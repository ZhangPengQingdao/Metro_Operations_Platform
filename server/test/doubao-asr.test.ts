import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import WebSocket,{WebSocketServer} from 'ws';
import {PGlite} from '@electric-sql/pglite';
import {env} from '../src/config/env.ts';
import {encryptApiKey,decryptApiKey} from '../src/core/integrations/ai/index.ts';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {testModelService,queryAsrTask,modelServiceSchema,prepareModelServiceConfig,publicModelServiceConfig,readModelServiceConfig,saveModelServiceConfig,decodeTestAudio,type ModelServiceConfig} from '../src/core/integrations/model-services/index.ts';
import {testStreamingAsr,streamingPcm,parseStreamingFrame,assertSafeStreamingEndpoint} from '../src/core/integrations/model-services/streaming-asr.ts';
const signal=new AbortController().signal;
const no=async()=>{};
async function fixture(){
 const before={key:env.AI_PROVIDER_ENCRYPTION_KEY,asr:env.MOP_ASR_ALLOWED_ENDPOINTS};
 env.AI_PROVIDER_ENCRYPTION_KEY='d'.repeat(64);env.MOP_ASR_ALLOWED_ENDPOINTS=['http://127.0.0.1:3219/submit','http://127.0.0.1:3219/query'];
 const pg=new PGlite(),db={query:async(sql:string,args?:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')?{rows:[]}:args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}};
 const pool={...db,connect:async()=>db};await initializePlatformDatabase(db);
 const config:ModelServiceConfig={protocol:'doubao-asr',resourceId:'volc.seedasr.auc',model:'bigmodel',endpoint:env.MOP_ASR_ALLOWED_ENDPOINTS[0],timeoutMs:5000,apiKey:encryptApiKey('fixture-voice-key')};
 return {pg,db,pool,config,close:async()=>{env.AI_PROVIDER_ENCRYPTION_KEY=before.key;env.MOP_ASR_ALLOWED_ENDPOINTS=before.asr;await pg.close();}};
}
function wav(){
 const bytes=Buffer.alloc(44+12800);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(12800,40);
 return decodeTestAudio({format:'wav',data:bytes.toString('base64')});
}
function frame(text:string,final=false){
 const data=gzipSync(Buffer.from(JSON.stringify({result:{text}}))),head=Buffer.from([0x11,final?0x93:0x91,0x11,0]),fields=Buffer.alloc(8);fields.writeInt32BE(final?-3:1);fields.writeUInt32BE(data.length,4);return Buffer.concat([head,fields,data]);
}

test('voice config validates protocol, retains old OpenAI config, isolates streaming config, and requires keys on protocol switches',async()=>{
 const f=await fixture();try{
  assert.equal(publicModelServiceConfig('asr',null).protocol,'openai');assert.equal(publicModelServiceConfig('streaming-asr',null).protocol,'doubao-streaming');
  assert.equal(modelServiceSchema('asr').safeParse({...f.config,apiKey:'fixture',protocol:'unknown'}).success,false);
  for(const patch of [{endpoint:'https://user:secret@example.com/ws'},{endpoint:'ws://example.com/ws'},{endpoint:'wss://example.com/ws?key=secret'},{resourceId:'volc.seedasr.auc'}])
   assert.equal(modelServiceSchema('streaming-asr').safeParse({endpoint:'wss://example.com/ws',model:'bigmodel',...patch}).success,false);
  const legacy={...f.config,protocol:undefined,apiKey:encryptApiKey('legacy-key')};
  await f.db.query("INSERT INTO system_configs(key,value) VALUES('asr_runtime_global',$1)",[JSON.stringify(legacy)]);
  assert.equal(publicModelServiceConfig('asr',(await readModelServiceConfig(f.db,'asr'))!).protocol,'openai');
  await assert.rejects(prepareModelServiceConfig(f.db,'asr',{...f.config,apiKey:undefined}),{code:'MODEL_KEY_REQUIRED'});
  const input={...f.config,apiKey:'fixture-new-voice'};
  const result=await saveModelServiceConfig(f.pool,'asr',input,randomUUID(),randomUUID(),no);
  assert.equal(result.protocol,'doubao-asr');assert.equal(decryptApiKey((await readModelServiceConfig(f.db,'asr'))!.apiKey),'fixture-new-voice');
  assert.ok(!JSON.stringify(result).includes('fixture-new-voice'));assert.ok(!JSON.stringify(result).includes('ciphertext'));
  assert.equal(await readModelServiceConfig(f.db,'streaming-asr'),null);
  const stream=await saveModelServiceConfig(f.pool,'streaming-asr',{protocol:'doubao-streaming',endpoint:'wss://8.8.8.8/asr',model:'bigmodel',resourceId:'volc.seedasr.sauc.duration',apiKey:'fixture-stream-key'},randomUUID(),randomUUID(),no);
  assert.equal(stream.protocol,'doubao-streaming');assert.equal(stream.timeoutMs,45000);
  assert.equal(decryptApiKey((await readModelServiceConfig(f.db,'streaming-asr'))!.apiKey),'fixture-stream-key');
  assert.equal(decryptApiKey((await readModelServiceConfig(f.db,'asr'))!.apiKey),'fixture-new-voice');
  await assert.rejects(prepareModelServiceConfig(f.db,'asr',{...input,model:'wrong'}),{code:'ASR_CONFIG_INVALID'});
  await assert.rejects(prepareModelServiceConfig(f.db,'asr',{...input,language:'zh'}),{code:'ASR_CONFIG_INVALID'});
  await assert.rejects(assertSafeStreamingEndpoint('wss://127.0.0.1:3219/asr'));
 }finally{await f.close();}
});

test('Doubao ASR submits JSON once, queries the same task while pending, parses text, and does not leak provider errors',async()=>{
 const f=await fixture();try{
  let submits=0,queries=0,id='';
  const fetcher:typeof fetch=async(url,options)=>{
   const headers=options!.headers as Record<string,string>;assert.equal(headers['X-Api-Key'],'fixture-voice-key');assert.equal(headers.Authorization,undefined);assert.equal(headers['X-Api-Resource-Id'],'volc.seedasr.auc');assert.equal(options!.redirect,'error');
   if(String(url).endsWith('/submit')){
    submits++;id=headers['X-Api-Request-Id'];const body=JSON.parse(options!.body as string);
    assert.deepEqual(body.audio,{url:'https://example.com/test.mp3',format:'mp3'});assert.equal(body.request.model_name,'bigmodel');
    return new Response('',{headers:{'X-Api-Status-Code':'20000000'}});
   }
   queries++;assert.equal(headers['X-Api-Request-Id'],id);assert.deepEqual(JSON.parse(options!.body as string),{});
   return queries===1?Response.json({},{headers:{'X-Api-Status-Code':'20000002'}}):Response.json({result:{text:'车门检查完成。'}},{headers:{'X-Api-Status-Code':'20000000'}});
  };
  const submitted=await testModelService('asr',f.config,signal,undefined,{fetch:fetcher},{url:'https://example.com/test.mp3',format:'mp3'});
  assert.equal(submitted.pending,true);assert.equal(submitted.taskId,id);assert.equal(submits,1);
  assert.equal((await queryAsrTask(f.config,id,signal,{fetch:fetcher})).pending,true);
  assert.equal((await queryAsrTask(f.config,id,signal,{fetch:fetcher})).text,'车门检查完成。');assert.equal(submits,1);
  await assert.rejects(queryAsrTask(f.config,id,signal,{fetch:async()=>Response.json({message:'provider-private-key'},{status:401})}),error=>!String(error).includes('provider-private-key'));
  for(const response of [Response.json({},{headers:{'X-Api-Status-Code':'45000001'}}),Response.json({result:{text:42}},{headers:{'X-Api-Status-Code':'20000000'}}),Response.json({result:{text:'x'.repeat(12001)}},{headers:{'X-Api-Status-Code':'20000000'}})])
   await assert.rejects(queryAsrTask(f.config,id,signal,{fetch:async()=>response}));
  env.MOP_ASR_ALLOWED_ENDPOINTS=[f.config.endpoint];
  await assert.rejects(testModelService('asr',f.config,signal,undefined,{fetch:async()=>{throw Error('must not submit');}},{url:'https://example.com/test.mp3',format:'mp3'}));
 }finally{await f.close();}
});

test('streaming WAV and frame decoders reject malformed input and gzip expansion; finals replace partial hypotheses',()=>{
 const audio=wav();assert.equal(streamingPcm(audio).length,12800);
 for(const bytes of [Buffer.alloc(44),audio.bytes.subarray(0,60),Buffer.from(audio.bytes)]){
  if(bytes.length===audio.bytes.length)bytes.writeUInt32LE(48000,24);
  assert.throws(()=>streamingPcm({...audio,bytes}),{code:'ASR_STREAM_AUDIO_INVALID'});
 }
 assert.deepEqual(parseStreamingFrame(frame('部分')),{text:'部分',final:false});assert.deepEqual(parseStreamingFrame(frame('最终',true)),{text:'最终',final:true});
 for(const bytes of [Buffer.from([1,2]),frame('x').subarray(0,10),frame('x'.repeat(70000)),Buffer.from([0x11,0xf0,0x10,0,0,0,0,1,0,0,0,0])])assert.throws(()=>parseStreamingFrame(bytes));
});

test('streaming probe sends binary paced PCM with server-only headers and waits for final text; rejects premature close and cancellation',async()=>{
 const f=await fixture(),server=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise<void>(resolve=>server.once('listening',resolve));
 const endpoint=`ws://127.0.0.1:${(server.address() as {port:number}).port}`;
 const config={...f.config,protocol:'doubao-streaming' as const,resourceId:'volc.seedasr.sauc.duration',endpoint:'wss://stream.example.com/asr'};
 let mode='success',chunks=0,bytes=0;
 server.on('connection',(socket,request)=>{
  assert.equal(request.headers['x-api-key'],'fixture-voice-key');assert.equal(request.headers['x-api-resource-id'],'volc.seedasr.sauc.duration');
  socket.on('message',raw=>{
   const data=Buffer.from(raw as Buffer),type=data[1]>>4,payload=gunzipSync(data.subarray(8));
   if(type===1){assert.equal(JSON.parse(payload.toString()).audio.rate,16000);if(mode==='close')socket.close();return;}
   chunks++;bytes+=payload.length;
   if(mode==='wait')return;
   socket.send(frame((data[1]&2)?'最终识别文本':'最终识别',!!(data[1]&2)));
  });
 });
 const dependencies={safety:no,connect:(_url:string,options:WebSocket.ClientOptions)=>new WebSocket(endpoint,options)};
 try{
  const result=await testStreamingAsr(config,wav(),signal,dependencies);
  assert.equal(result.text,'最终识别文本');assert.equal(result.partialCount,2);assert.equal(chunks,2);assert.equal(bytes,12800);
  mode='close';await assert.rejects(testStreamingAsr(config,wav(),signal,dependencies),{code:'ASR_STREAM_CLOSED'});
  const aborted=new AbortController();aborted.abort();await assert.rejects(testStreamingAsr(config,wav(),aborted.signal,dependencies),{name:'AbortError'});
  mode='wait';const during=new AbortController(),pending=testStreamingAsr(config,wav(),during.signal,dependencies);setTimeout(()=>during.abort(),50);
  await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(testStreamingAsr({...config,timeoutMs:3500},wav(),signal,dependencies),{code:'ASR_STREAM_TIMEOUT'});
 }finally{for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
