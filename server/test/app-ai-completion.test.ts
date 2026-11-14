import assert from 'node:assert/strict';
import test from 'node:test';
import {createAiCompletionOperation} from '../src/app-platform/gateway/ai.ts';
import {GatewayError} from '../src/app-platform/gateway/model.ts';
import {AiProviderTransportError,requestOpenAiMessage} from '../src/core/integrations/ai/index.ts';

const config=async()=>({external:{endpoint:'https://model.example.com/v1/chat/completions',model:'test',apiKey:'secret',toolsEnabled:true,timeoutMs:120000,reasoningEffort:'auto' as const}});
test('AI gateway bounds input, keeps credentials in the platform and propagates abort',async()=>{
 let calls=0;
 const operation=createAiCompletionOperation({config,request:async(runtime,messages,tools,_fetch,options)=>{
  calls++;
  assert.equal(runtime.apiKey,'secret');
  assert.equal(runtime.timeoutMs,100_000);
  assert.equal(messages[0].role,'system');
  assert.equal(messages[1].content,'现场描述');
  assert.deepEqual(tools,[]);
  assert.ok(options.signal);
  return {role:'assistant',content:'{"description":"规范描述"}'};
 }});
 assert.equal(operation.name,'platform.ai.complete');
 assert.equal(operation.permissionCode,'platform.ai.complete');
 assert.equal(operation.readTimeoutMs,105_000);
 assert.equal(operation.validateParams({system:'规则',prompt:'现场描述'}),true);
 for(const value of [{system:'',prompt:'现场描述'},{system:'规则',prompt:'x'.repeat(12001)},{system:'规则',prompt:'现场描述',apiKey:'attacker'}])assert.equal(operation.validateParams(value),false);
 const result=await operation.execute({} as never,{system:'规则',prompt:'现场描述'},new AbortController().signal);
 assert.deepEqual(result,{content:'{"description":"规范描述"}'});
 assert.equal(calls,1);
 assert.equal(operation.validateResult(result),true);
 assert.equal(operation.validateResult({content:'',apiKey:'secret'}),false);
});
test('AI gateway respects a shorter configured deadline and reports provider timeouts',async()=>{
 const operation=createAiCompletionOperation({
  config:async()=>({external:{...(await config()).external,timeoutMs:8000}}),
  request:async(runtime)=>{
   assert.equal(runtime.timeoutMs,8000);
   throw new AiProviderTransportError('private provider details',{code:'AI_PROVIDER_TIMEOUT'});
  },
 });
 await assert.rejects(operation.execute({} as never,{system:'规则',prompt:'描述'},new AbortController().signal),
  error=>error instanceof GatewayError&&error.code==='TIMEOUT'&&error.statusCode===504);
});
test('a model response that stalls after its headers reports a timeout',async()=>{
 const runtime={...(await config()).external,timeoutMs:10};
 const fetchImpl:typeof fetch=async(_url,init)=>new Response(new ReadableStream({
  start(controller){init?.signal?.addEventListener('abort',()=>controller.error(init.signal?.reason),{once:true});}
 }));
 const keepAlive=setTimeout(()=>{},1000);
 try{
  await assert.rejects(requestOpenAiMessage(runtime,[],[],fetchImpl,{endpointSafetyCheck:async()=>{}}),{code:'AI_PROVIDER_TIMEOUT'});
 }finally{clearTimeout(keepAlive);}
});
test('AI gateway returns safe failure codes without provider or key details',async()=>{
 const operation=createAiCompletionOperation({config,request:async()=>{throw Error('secret provider details');}});
 await assert.rejects(operation.execute({} as never,{system:'规则',prompt:'描述'},new AbortController().signal),error=>error instanceof GatewayError&&error.code==='AI_UNAVAILABLE'&&!error.message.includes('secret'));
 const missing=createAiCompletionOperation({config:async()=>{throw Error('missing secret');}});
 await assert.rejects(missing.execute({} as never,{system:'规则',prompt:'描述'},new AbortController().signal),error=>error instanceof GatewayError&&error.code==='AI_NOT_CONFIGURED');
});
