import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {registerUnifiedLogin} from '../src/platform/employee-identity/unified-login.js';
import {EmployeeIdentityError} from '../src/platform/employee-identity/index.js';

test('unified login routes verified identity with isolated cookies, rejects ambiguity, CSRF and excess attempts',async()=>{
 const app=Fastify();await app.register(cookie);let kinds=['employee'],adminCalls=0,employeeCalls=0;
 registerUnifiedLogin(app,{origin:'https://ops.example.com',pool:{connect:async()=>({query:async()=>({rows:kinds.map(kind=>({kind}))}),release(){}})} as never,
 admin:{login:async()=>{adminCalls++;return {account:{username:'admin'},token:'admin-token'};}} as never,
 employee:{login:async(input:{password:string})=>{employeeCalls++;if(input.password!=='valid')throw new EmployeeIdentityError(401,'EMPLOYEE_LOGIN_FAILED');return {account:{username:'staff'},token:'employee-token'};}} as never});
 const login=(password='valid')=>app.inject({method:'POST',url:'/api/auth/login',headers:{origin:'https://ops.example.com'},payload:{username:'staff',password}});
 try{
  assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{}})).statusCode,403);
  const employee=await login();assert.equal(employee.json().kind,'employee');assert.match(String(employee.headers['set-cookie']),/Path=\/api\/employee/);assert.equal(adminCalls,0);
  kinds=['admin'];const admin=await login();assert.equal(admin.json().kind,'admin');assert.equal(adminCalls,1);
  kinds=['admin','employee'];assert.equal((await login()).statusCode,409);assert.equal(adminCalls,1);
  kinds=['employee'];assert.equal((await login('bad')).statusCode,401);assert.equal(employeeCalls,2);
  kinds=[];assert.equal((await login('bad')).statusCode,401);
  assert.equal((await login()).statusCode,429);
 }finally{await app.close();}
});
