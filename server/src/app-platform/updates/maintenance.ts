import {z} from 'zod';
import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {AppInstallation} from '../registry/model.js';
export interface MaintenanceEntry {appId:string;installationId:string;version:string;revision:number;enabled:boolean;serving:boolean;phase:'unchanged'|'stopping'|'stopped'|'starting'|'restored';error?:string}
export interface MaintenanceSnapshot {format:1;taskId:string;actorId:string;phase:'draining'|'paused'|'restoring'|'completed'|'blocked';applications:MaintenanceEntry[]}
export interface MaintenanceAdapter {
 list():Promise<AppInstallation[]>;
 status(appId:string):Promise<{installation:AppInstallation;serving:boolean}>;
 gate(closed:boolean):void;
 drain(appId:string):Promise<void>;
 change(appId:string,revision:number,action:'enable'|'disable'):Promise<AppInstallation>;
}
const snapshotSchema=z.object({format:z.literal(1),taskId:z.string().uuid(),actorId:z.string().uuid(),phase:z.enum(['draining','paused','restoring','completed','blocked']),applications:z.array(z.object({appId:z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64),installationId:z.string().uuid(),version:z.string().max(128),revision:z.number().int().positive(),enabled:z.boolean(),serving:z.boolean(),phase:z.enum(['unchanged','stopping','stopped','starting','restored']),error:z.string().optional()}).strict()).max(1000)}).strict();
export async function saveMaintenance(path:string,value:MaintenanceSnapshot){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp';const file=await open(temp,'w',0o600);
 try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
 await rename(temp,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
/** Durable per-application intent is written before every lifecycle operation. Unknown outcomes
 * remain blocked; startup never repeats a stop/start merely because its acknowledgement was lost. */
export class PlatformMaintenance {
 private snapshot?:MaintenanceSnapshot;
 private busy=false;
 constructor(private readonly adapter:MaintenanceAdapter,private readonly path:string){}
 async initialize(){try{this.snapshot=snapshotSchema.parse(JSON.parse(await readFile(this.path,'utf8')));if(new Set(this.snapshot.applications.map(e=>e.appId)).size!==this.snapshot.applications.length)throw Error('INVALID_MAINTENANCE_STATE');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}this.adapter.gate(this.active);}
 get active(){return !!this.snapshot&&this.snapshot.phase!=='completed';}
 status(){return this.snapshot?structuredClone(this.snapshot):null;}
 private async persist(){await saveMaintenance(this.path,this.snapshot!);}
 private match(entry:MaintenanceEntry,record:AppInstallation){if(record.id!==entry.installationId||record.manifest.version!==entry.version||record.revision!==entry.revision)throw Error('MAINTENANCE_INSTALLATION_CHANGED');}
 async prepare(taskId:string,actorId:string){
  if(this.busy)throw Error('MAINTENANCE_BUSY');
  if(this.active){if(this.snapshot?.taskId!==taskId||this.snapshot.actorId!==actorId)throw Error('MAINTENANCE_TASK_CONFLICT');return this.status();}
  this.busy=true;this.adapter.gate(true);
  try{
   const records=await this.adapter.list();
   const applications:MaintenanceEntry[]=[];
   for(const record of records){const status=await this.adapter.status(record.appId);applications.push({appId:record.appId,installationId:record.id,version:record.manifest.version,revision:record.revision,enabled:record.enabled,serving:status.serving,phase:'unchanged'});}
   this.snapshot={format:1,taskId,actorId,phase:'draining',applications};await this.persist();
   for(const entry of applications){
    if(!entry.enabled)continue;
    if(!entry.serving)throw Error('ENABLED_APPLICATION_NOT_SERVING: '+entry.appId);
    await this.adapter.drain(entry.appId);
    this.match(entry,(await this.adapter.status(entry.appId)).installation);
    entry.phase='stopping';await this.persist();
    const stopped=await this.adapter.change(entry.appId,entry.revision,'disable');
    entry.revision=stopped.revision;entry.phase='stopped';await this.persist();
   }
   this.snapshot.phase='paused';await this.persist();return this.status();
  }catch(error){if(this.snapshot){this.snapshot.phase='blocked';await this.persist();}else this.adapter.gate(false);throw error;}
  finally{this.busy=false;}
 }
 async restore(taskId:string){
  if(this.busy)throw Error('MAINTENANCE_BUSY');
  if(!this.snapshot||this.snapshot.taskId!==taskId)throw Error('MAINTENANCE_TASK_CONFLICT');
  if(this.snapshot.phase==='completed')return this.status();
  if(this.snapshot.applications.some(e=>['starting','stopping'].includes(e.phase)))throw Error('MAINTENANCE_OUTCOME_UNKNOWN');
  this.busy=true;
  try{
   this.snapshot.phase='restoring';await this.persist();
   for(const entry of this.snapshot.applications){
    const current=await this.adapter.status(entry.appId);this.match(entry,current.installation);
    if(entry.phase==='unchanged'){if(current.installation.enabled!==entry.enabled||current.serving!==entry.serving)throw Error('MAINTENANCE_ORIGINAL_STATE_LOST');continue;}
    if(!entry.enabled||!entry.serving)throw Error('MAINTENANCE_STATE_CONFLICT');
    if(entry.phase==='restored'){if(!current.serving)throw Error('MAINTENANCE_RESTORED_HOST_LOST');continue;}
    if(entry.phase!=='stopped'||current.installation.enabled)throw Error('MAINTENANCE_STATE_CONFLICT');
    entry.phase='starting';await this.persist();
    const restored=await this.adapter.change(entry.appId,entry.revision,'enable');
    entry.revision=restored.revision;entry.phase='restored';await this.persist();
   }
   this.snapshot.phase='completed';await this.persist();this.adapter.gate(false);return this.status();
  }catch(error){this.snapshot.phase='blocked';await this.persist();throw error;}finally{this.busy=false;}
 }
}
