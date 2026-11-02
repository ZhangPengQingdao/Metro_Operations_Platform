import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppHostV2} from '../src/app-platform/v2/host.ts';
import {AppInterfaces,type PublishedInterface} from '../src/app-platform/developer/app-interfaces.ts';
import {AppGateway} from '../src/app-platform/gateway/gateway.ts';
import {GatewayError} from '../src/app-platform/gateway/model.ts';

test('real source and target child processes preserve target employee scopes, audit routing and block writes/nested calls',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mop-cross-app-')),person=randomUUID(),org=randomUUID(),otherOrg=randomUUID();
 let targetAllowed=true,dependency=true,targetEnabled=true,writeCount=0;
 const audit:any[]=[],received:any[]=[];
 const expose={mode:'read' as const,title:'查询',documentation:{description:'按目标员工范围查询',input:{type:'object' as const,properties:{action:{type:'string' as const}},required:['action'],additionalProperties:false},output:{type:'object' as const},examples:[{title:'读取',params:{action:'read'},result:{}}],errors:[]}};
 const record=(appId:string,open=false):any=>({id:randomUUID(),appId,revision:1,enabled:true,serviceIdentityId:randomUUID(),manifest:{backend:{mode:'isolated'},permissions:{defined:[{code:`app.${appId}.read`}]},api:[{id:'query',handler:'query',method:'POST',path:'/query',permission:`app.${appId}.read`,businessPermission:`app.${appId}.read`}]},runtime:{model:'v2',sha256:'fixture',manifest:{api:[{id:'query',permission:'read',...(open?{expose}:{})}],limits:{timeoutSeconds:3}}}});
 const sourceRecord=record('source'),targetRecord=record('target',true);
 for(const id of ['source','target'])await mkdir(join(directory,id));
 await writeFile(join(directory,'source','server.js'),`export default {kind:'mop-server',version:1,hooks:{},handlers:{query:async(input,ctx)=>({ok:true,result:await ctx.apps.call('target','query',input)})}};`);
 await writeFile(join(directory,'target','server.js'),`export default {kind:'mop-server',version:1,hooks:{},handlers:{query:async(input,ctx)=>({ok:true,result:input.action==='read'?{person:ctx.employee.personId,permissions:ctx.employee.permissions,grants:ctx.employee.businessAuthorization.grants,data:await ctx.platform.invoke('fixture.read',{})}:input.action==='nested'?await ctx.apps.call('source','query',{action:'read'}):await ctx.platform.invoke('fixture.write',{})})}};`);
 const actor=(input:any)=>({actorType:'person',person:{id:input.trustedIdentity.userId,organization:{id:org}},execution:input.execution,request:{requestId:input.requestId,traceId:input.traceId},authorize:async()=>({allowed:true})});
 const api:any={contextResolver:{resolve:async(input:any)=>actor(input)},authorize:async(c:any)=>c.execution.appId==='source'||targetAllowed,businessAuthorization:async(c:any)=>({revision:randomUUID(),organizations:[{id:org,name:'工班'}],grants:[{permission:`app.${c.execution.appId}.read`,all:c.execution.appId==='source',self:false,organizationIds:[org]}]})};
 const entry:PublishedInterface={appId:'target',appName:'Target',version:'1.0.0',revision:1,apiId:'query',permission:'read',expose};
 let target:AppHostV2;
 const interfaces=new AppInterfaces({catalog:async id=>id===person&&targetAllowed&&targetEnabled?[entry]:[],assertDependency:async(s,t,id,p)=>{if(!dependency||s!=='source'||t!=='target'||id!=='query'||p!==person)throw new GatewayError('ACCESS_DENIED',403);},invoke:(id,appId,apiId,input,signal)=>target.invokeEmployeeApi(async()=>({source:'session',userId:id}),{apiId,method:'POST',path:'/query',payload:input},signal)});
 const gateway=new AppGateway({registry:{} as any,contextResolver:{resolve:async(input:any)=>({actorType:'service',execution:input.execution,request:{requestId:input.requestId,traceId:input.traceId},authorize:async()=>({allowed:true})})} as any,
  operations:[interfaces.operation(),...(['read','write'] as const).map(mode=>({name:`fixture.${mode}`,permissionCode:'fixture.read',mode,validateParams:()=>true,resolveResources:async()=>[{}],validateResult:()=>true,execute:async(c:any)=>{if(mode==='write'){writeCount++;return {};}received.push(c.employeeActor);return [{id:'own',organizationId:org},{id:'other',organizationId:otherOrg}].filter(r=>r.organizationId===c.employeeActor.person.organization.id);}}))],auditRepository:{append:async row=>{audit.push(row);}} as any});
 const make=(r:any)=>new AppHostV2({appId:r.appId,registry:{runtimeSnapshot:async()=>({...r,enabled:r.appId==='source'||targetEnabled}),get:async()=>r} as any,store:{directory:()=>join(directory,r.appId)} as any,gateway,api,log:()=>{}});
 const source=make(sourceRecord);target=make(targetRecord);
 try{
  await source.serve(sourceRecord);await target.serve(targetRecord);
  const invoke=(action:string)=>source.invokeEmployeeApi(async()=>({source:'session',userId:person}),{apiId:'query',method:'POST',path:'/query',payload:{action}});
  const result=await invoke('read') as any;assert.equal(result.result.person,person);assert.deepEqual(result.result.permissions,['app.target.read']);assert.equal(result.result.grants[0].all,false);assert.deepEqual(JSON.parse(JSON.stringify(result.result.data)),[{id:'own',organizationId:org}]);assert.equal(received[0].execution.appId,'target');
  const log=audit.find(row=>row.action==='platform.apps.call');assert.equal(log.metadata.targetAppId,'target');assert.equal(log.metadata.employeeActorId,person);
  await assert.rejects(invoke('write'));assert.equal(writeCount,0);await assert.rejects(invoke('nested'));
  dependency=false;await assert.rejects(invoke('read'));dependency=true;
  targetAllowed=false;await assert.rejects(invoke('read'));targetAllowed=true;
  targetEnabled=false;await assert.rejects(invoke('read'));
 }finally{await source.close();await target.close();await rm(directory,{recursive:true,force:true});}
});
