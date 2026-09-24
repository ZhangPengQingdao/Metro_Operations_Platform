import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import type {SandboxDocument} from './document.js';

/** A separate listener serves only short-lived, one-use verified documents. No API or cookies. */
const appIdPattern=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const assetPattern=/^\/assets\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-f0-9]{64})\/ui\.js$/;
export async function createSandboxResourceServer(platformOrigin:string,resourceOrigin:string,port=3103,hostname='0.0.0.0',loadBundle?:(appId:string,hash:string)=>Promise<Uint8Array|null>){
 const parent=new URL(platformOrigin),target=new URL(resourceOrigin);
 if(parent.origin!==platformOrigin||target.origin!==resourceOrigin||parent.protocol!=='https:'||target.protocol!=='https:'
  ||parent.hostname===target.hostname||parent.hostname.endsWith(`.${target.hostname}`)||target.hostname.length>188||target.username||target.password||!Number.isInteger(port)||port<0||port>65535)throw Error('APP_RESOURCE_ORIGIN_INVALID');
 const entries=new Map<string,{document:SandboxDocument;expires:number;authorize:()=>Promise<void>;host:string}>();
 const appOrigin=(appId:string)=>{if(!appIdPattern.test(appId)||appId.length>63)throw Error('APP_RESOURCE_INVALID_ID');return `${target.protocol}//${appId}.${target.host}`;};
 let bytes=0;
 function remove(key:string){const item=entries.get(key);if(item){bytes-=Buffer.byteLength(item.document.html);entries.delete(key);}return item;}
 function prune(){for(const [key,item]of entries)if(item.expires<=Date.now())remove(key);}
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='GET'&&req.headers.host===target.host&&req.url==='/health/live'){res.setHeader('X-Mop-Resource','1');res.writeHead(204);res.end();return;}
  const asset=req.method==='GET'?assetPattern.exec(req.url??''):null;
  if(asset&&asset[1]!.length<=63&&req.headers.host===new URL(appOrigin(asset[1]!)).host&&loadBundle){
   try{const bytes=await loadBundle(asset[1]!,asset[2]!);if(!bytes){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','text/javascript; charset=utf-8');res.setHeader('Cache-Control','public, max-age=31536000, immutable');
    // The public hash bundle may be prefetched by the platform page; it contains no session data.
    res.setHeader('Cross-Origin-Resource-Policy','cross-origin');res.writeHead(200);res.end(bytes);return;
   }catch{res.writeHead(404);res.end();return;}
  }
  // Host is preserved by the dedicated proxy. Never trust X-Forwarded-Host.
  if(req.method!=='GET'||!/^\/document\/[a-f0-9]{64}$/.test(req.url??'')){
   res.writeHead(404);res.end();return;
  }
  prune();const token=req.url!.slice('/document/'.length),item=entries.get(token);
  if(!item){res.writeHead(404);res.end();return;}
  if(req.headers.host!==item.host){res.writeHead(404);res.end();return;}
  remove(token);
  try{await item.authorize();for(const [name,value]of Object.entries(item.document.headers))res.setHeader(name,value);res.writeHead(200);res.end(item.document.html);}
  catch{res.writeHead(403);res.end();}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,hostname,()=>{server.off('error',reject);resolve();});});
 const timer=setInterval(prune,30000);timer.unref();
 return {
  port:(server.address() as {port:number}).port,
  appOrigin,
  assetUrl(appId:string,hash:string){if(!/^[a-f0-9]{64}$/.test(hash))throw Error('APP_RESOURCE_INVALID_HASH');return `${appOrigin(appId)}/assets/${appId}/${hash}/ui.js`;},
  publish(document:SandboxDocument,authorize:()=>Promise<void>,trustedAppId?:string){
   prune();const size=Buffer.byteLength(document.html);
   if(entries.size>=128||bytes+size>32*1024*1024)throw Error('APP_RESOURCE_CAPACITY');
   const resource=trustedAppId?appOrigin(trustedAppId):resourceOrigin;
   const token=randomBytes(32).toString('hex');entries.set(token,{document,authorize,host:new URL(resource).host,expires:Date.now()+60000});bytes+=size;
   return {mode:'isolated-origin' as const,url:`${resource}/document/${token}`,platformOrigin,...(trustedAppId?{frontendRunMode:'trusted' as const}:{})};
  },
  async close(){clearInterval(timer);entries.clear();bytes=0;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));},
 };
}
