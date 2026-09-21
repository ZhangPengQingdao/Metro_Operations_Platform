import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import {createLocalStorageAdapter,type StorageAdapter} from '../../core/storage/index.js';
import {SignatureService,createPostgresSignatureRepository} from '../../platform/signatures/index.js';
import {createPostgresPeopleDirectoryRepository} from '../../platform/people/index.js';
import {GatewayError,type AppGatewayOperation,type GatewayActorContext} from './model.js';

const reference=z.object({entityId:z.string().uuid()}).strict();
const associate=reference.extend({title:z.string().min(1).max(200),organizationUnitId:z.string().uuid(),personIds:z.array(z.string().uuid()).min(1).max(100)}).strict();
const reading=reference.extend({evidencePersonId:z.string().uuid().optional()}).strict();
const signing=reference.extend({image:z.string().max(45000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)}).strict();
/** The application owns business resource access; the platform owns signer identity and evidence. */
export function createSignatureGatewayOperations(pool:ConnectablePool&QueryableClient,storage:()=>StorageAdapter=()=>createLocalStorageAdapter()):AppGatewayOperation[]{
 return (['associate','get','sign'] as const).map(action=>{
  const schema=action==='associate'?associate:action==='sign'?signing:reading;
  const permission=`platform.signatures.${action==='associate'?'create':action==='get'?'read':'sign'}`;
  return {name:`platform.signatures.${action}`,permissionCode:permission,mode:action==='get'?'read':'write',
   validateParams:value=>schema.safeParse(value).success,
   resolveResources:async context=>{requireBound(context);return [{}];},
   async execute(context,value,signal){
    const employee=requireBound(context),appId=context.execution.type==='service'?context.execution.appId:'';
    const client=await pool.connect();
    try{return await runDatabaseTransaction(client,async()=>{
     const repo=createPostgresSignatureRepository(client),people=createPostgresPeopleDirectoryRepository(client);
     const service=new SignatureService(repo,{findPerson:id=>people.findPersonById(id),findOrganizationUnit:id=>people.findOrganizationUnitById(id)});
     const key=`record:${reference.parse({entityId:(value as {entityId:string}).entityId}).entityId}`;
     const check=async()=>{if(signal.aborted||!(await context.authorize(permission,{})).allowed)throw new GatewayError('ACCESS_DENIED',403);};
     await check();
     let request=await repo.findRequestByKey(appId,key);
     if(action==='associate'){
      const p=associate.parse(value);
      const created=await service.associateRecord(context,{source:{appId,entityType:'meeting',entityId:p.entityId},signatureKey:key,idempotencyKey:key,
       document:{title:p.title,description:null,originalFileName:null,originalExtension:null,sourceFile:null},
       signers:[...new Set(p.personIds)].sort().map(personId=>({personId,expectedOrganizationUnitId:p.organizationUnitId,positions:[{page:0,x0:0,y0:0,x1:1,y1:1,strategy:'record'}]})),expiresAt:null});
      request=created.request;
     }
     if(!request)return {associated:false,signers:[]};
     if(request.sourceAppId!==appId)throw new GatewayError('ACCESS_DENIED',403);
     let signers=await repo.listSigners(request.id);
     if(action==='sign'){
      const signer=signers.find(s=>s.personId===employee.person.id);
      if(!signer||signer.status==='revoked')throw new GatewayError('ACCESS_DENIED',403);
      const p=signing.parse(value),bytes=Buffer.from(p.image.split(',')[1],'base64');
      if(bytes.length>32768||bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)>2048||bytes.readUInt32BE(20)>1024)throw new GatewayError('INVALID_PARAMS');
      await check();
      const adapter=storage(),kind='app-signatures',fileName=`${randomUUID()}.png`;
      const metadata=await adapter.writeObject(kind,fileName,bytes,{exclusive:true,contentType:'image/png'});
      // Service grant bounds the capability; person identity comes exclusively from the host binding.
      const actor={...employee,authorize:context.authorize,authorizeApplication:context.authorizeApplication};
      const session=await repo.findSessionByRequestId(request.id);
      if(!session)throw new GatewayError('INVALID_RESULT');
      await service.submitOwnSignature(actor,{sessionId:session.id,signerId:signer.id,evidence:{storageRef:metadata,contentType:'image/png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}});
      signers=await repo.listSigners(request.id);
     }
     let image:string|null=null;
     const selected=action==='get'?reading.parse(value).evidencePersonId:undefined;
     if(selected){const signer=signers.find(s=>s.personId===selected&&s.status==='signed');const evidence=signer?.signatureEvidenceId?await repo.findEvidenceById(signer.signatureEvidenceId):null;
      if(evidence?.storageRef?.kind==='app-signatures'&&evidence.contentType==='image/png'){
       const stream=storage().createObjectReadStream(evidence.storageRef.kind,evidence.storageRef.fileName) as Readable;
       const chunks:Buffer[]=[];let length=0;try{for await(const chunk of stream){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>32768)throw new GatewayError('INVALID_RESULT');chunks.push(bytes);}}finally{stream.destroy();}
       image='data:image/png;base64,'+Buffer.concat(chunks).toString('base64');
      }
     }
     await check();
     return {...(selected?{image}:{}),associated:true,signers:signers.filter(s=>s.status!=='revoked').map(s=>({personId:s.personId,name:s.displayName,status:s.status==='signed'?'signed':'unsigned',signedAt:s.signedAt}))};
    });}finally{client.release();}
   },validateResult:()=>true};
 });
}
function requireBound(context:GatewayActorContext){
 if(context.actorType!=='service'||!context.employeeActor||context.employeeActor.execution.type!=='application'||context.employeeActor.execution.appId!==context.execution.appId)throw new GatewayError('ACCESS_DENIED',403);
 return context.employeeActor;
}
