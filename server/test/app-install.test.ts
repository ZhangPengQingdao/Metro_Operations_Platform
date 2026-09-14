import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {AppRegistryService,MemoryAppRegistryRepository,PostgresAppRegistryRepository,APP_REGISTRY_SQL} from '../src/app-platform/registry/index.ts';
import {MemoryInstallJournal,PostgresInstallJournal,APP_INSTALL_SQL} from '../src/app-platform/install/journal.ts';
import {AppInstaller} from '../src/app-platform/install/service.ts';
import {AppLifecycleHost} from '../src/app-platform/runtime/lifecycle-host.ts';
import {AppExtensionRegistry} from '../src/app-platform/extensions/registry.ts';
import {createInstalledArtifactReader} from '../src/app-platform/install/artifact-reader.ts';
import {registerAppInstallRoutes} from '../src/app-platform/install/routes.ts';
import {encodeInstallPackage,withInstallUpload} from '../src/app-platform/install/wire.ts';
import {callInstallEndpoint} from '../src/app-platform/install/client.ts';
import {signAppDirectory} from '../src/app-platform/developer/signature.ts';
import type {PlatformActorContext} from '../src/platform/context/index.ts';
import type {AppGateway} from '../src/app-platform/gateway/gateway.ts';

async function fixture(mode:'trusted'|'sandbox',run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,postgres=false){const f=await setup(mode,postgres);try{await run(f);}finally{await f.close();}}
async function setup(mode:'trusted'|'sandbox',postgres=false){
 const root=await mkdtemp(join(tmpdir(),'afc-install-')),input=join(root,'input');await cp(new URL(`../../examples/app-sdk/dist/${mode}/`,import.meta.url),input,{recursive:true});
 const manifest=JSON.parse(await readFile(join(input,'manifest.json'),'utf8'));
 const keys=generateKeyPairSync('ed25519'),key=join(root,'private.pem'),sig=join(root,'signature.json');await writeFile(key,keys.privateKey.export({format:'pem',type:'pkcs8'}));await signAppDirectory(input,'release-key',key,sig);
 let allowed=true,approved=true,failRuntime=false,executions=0;
 const actor={actorType:'person',execution:{type:'platform'},person:{id:'42000000-0000-4000-8000-000000000002'},authorize:async()=>({allowed})} as unknown as PlatformActorContext;
 const db=postgres?new PGlite():null;if(db){await db.exec(APP_REGISTRY_SQL);await db.exec(APP_INSTALL_SQL);}
 const client=db?{query:async(sql:string,args?:readonly unknown[])=>db.query(sql,args?[...args]:undefined)}:null;
 const repository=client?new PostgresAppRegistryRepository(client):new MemoryAppRegistryRepository();const journal=client?new PostgresInstallJournal(client):new MemoryInstallJournal();
 const registry=new AppRegistryService(repository,{authorization:{listPermissions:async()=>[]},host:()=>({platformVersion:'0.0.1-alpha.51',capabilities:[],applications:[]})});
 const policy={policyVersion:'1.0',revision:1,keys:[{keyId:'release-key',publisherId:manifest.publisherId,publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),revoked:false,appIds:[manifest.id],validFrom:'2020-01-01T00:00:00Z',validUntil:'2099-01-01T00:00:00Z'}]};
 const hosts=new Map<string,AppLifecycleHost>();
 const extensionRegistry=new AppExtensionRegistry({getInstallation:async id=>repository.findByAppId(id),authorize:async()=>false,executeGateway:async()=>{throw Error('No business operations');}});
 const options={registry,journal,artifactRoot:join(root,'artifacts'),loadPublisherPolicy:async()=>policy,approve:async()=>approved,
  getHost:async(record:import('../src/app-platform/install/journal.ts').InstallRecord)=>{
   let host=hosts.get(record.installationId);if(!host){
    const connect=async()=>{const events=new EventEmitter();return Object.assign(events,{query:async(sql:string)=>sql.includes('platform_app_runtime_work')?{rows:[]}:sql.includes('pg_try_advisory_lock')?{rows:[{locked:true}]}:{rows:[{held:true}]},end:async()=>{events.emit('end');}});};
    host=new AppLifecycleHost({appId:record.appId,registry,gateway:{drain:async()=>{}} as unknown as AppGateway,connectLease:connect,artifactRoot:join(root,'runtime'),readArtifact:createInstalledArtifactReader(record),extensions:{registry:extensionRegistry,mappings:[{kind:'route',id:'home',permissionCode:'sample.greeting.read'}],options:()=>({bus:{subscribe:()=>({unsubscribe(){}})},resolveActor:async()=>{if(actor.actorType!=='person')throw Error('Expected test person');return {...actor,execution:{type:'application' as const,appId:record.appId}};}})}});hosts.set(record.installationId,host);
   }
   return {status:host.status.bind(host),recover:host.recover.bind(host),execute:async(...args:Parameters<AppLifecycleHost['execute']>)=>{executions++;if(failRuntime)throw Error('runtime unavailable');return host!.execute(...args);}};
  }};
 const installer=new AppInstaller(options);
 return {root,input,sig,manifest,actor,policy,registry,journal,installer,options,repository,db,setAllowed:(v:boolean)=>allowed=v,setApproved:(v:boolean)=>approved=v,setFail:(v:boolean)=>failRuntime=v,get executions(){return executions;},close:async()=>{allowed=true;for(const [id,host]of hosts){const r=await repository.findByAppId(manifest.id);if(r&&r.id===id)await host.recover(actor,r.revision).catch(()=>{});}await db?.close();await rm(root,{recursive:true,force:true});}};
}
for(const mode of ['trusted','sandbox'] as const)test(`actual ${mode} lifecycle install binds artifacts, grants nothing and is idempotent`,async()=>fixture(mode,async f=>{
 const request={directory:f.input,signatureFile:f.sig,requestId:'installation-request-one'};
 const result=await f.installer.install(f.actor,request);assert.equal(result.state,'installed');assert.equal(f.executions,1);
 const record=await f.registry.get(f.actor,f.manifest.id);assert.equal(record.enabled,true);assert.equal(record.grants.length,0);assert.equal(record.lifecycle?.status,'completed');
 assert.equal((await f.installer.install(f.actor,request)).installationId,result.installationId);assert.equal(f.executions,1);
 await assert.rejects(f.installer.install(f.actor,{...request,requestId:'installation-request-two'}),/INSTALL_EXISTS/);
 const binding=await f.journal.get(f.manifest.id);assert.ok(binding);assert.deepEqual(await createInstalledArtifactReader(binding)(record.manifest,'entry',record.manifest.artifacts[0].bytes),await readFile(join(f.input,'entry.js')));
 await writeFile(join(f.input,'manifest.json'),JSON.stringify({...f.manifest,version:'1.0.1'}));await assert.rejects(f.installer.install(f.actor,request),/INSTALL_EXISTS/);
}));
test('failure is durable across service recreation; recovery disables without retrying install',async()=>fixture('sandbox',async f=>{
 f.setFail(true);const input={directory:f.input,signatureFile:f.sig,requestId:'installation-request-one'};
 await assert.rejects(f.installer.install(f.actor,input),/RECOVERY_REQUIRED/);
 const restarted=new AppInstaller(f.options);let status=await restarted.status(f.actor,f.manifest.id);assert.equal(status.state,'recovery_required');
 assert.equal((await restarted.install(f.actor,input)).state,'recovery_required');assert.equal(f.executions,1);
 status=await restarted.recover(f.actor,f.manifest.id,status.revision);assert.equal(status.state,'recovered');assert.equal((await f.registry.get(f.actor,f.manifest.id)).enabled,false);assert.equal(f.executions,1);
 await assert.rejects(restarted.recover(f.actor,f.manifest.id,1),/INSTALL_CONFLICT/);
},true));
test('native denial and platform approval reject before registration',async()=>fixture('trusted',async f=>{
 const input={directory:f.input,signatureFile:f.sig,requestId:'installation-request-one'};
 f.setAllowed(false);await assert.rejects(f.installer.install(f.actor,input),/INSTALL_ACCESS_DENIED/);
 f.setAllowed(true);f.setApproved(false);await assert.rejects(f.installer.install(f.actor,input),/INSTALL_POLICY_DENIED/);
 assert.equal(await f.repository.findByAppId(f.manifest.id),null);assert.equal(f.executions,0);
 f.setApproved(true);f.policy.keys[0].revoked=true;await assert.rejects(f.installer.install(f.actor,input),/UNTRUSTED_PUBLISHER_KEY/);
}));
test('identity registration rolls back if durable binding insert fails',async()=>fixture('trusted',async f=>{
 f.journal.insert=async()=>{throw Error('injected insert failure');};await assert.rejects(f.installer.install(f.actor,{directory:f.input,signatureFile:f.sig,requestId:'installation-request-one'}),/injected insert failure/);
 assert.equal(await f.repository.findByAppId(f.manifest.id),null);assert.equal(f.executions,0);
},true));
test('wire and native route deny identity override, bad encoding and bad origin',async()=>fixture('sandbox',async f=>{
 const payload=await encodeInstallPackage(f.input,f.sig,'installation-request-one');
 await assert.rejects(withInstallUpload({...payload,actor:{admin:true}},join(f.root,'upload'),async()=>{}),/INVALID_INSTALL_PACKAGE/);
 await assert.rejects(withInstallUpload({...payload,artifacts:[{...payload.artifacts[0],base64:'bad'}]},join(f.root,'upload'),async()=>{}),/INVALID_INSTALL_PACKAGE/);
 const app=Fastify();await registerAppInstallRoutes(app,{origin:'https://platform.example',uploadRoot:join(f.root,'upload'),installer:f.installer,resolveContext:async req=>{if(req.headers.authorization!=='fixture')throw Error();return f.actor;}});
 try{
  assert.equal((await app.inject({method:'POST',url:'/api/v1/app-installations',payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/app-installations',headers:{authorization:'fixture',origin:'https://wrong.example'},payload})).statusCode,403);
  const result=await app.inject({method:'POST',url:'/api/v1/app-installations',headers:{authorization:'fixture',origin:'https://platform.example'},payload});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().state,'installed');assert.deepEqual(await readdir(join(f.root,'upload')),[]);assert.ok(!result.body.includes(f.root));
 }finally{await app.close();}
}));
async function freePort(){const net=await import('node:net');const probe=net.createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as import('node:net').AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));return port;}
for(const mode of ['trusted','sandbox'] as const)test(`complete ${mode} CLI create/test/build/pack/sign/install/status workflow`,async()=>fixture(mode,async f=>{
 const app=Fastify(),token=join(f.root,'token');await writeFile(token,'local-test-token');const port=await freePort(),origin=`http://127.0.0.1:${port}`;
 await registerAppInstallRoutes(app,{origin,uploadRoot:join(f.root,'upload'),installer:f.installer,resolveContext:async req=>{if(req.headers.authorization!=='Bearer local-test-token')throw Error();return f.actor;}});await app.listen({host:'127.0.0.1',port});
 const cli=fileURLToPath(new URL('../src/app-platform/developer/cli.ts',import.meta.url));
 const run=(args:string[])=>new Promise<{code:number|null;output:string}>(resolve=>{const child=spawn(process.execPath,['--import','tsx',cli,...args]);let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('close',code=>resolve({code,output}));});
 try{
  const project=join(f.root,'generated'),bundle=join(f.root,'packed'),signature=join(f.root,'generated.signature.json');
  for(const args of [['create',project,f.manifest.id,mode,f.manifest.publisherId]]){const r=await run(args);assert.equal(r.code,0,r.output);}
  await symlink(fileURLToPath(new URL('../../node_modules',import.meta.url)),join(project,'node_modules'),'dir');
  const tested=await run(['test',project]);assert.equal(tested.code,0,tested.output);
  const built=await new Promise<number|null>(resolve=>{const child=spawn(process.execPath,[join(project,'build.mjs')],{stdio:'pipe'});child.on('close',resolve);});assert.equal(built,0);
  for(const args of [['validate',join(project,'dist',mode)],['pack',join(project,'dist',mode),bundle],['sign',bundle,'release-key',join(f.root,'private.pem'),signature]]){const r=await run(args);assert.equal(r.code,0,r.output);}
  const result=await run(['install',bundle,signature,origin,token,'installation-request-one']);assert.equal(result.code,0,result.output);assert.match(result.output,/"state":"installed"/);assert.ok(!result.output.includes('local-test-token'));
  const status=await run(['install-status',f.manifest.id,origin,token]);assert.equal(status.code,0,status.output);assert.equal(f.executions,1);
 }finally{await app.close();}
}));
test('client rejects mismatched success without replay',async()=>fixture('trusted',async f=>{
 const app=Fastify(),token=join(f.root,'token');await writeFile(token,'test');let calls=0;
 app.post('/api/v1/app-installations',async()=>{calls++;return {appId:'another-app',requestId:'installation-request-one',installationId:'42000000-0000-4000-8000-000000000002',revision:1,state:'installed'};});
 const address=await app.listen({host:'127.0.0.1',port:0});try{await assert.rejects(callInstallEndpoint(address,token,'/api/v1/app-installations',{manifest:{id:f.manifest.id},requestId:'installation-request-one'}),/INSTALL_OUTCOME_UNKNOWN/);assert.equal(calls,1);}finally{await app.close();}
}));

test('lost runtime acknowledgement remains recoverable, never replays successful install',async()=>fixture('trusted',async f=>{
 const base=f.options.getHost;
 const installer=new AppInstaller({...f.options,getHost:async record=>{const host=await base(record);return {...host,execute:async(...args)=>{await host.execute(...args);throw Error('response lost');}};}});
 const input={directory:f.input,signatureFile:f.sig,requestId:'installation-request-one'};
 await assert.rejects(installer.install(f.actor,input),/RECOVERY_REQUIRED/);
 assert.equal((await f.registry.get(f.actor,f.manifest.id)).enabled,true);
 assert.equal((await installer.install(f.actor,input)).state,'recovery_required');assert.equal(f.executions,1);
 const status=await installer.status(f.actor,f.manifest.id);assert.equal((await installer.recover(f.actor,f.manifest.id,status.revision)).state,'recovered');assert.equal((await f.registry.get(f.actor,f.manifest.id)).enabled,false);
}));
test('concurrent first-install requests bind at most one identity and execute once',async()=>fixture('sandbox',async f=>{
 const input={directory:f.input,signatureFile:f.sig,requestId:'installation-request-one'};
 const result=await Promise.allSettled([f.installer.install(f.actor,input),f.installer.install(f.actor,{...input,requestId:'installation-request-two'})]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.executions,1);assert.equal((await f.installer.status(f.actor,f.manifest.id)).state,'installed');
}));
