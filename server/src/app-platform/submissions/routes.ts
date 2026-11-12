import {expectedOrigin} from '../../core/http/index.js';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import {AdminIdentityError,appendAdminAudit} from '../../core/admin-identity/index.js';
import {EmployeeIdentityError,EMPLOYEE_SESSION_COOKIE,type EmployeeIdentityService} from '../../platform/employee-identity/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
import type {AppManagement} from '../management/service.js';
import {inspectMopkg,MopkgError} from '@metro/platform-sdk/mopkg';
import {MOPKG_BODY_LIMIT,mopkgBody} from '../v2/upload.js';
const rows=async<T>(db:QueryableClient,sql:string,args:readonly unknown[]=[])=>((await db.query(sql,args)) as {rows:T[]}).rows;
const fail=(code:string,status=403):never=>{throw new EmployeeIdentityError(status,code);};
const summary=`id,app_id AS "appId",name,version,kind,status,revision,reason,created_at AS "createdAt"`;
const adminSummary=`s.id,s.app_id AS "appId",s.name,s.version,s.kind,s.status,s.revision,s.reason,s.created_at AS "createdAt",p.name AS "submittedBy"`;
const reviewPageSize=20;
type Submission={id:string;person_id:string;app_id:string;kind:string;target_revision:number|null;package_bytes:Buffer|null;status:string;revision:string};
export function registerAppSubmissionRoutes(app:FastifyInstance,options:{pool:ConnectablePool;origin:string;adminOrigin?:string;employee:EmployeeIdentityService;resolveAdmin:(req:FastifyRequest)=>Promise<PlatformAdministratorContext>;management?:AppManagement}){
 async function read<T>(work:(db:QueryableClient)=>Promise<T>){const db=await options.pool.connect();try{return await work(db);}finally{db.release();}}
 async function submitter(req:FastifyRequest){return (await options.employee.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE])).userId;}
 async function native(req:FastifyRequest){const context=await options.resolveAdmin(req);if(!(await context.authorize('platform.authorization.manage',{})).allowed)fail('ADMIN_ACCESS_DENIED');return context;}
 const management=()=>options.management??fail('APP_MANAGEMENT_UNAVAILABLE',503);
 async function current(db:QueryableClient,person:string,appId:string,kind:string){
  const [installed]=await rows<{id:string;record:{revision:number}}>(db,'SELECT id,record FROM platform_app_installations WHERE app_id=$1',[appId]);
  if(kind==='new'){if(installed)fail('APP_ALREADY_INSTALLED',409);return null;}
  if(!installed)fail('APP_NOT_FOUND',404);
  if(!(await rows(db,'SELECT installation_id FROM platform_app_authorization WHERE installation_id=$1 AND owner_person_id=$2',[installed.id,person])).length)fail('APP_OWNER_REQUIRED');
  return installed.record.revision;
 }
 const packageOf=(s:Submission)=>{if(!s.package_bytes)fail('SUBMISSION_PACKAGE_UNSUPPORTED',409);return new Uint8Array(s.package_bytes!);};
 app.register(async scoped=>{
  let uploads=0;const admitted=new WeakSet<FastifyRequest>();
  scoped.addHook('onRequest',async(req,reply)=>{
   reply.header('Cache-Control','no-store');if(req.method!=='GET'&&req.headers.origin!==expectedOrigin(req.url,options))fail('ORIGIN_DENIED');
   if(req.url.startsWith('/api/admin/'))await native(req);else await submitter(req);
   if(req.method==='POST'){if(uploads>=2)fail('SUBMISSION_BUSY',429);uploads++;admitted.add(req);}
  });
  scoped.addHook('onResponse',async req=>{if(admitted.delete(req))uploads--;});
  // A disconnected upload has no response; release its slot exactly once.
  scoped.addHook('onRequestAbort',async req=>{if(admitted.delete(req))uploads--;});
  scoped.setErrorHandler((error,_req,reply)=>{
   if(error instanceof EmployeeIdentityError||error instanceof AdminIdentityError)return reply.code(error.statusCode).send({error:error.code});
   if(error instanceof MopkgError)return reply.code(400).send({error:error.code});
   if(error instanceof z.ZodError)return reply.code(400).send({error:'INVALID_SUBMISSION'});
   return reply.code(503).send({error:'SUBMISSION_NOT_CONFIRMED'});
  });
  scoped.get('/api/employee/app-submissions',async req=>read(async db=>({submissions:await rows(db,`SELECT ${summary} FROM platform_app_submissions WHERE person_id=$1 ORDER BY created_at DESC LIMIT 100`,[await submitter(req)])})));
  scoped.post('/api/employee/app-submissions',{bodyLimit:MOPKG_BODY_LIMIT},async req=>{
   const input=z.object({kind:z.enum(['new','update']),appId:z.string().min(1).max(100).optional(),requestId:z.string().regex(/^[a-zA-Z0-9-]{16,64}$/),package:z.string()}).strict().parse(req.body),person=await submitter(req);
   const bytes=mopkgBody({package:input.package}),inspection=inspectMopkg(bytes),manifest=inspection.manifest;
   if(!manifest||inspection.issues.length)fail('INVALID_SUBMISSION_PACKAGE',400);
   if(input.appId!==undefined&&(input.kind!=='update'||manifest!.id!==input.appId))fail('SUBMISSION_APP_MISMATCH',400);
   const digest=inspection.sha256;
   return read(db=>runDatabaseTransaction(db,async()=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('app-submissions',0))");await submitter(req);
    const [existing]=await rows<{id:string;digest:string;kind:string}>(db,'SELECT id,digest,kind FROM platform_app_submissions WHERE person_id=$1 AND (request_id=$2 OR $2=ANY(retry_ids))',[person,input.requestId]);
    if(existing){if(existing.digest!==digest||existing.kind!==input.kind)fail('SUBMISSION_ID_CONFLICT',409);return {id:existing.id};}
    const target=await current(db,person,manifest!.id,input.kind);
    const [duplicate]=await rows<{id:string}>(db,`SELECT id FROM platform_app_submissions
     WHERE person_id=$1 AND digest=$2 AND kind=$3 AND target_revision IS NOT DISTINCT FROM $4
       AND status IN ('pending','processing','uncertain') ORDER BY created_at DESC,id DESC LIMIT 1`,[person,digest,input.kind,target]);
    if(duplicate){
     // Under the same advisory lock as the lookup. An acknowledged retry must stay bound after review.
     const remembered=await rows(db,`UPDATE platform_app_submissions SET retry_ids=array_append(retry_ids,$2::text)
      WHERE id=$1 AND cardinality(retry_ids)<100 RETURNING id`,[duplicate.id,input.requestId]);
     if(!remembered.length)fail('SUBMISSION_QUOTA',429);
     return {id:duplicate.id};
    }
    const [quota]=await rows<{total:string;mine:string}>(db,'SELECT coalesce(sum(bytes),0)::text AS total,count(*) FILTER(WHERE person_id=$1)::text AS mine FROM platform_app_submissions',[person]);
    if(Number(quota.total)+bytes.length>512*1024*1024||Number(quota.mine)>=100)fail('SUBMISSION_QUOTA',429);
    const id=randomUUID();await db.query(`INSERT INTO platform_app_submissions(id,person_id,request_id,digest,app_id,name,version,kind,target_revision,package_bytes,bytes,status,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)`,[id,person,input.requestId,digest,manifest!.id,manifest!.name,manifest!.version,input.kind,target,Buffer.from(bytes),bytes.length,randomUUID()]);
    await appendAdminAudit(db,{actorId:person,action:'app.submission.create',targetId:id});return {id};
   }));
  });
  scoped.get('/api/admin/app-submissions',async req=>{
   const query=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),submission:z.string().uuid().optional()}).parse(req.query);
   return read(async db=>{
    const [count]=await rows<{total:string}>(db,'SELECT count(*)::text AS total FROM platform_app_submissions');
    const total=Number(count.total),page=Math.min(query.page,Math.max(1,Math.ceil(total/reviewPageSize)));
    const source='FROM platform_app_submissions s JOIN platform_people p ON p.id=s.person_id';
    const submissions=await rows(db,`SELECT ${adminSummary} ${source}
     ORDER BY (s.status='pending') DESC,s.created_at DESC,s.id DESC LIMIT $1 OFFSET $2`,[reviewPageSize,(page-1)*reviewPageSize]);
    const selected=query.submission?(await rows(db,`SELECT ${adminSummary} ${source} WHERE s.id=$1`,[query.submission]))[0]??null:null;
    await native(req);
    return {submissions,total,page,pageSize:reviewPageSize,selected};
   });
  });
  const load=async(id:string)=>read(async db=>{const [s]=await rows<Submission>(db,'SELECT * FROM platform_app_submissions WHERE id=$1',[z.string().uuid().parse(id)]);if(!s)fail('SUBMISSION_NOT_FOUND',404);return s;});
  scoped.post<{Params:{id:string}}>('/api/admin/app-submissions/:id/preview',{bodyLimit:4096},async req=>{
   const s=await load(req.params.id),context=await native(req),mgr=management();if(s.status!=='pending')fail('SUBMISSION_NOT_PENDING',409);
   return mgr.previewPackage(context,packageOf(s));
  });
  scoped.post<{Params:{id:string}}>('/api/admin/app-submissions/:id/review',{bodyLimit:4096},async req=>{
   const v=z.object({revision:z.string().uuid(),decision:z.enum(['approve','reject']),reason:z.string().trim().max(500).default(''),digest:z.string().optional()}).strict().parse(req.body),context=await native(req),s=await load(req.params.id);
   if(s.status!=='pending'||s.revision!==v.revision)fail('STALE_REVISION',409);
   if(v.decision==='approve'){
    const preview=await management().previewPackage(context,packageOf(s));
    if(preview.sha256!==v.digest||!preview.installable)fail('SUBMISSION_PREVIEW_CHANGED',409);
   }
   const claim=()=>read(db=>runDatabaseTransaction(db,async()=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('app-submissions',0))");await native(req);
    if(v.decision==='approve'&&(await current(db,s.person_id,s.app_id,s.kind))!==s.target_revision)fail('SUBMISSION_TARGET_CHANGED',409);
    const changed=await rows(db,`UPDATE platform_app_submissions SET status=$3,revision=$4,reviewer_id=$5,reason=$6,updated_at=now() WHERE id=$1 AND revision=$2 AND status='pending' RETURNING id`,[s.id,v.revision,v.decision==='approve'?'processing':'rejected',randomUUID(),context.administrator.id,v.reason]);
    if(!changed.length)fail('STALE_REVISION',409);await appendAdminAudit(db,{actorId:context.administrator.id,action:`app.submission.${v.decision}`,targetId:s.id});
   }));
   if(v.decision==='reject'){await claim();return {status:'rejected'};}
   let claimed=false;
   try{
    const result=await management().installPackage(context,packageOf(s),async()=>{await claim();claimed=true;});
    const status=['installed','updated','repaired'].includes(result.state)?'completed':'uncertain';
    await read(db=>db.query("UPDATE platform_app_submissions SET status=$2,revision=$3,updated_at=now() WHERE id=$1 AND status='processing'",[s.id,status,randomUUID()]));return {status};
   }catch(error){
    if(!claimed)throw error;
    await read(db=>db.query("UPDATE platform_app_submissions SET status='uncertain',revision=$2,updated_at=now() WHERE id=$1 AND status='processing'",[s.id,randomUUID()]));return {status:'uncertain'};
   }
  });
 });
}
