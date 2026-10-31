import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {registerEmployeeRoutes} from '../src/app-platform/employee/routes.ts';
import {GatewayError} from '../src/app-platform/gateway/model.ts';
import {transcribeAudioFile,ModelServiceError} from '../src/core/integrations/model-services/index.ts';
import {encryptApiKey} from '../src/core/integrations/ai/index.ts';
import {env} from '../src/config/env.ts';

test('private recording route enforces employee origin and application authorization before and after transcription',async()=>{
 const app=Fastify(),origin='https://employee.example';await app.register(cookie);
 let authenticated=true,allowed=true,calls=0,checks=0,revoke=false;
 registerEmployeeRoutes(app,{origin,resolveAdmin:async()=>{throw Error('denied');},
  service:{authenticate:async()=>authenticated?{personId:'employee',passwordChangeRequired:false}:null,resolveIdentity:async()=>({source:'session',userId:'employee'})} as any,
  management:{authorizeEmployeeTranscription:async(appId:string,_resolve:unknown,key:string)=>{checks++;if(!allowed||appId!=='huicetong'||key!=='fixture')throw new GatewayError('ACCESS_DENIED',403);}} as any,
  transcriptionBackend:{config:async()=>({protocol:'openai'} as any),transcribe:async(_config,audio)=>{
   calls++;assert.equal(audio.bytes.toString(),'audio bytes');assert.equal(audio.contentType,'audio/webm');if(revoke)allowed=false;return {text:'两条会议事项',latencyMs:1};
  }}
 });
 try{
  const request={method:'POST' as const,url:'/api/employee/apps/huicetong/transcription?format=webm',headers:{origin,'x-mop-employee-admission':'fixture','content-type':'application/octet-stream'},payload:Buffer.from('audio bytes')};
  assert.equal((await app.inject({...request,headers:{...request.headers,origin:'https://wrong.example'}})).statusCode,403);
  authenticated=false;assert.equal((await app.inject(request)).statusCode,401);authenticated=true;
  allowed=false;assert.equal((await app.inject(request)).statusCode,403);assert.equal(calls,0);allowed=true;
  const before=checks,response=await app.inject(request);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{text:'两条会议事项'});assert.equal(checks-before,3);assert.equal(calls,1);
  assert.equal((await app.inject({...request,url:request.url.replace('webm','exe')})).statusCode,400);
  revoke=true;assert.equal((await app.inject(request)).statusCode,403);assert.equal(calls,2);
 }finally{await app.close();}
});

test('recording transport preserves bytes, bounds replies and rejects URL-only protocols before sending',async()=>{
 const previous={key:env.AI_PROVIDER_ENCRYPTION_KEY,urls:env.MOP_ASR_ALLOWED_ENDPOINTS};
 env.AI_PROVIDER_ENCRYPTION_KEY='c'.repeat(64);env.MOP_ASR_ALLOWED_ENDPOINTS=['http://127.0.0.1:3215/asr'];
 try{
  const config={protocol:'openai' as const,endpoint:'http://127.0.0.1:3215/asr',model:'asr',timeoutMs:5000,apiKey:encryptApiKey('private')};
  let calls=0;const bytes=Buffer.from('original audio');
  const request:typeof fetch=async(_url,options)=>{calls++;const form=options!.body as FormData;assert.equal(await (form.get('file') as File).text(),bytes.toString());assert.equal(form.get('model'),'asr');return Response.json({text:'第一项。第二项。'});};
  const audio={bytes,format:'webm',contentType:'audio/webm'};
  assert.equal((await transcribeAudioFile(config,audio,new AbortController().signal,request)).text,'第一项。第二项。');
  await assert.rejects(transcribeAudioFile({...config,protocol:'doubao-asr'},audio,new AbortController().signal,request),(e:unknown)=>e instanceof ModelServiceError&&e.code==='ASR_FILE_PROTOCOL');assert.equal(calls,1);
  await assert.rejects(transcribeAudioFile(config,audio,new AbortController().signal,async()=>Response.json({text:'x'.repeat(12001)})),/12000/);
 }finally{env.AI_PROVIDER_ENCRYPTION_KEY=previous.key;env.MOP_ASR_ALLOWED_ENDPOINTS=previous.urls;}
});
