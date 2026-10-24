import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {runtimeCountInput,runtimeCountQuery,runtimeListInput,runtimeListQuery,runtimeListSelection,runtimeDailyCountInput,runtimeDailyCountQuery} from '../src/app-platform/v2/data-query.ts';
import {isAppDashboardSnapshot,readAppDashboard} from '../../packages/platform-sdk/src/app-dashboard.ts';
import {AppDataServiceV2} from '../src/app-platform/v2/data.ts';
import {createFaultService} from '../../applications/faults/src/service.mjs';
import {createMaintenanceService} from '../../applications/maintenance/src/service.mjs';
import {createHuicetongService} from '../../applications/huicetong/src/service.mjs';
import {createTodosService} from '../../applications/todos/src/service.mjs';

const id=(n:number)=>`61000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const snapshot={version:'1.0',generatedAt:'2026-10-10T01:00:00Z',scopeLabel:'授权范围',metrics:[{id:'pending',label:'待处理',value:0,unit:'项'}],items:[]};
test('dashboard rejects unbounded data, false counts, HTML/link fields and invalid dates',()=>{
 assert.ok(isAppDashboardSnapshot(snapshot));
 for(const value of [{...snapshot,metrics:[{...snapshot.metrics[0],value:-1}]},{...snapshot,metrics:Array(5).fill(snapshot.metrics[0])},{...snapshot,completion:{completed:5,total:3}},{...snapshot,items:[{id:'a',title:'x',href:'https://example.org'}]},{...snapshot,generatedAt:'invalid'},{...snapshot,html:'<script/>'}])assert.equal(isAppDashboardSnapshot(value),false);
});
test('count and projection apply the same scoped predicates without reading large JSON columns',async()=>{
 const db=new PGlite();
 try{
  await db.exec('CREATE TABLE records(id uuid PRIMARY KEY,organization_id uuid,created_by uuid,status text,created_at timestamptz,title text,items jsonb)');
  for(const [n,org,status] of [[1,1,'pending'],[2,2,'pending'],[3,1,'completed']] as const)await db.query('INSERT INTO records VALUES($1,$2,$3,$4,$5,$6,$7)',[id(n),id(org),id(9),status,'2026-10-10T01:00:00Z',`记录${n}`,JSON.stringify({large:'x'.repeat(40000)})]);
  const columns=new Map([['id','uuid'],['organization_id','uuid'],['created_by','uuid'],['status','text'],['created_at','timestamptz'],['title','text'],['items','jsonb']]);
  const scope={anyOf:[[{column:'organization_id',value:id(1)}]]};
  const input=runtimeCountInput.parse({kind:'count',table:'records',...scope,filters:[{column:'status',value:'pending'}]});
  const count=runtimeCountQuery(input,columns);
  assert.equal((await db.query<{count:string}>('SELECT count(*)::text AS count FROM records'+count.suffix,count.values)).rows[0].count,'1');
  const list=runtimeListInput.parse({table:'records',...scope,columns:['title'],order:{column:'created_at',direction:'desc'},pageSize:1});
  const query=runtimeListQuery(list,columns),select=runtimeListSelection(list,columns);
  const rows=(await db.query(`SELECT ${select} FROM records t${query.suffix}`,query.values)).rows;
  assert.equal(rows.length,2);assert.deepEqual(Object.keys(rows[0]).sort(),['created_at','id','title']);
  assert.throws(()=>runtimeListSelection({...list,columns:['missing']},columns),/INVALID_PARAMS/);
  assert.throws(()=>runtimeCountQuery({...input,filters:[{column:'missing',value:'x'}]},columns),/INVALID_PARAMS/);
  for(const extra of [{sql:'select 1'},{groupBy:'status'},{schema:'public'},{columns:['items']},{pageSize:50}])assert.equal(runtimeCountInput.safeParse({...input,...extra}).success,false);
 }finally{await db.close();}
});
test('read batch admits count but rejects mutations and excessive work',()=>{
 const service=new AppDataServiceV2({pool:{connect:async()=>{throw Error('unused');}} as never,findInstallation:async()=>null});
 const batch=service.operations().find(op=>op.name==='platform.app_data.read_batch')!;
 assert.ok(batch.validateParams({operations:[{kind:'count',table:'records'},{table:'records',columns:['title'],pageSize:1}]}));
 assert.equal(batch.validateParams({operations:[{kind:'count',table:'records',action:'delete'}]}),false);
 assert.equal(batch.validateParams({operations:Array(5).fill({kind:'count',table:'records'})}),false);
});
for(const [appId,create] of [['faults',createFaultService],['maintenance',createMaintenanceService],['huicetong',createHuicetongService],['todos',createTodosService]] as const){
 test(`${appId} dashboard uses bounded sequential reads, preserves employee scope and rejects identity injection`,async()=>{
  let calls=0;
  const employee={personId:id(8),organizationUnitId:id(1),businessAuthorization:{revision:'1',organizations:[{id:id(1),name:'工班'}],grants:[{permission:`app.${appId}.read`,all:false,self:true,organizationIds:[id(1)]}]}};
  const gateway={async invoke(operation:string,params:any){calls++;assert.equal(operation,'platform.app_data.read_batch');
   for(const op of params.operations)assert.deepEqual(op.anyOf,[[{column:'organization_id',value:id(1)}],[{column:'created_by',value:id(8)}]]);
   if(params.operations.length===1){assert.equal(params.operations[0].kind,'daily_count');return {results:[{days:[]}]};}
   assert.ok(params.operations[2].columns.length>0);
   return {results:[{count:12},{count:4},{rows:[]},...(params.operations.length===4?[params.operations[3].kind==='daily_count'?{days:[]}:{count:2}]:[])]};
  }};
  const service=create(gateway),result=await service['dashboard-summary']({},employee);
  assert.ok(isAppDashboardSnapshot(result));assert.equal(calls,['todos','huicetong'].includes(appId)?2:1);assert.equal(result.metrics[0].value,['todos','huicetong'].includes(appId)?6:8);
  await assert.rejects(service['dashboard-summary']({personId:id(2)},employee),/INVALID_INPUT/);
  await assert.rejects(service['dashboard-summary']({}, {...employee,businessAuthorization:{...employee.businessAuthorization,grants:[]}}),/ACCESS_DENIED/);
  assert.equal(calls,['todos','huicetong'].includes(appId)?2:1);
 });
}
test('dashboard helper rejects inconsistent statistics and never retries failed reads',async()=>{
 let calls=0;
 const options={readBatch:async()=>{calls++;return {results:[{count:1},{count:2},{rows:[]}]};},table:'records',scope:{},filters:[],done:[],previewColumns:['title'],labels:['待办','完成','总计'] as [string,string,string],unit:'项',preview:()=>({id:'x',title:'x'})};
 await assert.rejects(readAppDashboard(options),/INVALID_DASHBOARD_COUNTS/);assert.equal(calls,1);
});

test('dashboard preview accepts multiline business text as bounded single-line display text',async()=>{
 const result=await readAppDashboard({readBatch:async()=>({results:[{count:1},{count:0},{rows:[{}]}]}),table:'records',scope:{},filters:[],done:[],previewColumns:['title'],labels:['待办','完成','总计'],unit:'项',preview:()=>({id:'x',title:'计划\n检查',description:'\t设备\r\n检查'})});
 assert.equal(result.items[0].title,'计划 检查');
 assert.equal(result.items[0].description,'设备 检查');
 assert.ok(isAppDashboardSnapshot(result));
});


test('employee dashboard binds API execution to admission and rechecks after the result',async()=>{
 const {readEmployeeDashboard}=await import('../src/app-platform/employee/dashboard.ts');
 const state={identity:{source:'session',userId:id(8)},access:{installationId:id(4),revision:'grant-1'},installation:{id:id(4),revision:1,manifest:{dashboard:{apiId:'summary',routeId:'home'},api:[{id:'summary',method:'POST',path:'/summary',expose:{mode:'read'}}]}}};
 let calls=0;
 const deps={admit:async()=>structuredClone(state) as any,navigation:async()=>({routes:[{id:'home'}]}),invoke:async(api:any,resolve:any)=>{calls++;assert.equal(api.id,'summary');assert.equal((await resolve()).userId,id(8));return {ok:true,result:snapshot};}};
 assert.deepEqual(await readEmployeeDashboard(deps),snapshot);assert.equal(calls,1);
 await assert.rejects(readEmployeeDashboard({...deps,navigation:async()=>({routes:[]})}),/ACCESS_DENIED/);assert.equal(calls,1);
 await assert.rejects(readEmployeeDashboard({...deps,invoke:async()=>({...snapshot,href:'https://example.org'})}),/INVALID_RESULT/);
 await assert.rejects(readEmployeeDashboard({...deps,invoke:async()=>{state.access.revision='grant-2';return {ok:true,result:snapshot};}}),/ACCESS_DENIED/);
});


test('daily aggregation respects Shanghai day boundaries, scope and bounded identifiers',async()=>{
 const db=new PGlite();
 try{
  await db.exec('CREATE TABLE records(id uuid,organization_id uuid,created_at timestamptz,status text)');
  for(const [n,org,at] of [[1,1,'2026-10-09T15:59:59Z'],[2,1,'2026-10-09T16:00:00Z'],[3,2,'2026-10-10T01:00:00Z'],[4,1,'2026-10-10T16:00:00Z']] as const)await db.query('INSERT INTO records VALUES($1,$2,$3,$4)',[id(n),id(org),at,'open']);
  const columns=new Map([['id','uuid'],['organization_id','uuid'],['created_at','timestamptz'],['status','text']]);
  const input=runtimeDailyCountInput.parse({kind:'daily_count',table:'records',column:'created_at',from:'2026-10-10',days:1,anyOf:[[{column:'organization_id',value:id(1)}]]});
  const query=runtimeDailyCountQuery(input,columns);
  assert.deepEqual((await db.query(`SELECT ${query.select} FROM records${query.suffix}`,query.values)).rows,[{day:'2026-10-10',count:'1'}]);
  for(const extra of [{days:32},{days:0},{from:'2026-02-30'},{column:'created_at;drop table records'},{groupBy:'status'}])assert.equal(runtimeDailyCountInput.safeParse({...input,...extra}).success,false);
  assert.throws(()=>runtimeDailyCountQuery({...input,column:'status'},columns),/INVALID_PARAMS/);
 }finally{await db.close();}
});
test('daily series zero fills absent days only after successful authorized aggregation',async()=>{
 const options={readBatch:async(operations:any)=>{assert.equal(operations.length,4);assert.deepEqual(operations[3],{table:'records',filters:[],kind:'daily_count',column:'created_at',from:'2026-10-09',days:2});return {results:[{count:2},{count:1},{rows:[]},{days:[{day:'2026-10-10',count:2}]}]};},table:'records',scope:{},filters:[],done:[],previewColumns:['title'],labels:['待办','完成','总计'] as [string,string,string],unit:'项',preview:()=>({id:'x',title:'x'}),clock:()=>new Date('2026-10-09T16:01:00Z'),trend:{kind:'line' as const,column:'created_at',label:'新增记录',days:2}};
 const result=await readAppDashboard(options);
 assert.deepEqual(result.series?.points,[{date:'2026-10-09',value:0},{date:'2026-10-10',value:2}]);
 assert.ok(isAppDashboardSnapshot(result));
 assert.equal(isAppDashboardSnapshot({...result,series:{...result.series,points:[{date:'2026-02-30',value:2}]}}),false);
 assert.equal(isAppDashboardSnapshot({...result,series:{...result.series,points:[{date:'2026-10-09',value:1},{date:'2026-10-09',value:2}]}}),false);
 await assert.rejects(readAppDashboard({...options,readBatch:async()=>{throw Error('READ_FAILED');}}),/READ_FAILED/);
 await assert.rejects(readAppDashboard({...options,readBatch:async()=>({results:[{count:2},{count:1},{rows:[]},{days:[{day:'2026-10-11',count:2}]}]})}),/INVALID_DASHBOARD_TREND/);
});


test('personal dashboard selection preserves empty choices, order, limits and revoked app filtering',async()=>{
 const {isDashboardLayout}=await import('../../packages/platform-sdk/src/app-dashboard.ts');
 const {visibleDashboardLayout,moveDashboardItem,smoothDashboardPath}=await import('../../src/app-platform/employee/dashboard-layout.ts');
 const value={version:1,cards:['todos','faults'],charts:['todos:series'],shortcuts:[]};
 assert.ok(isDashboardLayout(value));
 for(const patch of [{cards:['todos','todos']},{cards:['a','b','c','d','e']},{charts:['faults:script']},{shortcuts:['https://evil.test']},{accountId:id(5)}])assert.equal(isDashboardLayout({...value,...patch}),false);
 assert.deepEqual(visibleDashboardLayout(value as any,{cards:[{id:'faults',label:'故障'}],charts:[],shortcuts:[{id:'faults',label:'故障'}]}),{version:1,cards:['faults'],charts:[],shortcuts:[]});
 assert.deepEqual(moveDashboardItem(['a','b','c'],'b',-1),['b','a','c']);
 assert.deepEqual(moveDashboardItem(['a','b'],'a',-1),['a','b']);
 assert.equal(smoothDashboardPath([{x:0,y:0},{x:10,y:20},{x:20,y:0}]),'M0,0 C5,0 5,20 10,20 C15,20 15,0 20,0');
});
