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
  if(operation==='platform.app_data.read_batch')return {results:p.operations.map(item=>({rows:item.ids.map(id=>tables[item.table].get(id)).filter(Boolean).map(row=>structuredClone(row))}))};
  if(operation==='platform.app_data.list')return {rows:[...tables[p.table].values()].filter(r=>p.filters.every(f=>r[f.column]===f.value)&&(!p.anyOf||p.anyOf.some(group=>group.every(f=>r[f.column]===f.value)))),nextCursor:null};
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
test('record modification atomically replaces quantity and preserves the original record',async()=>{
 const f=fixture(),id=await f.stock();await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:10},f.employee);
 const out=await f.service.move({requestId:randomUUID(),materialId:id,direction:'out',quantity:4},f.employee),original=structuredClone(f.tables.movements.get(out.id));
 const replacement=await f.service.correct({requestId:randomUUID(),movementId:out.id,quantity:2,receiver:'张三',remark:'修改领用数量'},f.employee,undefined,{expectedKind:'out',ownOnly:true});
 assert.equal(f.tables.materials.get(id).quantity,8);assert.deepEqual(f.tables.movements.get(out.id),original);assert.equal(f.tables.movements.get(replacement.id).delta,-2);assert.ok(f.tables.reversals.has(out.id));
 await assert.rejects(f.service.correct({requestId:randomUUID(),movementId:out.id,quantity:1},f.employee,undefined,{expectedKind:'out',ownOnly:true}),/ALREADY_REVERSED/);
 await f.service.correct({requestId:randomUUID(),movementId:replacement.id,quantity:3},f.employee,undefined,{expectedKind:'out',ownOnly:true});assert.equal(f.tables.materials.get(id).quantity,7);
});
test('record modification rejects other employees and insufficient stock without partial writes',async()=>{
 const f=fixture(),id=await f.stock();const inbound=await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:10},f.employee);
 const out=await f.service.move({requestId:randomUUID(),materialId:id,direction:'out',quantity:7},f.employee),writes=f.writes;
 await assert.rejects(f.service.correct({requestId:randomUUID(),movementId:out.id,quantity:2},{...f.employee,personId:randomUUID()},undefined,{expectedKind:'out',ownOnly:true}),/MOVEMENT_DENIED/);
 await assert.rejects(f.service.correct({requestId:randomUUID(),movementId:inbound.id,quantity:6},f.employee,undefined,{expectedKind:'in',ownOnly:false}),/INSUFFICIENT_STOCK/);
 assert.equal(f.writes,writes);assert.equal(f.tables.materials.get(id).quantity,3);assert.equal(f.tables.reversals.size,0);
});
test('initial stock and inbound record are committed together',async()=>{
 const f=fixture(),result=await f.service.create({requestId:randomUUID(),name:'螺栓',sku:'M8',unit:'个',quantity:10},f.employee);
 assert.equal(f.writes,1);assert.equal(f.tables.materials.get(result.id).quantity,10);assert.equal([...f.tables.movements.values()][0].delta,10);
});
test('movement presentation respects the single-owner storage session and includes edit ownership',async()=>{
 const f=fixture(),id=await f.stock();await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:5},f.employee);await f.service.move({requestId:randomUUID(),materialId:id,direction:'out',quantity:2},f.employee);
 let active=false,reads=0;const service=createMaterialsService({async invoke(...args){assert.equal(active,false,'storage session must not overlap');active=true;try{reads++;await new Promise(resolve=>setImmediate(resolve));return await f.gateway.invoke(...args);}finally{active=false;}}});
 const result=await service.list({kind:'movements'},f.employee);assert.equal(result.rows.length,2);assert.equal(result.rows[0].material_name,'Bolt');assert.equal(result.rows[1].own,true);
 assert.equal(reads,2);
});
test('bootstrap returns session and first page in one application request',async()=>{
 const f=fixture(),id=await f.stock(),operations=[];
 const {createMaterialsHandlers}=await import('./handlers.mjs');
 const handlers=createMaterialsHandlers({invoke:async(operation,payload,signal)=>{operations.push(operation);return f.gateway.invoke(operation,payload,signal);}});
 const response=await handlers.get('bootstrap').execute({route:'stock'},new AbortController().signal,{...f.employee,permissions:['app.materials.manage']});
 assert.equal(response.ok,true);
 assert.equal(response.result.session.leader,true);
 assert.equal(response.result.page.rows[0].id,id);
 assert.deepEqual(operations,['platform.app_data.list']);
 const recordsOnly={...f.employee,businessAuthorization:{revision:randomUUID(),organizations:[{id:f.employee.organizationUnitId,name:'Team'}],grants:[{permission:'app.materials.read-records',all:false,self:false,organizationIds:[f.employee.organizationUnitId]}]}};
 assert.equal((await handlers.get('bootstrap').execute({route:'home'},new AbortController().signal,recordsOnly)).ok,true);
 const denied=await handlers.get('bootstrap').execute({route:'stock'},new AbortController().signal,recordsOnly);
 assert.equal(denied.ok,false);
 assert.equal(denied.error.code,'ACCESS_DENIED');
});
test('material editing preserves stock, rejects stale versions, and requires a manager',async()=>{
 const f=fixture(),id=await f.stock(),{createMaterialsHandlers}=await import('./handlers.mjs'),handlers=createMaterialsHandlers(f.gateway);
 const input={requestId:randomUUID(),materialId:id,name:'新名称',sku:'M8',unit:'件',version:0};
 assert.equal((await handlers.get('update').execute(input,undefined,f.employee)).error.code,'ACCESS_DENIED');
 assert.equal((await handlers.get('update').execute(input,undefined,{...f.employee,permissions:['app.materials.manage']})).ok,true);
 assert.equal(f.tables.materials.get(id).name,'新名称');assert.equal(f.tables.materials.get(id).quantity,0);
 await assert.rejects(f.service.update({...input,requestId:randomUUID()},f.employee),/MATERIAL_CONFLICT/);
 await assert.rejects(f.service.update({...input,requestId:randomUUID(),version:1,quantity:99},f.employee),/INVALID_INPUT/);
});
test('outbound accepts only a directory-confirmed active workgroup recipient',async()=>{
 const f=fixture(),id=await f.stock(),{createMaterialsHandlers}=await import('./handlers.mjs'),handlers=createMaterialsHandlers(f.gateway);
 await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:5},f.employee);
 const recipient={id:randomUUID(),name:'同班人员',employeeNo:'A01',organizationUnitId:f.employee.organizationUnitId};f.members.set(recipient.id,recipient);
 const payload={requestId:randomUUID(),materialId:id,quantity:2,receiverId:recipient.id};
 assert.equal((await handlers.get('outbound').execute({...payload,receiver:'伪造'},undefined,f.employee)).error.code,'INVALID_INPUT');
 assert.equal((await handlers.get('outbound').execute({...payload,receiverId:randomUUID()},undefined,f.employee)).error.code,'ACCESS_DENIED');
 const reply=await handlers.get('outbound').execute(payload,undefined,f.employee);assert.equal(reply.ok,true);assert.equal(f.tables.movements.get(reply.result.id).receiver,'同班人员');assert.equal(f.tables.movements.get(reply.result.id).receiver_id,recipient.id);
 f.members.delete(recipient.id);
 assert.equal((await handlers.get('correct-outbound').execute({requestId:randomUUID(),movementId:reply.result.id,quantity:1,receiverId:recipient.id},undefined,f.employee)).error.code,'ACCESS_DENIED');
});
test('deleting own consumption returns stock once, preserves ledger, and removes it from effective consumption results',async()=>{
 const f=fixture(),id=await f.stock(),{createMaterialsHandlers}=await import('./handlers.mjs'),handlers=createMaterialsHandlers(f.gateway);
 await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:5},f.employee);
 const out=await f.service.move({requestId:randomUUID(),materialId:id,direction:'out',quantity:2},f.employee),original=structuredClone(f.tables.movements.get(out.id));
 assert.equal((await f.service.list({kind:'consumptions'},f.employee)).rows.length,1);
 const payload={requestId:randomUUID(),movementId:out.id,reason:'删除消耗记录，返还库存'};
 assert.equal((await handlers.get('reverse-outbound').execute(payload,undefined,{...f.employee,personId:randomUUID()})).error.code,'MOVEMENT_DENIED');
 assert.equal((await handlers.get('reverse-outbound').execute(payload,undefined,f.employee)).ok,true);
 assert.equal(f.tables.materials.get(id).quantity,5);assert.deepEqual(f.tables.movements.get(out.id),original);
 assert.equal((await f.service.list({kind:'consumptions'},f.employee)).rows.length,0);
 assert.equal((await handlers.get('reverse-outbound').execute({...payload,requestId:randomUUID()},undefined,f.employee)).error.code,'ALREADY_REVERSED');assert.equal(f.tables.materials.get(id).quantity,5);
});
test('ordinary employees can select recipients but cannot manage delegation or supply a foreign group',async()=>{
 const f=fixture(),{createMaterialsHandlers}=await import('./handlers.mjs'),handlers=createMaterialsHandlers(f.gateway);
 f.members.set(f.employee.personId,{id:f.employee.personId,name:'本人',organizationUnitId:f.employee.organizationUnitId});f.members.set(randomUUID(),{id:randomUUID(),organizationUnitId:randomUUID()});
 const result=await handlers.get('recipients').execute({},undefined,f.employee);assert.equal(result.ok,true);assert.equal(result.result.rows.length,1);
 assert.equal((await handlers.get('recipients').execute({organizationUnitId:randomUUID()},undefined,f.employee)).error.code,'INVALID_INPUT');assert.equal((await handlers.get('members').execute({},undefined,f.employee)).error.code,'ACCESS_DENIED');
});
test('leader may correct and delete group consumption while ownership and organization boundaries remain intact',async()=>{
 const f=fixture(),id=await f.stock(),{createMaterialsHandlers}=await import('./handlers.mjs'),handlers=createMaterialsHandlers(f.gateway);
 await f.service.move({requestId:randomUUID(),materialId:id,direction:'in',quantity:8},f.employee);
 const out=await f.service.move({requestId:randomUUID(),materialId:id,direction:'out',quantity:3},f.employee);
 f.members.set(f.employee.personId,{id:f.employee.personId,name:'员工',organizationUnitId:f.employee.organizationUnitId});
 const leader={...f.employee,personId:randomUUID(),permissions:['app.materials.manage']};
 const changed=await handlers.get('correct-outbound').execute({requestId:randomUUID(),movementId:out.id,quantity:2,receiverId:f.employee.personId},undefined,leader);
 assert.equal(changed.ok,true);assert.equal(f.tables.movements.get(changed.result.id).operator_id,f.employee.personId);
 assert.equal((await handlers.get('reverse-outbound').execute({requestId:randomUUID(),movementId:changed.result.id,reason:'删除'},undefined,{...leader,organizationUnitId:randomUUID()})).error.code,'MOVEMENT_DENIED');
 assert.equal((await handlers.get('reverse-outbound').execute({requestId:randomUUID(),movementId:changed.result.id,reason:'删除'},undefined,leader)).ok,true);assert.equal(f.tables.materials.get(id).quantity,8);
});

test('business roles filter list before pagination and preserve source organization on cross-team correction',async()=>{
 const f=fixture(),stock=await f.stock();
 await f.service.move({requestId:randomUUID(),materialId:stock,direction:'in',quantity:10},f.employee);
 const out=await f.service.move({requestId:randomUUID(),materialId:stock,direction:'out',quantity:2},f.employee);
 const manager={...f.employee,personId:randomUUID(),organizationUnitId:randomUUID(),businessAuthorization:{revision:randomUUID(),organizations:[{id:f.employee.organizationUnitId,name:'Team'}],grants:[{permission:'app.materials.read-records',all:false,self:false,organizationIds:[f.employee.organizationUnitId]},{permission:'app.materials.modify-consumption',all:false,self:false,organizationIds:[f.employee.organizationUnitId]}]}};
 const read=createMaterialsService(f.gateway,{permission:'app.materials.read-records'});
 assert.equal((await read.list({kind:'consumptions'},manager)).rows.length,1);
 const modify=createMaterialsService(f.gateway,{permission:'app.materials.modify-consumption'});
 const replacement=await modify.correct({requestId:randomUUID(),movementId:out.id,quantity:3},manager,undefined,{expectedKind:'out',ownOnly:false});
 assert.equal(f.tables.movements.get(replacement.id).organization_id,f.employee.organizationUnitId);
 assert.equal(f.tables.movements.get(replacement.id).operator_id,f.employee.personId);
 assert.equal(f.tables.materials.get(stock).quantity,7);
 manager.businessAuthorization.grants[1]={permission:'app.materials.modify-consumption',all:false,self:true,organizationIds:[]};
 await assert.rejects(modify.correct({requestId:randomUUID(),movementId:replacement.id,quantity:1},manager,undefined,{expectedKind:'out',ownOnly:false}),/MOVEMENT_DENIED/);
 manager.businessAuthorization.grants[0]={permission:'app.materials.read-records',all:false,self:true,organizationIds:[]};
 assert.equal((await read.list({kind:'consumptions'},manager)).rows.length,0);
});
