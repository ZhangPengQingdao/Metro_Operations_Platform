import test from 'node:test';
import assert from 'node:assert/strict';
import {createTodosService} from './service.mjs';
import {createTodosHandlers} from './handlers.mjs';
import {dueAt,occurrence} from './schedule.mjs';

const ids={orgA:'11111111-1111-4111-8111-111111111111',orgB:'22222222-2222-4222-8222-222222222222',station:'33333333-3333-4333-8333-333333333333',alice:'44444444-4444-4444-8444-444444444444',bob:'55555555-5555-4555-8555-555555555555',carol:'66666666-6666-4666-8666-666666666666'};
let counter=100;const id=()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`;
const grant=(permission,orgs)=>({permission:`app.todos.${permission}`,all:false,self:false,organizationIds:orgs});
const employee=(person,grants)=>({personId:person,organizationUnitId:person===ids.carol?ids.orgB:ids.orgA,businessAuthorization:{revision:id(),grants,organizations:[{id:ids.orgA,name:'甲工班'},{id:ids.orgB,name:'乙工班'}]}});
const worker=employee(ids.alice,['read','create','handle'].map(p=>grant(p,[ids.orgA])));
const bob=employee(ids.bob,['read','create','handle'].map(p=>grant(p,[ids.orgA])));
const leader=employee(ids.alice,['read','create','handle','manage','recurring','score'].map(p=>grant(p,[ids.orgA])));
const department=employee(ids.alice,['read','create','handle','manage','recurring','score'].map(p=>grant(p,[ids.orgA,ids.orgB])));
function memoryGateway(){
 const tables={tasks:new Map(),templates:new Map()},requests=new Set();
 const people=new Map([[ids.alice,{id:ids.alice,name:'张工',organizationUnitId:ids.orgA}],[ids.bob,{id:ids.bob,name:'李工',organizationUnitId:ids.orgA}],[ids.carol,{id:ids.carol,name:'王工',organizationUnitId:ids.orgB}]]);
 const clone=value=>structuredClone(value);
 return {tables,async invoke(op,p){
  if(op==='platform.people.members')return {organizationUnitId:p.organizationUnitId,rows:[...people.values()].filter(x=>x.organizationUnitId===p.organizationUnitId&&(!p.personIds||p.personIds.includes(x.id))&&(!p.search||x.name.includes(p.search)))};
  if(op==='platform.locations.get')return {id:p.id,name:'西站',locationType:'station',status:'active',organizationUnitId:null};
  if(op==='platform.locations.list')return {rows:[{id:ids.station,name:'西站',locationType:'station',status:'active'}],nextCursor:null};
  if(op==='platform.app_data.get')return {row:clone(tables[p.table].get(p.id)??null)};
  if(op==='platform.app_data.list'){
   let rows=[...tables[p.table].values()].filter(row=>(p.filters??[]).every(f=>row[f.column]===f.value)&&(p.anyOf??[[]]).some(group=>group.every(f=>row[f.column]===f.value))&&(!p.search||row[p.search.column].toLowerCase().includes(p.search.text.toLowerCase()))).sort(p.order?(a,b)=>b[p.order.column].localeCompare(a[p.order.column])||b.id.localeCompare(a.id):(a,b)=>a.id.localeCompare(b.id));
   if(p.afterId)rows=rows.filter(x=>x.id>p.afterId);
   if(p.after)rows=rows.filter(x=>x[p.order.column]<p.after.value||x[p.order.column]===p.after.value&&x.id<p.after.id);
   const page=rows.slice(0,p.pageSize??20);return {rows:clone(page),nextCursor:rows.length>page.length?(p.order?{id:page.at(-1).id,value:page.at(-1)[p.order.column]}:page.at(-1).id):null};
  }
  if(op==='platform.app_data.transaction'){
   if(requests.has(p.requestId))throw Error('STORAGE_REQUEST_ALREADY_RECORDED');
   const staged=Object.fromEntries(Object.entries(tables).map(([name,table])=>[name,new Map(table)]));
   for(const change of p.operations){const table=staged[change.table],prior=table.get(change.id);
    if(change.action==='insert'){if(prior)throw Error('STORAGE_CONFLICT');table.set(change.id,{id:change.id,...clone(change.values)});}
    else {if(!prior||Object.entries(change.expected).some(([k,v])=>prior[k]!==v))throw Error('STORAGE_CONFLICT');table.set(change.id,{...prior,...clone(change.values)});}
   }
   Object.entries(staged).forEach(([name,table])=>{tables[name].clear();for(const [key,row] of table)tables[name].set(key,row);});requests.add(p.requestId);return {results:p.operations.map(x=>({row:clone(tables[x.table].get(x.id))}))};
  }
  throw Error(`UNEXPECTED_OPERATION:${op}`);
 }};
}
const taskInput=(org=ids.orgA,scopeType='station',targetIds=[ids.station])=>({requestId:id(),organizationId:org,title:'巡查设备',description:'逐项记录',scopeType,targetIds,dueAt:null,isScored:false,scoreValue:0});
const templateInput=()=>({requestId:id(),organizationId:ids.orgA,title:'日常巡查',description:'',scopeType:'station',targetIds:[ids.station],recurrenceType:'daily',recurrenceValue:0,dueValue:0,triggerMinutes:540,dueMinutes:1080,isScored:false,scoreValue:0,active:true});

test('工班普通任务可发布和办理，按人员任务只允许本人办理',async()=>{
 const gateway=memoryGateway(),service=createTodosService(gateway);
 const station=await service.createTask(taskInput(),worker),record=await service.detail({taskId:station.id},worker);
 assert.equal(record.items.length,1);assert.equal(record.is_scored,false);
 await service.handleItem({requestId:id(),taskId:station.id,itemId:record.items[0].id,revision:0,completed:true,remarks:'检查完毕'},worker);
 const done=await service.detail({taskId:station.id},worker);assert.equal(done.status,'completed');assert.equal(done.items[0].completed_by,ids.alice);
 const person=await service.createTask(taskInput(ids.orgA,'person',[ids.bob]),worker),detail=await service.detail({taskId:person.id},worker);
 assert.equal(detail.items[0].can_handle,false);
 await assert.rejects(()=>service.handleItem({requestId:id(),taskId:person.id,itemId:detail.items[0].id,revision:0,completed:true},worker),/ACCESS_DENIED/);
 const bobView=await service.detail({taskId:person.id},bob);assert.equal(bobView.items[0].can_handle,true);
 await service.handleItem({requestId:id(),taskId:person.id,itemId:detail.items[0].id,revision:0,completed:true},bob);
 assert.equal((await service.detail({taskId:person.id},worker)).items[0].completed_by,ids.bob);
});

test('车站子项可选择本工班完成人，跨工班人员不可分配',async()=>{
 const gateway=memoryGateway(),service=createTodosService(gateway);
 const created=await service.createTask(taskInput(),worker);
 const initial=await service.detail({taskId:created.id},worker);
 assert.equal(initial.items[0].handler_id,null);
 assert.deepEqual((await service.directory({kind:'person',organizationId:ids.orgA},worker)).rows.map(person=>person.id),[ids.alice,ids.bob]);
 await assert.rejects(()=>service.handleItem({requestId:id(),taskId:created.id,itemId:initial.items[0].id,revision:0,completed:false,handlerId:ids.carol},worker),/INVALID_TARGET/);
 await service.handleItem({requestId:id(),taskId:created.id,itemId:initial.items[0].id,revision:0,completed:false,handlerId:ids.bob,remarks:'交给李工'},worker);
 const assigned=await service.detail({taskId:created.id},worker);
 assert.equal(assigned.items[0].handler_id,ids.bob);
 assert.equal(assigned.items[0].handler_name,'李工');
 assert.equal(assigned.items[0].status,'pending');
 await service.handleItem({requestId:id(),taskId:created.id,itemId:initial.items[0].id,revision:1,completed:true,handlerId:ids.bob,remarks:'已检查'},worker);
 const completed=await service.detail({taskId:created.id},worker);
 assert.equal(completed.items[0].completed_by,ids.alice);
 await service.handleItem({requestId:id(),taskId:created.id,itemId:initial.items[0].id,revision:2,completed:true,handlerId:null,remarks:'已检查'},worker);
 const cleared=await service.detail({taskId:created.id},worker);
 assert.equal(cleared.items[0].handler_id,null);
 assert.equal(cleared.items[0].completed_by,ids.alice);
 assert.equal(cleared.items[0].completed_at,completed.items[0].completed_at);
});

test('单项任务可以分配超过二十个车站',async()=>{
 const service=createTodosService(memoryGateway());
 const targetIds=Array.from({length:25},()=>id());
 const created=await service.createTask(taskInput(ids.orgA,'station',targetIds),worker);
 const detail=await service.detail({taskId:created.id},worker);
 assert.equal(detail.total_items,25);
 assert.deepEqual(detail.items.map(item=>item.target_id),targetIds);
});

test('权限按工班范围生效，部门角色可管理所属多个工班',async()=>{
 const gateway=memoryGateway(),service=createTodosService(gateway);
 await assert.rejects(()=>service.createTask({...taskInput(),isScored:true,scoreValue:5},worker),/ACCESS_DENIED/);
 await assert.rejects(()=>service.createTask(taskInput(ids.orgB),worker),/ACCESS_DENIED/);
 await assert.rejects(()=>service.saveTemplate(templateInput(),worker),/ACCESS_DENIED/);
 const other=await service.createTask(taskInput(ids.orgB,'person',[ids.carol]),department);
 await assert.rejects(()=>service.detail({taskId:other.id},worker),/ACCESS_DENIED/);
 const detail=await service.detail({taskId:other.id},department);
 await service.updateTask({requestId:id(),taskId:other.id,revision:detail.revision,title:'新标题',description:'',dueAt:null,isScored:false,scoreValue:0},department);
 assert.equal((await service.detail({taskId:other.id},department)).title,'新标题');
 await service.deleteTask({requestId:id(),taskId:other.id,revision:1},department);
 await assert.rejects(()=>service.detail({taskId:other.id},department),/ACCESS_DENIED/);
});

test('本人管理权限不能办理他人任务或读取其他工班人员目录',async()=>{
 const gateway=memoryGateway(),service=createTodosService(gateway);
 const selfManager=employee(ids.alice,[grant('read',[ids.orgA]),{permission:'app.todos.manage',all:false,self:true,organizationIds:[]}]);
 const other=await service.createTask(taskInput(),bob);
 const detail=await service.detail({taskId:other.id},selfManager);
 await assert.rejects(()=>service.handleItem({requestId:id(),taskId:other.id,itemId:detail.items[0].id,revision:0,completed:true},selfManager),/ACCESS_DENIED/);
 await assert.rejects(()=>service.directory({kind:'person',organizationId:ids.orgB},selfManager),/ACCESS_DENIED/);
 assert.equal((await service.directory({kind:'person',organizationId:ids.orgA},selfManager)).rows.length,2);
});

test('本人办理权限可办理分配给自己的人员任务',async()=>{
 const gateway=memoryGateway(),service=createTodosService(gateway);
 const assignee=employee(ids.bob,[grant('read',[ids.orgA]),{permission:'app.todos.handle',all:false,self:true,organizationIds:[]}]);
 const created=await service.createTask(taskInput(ids.orgA,'person',[ids.bob]),worker);
 const detail=await service.detail({taskId:created.id},assignee);
 assert.equal(detail.items[0].can_handle,true);
 await service.handleItem({requestId:id(),taskId:created.id,itemId:detail.items[0].id,revision:0,completed:true},assignee);
 assert.equal((await service.detail({taskId:created.id},assignee)).items[0].completed_by,ids.bob);
});

test('每日模板只在本地触发时间后生成一次，隔天继续生成',async()=>{
 const gateway=memoryGateway();let now=new Date('2026-09-24T00:59:00.000Z');const service=createTodosService(gateway,{clock:()=>now});
 const template=await service.saveTemplate(templateInput(),leader);
 assert.equal((await service.sweep()).length,0);
 now=new Date('2026-09-24T01:01:00.000Z');assert.equal((await service.sweep()).length,1);
 assert.equal((await service.sweep())[0].existing,true);
 now=new Date('2026-09-25T01:01:00.000Z');assert.equal((await service.sweep()).length,1);
 const records=[...gateway.tables.tasks.values()];assert.equal(records.length,2);
 assert.equal(records[0].template_id,template.id);assert.equal(records[0].due_at,'2026-09-24T10:00:00.000Z');
});

test('周期写入结果不确定时本进程不重试，跨进程仍使用同一请求号',async()=>{
 const storage=memoryGateway(),attempts=[];let now=new Date('2026-09-24T01:01:00.000Z');
 const gateway={invoke:async(op,params,signal)=>{
  if(op==='platform.app_data.transaction'&&params.operations[0].table==='tasks'){
   attempts.push(params.requestId);
   throw Object.assign(Error('NETWORK_LOST'),{writeOutcome:'unknown'});
  }
  return storage.invoke(op,params,signal);
 }};
 const service=createTodosService(gateway,{clock:()=>now});await service.saveTemplate(templateInput(),leader);
 await assert.rejects(()=>service.sweep(),/NETWORK_LOST/);
 assert.deepEqual(await service.sweep(),[]);assert.equal(attempts.length,1);
 await assert.rejects(()=>createTodosService(gateway,{clock:()=>now}).sweep(),/NETWORK_LOST/);
 assert.equal(attempts[0],attempts[1]);assert.equal(storage.tables.tasks.size,0);
});

test('手动生成使用请求号去重，停用模板不可生成',async()=>{
 const gateway=memoryGateway(),service=createTodosService(gateway);
 const template=await service.saveTemplate(templateInput(),leader),requestId=id();
 const first=await service.trigger({requestId,templateId:template.id},leader);
 const second=await service.trigger({requestId,templateId:template.id},leader);
 assert.equal(first.id,second.id);assert.equal(second.existing,true);assert.equal(gateway.tables.tasks.size,1);
 await service.templateState({requestId:id(),templateId:template.id,revision:0,action:'active',active:false},leader);
 await assert.rejects(()=>service.trigger({requestId:id(),templateId:template.id},leader),/INACTIVE_TEMPLATE/);
});

test('并发办理使用任务版本校验，计分修改须单独授权',async()=>{
 const gateway=memoryGateway(),service=createTodosService(gateway);
 const created=await service.createTask(taskInput(),worker),detail=await service.detail({taskId:created.id},worker);
 await assert.rejects(()=>service.updateTask({requestId:id(),taskId:created.id,revision:0,title:'新标题',isScored:true,scoreValue:8},worker),/ACCESS_DENIED/);
 await service.handleItem({requestId:id(),taskId:created.id,itemId:detail.items[0].id,revision:0,completed:true},worker);
 await assert.rejects(()=>service.handleItem({requestId:id(),taskId:created.id,itemId:detail.items[0].id,revision:0,completed:false},worker),/CONFLICT/);
});

test('列表按创建时间倒序分页并限制在授权工班',async()=>{
 const gateway=memoryGateway();let minute=0;
 const service=createTodosService(gateway,{clock:()=>new Date(Date.UTC(2026,8,24,minute++))});
 const first=await service.createTask(taskInput(),worker);
 const second=await service.createTask(taskInput(),worker);
 const third=await service.createTask(taskInput(),worker);
 await service.createTask(taskInput(ids.orgB,'person',[ids.carol]),department);
 const page=await service.list({kind:'tasks'},worker);
 assert.deepEqual(page.rows.map(x=>x.id),[third.id,second.id]);
 assert.ok(page.nextCursor);
 const last=await service.list({kind:'tasks',after:page.nextCursor},worker);
 assert.deepEqual(last.rows.map(x=>x.id),[first.id]);
 assert.deepEqual((await service.list({kind:'tasks',search:'巡查'},worker)).rows.map(x=>x.id),[third.id,second.id]);
 assert.deepEqual((await service.list({kind:'tasks',search:'不存在'},worker)).rows,[]);
});

test('周期时间计算覆盖跨日和周边界',()=>{
 const at=new Date('2026-09-24T01:00:00.000Z');
 assert.equal(dueAt({recurrence_type:'daily',trigger_minutes:1200,due_minutes:480},at),'2026-09-25T00:00:00.000Z');
 assert.equal(occurrence({active:true,deleted:false,recurrence_type:'weekly',recurrence_value:4,trigger_minutes:540},at),'2026-09-24');
 assert.equal(occurrence({active:true,deleted:false,recurrence_type:'monthly',recurrence_value:25,trigger_minutes:540},at),null);
});

test('API 错误区分拒绝与未知写结果',async()=>{
 const gateway=memoryGateway(),handlers=createTodosHandlers(gateway);
 const denied=await handlers.get('create-task').execute({...taskInput(),isScored:true},new AbortController().signal,worker);
 assert.equal(denied.error.code,'ACCESS_DENIED');assert.equal(denied.error.writeOutcome,'not_started');
 const broken=createTodosHandlers({invoke:async()=>{throw Error('NETWORK_LOST');}});
 const unknown=await broken.get('create-task').execute(taskInput(),new AbortController().signal,worker);
 assert.equal(unknown.error.writeOutcome,'unknown');
 const conflicted=createTodosHandlers({invoke:async(op,params)=>{
  if(op==='platform.locations.get')return gateway.invoke(op,params);
  throw Object.assign(Error('STORAGE_CONFLICT'),{code:'STORAGE_CONFLICT',writeOutcome:'unknown'});
 }});
 const conflict=await conflicted.get('create-task').execute(taskInput(),new AbortController().signal,worker);
 assert.deepEqual(conflict.error,{code:'CONFLICT',writeOutcome:'unknown'});
});
