import type {AppBusinessAuthorization} from '../business-authorization/service.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ChatError,ChatService,chatMessageInput} from '../../platform/chat/index.js';
import {EmployeeIdentityService,EmployeeIdentityError,EMPLOYEE_SESSION_COOKIE} from '../../platform/employee-identity/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
import type {AppManagement} from '../management/service.js';
import {GatewayError} from '../gateway/model.js';
import {AdminIdentityError} from '../../core/admin-identity/index.js';
import type {EmployeeAppAccess} from './access.js';
import {AppManagementError} from '../management/config.js';
import {AppV2CallError} from '../v2/host.js';
import {createAppAttachmentTransfer,AppAttachmentError,APP_ATTACHMENT_MAX_BYTES,type AppAttachmentDirectory} from './attachment-service.js';
import {createLocalStorageAdapter,type StorageAdapter} from '../../core/storage/index.js';
import {createPostgresAttachmentRepository,AttachmentError,type AttachmentRepository} from '../../platform/attachments/index.js';
import {createPostgresPeopleDirectoryRepository} from '../../platform/people/index.js';
import {getDatabasePool,type QueryableClient} from '../../core/database/index.js';
import {Readable} from 'node:stream';
import {zipStream,zipSize,type ZipEntry} from './zip-stream.js';

type AttachmentBackend={connect():Promise<QueryableClient&{release():void}>;repository(client:QueryableClient):AttachmentRepository;directory(client:QueryableClient):AppAttachmentDirectory;storage:StorageAdapter};
export function registerEmployeeRoutes(app:FastifyInstance,options:{origin:string;service:EmployeeIdentityService;resolveAdmin(request:FastifyRequest):Promise<PlatformAdministratorContext>;adminOrigin?:string;management?:AppManagement;chat?:ChatService;access?:EmployeeAppAccess;business?:AppBusinessAuthorization;attachmentBackend?:AttachmentBackend}){
 const url=new URL(options.origin);
 if(url.origin!==options.origin||!['http:','https:'].includes(url.protocol)||(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('EMPLOYEE_CANONICAL_ORIGIN_REQUIRED');
 const cookie={path:'/api/employee',httpOnly:true,secure:url.protocol==='https:',sameSite:'strict' as const};
 const attempts=new Map<string,{count:number;until:number}>();
 const precheckedIdentity=new WeakMap<FastifyRequest,Awaited<ReturnType<EmployeeIdentityService['resolveIdentity']>>>();
 const resolveRequestIdentity=(req:FastifyRequest)=>{
  const checked=precheckedIdentity.get(req);
  if(checked){precheckedIdentity.delete(req);return Promise.resolve(checked);}
  return options.service.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE]);
 };
 const attachmentBackend=options.attachmentBackend??{
  connect:async()=>{const pool=getDatabasePool();if(!pool)throw new AppAttachmentError('ATTACHMENT_UNAVAILABLE');return pool.connect();},
  repository:(client:QueryableClient)=>createPostgresAttachmentRepository(client),
  directory:(client:QueryableClient)=>{const people=createPostgresPeopleDirectoryRepository(client);return {findPerson:(id:string)=>people.findPersonById(id),findOrganizationUnit:(id:string)=>people.findOrganizationUnitById(id)};},
  storage:createLocalStorageAdapter()
 };
 app.register(async scoped=>{
  scoped.setErrorHandler((error,_req,reply)=>{
   if(error&&typeof error==='object'&&'statusCode' in error&&error.statusCode===413)return reply.code(413).send({error:'FILE_TOO_LARGE'});
   if(error instanceof z.ZodError)return reply.code(400).send({error:'EMPLOYEE_INVALID_INPUT'});
   if(error instanceof ChatError)return reply.code(error.statusCode).send({error:error.code});
   if(error instanceof GatewayError)return reply.code(error.statusCode).send({version:'1.0',error:{code:error.code,writeOutcome:error.writeOutcome}});
   if(error instanceof AppV2CallError)return reply.code(error.statusCode).send({error:{code:error.code,writeOutcome:error.writeOutcome}});
   if(error instanceof EmployeeIdentityError)return reply.code(error.statusCode).send({error:error.code});
   if(error instanceof AppManagementError)return reply.code(503).send({error:error.code});
   if(error instanceof AppAttachmentError)return reply.code(error.code==='FILE_TOO_LARGE'?413:error.code==='ACCESS_DENIED'?403:error.code==='ATTACHMENT_UNAVAILABLE'?503:error.code==='ATTACHMENT_LIMIT'?409:400).send({error:error.code});
   if(error instanceof AttachmentError)return reply.code(403).send({error:'ACCESS_DENIED'});
   return reply.code(503).send({error:'EMPLOYEE_SERVICE_UNAVAILABLE'});
  });
  scoped.addHook('preHandler',async(req,reply)=>{
   reply.header('Cache-Control','no-store');if(req.method!=='GET'&&req.headers.origin!==options.origin)throw new EmployeeIdentityError(403,'EMPLOYEE_ORIGIN_DENIED');
   if(req.routeOptions.url==='/api/employee/auth/login'){
    const now=Date.now();for(const [id,entry]of attempts)if(entry.until<=now)attempts.delete(id);
    if(!attempts.has(req.ip)&&attempts.size>=10000)throw new EmployeeIdentityError(429,'EMPLOYEE_RATE_LIMIT');
    const entry=attempts.get(req.ip)??{count:0,until:now+60000};attempts.set(req.ip,entry);if(++entry.count>5)throw new EmployeeIdentityError(429,'EMPLOYEE_RATE_LIMIT');
   }else {
    const passwordRoute=({GET:'/api/employee/auth/me',POST:'/api/employee/auth/logout',PATCH:'/api/employee/auth/password'} as Record<string,string>)[req.method];
    const account=await options.service.authenticate(req.cookies[EMPLOYEE_SESSION_COOKIE],true);
    if(!account)throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');
    if(account.passwordChangeRequired&&req.routeOptions.url!==passwordRoute)throw new EmployeeIdentityError(403,'EMPLOYEE_PASSWORD_CHANGE_REQUIRED');
    if(req.routeOptions.url!==passwordRoute)precheckedIdentity.set(req,{source:'session',userId:account.personId});
   }
  });
  scoped.post('/auth/login',{bodyLimit:4096},async(req,reply)=>{const result=await options.service.login(req.body);reply.setCookie(EMPLOYEE_SESSION_COOKIE,result.token,{...cookie,maxAge:8*60*60});return result.account;});
  scoped.get('/auth/me',async req=>options.service.authenticate(req.cookies[EMPLOYEE_SESSION_COOKIE],true));
  scoped.post('/auth/logout',async(req,reply)=>{await options.service.logout(req.cookies[EMPLOYEE_SESSION_COOKIE]!);options.management?.invalidateEmployeeSessions();reply.clearCookie(EMPLOYEE_SESSION_COOKIE,cookie);return {ok:true};});
  scoped.get('/dashboard-layout',async req=>options.service.dashboardLayout(req.cookies[EMPLOYEE_SESSION_COOKIE]));
  scoped.put('/dashboard-layout',{bodyLimit:8192},async req=>options.service.saveDashboardLayout(req.cookies[EMPLOYEE_SESSION_COOKIE]!,req.body));
  scoped.get('/profile',async req=>options.service.profile(req.cookies[EMPLOYEE_SESSION_COOKIE]));
  scoped.patch('/profile',{bodyLimit:4096},async req=>options.service.updateProfile(req.cookies[EMPLOYEE_SESSION_COOKIE]!,req.body));
  scoped.patch('/auth/password',{bodyLimit:4096},async(req,reply)=>{await options.service.changePassword(req.cookies[EMPLOYEE_SESSION_COOKIE]!,req.body);options.management?.invalidateEmployeeSessions();reply.clearCookie(EMPLOYEE_SESSION_COOKIE,cookie);return {ok:true};});
  scoped.get('/notifications',async req=>options.service.notifications(req.cookies[EMPLOYEE_SESSION_COOKIE]));
  scoped.post<{Params:{id:string}}>('/notifications/:id/read',{bodyLimit:1024},async req=>options.service.markNotificationRead(req.cookies[EMPLOYEE_SESSION_COOKIE]!,req.params.id));
  scoped.get('/managed-apps',async req=>({applications:options.business?await options.business.ownedApps((await resolveRequestIdentity(req)).userId):[]}));
  async function ownerId(req:FastifyRequest){return (await resolveRequestIdentity(req)).userId;}
  if(options.chat){
   const chat=options.chat;
   scoped.get('/chat/capabilities',async req=>({capabilities:await chat.capabilities(await ownerId(req))}));
   scoped.get('/chats',async req=>({sessions:await chat.list(await ownerId(req))}));
   scoped.get<{Params:{id:string}}>('/chats/:id',async req=>chat.read(await ownerId(req),z.string().uuid().parse(req.params.id)));
   scoped.post('/chats/messages',{bodyLimit:8192},async(req,reply)=>{const input=chatMessageInput.parse(req.body);return reply.code(202).send(await chat.send(await ownerId(req),input));});
   scoped.post<{Params:{id:string;requestId:string}}>('/chats/:id/runs/:requestId/cancel',{bodyLimit:1024},async req=>{const p=z.object({id:z.string().uuid(),requestId:z.string().uuid()}).parse(req.params);return chat.cancel(await ownerId(req),p.id,p.requestId);});
  }
  scoped.get<{Params:{appId:string}}>('/apps/:appId/business-authorization',async req=>{if(!options.business)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');return options.business.snapshot(req.params.appId,await ownerId(req));});
  scoped.get<{Params:{appId:string}}>('/apps/:appId/business-directory',async req=>{if(!options.business)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');return options.business.directory(req.params.appId,await ownerId(req),req.query);});
  scoped.post<{Params:{appId:string}}>('/apps/:appId/business-authorization',{bodyLimit:65536},async req=>{if(!options.business)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');const result=await options.business.change(req.params.appId,await ownerId(req),req.body);options.management?.invalidateEmployeeSessions();return result;});
  scoped.post<{Params:{appId:string}}>('/apps/:appId/business-delegation',{bodyLimit:16384},async req=>{if(!options.business)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');const result=await options.business.delegate(req.params.appId,await ownerId(req),req.body);options.management?.invalidateEmployeeSessions();return result;});
  scoped.get('/apps',async req=>{
   if(!options.management)return {applications:[]};
   return options.management.employeeApps(()=>resolveRequestIdentity(req));
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/dashboard',async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   return options.management.employeeDashboard(req.params.appId,()=>resolveRequestIdentity(req));
  });
  // Application pages: page session, immutable page bundle and icon.
  scoped.get<{Params:{appId:string}}>('/apps/:appId/v2-session',async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const query=z.object({path:z.string().max(512).default('/')}).strict().parse(req.query);
   return options.management.employeeV2Session(req.params.appId,query.path,()=>resolveRequestIdentity(req));
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/v2-platform',{bodyLimit:16384},async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const input=z.object({operation:z.string().min(1).max(100),params:z.unknown().optional()}).strict().parse(req.body);
   return {result:await options.management.invokeEmployeeV2Platform(req.params.appId,()=>resolveRequestIdentity(req),{operation:input.operation,params:input.params??{}},z.string().min(1).max(256).parse(req.headers['x-mop-employee-admission']))};
  });
  scoped.get<{Params:{appId:string;sha256:string;file:string}}>('/apps/:appId/v2/:sha256/:file',async(req,reply)=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const params=z.object({appId:z.string().max(64),sha256:z.string().regex(/^[a-f0-9]{64}$/),file:z.enum(['ui.js','ui.css'])}).strict().parse(req.params);
   const bytes=await options.management.employeeV2Asset(params.appId,params.sha256,params.file,()=>resolveRequestIdentity(req));
   reply.header('Cache-Control','private, max-age=31536000, immutable').header('X-Content-Type-Options','nosniff');
   return reply.type(params.file==='ui.js'?'text/javascript; charset=utf-8':'text/css; charset=utf-8').send(bytes);
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/icon',async(req,reply)=>{
   const icon=await options.management?.appIcon(req.params.appId);
   if(!icon)return reply.code(404).send({error:'APP_ICON_NOT_FOUND'});
   reply.header('Cache-Control','private, max-age=300').header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'").header('X-Content-Type-Options','nosniff');
   return reply.type(icon.contentType).send(icon.bytes);
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/api',{bodyLimit:65536},async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const input=z.object({apiId:z.string().min(1).max(100),method:z.enum(['GET','POST','PUT','PATCH','DELETE']),path:z.string().min(1).max(512),payload:z.unknown().refine(value=>value!==undefined)}).strict().parse(req.body);
   return {result:await options.management.invokeEmployeeApi(req.params.appId,()=>resolveRequestIdentity(req),{...input,payload:input.payload},z.string().min(1).max(256).parse(req.headers['x-mop-employee-admission']))};
  });
  scoped.addContentTypeParser('application/octet-stream',(_req,body,done)=>done(null,body));
  let activeUploads=0;
  const uploads=new WeakSet<FastifyRequest>();
  const admitUpload=async(req:FastifyRequest)=>{
   if(req.headers.origin!==options.origin)throw new EmployeeIdentityError(403,'EMPLOYEE_ORIGIN_DENIED');
   const account=await options.service.authenticate(req.cookies[EMPLOYEE_SESSION_COOKIE],true);
   if(!account||account.passwordChangeRequired)throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');
   if(Number(req.headers['content-length']??0)>APP_ATTACHMENT_MAX_BYTES)throw new AppAttachmentError('FILE_TOO_LARGE');
   if(activeUploads>=2)throw new EmployeeIdentityError(429,'EMPLOYEE_RATE_LIMIT');
   activeUploads++;uploads.add(req);
  };
  const releaseUpload=(req:FastifyRequest)=>{if(uploads.delete(req))activeUploads--;};
  scoped.post<{Params:{appId:string}}>('/apps/:appId/attachments',{
   bodyLimit:APP_ATTACHMENT_MAX_BYTES,onRequest:admitUpload,onRequestAbort:async req=>releaseUpload(req),onResponse:async req=>releaseUpload(req)
  },async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const input=z.object({entityType:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),entityId:z.string().uuid(),intentId:z.string().uuid(),fileName:z.string().min(1).max(180)}).strict().parse(req.query);
   const admission=z.string().min(1).max(256).parse(req.headers['x-mop-employee-admission']);
   const stream=req.body;if(!(stream instanceof Readable))throw new AppAttachmentError('INVALID_FILE');
   const authorize=()=>options.management!.authorizeEmployeeAttachment(req.params.appId,()=>resolveRequestIdentity(req),admission,{action:'upload',entityType:input.entityType,entityId:input.entityId,requestId:input.intentId});
   const first=await authorize(),client=await attachmentBackend.connect();
   try{
    let firstUsed=false;
    const transfer=createAppAttachmentTransfer({storage:attachmentBackend.storage,repository:attachmentBackend.repository(client),directory:attachmentBackend.directory(client),
     authorize:async()=>{const result=firstUsed?await authorize():first;firstUsed=true;return {organizationId:result.organizationId};}});
    return await transfer.upload(first.context,{appId:req.params.appId,entityType:input.entityType,entityId:input.entityId,intentId:input.intentId,fileName:input.fileName,stream});
   }finally{client.release();}
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/attachments',async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const input=z.object({entityType:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),entityId:z.string().uuid(),afterId:z.string().uuid().optional()}).strict().parse(req.query);
   const admission=z.string().min(1).max(256).parse(req.headers['x-mop-employee-admission']);
   const client=await attachmentBackend.connect();
   try{
    const authorize=()=>options.management!.authorizeEmployeeAttachment(req.params.appId,()=>resolveRequestIdentity(req),admission,
     {action:'read',entityType:input.entityType,entityId:input.entityId,requestId:input.entityId});
    const first=await authorize();let firstUsed=false;
    const transfer=createAppAttachmentTransfer({storage:attachmentBackend.storage,repository:attachmentBackend.repository(client),directory:attachmentBackend.directory(client),
     authorize:async()=>{const result=firstUsed?await authorize():first;firstUsed=true;return {organizationId:result.organizationId};}});
    return await transfer.list(first.context,req.params.appId,input.entityType,input.entityId,input.afterId);
   }finally{client.release();}
  });
  scoped.get<{Params:{appId:string;attachmentId:string}}>('/apps/:appId/attachments/:attachmentId',async(req,reply)=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const attachmentId=z.string().uuid().parse(req.params.attachmentId),admission=z.string().min(1).max(256).parse(req.headers['x-mop-employee-admission']);
   const client=await attachmentBackend.connect();
   try{
    const repository=attachmentBackend.repository(client),record=await repository.findAttachmentById(attachmentId);
    if(!record||record.sourceAppId!==req.params.appId)throw new AppAttachmentError('ACCESS_DENIED');
    const authorize=()=>options.management!.authorizeEmployeeAttachment(req.params.appId,()=>resolveRequestIdentity(req),admission,
     {action:'read',entityType:record.sourceEntityType,entityId:record.sourceEntityId,attachmentId,requestId:attachmentId});
    const first=await authorize();let firstUsed=false;
    const transfer=createAppAttachmentTransfer({storage:attachmentBackend.storage,repository,directory:attachmentBackend.directory(client),
     authorize:async()=>{const result=firstUsed?await authorize():first;firstUsed=true;return {organizationId:result.organizationId};}});
    const file=await transfer.read(first.context,req.params.appId,attachmentId);
    reply.header('Content-Type',file.contentType).header('Content-Length',file.sizeBytes).header('X-Content-Type-Options','nosniff')
     .header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
     .header('X-Mop-Attachment-Name',encodeURIComponent(file.fileName));
    return reply.send(file.stream);
   }finally{client.release();}
  });
  let activeArchives=0;
  scoped.post<{Params:{appId:string}}>('/apps/:appId/attachments-archive',{bodyLimit:32768},async(req,reply)=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   if(activeArchives>=2)throw new EmployeeIdentityError(429,'EMPLOYEE_RATE_LIMIT');
   const safe=z.string().min(1).max(180).regex(/^[^\\/\u0000-\u001f\u007f<>:"|?*]+\.zip$/);
   const input=z.object({fileName:safe,batch:z.boolean(),records:z.array(z.object({entityType:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),entityId:z.string().uuid(),fileName:safe}).strict()).min(1).max(100)}).strict().parse(req.body);
   if(!input.batch&&input.records.length!==1||new Set(input.records.map(row=>row.entityId)).size!==input.records.length||new Set(input.records.map(row=>row.fileName)).size!==input.records.length)throw new AppAttachmentError('INVALID_FILE');
   const admission=z.string().min(1).max(256).parse(req.headers['x-mop-employee-admission']);
   activeArchives++;let released=false;const release=()=>{if(!released){released=true;activeArchives--;}};
   const controller=new AbortController();req.raw.once('aborted',()=>controller.abort());reply.raw.once('close',()=>{controller.abort();release();});
   try{
    const groups:ZipEntry[]=[],single:ZipEntry[]=[];let totalBytes=0,fileCount=0;
    for(const target of input.records){
     const authorize=()=>options.management!.authorizeEmployeeAttachment(req.params.appId,()=>resolveRequestIdentity(req),admission,{action:'export',entityType:target.entityType,entityId:target.entityId,requestId:target.entityId});
     const first=await authorize(),client=await attachmentBackend.connect();
     try{
      const repository=attachmentBackend.repository(client),files=await repository.listAttachments({sourceAppId:req.params.appId,sourceEntityType:target.entityType,sourceEntityId:target.entityId,lifecycle:'active',limit:500});
      if(!files.length)throw new AppAttachmentError('ATTACHMENT_UNAVAILABLE');const entries:ZipEntry[]=[],used=new Set<string>();
      for(const row of files){
       if(row.ownerOrganizationUnitId!==first.organizationId||row.storageKind!=='app-attachments')throw new AppAttachmentError('ACCESS_DENIED');
       totalBytes+=row.sizeBytes;if(++fileCount>1000||totalBytes>2*1024*1024*1024)throw new AppAttachmentError('ATTACHMENT_LIMIT');
       if(!await attachmentBackend.storage.exists(row.storageKind,row.storageFileName))throw new AppAttachmentError('ATTACHMENT_UNAVAILABLE');
       let fileName=row.originalFileName;if(used.has(fileName))fileName=`${row.id}-${fileName}`;used.add(fileName);
       entries.push({name:fileName,size:row.sizeBytes,async open(){
        const connection=await attachmentBackend.connect();try{const live=await authorize();const transfer=createAppAttachmentTransfer({storage:attachmentBackend.storage,repository:attachmentBackend.repository(connection),directory:attachmentBackend.directory(connection),authorize:async()=>({organizationId:(await authorize()).organizationId})});return (await transfer.read(live.context,req.params.appId,row.id)).stream;}finally{connection.release();}
       }});
      }
      if(!(await first.context.authorize('platform.attachments.read',{organizationUnitId:first.organizationId})).allowed)throw new AppAttachmentError('ACCESS_DENIED');
      if(input.batch)groups.push({name:target.fileName,size:zipSize(entries),open:async()=>zipStream(entries,controller.signal)});else single.push(...entries);
     }finally{client.release();}
    }
    const entries=input.batch?groups:single,size=zipSize(entries);if(size>2*1024*1024*1024)throw new AppAttachmentError('ATTACHMENT_LIMIT');
    const stream=zipStream(entries,controller.signal);stream.once('close',release);stream.once('error',release);
    reply.header('Content-Type','application/zip').header('Content-Length',size).header('X-Content-Type-Options','nosniff').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`).header('X-Mop-Attachment-Name',encodeURIComponent(input.fileName));
    return reply.send(stream);
   }catch(error){release();throw error;}
  });
 },{prefix:'/api/employee'});
 app.register(async scoped=>{
  scoped.setErrorHandler((error,_req,reply)=>{
   if(error instanceof EmployeeIdentityError||error instanceof AdminIdentityError)return reply.code(error.statusCode).send({error:error.code});
   if(error instanceof z.ZodError)return reply.code(400).send({error:'EMPLOYEE_INVALID_INPUT'});
   return reply.code(503).send({error:'EMPLOYEE_MANAGEMENT_UNAVAILABLE'});
  });
  scoped.addHook('preHandler',async(req,reply)=>{reply.header('Cache-Control','no-store');if(req.method!=='GET'&&req.headers.origin!==(options.adminOrigin??options.origin))throw new EmployeeIdentityError(403,'EMPLOYEE_ORIGIN_DENIED');});
  scoped.get('/employee-accounts',async req=>options.service.list(await options.resolveAdmin(req),req.query));
  scoped.get<{Params:{appId:string}}>('/apps/:appId/employee-access',async req=>{const context=await options.resolveAdmin(req);if(!options.access)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');return options.access.list(context,req.params.appId);});
  scoped.put<{Params:{appId:string}}>('/apps/:appId/employee-access',{bodyLimit:4096},async req=>{const context=await options.resolveAdmin(req);if(!options.access)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');const result=await options.access.set(context,req.params.appId,req.body);options.management?.invalidateEmployeeSessions();return result;});
  scoped.post('/employee-accounts',{bodyLimit:4096},async(req,reply)=>{const result=await options.service.create(await options.resolveAdmin(req),req.body);options.management?.invalidateEmployeeSessions();return reply.code(201).send(result);});
  scoped.patch<{Params:{id:string}}>('/employee-accounts/:id',{bodyLimit:4096},async req=>{const result=await options.service.update(await options.resolveAdmin(req),req.params.id,req.body);options.management?.invalidateEmployeeSessions();return result;});
 },{prefix:'/api/admin'});
}
