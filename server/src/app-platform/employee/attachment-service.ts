import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import type {StorageAdapter,StorageObjectMetadata} from '../../core/storage/index.js';
import {createAttachmentService,type AttachmentRepository,type AttachmentDirectoryPerson,type AttachmentDirectoryOrganizationUnit} from '../../platform/attachments/index.js';
import type {PlatformActorContext,PlatformPersonActorContext,PlatformServiceActorContext} from '../../platform/context/index.js';

export const APP_ATTACHMENT_MAX_BYTES=200*1024*1024;
export const APP_ATTACHMENT_KIND='app-attachments';

const types:Record<string,{mime:string;signature:readonly number[];entry?:string;offset?:number}>={
  '.doc':{mime:'application/msword',signature:[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]},
  '.docx':{mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',signature:[0x50,0x4b,0x03,0x04],entry:'word/document.xml'},
  '.xls':{mime:'application/vnd.ms-excel',signature:[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]},
  '.xlsx':{mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',signature:[0x50,0x4b,0x03,0x04],entry:'xl/workbook.xml'},
  '.pdf':{mime:'application/pdf',signature:[0x25,0x50,0x44,0x46,0x2d]},
  '.zip':{mime:'application/zip',signature:[0x50,0x4b,0x03,0x04]},
  '.rar':{mime:'application/vnd.rar',signature:[0x52,0x61,0x72,0x21,0x1a,0x07]},
  '.7z':{mime:'application/x-7z-compressed',signature:[0x37,0x7a,0xbc,0xaf,0x27,0x1c]},
  '.gz':{mime:'application/gzip',signature:[0x1f,0x8b]},
  '.jpg':{mime:'image/jpeg',signature:[0xff,0xd8,0xff]},
  '.jpeg':{mime:'image/jpeg',signature:[0xff,0xd8,0xff]},
  '.png':{mime:'image/png',signature:[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]},
  '.gif':{mime:'image/gif',signature:[0x47,0x49,0x46,0x38]},
  '.webp':{mime:'image/webp',signature:[0x57,0x45,0x42,0x50],offset:8},
  '.bmp':{mime:'image/bmp',signature:[0x42,0x4d]},
  '.mp4':{mime:'video/mp4',signature:[0x66,0x74,0x79,0x70],offset:4},
  '.m4v':{mime:'video/mp4',signature:[0x66,0x74,0x79,0x70],offset:4},
  '.mov':{mime:'video/quicktime',signature:[0x66,0x74,0x79,0x70],offset:4},
  '.webm':{mime:'video/webm',signature:[0x1a,0x45,0xdf,0xa3]},
  '.mkv':{mime:'video/x-matroska',signature:[0x1a,0x45,0xdf,0xa3]},
  '.avi':{mime:'video/x-msvideo',signature:[0x41,0x56,0x49,0x20],offset:8}
};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const sourceType=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value);
const name=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=180&&value.trim()===value&&!/[\\/\u0000-\u001f\u007f<>:"|?*]/.test(value)&&value!=='.'&&value!=='..';
const appId=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)&&value.length<=64;

export class AppAttachmentError extends Error {
  constructor(readonly code:'INVALID_FILE'|'FILE_TOO_LARGE'|'UNSUPPORTED_FILE'|'ACCESS_DENIED'|'ATTACHMENT_UNAVAILABLE'|'ATTACHMENT_LIMIT') {super(code);this.name='AppAttachmentError';}
}

/** Browser extension and MIME are never trusted as a file-format validator. */
export function inspectAppAttachment(fileName:unknown,bytes:Buffer,prefixOnly=false):{contentType:string;sizeBytes:number}{
  if(!name(fileName)||!Buffer.isBuffer(bytes)||!bytes.length)throw new AppAttachmentError('INVALID_FILE');
  if(bytes.length>APP_ATTACHMENT_MAX_BYTES)throw new AppAttachmentError('FILE_TOO_LARGE');
  const extension=/\.[a-z0-9]+$/i.exec(fileName)?.[0].toLowerCase(),type=extension&&types[extension];
  if(!type)throw new AppAttachmentError('UNSUPPORTED_FILE');
  if(type.signature.some((byte,index)=>bytes[index+(type.offset??0)]!==byte)||!prefixOnly&&type.entry&&!bytes.includes(Buffer.from(type.entry)))throw new AppAttachmentError('INVALID_FILE');
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
  type UploadInput={appId:string;entityType:string;entityId:string;intentId:string;fileName:string;bytes?:Buffer;stream?:Readable};
  async function upload(context:PlatformActorContext,input:UploadInput){
      if(context.actorType!=='person'||context.execution.type!=='application'||context.execution.appId!==input.appId||!appId(input.appId)||!sourceType(input.entityType)||!uuid(input.entityId)||!uuid(input.intentId))throw new AppAttachmentError('ACCESS_DENIED');
      const first=await options.authorize({action:'upload',appId:input.appId,entityType:input.entityType,entityId:input.entityId});
      if(!uuid(first.organizationId))throw new AppAttachmentError('ACCESS_DENIED');
      const resource={organizationUnitId:first.organizationId};
      if(!(await context.authorize('platform.attachments.create',resource)).allowed||!context.authorizeApplication||!(await context.authorizeApplication('platform.attachments.create',resource)).allowed)throw new AppAttachmentError('ACCESS_DENIED');
      if((await options.repository.listAttachments({sourceAppId:input.appId,sourceEntityType:input.entityType,sourceEntityId:input.entityId,limit:500})).length>=500)throw new AppAttachmentError('ATTACHMENT_LIMIT');
      let format:{contentType:string},incoming:Readable|undefined;
      if(input.bytes)format=inspectAppAttachment(input.fileName,input.bytes);
      else if(input.stream){
        const iterator=input.stream[Symbol.asyncIterator](),firstChunk=await iterator.next();
        if(firstChunk.done)throw new AppAttachmentError('INVALID_FILE');
        const prefix:Buffer[]= [Buffer.from(firstChunk.value)];let length=prefix[0].length,ended=false;
        while(length<512){const next=await iterator.next();if(next.done){ended=true;break;}const part=Buffer.from(next.value);prefix.push(part);length+=part.length;}
        format=inspectAppAttachment(input.fileName,Buffer.concat(prefix),true);
        incoming=Readable.from((async function*(){yield* prefix;if(!ended){let next;while(!(next=await iterator.next()).done)yield next.value;}})());
      }else throw new AppAttachmentError('INVALID_FILE');
      const fresh=await options.authorize({action:'upload',appId:input.appId,entityType:input.entityType,entityId:input.entityId});
      if(fresh.organizationId!==first.organizationId)throw new AppAttachmentError('ACCESS_DENIED');
      const fileName=`${input.appId}-${randomUUID()}`;
      let metadata:StorageObjectMetadata;
      if(incoming){if(!storage.writeObjectStream)throw new AppAttachmentError('ATTACHMENT_UNAVAILABLE');try{metadata=await storage.writeObjectStream(APP_ATTACHMENT_KIND,fileName,incoming,{maxBytes:APP_ATTACHMENT_MAX_BYTES,contentType:format.contentType});}catch(error){if((error as {code?:string}).code==='FILE_TOO_LARGE')throw new AppAttachmentError('FILE_TOO_LARGE');throw error;}}
      else metadata=await storage.writeObject(APP_ATTACHMENT_KIND,fileName,input.bytes!,{exclusive:true,contentType:format.contentType});
      try{const after=await options.authorize({action:'upload',appId:input.appId,entityType:input.entityType,entityId:input.entityId});if(after.organizationId!==first.organizationId)throw new AppAttachmentError('ACCESS_DENIED');}
      catch(error){await storage.deleteObject(APP_ATTACHMENT_KIND,fileName).catch(()=>{});throw error;}
      let registrationAttempted=false;
      const repository:AttachmentRepository={...options.repository,createAttachment:async(...args)=>{registrationAttempted=true;return options.repository.createAttachment(...args);}};
      try{
        const detail=await service(metadata,repository).registerAttachment(context,{source:{appId:input.appId,entityType:input.entityType,entityId:input.entityId},attachmentKey:input.intentId,idempotencyKey:input.intentId,purpose:'business-evidence',storage:{kind:APP_ATTACHMENT_KIND,fileName},originalFileName:input.fileName,ownerOrganizationUnitId:first.organizationId,visibility:'private'});
        return {attachmentId:detail.attachment.id,fileName:detail.attachment.originalFileName,contentType:detail.attachment.contentType,sizeBytes:detail.attachment.sizeBytes};
      }catch(error){if(!registrationAttempted)await storage.deleteObject(APP_ATTACHMENT_KIND,fileName).catch(()=>{});throw error;}
  }
  return Object.freeze({
    upload,
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
