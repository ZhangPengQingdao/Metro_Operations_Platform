import {createHash,randomBytes,randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import type {PlatformAdministratorContext} from '../context/index.js';
import {appendAdminAudit} from '../../core/admin-identity/index.js';

export const EMPLOYEE_SESSION_COOKIE='mop_employee_session';
export const EMPLOYEE_IDENTITY_SQL=`
CREATE TABLE IF NOT EXISTS platform_employee_accounts(
 id uuid PRIMARY KEY,person_id uuid UNIQUE NOT NULL REFERENCES platform_people(id),username text UNIQUE NOT NULL,
 password_hash text NOT NULL,status text NOT NULL CHECK(status IN ('active','disabled')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_employee_sessions(
 token_hash text PRIMARY KEY,account_id uuid NOT NULL REFERENCES platform_employee_accounts(id),expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_employee_sessions_account ON platform_employee_sessions(account_id);`;
export const employeeIdentityMigration:MigrationDefinition={id:'platform-employee-identity-expand',title:'Independent employee accounts and sessions',ownerTaskId:'PLATFORM-L4-015',phase:'expand',layer:'L3',dataRows:[],migrationRows:['MIG-056'],sourceTables:[],targetTables:['platform_employee_accounts','platform_employee_sessions'],dependsOn:['platform-people-directory-expand'],recoveryNotes:'Additive schema only; never bootstrap employees or copy administrator accounts.',async run({client}){await client.query(EMPLOYEE_IDENTITY_SQL);}};
export class EmployeeIdentityError extends Error{constructor(readonly statusCode:number,readonly code:string){super(code);}}
export interface EmployeeAccount{id:string;personId:string;username:string;status:'active'|'disabled'}
type Row={id:string;person_id:string;username:string;password_hash:string;status:'active'|'disabled'};
const username=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/).transform(v=>v.toLowerCase());
const password=z.string().min(12).refine(v=>Buffer.byteLength(v,'utf8')<=72);
const publicAccount=(row:Row):EmployeeAccount=>({id:row.id,personId:row.person_id,username:row.username,status:row.status});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const activePerson=`SELECT p.id FROM platform_people p JOIN platform_organization_units o ON o.id=p.organization_unit_id JOIN platform_positions pos ON pos.id=p.position_id
 WHERE p.id=$1 AND p.employment_status='active' AND o.status='active' AND pos.status='active'`;
const rows=async<T>(db:QueryableClient,sql:string,args:readonly unknown[]=[])=>((await db.query(sql,args)) as {rows:T[]}).rows;
export class EmployeeIdentityService{
 constructor(private readonly pool:ConnectablePool){}
 private async read<T>(work:(db:QueryableClient)=>Promise<T>){const db=await this.pool.connect();try{return await work(db);}finally{db.release();}}
 private transaction<T>(work:(db:QueryableClient)=>Promise<T>){return this.read(db=>runDatabaseTransaction(db,async()=>{await db.query('SELECT pg_advisory_xact_lock(6013015)');return work(db);}));}
 private async manage(context:PlatformAdministratorContext){if(context.actorType!=='administrator'||context.execution.type!=='platform'||!(await context.authorize('platform.authorization.manage',{})).allowed)throw new EmployeeIdentityError(403,'EMPLOYEE_MANAGEMENT_DENIED');}
 private async validPerson(db:QueryableClient,personId:string){if(!(await rows(db,activePerson,[personId])).length)throw new EmployeeIdentityError(403,'EMPLOYEE_PERSON_INACTIVE');}
 async list(context:PlatformAdministratorContext,input:unknown){
  await this.manage(context);
  const query=z.object({search:z.string().trim().max(100).default(''),status:z.enum(['active','disabled']).optional(),page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).strict().parse(input);
  return this.read(async db=>{
   const where=`($1='' OR strpos(lower(a.username),lower($1))>0 OR strpos(lower(p.name),lower($1))>0 OR strpos(lower(p.employee_no),lower($1))>0) AND ($2::text IS NULL OR a.status=$2)`;
   const args=[query.search,query.status??null];
   const [count]=await rows<{total:string|number}>(db,`SELECT count(*) AS total FROM platform_employee_accounts a JOIN platform_people p ON p.id=a.person_id WHERE ${where}`,args);
   const accounts=await rows<{id:string;personId:string;username:string;status:string;personName:string;employeeNo:string;employmentStatus:string}>(db,`SELECT a.id,a.person_id AS "personId",a.username,a.status,p.name AS "personName",p.employee_no AS "employeeNo",p.employment_status AS "employmentStatus" FROM platform_employee_accounts a JOIN platform_people p ON p.id=a.person_id WHERE ${where} ORDER BY a.username,a.id LIMIT $3 OFFSET $4`,[...args,query.pageSize,(query.page-1)*query.pageSize]);
   await this.manage(context);
   return {accounts,total:Number(count.total),page:query.page,pageSize:query.pageSize};
  });
 }
 async create(context:PlatformAdministratorContext,input:unknown){
  await this.manage(context);const parsed=z.object({personId:z.string().uuid(),username,password}).strict().parse(input);
  const hash=await bcrypt.hash(parsed.password,12);
  return this.transaction(async db=>{await this.manage(context);await this.validPerson(db,parsed.personId);
   if((await rows(db,'SELECT id FROM platform_employee_accounts WHERE username=$1 OR person_id=$2',[parsed.username,parsed.personId])).length)throw new EmployeeIdentityError(409,'EMPLOYEE_ACCOUNT_EXISTS');
   const [account]=await rows<Row>(db,"INSERT INTO platform_employee_accounts(id,person_id,username,password_hash,status) VALUES($1,$2,$3,$4,'active') RETURNING *",[randomUUID(),parsed.personId,parsed.username,hash]);
   await appendAdminAudit(db,{actorId:context.administrator.id,action:'employee.create',targetId:account.id});return publicAccount(account);
  });
 }
 async update(context:PlatformAdministratorContext,id:string,input:unknown){
  await this.manage(context);z.string().uuid().parse(id);
  const parsed=z.object({status:z.enum(['active','disabled']).optional(),password:password.optional()}).strict().refine(v=>v.status!==undefined||v.password!==undefined).parse(input);
  const hash=parsed.password?await bcrypt.hash(parsed.password,12):undefined;
  return this.transaction(async db=>{await this.manage(context);
   const [account]=await rows<Row>(db,'SELECT * FROM platform_employee_accounts WHERE id=$1 FOR UPDATE',[id]);if(!account)throw new EmployeeIdentityError(404,'EMPLOYEE_NOT_FOUND');
   if(parsed.status==='active')await this.validPerson(db,account.person_id);
   await db.query('UPDATE platform_employee_accounts SET status=$1,password_hash=$2 WHERE id=$3',[parsed.status??account.status,hash??account.password_hash,id]);
   await db.query('DELETE FROM platform_employee_sessions WHERE account_id=$1',[id]);
   await appendAdminAudit(db,{actorId:context.administrator.id,action:'employee.update',targetId:id});return {...publicAccount(account),status:parsed.status??account.status};
  });
 }
 async authenticate(token?:string):Promise<EmployeeAccount|null>{
  if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
  return this.read(async db=>{
   const [row]=await rows<Row>(db,`SELECT a.* FROM platform_employee_accounts a JOIN platform_employee_sessions s ON s.account_id=a.id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND a.status='active'`,[digest(token)]);
   if(!row||!(await rows(db,activePerson,[row.person_id])).length)return null;
   return publicAccount(row);
  });
 }
 async login(input:unknown){
  const parsed=z.object({username,password:z.string().max(72).refine(v=>Buffer.byteLength(v,'utf8')<=72)}).strict().parse(input);
  const [candidate]=await this.read(db=>rows<Row>(db,'SELECT * FROM platform_employee_accounts WHERE username=$1',[parsed.username]));
  const valid=await bcrypt.compare(parsed.password,candidate?.password_hash??'$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW');
  if(!valid||!candidate||candidate.status!=='active')throw new EmployeeIdentityError(401,'EMPLOYEE_LOGIN_FAILED');
  return this.transaction(async db=>{
   const [account]=await rows<Row>(db,'SELECT * FROM platform_employee_accounts WHERE id=$1',[candidate.id]);
   if(!account||account.status!=='active'||account.password_hash!==candidate.password_hash||!(await rows(db,activePerson,[account.person_id])).length)throw new EmployeeIdentityError(401,'EMPLOYEE_LOGIN_FAILED');
   const token=randomBytes(32).toString('hex');await db.query('DELETE FROM platform_employee_sessions WHERE expires_at<=now()');
   await db.query('INSERT INTO platform_employee_sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)',[digest(token),account.id,new Date(Date.now()+8*60*60*1000)]);
   return {account:publicAccount(account),token};
  });
 }
 async profile(token?:string){
  const account=await this.authenticate(token);if(!account)throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');
  const result=await this.read(db=>rows<Record<string,string>>(db,`SELECT p.name,p.phone,(SELECT external_user_id FROM platform_external_identities WHERE person_id=p.id AND provider='wecom' AND tenant_key='default' AND status='active') AS "wecomUserId",p.employee_no AS "employeeNo",o.name AS organization,pos.name AS position FROM platform_people p JOIN platform_organization_units o ON o.id=p.organization_unit_id JOIN platform_positions pos ON pos.id=p.position_id WHERE p.id=$1`,[account.personId]));
  if(!await this.authenticate(token))throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');
  return {...account,...result[0]};
 }
 private async requireSelf(db:QueryableClient,token:string){
  const [account]=await rows<Row>(db,`SELECT a.* FROM platform_employee_accounts a JOIN platform_employee_sessions s ON s.account_id=a.id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.status='active' FOR UPDATE OF a`,[digest(token)]);
  if(!account)throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');
  await this.validPerson(db,account.person_id);return account;
 }
 async updateProfile(token:string,input:unknown){
  const parsed=z.object({phone:z.string().trim().max(50).regex(/^[+0-9 ()-]*$/),wecomUserId:z.string().trim().max(255).regex(/^[a-zA-Z0-9_.@-]*$/)}).strict().parse(input);
  try{return await this.transaction(async db=>{
   const account=await this.requireSelf(db,token);
   await db.query('UPDATE platform_people SET phone=$1,updated_at=now() WHERE id=$2',[parsed.phone||null,account.person_id]);
   if(parsed.wecomUserId){
    await db.query(`INSERT INTO platform_external_identities(id,person_id,provider,tenant_key,external_user_id,status,verified_at,created_at,updated_at)
     VALUES($1,$2,'wecom','default',$3,'active',NULL,now(),now())
     ON CONFLICT(person_id,provider,tenant_key) DO UPDATE SET external_user_id=EXCLUDED.external_user_id,status='active',
     verified_at=CASE WHEN platform_external_identities.external_user_id=EXCLUDED.external_user_id AND platform_external_identities.status='active' THEN platform_external_identities.verified_at ELSE NULL END,updated_at=now()`,[randomUUID(),account.person_id,parsed.wecomUserId]);
   }else await db.query("UPDATE platform_external_identities SET status='inactive',verified_at=NULL,updated_at=now() WHERE person_id=$1 AND provider='wecom' AND tenant_key='default'",[account.person_id]);
   await appendAdminAudit(db,{actorId:account.id,action:'employee.profile-update',targetId:account.person_id});return {ok:true};
  });}catch(error){if((error as {code?:string}).code==='23505')throw new EmployeeIdentityError(409,'EMPLOYEE_WECOM_ID_EXISTS');throw error;}
 }
 async changePassword(token:string,input:unknown){
  const parsed=z.object({currentPassword:z.string().max(256),newPassword:password}).strict().parse(input);
  if(!await this.authenticate(token))throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');
  const hash=await bcrypt.hash(parsed.newPassword,12);
  await this.transaction(async db=>{
   const account=await this.requireSelf(db,token);
   if(!await bcrypt.compare(parsed.currentPassword,account.password_hash))throw new EmployeeIdentityError(403,'EMPLOYEE_PASSWORD_INCORRECT');
   await db.query('UPDATE platform_employee_accounts SET password_hash=$1 WHERE id=$2',[hash,account.id]);
   await db.query('DELETE FROM platform_employee_sessions WHERE account_id=$1',[account.id]);
   await appendAdminAudit(db,{actorId:account.id,action:'employee.password-change',targetId:account.id});
  });
 }
 async notifications(token?:string){
  const account=await this.authenticate(token);if(!account)throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');
  const notifications=await this.read(db=>rows(db,`SELECT n.id,n.display_snapshot AS display,n.created_at AS "createdAt",r.read_at AS "readAt" FROM platform_notifications n JOIN platform_notification_recipients recipient ON recipient.notification_id=n.id AND recipient.person_id=$1 LEFT JOIN platform_notification_reads r ON r.notification_id=n.id AND r.person_id=$1 WHERE n.status='active' ORDER BY n.created_at DESC,n.id DESC LIMIT 50`,[account.personId]));
  if(!await this.authenticate(token))throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');
  return {notifications};
 }
 async logout(token:string){await this.transaction(async db=>{await db.query('DELETE FROM platform_employee_sessions WHERE token_hash=$1',[digest(token)]);});}
 async resolveIdentity(token?:string){const account=await this.authenticate(token);if(!account)throw new EmployeeIdentityError(401,'EMPLOYEE_AUTH_REQUIRED');return {source:'session' as const,userId:account.personId};}
}
