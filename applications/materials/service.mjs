import {randomUUID} from 'node:crypto';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fail=code=>{throw Error(code);};
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
const keys=(v,required,optional=[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||required.some(k=>!(k in v))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail('INVALID_INPUT');};
/** Business rules depend only on the public SDK. No platform database connection. */
export function createMaterialsService(gateway,{clock=()=>new Date(),newId=randomUUID}={}){
 const data=createAppDataClient(gateway);
 const identity=employee=>{if(!employee||!uuid(employee.personId)||!uuid(employee.organizationUnitId))fail('EMPLOYEE_REQUIRED');return employee;};
 const material=async(id,employee,signal)=>{
  if(!uuid(id))fail('INVALID_INPUT');const {row}=await data.get('materials',id,signal);
  if(!row||row.organization_id!==employee.organizationUnitId)fail('MATERIAL_DENIED');
  if(!Number.isInteger(row.quantity)||row.quantity<0||row.quantity>2147483647||!Number.isInteger(row.version)||row.version<0)fail('INVALID_STORED_DATA');return row;
 };
 const record=(employee,values)=>({...values,operator_id:employee.personId,organization_id:employee.organizationUnitId,created_at:clock().toISOString()});
 return Object.freeze({
  async create(input,employee,signal){
   identity(employee);keys(input,['requestId','name','sku','unit'],['quantity']);
   if(!uuid(input.requestId)||!text(input.name,100)||!text(input.sku,64)||!text(input.unit,20)||input.quantity!==undefined&&(!Number.isInteger(input.quantity)||input.quantity<0||input.quantity>2147483647))fail('INVALID_INPUT');
   const id=newId(),quantity=input.quantity??0,operations=[{action:'insert',table:'materials',id,values:record(employee,{request_id:input.requestId,name:input.name.trim(),sku:input.sku.trim(),unit:input.unit.trim(),quantity,version:0})}];
   if(quantity)operations.push({action:'insert',table:'movements',id:newId(),values:record(employee,{request_id:input.requestId,material_id:id,delta:quantity,kind:'in',reverses_id:null,remark:'初始入库',receiver:null})});
   await data.transaction(input.requestId,operations,signal);return {id};
  },
  async update(input,employee,signal){
   identity(employee);keys(input,['requestId','materialId','name','sku','unit','version']);
   if(!uuid(input.requestId)||!text(input.name,100)||!text(input.sku,64)||!text(input.unit,20)||!Number.isInteger(input.version)||input.version<0)fail('INVALID_INPUT');
   const row=await material(input.materialId,employee,signal);
   if(row.version!==input.version)fail('MATERIAL_CONFLICT');if(row.version===2147483647)fail('QUANTITY_LIMIT');
   await data.transaction(input.requestId,[{action:'update',table:'materials',id:row.id,values:{name:input.name.trim(),sku:input.sku.trim(),unit:input.unit.trim(),version:row.version+1},expected:{organization_id:employee.organizationUnitId,version:row.version}}],signal);return {id:row.id};
  },
  async move(input,employee,signal){
   identity(employee);keys(input,['requestId','materialId','direction','quantity'],['remark','receiver','receiverId']);
   if(!uuid(input.requestId)||!['in','out'].includes(input.direction)||!Number.isInteger(input.quantity)||input.quantity<1||input.quantity>2147483647||input.remark!==undefined&&!text(input.remark,500)||input.receiver!==undefined&&!text(input.receiver,100)||input.receiverId!==undefined&&!uuid(input.receiverId))fail('INVALID_INPUT');
   const row=await material(input.materialId,employee,signal),delta=input.direction==='in'?input.quantity:-input.quantity,next=row.quantity+delta;
   if(next<0)fail('INSUFFICIENT_STOCK');if(next>2147483647||row.version===2147483647)fail('QUANTITY_LIMIT');
   const id=newId();await data.transaction(input.requestId,[
    {action:'update',table:'materials',id:row.id,values:{quantity:next,version:row.version+1},expected:{quantity:row.quantity,version:row.version,organization_id:employee.organizationUnitId}},
    {action:'insert',table:'movements',id,values:record(employee,{request_id:input.requestId,material_id:row.id,delta,kind:input.direction,reverses_id:null,remark:input.remark??null,receiver:input.receiver??null,...(input.receiverId?{receiver_id:input.receiverId}:{})})},
   ],signal);return {id,quantity:next};
  },
  async correct(input,employee,signal,policy){
   identity(employee);keys(input,['requestId','movementId','quantity'],['receiver','remark','receiverId']);
   if(!uuid(input.requestId)||!uuid(input.movementId)||!Number.isInteger(input.quantity)||input.quantity<1||input.quantity>2147483647||input.receiver!==undefined&&!text(input.receiver,100)||input.receiverId!==undefined&&!uuid(input.receiverId)||input.remark!==undefined&&!text(input.remark,500))fail('INVALID_INPUT');
   const {row:original}=await data.get('movements',input.movementId,signal);
   if(!original||original.organization_id!==employee.organizationUnitId||original.kind!==policy.expectedKind||policy.ownOnly&&original.operator_id!==employee.personId)fail('MOVEMENT_DENIED');
   if(original.reverses_id!==null)fail('REVERSAL_NOT_ALLOWED');
   if((await data.get('reversals',original.id,signal)).row)fail('ALREADY_REVERSED');
   const row=await material(original.material_id,employee,signal),delta=original.kind==='in'?input.quantity:-input.quantity,next=row.quantity-original.delta+delta;
   if(!Number.isInteger(original.delta)||original.delta===0||Math.abs(original.delta)>2147483647)fail('INVALID_STORED_DATA');
   if(next<0)fail('INSUFFICIENT_STOCK');if(next>2147483647||row.version===2147483647)fail('QUANTITY_LIMIT');
   const reversalId=newId(),id=newId();
   await data.transaction(input.requestId,[
    {action:'update',table:'materials',id:row.id,values:{quantity:next,version:row.version+1},expected:{quantity:row.quantity,version:row.version,organization_id:employee.organizationUnitId}},
    {action:'insert',table:'reversals',id:original.id,values:{movement_id:reversalId}},
    {action:'insert',table:'movements',id:reversalId,values:record(employee,{request_id:input.requestId,material_id:row.id,delta:-original.delta,kind:'reversal',reverses_id:original.id,remark:'修改记录',receiver:null})},
    {action:'insert',table:'movements',id,values:{...record(employee,{request_id:newId(),material_id:row.id,delta,kind:original.kind,reverses_id:null,remark:input.remark??null,receiver:input.receiver??null,...(input.receiverId?{receiver_id:input.receiverId}:{})}),operator_id:original.operator_id}},
   ],signal);return {id,quantity:next};
  },
  async reverse(input,employee,signal,policy){
   identity(employee);keys(input,['requestId','movementId','reason']);if(!uuid(input.requestId)||!uuid(input.movementId)||!text(input.reason,500))fail('INVALID_INPUT');
   const {row:original}=await data.get('movements',input.movementId,signal);
   if(!original||original.organization_id!==employee.organizationUnitId)fail('MOVEMENT_DENIED');
   if(policy&&(original.kind!==policy.expectedKind||policy.ownOnly&&original.operator_id!==employee.personId))fail('MOVEMENT_DENIED');
   if(!['in','out'].includes(original.kind)||original.reverses_id!==null)fail('REVERSAL_NOT_ALLOWED');
   const {row:marker}=await data.get('reversals',original.id,signal);if(marker)fail('ALREADY_REVERSED');
   const row=await material(original.material_id,employee,signal),delta=-original.delta,next=row.quantity+delta;
   if(!Number.isInteger(delta)||delta===0||Math.abs(delta)>2147483647)fail('INVALID_STORED_DATA');
   if(next<0)fail('INSUFFICIENT_STOCK');if(next>2147483647||row.version===2147483647)fail('QUANTITY_LIMIT');
   const id=newId();await data.transaction(input.requestId,[
    {action:'update',table:'materials',id:row.id,values:{quantity:next,version:row.version+1},expected:{quantity:row.quantity,version:row.version,organization_id:employee.organizationUnitId}},
    {action:'insert',table:'reversals',id:original.id,values:{movement_id:id}},
    {action:'insert',table:'movements',id,values:record(employee,{request_id:input.requestId,material_id:row.id,delta,kind:'reversal',reverses_id:original.id,remark:input.reason,receiver:null})},
   ],signal);return {id,quantity:next};
  },
  async list(input,employee,signal){
   identity(employee);keys(input,['kind'],['afterId','pageSize','search','materialId']);
   if(!['materials','movements','consumptions'].includes(input.kind)||input.afterId!==undefined&&!uuid(input.afterId)||input.pageSize!==undefined&&(!Number.isInteger(input.pageSize)||input.pageSize<1||input.pageSize>50)||input.search!==undefined&&!text(input.search,100)||input.materialId!==undefined&&(!uuid(input.materialId)||!['movements','consumptions'].includes(input.kind)))fail('INVALID_INPUT');
   const filters=[{column:'organization_id',value:employee.organizationUnitId}];if(input.materialId)filters.push({column:'material_id',value:input.materialId});
   if(input.kind==='consumptions')filters.push({column:'kind',value:'out'});
   const result=await data.list(input.kind==='consumptions'?'movements':input.kind,{filters,...(input.afterId?{afterId:input.afterId}:{}),...(input.pageSize?{pageSize:input.pageSize}:{}),...(input.search?{search:{column:input.kind==='materials'?'name':'remark',text:input.search}}:{})},signal);
   if(input.kind==='materials')return result;
   const labels=new Map();for(const id of new Set(result.rows.map(row=>row.material_id)))labels.set(id,await material(id,employee,signal));
   const rows=[];for(const row of result.rows){const reversed=!!(await data.get('reversals',row.id,signal)).row;if(input.kind==='consumptions'&&reversed)continue;rows.push({...row,material_name:labels.get(row.material_id).name,material_sku:labels.get(row.material_id).sku,unit:labels.get(row.material_id).unit,reversed,own:row.operator_id===employee.personId});}return {...result,rows};
  },
 });
}
