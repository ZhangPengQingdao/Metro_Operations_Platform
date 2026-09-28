import {randomUUID} from 'node:crypto';
import type {Readable} from 'node:stream';
import type {StorageAdapter,StorageObjectMetadata} from '../../core/storage/index.js';
import {createAttachmentService,type AttachmentRepository,type AttachmentDirectoryPerson,type AttachmentDirectoryOrganizationUnit} from '../../platform/attachments/index.js';
import type {PlatformActorContext,PlatformPersonActorContext,PlatformServiceActorContext} from '../../platform/context/index.js';

export const APP_ATTACHMENT_MAX_BYTES=50*1024*1024;
export const APP_ATTACHMENT_KIND='app-attachments';

const types:Record<string,{mime:string;signature:readonly number[];entry?:string}>={
  '.doc':{mime:'application/msword',signature:[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]},
  '.docx':{mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',signature:[0x50,0x4b,0x03,0x04],entry:'word/document.xml'},
  '.xls':{mime:'application/vnd.ms-excel',signature:[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]},
  '.xlsx':{mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',signature:[0x50,0x4b,0x03,0x04],entry:'xl/workbook.xml'},
  '.pdf':{mime:'application/pdf',signature:[0x25,0x50,0x44,0x46,0x2d]},
  '.zip':{mime:'application/zip',signature:[0x50,0x4b,0x03,0x04]}
};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const sourceType=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value);
const name=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=180&&value.trim()===value&&!/[\\/\u0000-\u001f\u007f<>:"|?*]/.test(value)&&value!=='.'&&value!=='..';
const appId=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)&&value.length<=64;

export class AppAttachmentError extends Error {
  constructor(readonly code:'INVALID_FILE'|'FILE_TOO_LARGE'|'UNSUPPORTED_FILE'|'ACCESS_DENIED'|'ATTACHMENT_UNAVAILABLE'|'ATTACHMENT_LIMIT') {super(code);this.name='AppAttachmentError';}
}

/** Browser extension and MIME are never trusted as a file-format validator. */
export function inspectAppAttachment(fileName:unknown,bytes:Buffer):{contentType:string;sizeBytes:number}{
  if(!name(fileName)||!Buffer.isBuffer(bytes)||!bytes.length)throw new AppAttachmentError('INVALID_FILE');
  if(bytes.length>APP_ATTACHMENT_MAX_BYTES)throw new AppAttachmentError('FILE_TOO_LARGE');
  const extension=/\.[a-z0-9]+$/i.exec(fileName)?.[0].toLowerCase(),type=extension&&types[extension];
  if(!type)throw new AppAttachmentError('UNSUPPORTED_FILE');
  if(type.signature.some((byte,index)=>bytes[index]!==byte)||type.entry&&!bytes.includes(Buffer.from(type.entry)))throw new AppAttachmentError('INVALID_FILE');
  return {contentType:type.mime,sizeBytes:bytes.length};
}

export interface AppAttachmentDirectory {
  findPerson(id:string):Promise<AttachmentDirectoryPerson|null>;
  findOrganizationUnit(id:string):Promise<AttachmentDirectoryOrganizationUnit|null>;
}
export interface AppAttachmentTransferOptions {
  storage:StorageAdapter;
  repository:AttachmentRepository;
  directory:AppAttachmentDirectory;
  /** Revalidate employee, installation, business permission and source record before and after storage work. */
  authorize(input:{action:'upload'|'read';appId:string;entityType:string;entityId:string;attachmentId?:string}):Promise<{organizationId:string}>;
}

/** Preserve the employee as uploader while enforcing the signed app's approved service grant. */
export function bindEmployeeAttachmentActor(person:PlatformPersonActorContext,service:PlatformServiceActorContext):PlatformPersonActorContext{
  if(person.execution.type!=='application'||person.execution.appId!==service.execution.appId)throw new AppAttachmentError('ACCESS_DENIED');
  return {...person,authorize:service.authorize,authorizeApplication:service.authorizeApplication};
}

/** Authenticated host transport. The app authorizes its record; AttachmentService enforces platform grants. */
export function createAppAttachmentTransfer(options:AppAttachmentTransferOptions){
  const storage=options.storage;
  const service=(metadata?:StorageObjectMetadata,repository=options.repository)=>createAttachmentService(repository,{
    findStorageMetadata:async(kind,fileName)=>metadata?.kind===kind&&metadata.fileName===fileName?metadata:null,
    findPerson:id=>options.directory.findPerson(id),findOrganizationUnit:id=>options.directory.findOrganizationUnit(id)
  });
  return Object.freeze({
    async list(context:PlatformActorContext,app:string,entityType:string,entityId:string,afterId?:string){
      if(context.actorType!=='person'||context.execution.type!=='application'||context.execution.appId!==app||!appId(app)||!sourceType(entityType)||!uuid(entityId))throw new AppAttachmentError('ACCESS_DENIED');
      if(afterId!==undefined&&!uuid(afterId))throw new AppAttachmentError('INVALID_FILE');
      const access=await options.authorize({action:'read',appId:app,entityType,entityId});
      if(!uuid(access.organizationId))throw new AppAttachmentError('ACCESS_DENIED');
      const rows=(await service().listAttachments(context,{sourceAppId:app,sourceEntityType:entityType,sourceEntityId:entityId,lifecycle:'active',limit:500}))
       .filter(row=>row.storageKind===APP_ATTACHMENT_KIND&&row.ownerOrganizationUnitId===access.organizationId);
      const fresh=await options.authorize({action:'read',appId:app,entityType,entityId});
      if(fresh.organizationId!==access.organizationId)throw new AppAttachmentError('ACCESS_DENIED');
      const start=afterId?rows.findIndex(row=>row.id===afterId)+1:0;
      if(afterId&&start===0)throw new AppAttachmentError('INVALID_FILE');
      const page=rows.slice(start,start+50);
      return {attachments:page.map(row=>({attachmentId:row.id,intentId:row.idempotencyKey,fileName:row.originalFileName,contentType:row.contentType,sizeBytes:row.sizeBytes,createdAt:row.createdAt})),nextCursor:start+50<rows.length?page.at(-1)!.id:null};
    },
    async upload(context:PlatformActorContext,input:{appId:string;entityType:string;entityId:string;intentId:string;fileName:string;bytes:Buffer}){
      if(context.actorType!=='person'||context.execution.type!=='application'||context.execution.appId!==input.appId||!appId(input.appId)||!sourceType(input.entityType)||!uuid(input.entityId)||!uuid(input.intentId))throw new AppAttachmentError('ACCESS_DENIED');
      const format=inspectAppAttachment(input.fileName,input.bytes);
      const first=await options.authorize({action:'upload',appId:input.appId,entityType:input.entityType,entityId:input.entityId});
      if(!uuid(first.organizationId))throw new AppAttachmentError('ACCESS_DENIED');
      const resource={organizationUnitId:first.organizationId};
      if(!(await context.authorize('platform.attachments.create',resource)).allowed||!context.authorizeApplication||!(await context.authorizeApplication('platform.attachments.create',resource)).allowed)throw new AppAttachmentError('ACCESS_DENIED');
      if((await options.repository.listAttachments({sourceAppId:input.appId,sourceEntityType:input.entityType,sourceEntityId:input.entityId,limit:500})).length>=500)throw new AppAttachmentError('ATTACHMENT_LIMIT');
      const fresh=await options.authorize({action:'upload',appId:input.appId,entityType:input.entityType,entityId:input.entityId});
      if(fresh.organizationId!==first.organizationId)throw new AppAttachmentError('ACCESS_DENIED');
      const fileName=`${input.appId}-${randomUUID()}`;
      const metadata=await storage.writeObject(APP_ATTACHMENT_KIND,fileName,input.bytes,{exclusive:true,contentType:format.contentType});
      try{
        const afterWrite=await options.authorize({action:'upload',appId:input.appId,entityType:input.entityType,entityId:input.entityId});
        if(afterWrite.organizationId!==first.organizationId)throw new AppAttachmentError('ACCESS_DENIED');
      }catch(error){await storage.deleteObject(APP_ATTACHMENT_KIND,fileName).catch(()=>{});throw error;}
      let registrationAttempted=false;
      const repository:AttachmentRepository={...options.repository,createAttachment:async(...args)=>{
        registrationAttempted=true;
        return options.repository.createAttachment(...args);
      }};
      try{
        const detail=await service(metadata,repository).registerAttachment(context,{
          source:{appId:input.appId,entityType:input.entityType,entityId:input.entityId},
          attachmentKey:input.intentId,idempotencyKey:input.intentId,purpose:'business-evidence',
          storage:{kind:APP_ATTACHMENT_KIND,fileName},originalFileName:input.fileName,
          ownerOrganizationUnitId:first.organizationId,visibility:'private'
        });
        return {attachmentId:detail.attachment.id,fileName:detail.attachment.originalFileName,contentType:detail.attachment.contentType,sizeBytes:detail.attachment.sizeBytes};
      }catch(error){
        // Only an attempted database write can have an unknown outcome. Retain its
        // object so a committed attachment never points at deleted bytes.
        if(!registrationAttempted)await storage.deleteObject(APP_ATTACHMENT_KIND,fileName).catch(()=>{});
        throw error;
      }
    },
    async read(context:PlatformActorContext,app:string,attachmentId:string):Promise<{fileName:string;contentType:string;sizeBytes:number;stream:Readable}>{
      if(context.actorType!=='person'||context.execution.type!=='application'||context.execution.appId!==app||!appId(app)||!uuid(attachmentId))throw new AppAttachmentError('ACCESS_DENIED');
      const first=await service().getAttachment(context,attachmentId),record=first.attachment;
      if(record.sourceAppId!==app||record.lifecycle!=='active'||record.storageKind!==APP_ATTACHMENT_KIND||record.sizeBytes<1||record.sizeBytes>APP_ATTACHMENT_MAX_BYTES)throw new AppAttachmentError('ACCESS_DENIED');
      const access=await options.authorize({action:'read',appId:app,entityType:record.sourceEntityType,entityId:record.sourceEntityId,attachmentId});
      if(!uuid(access.organizationId)||access.organizationId!==record.ownerOrganizationUnitId)throw new AppAttachmentError('ACCESS_DENIED');
      const fresh=(await service().getAttachment(context,attachmentId)).attachment;
      if(fresh.lifecycle!=='active'||fresh.sourceAppId!==app||fresh.storageFileName!==record.storageFileName)throw new AppAttachmentError('ACCESS_DENIED');
      if(!await storage.exists(APP_ATTACHMENT_KIND,record.storageFileName))throw new AppAttachmentError('ATTACHMENT_UNAVAILABLE');
      const final=await options.authorize({action:'read',appId:app,entityType:record.sourceEntityType,entityId:record.sourceEntityId,attachmentId});
      if(final.organizationId!==record.ownerOrganizationUnitId)throw new AppAttachmentError('ACCESS_DENIED');
      return {fileName:record.originalFileName,contentType:record.contentType,sizeBytes:record.sizeBytes,stream:storage.createObjectReadStream(APP_ATTACHMENT_KIND,record.storageFileName) as Readable};
    }
  });
}
