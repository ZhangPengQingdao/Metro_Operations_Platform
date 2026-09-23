import type {AppInstallation} from '../registry/index.js';
import type {TrustedActorIdentity} from '../../core/identity/index.js';
import {isDeepStrictEqual} from 'node:util';

export interface EmployeeAppSession {
 identity:TrustedActorIdentity;
 access:{installationId:string;revision:string};
 installation:AppInstallation;
}

/** Short-lived, process-local admission snapshot. Authentication is still checked by the caller. */
export class EmployeeAppSessions {
 private readonly entries=new Map<string,{value:EmployeeAppSession;expires:number}>();
 private readonly pending=new Map<string,{identity:TrustedActorIdentity;request:Promise<EmployeeAppSession>}>();
 private generation=0;
 constructor(private readonly ttlMs=30_000,private readonly limit=512){}

 async get(identity:TrustedActorIdentity,appId:string,load:()=>Promise<EmployeeAppSession>):Promise<EmployeeAppSession>{
  const key=`${identity.userId}:${appId}`,now=Date.now(),entry=this.entries.get(key);
  if(entry&&entry.expires>now&&isDeepStrictEqual(entry.value.identity,identity)){
   this.entries.delete(key);this.entries.set(key,entry);
   return entry.value;
  }
  if(entry)this.entries.delete(key);
  const inFlight=this.pending.get(key);
  if(inFlight&&isDeepStrictEqual(inFlight.identity,identity))return inFlight.request;
  const generation=this.generation;
  const request=load().then(value=>{
   if(this.generation!==generation)return this.get(identity,appId,load);
   if(this.pending.get(key)?.request===request&&isDeepStrictEqual(value.identity,identity)){
    this.entries.set(key,{value,expires:Date.now()+this.ttlMs});
    if(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);
   }
   return value;
  }).finally(()=>{if(this.pending.get(key)?.request===request)this.pending.delete(key);});
  this.pending.set(key,{identity,request});
  return request;
 }

 clear(){this.generation++;this.entries.clear();this.pending.clear();}
}
