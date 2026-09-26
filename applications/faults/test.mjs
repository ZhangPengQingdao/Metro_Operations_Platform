import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFaultService} from './service.mjs';
import {createFaultHandlers} from './handlers.mjs';
import {parseSlip} from './slip.mjs';

function fixture(){
 const org=randomUUID(),otherOrg=randomUUID(),personId=randomUUID(),otherPerson=randomUUID(),locationId=randomUUID();
 const grants=['read','create','update','export','delete'].map(name=>({permission:'app.faults.'+name,all:false,self:false,organizationIds:[org]}));
 const employee={personId,organizationUnitId:org,businessAuthorization:{revision:randomUUID(),organizations:[{id:org,name:'一工班'}],grants}};
 const rows=new Map(),writes=[];
 const gateway={async invoke(operation,p){
  if(operation==='platform.people.members')return {rows:[{id:personId,name:'张三',employeeNo:'1',organizationUnitId:org},{id:otherPerson,name:'李四',employeeNo:'2',organizationUnitId:org}].filter(row=>row.organizationUnitId===p.organizationUnitId&&(!p.personId||p.personId===row.id))};
  if(operation==='platform.locations.get')return {id:locationId,name:'测试站',status:'active',locationType:'station'};
  if(operation==='platform.locations.list')return {rows:[{id:locationId,name:'测试站',status:'active',locationType:'station'}]};
  if(operation==='platform.app_data.get')return {row:structuredClone(rows.get(p.id)??null)};
  if(operation==='platform.app_data.list'){
   const filtered=[...rows.values()].filter(row=>p.filters.every(item=>row[item.column]===item.value)&&(!p.anyOf||p.anyOf.some(group=>group.every(item=>row[item.column]===item.value)))&&(!p.search||row[p.search.column].includes(p.search.text))&&(!p.range||(!p.range.from||row[p.range.column]>=p.range.from)&&(!p.range.to||row[p.range.column]<=p.range.to))).sort((a,b)=>b.occurred_order.localeCompare(a.occurred_order));
   return {rows:filtered.slice(0,p.pageSize),nextCursor:null};
  }
  assert.equal(operation,'platform.app_data.transaction');writes.push(p);
  for(const item of p.operations){const previous=rows.get(item.id);if(item.action==='insert'){assert.equal(previous,undefined);rows.set(item.id,{id:item.id,...item.values});}else{assert.equal(item.action,'update');assert.ok(previous);if(Object.entries(item.expected).some(([key,value])=>previous[key]!==value))throw Error('STORAGE_CONFLICT');rows.set(item.id,{...previous,...item.values});}}
  return {results:[]};
 }};
 const service=createFaultService(gateway,{clock:()=>new Date('2026-09-25T01:00:00Z')});
 const form={organizationId:org,occurredAt:'2026-09-25T00:00:00+08:00',stationId:locationId,stationName:'测试站',deviceTypeName:'TVM',deviceNumber:'01',reporter:'张三',handlerId:personId,description:'无法售票',reason:'',solution:'',arrivalAt:null,fixedAt:null,status:'pending',powerSwitchRelated:'',source:'manual'};
 return {org,otherOrg,personId,otherPerson,employee,locationId,rows,writes,service,form,gateway};
}

test('record lifecycle enforces organization, version and soft deletion',async()=>{
 const f=fixture(),id=randomUUID();await f.service.create({requestId:randomUUID(),id,record:f.form},f.employee);
 assert.equal(f.rows.get(id).created_by,f.personId);
 assert.equal((await f.service.list({},f.employee)).rows.length,1);
 assert.equal((await f.service.list({search:'tvM'},f.employee)).rows.length,1);
 assert.equal((await f.service.list({search:'别的车站'},f.employee)).rows.length,0);
 await assert.rejects(f.service.update({requestId:randomUUID(),id,revision:1,record:{...f.form,organizationId:f.otherOrg}},f.employee),/ACCESS_DENIED/);
 await assert.rejects(f.service.update({requestId:randomUUID(),id,revision:1,record:{...f.form,status:'fixed'}},f.employee),/FIXED_DETAILS_REQUIRED/);
 const fixed={...f.form,status:'fixed',arrivalAt:'2026-09-25T00:10:00+08:00',fixedAt:'2026-09-25T00:30:00+08:00'};
 await f.service.update({requestId:randomUUID(),id,revision:1,record:fixed},f.employee);
 assert.equal(f.rows.get(id).quality,'issues');
 await assert.rejects(f.service.update({requestId:randomUUID(),id,revision:1,record:fixed},f.employee),/CONFLICT/);
 await f.service.delete({requestId:randomUUID(),id,revision:2},f.employee);
 assert.equal(f.rows.get(id).voided,true);
 assert.equal((await f.service.list({},f.employee)).rows.length,0);
 await assert.rejects(f.service.detail({id},f.employee),/ACCESS_DENIED/);
 assert.equal(f.writes.length,3);
});

test('list and export apply grant scope before returning rows',async()=>{
 const f=fixture(),id=randomUUID(),foreignId=randomUUID();await f.service.create({requestId:randomUUID(),id,record:f.form},f.employee);
 f.rows.set(foreignId,{...f.rows.get(id),id:foreignId,organization_id:f.otherOrg});
 assert.equal((await f.service.list({},f.employee)).rows.length,1);
 assert.equal((await f.service.export({dateFrom:'2026-09-25',dateTo:'2026-09-25'},f.employee)).rows.length,1);
 await assert.rejects(f.service.detail({id:foreignId},f.employee),/ACCESS_DENIED/);
 await assert.rejects(f.service.create({requestId:randomUUID(),id:randomUUID(),record:{...f.form,organizationId:f.otherOrg}},f.employee),/ACCESS_DENIED/);
 const noDelete={...f.employee,businessAuthorization:{...f.employee.businessAuthorization,grants:f.employee.businessAuthorization.grants.filter(g=>g.permission!=='app.faults.delete')}};
 await assert.rejects(f.service.delete({requestId:randomUUID(),id,revision:1},noDelete),/ACCESS_DENIED/);
});

test('self-only creation cannot assign another organization',async()=>{
 const f=fixture();const selfOnly={...f.employee,businessAuthorization:{...f.employee.businessAuthorization,grants:[{permission:'app.faults.create',all:false,self:true,organizationIds:[]}]}};
 await assert.rejects(f.service.create({requestId:randomUUID(),id:randomUUID(),record:{...f.form,organizationId:f.otherOrg}},selfOnly),/ACCESS_DENIED/);
 await f.service.create({requestId:randomUUID(),id:randomUUID(),record:f.form},selfOnly);
 assert.equal(f.writes.length,1);
});

test('invalid time order and spoofed identity fail without a write',async()=>{
 const f=fixture();await assert.rejects(f.service.create({requestId:randomUUID(),id:randomUUID(),record:{...f.form,arrivalAt:'2026-09-24T23:00:00+08:00'}},f.employee),/INVALID_TIMELINE/);
 const result=await createFaultHandlers(f.gateway).get('create').execute({requestId:randomUUID(),id:randomUUID(),record:f.form,personId:f.otherPerson},undefined,f.employee);
 assert.equal(result.error.code,'INVALID_INPUT');assert.equal(result.error.writeOutcome,'not_started');assert.equal(f.writes.length,0);
});

test('pasted slip produces editable fields without declaring an AI match',()=>{
 const parsed=parseSlip('接报时间：2026-09-25 08:00\n车站：测试站\n设备编号：TVM01\n故障现象：无法售票\n是否完全修复：否');
 assert.equal(parsed.form.occurredAt,'2026-09-25T08:00');assert.equal(parsed.form.status,'pending');assert.equal(parsed.form.stationName,'测试站');assert.equal(parsed.form.deviceNumber,'TVM01');
 assert.equal(parsed.form.stationId,undefined);
});
