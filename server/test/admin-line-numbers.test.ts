import {ADMIN_PASSWORD_SESSION_SQL} from '../src/setup/password-policy-migration.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {PGlite} from '@electric-sql/pglite';
import {ADMIN_IDENTITY_MIGRATION,AdminIdentityService,registerAdminIdentityRoutes} from '../src/core/admin-identity/index.ts';
import {registerAdminConsoleRoutes} from '../src/app-platform/admin/routes.ts';
import {PLATFORM_PEOPLE_DIRECTORY_SQL} from '../src/platform/people/index.ts';
import {PLATFORM_LOCATION_DIRECTORY_SQL} from '../src/platform/locations/index.ts';
import {PLATFORM_ASSET_DIRECTORY_SQL} from '../src/platform/assets/index.ts';
import {PLATFORM_RESPONSIBILITY_SQL} from '../src/platform/responsibility/index.ts';
import {LINE_NUMBER_SQL} from '../src/platform/locations/line-number-migration.ts';

test('administrator maintains line numbers with leading zeros, case-insensitive uniqueness and clearing',async()=>{
 const db=new PGlite();await db.exec(ADMIN_IDENTITY_MIGRATION+PLATFORM_PEOPLE_DIRECTORY_SQL+PLATFORM_LOCATION_DIRECTORY_SQL+PLATFORM_ASSET_DIRECTORY_SQL+PLATFORM_RESPONSIBILITY_SQL);await db.exec(ADMIN_PASSWORD_SESSION_SQL);await db.exec(LINE_NUMBER_SQL);
 const client={query:(sql:string,args?:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,[...(args??[])]),release(){}};
 const pool={connect:async()=>client},identity=new AdminIdentityService(pool),origin='https://platform.example';
 const actor=await identity.bootstrap({username:'line.admin',displayName:'线路管理员',password:'Line-directory-test-123'});
 const app=Fastify();await app.register(cookie);registerAdminIdentityRoutes(app,{origin,service:identity});await registerAdminConsoleRoutes(app,{origin,identity,pool});
 try{
  const login=await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin},payload:{username:actor.username,password:'Line-directory-test-123'}});
  assert.equal(login.statusCode,200,login.body);
  const headers={origin,cookie:String(login.headers['set-cookie']).split(';')[0]};
  async function request(method:'GET'|'POST'|'PATCH',path:string,payload?:unknown){return app.inject({method,url:'/api/admin/data/'+path,headers,payload:method==='GET'?undefined:payload});}
  assert.equal((await app.inject({method:'POST',url:'/api/admin/data/lines',headers:{origin},payload:{name:'未登录'}})).statusCode,401);
  const first=(await request('POST','lines',{name:'一号线',lineNumber:'01'})).json();
  assert.equal(first.lineNumber,'01');
  const noNumber=(await request('POST','lines',{name:'二号线'})).json();
  assert.equal(noNumber.lineNumber,null);
  const duplicate=(await request('POST','lines',{name:'三号线',lineNumber:'01'}));
  assert.equal(duplicate.statusCode,400);assert.equal(duplicate.json().error,'DUPLICATE_LINE_NUMBER');
  const upper=(await request('POST','lines',{name:'四号线',lineNumber:'a1'})).json();
  assert.equal(upper.lineNumber,'a1');
  const caseDuplicate=(await request('POST','lines',{name:'五号线',lineNumber:'A1'}));
  assert.equal(caseDuplicate.statusCode,400);assert.equal(caseDuplicate.json().error,'DUPLICATE_LINE_NUMBER');
  for(const invalid of ['-x','', 'a'.repeat(51)])assert.equal((await request('POST','lines',{name:'无效线',lineNumber:invalid})).statusCode,400);
  const renamed=(await request('PATCH',`lines/${first.id}`,{lineNumber:'02'})).json();
  assert.equal(renamed.lineNumber,'02');
  const selfUpdate=(await request('PATCH',`lines/${first.id}`,{lineNumber:'02'}));
  assert.equal(selfUpdate.statusCode,200);
  const updateDuplicate=(await request('PATCH',`lines/${noNumber.id}`,{lineNumber:'02'}));
  assert.equal(updateDuplicate.statusCode,400);assert.equal(updateDuplicate.json().error,'DUPLICATE_LINE_NUMBER');
  const cleared=(await request('PATCH',`lines/${first.id}`,{lineNumber:null})).json();
  assert.equal(cleared.lineNumber,null);
  const freed=(await request('PATCH',`lines/${noNumber.id}`,{lineNumber:'02'}));
  assert.equal(freed.statusCode,200);
  const list=(await request('GET','lines')).json().records;
  assert.equal(list.find((row:{id:string})=>row.id===noNumber.id).lineNumber,'02');
  const dbRow=(await db.query('SELECT line_number FROM platform_lines WHERE id=$1',[noNumber.id])).rows[0] as {line_number:string};
  assert.equal(dbRow.line_number,'02');
 }finally{await app.close();}
});
