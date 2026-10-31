import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {env} from '../../../config/env.js';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../database/index.js';
import {assertSafeAiProviderEndpoint,encryptApiKey,decryptApiKey} from '../ai/index.js';
import {ModelServiceError} from './errors.js';
import {assertSafeStreamingEndpoint,testStreamingAsr} from './streaming-asr.js';
export {ModelServiceError} from './errors.js';

export type ModelServiceKind='rerank'|'asr'|'streaming-asr';
const baseSchema=z.object({
 endpoint:z.string().trim().url().max(500).refine(value=>{
  let url:URL;try{url=new URL(value);}catch{return false;}
  return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash;
 },'服务地址须为不含凭据、查询参数和片段的完整 HTTP(S) 地址').transform(value=>new URL(value).toString()),
 model:z.string().trim().min(1).max(120),
 timeoutMs:z.number().int().min(5000).max(120000).default(30000),
 apiKey:z.string().trim().max(4096).optional(),
}).strict();
const asrSchema=baseSchema.extend({protocol:z.enum(['openai','doubao-asr']).default('openai'),resourceId:z.enum(['volc.seedasr.auc','volc.bigasr.auc']).optional(),language:z.string().trim().regex(/^$|^[a-z]{2}$/).default('')});
const streamingSchema=baseSchema.extend({
 endpoint:z.string().trim().url().max(500).refine(value=>{try{const url=new URL(value);return url.protocol==='wss:'&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}},'流式服务地址须为不含凭据和查询参数的 WSS 地址'),
 protocol:z.literal('doubao-streaming').default('doubao-streaming'),model:z.literal('bigmodel').default('bigmodel'),
 timeoutMs:z.number().int().min(5000).max(120000).default(45000),
 resourceId:z.enum(['volc.seedasr.sauc.duration','volc.seedasr.sauc.concurrent','volc.bigasr.sauc.duration','volc.bigasr.sauc.concurrent']).default('volc.seedasr.sauc.duration'),
});
export function modelServiceSchema(kind:ModelServiceKind){return kind==='asr'?asrSchema:kind==='streaming-asr'?streamingSchema:baseSchema;}
export type ModelServiceInput=z.infer<typeof baseSchema>&{protocol?:'openai'|'doubao-asr'|'doubao-streaming';resourceId?:string;language?:string};
export type ModelServiceConfig=Omit<ModelServiceInput,'apiKey'>&{apiKey:ReturnType<typeof encryptApiKey>};
export async function assertSafeModelServiceEndpoint(kind:ModelServiceKind,endpoint:string){
 if(kind==='streaming-asr')return assertSafeStreamingEndpoint(endpoint);
 const allowed=kind==='rerank'?env.MOP_RERANK_ALLOWED_ENDPOINTS:env.MOP_ASR_ALLOWED_ENDPOINTS;
 if(allowed.includes(endpoint))return;
 await assertSafeAiProviderEndpoint(endpoint);
}
export async function readModelServiceConfig(db:QueryableClient,kind:ModelServiceKind):Promise<ModelServiceConfig|null>{
 const result=await db.query('SELECT value FROM system_configs WHERE key=$1',[`${kind}_runtime_global`]) as {rows:{value:ModelServiceConfig}[]};
 return result.rows[0]?.value??null;
}
export function publicModelServiceConfig(kind:ModelServiceKind,config:ModelServiceConfig|null){
 return {endpoint:config?.endpoint??'',model:config?.model??'',timeoutMs:config?.timeoutMs??(kind==='streaming-asr'?45000:30000),
  ...(kind==='asr'?{protocol:config?.protocol??'openai',language:config?.language??'',...(config?.protocol==='doubao-asr'?{resourceId:config.resourceId??'volc.seedasr.auc'}:{})}:{}),
  ...(kind==='streaming-asr'?{protocol:config?.protocol??'doubao-streaming',resourceId:config?.resourceId??'volc.seedasr.sauc.duration'}:{}),hasApiKey:!!config?.apiKey,configured:!!config};
}
async function prepareConfig(db:QueryableClient,kind:ModelServiceKind,input:ModelServiceInput):Promise<ModelServiceConfig>{
 const previous=await readModelServiceConfig(db,kind);
 if(!input.apiKey&&(!previous?.apiKey||previous.endpoint!==input.endpoint||(kind!=='rerank'&&(previous.protocol??'openai')!==input.protocol)))
  throw new ModelServiceError('MODEL_KEY_REQUIRED','首次配置或更换协议、地址后，请填写 API Key。');
 return {...input,apiKey:input.apiKey?encryptApiKey(input.apiKey):previous!.apiKey};
}
export async function prepareModelServiceConfig(db:QueryableClient,kind:ModelServiceKind,input:unknown){
 const parsed=modelServiceSchema(kind).parse(input);
 validateProtocolConfig(parsed);
 await assertSafeModelServiceEndpoint(kind,parsed.endpoint);
 return prepareConfig(db,kind,parsed);
}
export async function saveModelServiceConfig(pool:ConnectablePool,kind:ModelServiceKind,raw:unknown,requestId:string,actorId:string,audit:(db:QueryableClient)=>Promise<void>){
 z.string().uuid().parse(requestId);
 const input=modelServiceSchema(kind).parse(raw);
 validateProtocolConfig(input);
 // Network validation must not hold the database transaction open.
 await assertSafeModelServiceEndpoint(kind,input.endpoint);
 const fingerprint=(salt:string)=>createHash('sha256').update(salt).update(JSON.stringify({kind,actorId,input})).digest('hex');
 const db=await pool.connect();
 try{return await runDatabaseTransaction(db,async()=>{
  await db.query('SELECT pg_advisory_xact_lock(6013017)');
  const existing=await db.query('SELECT salt,digest,result FROM model_configuration_requests WHERE request_id=$1',[requestId]) as {rows:{salt:string;digest:string;result:ReturnType<typeof publicModelServiceConfig>}[]};
  if(existing.rows[0]){
   const row=existing.rows[0];
   if(row.digest!==fingerprint(row.salt))throw new ModelServiceError('REQUEST_ID_REUSED','请求编号已被用于其他配置操作。',409);
   return row.result;
  }
  const config=await prepareConfig(db,kind,input);
  await db.query(`INSERT INTO system_configs(key,value,description) VALUES($1,$2,$3)
   ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,[`${kind}_runtime_global`,JSON.stringify(config),kind==='rerank'?'重排序模型':kind==='asr'?'语音识别模型':'流式语音识别模型']);
  const result=publicModelServiceConfig(kind,config),salt=randomUUID();
  await audit(db);
  await db.query('INSERT INTO model_configuration_requests(request_id,salt,digest,result) VALUES($1,$2,$3,$4)',[requestId,salt,fingerprint(salt),JSON.stringify(result)]);
  return result;
 });}finally{db.release();}
}

function validateProtocolConfig(input:Omit<ModelServiceInput,'apiKey'>){
 if(input.protocol==='doubao-asr'){
  if(input.model!=='bigmodel'||!new URL(input.endpoint).pathname.endsWith('/submit'))
   throw new ModelServiceError('ASR_CONFIG_INVALID','豆包录音识别须使用完整 submit 地址，模型填写 bigmodel。');
  if(input.language)throw new ModelServiceError('ASR_CONFIG_INVALID','豆包录音识别使用自动语言识别，请清空语言提示。');
  input.resourceId??='volc.seedasr.auc';
 }else if(input.protocol==='openai')delete input.resourceId;
}

export const MAX_TEST_AUDIO_BYTES=2*1024*1024;
const audioTypes={wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4',webm:'audio/webm',ogg:'audio/ogg'} as const;
export const testAudioSchema=z.object({format:z.enum(['wav','mp3','m4a','webm','ogg']),data:z.string().min(4).max(Math.ceil(MAX_TEST_AUDIO_BYTES/3)*4)}).strict();
export function decodeTestAudio(raw:unknown){
 const audio=testAudioSchema.parse(raw);
 if(audio.data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data))throw new ModelServiceError('ASR_AUDIO_INVALID','测试音频格式无效。');
 const bytes=Buffer.from(audio.data,'base64');
 if(!bytes.length||bytes.length>MAX_TEST_AUDIO_BYTES||bytes.toString('base64')!==audio.data)
  throw new ModelServiceError('ASR_AUDIO_INVALID','请选择不超过 2 MiB 的短音频。');
 return {bytes,format:audio.format,contentType:audioTypes[audio.format]};
}
type TestDependencies={fetch?:typeof fetch};
export type ModelTestResult={latencyMs:number;text?:string;taskId?:string;pending?:boolean;partialCount?:number;results?:{index:number;relevance_score:number;text:string}[]};
export const asrUrlAudioSchema=z.object({url:z.string().trim().url().max(2048),format:z.enum(['wav','mp3','ogg'])}).strict();
async function readProviderJson(response:Response,allowEmpty=false){
 if(!response.ok){await response.body?.cancel();throw new ModelServiceError('MODEL_PROVIDER_FAILED','模型服务拒绝请求，请检查地址、密钥、模型和接口协议。',502);}
 const reader=response.body?.getReader();
 if(!reader)throw new ModelServiceError('MODEL_RESPONSE_INVALID','模型服务返回为空。',502);
 const chunks:Uint8Array[]=[];let size=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
   if(size>65536){await reader.cancel();throw new ModelServiceError('MODEL_RESPONSE_TOO_LARGE','模型测试响应超过大小限制。',502);}chunks.push(value);}
  try{return !size&&allowEmpty?{}:JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  catch{throw new ModelServiceError('MODEL_RESPONSE_INVALID','模型服务未返回有效 JSON。',502);}
 }finally{reader.releaseLock();}
}
export const RERANK_TEST_QUERY='列车车门故障应如何处理？';
export const RERANK_TEST_DOCUMENTS=['发现车门故障后按规程报修，并确认现场安全。','绿化区域定期浇水和修剪。'];
/** Transcribe original bytes in memory. The configured URL-only protocol cannot take a private file. */
export async function transcribeAudioFile(config:ModelServiceConfig,audio:{bytes:Buffer;format:string;contentType:string},signal:AbortSignal,request:typeof fetch=fetch,fileName='recording'){
 if(config.protocol&&config.protocol!=='openai')throw new ModelServiceError('ASR_FILE_PROTOCOL','当前语音协议需要音频网址。请为本地录音配置兼容文件上传的语音模型。',422);
 await assertSafeModelServiceEndpoint('asr',config.endpoint);
 const started=Date.now(),form=new FormData();
 form.set('model',config.model);form.set('response_format','json');
 if(config.language)form.set('language',config.language);
 form.set('file',new Blob([new Uint8Array(audio.bytes)],{type:audio.contentType}),`${fileName}.${audio.format}`);
 const timeout=AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]);
 const response=await request(config.endpoint,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${decryptApiKey(config.apiKey)}`},body:form,signal:timeout});
 const payload=await readProviderJson(response);
 timeout.throwIfAborted();
 const parsed=z.object({text:z.string().max(12000)}).safeParse(payload);
 if(!parsed.success)throw new ModelServiceError('MODEL_RESPONSE_INVALID','语音服务须返回 text 字段，且文本不超过 12000 字符。',502);
 return {latencyMs:Date.now()-started,text:parsed.data.text};
}
/** Admin diagnostics only. Business retrieval and audio workflows do not call these probes. */
export async function testModelService(kind:ModelServiceKind,config:ModelServiceConfig,signal:AbortSignal,audio?:ReturnType<typeof decodeTestAudio>,dependencies:TestDependencies={},urlAudio?:z.infer<typeof asrUrlAudioSchema>):Promise<ModelTestResult>{
 signal.throwIfAborted();
 if(kind==='streaming-asr'){
  if(!audio)throw new ModelServiceError('ASR_AUDIO_REQUIRED','请先选择用于测试的短音频。');
  return testStreamingAsr(config,audio,signal);
 }
 if(kind==='asr'&&config.protocol==='doubao-asr')return submitDoubaoAsr(config,urlAudio,signal,dependencies);
 if(kind==='asr'){
  if(!audio)throw new ModelServiceError('ASR_AUDIO_REQUIRED','请先选择用于测试的短音频。');
  return transcribeAudioFile(config,audio,signal,dependencies.fetch,'connection-test');
 }
 await assertSafeModelServiceEndpoint(kind,config.endpoint);
 signal.throwIfAborted();
 const started=Date.now(),headers={'Content-Type':'application/json',Authorization:`Bearer ${decryptApiKey(config.apiKey)}`};
 const body=JSON.stringify({model:config.model,query:RERANK_TEST_QUERY,documents:RERANK_TEST_DOCUMENTS,top_n:2});
 const timeoutSignal=AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]);
 const response=await (dependencies.fetch??fetch)(config.endpoint,{method:'POST',headers,body,redirect:'error',signal:timeoutSignal});
 const payload=await readProviderJson(response);
 timeoutSignal.throwIfAborted();
  const parsed=z.object({results:z.array(z.object({index:z.number().int().min(0).max(1),relevance_score:z.number().finite()})).length(2)}).safeParse(payload);
  if(!parsed.success||new Set(parsed.data.results.map(row=>row.index)).size!==2)
   throw new ModelServiceError('MODEL_RESPONSE_INVALID','重排序结果须包含两个不同候选的索引和有效分数。',502);
  return {latencyMs:Date.now()-started,results:parsed.data.results.map(row=>({...row,text:RERANK_TEST_DOCUMENTS[row.index]}))};
}

async function doubaoRequest(config:ModelServiceConfig,taskId:string,query:boolean,body:unknown,signal:AbortSignal,dependencies:TestDependencies){
 const endpoint=query?config.endpoint.replace(/\/submit$/,'/query'):config.endpoint;
 await assertSafeModelServiceEndpoint('asr',endpoint);
 signal.throwIfAborted();
 const response=await (dependencies.fetch??fetch)(endpoint,{method:'POST',redirect:'error',signal,
  headers:{'Content-Type':'application/json','X-Api-Key':decryptApiKey(config.apiKey),'X-Api-Resource-Id':config.resourceId??'volc.seedasr.auc','X-Api-Request-Id':taskId,'X-Api-Sequence':'-1'},body:JSON.stringify(body)});
 if(response.status===401||response.status===403){await response.body?.cancel();throw new ModelServiceError('ASR_AUTH_FAILED','豆包语音鉴权失败，请检查语音服务 API Key 和资源开通状态。',502);}
 const data=await readProviderJson(response,true);
 const code=response.headers.get('X-Api-Status-Code')??(data as Record<string,unknown>)?.['X-Api-Status-Code'];
 if(!['20000000','20000001','20000002'].includes(String(code)))
  throw new ModelServiceError('ASR_PROVIDER_FAILED','豆包语音未完成识别，请检查资源 ID、音频地址和音频格式。',502);
 return {data,code:String(code)};
}
async function submitDoubaoAsr(config:ModelServiceConfig,audio:unknown,signal:AbortSignal,dependencies:TestDependencies):Promise<ModelTestResult>{
 validateProtocolConfig(config);
 const parsed=asrUrlAudioSchema.safeParse(audio);
 if(!parsed.success)throw new ModelServiceError('ASR_AUDIO_URL_REQUIRED','请填写公网可访问的 WAV、MP3 或 OGG 音频地址。');
 // The provider fetches the audio. Never publish a local recording just to run diagnostics.
 await assertSafeAiProviderEndpoint(parsed.data.url);
 // Validate both paths before creating a billable task. An allowlisted submit URL does not authorize query.
 await assertSafeModelServiceEndpoint('asr',config.endpoint.replace(/\/submit$/,'/query'));
 const started=Date.now(),taskId=randomUUID();
 await doubaoRequest(config,taskId,false,{user:{uid:'mop-admin-diagnostic'},audio:parsed.data,
  request:{model_name:'bigmodel',enable_itn:true,enable_punc:true,show_utterances:false}},AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]),dependencies);
 return {latencyMs:Date.now()-started,taskId,pending:true};
}
export async function queryAsrTask(config:ModelServiceConfig,taskId:string,signal:AbortSignal,dependencies:TestDependencies={}):Promise<ModelTestResult>{
 if(config.protocol!=='doubao-asr')throw new ModelServiceError('ASR_PROTOCOL_INVALID','只有豆包录音识别协议支持任务查询。');
 validateProtocolConfig(config);z.string().uuid().parse(taskId);
 const started=Date.now(),{data,code}=await doubaoRequest(config,taskId,true,{},AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]),dependencies);
 if(code!=='20000000')return {latencyMs:Date.now()-started,taskId,pending:true};
 const parsed=z.object({result:z.object({text:z.string().max(12000)})}).safeParse(data);
 if(!parsed.success)throw new ModelServiceError('MODEL_RESPONSE_INVALID','豆包语音未返回有效的转写结果。',502);
 return {latencyMs:Date.now()-started,taskId,pending:false,text:parsed.data.result.text};
}
