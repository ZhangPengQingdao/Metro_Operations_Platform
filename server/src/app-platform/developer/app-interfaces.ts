import {z} from 'zod';
import {matchesAppContract} from '@metro/platform-sdk/app-api-documentation';
import type {AppApiExposure} from '@metro/platform-sdk/manifest';
import {GatewayError,jsonSnapshot,type AppGatewayOperation} from '../gateway/model.js';
const id=z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64);
export const appCallInput=z.object({appId:id,apiId:id,input:z.unknown().refine(v=>v!==undefined)}).strict();
export type PublishedInterface={appId:string;appName:string;version:string;revision:number;accessKey?:string;apiId:string;permission:string;expose:AppApiExposure;consumers?:string[]};
export interface AppInterfaceBackend {
 catalog(personId:string,appId?:string,channel?:'apps'|'developer'):Promise<PublishedInterface[]>;
 invoke(personId:string,appId:string,apiId:string,input:unknown,signal?:AbortSignal):Promise<unknown>;
 assertDependency(source:string,target:string,apiId:string,personId:string):Promise<void>;
}
/** Same catalog and business handler for browser, development keys and installed applications. */
export class AppInterfaces {
 constructor(private readonly backend:AppInterfaceBackend){}
 catalog(personId:string){return this.backend.catalog(personId);}
 /** Documentation discovery includes app-only interfaces. It never grants execution through a personal key. */
 async describe(personId:string){return (await this.backend.catalog(personId,undefined,'apps')).map(({accessKey,revision,...entry})=>entry);}
 async call(personId:string,value:unknown,signal?:AbortSignal,source?:string){
  const p=appCallInput.parse(value);
  if(source)await this.backend.assertDependency(source,p.appId,p.apiId,personId);
  const entry=(await this.backend.catalog(personId,p.appId,source?'apps':'developer')).find(e=>e.appId===p.appId&&e.apiId===p.apiId);
  if(!entry)throw new GatewayError('ACCESS_DENIED',403);
  const input=jsonSnapshot(p.input,60*1024);
  if(!matchesAppContract(entry.expose.documentation.input,input))throw new GatewayError('INVALID_PARAMS');
  const response=jsonSnapshot(await this.backend.invoke(personId,p.appId,p.apiId,input,signal),256*1024);
  if(!response||typeof response!=='object'||Array.isArray(response)||!('ok' in response)||response.ok!==true||!('result' in response))throw new GatewayError('GATEWAY_FAILED',502);
  if(!matchesAppContract(entry.expose.documentation.output,response.result))throw new GatewayError('INVALID_RESULT',502);
  // Do not release a result after an application upgrade, account/role revocation or dependency change.
  const fresh=(await this.backend.catalog(personId,p.appId,source?'apps':'developer')).find(e=>e.appId===p.appId&&e.apiId===p.apiId);
  if(!fresh||JSON.stringify(fresh)!==JSON.stringify(entry))throw new GatewayError('ACCESS_DENIED',403);
  if(source)await this.backend.assertDependency(source,p.appId,p.apiId,personId);
  return response.result;
 }
 operation():AppGatewayOperation {
  return {name:'platform.apps.call',permissionCode:'platform.apps.read',mode:'read',validateParams:v=>appCallInput.safeParse(v).success,
   resolveResources:async c=>{if(!c.employeeActor||c.actorType!=='service')throw new GatewayError('ACCESS_DENIED',403);return [{}];},
   execute:async(c,v,signal)=>{if(!c.employeeActor||c.actorType!=='service')throw new GatewayError('ACCESS_DENIED',403);return this.call(c.employeeActor.person.id,v,signal,c.execution.appId);},
   validateResult:()=>true,auditMetadata:v=>{const p=appCallInput.parse(v);return {targetAppId:p.appId,targetApiId:p.apiId};}};
 }
}
