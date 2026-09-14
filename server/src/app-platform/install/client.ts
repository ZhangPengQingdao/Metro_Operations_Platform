import { readDeveloperFile } from '../developer/package.js';
import { InstallError } from './journal.js';
/** Explicit management endpoint and credential; never uses ambient cookie, redirects or retries. */
export async function callInstallEndpoint(origin:string,tokenFile:string,path:string,body?:unknown){
 let url:URL;try{url=new URL(origin);}catch{throw new InstallError('INVALID_INSTALL_ORIGIN');}
 if(url.origin!==origin||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname))))throw new InstallError('INVALID_INSTALL_ORIGIN');
 if(!/^\/api\/v1\/app-installations(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/.test(path))throw new InstallError('INVALID_INSTALL_PATH');
 const bytes=await readDeveloperFile(tokenFile,8192);let token:string;
 try{token=bytes.toString('utf8').trim();if(!/^[\x21-\x7e]{1,8192}$/.test(token))throw new InstallError('INVALID_INSTALL_CREDENTIAL');}finally{bytes.fill(0);}
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),60000);
 try{
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${token}`,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reader=response.body?.getReader();if(!reader)throw Error();const parts:Uint8Array[]=[];let size=0;
  while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>65536){await reader.cancel();throw Error();}parts.push(item.value);}
  if(!response.ok)throw new InstallError(response.status===403?'INSTALL_ACCESS_DENIED':'INSTALL_NOT_CONFIRMED');
  const result=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(!result||typeof result.appId!=='string'||typeof result.requestId!=='string'||!Number.isSafeInteger(result.revision)||result.revision<1||typeof result.installationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.installationId)||!['registered','installing','installed','recovery_required','recovering','recovered'].includes(result.state))throw Error();
  const submitted=body as {requestId?:unknown;manifest?:{id?:unknown}}|undefined;
  if(path==='/api/v1/app-installations'){if(result.appId!==submitted?.manifest?.id||result.requestId!==submitted?.requestId)throw Error();}
  else if(result.appId!==path.split('/').at(-1))throw Error();
  return {appId:result.appId,requestId:result.requestId,installationId:result.installationId,revision:result.revision,state:result.state};
 }catch(error){if(error instanceof InstallError)throw error;throw new InstallError('INSTALL_OUTCOME_UNKNOWN');}
 finally{clearTimeout(timeout);token='';}
}
