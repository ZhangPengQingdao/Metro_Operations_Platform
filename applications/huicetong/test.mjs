import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHuicetongService} from './service.mjs';
import {createHuicetongHandlers} from './handlers.mjs';
import {migration} from './schema.mjs';
import {allowsAppResource} from '@metro/platform-sdk/app-backend';
import * as XLSX from 'xlsx';
import {planRows,planWorkbook,planColumns} from './plan-export.mjs';

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
 const employee={personId:person,organizationUnitId:team,businessAuthorization:{revision:randomUUID(),organizations:[{id:department,name:'AFC 维保部'}],grants:['read','fill','manage','review','sign'].map(name=>grant(name))}};
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

async function prepared(){
 const f=fixture(),cycleId=randomUUID(),root=randomUUID(),parent=randomUUID(),leaf=randomUUID();
 await f.service['cycle-create']({id:cycleId,requestId:randomUUID(),organizationId:f.department,year:2026,month:9},f.employee);
 for(const [id,level,parentId] of [[root,1,null],[parent,2,root],[leaf,3,parent]])await f.service['category-upsert']({id,requestId:randomUUID(),organizationId:f.department,level,parentId,name:`分类 ${level}`,sort:level,enabled:true},f.employee);
 const draft={categoryId:leaf,content:'九月工作计划',qualityStandard:'验收完成',startDate:'2026-09-01',endDate:'2026-09-30',escalated:false,remark:'重点',assignees:[{personId:f.person,organizationUnitId:f.team,isLead:true},{personId:f.colleague,organizationUnitId:f.otherTeam,isLead:false}]};
 const itemId=randomUUID();await f.service['item-create']({id:itemId,requestId:randomUUID(),cycleId,draft},f.employee);
 return {...f,cycleId,root,parent,leaf,itemId,draft};
}
const revision=f=>f.tables.get('plan_cycles').get(f.cycleId).revision;
async function bind(f){return f.service['binding-upsert']({id:randomUUID(),requestId:randomUUID(),organizationId:f.department,categoryId:f.parent,personId:f.person,personOrganizationId:f.team},f.employee);}
async function locked(f){
 await bind(f);await f.service['item-submit']({id:f.itemId,requestId:randomUUID(),expectedVersion:1},f.employee);
 await f.service['cycle.submit-review']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 await f.service['item-review']({id:f.itemId,requestId:randomUUID(),expectedVersion:2,action:'approve'},f.employee);
 await f.service['cycle.submit-countersign']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 await f.service['cycle.confirm-signature']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 await f.service['cycle.lock']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
}

test('submission requires a level-2 binding and only the author or manager can submit',async()=>{
 const f=await prepared(),limited={...f.employee,businessAuthorization:{...f.employee.businessAuthorization,grants:f.employee.businessAuthorization.grants.filter(grant=>['app.huicetong.read','app.huicetong.fill'].includes(grant.permission))}};
 await assert.rejects(f.service['item-submit']({id:f.itemId,requestId:randomUUID(),expectedVersion:1},limited),error=>error.message==='BINDING_MISSING'&&error.details.includes('分类 2'));
 await bind(f);const other={...limited,personId:f.colleague,organizationUnitId:f.otherTeam};
 await assert.rejects(f.service['item-submit']({id:f.itemId,requestId:randomUUID(),expectedVersion:1},other),/ACCESS_DENIED/);
 await assert.rejects(f.service['item-submit']({id:f.itemId,requestId:randomUUID(),expectedVersion:1},{...other,businessAuthorization:{...other.businessAuthorization,grants:[]}}),/ACCESS_DENIED/);
 await f.service['item-submit']({id:f.itemId,requestId:randomUUID(),expectedVersion:1},limited);
 assert.equal(f.tables.get('review_records').size,1);
 await assert.rejects(f.service['item-submit']({id:f.itemId,requestId:randomUUID(),expectedVersion:1},limited),/CONFLICT/);
});

test('review is scoped to a binding, requires reviewing, and a return comment',async()=>{
 const f=await prepared();await bind(f);await f.service['item-submit']({id:f.itemId,requestId:randomUUID(),expectedVersion:1},f.employee);
 await assert.rejects(f.service['item-review']({id:f.itemId,requestId:randomUUID(),expectedVersion:2,action:'approve'},f.employee),/REVIEW_NOT_OPEN/);
 await f.service['cycle.submit-review']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 const reviewer={...f.employee,personId:f.colleague,organizationUnitId:f.otherTeam,businessAuthorization:{...f.employee.businessAuthorization,grants:f.employee.businessAuthorization.grants.filter(grant=>['app.huicetong.read','app.huicetong.review'].includes(grant.permission))}};
 await assert.rejects(f.service['item-review']({id:f.itemId,requestId:randomUUID(),expectedVersion:2,action:'approve'},reviewer),/ACCESS_DENIED/);
 await assert.rejects(f.service['item-review']({id:f.itemId,requestId:randomUUID(),expectedVersion:2,action:'return',comment:''},f.employee),/INVALID_INPUT/);
 await f.service['item-review']({id:f.itemId,requestId:randomUUID(),expectedVersion:2,action:'return',comment:'请完善标准'},f.employee);
 assert.equal(f.tables.get('plan_items').get(f.itemId).status,'draft');
 await assert.rejects(f.service['item-update']({id:f.itemId,requestId:randomUUID(),expectedVersion:3,draft:f.draft},f.employee),/CYCLE_LOCKED/);
 await f.service['cycle.return-draft']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 assert.ok([...f.tables.get('audit_events').values()].some(row=>row.action==='return-notification-pending'));
 await f.service['item-update']({id:f.itemId,requestId:randomUUID(),expectedVersion:3,draft:f.draft},f.employee);
 await assert.rejects(f.service['item-update']({id:f.itemId,requestId:randomUUID(),expectedVersion:3,draft:f.draft},f.employee),/CONFLICT/);
});

test('signature fallback is audited and locking atomically starts approved items',async()=>{
 const f=await prepared();await bind(f);await f.service['item-submit']({id:f.itemId,requestId:randomUUID(),expectedVersion:1},f.employee);
 await f.service['cycle.submit-review']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 await assert.rejects(f.service['cycle.submit-countersign']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee),/REVIEW_PENDING/);
 await f.service['item-review']({id:f.itemId,requestId:randomUUID(),expectedVersion:2,action:'approve'},f.employee);
 await f.service['cycle.submit-countersign']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 await assert.rejects(f.service['cycle.lock']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee),/SIGNATURE_PENDING/);
 await f.service['cycle.confirm-signature']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 assert.equal((await f.service['cycle.signature-status']({cycleId:f.cycleId},f.employee)).status,'completed');
 await assert.rejects(f.service['cycle.lock']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)-1},f.employee),/CONFLICT/);
 await f.service['cycle.lock']({cycleId:f.cycleId,requestId:randomUUID(),expectedRevision:revision(f)},f.employee);
 assert.equal(f.tables.get('plan_items').get(f.itemId).status,'in_progress');
 assert.ok([...f.tables.get('audit_events').values()].some(row=>row.action==='signature-confirmed-fallback'));
 await assert.rejects(f.service['item-create']({id:randomUUID(),cycleId:f.cycleId,requestId:randomUUID(),draft:f.draft},f.employee),/CYCLE_LOCKED/);
});

test('escalated changes wait for owner countersign, ordinary changes apply after review',async()=>{
 const f=await prepared();await locked(f);const version=f.tables.get('plan_items').get(f.itemId).version;
 const ordinary=randomUUID();await f.service['change.create']({id:ordinary,itemId:randomUUID(),cycleId:f.cycleId,requestId:randomUUID(),type:'add',draft:f.draft},f.employee);
 await f.service['change.review']({id:ordinary,requestId:randomUUID(),action:'approve'},f.employee);
 assert.ok(f.tables.get('plan_items').size===2);
 const escalated=randomUUID();await f.service['change.create']({id:escalated,itemId:f.itemId,cycleId:f.cycleId,requestId:randomUUID(),type:'update',expectedVersion:version,draft:{...f.draft,escalated:true,content:'拟提报中心'}},f.employee);
 await f.service['change.review']({id:escalated,requestId:randomUUID(),action:'approve'},f.employee);
 assert.equal(f.tables.get('plan_items').get(f.itemId).content,'九月工作计划');
 const noSign={...f.employee,businessAuthorization:{...f.employee.businessAuthorization,grants:f.employee.businessAuthorization.grants.filter(grant=>grant.permission!=='app.huicetong.sign')}};
 await assert.rejects(f.service['change.countersign']({id:escalated,requestId:randomUUID()},noSign),/ACCESS_DENIED/);
 await f.service['change.countersign']({id:escalated,requestId:randomUUID()},f.employee);
 assert.equal(f.tables.get('plan_items').get(f.itemId).content,'拟提报中心');
 assert.equal((await f.service['change.list']({cycleId:f.cycleId},f.employee)).rows.length,2);
});

test('xlsx export preserves ten columns, merged headers, dates, names, and escalated prefix',async()=>{
 const f=await prepared(),entry=f.tables.get('plan_items').get(f.itemId);entry.escalated=true;
 const rows=planRows([entry],'escalated');assert.deepEqual(rows[0],[1,'分类 1','分类 2','分类 3','九月工作计划','验收完成','2026-09-01','2026-09-30','张三、李四','拟提报中心计划；重点']);
 const workbook=planWorkbook('AFC 维保部9月份工作计划',[...rows,[2,...rows[0].slice(1)]]);
 const decoded=XLSX.read(XLSX.write(workbook,{bookType:'xlsx',type:'buffer'}),{type:'buffer'}).Sheets['月度工作计划'];
 assert.deepEqual(XLSX.utils.sheet_to_json(decoded,{header:1})[1],planColumns);
 assert.equal(decoded['!merges'].length,3);assert.equal(decoded.A1.v,'AFC 维保部9月份工作计划');assert.equal(decoded.G3.v,'2026-09-01');
 const exported=await f.service['export.plan']({cycleId:f.cycleId,scope:'escalated',requestId:randomUUID()},f.employee);
 assert.equal(exported.count,1);assert.ok(exported.base64.length>0);
 assert.ok([...f.tables.get('audit_events').values()].some(row=>row.action==='export'&&row.after.scope==='escalated'));
});

test('33 plan rows export as a single worksheet with two vertical category merges',async()=>{
 const f=await prepared(),base=f.tables.get('plan_items').get(f.itemId);
 for(let index=1;index<33;index++){const id=randomUUID();f.tables.get('plan_items').set(id,{...base,id,content:`九月条目 ${index}`,created_at:new Date(Date.UTC(2026,8,1,0,index)).toISOString()});}
 const result=await f.service['export.plan']({cycleId:f.cycleId,scope:'all',requestId:randomUUID()},f.employee);
 assert.equal(result.count,33);
 const book=XLSX.read(Buffer.from(result.base64,'base64'),{type:'buffer'}),sheet=book.Sheets['月度工作计划'];
 assert.equal(XLSX.utils.sheet_to_json(sheet,{header:1}).length,35);
 assert.deepEqual(sheet['!merges'].map(merge=>[merge.s.r,merge.e.r]),[[0,0],[2,34],[2,34]]);
});
