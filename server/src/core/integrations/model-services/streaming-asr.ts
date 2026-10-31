import {randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {assertSafeAiProviderEndpoint,decryptApiKey} from '../ai/index.js';
import {ModelServiceError} from './errors.js';
import type {ModelServiceConfig,ModelTestResult,decodeTestAudio} from './index.js';

export async function assertSafeStreamingEndpoint(value:string){
 const url=new URL(value);
 if(url.protocol!=='wss:')throw new ModelServiceError('ASR_STREAM_ENDPOINT_INVALID','流式语音服务须使用 WSS 地址。');
 url.protocol='https:';await assertSafeAiProviderEndpoint(url.toString());
}

/** Diagnostics accept PCM WAV only, so frame rate and pacing are known without transcoding. */
export function streamingPcm(audio:ReturnType<typeof decodeTestAudio>):Buffer{
 const bytes=audio.bytes;
 const invalid=()=>new ModelServiceError('ASR_STREAM_AUDIO_INVALID','请选择不超过 30 秒、16 kHz、单声道、16 位 PCM 编码的 WAV 音频。');
 if(audio.format!=='wav'||bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw invalid();
 let formatValid=false,pcm:Buffer|undefined;
 for(let offset=12;offset+8<=bytes.length;){
  const id=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;
  if(start+size>bytes.length)throw invalid();
  if(id==='fmt '){
   if(size<16)throw invalid();
   formatValid=bytes.readUInt16LE(start)===1&&bytes.readUInt16LE(start+2)===1&&bytes.readUInt32LE(start+4)===16000&&bytes.readUInt32LE(start+8)===32000&&bytes.readUInt16LE(start+12)===2&&bytes.readUInt16LE(start+14)===16;
  }
  if(id==='data'){if(pcm)throw invalid();pcm=bytes.subarray(start,start+size);}
  offset=start+size+(size%2);
 }
 if(!formatValid||!pcm?.length||pcm.length%2||pcm.length>30*32000)throw invalid();
 return pcm;
}

function clientFrame(type:number,payload:Buffer,final=false){
 const packed=gzipSync(payload),header=Buffer.from([0x11,(type<<4)|(final?2:0),(type===1?0x10:0)|1,0]);
 const size=Buffer.alloc(4);size.writeUInt32BE(packed.length);
 return Buffer.concat([header,size,packed]);
}

export function parseStreamingFrame(bytes:Buffer){
 const invalid=()=>new ModelServiceError('ASR_STREAM_RESPONSE_INVALID','流式语音服务返回的消息格式无效。',502);
 if(bytes.length<8||bytes[0]!==0x11)throw invalid();
 const type=bytes[1]>>4,flags=bytes[1]&15,compression=bytes[2]&15;
 if(![9,15].includes(type)||flags>3||bytes[2]>>4!==1||compression>1)throw invalid();
 let offset=4,sequence=0;
 if(type===15)throw new ModelServiceError('ASR_STREAM_PROVIDER_FAILED','流式语音服务拒绝识别，请检查资源开通状态与音频格式。',502);
 if(flags&1){if(bytes.length<12)throw invalid();sequence=bytes.readInt32BE(offset);offset+=4;}
 if(offset+4>bytes.length)throw invalid();
 const size=bytes.readUInt32BE(offset);offset+=4;
 if(size>65536||offset+size!==bytes.length)throw invalid();
 let payload:unknown;
 try{const packed=bytes.subarray(offset);payload=JSON.parse((compression?gunzipSync(packed,{maxOutputLength:65536}):packed).toString('utf8'));}catch{throw invalid();}
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw invalid();
 const row=payload as {code?:unknown;result?:{text?:unknown}};
 if(row.code!==undefined&&row.code!==0&&row.code!==20000000)
  throw new ModelServiceError('ASR_STREAM_PROVIDER_FAILED','流式语音服务未完成识别，请检查资源与音频。',502);
 if(row.result?.text!==undefined&&(typeof row.result.text!=='string'||row.result.text.length>12000))throw invalid();
 return {text:row.result?.text as string|undefined,final:!!(flags&2)||sequence<0};
}

/** Sends actual audio at 200 ms intervals. Keys stay on the API process; this is not a browser relay. */
export async function testStreamingAsr(config:ModelServiceConfig,audio:ReturnType<typeof decodeTestAudio>,signal:AbortSignal,
 dependencies:{safety?:(endpoint:string)=>Promise<unknown>;connect?:(endpoint:string,options:WebSocket.ClientOptions)=>WebSocket}={}):Promise<ModelTestResult>{
 const pcm=streamingPcm(audio);
 if(config.timeoutMs<pcm.length/32+3000)throw new ModelServiceError('ASR_STREAM_TIMEOUT_SHORT','请求超时需比测试音频时长至少多 3 秒。');
 signal.throwIfAborted();await (dependencies.safety??assertSafeStreamingEndpoint)(config.endpoint);signal.throwIfAborted();
 const started=Date.now(),requestId=randomUUID(),sending=new AbortController();
 return new Promise((resolve,reject)=>{
  const socket=(dependencies.connect??((endpoint,options)=>new WebSocket(endpoint,options)))(config.endpoint,{
   headers:{'X-Api-Key':decryptApiKey(config.apiKey),'X-Api-Resource-Id':config.resourceId??'volc.seedasr.sauc.duration','X-Api-Request-Id':requestId,'X-Api-Connect-Id':requestId},
   followRedirects:false,handshakeTimeout:config.timeoutMs,maxPayload:65536,perMessageDeflate:false,
  });
  let settled=false,finalSent=false,text='',partialCount=0,totalReceived=0;
  const finish=(error?:unknown)=>{
   if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);sending.abort();
   socket.removeAllListeners();socket.on('error',()=>{});socket.terminate();
   if(error)reject(error);else resolve({latencyMs:Date.now()-started,text,partialCount});
  };
  const abort=()=>finish(signal.reason);
  const timer=setTimeout(()=>finish(new ModelServiceError('ASR_STREAM_TIMEOUT','流式语音测试超时，请检查连接或增加超时时间。',504)),config.timeoutMs);
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted){abort();return;}
  socket.on('unexpected-response',(_request,response)=>{
   response.resume();const denied=response.statusCode===401||response.statusCode===403;
   finish(new ModelServiceError(denied?'ASR_STREAM_AUTH_FAILED':'ASR_STREAM_HANDSHAKE_FAILED',denied?
    `流式语音鉴权被拒绝（HTTP ${response.statusCode}），请检查语音 API Key、资源 ID 和开通状态。`:
    `流式服务未能建立连接（HTTP ${response.statusCode}），请检查 WSS 地址与服务状态。`,502));
  });
  socket.on('error',()=>finish(new ModelServiceError('ASR_STREAM_CONNECTION_FAILED','流式语音连接失败，请检查服务地址。',502)));
  socket.on('close',()=>finish(new ModelServiceError('ASR_STREAM_CLOSED','流式连接在返回最终识别结果前关闭。',502)));
  socket.on('message',(raw,isBinary)=>{
   try{
    if(!isBinary)throw new ModelServiceError('ASR_STREAM_RESPONSE_INVALID','流式服务须返回二进制消息。',502);
    const bytes=Buffer.isBuffer(raw)?raw:Array.isArray(raw)?Buffer.concat(raw):Buffer.from(raw);
    totalReceived+=bytes.length;
    if(totalReceived>2*1024*1024)throw new ModelServiceError('MODEL_RESPONSE_TOO_LARGE','流式测试响应超过大小限制。',502);
    const result=parseStreamingFrame(bytes);
    // Full hypotheses replace earlier partial text; concatenation would duplicate words.
    if(result.text!==undefined){text=result.text;partialCount++;}
    if(result.final){if(!finalSent||result.text===undefined)throw new ModelServiceError('ASR_STREAM_RESPONSE_INVALID','流式服务缺少有效的最终结果。',502);finish();}
   }catch(error){finish(error);}
  });
  socket.on('open',()=>{
   void (async()=>{
    socket.send(clientFrame(1,Buffer.from(JSON.stringify({user:{uid:'mop-admin-diagnostic'},audio:{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1},request:{model_name:'bigmodel',enable_itn:true,enable_punc:true,show_utterances:true,result_type:'full'}}))));
    for(let offset=0;offset<pcm.length;offset+=6400){
     sending.signal.throwIfAborted();finalSent=offset+6400>=pcm.length;
     await new Promise<void>((done,fail)=>socket.send(clientFrame(2,pcm.subarray(offset,offset+6400),finalSent),error=>error?fail(error):done()));
     if(!finalSent)await delay(200,undefined,{signal:sending.signal});
    }
   })().catch(()=>{if(!settled)finish(new ModelServiceError('ASR_STREAM_SEND_FAILED','未能完成测试音频发送。',502));});
  });
 });
}
