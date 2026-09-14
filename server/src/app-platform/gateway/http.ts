import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppGateway } from './gateway.js';
import { GatewayError } from './model.js';
/** Mount explicitly behind transport-level header/connection limits; never a cookie session route. */
export function createAppGatewayHttpHandler(gateway:AppGateway,appId:string) {
  return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    const controller=new AbortController();
    const abort=()=>controller.abort();
    req.once('aborted',abort);
    const close=()=>{if(!res.writableEnded) abort();};res.once('close',close);
    try {
      const response=await gateway.invokeServiceFromTransport(appId,async(signal)=>{
      const stopReading=()=>req.destroy();signal.addEventListener('abort',stopReading,{once:true});
      try {
      if(req.method!=='POST') throw new GatewayError('METHOD_NOT_ALLOWED',405);
      if(Buffer.byteLength(req.rawHeaders.join('\n'))>8192) throw new GatewayError('HEADERS_TOO_LARGE',431);
      const names=req.rawHeaders.filter((_,i)=>i%2===0).map(v=>v.toLowerCase());
      for(const name of ['authorization','content-type','content-length','transfer-encoding']) if(names.filter(v=>v===name).length>1) throw new GatewayError('INVALID_HEADERS');
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'') || req.headers['content-encoding']) throw new GatewayError('UNSUPPORTED_MEDIA_TYPE',415);
      const auth=req.headers.authorization;
      if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,1024}$/.test(auth)) throw new GatewayError('INVALID_CREDENTIAL',401);
      const length=req.headers['content-length'];
      if(length && (!/^\d+$/.test(length)||Number(length)>gateway.admission.limits.requestBytes)) throw new GatewayError('PAYLOAD_TOO_LARGE',413);
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req) {const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>gateway.admission.limits.requestBytes) throw new GatewayError('PAYLOAD_TOO_LARGE',413);chunks.push(buffer);}
      let body:unknown;try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new GatewayError('INVALID_JSON');}
      return {credential:auth.slice(7),request:body};
      }finally{signal.removeEventListener('abort',stopReading);}
      },controller.signal);
      res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.end(JSON.stringify(response));
    }catch(error){
      const safe=error instanceof GatewayError?error:new GatewayError('GATEWAY_FAILED',500);
      if(!res.destroyed&&!res.writableEnded){res.statusCode=safe.statusCode;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.end(JSON.stringify({version:'1.0',error:{code:safe.code,writeOutcome:safe.writeOutcome}}));}
    }finally{req.removeListener('aborted',abort);res.removeListener('close',close);}
  };
}
