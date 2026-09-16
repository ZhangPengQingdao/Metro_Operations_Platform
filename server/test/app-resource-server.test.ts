import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {request} from 'node:http';
import {createSandboxResourceServer} from '../src/app-platform/sandbox/resource-server.js';
import {buildSandboxDocument} from '../src/app-platform/sandbox/document.js';

test('resource listener serves verified document once, rechecks admission, and exposes no platform endpoints or cookies',async()=>{
 const origin='https://resources.example.net';
 const server=await createSandboxResourceServer('https://ops.example.com',origin,0,'127.0.0.1');
 const script='document.body.textContent="ok";';
 const document=buildSandboxDocument({platformOrigin:'https://ops.example.com',script:{text:script,bytes:Buffer.byteLength(script),sha256:createHash('sha256').update(script).digest('hex')}});
 const get=(path:string,host='resources.example.net')=>new Promise<{status:number;headers:Record<string,unknown>;body:string}>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:server.port,path,headers:{Host:host,Cookie:'irrelevant=1'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body}));});req.on('error',reject);req.end();
 });
 try{
  let allowed=true;
  const issue=()=>new URL(server.publish(document,async()=>{if(!allowed)throw Error('REVOKED');}).url).pathname;
  const path=issue();assert.equal((await get(path,'ops.example.com')).status,404);
  const response=await get(path);assert.equal(response.status,200);assert.equal(response.body,document.html);
  assert.equal(response.headers['set-cookie'],undefined);assert.match(String(response.headers['content-security-policy']),/sandbox allow-scripts/);
  assert.equal((await get(path)).status,404);
  const revoked=issue();allowed=false;assert.equal((await get(revoked)).status,403);
  assert.equal((await get('/api/admin/auth')).status,404);
 }finally{await server.close();}
});
test('resource origin requires distinct HTTPS host',async()=>{
 for(const origin of ['https://ops.example.com','http://apps.example.net','https://apps.example.net/path','https://a:b@apps.example.net']){
  await assert.rejects(()=>createSandboxResourceServer('https://ops.example.com',origin,0,'127.0.0.1'));
 }
});
