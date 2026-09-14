import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {admitMcpView} from '../src/app-platform/mcp-apps/admission.ts';
import {assertPlatformMcpToolContribution, PLATFORM_MCP_TOOL_CATALOG, type PlatformMcpToolContribution, type PlatformMcpToolResult} from '../src/platform/mcp/index.ts';
import type {AppInstallation} from '../src/app-platform/registry/index.ts';
import {readInstalledMcpView,McpViewResourceCache} from '../src/app-platform/mcp-apps/resource-reader.ts';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {McpServer} from '@modelcontextprotocol/server';
import {openInstalledMcpView} from '../src/app-platform/mcp-apps/installed-session.ts';
import {AppExtensionRegistry} from '../src/app-platform/extensions/index.ts';
import type {PlatformActorContext} from '../src/platform/context/index.ts';
import {decideMcpViewPolicy,emptyMcpViewPolicy,mcpViewPolicyHeaders} from '../src/app-platform/mcp-apps/policy.ts';
async function fixture(){
 const manifest=JSON.parse(await readFile(new URL('../../examples/app-sdk/dist/sandbox/manifest.json',import.meta.url),'utf8'));
 const html='<!doctype html><html><body>Conformance</body></html>',sha256=createHash('sha256').update(html).digest('hex');
 manifest.backend={mode:'external',origin:'https://conformance.example'};
 manifest.compatibility.capabilities=[{id:'platform-mcp',contractVersion:'2.0'}];
 manifest.tools=[{name:'fixtureecho',contributionArtifactId:'tools',uiResourceId:'view'}];manifest.resources=[{id:'view',kind:'mcp-ui',artifactId:'view'}];
 manifest.artifacts.push({id:'tools',kind:'mcp-contribution',path:'tools.json',bytes:2,sha256:'a'.repeat(64)},{id:'view',kind:'resource',path:'view.html',bytes:Buffer.byteLength(html),sha256});
 const installation:AppInstallation={id:'test-installation',appId:manifest.id,revision:1,manifest,enabled:true,grants:[],serviceIdentityId:null,createdAt:'2026-09-14T00:00:00Z',updatedAt:'2026-09-14T00:00:00Z'};
 const uri=`ui://app/${manifest.id}/view/1.html`;
 let calls=0;
 const result:PlatformMcpToolResult={resultType:'complete',content:[{type:'text',text:'Existing tool result'}]};
 const contribution:PlatformMcpToolContribution={id:'app:fixture',contractVersion:'2.0',tools:[{...structuredClone(PLATFORM_MCP_TOOL_CATALOG[0]),name:'fixtureecho',owner:{type:'application',id:manifest.id},_meta:{ui:{resourceUri:uri}}}],resources:[{owner:{type:'application',id:manifest.id},uri,name:'view',mimeType:'text/html;profile=mcp-app',html,sha256}],callTool:async()=>{calls++;return result;}};
 return {installation,contribution,result,get calls(){return calls;}};
}
test('installed MCP view binds declared HTML bytes and never replays completed tool',async()=>{
 const f=await fixture();const options={appId:f.installation.appId,contribution:f.contribution,getInstallation:async()=>f.installation,authorize:async()=>true};
 assertPlatformMcpToolContribution(f.contribution);
 const {validateAppManifest}=await import('../src/app-platform/manifest/index.ts');
 assert.equal(validateAppManifest(f.installation.manifest).ok,true,JSON.stringify(validateAppManifest(f.installation.manifest)));
 const view=await admitMcpView(options,'fixtureecho',f.result);assert.equal(view.kind,'resource');assert.equal(f.calls,0);
 if(view.kind==='resource'){assert.equal(view.revision,1);assert.notEqual(view.resource,f.contribution.resources![0]);}
 f.installation.enabled=false;const denied=await admitMcpView(options,'fixtureecho',f.result);assert.equal(denied.kind,'text');assert.deepEqual(denied.result,f.result);assert.equal(f.calls,0);
});
test('changed version, hash and revoked authorization preserve text',async()=>{
 const f=await fixture();let reads=0;
 const base={appId:f.installation.appId,contribution:f.contribution,getInstallation:async()=>f.installation,authorize:async()=>true};
 assert.equal((await admitMcpView({...base,getInstallation:async()=>++reads===1?f.installation:{...f.installation,revision:2}},'fixtureecho',f.result)).kind,'text');
 assert.equal((await admitMcpView({...base,authorize:async()=>false},'fixtureecho',f.result)).kind,'text');
 f.contribution.resources![0].html+='changed';assert.equal((await admitMcpView(base,'fixtureecho',f.result)).kind,'text');assert.equal(f.calls,0);
});

test('installed resource is read through official MCP resources/read without tool replay', async () => {
 const f=await fixture();
 const resource=f.contribution.resources![0];
 const server=new McpServer({name:'fixture',version:'1'});
 let reads=0;
 server.registerResource(resource.name,resource.uri,{mimeType:resource.mimeType},async()=>{
  reads++;return {contents:[{uri:resource.uri,mimeType:resource.mimeType,text:resource.html}]};
 });
 const client=new Client({name:'host',version:'1'});
 const [host,remote]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(remote);await client.connect(host);
  const view=await readInstalledMcpView({appId:f.installation.appId,contribution:f.contribution,
   getInstallation:async()=>f.installation,authorize:async()=>true,client},'fixtureecho',f.result);
  assert.equal(view.kind,'resource');assert.equal(reads,1);assert.equal(f.calls,0);
 } finally {await client.close();await server.close();}
});

test('resource read rejects altered content, metadata, extra entries and revoked installs', async () => {
 for(const mode of ['html','uri','mime','metadata','extra','disabled','revision','denied','error'] as const){
  const f=await fixture();const r=f.contribution.resources![0];let permitted=true;
  const client={readResource:async()=>{
   if(mode==='error')throw Error('offline');
   if(mode==='disabled')f.installation.enabled=false;
   if(mode==='revision')f.installation.revision++;
   if(mode==='denied')permitted=false;
   const item={uri:mode==='uri'?`${r.uri}?changed`:r.uri,mimeType:mode==='mime'?'text/html':r.mimeType,
    text:mode==='html'?`${r.html}changed`:r.html,...(mode==='metadata'?{_meta:{ui:{permissions:{camera:{}}}}}:{})};
   return {contents:mode==='extra'?[item,item]:[item]};
  }};
  const view=await readInstalledMcpView({appId:f.installation.appId,contribution:f.contribution,
   getInstallation:async()=>f.installation,authorize:async()=>permitted,client},'fixtureecho',f.result);
  assert.equal(view.kind,'text',mode);assert.deepEqual(view.result,f.result);assert.equal(f.calls,0);
 }
});

test('denied admission never starts a resource read', async()=>{
 const f=await fixture();let reads=0;
 const view=await readInstalledMcpView({appId:f.installation.appId,contribution:f.contribution,
  getInstallation:async()=>f.installation,authorize:async()=>false,
  client:{readResource:async()=>{reads++;return {contents:[]};}}},'fixtureecho',f.result);
 assert.equal(view.kind,'text');assert.equal(reads,0);
});

test('installed view calls use current Gateway grants and close on extension replacement',async()=>{
 const f=await fixture();const permission='app.fixture.use';
 f.installation.manifest.permissions.requested.push(permission);
 f.installation.manifest.routes=[];f.installation.manifest.navigation=[];
 f.installation.serviceIdentityId='fixture';
 let allowed=true,calls=0,resolutions=0;
 const actor:PlatformActorContext={actorType:'service',trustedIdentity:{source:'service'},execution:{type:'service',appId:f.installation.appId,serviceIdentityId:'fixture'},request:{requestId:'r',traceId:'t',startedAt:new Date().toISOString()},authorize:async()=>({allowed} as Awaited<ReturnType<PlatformActorContext['authorize']>>)};
 const registry=new AppExtensionRegistry({getInstallation:async()=>f.installation,authorize:async()=>allowed,executeGateway:async()=>{calls++;return f.result;}});
 const mappings=[{kind:'tool' as const,id:'fixtureecho',operation:'fixture.echo',permissionCode:permission}];
 const extension=registry.activate(f.installation,mappings);
 const r=f.contribution.resources![0];
 const view=await openInstalledMcpView({appId:f.installation.appId,contribution:f.contribution,getInstallation:async()=>f.installation,authorize:async()=>true,
  extension,resolveActor:async()=>{resolutions++;return actor;},client:{readResource:async()=>({contents:[{uri:r.uri,mimeType:r.mimeType,text:r.html}]})}},'fixtureecho',f.result);
 assert.equal(view.kind,'resource');if(view.kind!=='resource')return;
 await view.callTool('fixtureecho',{});assert.equal(calls,1);assert.equal(resolutions,1);
 await assert.rejects(view.callTool('otherapp',{}));assert.equal(calls,1);
 allowed=false;await assert.rejects(view.callTool('fixtureecho',{}));assert.equal(calls,1);
 allowed=true;registry.activate(f.installation,mappings);assert.equal(view.signal.aborted,true);
 await assert.rejects(view.callTool('fixtureecho',{}));assert.equal(calls,1);view.close();registry.deactivate(f.installation.appId);
});

test('network and device policy is the declared, installed, approved and host intersection',async()=>{
 const f=await fixture();f.installation.manifest.network.frontendOrigins=['https://allowed.example'];
 const approval=emptyMcpViewPolicy();approval.csp.connectDomains=['https://allowed.example','https://unlisted.example'];approval.permissions=['camera'];
 const host=structuredClone(approval);
 const decision=decideMcpViewPolicy(f.installation,{csp:{connectDomains:['https://allowed.example','https://unlisted.example']},permissions:{camera:{},microphone:{}}},{installationId:f.installation.id,revision:1,policy:approval},host);
 assert.deepEqual(decision.policy.csp.connectDomains,['https://allowed.example']);assert.deepEqual(decision.policy.permissions,['camera']);
 const headers=mcpViewPolicyHeaders(decision.policy,'https://platform.example');assert.match(headers.inner,/frame-src 'none'/);assert.match(headers.outer,/frame-src 'self'/);assert.match(headers.permissions,/microphone=\(\)/);
 assert.throws(()=>decideMcpViewPolicy(f.installation,undefined,{installationId:f.installation.id,revision:2,policy:approval},host));
 assert.throws(()=>mcpViewPolicyHeaders({...host,csp:{...host.csp,connectDomains:['https://*.example']}},'https://platform.example'));
});

test('static cache rechecks grants and invalidates with extension lifetime',async()=>{
 const f=await fixture();const controller=new AbortController(),cache=new McpViewResourceCache(controller.signal);let reads=0,allowed=true;
 const r=f.contribution.resources![0];const options={appId:f.installation.appId,contribution:f.contribution,cache,getInstallation:async()=>f.installation,authorize:async()=>allowed,client:{readResource:async()=>{reads++;return {contents:[{uri:r.uri,mimeType:r.mimeType,text:r.html}]};}}};
 await readInstalledMcpView(options,'fixtureecho',f.result);await readInstalledMcpView(options,'fixtureecho',f.result);assert.equal(reads,1);
 allowed=false;assert.equal((await readInstalledMcpView(options,'fixtureecho',f.result)).kind,'text');assert.equal(reads,1);
 allowed=true;controller.abort();await readInstalledMcpView(options,'fixtureecho',f.result);assert.equal(reads,2);
});
