import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AppRegistryService,PostgresAppRegistryRepository,APP_REGISTRY_SQL} from '../src/app-platform/registry/index.ts';
import {PostgresInstallJournal,APP_INSTALL_SQL} from '../src/app-platform/install/journal.ts';
import {AppVersionService,PostgresAppVersionJournal,APP_VERSION_SQL,createVersionedArtifactReader} from '../src/app-platform/install/version-service.ts';
import {signAppDirectory} from '../src/app-platform/developer/signature.ts';
import {prepareAppInstallation} from '../src/app-platform/developer/install-preparation.ts';
import type {AppManifest} from '../src/app-platform/manifest/index.ts';
import type {PlatformAdministratorContext} from '../src/platform/context/index.ts';
const ctx:PlatformAdministratorContext={actorType:'administrator',administrator:{id:'10000000-0000-4000-8000-000000000001',username:'admin',displayName:'Admin'},execution:{type:'platform'},request:{requestId:'r',traceId:'r',startedAt:new Date().toISOString()},authorize:async permissionCode=>({id:'a',allowed:true,permissionCode,subjectType:'administrator',reasonCode:'allowed',effectiveScopes:[],decidedAt:new Date().toISOString()})};
test('signed upgrades bind version bytes, reject tampering and keep unknown work blocked until explicit recovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'afc-versions-'));const db=new PGlite();
 try{
 await db.exec(APP_REGISTRY_SQL);await db.exec(APP_INSTALL_SQL);await db.exec(APP_VERSION_SQL);
 const client={query:(sql:string,values?:readonly unknown[])=>db.query(sql,[...(values??[])])};
 const registry=new AppRegistryService(new PostgresAppRegistryRepository(client),{host:()=>({platformVersion:'0.0.1',capabilities:[],applications:[]}),authorization:{listPermissions:async()=>[]}});
 const installs=new PostgresInstallJournal(client),journal=new PostgresAppVersionJournal(client);
 const pair=generateKeyPairSync('ed25519');const privateFile=join(root,'private.pem');await writeFile(privateFile,pair.privateKey.export({format:'pem',type:'pkcs8'}));
 const policy={policyVersion:'1.0',revision:1,keys:[{keyId:'test',publisherId:'test',publicKeyPem:pair.publicKey.export({format:'pem',type:'spki'}),revoked:false,appIds:['sample'],validFrom:'2020-01-01T00:00:00Z',validUntil:'2099-01-01T00:00:00Z'}]};
 async function pack(version:string){const directory=join(root,version);await mkdir(directory);const bytes=Buffer.from(`console.log('${version}')`);await writeFile(join(directory,'entry.js'),bytes);
 const manifest:AppManifest={manifestVersion:'1.0',id:'sample',name:'Sample',description:'test',version,publisherId:'test',compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},ui:{mode:'sandbox',entryArtifactId:'entry'},backend:{mode:'none'},storage:{mode:'none'},permissions:{requested:[],defined:[]},routes:[{id:'home',path:'/'}],navigation:[],api:[],events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts:[{id:'entry',kind:'frontend',path:'entry.js',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));const signatureFile=join(root,version+'.sig');await signAppDirectory(directory,'test',privateFile,signatureFile);return {directory,signatureFile,manifest,bytes};}
 const one=await pack('1.0.0'),two=await pack('1.1.0'),three=await pack('1.2.0');
 const initial=await registry.register(ctx,one.manifest);const prepared=await prepareAppInstallation({...one,context:ctx,artifactRoot:join(root,'bundles'),loadPublisherPolicy:async()=>policy});
 await installs.insert({appId:'sample',requestId:'first-install-0001',installationId:initial.id,revision:1,state:'installed',prepared,actorId:ctx.administrator.id,updatedAt:new Date().toISOString()});
 const read=createVersionedArtifactReader(installs,journal);let calls=0,fail=false;
 const host={status:async()=>({installation:await registry.get(ctx,'sample'),owned:false,serving:false}),recover:async()=>registry.get(ctx,'sample'),execute:async(_context:unknown,input:{revision:number;action:unknown;targetManifest?:unknown})=>{calls++;if(fail)throw Error('lost response');const target=input.targetManifest as AppManifest;assert.deepEqual(await read(target,'entry',target.artifacts[0].bytes),target.version==='1.1.0'?two.bytes:three.bytes);const started=await registry.beginLifecycle(ctx,'sample',input.revision,'upgrade',target);return registry.settleLifecycle(ctx,'sample',started.revision,started.lifecycle!.operationId,'completed');}};
 const service=new AppVersionService({registry,journal,installJournal:installs,artifactRoot:join(root,'versions'),loadPublisherPolicy:async()=>policy,approve:async()=>true,getHost:async()=>host});
 const input={...two,appId:'sample',revision:initial.revision,requestId:'upgrade-request-0001'};
 const done=await service.update(ctx,input);assert.equal(done.state,'updated');assert.equal((await registry.get(ctx,'sample')).enabled,false);
 assert.deepEqual(await service.update(ctx,input),done);assert.equal(calls,1);
 const current=await registry.get(ctx,'sample');
 await writeFile(join(three.directory,'entry.js'),'tampered');await assert.rejects(service.update(ctx,{...three,appId:'sample',revision:current.revision,requestId:'upgrade-tampered-01'}));assert.equal(calls,1);await writeFile(join(three.directory,'entry.js'),three.bytes);
 fail=true;await assert.rejects(service.update(ctx,{...three,appId:'sample',revision:current.revision,requestId:'upgrade-unknown-01'}),/RECOVERY_REQUIRED/);assert.equal(calls,2);
 await assert.rejects(service.assertActivationAllowed(ctx,'sample'),/RECOVERY_REQUIRED/);
 await assert.rejects(service.update(ctx,{...three,appId:'sample',revision:current.revision,requestId:'upgrade-second-001'}),/RECOVERY_REQUIRED/);assert.equal(calls,2);
 await service.recover(ctx,'sample','upgrade-unknown-01');await service.assertActivationAllowed(ctx,'sample');assert.equal(calls,2);
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
