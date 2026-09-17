import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {ConnectablePool} from '../../core/database/index.js';
import {ADMIN_SESSION_COOKIE,AdminIdentityError,type AdminIdentityService} from '../../core/admin-identity/index.js';
import {EMPLOYEE_SESSION_COOKIE,EmployeeIdentityError,type EmployeeIdentityService} from './index.js';

/** One entry point; account stores, cookie paths and authorization remain separate. */
export function registerUnifiedLogin(app:FastifyInstance,options:{origin:string;pool:ConnectablePool;admin:AdminIdentityService;employee:EmployeeIdentityService}){
 const attempts=new Map<string,{count:number;until:number}>();
 app.post('/api/auth/login',{bodyLimit:4096},async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  if(req.headers.origin!==options.origin)return reply.code(403).send({error:'LOGIN_ORIGIN_DENIED'});
  const now=Date.now();for(const [key,value]of attempts)if(value.until<=now)attempts.delete(key);
  if(!attempts.has(req.ip)&&attempts.size>=10000)return reply.code(429).send({error:'LOGIN_RATE_LIMIT'});
  const attempt=attempts.get(req.ip)??{count:0,until:now+60000};attempts.set(req.ip,attempt);
  if(++attempt.count>5)return reply.code(429).send({error:'LOGIN_RATE_LIMIT'});
  const parsed=z.object({username:z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/).transform(v=>v.toLowerCase()),password:z.string().max(72)}).strict().safeParse(req.body);
  if(!parsed.success)return reply.code(401).send({error:'LOGIN_FAILED'});
  const db=await options.pool.connect();let roles:string[];
  try{const result=await db.query("SELECT 'admin' AS kind FROM platform_admin_accounts WHERE username=$1 UNION ALL SELECT 'employee' AS kind FROM platform_employee_accounts WHERE username=$1",[parsed.data.username]) as {rows:{kind:string}[]};roles=result.rows.map(row=>row.kind);}finally{db.release();}
  // Existing ambiguous usernames fail closed; never select the more privileged identity.
  if(roles.length>1)return reply.code(409).send({error:'LOGIN_ACCOUNT_CONFLICT'});
  const kind=roles[0]==='admin'?'admin':'employee';
  try{
   const result=await (kind==='admin'?options.admin:options.employee).login(parsed.data);
   const cookie={httpOnly:true,secure:new URL(options.origin).protocol==='https:',sameSite:'strict' as const};
   reply.clearCookie(kind==='admin'?EMPLOYEE_SESSION_COOKIE:ADMIN_SESSION_COOKIE,{...cookie,path:kind==='admin'?'/api/employee':'/api/admin'});
   reply.setCookie(kind==='admin'?ADMIN_SESSION_COOKIE:EMPLOYEE_SESSION_COOKIE,result.token,{...cookie,path:kind==='admin'?'/api/admin':'/api/employee',maxAge:8*60*60});
   return {kind,account:result.account};
  }catch(error){if(error instanceof AdminIdentityError||error instanceof EmployeeIdentityError)return reply.code(401).send({error:'LOGIN_FAILED'});throw error;}
 });
}
