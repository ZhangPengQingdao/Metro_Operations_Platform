import {AppLifecycleHost,type AppLifecycleHostOptions} from './lifecycle-host.js';
import {AppDockerTransport} from './docker-transport.js';
import {AppDockerExecutor,type AppDockerImageApproval} from './docker-executor.js';
import {AppDockerJournal} from './docker-journal.js';
import type {QueryableClient} from '../../core/database/index.js';
export function createAppRuntimeComposition(options:Omit<AppLifecycleHostOptions,'appId'|'docker'> & {docker?:{socketPath:string;runtimeImage:string;approval:AppDockerImageApproval;client:QueryableClient}}){
 const hosts=new Map<string,AppLifecycleHost>();let closed=false;
 const {docker,...shared}=options;
 const adapter=docker?{socketPath:docker.socketPath,runtimeImage:docker.runtimeImage,approval:docker.approval,executor:new AppDockerExecutor(new AppDockerTransport({socketPath:docker.socketPath})),journal:new AppDockerJournal(docker.client)}:undefined;
 return {
  // Public ingress must never allocate hosts from caller-supplied application IDs.
  findHost(appId:string){return closed?undefined:hosts.get(appId);},
  async getHost(appId:string){
   if(closed)throw Error('APP_RUNTIME_CLOSED');
   if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(appId)||appId.length>64)throw Error('INVALID_APP_ID');
   let host=hosts.get(appId);if(!host){host=new AppLifecycleHost({...shared,appId,...(adapter?{docker:adapter}:{})});hosts.set(appId,host);}return host;
  },
  async close(){closed=true;for(const host of hosts.values())await host.close();hosts.clear();},
 };
}
