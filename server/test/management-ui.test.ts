import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readInstalledAdminUi} from '../src/app-platform/management/ui.ts';
import type {PlatformManagementContext} from '../src/platform/context/index.ts';
import type {AppInstallation} from '../src/app-platform/registry/index.ts';
const context={actorType:'administrator',administrator:{id:'a'},execution:{type:'platform'},authorize:async()=>({allowed:true})} as unknown as PlatformManagementContext;
const script='document.getElementById("app").textContent="signed"';
const manifest={id:'sample',name:'Sample',ui:{mode:'sandbox',entryArtifactId:'entry'},api:[],routes:[{path:'/'}],artifacts:[{id:'entry',bytes:Buffer.byteLength(script),sha256:createHash('sha256').update(script).digest('hex')}]};
const installation={id:'id',appId:'sample',revision:1,enabled:true,manifest} as unknown as AppInstallation;
const options={context,appId:'sample',path:'/',origin:'http://127.0.0.1:3000',readArtifact:async()=>Buffer.from(script),host:{status:async()=>({installation,serving:true,owned:true})}};
test('installed UI verifies immutable bytes and rejects unconfigured production origin',async()=>{
 const result=await readInstalledAdminUi(options);assert.equal(result.resource.mode,'local-demo');assert.match(result.resource.html,/Content-Security-Policy/);
 await assert.rejects(readInstalledAdminUi({...options,readArtifact:async()=>Buffer.from('tampered')}),/INVALID_ARTIFACT/);
 await assert.rejects(readInstalledAdminUi({...options,origin:'https://platform.example'}),/RESOURCE_ORIGIN_NOT_CONFIGURED/);
 await assert.rejects(readInstalledAdminUi({...options,path:'/other'}),/ROUTE_NOT_FOUND/);
});
test('disabled/revised application cannot hand out a UI after artifact IO',async()=>{
 let calls=0;
 await assert.rejects(readInstalledAdminUi({...options,host:{status:async()=>({installation:{...installation,revision:++calls},serving:true,owned:true})}}),/NOT_SERVING/);
 await assert.rejects(readInstalledAdminUi({...options,host:{status:async()=>({installation,serving:false,owned:false})}}),/NOT_SERVING/);
});
test('administrator preview preserves the route and marks employee-only business apps',async()=>{
 const current={...installation,manifest:{...installation.manifest,routes:[{id:'settings',path:'/settings'}],api:[{id:'settings',method:'POST' as const,path:'/settings',handler:'settings',businessPermission:'app.sample.config'}]}};
 const result=await readInstalledAdminUi({...options,path:'/settings',host:{status:async()=>({installation:current,serving:true,owned:true})}});
 assert.equal(result.requiresEmployee,true);
 assert.match(result.resource.html!,/data-app-route="%2Fsettings"/);
});
