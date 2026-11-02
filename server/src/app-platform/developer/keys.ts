import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';
export const developerMigration:MigrationDefinition={id:'developer-access-expand',title:'Personal development keys and read-only integration capabilities',ownerTaskId:'PLATFORM-L4-019',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-077'],sourceTables:[],targetTables:['platform_developer_keys','platform_developer_audit','platform_permissions'],dependsOn:['platform-employee-identity-expand','platform-authorization-expand','platform-password-policy-sessions-expand'],recoveryNotes:'Additive only. No keys or employee roles are provisioned.',async run({client}){await client.query(`
 CREATE TABLE IF NOT EXISTS platform_developer_keys(
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES platform_employee_accounts(id),request_id uuid NOT NULL,
 name text NOT NULL,token_hash text UNIQUE NOT NULL,token_prefix text NOT NULL,password_fingerprint text NOT NULL,
 scopes jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,revoked_at timestamptz,
 UNIQUE(account_id,request_id));
 CREATE TABLE IF NOT EXISTS platform_developer_audit(
 id uuid PRIMARY KEY,person_id uuid NOT NULL REFERENCES platform_people(id),key_id uuid REFERENCES platform_developer_keys(id),
 action text NOT NULL,target text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS developer_audit_person_time ON platform_developer_audit(person_id,created_at DESC);
 INSERT INTO platform_permissions(id,code,name,description,status,created_at,updated_at) VALUES
 ('49000000-0000-4000-8000-000000000077','platform.directory.read','读取公共目录','只读线路车站、组织工班、岗位及设备分类','active',now(),now()),
 ('49000000-0000-4000-8000-000000000078','platform.apps.read','跨应用查询','按声明依赖与当前员工权限调用开放查询接口','active',now(),now()) ON CONFLICT(code) DO NOTHING;
`);}};
export const developerKeyLifetimeMigration:MigrationDefinition={id:'developer-key-lifetime-expand',title:'Allow non-expiring personal development keys',ownerTaskId:'PLATFORM-L4-019',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-078'],sourceTables:['platform_developer_keys'],targetTables:['platform_developer_keys'],dependsOn:['developer-access-expand'],recoveryNotes:'Only allows null expiry; existing keys retain their expiry and scopes.',async run({client}){await client.query('ALTER TABLE platform_developer_keys ALTER COLUMN expires_at DROP NOT NULL');}};
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const rows=async<T>(db:QueryableClient,sql:string,args:readonly unknown[]=[])=>((await db.query(sql,args)) as {rows:T[]}).rows;
export const keyInput=z.object({requestId:z.string().uuid(),name:z.string().trim().min(1).max(60),days:z.number().int().min(1).max(90).nullable().default(null),scopes:z.array(z.enum(['directory','apps'])).min(1).max(2).refine(a=>new Set(a).size===a.length).default(['directory','apps'])}).strict();
const accountSql=`SELECT a.id,a.person_id AS "personId",a.password_hash AS "passwordHash" FROM platform_employee_accounts a JOIN platform_people p ON p.id=a.person_id JOIN platform_organization_units o ON o.id=p.organization_unit_id JOIN platform_positions pos ON pos.id=p.position_id WHERE a.person_id=$1 AND a.status='active' AND NOT EXISTS(SELECT 1 FROM platform_employee_sessions s WHERE s.account_id=a.id AND s.password_change_required AND s.expires_at>now()) AND p.employment_status='active' AND o.status='active' AND pos.status='active'`;
export async function requireDeveloperAccount(db:QueryableClient,personId:string){
 const [account]=await rows<{id:string;personId:string;passwordHash:string}>(db,accountSql,[personId]);
 if(!account)throw new EmployeeIdentityError(401,'DEVELOPER_AUTH_REQUIRED');return account;
}
const publicColumns=`id,name,token_prefix AS prefix,scopes,created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt"`;
export class DeveloperKeys {
 constructor(private readonly pool:ConnectablePool&QueryableClient){}
 private async transaction<T>(work:(db:QueryableClient)=>Promise<T>){const db=await this.pool.connect();try{return await runDatabaseTransaction(db,work);}finally{db.release();}}
 async list(personId:string){const a=await requireDeveloperAccount(this.pool,personId);return {keys:await rows(this.pool,`SELECT ${publicColumns} FROM platform_developer_keys WHERE account_id=$1 ORDER BY (revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())) DESC,created_at DESC LIMIT 100`,[a.id])};}
 async create(personId:string,value:unknown){const p=keyInput.parse(value);return this.transaction(async db=>{
  const a=await requireDeveloperAccount(db,personId);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`developer:${a.id}`]);
  const [old]=await rows<{name:string;scopes:string[];days:number|null}>(db,`SELECT name,scopes,extract(epoch from (expires_at-created_at))/86400 AS days FROM platform_developer_keys WHERE account_id=$1 AND request_id=$2`,[a.id,p.requestId]);
  if(old){if(old.name!==p.name||JSON.stringify(old.scopes)!==JSON.stringify(p.scopes)||(old.days===null?null:Number(old.days))!==p.days)throw new EmployeeIdentityError(409,'REQUEST_ID_REUSED');return {recorded:true,token:null};}
  const [count]=await rows<{count:string}>(db,'SELECT count(*) FROM platform_developer_keys WHERE account_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())',[a.id]);
  if(Number(count.count)>=5)throw new EmployeeIdentityError(409,'DEVELOPER_KEY_LIMIT');
  const token=`mop_dev_${randomBytes(32).toString('base64url')}`,id=randomUUID();
  await db.query(`INSERT INTO platform_developer_keys(id,account_id,request_id,name,token_hash,token_prefix,password_fingerprint,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now()+($9::integer * interval '1 day'))`,[id,a.id,p.requestId,p.name,digest(token),token.slice(0,16),digest(a.passwordHash),JSON.stringify(p.scopes),p.days]);
  await this.audit(personId,id,'key.create','',db);return {recorded:false,id,token};
 });}
 async revoke(personId:string,id:string,requestId:string){z.string().uuid().parse(id);z.string().uuid().parse(requestId);return this.transaction(async db=>{
  const a=await requireDeveloperAccount(db,personId);
  const changed=await rows(db,'UPDATE platform_developer_keys SET revoked_at=now() WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING id',[id,a.id]);
  if(changed.length)await this.audit(personId,id,'key.revoke',requestId,db);return {ok:true};
 });}
 async authenticate(header:unknown){
  if(typeof header!=='string'||!/^Bearer mop_dev_[A-Za-z0-9_-]{43}$/.test(header))throw new EmployeeIdentityError(401,'DEVELOPER_AUTH_REQUIRED');
  const [key]=await rows<{id:string;personId:string;scopes:('directory'|'apps')[];passwordFingerprint:string}>(this.pool,`SELECT k.id,a.person_id AS "personId",k.scopes,k.password_fingerprint AS "passwordFingerprint" FROM platform_developer_keys k JOIN platform_employee_accounts a ON a.id=k.account_id WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())`,[digest(header.slice(7))]);
  if(!key)throw new EmployeeIdentityError(401,'DEVELOPER_AUTH_REQUIRED');
  const account=await requireDeveloperAccount(this.pool,key.personId);
  if(digest(account.passwordHash)!==key.passwordFingerprint)throw new EmployeeIdentityError(401,'DEVELOPER_AUTH_REQUIRED');return key;
 }
 async audit(personId:string,keyId:string|null,action:string,target:string,db:QueryableClient=this.pool){await db.query('INSERT INTO platform_developer_audit(id,person_id,key_id,action,target) VALUES($1,$2,$3,$4,$5)',[randomUUID(),personId,keyId,action,target]);}
 async history(personId:string){await requireDeveloperAccount(this.pool,personId);return {events:await rows(this.pool,'SELECT action,target,key_id AS "keyId",created_at AS "createdAt" FROM platform_developer_audit WHERE person_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',[personId])};}
}
