import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHuicetongService} from './service.mjs';
import {createHuicetongHandlers} from './handlers.mjs';
import {migration} from './schema.mjs';
import {allowsAppResource} from '@metro/platform-sdk/app-backend';

function fixture(){
 const department=randomUUID(),otherDepartment=randomUUID(),team=randomUUID(),otherTeam=randomUUID(),person=randomUUID(),colleague=randomUUID(),outside=randomUUID();
 const tables=new Map(migration.operations.filter(operation=>operation.kind==='createTable').map(operation=>[operation.table,new Map()]));
 const people=new Map([[person,{id:person,name:'张三',organizationUnitId:team}],[colleague,{id:colleague,name:'李四',organizationUnitId:otherTeam}],[outside,{id:outside,name:'外部门员工',organizationUnitId:otherDepartment}]]);
 const writes=[];
 const gateway={async invoke(operation,payload){
  if(operation==='platform.people.organization_context')return {organizations:payload.organizationUnitId===team||payload.organizationUnitId===otherTeam?[{id:payload.organizationUnitId,unitType:'workgroup'},{id:department,unitType:'department'}]:[{id:payload.organizationUnitId,unitType:'workgroup'},{id:otherDepartment,unitType:'department'}]};
  if(operation==='platform.people.members')return {organizationUnitId:payload.organizationUnitId,rows:[...people.values()].filter(row=>row.organizationUnitId===payload.organizationUnitId&&(!payload.personIds||payload.personIds.includes(row.id))&&(!payload.search||row.name.includes(payload.search)))};
  if(operation==='platform.app_data.get')return {row:structuredClone(tables.get(payload.table)?.get(payload.id)??null)};
  if(operation==='platform.app_data.list'){
   let values=[...tables.get(payload.table).values()].filter(row=>payload.filters?.every(filter=>row[filter.column]===filter.value)??true).filter(row=>!payload.anyOf||payload.anyOf.some(group=>group.every(filter=>row[filter.column]===filter.value)));
   if(payload.order){const column=payload.order.column,direction=payload.order.direction==='asc'?1:-1;values.sort((a,b)=>direction*(String(a[column]).localeCompare(String(b[column]))||a.id.localeCompare(b.id)));if(payload.after)values=values.filter(row=>direction*(String(row[column]).localeCompare(payload.after.value)||row.id.localeCompare(payload.after.id))>0);}
   const page=values.slice(0,payload.pageSize??100),last=page.at(-1);
   return {rows:structuredClone(page),nextCursor:values.length>page.length?payload.order?{id:last.id,value:String(last[payload.order.column])}:last.id:null};
  }
  assert.equal(operation,'platform.app_data.transaction');writes.push(structuredClone(payload));
  const next=new Map([...tables].map(([name,rows])=>[name,new Map([...rows].map(([id,row])=>[id,structuredClone(row)]))]));
  for(const change of payload.operations){const rows=next.get(change.table),old=rows.get(change.id);
   if(change.action==='insert'){
    if(old)throw Object.assign(Error('duplicate'),{code:'STORAGE_CONFLICT',writeOutcome:'not_started'});
    if(change.table==='plan_cycles'&&[...rows.values()].some(row=>row.organization_id===change.values.organization_id&&row.year===change.values.year&&row.month===change.values.month))throw Object.assign(Error('duplicate month'),{code:'STORAGE_CONFLICT',writeOutcome:'not_started'});
    rows.set(change.id,{id:change.id,...structuredClone(change.values)});
   }else{
    if(!old||Object.entries(change.expected).some(([name,value])=>old[name]!==value))throw Object.assign(Error('stale'),{code:'STORAGE_CONFLICT',writeOutcome:'not_started'});
    if(change.action==='delete')rows.delete(change.id);else rows.set(change.id,{...old,...structuredClone(change.values)});
   }
  }
  tables.clear();for(const [name,rows] of next)tables.set(name,rows);
  return {results:[]};
 }};
 const grant=(name,organizationIds=[department])=>({permission:`app.huicetong.${name}`,all:false,self:false,organizationIds});
 const employee={personId:person,organizationUnitId:team,businessAuthorization:{revision:randomUUID(),organizations:[{id:department,name:'AFC 维保部'}],grants:['read','fill','manage'].map(name=>grant(name))}};
 return {department,otherDepartment,team,otherTeam,person,colleague,outside,tables,writes,gateway,employee,service:createHuicetongService(gateway,{clock:()=>new Date('2026-09-28T02:00:00.000Z')})};
}

test('P0 schema reserves all plan tables and the unique monthly cycle key',()=>{
 const names=migration.operations.filter(operation=>operation.kind==='createTable').map(operation=>operation.table);
 assert.deepEqual(names,['plan_cycles','category_nodes','plan_items','plan_item_assignees','review_records','completion_records','change_records','recurring_templates','supervision_entries','language_patterns','review_bindings','audit_events']);
 assert.ok(migration.operations.some(operation=>operation.kind==='createIndex'&&operation.name==='cycles_org_month_unique'&&operation.unique));
});

test('M1 creates a department cycle, three-level categories and multi-team item with audit',async()=>{
 const f=fixture(),cycleId=randomUUID(),root=randomUUID(),parent=randomUUID(),leaf=randomUUID(),itemId=randomUUID();
 await f.service['cycle-create']({id:cycleId,requestId:randomUUID(),organizationId:f.department,year:2026,month:9},f.employee);
 await assert.rejects(f.service['cycle-create']({id:randomUUID(),requestId:randomUUID(),organizationId:f.department,year:2026,month:9},f.employee),/CONFLICT/);
 for(const [id,level,parentId,name] of [[root,1,null,'一流地铁目标体系'],[parent,2,root,'安全'],[leaf,3,parent,'应急演练']])await f.service['category-upsert']({id,requestId:randomUUID(),organizationId:f.department,level,parentId,name,sort:level,enabled:true},f.employee);
 const draft={categoryId:leaf,content:'完成应急演练',qualityStandard:'提交演练记录并通过复盘',startDate:'2026-09-01',endDate:'2026-09-30',escalated:false,remark:'',assignees:[{personId:f.person,organizationUnitId:f.team,isLead:true},{personId:f.colleague,organizationUnitId:f.otherTeam,isLead:false}]};
 assert.equal((await f.service['item-create']({id:itemId,requestId:randomUUID(),cycleId,draft},f.employee)).version,1);
 const row=await f.service['item-get']({id:itemId},f.employee);
 assert.equal(row.category_name,'应急演练');assert.equal(row.assignees.length,2);assert.equal(row.lead_person_id,f.person);
 assert.equal((await f.service['item-list']({cycleId},f.employee)).rows.length,1);
 assert.equal(f.tables.get('plan_item_assignees').size,2);
 assert.equal(f.tables.get('audit_events').size,5);
 await f.service['item-update']({id:itemId,requestId:randomUUID(),expectedVersion:1,draft:{...draft,content:'完成联合演练',assignees:[{personId:f.colleague,organizationUnitId:f.otherTeam,isLead:true}]}},f.employee);
 assert.equal((await f.service['item-get']({id:itemId},f.employee)).lead_person_id,f.colleague);
 assert.equal(f.tables.get('plan_item_assignees').size,1);
 await assert.rejects(f.service['item-update']({id:itemId,requestId:randomUUID(),expectedVersion:1,draft},f.employee),/CONFLICT/);
});

test('M1 denies cross-organization writes, foreign assignees and read-only edits',async()=>{
 const f=fixture(),cycleId=randomUUID(),before=f.writes.length;
 await assert.rejects(f.service['cycle-create']({id:cycleId,requestId:randomUUID(),organizationId:f.otherDepartment,year:2026,month:9},f.employee),/ACCESS_DENIED/);
 assert.equal(f.writes.length,before);
 const readOnly={...f.employee,businessAuthorization:{...f.employee.businessAuthorization,grants:f.employee.businessAuthorization.grants.filter(grant=>grant.permission==='app.huicetong.read')}};
 await assert.rejects(f.service['cycle-create']({id:cycleId,requestId:randomUUID(),organizationId:f.department,year:2026,month:9},readOnly),/ACCESS_DENIED/);
 const response=await createHuicetongHandlers(f.gateway).get('cycle-create').execute({id:cycleId,requestId:randomUUID(),organizationId:f.department,year:2026,month:9,personId:f.colleague},undefined,f.employee);
 assert.equal(response.error.code,'INVALID_INPUT');assert.equal(response.error.writeOutcome,'not_started');
 await f.service['cycle-create']({id:cycleId,requestId:randomUUID(),organizationId:f.department,year:2026,month:9},f.employee);
 const root=randomUUID(),parent=randomUUID(),leaf=randomUUID();
 for(const [id,level,parentId] of [[root,1,null],[parent,2,root],[leaf,3,parent]])await f.service['category-upsert']({id,requestId:randomUUID(),organizationId:f.department,level,parentId,name:`分类 ${level}`,sort:level,enabled:true},f.employee);
 const draft={categoryId:leaf,content:'跨组织人员不应入选',qualityStandard:'完成验收',startDate:'2026-09-01',endDate:'2026-09-30',escalated:false,assignees:[{personId:f.outside,organizationUnitId:f.otherDepartment,isLead:true}]};
 const writesBefore=f.writes.length;
 await assert.rejects(f.service['item-create']({id:randomUUID(),requestId:randomUUID(),cycleId,draft},f.employee),/PERSON_INVALID/);
 assert.equal(f.writes.length,writesBefore);
});

test('self-fill cannot add an item to a readable department outside the current organization',async()=>{
 const f=fixture(),cycleId=randomUUID();
 f.tables.get('plan_cycles').set(cycleId,{id:cycleId,organization_id:f.otherDepartment,status:'drafting',revision:1,created_by:f.outside});
 const employee={...f.employee,businessAuthorization:{...f.employee.businessAuthorization,grants:[
  {permission:'app.huicetong.read',all:false,self:false,organizationIds:[f.otherDepartment]},
  {permission:'app.huicetong.fill',all:false,self:true,organizationIds:[]}
 ]}};
 assert.equal(allowsAppResource(employee,'app.huicetong.fill',{organizationUnitId:f.otherDepartment,ownerPersonId:f.person}),true);
 await assert.rejects(f.service['item-create']({id:randomUUID(),requestId:randomUUID(),cycleId,draft:{}},employee),/ACCESS_DENIED/);
 assert.equal(f.writes.length,0);
});

test('cycle status is checked in the same transaction as an item insert',async()=>{
 const f=fixture(),cycleId=randomUUID(),root=randomUUID(),parent=randomUUID(),leaf=randomUUID();
 await f.service['cycle-create']({id:cycleId,requestId:randomUUID(),organizationId:f.department,year:2026,month:9},f.employee);
 for(const [id,level,parentId] of [[root,1,null],[parent,2,root],[leaf,3,parent]])await f.service['category-upsert']({id,requestId:randomUUID(),organizationId:f.department,level,parentId,name:`分类 ${level}`,sort:level,enabled:true},f.employee);
 const gateway={invoke:(operation,payload)=>{if(operation==='platform.app_data.transaction'&&payload.operations.some(change=>change.table==='plan_items'))f.tables.get('plan_cycles').get(cycleId).status='reviewing';return f.gateway.invoke(operation,payload);}};
 const service=createHuicetongService(gateway),draft={categoryId:leaf,content:'并发提交',qualityStandard:'验收',startDate:'2026-09-01',endDate:'2026-09-30',escalated:false,assignees:[{personId:f.person,organizationUnitId:f.team,isLead:true}]};
 await assert.rejects(service['item-create']({id:randomUUID(),requestId:randomUUID(),cycleId,draft},f.employee),/CONFLICT/);
 assert.equal(f.tables.get('plan_items').size,0);
});

test('category cursor follows the storage ordering contract',async()=>{
 const f=fixture();for(let number=0;number<53;number++){const id=randomUUID();f.tables.get('category_nodes').set(id,{id,organization_id:f.department,parent_id:null,level:1,name:`分类 ${String(number).padStart(2,'0')}`,sort:number,enabled:true,revision:1});}
 const first=await f.service['category-list']({organizationId:f.department},f.employee),second=await f.service['category-list']({organizationId:f.department,after:first.nextCursor},f.employee);
 assert.equal(first.rows.length,50);assert.equal(second.rows.length,3);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,53);
});

test('unknown storage write remains unknown and is not replayed',async()=>{
 const f=fixture();const gateway={invoke:async(name)=>{if(name==='platform.app_data.transaction')throw Object.assign(Error('lost response'),{code:'STORAGE_UNCERTAIN',writeOutcome:'unknown'});return f.gateway.invoke(name,{});}};
 const handler=createHuicetongHandlers(gateway).get('cycle-create');
 const result=await handler.execute({id:randomUUID(),requestId:randomUUID(),organizationId:f.department,year:2026,month:9},undefined,f.employee);
 assert.equal(result.error.code,'OPERATION_UNCONFIRMED');assert.equal(result.error.writeOutcome,'unknown');
});
