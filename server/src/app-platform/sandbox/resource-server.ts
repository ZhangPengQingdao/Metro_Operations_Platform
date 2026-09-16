import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import type {SandboxDocument} from './document.js';

/** A separate listener serves only short-lived, one-use verified documents. No API or cookies. */
export async function createSandboxResourceServer(platformOrigin:string,resourceOrigin:string,port=3103,hostname='0.0.0.0'){
 const parent=new URL(platformOrigin),target=new URL(resourceOrigin);
 if(parent.origin!==platformOrigin||target.origin!==resourceOrigin||parent.protocol!=='https:'||target.protocol!=='https:'
  ||parent.hostname===target.hostname||target.username||target.password||!Number.isInteger(port)||port<0||port>65535)throw Error('APP_RESOURCE_ORIGIN_INVALID');
 const entries=new Map<string,{document:SandboxDocument;expires:number;authorize:()=>Promise<void>}>();
 let bytes=0;
 function remove(key:string){const item=entries.get(key);if(item){bytes-=Buffer.byteLength(item.document.html);entries.delete(key);}return item;}
 function prune(){for(const [key,item]of entries)if(item.expires<=Date.now())remove(key);}
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='GET'&&req.headers.host===target.host&&req.url==='/health/live'){res.setHeader('X-Mop-Resource','1');res.writeHead(204);res.end();return;}
  // Host is preserved by the dedicated proxy. Never trust X-Forwarded-Host.
  if(req.method!=='GET'||req.headers.host!==target.host||!/^\/document\/[a-f0-9]{64}$/.test(req.url??'')){
   res.writeHead(404);res.end();return;
  }
  prune();const item=remove(req.url!.slice('/document/'.length));
  if(!item){res.writeHead(404);res.end();return;}
  try{await item.authorize();for(const [name,value]of Object.entries(item.document.headers))res.setHeader(name,value);res.writeHead(200);res.end(item.document.html);}
  catch{res.writeHead(403);res.end();}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,hostname,()=>{server.off('error',reject);resolve();});});
 const timer=setInterval(prune,30000);timer.unref();
 return {
  port:(server.address() as {port:number}).port,
  publish(document:SandboxDocument,authorize:()=>Promise<void>){
   prune();const size=Buffer.byteLength(document.html);
   if(entries.size>=128||bytes+size>32*1024*1024)throw Error('APP_RESOURCE_CAPACITY');
   const token=randomBytes(32).toString('hex');entries.set(token,{document,authorize,expires:Date.now()+60000});bytes+=size;
   return {mode:'isolated-origin' as const,url:`${resourceOrigin}/document/${token}`,platformOrigin};
  },
  async close(){clearInterval(timer);entries.clear();bytes=0;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));},
 };
}
