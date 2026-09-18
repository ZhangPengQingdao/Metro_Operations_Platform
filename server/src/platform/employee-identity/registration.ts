import {randomUUID,randomInt} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {z} from 'zod';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import type {PlatformAdministratorContext} from '../context/index.js';
import {appendAdminAudit} from '../../core/admin-identity/index.js';
import {EmployeeIdentityError} from './index.js';
export const registrationMigration:MigrationDefinition={id:'employee-registration-expand',title:'Employee registration approval',ownerTaskId:'PLATFORM-L3-021',phase:'expand',layer:'L3',dataRows:[],migrationRows:['MIG-072'],sourceTables:[],targetTables:['platform_employee_registrations','platform_registration_challenges'],dependsOn:['platform-employee-identity-expand'],recoveryNotes:'Keep applications and review audit; never activates pending applications.',async run({client}){await client.query(`
CREATE TABLE IF NOT EXISTS platform_registration_challenges(id uuid PRIMARY KEY,target integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS platform_employee_registrations(id uuid PRIMARY KEY,employee_no text NOT NULL,name text NOT NULL,phone text,wecom_user_id text,organization_id uuid NOT NULL REFERENCES platform_organization_units(id),password_hash text,status text NOT NULL CHECK(status IN ('pending','approved','rejected')),created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz,reviewer_id uuid,person_id uuid REFERENCES platform_people(id));
CREATE UNIQUE INDEX IF NOT EXISTS platform_registration_pending_employee ON platform_employee_registrations(lower(employee_no)) WHERE status='pending';`);}};
const rows=async<T=Record<string,unknown>>(db:QueryableClient,sql:string,args:readonly unknown[]=[])=>((await db.query(sql,args)) as {rows:T[]}).rows;
const application=z.object({employeeNo:z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).transform(v=>v.toLowerCase()),name:z.string().trim().min(1).max(100),phone:z.string().trim().max(50).regex(/^[+0-9 ()-]*$/).default(''),wecomUserId:z.string().trim().max(255).regex(/^[a-zA-Z0-9_.@-]*$/).default(''),organizationId:z.string().uuid(),password:z.string().min(12).refine(v=>Buffer.byteLength(v,'utf8')<=72),challengeId:z.string().uuid(),slider:z.number().int().min(0).max(100)}).strict();
export class RegistrationService {
 constructor(private pool:ConnectablePool){}
 private async read<T>(work:(db:QueryableClient)=>Promise<T>){const db=await this.pool.connect();try{return await work(db);}finally{db.release();}}
 private async manage(c:PlatformAdministratorContext){if(c.actorType!=='administrator'||c.execution.type!=='platform'||!(await c.authorize('platform.authorization.manage',{})).allowed)throw new EmployeeIdentityError(403,'REGISTRATION_DENIED');}
 async organizations(search:string){return this.read(db=>rows(db,"SELECT id,name,parent_id AS \"parentId\" FROM platform_organization_units WHERE status='active' AND ($1='' OR strpos(lower(name),lower($1))>0) ORDER BY name,id LIMIT 100",[search]));}
 async challenge(){return this.read(async db=>{await db.query('DELETE FROM platform_registration_challenges WHERE expires_at<now()');const id=randomUUID(),target=randomInt(65,96);await db.query("INSERT INTO platform_registration_challenges(id,target,expires_at) VALUES($1,$2,now()+interval '5 minutes')",[id,target]);return {id,target};});}
 async submit(input:unknown){const v=application.parse(input);
 // Consume before validation/hash: even failed attempts cannot reuse a challenge across processes.
 const [challenge]=await this.read(db=>rows<{target:number;valid:boolean}>(db,'DELETE FROM platform_registration_challenges WHERE id=$1 RETURNING target,expires_at>clock_timestamp() AND created_at<clock_timestamp()-interval \'500 milliseconds\' AS valid',[v.challengeId]));
 if(!challenge?.valid||Math.abs(challenge.target-v.slider)>2)throw new EmployeeIdentityError(400,'REGISTRATION_CHALLENGE_FAILED');
 const hash=await bcrypt.hash(v.password,12);
 try{return await this.read(db=>runDatabaseTransaction(db,async()=>{await db.query('SELECT pg_advisory_xact_lock(6013015)');
 if(!(await rows(db,"SELECT id FROM platform_organization_units WHERE id=$1 AND status='active' FOR SHARE",[v.organizationId])).length)throw new EmployeeIdentityError(400,'REGISTRATION_ORGANIZATION_INACTIVE');
 if((await rows(db,'SELECT id FROM platform_employee_accounts WHERE username=$1 UNION ALL SELECT id FROM platform_admin_accounts WHERE username=$1',[v.employeeNo])).length)throw new EmployeeIdentityError(409,'REGISTRATION_CONFLICT');
 await db.query("INSERT INTO platform_employee_registrations(id,employee_no,name,phone,wecom_user_id,organization_id,password_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending')",[randomUUID(),v.employeeNo,v.name,v.phone||null,v.wecomUserId||null,v.organizationId,hash]);return {status:'pending'};
 }));}catch(e){if((e as {code?:string}).code==='23505')throw new EmployeeIdentityError(409,'REGISTRATION_CONFLICT');throw e;}}
 async list(c:PlatformAdministratorContext,page:number){await this.manage(c);return this.read(async db=>{const applications=await rows(db,`SELECT r.id,r.employee_no AS "employeeNo",r.name,r.phone,r.wecom_user_id AS "wecomUserId",r.organization_id AS "organizationId",o.name AS organization,r.status,r.created_at AS "createdAt" FROM platform_employee_registrations r JOIN platform_organization_units o ON o.id=r.organization_id WHERE r.status='pending' ORDER BY r.created_at,r.id LIMIT 20 OFFSET $1`,[(page-1)*20]);const [count]=await rows<{total:string}>(db,"SELECT count(*) AS total FROM platform_employee_registrations WHERE status='pending'");await this.manage(c);return {applications,total:Number(count.total)};});}
 async review(c:PlatformAdministratorContext,id:string,input:unknown){await this.manage(c);z.string().uuid().parse(id);const v=z.discriminatedUnion('decision',[z.object({decision:z.literal('reject')}).strict(),z.object({decision:z.literal('approve'),organizationId:z.string().uuid(),positionId:z.string().uuid()}).strict()]).parse(input);
 try{return await this.read(db=>runDatabaseTransaction(db,async()=>{await db.query('SELECT pg_advisory_xact_lock(6013015)');await this.manage(c);
 const [r]=await rows<{employee_no:string;name:string;phone:string|null;wecom_user_id:string|null;password_hash:string;status:string}>(db,'SELECT * FROM platform_employee_registrations WHERE id=$1 FOR UPDATE',[id]);if(!r||r.status!=='pending')throw new EmployeeIdentityError(409,'REGISTRATION_ALREADY_REVIEWED');
 let personId:string|null=null;
 if(v.decision==='approve'){
 if(!(await rows(db,"SELECT id FROM platform_organization_units WHERE id=$1 AND status='active' FOR SHARE",[v.organizationId])).length||!(await rows(db,"SELECT id FROM platform_positions WHERE id=$1 AND status='active' FOR SHARE",[v.positionId])).length)throw new EmployeeIdentityError(400,'REGISTRATION_ASSIGNMENT_INACTIVE');
 if((await rows(db,'SELECT id FROM platform_admin_accounts WHERE username=$1 UNION ALL SELECT id FROM platform_employee_accounts WHERE username=$1',[r.employee_no])).length)throw new EmployeeIdentityError(409,'REGISTRATION_CONFLICT');
 const [existing]=await rows<{id:string;name:string;employment_status:string;organization_unit_id:string;position_id:string}>(db,'SELECT * FROM platform_people WHERE lower(employee_no)=$1 FOR UPDATE',[r.employee_no]);
 if(existing)throw new EmployeeIdentityError(409,'REGISTRATION_PERSON_EXISTS');
 personId=randomUUID();await db.query("INSERT INTO platform_people(id,employee_no,name,phone,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'active',now(),now())",[personId,r.employee_no,r.name,r.phone,v.organizationId,v.positionId]);
 if(r.wecom_user_id)await db.query("INSERT INTO platform_external_identities(id,person_id,provider,tenant_key,external_user_id,status,verified_at,created_at,updated_at) VALUES($1,$2,'wecom','default',$3,'active',NULL,now(),now())",[randomUUID(),personId,r.wecom_user_id]);
 await db.query("INSERT INTO platform_employee_accounts(id,person_id,username,password_hash,status) VALUES($1,$2,$3,$4,'active')",[randomUUID(),personId,r.employee_no,r.password_hash]);
 }
 await db.query('UPDATE platform_employee_registrations SET status=$1,password_hash=NULL,reviewed_at=now(),reviewer_id=$2,person_id=$3 WHERE id=$4',[v.decision==='approve'?'approved':'rejected',c.administrator.id,personId,id]);await appendAdminAudit(db,{actorId:c.administrator.id,action:'employee.registration.'+v.decision,targetId:id});return {ok:true};
 }));}catch(e){if((e as {code?:string}).code==='23505')throw new EmployeeIdentityError(409,'REGISTRATION_CONFLICT');throw e;}}
}
export async function registerRegistrationRoutes(app:FastifyInstance,o:{pool:ConnectablePool;origin:string;resolveAdmin:(r:FastifyRequest)=>Promise<PlatformAdministratorContext>}){const s=new RegistrationService(o.pool);await app.register(async api=>{
 api.addHook('onRequest',async(req,reply)=>{reply.header('Cache-Control','no-store');if(req.method!=='GET'&&req.headers.origin!==o.origin)throw new EmployeeIdentityError(403,'REGISTRATION_ORIGIN_DENIED');});
 api.setErrorHandler((e,_req,reply)=>{if(e instanceof EmployeeIdentityError)return reply.code(e.statusCode).send({error:e.code});if(e instanceof z.ZodError)return reply.code(400).send({error:'REGISTRATION_INVALID_INPUT'});const status=(e as {statusCode?:number}).statusCode;return reply.code(status===401||status===403||status===429?status:503).send({error:status===429?'REGISTRATION_RATE_LIMIT':status===401?'ADMIN_AUTH_REQUIRED':'REGISTRATION_UNAVAILABLE'});});
 api.get('/api/auth/registration/organizations',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async req=>({organizations:await s.organizations(z.object({q:z.string().trim().max(100).default('')}).parse(req.query).q)}));
 api.post('/api/auth/registration/challenge',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},()=>s.challenge());
 api.post('/api/auth/registration',{bodyLimit:4096,config:{rateLimit:{max:5,timeWindow:'1 minute'}}},req=>s.submit(req.body));
 api.get('/api/admin/registrations',async req=>s.list(await o.resolveAdmin(req),z.object({page:z.coerce.number().int().min(1).max(100000).default(1)}).parse(req.query).page));
 api.post<{Params:{id:string}}>('/api/admin/registrations/:id/review',{bodyLimit:4096},async req=>s.review(await o.resolveAdmin(req),req.params.id,req.body));
 });}
