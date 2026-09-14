import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {validateAppDirectory} from '../src/app-platform/developer/package.ts';
import {stageAppArtifacts,compileAppDockerPolicy,AppDockerTransport,AppDockerExecutor,attachAppDocker,startAppStdioGateway,type AppStdioGatewaySession} from '../src/app-platform/runtime/index.ts';
import type {AppInstallation} from '../src/app-platform/registry/index.ts';

const socketPath=process.env.AFC_DOCKER_TEST_SOCKET,image=process.env.AFC_DOCKER_TEST_IMAGE,root=process.env.AFC_DOCKER_TEST_ROOT;
test('packaged public SDK backend runs in isolated Docker and serves the standard host API',{
 skip:!socketPath||!image||!root,timeout:60_000,
},async()=>{
 const directory=new URL('../../examples/backend-sdk/dist/',import.meta.url);
 const {fileURLToPath}=await import('node:url');
 const {manifest}=await validateAppDirectory(fileURLToPath(directory));
 const installation:AppInstallation={id:randomUUID(),appId:manifest.id,manifest,revision:1,enabled:false,serviceIdentityId:null,grants:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 const transport=new AppDockerTransport({socketPath:socketPath!});const executor=new AppDockerExecutor(transport);
 const inspected=await transport.inspectImage(image!);assert.ok(inspected);const approval={imageId:inspected.Id,config:inspected.Config};
 const stage=await mkdtemp(join(root!,'.afc-backend-test-'));
 const bundle=await stageAppArtifacts({root:stage,manifest,read:async id=>readFile(new URL(manifest.artifacts.find(a=>a.id===id)!.path,directory))});
 const policy=compileAppDockerPolicy({installation,operationId:randomUUID(),runtimeImage:image!,verifiedBundlePath:bundle.path,network:'none',gateway:'stdio'});
 let identity=policy.name;let confirmed=false;let bridge:AppStdioGatewaySession|undefined;
 try {
  const created=await executor.create(policy,approval);identity=created.Id;
  const attachment=await attachAppDocker({socketPath:socketPath!,executor,policy,approval,containerId:identity});
  bridge=startAppStdioGateway({appId:manifest.id,serviceCredential:'host-only-credential',stdin:attachment.stdin,stdout:attachment.stdout,gateway:{invokeService:async()=>{throw Error('Unexpected Gateway call');},drain:async()=>{}}});
  await executor.start(policy,approval,identity);
  const deadline=Date.now()+20_000;
  for(;;){const current=await executor.observe(policy,approval,identity);if((current?.State.Health as {Status?:string})?.Status==='healthy')break;assert.ok(Date.now()<deadline,'health timeout');await pause(100);}
  const current=await executor.observe(policy,approval,identity);assert.ok(current);
  assert.equal(current.Config.User,'1000:1000');assert.equal(current.HostConfig.NetworkMode,'none');assert.equal(current.HostConfig.ReadonlyRootfs,true);
  assert.equal(JSON.stringify(current.Config.Env).includes('host-only-credential'),false);assert.equal(current.HostConfig.Memory,128*1024*1024);
  const result=await bridge.api.invoke({handler:'echo',method:'POST',path:'/echo',payload:{message:'packaged backend'}});
  assert.equal((result as {message:string}).message,'packaged backend');
  await executor.stop(policy,approval,identity);bridge.api.confirmContainerStopped();await bridge.stop();
  assert.equal((await executor.observe(policy,approval,identity))?.State.ExitCode,0);
  await executor.remove(policy,approval,identity);confirmed=true;assert.equal(await transport.inspectContainer(identity),null);
 }finally{
  if(!confirmed){const current=await transport.inspectContainer(identity);if(current){await executor.stop(policy,approval,current.Id);bridge?.api.confirmContainerStopped();await executor.remove(policy,approval,current.Id);confirmed=true;}}
  if(confirmed){bridge?.api.confirmContainerStopped();if(bridge)await bridge.stop();await rm(stage,{recursive:true,force:true});}
 }
});
