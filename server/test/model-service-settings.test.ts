import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {env} from '../src/config/env.ts';
import {AdminIdentityService,registerAdminIdentityRoutes} from '../src/core/admin-identity/index.ts';
import {registerAdminConsoleRoutes} from '../src/app-platform/admin/routes.ts';
import {assertSafeAiProviderEndpoint,decryptApiKey,encryptApiKey} from '../src/core/integrations/ai/index.ts';
import {assertSafeModelServiceEndpoint,readModelServiceConfig,publicModelServiceConfig,saveModelServiceConfig,
 testModelService,decodeTestAudio,modelServiceSchema,MAX_TEST_AUDIO_BYTES,type ModelServiceConfig} from '../src/core/integrations/model-services/index.ts';

async function fixture(){
 const pg=new PGlite();
 const db={query:async(sql:string,args?:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')?{rows:[]}:args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}};
 const pool={...db,connect:async()=>db};await initializePlatformDatabase(db);
 const previous={key:env.AI_PROVIDER_ENCRYPTION_KEY,rerank:env.MOP_RERANK_ALLOWED_ENDPOINTS,asr:env.MOP_ASR_ALLOWED_ENDPOINTS};
 env.AI_PROVIDER_ENCRYPTION_KEY='c'.repeat(64);env.MOP_RERANK_ALLOWED_ENDPOINTS=['http://127.0.0.1:3214/rerank'];env.MOP_ASR_ALLOWED_ENDPOINTS=['http://127.0.0.1:3215/asr'];
 return {pg,db,pool,close:async()=>{env.AI_PROVIDER_ENCRYPTION_KEY=previous.key;env.MOP_RERANK_ALLOWED_ENDPOINTS=previous.rerank;env.MOP_ASR_ALLOWED_ENDPOINTS=previous.asr;await pg.close();}};
}
const input={endpoint:'http://127.0.0.1:3214/rerank',model:'rerank-test',timeoutMs:5000,apiKey:'fixture-private-key'};
const noop=async()=>{};

test('rerank and ASR environment allowlists validate deployment URLs independently',()=>{
 const run=(name:string,value:string)=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {env} from './src/config/env.ts';console.log(JSON.stringify(env.${name}));`],{
  cwd:new URL('../',import.meta.url),env:{...process.env,NODE_ENV:'test',[name]:value},encoding:'utf8',
 });
 for(const name of ['MOP_RERANK_ALLOWED_ENDPOINTS','MOP_ASR_ALLOWED_ENDPOINTS']){
  const valid=run(name,'http://model.internal:8000/test,https://model.example.com/test');
  assert.equal(valid.status,0,valid.stderr);assert.equal(JSON.parse(valid.stdout).length,2);
  for(const value of ['not a url','ftp://model.internal/test','http://user:secret@model.internal/test','http://model.internal/test?key=x',Array(17).fill('http://model.internal/test').join(',')])
   assert.notEqual(run(name,value).status,0);
 }
});

test('model config is encrypted, independent, idempotent and atomic with audit; old requests cannot overwrite later saves',async()=>{
 const f=await fixture();try{
  assert.equal(publicModelServiceConfig('asr',null).configured,false);
  const actor=randomUUID(),requestId=randomUUID();let audits=0;
  const first=await saveModelServiceConfig(f.pool,'rerank',input,requestId,actor,async()=>{audits++;});
  const stored=(await readModelServiceConfig(f.db,'rerank'))!;
  assert.equal(decryptApiKey(stored.apiKey),input.apiKey);
  assert.ok(!JSON.stringify(stored).includes(input.apiKey));
  assert.ok(!JSON.stringify(first).includes('ciphertext'));
  assert.ok(!JSON.stringify(first).includes(input.apiKey));
  await saveModelServiceConfig(f.pool,'rerank',{...input,model:'updated',apiKey:undefined},randomUUID(),actor,async()=>{audits++;});
  assert.equal(decryptApiKey((await readModelServiceConfig(f.db,'rerank'))!.apiKey),input.apiKey);
  assert.deepEqual(await saveModelServiceConfig(f.pool,'rerank',input,requestId,actor,async()=>{audits++;}),first);
  assert.equal(audits,2);assert.equal((await readModelServiceConfig(f.db,'rerank'))!.model,'updated');
  await assert.rejects(saveModelServiceConfig(f.pool,'rerank',{...input,model:'other'},requestId,actor,noop),{code:'REQUEST_ID_REUSED'});
  await assert.rejects(saveModelServiceConfig(f.pool,'rerank',input,requestId,randomUUID(),noop),{code:'REQUEST_ID_REUSED'});
  env.MOP_RERANK_ALLOWED_ENDPOINTS.push('http://127.0.0.1:3214/other');
  await assert.rejects(saveModelServiceConfig(f.pool,'rerank',{...input,endpoint:'http://127.0.0.1:3214/other',apiKey:undefined},randomUUID(),actor,noop),{code:'MODEL_KEY_REQUIRED'});
  const failedId=randomUUID();
  await assert.rejects(saveModelServiceConfig(f.pool,'rerank',{...input,model:'rollback'},failedId,actor,async()=>{throw Error('audit failed');}),/audit failed/);
  assert.equal((await readModelServiceConfig(f.db,'rerank'))!.model,'updated');
  assert.equal((await f.pg.query('SELECT * FROM model_configuration_requests WHERE request_id=$1',[failedId])).rows.length,0);
  await saveModelServiceConfig(f.pool,'asr',{...input,endpoint:'http://127.0.0.1:3215/asr',language:'zh',model:'asr-test'},randomUUID(),actor,noop);
  assert.equal((await readModelServiceConfig(f.db,'rerank'))!.model,'updated');
  assert.equal((await readModelServiceConfig(f.db,'asr'))!.language,'zh');
  assert.ok(!JSON.stringify((await f.pg.query('SELECT * FROM model_configuration_requests')).rows).includes(input.apiKey));
  assert.deepEqual(await initializePlatformDatabase(f.db),[]);
 }finally{await f.close();}
});

test('model endpoint permissions are separate and exact; schema rejects invalid parameters and embedded data',async()=>{
 const f=await fixture();try{
  await assertSafeModelServiceEndpoint('rerank',input.endpoint);
  for(const endpoint of [input.endpoint+'/other',input.endpoint+'?key=secret','http://127.0.0.1:3215/asr','http://localhost:3214/rerank'])
   await assert.rejects(assertSafeModelServiceEndpoint('rerank',endpoint));
  await assert.rejects(assertSafeModelServiceEndpoint('asr',input.endpoint));
  await assert.rejects(assertSafeAiProviderEndpoint(input.endpoint));
  for(const patch of [{endpoint:'not a url'},{endpoint:'http://user:password@127.0.0.1/rerank'},{endpoint:input.endpoint+'?key=x'},{endpoint:'file:///tmp/a'},{timeoutMs:1},{timeoutMs:120001},{model:''},{enabled:true},{language:'zh'}])
   assert.equal(modelServiceSchema('rerank').safeParse({...input,...patch}).success,false);
  assert.equal(modelServiceSchema('asr').safeParse({...input,language:'zh-CN'}).success,false);
 }finally{await f.close();}
});

test('rerank probes validate candidate indices and bounded responses, redact provider errors and honor cancellation',async()=>{
 const f=await fixture();try{
  const config:ModelServiceConfig={...input,apiKey:encryptApiKey(input.apiKey)};
  let calls=0;
  const result=await testModelService('rerank',config,new AbortController().signal,undefined,{fetch:async(url,options)=>{
   calls++;assert.equal(url,input.endpoint);assert.equal(options?.redirect,'error');
   const body=JSON.parse(options!.body as string);assert.equal(body.top_n,2);assert.equal(body.documents.length,2);
   assert.equal((options!.headers as any).Authorization,`Bearer ${input.apiKey}`);
   return Response.json({results:[{index:0,relevance_score:0.9},{index:1,relevance_score:0.1}]});
  }});
  assert.equal(result.results?.[0].index,0);assert.equal(calls,1);
  for(const payload of [null,{results:[]},{results:[{index:0,relevance_score:1},{index:0,relevance_score:0}]},{results:[{index:2,relevance_score:1},{index:0,relevance_score:0}]},{results:[{index:1,relevance_score:'1'},{index:0,relevance_score:0}]}])
   await assert.rejects(testModelService('rerank',config,new AbortController().signal,undefined,{fetch:async()=>Response.json(payload)}),{code:'MODEL_RESPONSE_INVALID'});
  await assert.rejects(testModelService('rerank',config,new AbortController().signal,undefined,{fetch:async()=>new Response('x'.repeat(65537))}),{code:'MODEL_RESPONSE_TOO_LARGE'});
  await assert.rejects(testModelService('rerank',config,new AbortController().signal,undefined,{fetch:async()=>new Response('provider secret',{status:401})}),error=>!String(error).includes('provider secret'));
  const abort=new AbortController();abort.abort();
  await assert.rejects(testModelService('rerank',config,abort.signal,undefined,{fetch:async()=>{throw Error('must not call');}}),{name:'AbortError'});
  const during=new AbortController();
  const pending=testModelService('rerank',config,during.signal,undefined,{fetch:async(_url,options)=>new Promise((_resolve,reject)=>{
   options!.signal!.addEventListener('abort',()=>reject(options!.signal!.reason),{once:true});during.abort();
  })});
  await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(testModelService('rerank',{...config,timeoutMs:5},new AbortController().signal,undefined,{fetch:async(_url,options)=>new Promise((_resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('timeout did not fire')),1000);
   options!.signal!.addEventListener('abort',()=>{clearTimeout(timer);reject(options!.signal!.reason);},{once:true});
  })}),{name:'TimeoutError'});
 }finally{await f.close();}
});

test('ASR probe sends real multipart audio, accepts empty transcription, rejects invalid or oversized audio and responses',async()=>{
 const f=await fixture();try{
  const config:ModelServiceConfig={...input,endpoint:'http://127.0.0.1:3215/asr',language:'zh',apiKey:encryptApiKey(input.apiKey)};
  const audio=decodeTestAudio({format:'wav',data:Buffer.from('RIFF fixture audio').toString('base64')});
  const result=await testModelService('asr',config,new AbortController().signal,audio,{fetch:async(_url,options)=>{
   assert.ok(options!.body instanceof FormData);const form=options!.body as FormData;
   assert.equal(form.get('model'),input.model);assert.equal(form.get('language'),'zh');assert.equal(form.get('response_format'),'json');
   assert.equal((form.get('file') as File).name,'connection-test.wav');
   assert.equal(await (form.get('file') as File).text(),'RIFF fixture audio');
   assert.equal((options!.headers as any)['Content-Type'],undefined);
   return Response.json({text:'车门故障已报修。'});
  }});assert.equal(result.text,'车门故障已报修。');
  assert.equal((await testModelService('asr',config,new AbortController().signal,audio,{fetch:async()=>Response.json({text:''})})).text,'');
  for(const payload of [{text:3},{text:'x'.repeat(12001)},{error:'no model'}])
   await assert.rejects(testModelService('asr',config,new AbortController().signal,audio,{fetch:async()=>Response.json(payload)}),{code:'MODEL_RESPONSE_INVALID'});
  await assert.rejects(testModelService('asr',config,new AbortController().signal),{code:'ASR_AUDIO_REQUIRED'});
  for(const sample of [{format:'exe',data:'AAAA'},{format:'wav',data:'!!!!'},{format:'wav',data:'AB=='},{format:'wav',data:Buffer.alloc(MAX_TEST_AUDIO_BYTES+1).toString('base64')}])
   assert.throws(()=>decodeTestAudio(sample));
 }finally{await f.close();}
});

test('admin model routes require admin and same origin, save with audit and test real HTTP without persisting sample audio',async()=>{
 const f=await fixture();const bodies:string[]=[];
 let gate:Promise<void>|undefined,entered=0,onEntered=()=>{};
 const provider=http.createServer((req,res)=>{
  const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',async()=>{
   if(gate){entered++;if(entered===2)onEntered();await gate;}
   bodies.push(Buffer.concat(chunks).toString());res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify(req.url==='/rerank'?{results:[{index:0,relevance_score:0.9},{index:1,relevance_score:0.2}]}:{text:'真实 HTTP 测试'}));
  });
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(provider.address() as import('node:net').AddressInfo).port}`;
 env.MOP_RERANK_ALLOWED_ENDPOINTS=[base+'/rerank'];env.MOP_ASR_ALLOWED_ENDPOINTS=[base+'/asr'];
 const app=Fastify();await app.register(cookie);
 const identity=new AdminIdentityService(f.pool);
 await identity.bootstrap({username:'model.admin',displayName:'Model Admin',password:'Administrator-test-123'});
 registerAdminIdentityRoutes(app,{origin:'https://platform.example',service:identity});
 await registerAdminConsoleRoutes(app,{origin:'https://platform.example',identity,pool:f.pool});
 try{
  for(const path of ['/rerank','/asr']){
   assert.equal((await app.inject({url:'/api/admin'+path})).statusCode,401);
   assert.equal((await app.inject({method:'POST',url:'/api/admin'+path+'/test',headers:{origin:'https://platform.example'},payload:{}})).statusCode,401);
  }
  const login=await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin:'https://platform.example'},payload:{username:'model.admin',password:'Administrator-test-123'}});
  const headers={origin:'https://platform.example',cookie:String(login.headers['set-cookie']).split(';')[0]};
  for(const kind of ['rerank','asr']){
   const config={...input,endpoint:base+'/'+kind,...(kind==='asr'?{language:'zh'}:{})};
   const requestId=randomUUID();
   const denied=await app.inject({method:'POST',url:`/api/admin/${kind}/save`,headers:{...headers,origin:'https://evil.example'},payload:{...config,requestId}});
   assert.equal(denied.statusCode,403);
   const save=await app.inject({method:'POST',url:`/api/admin/${kind}/save`,headers,payload:{...config,requestId}});
   assert.equal(save.statusCode,200,save.body);assert.equal(save.json().hasApiKey,true);assert.ok(!save.body.includes(input.apiKey));
   assert.equal((await app.inject({method:'POST',url:`/api/admin/${kind}/save`,headers,payload:{...config,requestId}})).statusCode,200);
   const read=await app.inject({url:`/api/admin/${kind}`,headers});assert.equal(read.headers['cache-control'],'no-store');assert.equal(read.json().model,input.model);
   const testResponse=await app.inject({method:'POST',url:`/api/admin/${kind}/test`,headers,payload:{...config,model:'unsaved-test-model',apiKey:undefined,...(kind==='asr'?{audio:{format:'wav',data:Buffer.from('RIFF HTTP audio').toString('base64')}}:{})}});
   assert.equal(testResponse.statusCode,200,testResponse.body);
   assert.equal((await readModelServiceConfig(f.db,kind as 'rerank'|'asr'))!.model,input.model,'diagnostics must not save the draft');
  }
  assert.equal(bodies.length,2);assert.ok(bodies[1].includes('RIFF HTTP audio'));
  const audit=await f.pg.query("SELECT action FROM platform_admin_audit WHERE action IN ('rerank.configuration.update','asr.configuration.update')");assert.equal(audit.rows.length,2);
  assert.ok(!JSON.stringify((await f.pg.query('SELECT value FROM system_configs')).rows).includes('HTTP audio'));
  const invalid=await app.inject({method:'POST',url:'/api/admin/asr/test',headers,payload:{...input,endpoint:base+'/asr'}});assert.equal(invalid.statusCode,400);
  const oversize=await app.inject({method:'POST',url:'/api/admin/asr/test',headers,payload:{...input,endpoint:base+'/asr',audio:{format:'wav',data:'A'.repeat(3*1024*1024)}}});
  assert.equal(oversize.statusCode,413);assert.equal(bodies.length,2);
  let release!:()=>void;gate=new Promise(resolve=>{release=resolve;});
  const bothEntered=new Promise<void>(resolve=>{onEntered=resolve;});
  const probe=()=>app.inject({method:'POST',url:'/api/admin/rerank/test',headers,payload:{...input,endpoint:base+'/rerank'}});
  const pending=[probe(),probe()];await bothEntered;
  assert.equal((await probe()).statusCode,429);
  release();assert.ok((await Promise.all(pending)).every(response=>response.statusCode===200));gate=undefined;
  assert.equal((await probe()).statusCode,200,'test slots must be released');
 }finally{await app.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));await f.close();}
});
