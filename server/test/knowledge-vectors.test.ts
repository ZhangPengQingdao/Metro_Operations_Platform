import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {KnowledgeService} from '../src/platform/knowledge/index.ts';
import {KnowledgeIndexer} from '../src/platform/knowledge/indexer.ts';
import {embedText,EmbeddingError,publicEmbeddingConfig, type EmbeddingConfig,type EmbeddingProvider} from '../src/core/integrations/embeddings/index.ts';
import {encryptApiKey} from '../src/core/integrations/ai/index.ts';
const signal=new AbortController().signal;
async function fixture(){
 const pg=new PGlite();const db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}};
 const pool={...db,connect:async()=>db};await initializePlatformDatabase(db);
 const scope={installationId:randomUUID(),personId:randomUUID(),retrieval:'similar' as const},target={libraryId:'examples',organizationId:randomUUID()};
 const installation={id:scope.installationId,appId:'test-vectors',revision:1,serviceIdentityId:randomUUID(),credentialDigest:null,manifest:{},grants:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),enabled:true,runtime:{model:'v2',manifest:{knowledgeBases:[{id:'examples',retrieval:'similar'},{id:'terms',retrieval:'exact'}]}}};
 await pg.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3)',[scope.installationId,'test-vectors',JSON.stringify(installation)]);
 let config:EmbeddingConfig|null=null,calls=0;
 let embed:EmbeddingProvider['embed']=async(_config,text)=>{calls++;return /检修|故障|repair/.test(text)?[1,0]:[0,1];};
 const provider:EmbeddingProvider={configuration:async()=>config,embed:(...args)=>embed(...args)};
 const service=new KnowledgeService(pool,provider),indexer=new KnowledgeIndexer(db,provider);
 const configure=async(revision=randomUUID(),enabled=true)=>{
  config={enabled,revision,endpoint:'https://example.com/v1/embeddings',model:'test',dimensions:2,timeoutMs:5000,minScore:0.55,apiKey:{} as any,apiKeyMask:'masked'};
  await pg.query(`INSERT INTO system_configs(key,value) VALUES('embedding_runtime_global',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify(config)]);return config;
 };
 const save=(content:string,extra={})=>service.write(scope,{...target,id:randomUUID(),requestId:randomUUID(),action:'save',title:content,content,metadata:{},...extra},signal);
 return {pg,db,scope,target,service,indexer,configure,save,calls:()=>calls,setEmbed:(value:typeof embed)=>{embed=value;}};
}
test('unconfigured entries save normally; semantic lookup finds a different wording and returns versioned references',async()=>{
 const f=await fixture();try{
  const item=await f.save('检修');await f.save('绿化');
  assert.equal((await f.service.list(f.scope,f.target)).entries[0].indexStatus,'unconfigured');
  assert.equal(await f.indexer.runOnce(signal),false);assert.equal(f.calls(),0);
  assert.deepEqual((await f.service.search(f.scope,{...f.target,query:'repair'})).retrieval,{mode:'text',reason:'unconfigured'});
  await f.configure();assert.equal((await f.service.search(f.scope,{...f.target,query:'检修'})).retrieval.reason,'indexing');
  await f.indexer.runOnce(signal);await f.indexer.runOnce(signal);assert.equal(await f.indexer.runOnce(signal),false);
  const found=await f.service.search(f.scope,{...f.target,query:'repair',limit:1});
  assert.equal(found.retrieval.mode,'semantic');
  f.setEmbed(async()=>[0.5,-Math.sqrt(0.75)]);assert.deepEqual((await f.service.search(f.scope,{...f.target,query:'unrelated'})).entries,[]);assert.equal(found.entries[0].id,item.id);assert.equal(found.entries[0].score,1);
  assert.deepEqual(found.entries[0].reference,{...f.target,id:item.id,version:1});
  assert.deepEqual((await f.service.search(f.scope,{...f.target,organizationId:randomUUID(),query:'repair'})).entries,[]);
  assert.deepEqual((await f.service.search({...f.scope,installationId:randomUUID()},{...f.target,query:'repair'})).entries,[]);
  const terms={...f.target,libraryId:'terms'},scope={...f.scope,retrieval:'exact' as const};
  await f.service.write(scope,{...terms,id:randomUUID(),requestId:randomUUID(),action:'save',title:'AFC',content:'自动售检票',metadata:{}},signal);
  assert.equal(await f.indexer.runOnce(signal),false);assert.equal((await f.service.search(scope,{...terms,query:'AFC检修'})).retrieval.mode,'exact');
 }finally{await f.pg.close();}
});
test('edits, deletes and same-version reindex invalidate in-flight claims; crash leases are recoverable',async()=>{
 const f=await fixture();try{
  await f.configure();const item=await f.save('检修');
  for(const action of ['save','reindex','delete'] as const){
   let release!:(vector:number[])=>void,started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});
   f.setEmbed(async()=>{started();return new Promise(resolve=>{release=resolve;});});
   const running=f.indexer.runOnce(signal);await entered;
   const version=action==='save'?1:2;
   if(action==='save')await f.save('绿化',{id:item.id,expectedVersion:version});
   else await f.service.write(f.scope,{...f.target,id:item.id,requestId:randomUUID(),action,expectedVersion:version},signal);
   release([1,0]);await running;
   const state=await f.pg.query('SELECT embedding,index_status,deleted FROM platform_knowledge_entries WHERE id=$1',[item.id]);
   assert.equal(state.rows[0].embedding,null);assert.equal(state.rows[0].index_status,'pending');
  }
  assert.deepEqual((await f.service.search(f.scope,{...f.target,query:'检修'})).entries,[]);
  const next=await f.save('检修');await f.pg.query(`UPDATE platform_knowledge_entries SET index_status='processing',index_started_at=now()-interval '3 minutes',embedding_key=(SELECT value->>'revision' FROM system_configs WHERE key='embedding_runtime_global') WHERE id=$1`,[next.id]);
  f.setEmbed(async()=>[1,0]);assert.equal(await f.indexer.runOnce(signal),true);
  assert.equal((await f.service.list(f.scope,f.target)).entries[0].indexStatus,'ready');
 }finally{await f.pg.close();}
});
test('failed jobs wait for an explicit idempotent retry; model changes invalidate vectors, including during a query',async()=>{
 const f=await fixture();try{
  const first=await f.configure(),item=await f.save('检修');
  f.setEmbed(async()=>{throw new EmbeddingError('EMBEDDING_VECTOR_INVALID','secret provider details');});
  await f.indexer.runOnce(signal);assert.equal(await f.indexer.runOnce(signal),false);
  const failed=(await f.service.list(f.scope,f.target)).entries[0];assert.equal(failed.indexStatus,'failed');assert.equal(failed.indexError,'EMBEDDING_VECTOR_INVALID');
  assert.equal((await f.service.search(f.scope,{...f.target,query:'检修'})).retrieval.reason,'failed');
  const retry={...f.target,id:item.id,requestId:randomUUID(),action:'reindex' as const,expectedVersion:1};
  await f.service.write(f.scope,retry,signal);await f.service.write(f.scope,retry,signal);
  f.setEmbed(async()=>[1,0]);await f.indexer.runOnce(signal);
  await f.service.write(f.scope,retry,signal);assert.equal((await f.service.list(f.scope,f.target)).entries[0].indexStatus,'ready');
  const next=await f.configure();assert.notEqual(next.revision,first.revision);
  assert.equal((await f.service.list(f.scope,f.target)).entries[0].indexStatus,'pending');
  assert.equal((await f.service.search(f.scope,{...f.target,query:'检修'})).retrieval.mode,'text');await f.indexer.runOnce(signal);
  f.setEmbed(async()=>{await f.configure();return [1,0];});
  assert.deepEqual((await f.service.search(f.scope,{...f.target,query:'repair'})).entries,[]);
  await f.configure(randomUUID(),false);assert.equal((await f.service.search(f.scope,{...f.target,query:'检修'})).retrieval.reason,'unconfigured');
 }finally{await f.pg.close();}
});
test('embedding HTTP boundary normalizes vectors, validates dimension, redacts config and honors cancellation',async()=>{
 const {env}=await import('../src/config/env.ts');const before=env.AI_PROVIDER_ENCRYPTION_KEY;env.AI_PROVIDER_ENCRYPTION_KEY='a'.repeat(64);
 try{
  const config:EmbeddingConfig={enabled:true,revision:randomUUID(),model:'small',endpoint:'https://example.com/v1/embeddings',dimensions:2,timeoutMs:5000,apiKey:encryptApiKey('sensitive-key'),apiKeyMask:'masked'};
  const safe=async()=>{};
  const vector=await embedText(config,'检修',signal,{safety:safe,fetch:async(url,options)=>{
   assert.equal(url,config.endpoint);assert.equal(options?.redirect,'error');assert.deepEqual(JSON.parse(options?.body as string),{model:'small',input:'检修',encoding_format:'float'});
   return Response.json({data:[{embedding:[3,4]}]});
  }});assert.deepEqual(vector,[0.6,0.8]);assert.ok(!JSON.stringify(publicEmbeddingConfig(config)).includes('ciphertext'));
  for(const embedding of [[1],[0,0],['1',0]])await assert.rejects(embedText(config,'检修',signal,{safety:safe,fetch:async()=>Response.json({data:[{embedding}]})}),/维度|无效/);
  const abort=new AbortController();abort.abort();await assert.rejects(embedText(config,'检修',abort.signal,{safety:safe,fetch:async(_url,options)=>{options!.signal!.throwIfAborted();throw Error('should not reach');}}),{name:'AbortError'});
 }finally{env.AI_PROVIDER_ENCRYPTION_KEY=before;}
});

test('embedding configuration preserves encrypted credentials, versions models and rolls back failed audit writes',async()=>{
 const f=await fixture();const {env}=await import('../src/config/env.ts');const before=env.AI_PROVIDER_ENCRYPTION_KEY;env.AI_PROVIDER_ENCRYPTION_KEY='b'.repeat(64);
 const {saveEmbeddingConfig,readEmbeddingConfig}=await import('../src/core/integrations/embeddings/index.ts');
 const pool={...f.db,connect:async()=>f.db};
 const input={enabled:false,endpoint:'https://example.com/v1/embeddings',model:'small',dimensions:2,timeoutMs:5000,apiKey:'private-test-key'};
 try{
  await saveEmbeddingConfig(pool,input,async()=>{});const first=(await readEmbeddingConfig(f.db))!;
  assert.ok(first.apiKey.ciphertext);assert.ok(!JSON.stringify(first).includes('private-test-key'));
  await saveEmbeddingConfig(pool,{...input,apiKey:undefined,timeoutMs:6000,minScore:0.55},async()=>{});
  assert.equal((await readEmbeddingConfig(f.db))!.revision,first.revision);assert.equal((await readEmbeddingConfig(f.db))!.minScore,0.55);
  await assert.rejects(saveEmbeddingConfig(pool,{...input,endpoint:'https://other.example.com/embeddings',apiKey:undefined},async()=>{}),/首次配置|更换地址/);
  await assert.rejects(saveEmbeddingConfig(pool,{...input,model:'new'},async()=>{throw Error('audit failed');}),/audit failed/);
  assert.equal((await readEmbeddingConfig(f.db))!.model,'small');
  await saveEmbeddingConfig(pool,{...input,model:'new'},async()=>{});
  assert.notEqual((await readEmbeddingConfig(f.db))!.revision,first.revision);
 }finally{env.AI_PROVIDER_ENCRYPTION_KEY=before;await f.pg.close();}
});

test('local and private embeddings require exact operator-approved endpoints; chat restrictions remain intact',async()=>{
 const {env}=await import('../src/config/env.ts');const before=env.MOP_EMBEDDING_ALLOWED_ENDPOINTS;
 const {assertSafeEmbeddingEndpoint}=await import('../src/core/integrations/embeddings/index.ts');
 const {assertSafeAiProviderEndpoint}=await import('../src/core/integrations/ai/index.ts');
 const endpoint='http://127.0.0.1:3212/v1/embeddings';
 try{
  env.MOP_EMBEDDING_ALLOWED_ENDPOINTS=[];await assert.rejects(assertSafeEmbeddingEndpoint(endpoint));
  env.MOP_EMBEDDING_ALLOWED_ENDPOINTS=[endpoint,'http://embedding.internal:8000/v1/embeddings','https://192.168.1.10/v1/embeddings'];
  await assertSafeEmbeddingEndpoint('http://embedding.internal:8000/v1/embeddings');
  await assertSafeEmbeddingEndpoint('https://192.168.1.10/v1/embeddings');await assertSafeEmbeddingEndpoint(endpoint);
  for(const other of ['http://127.0.0.1:3213/v1/embeddings','http://localhost:3212/v1/embeddings',endpoint+'?token=x',endpoint+'/other','http://192.168.1.1:3212/v1/embeddings'])
   await assert.rejects(assertSafeEmbeddingEndpoint(other));
  await assert.rejects(assertSafeAiProviderEndpoint(endpoint));
 }finally{env.MOP_EMBEDDING_ALLOWED_ENDPOINTS=before;}
});

test('embedding allowlist environment accepts deployment endpoints and rejects unsafe URL syntax',async()=>{
 const {spawnSync}=await import('node:child_process');
 const run=(value:string)=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {env} from './src/config/env.ts';console.log(JSON.stringify(env.MOP_EMBEDDING_ALLOWED_ENDPOINTS));`],{cwd:new URL('../',import.meta.url),env:{...process.env,NODE_ENV:'test',MOP_EMBEDDING_ALLOWED_ENDPOINTS:value},encoding:'utf8'});
 const valid=run('http://127.0.0.1:3212/v1/embeddings, https://embedding.internal/v1/embeddings');
 assert.equal(valid.status,0,valid.stderr);assert.equal(JSON.parse(valid.stdout).length,2);
 for(const value of ['ftp://embedding.internal/model','http://user:password@embedding.internal/v1/embeddings','http://embedding.internal/v1/embeddings?key=x','http://embedding.internal/v1/embeddings#part'])assert.notEqual(run(value).status,0);
});
