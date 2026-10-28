import {randomUUID} from 'node:crypto';
import {createEmbeddingProvider, EmbeddingError, type EmbeddingProvider} from '../../core/integrations/embeddings/index.js';
import type {QueryableClient} from '../../core/database/index.js';

/** A database-backed queue, one entry per claim. Tokens prevent late responses overwriting edits or retries. */
export class KnowledgeIndexer {
  constructor(private readonly db:QueryableClient,private readonly provider:EmbeddingProvider=createEmbeddingProvider(db)){}
  async runOnce(signal:AbortSignal):Promise<boolean>{
    const config=await this.provider.configuration();
    if(!config?.enabled||signal.aborted)return false;
    const token=randomUUID();
    const result=await this.db.query(`WITH candidate AS (
      SELECT e.installation_id,e.library_id,e.organization_id,e.id FROM platform_knowledge_entries e
      JOIN platform_app_installations i ON i.id=e.installation_id
      WHERE NOT e.deleted AND i.record->>'enabled'='true'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(i.record->'runtime'->'manifest'->'knowledgeBases') b
          WHERE b->>'id'=e.library_id AND b->>'retrieval'='similar')
        AND (e.index_status='pending' OR e.embedding_key IS DISTINCT FROM $1
          OR (e.index_status='processing' AND e.index_started_at<now()-interval '2 minutes'))
      ORDER BY e.updated_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED
    ) UPDATE platform_knowledge_entries e SET index_status='processing',embedding_key=$1,index_version=e.version,index_token=$2,index_started_at=now(),index_error=NULL
      FROM candidate c WHERE e.installation_id=c.installation_id AND e.library_id=c.library_id AND e.organization_id=c.organization_id AND e.id=c.id
      RETURNING e.installation_id,e.library_id,e.organization_id,e.id,e.version,e.title,e.content,e.metadata`,[config.revision,token]) as {rows:{installation_id:string;library_id:string;organization_id:string;id:string;version:number;title:string;content:string;metadata:Record<string,string>}[]};
    const entry=result.rows[0];if(!entry)return false;
    const target=[entry.installation_id,entry.library_id,entry.organization_id,entry.id,entry.version,token];
    let vector:number[];
    try{vector=await this.provider.embed(config,JSON.stringify({title:entry.title,content:entry.content,metadata:entry.metadata}),signal);}
    catch(error){
      await this.db.query(`UPDATE platform_knowledge_entries SET index_status=$7,index_error=$8,index_token=NULL
        WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND id=$4 AND version=$5 AND index_token=$6 AND NOT deleted`,
      [...target,signal.aborted?'pending':'failed',signal.aborted?null:error instanceof EmbeddingError?error.code:'EMBEDDING_PROVIDER_FAILED']);
      return true;
    }
    await this.db.query(`UPDATE platform_knowledge_entries SET embedding=$7,index_status='ready',index_error=NULL,index_token=NULL
      WHERE installation_id=$1 AND library_id=$2 AND organization_id=$3 AND id=$4 AND version=$5 AND index_token=$6 AND NOT deleted`,[...target,vector]);
    return true;
  }
}
