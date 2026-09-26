import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMaintenanceService} from './service.mjs';
import {createMaintenanceHandlers} from './handlers.mjs';
import * as XLSX from 'xlsx';
import {parsePlanImportFile} from './import.mjs';

test('CSV import keeps device numbers as text and Excel import reads the template',async()=>{
 const csv=new File(['日期,车站,设备类型,设备编号,检修内容\n2026-09-27,测试站,TVM,01/02,季度检修'],'plans.csv',{type:'text/csv'});
 const [csvPlan]=await parsePlanImportFile(csv,'workgroup');
 assert.equal(csvPlan.scheduledDate,'2026-09-27');
 assert.deepEqual(csvPlan.items.map(item=>item.deviceNumber),['01','02']);
 const book=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet([{日期:'2026-09-28',车站:'二号站',设备类型:'AGM',设备编号:'03/04',检修内容:'例检'}]),'计划');
 const excel=new File([XLSX.write(book,{bookType:'xlsx',type:'array'})],'plans.xlsx');
 const [excelPlan]=await parsePlanImportFile(excel,'workgroup');
 assert.deepEqual(excelPlan.items.map(item=>item.deviceNumber),['03','04']);
 assert.equal(excelPlan.stationName,'二号站');
});

test('plan import rejects malformed rows before any write',async()=>{
 const invalid=new File(['日期,车站,设备类型,设备编号\n2026-09-27,测试站,TVM,'],'bad.csv');
 await assert.rejects(parsePlanImportFile(invalid,'workgroup'),/第 2 行/);
 const rows=['日期,车站,设备类型,设备编号',...Array.from({length:201},(_,i)=>`2026-09-27,测试站,TVM,${i+1}`)];
 await assert.rejects(parsePlanImportFile(new File([rows.join('\n')],'too-many.csv'),'workgroup'),/1–200/);
});

function fixture(){
 const org=randomUUID(),otherOrg=randomUUID(),person=randomUUID(),colleague=randomUUID(),station=randomUUID();
 const employee={personId:person,organizationUnitId:org,businessAuthorization:{organizations:[{id:org,name:'一工班'}],grants:['read','create','update','delete','export'].map(name=>({permission:`app.maintenance.${name}`,all:false,self:false,organizationIds:[org]}))}};
 const rows=new Map(),writes=[];
 const gateway={async invoke(operation,payload){
  if(operation==='platform.people.members')return {rows:[{id:person,name:'张三',employeeNo:'1'},{id:colleague,name:'李四',employeeNo:'2'}].filter(row=>!payload.personIds||payload.personIds.includes(row.id))};
  if(operation==='platform.locations.get')return {id:station,name:'测试站',status:'active',locationType:'station'};
  if(operation==='platform.locations.list')return {rows:[{id:station,name:'测试站',status:'active',locationType:'station'}]};
  if(operation==='platform.assets.list')return {rows:[{id:randomUUID(),assetCode:'TVM-01',typeName:'TVM',locationId:station}]};
  if(operation==='platform.app_data.get')return {row:structuredClone(rows.get(payload.id)??null)};
  if(operation==='platform.app_data.list'){
   const filtered=[...rows.values()].filter(row=>payload.filters.every(item=>row[item.column]===item.value)&&(!payload.anyOf||payload.anyOf.some(group=>group.every(item=>row[item.column]===item.value)))&&(!payload.search||row[payload.search.column].includes(payload.search.text))&&(!payload.range||(!payload.range.from||row[payload.range.column]>=payload.range.from)&&(!payload.range.to||row[payload.range.column]<=payload.range.to)));
   filtered.sort((a,b)=>payload.order.direction==='asc'?a.scheduled_date.localeCompare(b.scheduled_date):b.scheduled_date.localeCompare(a.scheduled_date));
   return {rows:filtered.slice(0,payload.pageSize),nextCursor:null};
  }
  assert.equal(operation,'platform.app_data.transaction');writes.push(payload);
  for(const change of payload.operations){const old=rows.get(change.id);if(change.action==='insert'){assert.equal(old,undefined);rows.set(change.id,{id:change.id,...change.values});}else{if(Object.entries(change.expected).some(([key,value])=>old[key]!==value)){const error=Error('conflict');error.code='STORAGE_CONFLICT';error.writeOutcome='not_started';throw error;}rows.set(change.id,{...old,...change.values});}}
  return {results:[]};
 }};
 const service=createMaintenanceService(gateway,{clock:()=>new Date('2026-09-26T04:00:00Z')});
 const plan={organizationId:org,scheduledDate:'2026-09-27',stationId:station,stationName:'测试站',deviceTypeName:'TVM',content:'季度检修',items:[{deviceNumber:'01',operatorId:person,secondaryOperatorId:null,status:'pending'},{deviceNumber:'02',operatorId:colleague,secondaryOperatorId:null,status:'pending'}]};
 return {org,otherOrg,person,colleague,station,employee,rows,writes,service,plan,gateway};
}

test('grouped plan lifecycle tracks each device and protects completed work',async()=>{
 const f=fixture(),id=randomUUID();await f.service.create({requestId:randomUUID(),id,plan:f.plan},f.employee);
 const row=f.rows.get(id);assert.equal(row.items.length,2);assert.equal(row.status,'pending');assert.equal(row.created_by,f.person);
 assert.equal((await f.service.list({status:'pending',search:'tvM'},f.employee)).rows.length,1);
 const update={...f.plan,items:row.items.map((item,index)=>({id:item.id,deviceNumber:item.deviceNumber,operatorId:item.operatorId,secondaryOperatorId:null,status:index===0?'completed':'pending'}))};
 await f.service.update({requestId:randomUUID(),id,revision:1,plan:update},f.employee);
 assert.equal(f.rows.get(id).items[0].completedAt,'2026-09-26T04:00:00.000Z');
 await assert.rejects(f.service.update({requestId:randomUUID(),id,revision:2,plan:{...update,items:update.items.slice(1)}},f.employee),/COMPLETED_PROTECTED/);
 await assert.rejects(f.service.delete({requestId:randomUUID(),id,revision:2},f.employee),/COMPLETED_PROTECTED/);
 await assert.rejects(f.service.update({requestId:randomUUID(),id,revision:1,plan:update},f.employee),/CONFLICT/);
 await f.service.update({requestId:randomUUID(),id,revision:2,plan:{...update,items:update.items.map(item=>({...item,status:'completed'}))}},f.employee);
 assert.equal((await f.service.list({status:'completed'},f.employee)).rows.length,1);
 assert.equal((await f.service.export({dateFrom:'2026-09-27',dateTo:'2026-09-27'},f.employee)).rows.length,1);
});

test('authorization and directory identity are checked before writes',async()=>{
 const f=fixture(),id=randomUUID();
 await assert.rejects(f.service.create({requestId:randomUUID(),id,plan:{...f.plan,organizationId:f.otherOrg}},f.employee),/ACCESS_DENIED/);
 await assert.rejects(f.service.create({requestId:randomUUID(),id,plan:{...f.plan,items:[{deviceNumber:'01',operatorId:randomUUID(),status:'completed'}]}},f.employee),/INVALID_PERSON/);
 assert.equal(f.writes.length,0);
 await f.service.create({requestId:randomUUID(),id,plan:f.plan},f.employee);
 f.rows.set(randomUUID(),{...f.rows.get(id),id:randomUUID(),organization_id:f.otherOrg});
 assert.equal((await f.service.list({},f.employee)).rows.length,1);
 const readOnly={...f.employee,businessAuthorization:{...f.employee.businessAuthorization,grants:f.employee.businessAuthorization.grants.filter(item=>item.permission!=='app.maintenance.update')}};
 await assert.rejects(f.service.update({requestId:randomUUID(),id,revision:1,plan:f.plan},readOnly),/ACCESS_DENIED/);
 const result=await createMaintenanceHandlers(f.gateway).get('create').execute({requestId:randomUUID(),id:randomUUID(),plan:f.plan,personId:f.colleague},undefined,f.employee);
 assert.equal(result.error.code,'INVALID_INPUT');assert.equal(result.error.writeOutcome,'not_started');
});

test('pending plans can be soft deleted but no longer read',async()=>{
 const f=fixture(),id=randomUUID();await f.service.create({requestId:randomUUID(),id,plan:f.plan},f.employee);
 await f.service.delete({requestId:randomUUID(),id,revision:1},f.employee);
 assert.equal((await f.service.list({},f.employee)).rows.length,0);
 await assert.rejects(f.service.detail({id},f.employee),/ACCESS_DENIED/);
});

test('self-only creator cannot assign a plan to another organization',async()=>{
 const f=fixture(),selfOnly={...f.employee,businessAuthorization:{...f.employee.businessAuthorization,grants:[{permission:'app.maintenance.create',all:false,self:true,organizationIds:[]}]}};
 await assert.rejects(f.service.create({requestId:randomUUID(),id:randomUUID(),plan:{...f.plan,organizationId:f.otherOrg}},selfOnly),/ACCESS_DENIED/);
 await assert.rejects(f.service.catalog({organizationId:f.otherOrg},selfOnly),/ACCESS_DENIED/);
 assert.equal((await f.service.catalog({organizationId:f.org},selfOnly)).people.length,2);
 await f.service.create({requestId:randomUUID(),id:randomUUID(),plan:f.plan},selfOnly);
 assert.equal(f.writes.length,1);
});

test('large grouped plans reduce the read page size after a bounded result error',async()=>{
 const f=fixture(),id=randomUUID(),sizes=[],invoke=f.gateway.invoke;
 await f.service.create({requestId:randomUUID(),id,plan:f.plan},f.employee);
 f.gateway.invoke=async(operation,payload)=>{
  if(operation==='platform.app_data.list'){
   sizes.push(payload.pageSize);
   if(payload.pageSize>3){const error=Error('result too large');error.code='STORAGE_RESULT_LIMIT';throw error;}
  }
  return invoke(operation,payload);
 };
 assert.equal((await f.service.list({},f.employee)).rows.length,1);
 assert.deepEqual(sizes,[20,10,5,2]);
});

test('unchanged historical assignees remain editable after leaving the current workgroup',async()=>{
 const f=fixture(),id=randomUUID(),invoke=f.gateway.invoke;
 await f.service.create({requestId:randomUUID(),id,plan:f.plan},f.employee);
 const row=f.rows.get(id);
 f.gateway.invoke=(operation,payload)=>operation==='platform.people.members'?Promise.resolve({rows:[]}):invoke(operation,payload);
 await f.service.update({requestId:randomUUID(),id,revision:1,plan:{...f.plan,content:'补充记录',items:row.items.map(item=>({id:item.id,deviceNumber:item.deviceNumber,operatorId:item.operatorId,secondaryOperatorId:item.secondaryOperatorId,status:'completed'}))}},f.employee);
 assert.equal(f.rows.get(id).items[0].operatorName,'张三');
 assert.equal(f.rows.get(id).items[0].status,'completed');
});

test('oversized plan is rejected before the managed storage write',async()=>{
 const f=fixture(),plan={...f.plan,items:Array.from({length:100},(_,index)=>({deviceNumber:String(index).padStart(3,'0')+'X'.repeat(97),operatorId:null,secondaryOperatorId:null,status:'pending'}))};
 await assert.rejects(f.service.create({requestId:randomUUID(),id:randomUUID(),plan},f.employee),/PLAN_TOO_LARGE/);
 assert.equal(f.writes.length,0);
});
