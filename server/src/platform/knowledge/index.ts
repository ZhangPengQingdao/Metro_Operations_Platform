import {createEmbeddingProvider,type EmbeddingProvider} from '../../core/integrations/embeddings/index.js';
import { createHash } from 'node:crypto';
import type { KnowledgeEntry, KnowledgeTarget, KnowledgeWrite, KnowledgeSearchResult } from '@metro/platform-sdk/app-knowledge';
import { runDatabaseTransaction, type ConnectablePool, type QueryableClient } from '../../core/database/index.js';

export class KnowledgeError extends Error {
  constructor(readonly code: 'KNOWLEDGE_CONFLICT' | 'KNOWLEDGE_LIMIT' | 'REQUEST_ID_REUSED' | 'ABORTED' | 'KNOWLEDGE_EMBEDDING_UNAVAILABLE') { super(code); }
}
export interface KnowledgeScope { installationId: string; personId: string; retrieval: 'exact' | 'similar' }
const columns = 'id,title,content,metadata,version';

/** Text libraries are declared in the installed manifest. Only their entries are persisted here. */
export class KnowledgeService {
  constructor(private readonly pool: ConnectablePool & QueryableClient, private readonly provider:EmbeddingProvider=createEmbeddingProvider(pool)) {}

  async list(scope: KnowledgeScope, input: KnowledgeTarget & {afterId?: string}) {
    const result = await this.pool.query(`SELECT ${columns},embedding_key,index_status,index_version,index_error FROM platform_knowledge_entries
      WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND NOT deleted
      AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 21`,
    [scope.installationId,input.libraryId,input.organizationId,input.afterId ?? null]) as {rows: (KnowledgeEntry & {embedding_key:string;index_status:KnowledgeEntry["indexStatus"];index_version:number;index_error:string})[]};
    const config=scope.retrieval==='similar'?await this.provider.configuration():null;
    const entries=result.rows.slice(0,20).map(({embedding_key,index_status,index_version,index_error,...entry})=>({
      ...entry,indexStatus:scope.retrieval==='exact'?'not_required' as const:!config?.enabled?'unconfigured' as const:
        embedding_key!==config.revision?'pending' as const:index_status==='ready'&&index_version!==entry.version?'pending' as const:index_status,
      ...(config?.enabled&&embedding_key===config.revision&&index_status==='failed'?{indexError:index_error}:{}),
    }));
    return {entries, nextCursor: result.rows.length > 20 ? result.rows[19].id : null};
  }

  async search(scope: KnowledgeScope, input: KnowledgeTarget & {query: string; limit?: number},signal:AbortSignal=new AbortController().signal):Promise<KnowledgeSearchResult> {
    const target = [scope.installationId,input.libraryId,input.organizationId];
    const finish=(entries:(KnowledgeEntry & {score:number})[],retrieval:KnowledgeSearchResult['retrieval']):KnowledgeSearchResult=>({entries:entries.map(entry=>({...entry,reference:{libraryId:input.libraryId,organizationId:input.organizationId,id:entry.id,version:entry.version}})),retrieval});
    if (scope.retrieval === 'exact') {
      const result = await this.pool.query(`SELECT ${columns},1 AS score FROM platform_knowledge_entries
        WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND NOT deleted
        AND strpos($4,title)>0 ORDER BY id LIMIT 41`,[...target,input.query]) as {rows: (KnowledgeEntry & {score: number})[]};
      // Exact terms must not be silently dropped from the caller's protected vocabulary.
      if (result.rows.length > 40) throw new KnowledgeError('KNOWLEDGE_LIMIT');
      return finish(result.rows,{mode:'exact'});
    }
    const config=await this.provider.configuration();
    let reason:KnowledgeSearchResult['retrieval']['reason']='unconfigured';
    if(config?.enabled){
      const state=await this.pool.query(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE index_status='ready' AND index_version=version AND embedding_key=$4)::int AS ready,
        count(*) FILTER(WHERE index_status='failed' AND embedding_key=$4)::int AS failed
        FROM platform_knowledge_entries WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND NOT deleted`,[...target,config.revision]) as {rows:{total:number;ready:number;failed:number}[]};
      if(state.rows[0].ready===state.rows[0].total){
        if(!state.rows[0].total)return finish([],{mode:'semantic'});
        let vector:number[];
        try{vector=await this.provider.embed(config,input.query,signal);}catch{throw new KnowledgeError(signal.aborted?'ABORTED':'KNOWLEDGE_EMBEDDING_UNAVAILABLE');}
        // Version and model checks are repeated in this query because entries may change during the external request.
        const result=await this.pool.query(`SELECT * FROM (SELECT ${columns},(SELECT sum(a*b) FROM unnest(embedding,$5::float8[]) AS v(a,b)) AS score
          FROM platform_knowledge_entries WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND NOT deleted
          AND index_status='ready' AND index_version=version AND embedding_key=$4
          AND $4=(SELECT value->>'revision' FROM system_configs WHERE key='embedding_runtime_global' AND value->>'enabled'='true')) candidates WHERE score>=$7
          ORDER BY score DESC,id LIMIT $6`,[...target,config.revision,vector,input.limit??5,config.minScore??0.3]) as {rows:(KnowledgeEntry & {score:number})[]};
        return finish(result.rows,{mode:'semantic'});
      }
      reason=state.rows[0].failed?'failed':'indexing';
    }
    const characters = [...new Set(input.query.toLowerCase().match(/[\p{L}\p{N}]/gu) ?? [])];
    if (!characters.length) return finish([],{mode:'text',reason});
    const result = await this.pool.query(`SELECT ${columns},hits::float8/$5 AS score FROM (
      SELECT ${columns},(SELECT count(*) FROM unnest($4::text[]) AS c(value) WHERE strpos(lower(content),c.value)>0) AS hits
      FROM platform_knowledge_entries WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND NOT deleted
      ) candidates WHERE hits >= $6 AND hits::float8/$5 >= 0.2 ORDER BY hits DESC,id LIMIT $7`,
    [...target,characters,characters.length,Math.min(2,characters.length),input.limit ?? 5]) as {rows: (KnowledgeEntry & {score: number})[]};
    return finish(result.rows,{mode:'text',reason});
  }

  async write(scope: KnowledgeScope, input: KnowledgeWrite, signal: AbortSignal) {
    const client = await this.pool.connect();
    try {
      return await runDatabaseTransaction(client, async () => {
        if (signal.aborted) throw new KnowledgeError('ABORTED');
        const request = JSON.stringify({personId:scope.personId,input});
        const reserved = await client.query(`INSERT INTO platform_knowledge_requests(installation_id,request_id,request)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id`,[scope.installationId,input.requestId,request]) as {rows: unknown[]};
        if (!reserved.rows.length) {
          const previous = await client.query(`SELECT request=$3::jsonb AS matches,result FROM platform_knowledge_requests
            WHERE installation_id=$1 AND request_id=$2`,[scope.installationId,input.requestId,request]) as {rows: {matches:boolean;result:{id:string;version:number}}[]};
          if (!previous.rows[0].matches) throw new KnowledgeError('REQUEST_ID_REUSED');
          return previous.rows[0].result;
        }
        let id = input.id;
        if (scope.retrieval === 'exact' && input.action === 'save' && input.expectedVersion === undefined) {
          const hash = createHash('sha256').update(JSON.stringify([input.libraryId,input.organizationId,input.title])).digest('hex');
          id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
        }
        const target = [scope.installationId,input.libraryId,input.organizationId,id];
        let changed: {rows: {id:string;version:number}[]};
        if (input.action === 'reindex') {
          if(scope.retrieval!=='similar')throw new KnowledgeError('KNOWLEDGE_CONFLICT');
          changed=await client.query(`UPDATE platform_knowledge_entries SET embedding=NULL,embedding_key=NULL,index_status='pending',index_version=NULL,index_error=NULL,index_token=NULL
            WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND id=$4 AND version=$5 AND NOT deleted RETURNING id,version`,[...target,input.expectedVersion]) as typeof changed;
        } else if (input.action === 'delete') {
          changed = await client.query(`UPDATE platform_knowledge_entries SET embedding=NULL,embedding_key=NULL,index_status='pending',index_version=NULL,index_error=NULL,index_token=NULL,deleted=true,version=version+1,updated_by=$6,updated_at=now()
            WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND id=$4 AND version=$5 AND NOT deleted
            RETURNING id,version`,[...target,input.expectedVersion,scope.personId]) as typeof changed;
        } else if (input.expectedVersion !== undefined) {
          changed = await client.query(`UPDATE platform_knowledge_entries SET embedding=NULL,embedding_key=NULL,index_status='pending',index_version=NULL,index_error=NULL,index_token=NULL,title=$6,content=$7,metadata=$8,version=version+1,updated_by=$9,updated_at=now()
            WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND id=$4 AND version=$5 AND NOT deleted
            AND ($10::boolean OR title=$6) RETURNING id,version`,
          [...target,input.expectedVersion,input.title,input.content,JSON.stringify(input.metadata),scope.personId,scope.retrieval!=='exact']) as typeof changed;
        } else {
          changed = await client.query(`INSERT INTO platform_knowledge_entries(installation_id,library_id,organization_id,id,title,content,metadata,version,updated_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)
            ON CONFLICT(installation_id,library_id,organization_id,id) DO UPDATE
            SET embedding=NULL,embedding_key=NULL,index_status='pending',index_version=NULL,index_error=NULL,index_token=NULL,title=excluded.title,content=excluded.content,metadata=excluded.metadata,deleted=false,
              version=platform_knowledge_entries.version+1,updated_by=excluded.updated_by,updated_at=now()
            WHERE platform_knowledge_entries.deleted RETURNING id,version`,
          [...target,input.title,input.content,JSON.stringify(input.metadata),scope.personId]) as typeof changed;
        }
        if (!changed.rows.length) throw new KnowledgeError('KNOWLEDGE_CONFLICT');
        const result = changed.rows[0];
        await client.query('UPDATE platform_knowledge_requests SET result=$3 WHERE installation_id=$1 AND request_id=$2',
          [scope.installationId,input.requestId,JSON.stringify(result)]);
        if (signal.aborted) throw new KnowledgeError('ABORTED');
        return result;
      });
    } finally { client.release(); }
  }
}
