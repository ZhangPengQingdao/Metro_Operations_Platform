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
   identity(employee);keys(input,['requestId','name','sku','unit']);
   if(!uuid(input.requestId)||!text(input.name,100)||!text(input.sku,64)||!text(input.unit,20))fail('INVALID_INPUT');
   const id=newId();await data.transaction(input.requestId,[{action:'insert',table:'materials',id,values:record(employee,{request_id:input.requestId,name:input.name.trim(),sku:input.sku.trim(),unit:input.unit.trim(),quantity:0,version:0})}],signal);return {id};
  },
  async move(input,employee,signal){
   identity(employee);keys(input,['requestId','materialId','direction','quantity'],['remark','receiver']);
   if(!uuid(input.requestId)||!['in','out'].includes(input.direction)||!Number.isInteger(input.quantity)||input.quantity<1||input.quantity>2147483647||input.remark!==undefined&&!text(input.remark,500)||input.receiver!==undefined&&!text(input.receiver,100))fail('INVALID_INPUT');
   const row=await material(input.materialId,employee,signal),delta=input.direction==='in'?input.quantity:-input.quantity,next=row.quantity+delta;
   if(next<0)fail('INSUFFICIENT_STOCK');if(next>2147483647||row.version===2147483647)fail('QUANTITY_LIMIT');
   const id=newId();await data.transaction(input.requestId,[
    {action:'update',table:'materials',id:row.id,values:{quantity:next,version:row.version+1},expected:{quantity:row.quantity,version:row.version,organization_id:employee.organizationUnitId}},
    {action:'insert',table:'movements',id,values:record(employee,{request_id:input.requestId,material_id:row.id,delta,kind:input.direction,reverses_id:null,remark:input.remark??null,receiver:input.receiver??null})},
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
   if(!['materials','movements'].includes(input.kind)||input.afterId!==undefined&&!uuid(input.afterId)||input.pageSize!==undefined&&(!Number.isInteger(input.pageSize)||input.pageSize<1||input.pageSize>50)||input.search!==undefined&&(!text(input.search,100)||input.kind!=='materials')||input.materialId!==undefined&&(!uuid(input.materialId)||input.kind!=='movements'))fail('INVALID_INPUT');
   const filters=[{column:'organization_id',value:employee.organizationUnitId}];if(input.materialId)filters.push({column:'material_id',value:input.materialId});
   return data.list(input.kind,{filters,...(input.afterId?{afterId:input.afterId}:{}),...(input.pageSize?{pageSize:input.pageSize}:{}),...(input.search?{search:{column:'name',text:input.search}}:{})},signal);
  },
 });
}
