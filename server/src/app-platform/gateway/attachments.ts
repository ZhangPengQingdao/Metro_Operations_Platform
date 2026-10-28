import {z} from 'zod';
import {createPostgresAttachmentRepository,type AttachmentRepository} from '../../platform/attachments/index.js';
import {createLocalStorageAdapter,type StorageAdapter} from '../../core/storage/index.js';
import type {QueryableClient} from '../../core/database/index.js';
import {APP_ATTACHMENT_KIND} from '../employee/attachment-service.js';
import {GatewayError,type AppGatewayOperation} from './model.js';

const input=z.object({entityType:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),entityId:z.string().uuid(),organizationId:z.string().uuid(),afterId:z.string().uuid().optional(),availableOnly:z.boolean().optional()}).strict();
/** Backend metadata lookup is always bound to the calling installation; no storage paths leave the host. */
export function createAttachmentListOperation(repository:Pick<AttachmentRepository,'listAttachments'>,storage:Pick<StorageAdapter,'exists'>):AppGatewayOperation{
 return {name:'platform.attachments.list',permissionCode:'platform.attachments.read',mode:'read',validateParams:value=>input.safeParse(value).success,
  resolveResources:async(context,value)=>{if(context.actorType!=='service'||!context.execution.appId)throw new GatewayError('ACCESS_DENIED',403);return [{organizationUnitId:(value as z.infer<typeof input>).organizationId}];},
  async execute(context,value){
   if(context.actorType!=='service')throw new GatewayError('ACCESS_DENIED',403);const p=value as z.infer<typeof input>,appId=context.execution.appId;
   const rows=(await repository.listAttachments({sourceAppId:appId,sourceEntityType:p.entityType,sourceEntityId:p.entityId,ownerOrganizationUnitId:p.organizationId,lifecycle:'active',limit:500})).filter(row=>row.sourceAppId===appId&&row.sourceEntityType===p.entityType&&row.sourceEntityId===p.entityId&&row.ownerOrganizationUnitId===p.organizationId&&row.lifecycle==='active'&&row.storageKind===APP_ATTACHMENT_KIND).sort((a,b)=>a.id.localeCompare(b.id));
   const start=p.afterId?rows.findIndex(row=>row.id===p.afterId)+1:0;if(p.afterId&&!start)throw new GatewayError('INVALID_PARAMS');
   const result=[];let index=start;
   for(;index<rows.length&&result.length<50;index++){const row=rows[index];if(!p.availableOnly||await storage.exists(row.storageKind,row.storageFileName))result.push({attachmentId:row.id,fileName:row.originalFileName,sizeBytes:row.sizeBytes,contentType:row.contentType});}
   return {attachments:result,nextCursor:index<rows.length?rows[index-1].id:null};
  },validateResult:value=>!!value&&typeof value==='object'&&'attachments' in value&&Array.isArray(value.attachments)};
}
export const createPostgresAttachmentListOperation=(database:QueryableClient)=>createAttachmentListOperation(createPostgresAttachmentRepository(database),createLocalStorageAdapter());
