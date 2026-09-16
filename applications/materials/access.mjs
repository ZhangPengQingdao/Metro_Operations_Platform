import {randomUUID} from 'node:crypto';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const deny=()=>{throw Error('ACCESS_DENIED');};
/** Leadership comes only from a fresh host permission; delegated managers cannot delegate again. */
export function createMaterialsAccess(gateway){
 const data=createAppDataClient(gateway);
 const leader=employee=>employee?.permissions?.includes('app.materials.manage')===true;
 const requireLeader=employee=>{if(!leader(employee))deny();};
 async function manager(employee,signal){
  const {row}=await data.get('managers',employee.personId,signal);
  return row?.active===true&&row.organization_id===employee.organizationUnitId?row:null;
 }
 return {
  async capabilities(employee,signal){const isLeader=leader(employee);return {leader:isLeader,manageMaterials:isLeader||!!await manager(employee,signal)};},
  async guard(employee,signal){
   if(leader(employee))return [];
   const row=await manager(employee,signal);if(!row)deny();
   // Lock and compare the delegation in the same transaction as the stock mutation.
   // Revocation competes on this row; a stale request cannot commit after revocation.
   return [{action:'update',table:'managers',id:row.id,values:{revision:row.revision},expected:{active:true,organization_id:employee.organizationUnitId,revision:row.revision}}];
  },
  async members(input,employee,signal){
   requireLeader(employee);
   if(!input||Object.keys(input).some(k=>k!=='search')||input.search!==undefined&&(typeof input.search!=='string'||input.search.length>100))throw Error('INVALID_INPUT');
   const result=await gateway.invoke('platform.people.members',{organizationUnitId:employee.organizationUnitId,...(input.search?{search:input.search}:{})},signal);
   const rows=[];for(const person of result.rows){const {row}=await data.get('managers',person.id,signal);rows.push({...person,manager:row?.active===true&&row.organization_id===employee.organizationUnitId,revision:row?.revision??null});}return {rows};
  },
  async setManager(input,employee,signal){
   requireLeader(employee);
   if(!input||Object.keys(input).sort().join(',')!=='active,personId,requestId,revision'||!uuid(input.personId)||!uuid(input.requestId)||typeof input.active!=='boolean'||input.revision!==null&&(!Number.isInteger(input.revision)||input.revision<1||input.revision>=2147483647))throw Error('INVALID_INPUT');
   if(input.personId===employee.personId)deny();
   const {rows}=await gateway.invoke('platform.people.members',{organizationUnitId:employee.organizationUnitId,personId:input.personId},signal);
   if(rows.length!==1||rows[0].id!==input.personId||rows[0].organizationUnitId!==employee.organizationUnitId)deny();
   const {row}=await data.get('managers',input.personId,signal);
   if((row?.revision??null)!==input.revision)throw Error('SETTINGS_CONFLICT');
   if(row&&row.organization_id!==employee.organizationUnitId)deny();
   if(row?.active===input.active||!row&&!input.active)throw Error('SETTINGS_CONFLICT');
   const values={active:input.active,organization_id:employee.organizationUnitId,revision:(row?.revision??0)+1};
   await data.transaction(input.requestId,[row?{action:'update',table:'managers',id:input.personId,values,expected:{revision:row.revision,organization_id:employee.organizationUnitId,active:row.active}}:{action:'insert',table:'managers',id:input.personId,values},
    {action:'insert',table:'manager_audit',id:randomUUID(),values:{person_id:input.personId,organization_id:employee.organizationUnitId,operator_id:employee.personId,active:input.active,request_id:input.requestId,created_at:new Date().toISOString()}}],signal);
   return {updated:true};
  },
 };
}
