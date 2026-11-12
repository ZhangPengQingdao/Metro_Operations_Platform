import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {appAgents,appTools,appApiExposure,validateAppManifestV2,type AppManifestV2} from '@metro/platform-sdk/manifest';
import {matchesAppContract,isAppApiDocumentation} from '@metro/platform-sdk/app-api-documentation';
import {runApiAgent} from '../src/platform/chat/api-agent.ts';

const documentation={description:'按编号总结计划，返回草稿，不提交。',
 input:{type:'object' as const,properties:{ids:{type:'array' as const,items:{type:'string' as const,maxLength:40},minItems:1,maxItems:5}},required:['ids'],additionalProperties:false},
 output:{type:'object' as const,properties:{summary:{type:'string' as const,maxLength:100}},required:['summary'],additionalProperties:false},
 examples:[{title:'总结这些计划',params:{ids:['one']},result:{summary:'草稿'}}],errors:[]};
const manifest:AppManifestV2={id:'demo',name:'示例',version:'1.0.0',description:'统一接口测试',platform:'>=1.12.0',permissions:[{code:'read',name:'读取'}],platformAccess:[],pages:[{path:'/',title:'示例',nav:true}],
 api:[{id:'summary',title:'计划总结',permission:'read',mode:'read',documentation,ai:true,expose:true}]};
const task={message:'总结这些计划',history:[],today:'2026-11-12'};

test('a single manifest contract derives all consumer catalogs without duplicate declarations',()=>{
 const parsed=validateAppManifestV2(manifest);assert.ok(parsed.ok);
 assert.equal(parsed.manifest.agents,undefined);assert.equal(parsed.manifest.tools,undefined);
 const api=parsed.manifest.api[0],agent=appAgents(parsed.manifest)[0],tool=appTools(parsed.manifest)[0];
 assert.equal(agent.apiId,api.id);assert.equal(tool.apiId,api.id);
 assert.deepEqual(agent.documentation,api.documentation);
 assert.deepEqual(tool.inputSchema,api.documentation!.input);
 assert.deepEqual(appApiExposure(api)!.documentation,api.documentation);
 assert.equal(appApiExposure({...api,expose:'apps'},'developer'),undefined);
 assert.ok(appApiExposure({...api,expose:'apps'},'apps'));
 assert.ok(appApiExposure(api,'developer'));
 assert.equal(agent.execution,'api');assert.equal(agent.page,'/');
});

test('shared contracts reject writes, invalid channels, unsafe schemas and shadow declarations',()=>{
 for(const patch of [{mode:'write'},{mode:'other'},{tool:false},{ai:false},{ai:{page:'/missing'}},{ai:{examples:[]}},{expose:{}},{documentation:{...documentation,input:{type:'object'}}},{documentation:{...documentation,output:{type:'object',$ref:'https://invalid'}}}]){
  assert.equal(validateAppManifestV2({...manifest,api:[{...manifest.api[0],...patch}]}).ok,false,JSON.stringify(patch));
 }
 assert.equal(validateAppManifestV2({...manifest,tools:[{...appTools(manifest)[0],inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}]}).ok,false);
 assert.equal(validateAppManifestV2({...manifest,agents:[{...appAgents(manifest)[0],execution:undefined,documentation:undefined}]}).ok,false);
 assert.ok(isAppApiDocumentation(documentation));
 for(const ids of [[],['a'.repeat(41)],Array(6).fill('x'),[1]])assert.equal(matchesAppContract(documentation.input,{ids}),false);
 assert.equal(matchesAppContract(documentation.input,{ids:['one'],employee:{id:'forged'}}),false);
 assert.equal(matchesAppContract(documentation.input,{ids:['one']}),true);
});

test('AI adapter asks for missing input and uses the same validated handler once',async()=>{
 const capability=appAgents(manifest)[0],signal=new AbortController().signal;
 let calls=0,step=0;
 const invoke=async(input:unknown)=>{calls++;assert.deepEqual(input,{ids:['one']});return {summary:'真实结果'};};
 assert.deepEqual(await runApiAgent(capability,task,invoke,signal,async()=>JSON.stringify({kind:'clarify',text:'请提供计划编号。'})),{kind:'clarify',text:'请提供计划编号。'});
 assert.equal(calls,0);
 const reply=await runApiAgent(capability,{...task,history:[{role:'user',content:'计划编号one'}]},invoke,signal,async(_system,data:any)=>{
  if(step++===0){assert.equal(data.task.history[0].content,'计划编号one');return JSON.stringify({kind:'call',input:{ids:['one']}});}
  assert.deepEqual(data.result,{summary:'真实结果'});return JSON.stringify({kind:'draft',text:'真实结果，尚未提交。'});
 });
 assert.equal(calls,1);assert.equal(reply.kind,'draft');assert.match(reply.text,/真实结果/);
});

test('AI adapter rejects invalid model arguments, errors and cancellation without replay',async()=>{
 const cap=appAgents(manifest)[0],signal=new AbortController().signal;
 let calls=0;
 await assert.rejects(runApiAgent(cap,task,async()=>{calls++;return {};},signal,async()=>JSON.stringify({kind:'call',input:{ids:['one'],employee:'forged'}})),/INVALID_PARAMS/);
 assert.equal(calls,0);
 const prepare=async()=>JSON.stringify({kind:'call',input:{ids:['one']}});
 await assert.rejects(runApiAgent(cap,task,async()=>{calls++;throw Error('ACCESS_DENIED');},signal,prepare),/ACCESS_DENIED/);assert.equal(calls,1);
 await assert.rejects(runApiAgent(cap,task,async()=>({secret:'invalid shape'}),signal,prepare),/INVALID_RESULT/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(runApiAgent(cap,task,async()=>{throw Error('must not execute');},controller.signal,prepare),/abort/i);
});

test('all shipped apps declare execution modes, share business APIs and remove redundant agent handlers',async()=>{
 for(const name of await readdir(new URL('../../applications/',import.meta.url))){
  const manifest=JSON.parse(await readFile(new URL(`../../applications/${name}/app.json`,import.meta.url),'utf8'));
  const parsed=validateAppManifestV2(manifest);assert.ok(parsed.ok,`${name}: ${JSON.stringify(parsed)}`);
  assert.ok(manifest.api.every((a:any)=>['read','draft','write'].includes(a.mode)),name);
  assert.ok(appAgents(manifest).length,name);
  assert.ok(manifest.api.some((api:any)=>appApiExposure(api,'apps')),name);
  assert.equal(manifest.agents,undefined,name);assert.equal(manifest.tools,undefined,name);
  assert.ok(!manifest.api.some((a:any)=>/^(agent-|tool-)/.test(a.id)),name);
 }
});
