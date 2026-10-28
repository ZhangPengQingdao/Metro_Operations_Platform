import {z} from 'zod';
import {appPermissionCode} from '@metro/platform-sdk/manifest';
import type {KnowledgeTarget, KnowledgeWrite} from '@metro/platform-sdk/app-knowledge';
import type {ConnectablePool, QueryableClient} from '../../core/database/index.js';
import {KnowledgeError, KnowledgeService} from '../../platform/knowledge/index.js';
import {AppBusinessAuthorization} from '../business-authorization/service.js';
import type {AppInstallation} from '../registry/index.js';
import {GatewayError, type AppGatewayOperation} from './model.js';

const uuid=z.string().uuid();
const target={libraryId:z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64),organizationId:uuid};
const list=z.object({...target,afterId:uuid.optional()}).strict();
const search=z.object({...target,query:z.string().min(1).max(1500),limit:z.number().int().min(1).max(20).optional()}).strict();
const write=z.discriminatedUnion('action',[
  z.object({...target,id:uuid,requestId:uuid,action:z.literal('save'),expectedVersion:z.number().int().min(1).optional(),
    title:z.string().min(1).max(100).refine(value=>value.trim()===value),content:z.string().max(1000),
    metadata:z.record(z.string().max(500)).refine(value=>Object.keys(value).length<=4 && Buffer.byteLength(JSON.stringify(value))<=2048),
  }).strict(),
  z.object({...target,id:uuid,requestId:uuid,action:z.literal('reindex'),expectedVersion:z.number().int().min(1)}).strict(),
  z.object({...target,id:uuid,requestId:uuid,action:z.literal('delete'),expectedVersion:z.number().int().min(1)}).strict(),
]);

/** Payload structure is checked once by Gateway; execution uses that validated value directly. */
export function createKnowledgeOperations(pool:ConnectablePool&QueryableClient):AppGatewayOperation[] {
  const knowledge=new KnowledgeService(pool), authorization=new AppBusinessAuthorization(pool);
  return (['list','search','write'] as const).map(mode=>({
    name:`platform.knowledge.${mode}`,permissionCode:mode==='write'?'platform.knowledge.write':'platform.knowledge.read',mode:mode==='write'?'write':'read',
    validateParams:value=>({list,search,write}[mode]).safeParse(value).success,
    resolveResources:async()=>[{}],
    auditMetadata:value=>{const input=value as unknown as KnowledgeTarget;return {libraryId:input.libraryId,organizationId:input.organizationId};},
    validateResult:()=>true,
    async execute(context,value,signal) {
      const employee=context.employeeActor;
      if(context.actorType!=='service'||!employee||employee.execution.type!=='application'||employee.execution.appId!==context.execution.appId)
        throw new GatewayError('ACCESS_DENIED',403);
      const input=value as unknown as KnowledgeTarget,appId=context.execution.appId;
      const installed=await pool.query('SELECT record FROM platform_app_installations WHERE app_id=$1',[appId]) as {rows:{record:AppInstallation}[]};
      const installation=installed.rows[0]?.record;
      const library=installation?.runtime?.model==='v2'?installation.runtime.manifest.knowledgeBases?.find(base=>base.id===input.libraryId):undefined;
      if(!installation?.enabled||!library)throw new GatewayError('ACCESS_DENIED',403);
      const rules=await authorization.resolve(appId,employee.person.id);
      const permissions=mode==='search'?[library.readPermission,library.writePermission]:[library.writePermission];
      const grants=rules?.grants.filter(grant=>permissions.some(code=>appPermissionCode(appId,code)===grant.permission))??[];
      let allowed=grants.some(grant=>grant.all||grant.organizationIds.includes(input.organizationId));
      // Explicit opt-in: a self-scoped reader can use shared knowledge from their own organization ancestry, never manage it.
      if(!allowed&&mode==='search'&&library.selfRead&&grants.some(grant=>grant.self&&grant.permission===appPermissionCode(appId,library.readPermission))) {
        const ancestors=await pool.query(`WITH RECURSIVE ancestors AS (
          SELECT id,parent_id FROM platform_organization_units WHERE id=$1 AND status='active'
          UNION SELECT o.id,o.parent_id FROM platform_organization_units o JOIN ancestors a ON o.id=a.parent_id WHERE o.status='active'
        ) SELECT id FROM ancestors WHERE id=$2`,[employee.person.organization.id,input.organizationId]) as {rows:unknown[]};
        allowed=ancestors.rows.length>0;
      }
      if(!allowed)throw new GatewayError('ACCESS_DENIED',403);
      const organization=await pool.query("SELECT id FROM platform_organization_units WHERE id=$1 AND status='active'",[input.organizationId]) as {rows:unknown[]};
      if(!organization.rows.length)throw new GatewayError('ACCESS_DENIED',403);
      const scope={installationId:installation.id,personId:employee.person.id,retrieval:library.retrieval};
      try {
        if(mode==='write')return await knowledge.write(scope,value as unknown as KnowledgeWrite,signal);
        if(mode==='search')return await knowledge.search(scope,value as unknown as KnowledgeTarget&{query:string;limit?:number},signal);
        return await knowledge.list(scope,value as unknown as KnowledgeTarget&{afterId?:string});
      } catch(error) {
        if(error instanceof KnowledgeError)throw new GatewayError(error.code,error.code==='ABORTED'?499:error.code==='KNOWLEDGE_EMBEDDING_UNAVAILABLE'?502:409);
        throw error;
      }
    },
  }));
}
