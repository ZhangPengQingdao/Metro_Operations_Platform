import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMaterialsService} from './service.mjs';
function fixture(){
 let tables={materials:new Map(),movements:new Map(),reversals:new Map(),managers:new Map(),manager_audit:new Map()};const spent=new Set();let writes=0,unknown=false;
 const employee={personId:randomUUID(),organizationUnitId:randomUUID()};
 const members=new Map();
 const gateway={async invoke(operation,p){
  if(operation==='platform.people.members')return {rows:[...members.values()].filter(row=>row.organizationUnitId===p.organizationUnitId&&(!p.personId||row.id===p.personId))};
  if(operation==='platform.app_data.get')return {row:structuredClone(tables[p.table].get(p.id)??null)};
  if(operation==='platform.app_data.list')return {rows:[...tables[p.table].values()].filter(r=>p.filters.every(f=>r[f.column]===f.value)),nextCursor:null};
  assert.equal(operation,'platform.app_data.transaction');writes++;
  if(spent.has(p.requestId))throw Error('STORAGE_REQUEST_ALREADY_RECORDED');spent.add(p.requestId);
  const next=structuredClone(tables);
  for(const op of p.operations){const rows=next[op.table],row=rows.get(op.id);
   if(op.action==='insert'){if(row)throw Error('STORAGE_CONFLICT');rows.set(op.id,{id:op.id,...op.values});}
   else{assert.equal(op.action,'update');if(!row||Object.entries(op.expected).some(([k,v])=>row[k]!==v))throw Error('STORAGE_CONFLICT');rows.set(op.id,{...row,...op.values});}
  }
  tables=next;if(unknown)throw Error('STORAGE_WRITE_UNCERTAIN');return {ok:true};
 }};
 const service=createMaterialsService(gateway);
 return {employee,service,gateway,members,get tables(){return tables;},get writes(){return writes;},uncertain(){unknown=true;},async stock(){const {id}=await service.create({requestId:randomUUID(),name:'Bolt',sku:'B1',unit:'个'},employee);return id;}};
}
test('inbound/outbound/reversal preserve original ledger and reject duplicate reversal',async()=>{
 const f=fixture(),id=await f.stock();const inbound=await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:10},f.employee);
 const original=structuredClone(f.tables.movements.get(inbound.id));
 const out=await f.service.move({requestId:randomUUID(),materialId:id,direction:'out',quantity:4},f.employee);
 await assert.rejects(f.service.reverse({requestId:randomUUID(),movementId:inbound.id,reason:'wrong'},f.employee),/INSUFFICIENT_STOCK/);
 await f.service.reverse({requestId:randomUUID(),movementId:out.id,reason:'wrong'},f.employee);
 await f.service.reverse({requestId:randomUUID(),movementId:inbound.id,reason:'wrong'},f.employee);
 assert.equal(f.tables.materials.get(id).quantity,0);assert.deepEqual(f.tables.movements.get(inbound.id),original);
 await assert.rejects(f.service.reverse({requestId:randomUUID(),movementId:out.id,reason:'again'},f.employee),/ALREADY_REVERSED/);
 assert.equal(f.tables.movements.size,4);
});
test('concurrent deductions have one winner and one ledger entry',async()=>{
 const f=fixture(),id=await f.stock();await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:10},f.employee);
 const result=await Promise.allSettled([1,2].map(()=>f.service.move({requestId:randomUUID(),materialId:id,direction:'out',quantity:7},f.employee)));
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.tables.materials.get(id).quantity,3);assert.equal(f.tables.movements.size,2);
});
test('organization isolation and input identity spoofing reject before writes',async()=>{
 const f=fixture(),id=await f.stock(),other={...f.employee,organizationUnitId:randomUUID()};
 await assert.rejects(f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:1},other),/MATERIAL_DENIED/);
 await assert.rejects(f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:1,operator_id:randomUUID()},f.employee),/INVALID_INPUT/);
 assert.deepEqual((await f.service.list({kind:'materials'},other)).rows,[]);assert.equal(f.writes,1);
});
test('uncertain committed operation is not automatically retried',async()=>{
 const f=fixture(),id=await f.stock();f.uncertain();
 await assert.rejects(f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:2},f.employee),/STORAGE_WRITE_UNCERTAIN/);
 assert.equal(f.writes,2);assert.equal(f.tables.materials.get(id).quantity,2);assert.equal(f.tables.movements.size,1);
});
test('outbound correction can only reverse the same employee outbound within the workgroup',async()=>{
 const f=fixture(),id=await f.stock();await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:10},f.employee);
 const out=await f.service.move({requestId:randomUUID(),materialId:id,direction:'out',quantity:2},f.employee);
 const other={...f.employee,personId:randomUUID()};
 await assert.rejects(f.service.reverse({requestId:randomUUID(),movementId:out.id,reason:'not mine'},other,undefined,{expectedKind:'out',ownOnly:true}),/MOVEMENT_DENIED/);
 await assert.rejects(f.service.reverse({requestId:randomUUID(),movementId:out.id,reason:'wrong route'},f.employee,undefined,{expectedKind:'in',ownOnly:false}),/MOVEMENT_DENIED/);
 await f.service.reverse({requestId:randomUUID(),movementId:out.id,reason:'correct'},f.employee,undefined,{expectedKind:'out',ownOnly:true});assert.equal(f.tables.materials.get(id).quantity,10);
});
test('handler route fixes direction and rejects client overrides',async()=>{
 const {createMaterialsHandlers}=await import('./handlers.mjs');let calls=0;
 const handlers=createMaterialsHandlers({invoke:async()=>{calls++;throw Error('not expected');}});
 const result=await handlers.get('outbound').execute({direction:'in'},new AbortController().signal,{personId:randomUUID(),organizationUnitId:randomUUID()});
 assert.equal(result.error.code,'INVALID_INPUT');assert.equal(calls,0);assert.equal(handlers.has('move'),false);assert.equal(handlers.has('reverse'),false);
});
test('only the leader delegates to active same-workgroup members; managers cannot delegate',async()=>{
 const {createMaterialsAccess}=await import('./access.mjs'),f=fixture(),access=createMaterialsAccess(f.gateway);
 const leader={...f.employee,permissions:['app.materials.manage']},member={...f.employee,personId:randomUUID()},outsider={id:randomUUID(),organizationUnitId:randomUUID()};
 f.members.set(member.personId,{id:member.personId,name:'Member',employeeNo:'E1',organizationUnitId:member.organizationUnitId});f.members.set(outsider.id,outsider);
 const change={requestId:randomUUID(),personId:member.personId,active:true,revision:null};
 await assert.rejects(access.setManager(change,member),/ACCESS_DENIED/);
 await assert.rejects(access.setManager({...change,personId:outsider.id},leader),/ACCESS_DENIED/);
 await access.setManager(change,leader);assert.deepEqual(await access.capabilities(member),{leader:false,manageMaterials:true});
 await assert.rejects(access.members({},member),/ACCESS_DENIED/);
 await assert.rejects(access.setManager({...change,requestId:randomUUID(),active:false,revision:1},member),/ACCESS_DENIED/);
 await assert.rejects(access.setManager({...change,requestId:randomUUID()},leader),/SETTINGS_CONFLICT/);
 await access.setManager({...change,requestId:randomUUID(),active:false,revision:1},leader);
 await assert.rejects(access.guard(member),/ACCESS_DENIED/);assert.equal(f.tables.manager_audit.size,2);
 const moved={...member,organizationUnitId:randomUUID()};assert.equal((await access.capabilities(moved)).manageMaterials,false);
});
test('manager revocation races with inbound: stale delegation cannot commit stock or ledger',async()=>{
 const {createMaterialsAccess}=await import('./access.mjs'),{createMaterialsHandlers}=await import('./handlers.mjs');
 const f=fixture(),access=createMaterialsAccess(f.gateway),leader={...f.employee,permissions:['app.materials.manage']},member={...f.employee,personId:randomUUID()};
 const id=await f.stock();f.members.set(member.personId,{id:member.personId,organizationUnitId:member.organizationUnitId});
 await access.setManager({requestId:randomUUID(),personId:member.personId,active:true,revision:null},leader);
 const gateway={async invoke(operation,params,signal){if(operation==='platform.app_data.transaction'){await access.setManager({requestId:randomUUID(),personId:member.personId,active:false,revision:1},leader);}return f.gateway.invoke(operation,params,signal);}};
 const result=await createMaterialsHandlers(gateway).get('inbound').execute({requestId:randomUUID(),materialId:id,quantity:3},undefined,member);
 assert.equal(result.ok,false);assert.equal(f.tables.materials.get(id).quantity,0);assert.equal(f.tables.movements.size,0);
});
test('manager performs inbound but ordinary member and spoofed leadership are denied',async()=>{
 const {createMaterialsAccess}=await import('./access.mjs'),{createMaterialsHandlers}=await import('./handlers.mjs');
 const f=fixture(),access=createMaterialsAccess(f.gateway),leader={...f.employee,permissions:['app.materials.manage']},member={...f.employee,personId:randomUUID()},handlers=createMaterialsHandlers(f.gateway);
 const id=await f.stock(),payload={requestId:randomUUID(),materialId:id,quantity:3};
 assert.equal((await handlers.get('inbound').execute(payload,undefined,member)).error.code,'ACCESS_DENIED');
 f.members.set(member.personId,{id:member.personId,organizationUnitId:member.organizationUnitId});
 await access.setManager({requestId:randomUUID(),personId:member.personId,active:true,revision:null},leader);
 assert.equal((await handlers.get('inbound').execute(payload,undefined,member)).ok,true);assert.equal(f.tables.materials.get(id).quantity,3);
 assert.equal((await handlers.get('inbound').execute({...payload,permissions:['app.materials.manage']},undefined,member)).error.code,'INVALID_INPUT');
});
