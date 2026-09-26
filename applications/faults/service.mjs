import {randomUUID} from 'node:crypto';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
import {allowed,requireAllowed,scope} from './business-policy.mjs';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Error(code);};
const short=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||value.trim().length>0)&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&!Number.isNaN(Date.parse(value));
const at=value=>value?new Date(value).toISOString():null;
const dateRange=(from,to)=>({column:'occurred_order',...(from?{from:new Date(from+'T00:00:00+08:00').toISOString()}:{}),...(to?{to:new Date(to+'T23:59:59.999+08:00').toISOString()}:{} )});

function validateForm(input){
 if(!plain(input)||Object.keys(input).some(key=>!['organizationId','occurredAt','stationId','stationName','deviceTypeName','deviceNumber','reporter','handlerId','description','reason','solution','arrivalAt','fixedAt','status','powerSwitchRelated','source'].includes(key)))fail('INVALID_INPUT');
 if(!uuid(input.organizationId)||!iso(input.occurredAt)||!short(input.stationName,100,true)||input.stationId!==null&&input.stationId!==undefined&&!uuid(input.stationId)||!short(input.deviceTypeName,100,true)||!short(input.deviceNumber,100,true)||!short(input.reporter,100,true)||!uuid(input.handlerId)||!short(input.description,2000,true)||!short(input.reason??'',1000)||!short(input.solution??'',1000)||!['pending','fixed'].includes(input.status)||!['','yes','no'].includes(input.powerSwitchRelated??'')||!['manual','slip'].includes(input.source??'manual'))fail('INVALID_INPUT');
 if(input.arrivalAt&&!iso(input.arrivalAt)||input.fixedAt&&!iso(input.fixedAt))fail('INVALID_INPUT');
 const occurred=Date.parse(input.occurredAt),arrival=input.arrivalAt?Date.parse(input.arrivalAt):null,fixed=input.fixedAt?Date.parse(input.fixedAt):null;
 if(arrival!==null&&arrival<occurred||fixed!==null&&fixed<occurred||arrival!==null&&fixed!==null&&fixed<arrival)fail('INVALID_TIMELINE');
 if(input.status==='fixed'&&(arrival===null||fixed===null))fail('FIXED_DETAILS_REQUIRED');
 return {organization_id:input.organizationId,occurred_at:at(input.occurredAt),occurred_order:at(input.occurredAt),search_text:[input.stationName,input.deviceTypeName,input.deviceNumber,input.description,input.reason,input.solution].filter(Boolean).join(' ').toLowerCase(),station_id:input.stationId??null,station_name:input.stationName.trim(),device_type_name:input.deviceTypeName.trim(),device_number:input.deviceNumber.trim(),reporter:input.reporter.trim(),handler_id:input.handlerId,description:input.description.trim(),reason:input.reason?.trim()||null,solution:input.solution?.trim()||null,arrival_at:at(input.arrivalAt),fixed_at:input.status==='fixed'?at(input.fixedAt):null,status:input.status,quality:input.status==='fixed'&&(!input.reason?.trim()||!input.solution?.trim())?'issues':'ok',power_switch_related:input.powerSwitchRelated||null,source:input.source??'manual'};
}

export function createFaultService(gateway,{clock=()=>new Date(),newId=randomUUID}={}){
 const data=createAppDataClient(gateway);
 const write=async(requestId,operations,signal)=>{try{return await data.transaction(requestId,operations,signal);}catch(error){if(error?.code==='STORAGE_CONFLICT'&&error.writeOutcome==='not_started')fail('CONFLICT');throw error;}};
 const identity=employee=>{if(!employee||!uuid(employee.personId)||!uuid(employee.organizationUnitId)||!employee.businessAuthorization)fail('EMPLOYEE_REQUIRED');return employee;};
 const targetOrganization=(employee,name,org)=>{const grant=employee.businessAuthorization.grants.find(item=>item.permission==='app.faults.'+name);if(!grant||!(grant.all||grant.organizationIds.includes(org)||grant.self&&org===employee.organizationUnitId))fail('ACCESS_DENIED');};
 const requireId=value=>{if(!uuid(value))fail('INVALID_INPUT');return value;};
 const stored=async(id,employee,name,signal)=>{const {row}=await data.get('records',requireId(id),signal);if(!row||row.voided||!allowed(employee,name,row))fail('ACCESS_DENIED');return row;};
 const person=async(id,org,signal)=>{const page=await gateway.invoke('platform.people.members',{organizationUnitId:org,personId:id},signal);const row=page.rows.find(item=>item.id===id);if(!row)fail('INVALID_PERSON');return row;};
 const station=async(id,name,signal)=>{if(!id)return {id:null,name};const row=await gateway.invoke('platform.locations.get',{id},signal);if(row.status!=='active'||row.name!==name)fail('INVALID_STATION');return {id:row.id,name:row.name};};
 async function list(input,employee,signal,name='read'){
  identity(employee);if(!plain(input)||Object.keys(input).some(key=>!['organizationId','status','quality','stationName','search','sort','dateFrom','dateTo','after','pageSize'].includes(key)))fail('INVALID_INPUT');
  if(input.organizationId!==undefined&&!uuid(input.organizationId)||input.status!==undefined&&!['all','pending','fixed'].includes(input.status)||input.quality!==undefined&&input.quality!=='issues'||input.stationName!==undefined&&!short(input.stationName,100,true)||input.search!==undefined&&!short(input.search,100,true)||input.sort!==undefined&&!['asc','desc'].includes(input.sort)||input.dateFrom!==undefined&&!day(input.dateFrom)||input.dateTo!==undefined&&!day(input.dateTo)||input.dateFrom&&input.dateTo&&input.dateFrom>input.dateTo||input.after!==undefined&&(!plain(input.after)||typeof input.after.value!=='string'||!uuid(input.after.id))||input.pageSize!==undefined&&(!Number.isInteger(input.pageSize)||input.pageSize<1||input.pageSize>50))fail('INVALID_INPUT');
  const filters=[{column:'voided',value:false}];
  if(input.organizationId){targetOrganization(employee,name,input.organizationId);filters.push({column:'organization_id',value:input.organizationId});}
  if(input.status&&input.status!=='all')filters.push({column:'status',value:input.status});
  if(input.quality)filters.push({column:'quality',value:'issues'});
  if(input.stationName)filters.push({column:'station_name',value:input.stationName});
  return data.list('records',{...scope(employee,name),filters,order:{column:'occurred_order',direction:input.sort??'desc'},...(input.search?{search:{column:'search_text',text:input.search.toLowerCase()}}:{}),...(input.dateFrom||input.dateTo?{range:dateRange(input.dateFrom,input.dateTo)}:{}),...(input.after?{after:input.after}:{}),pageSize:input.pageSize??20},signal);
 }
 return Object.freeze({
  async session(_input,employee){identity(employee);return {personId:employee.personId,organizationId:employee.organizationUnitId,organizations:employee.businessAuthorization.organizations,permissions:employee.businessAuthorization.grants.map(item=>item.permission)};},
  async catalog(input,employee,signal){identity(employee);if(!plain(input)||Object.keys(input).some(key=>!['organizationId','stationSearch','personSearch'].includes(key)))fail('INVALID_INPUT');const org=input.organizationId??employee.organizationUnitId;if(!uuid(org)||!short(input.stationSearch??'',100)||!short(input.personSearch??'',100)||!['read','create','update'].some(name=>{try{targetOrganization(employee,name,org);return true;}catch{return false;}}))fail('ACCESS_DENIED');
   const people=await gateway.invoke('platform.people.members',{organizationUnitId:org,...(input.personSearch?{search:input.personSearch}:{})},signal);
   const locations=await gateway.invoke('platform.locations.list',{pageSize:50,status:'active',...(input.stationSearch?{search:input.stationSearch}:{})},signal).catch(()=>null);
   if(!input.personSearch&&!people.rows.some(row=>row.id===employee.personId)&&org===employee.organizationUnitId){const current=await gateway.invoke('platform.people.members',{organizationUnitId:org,personId:employee.personId},signal);people.rows.push(...current.rows);}
   return {people:people.rows,stations:locations?.rows.filter(row=>row.locationType==='station')??[],stationLookupAvailable:!!locations};
  },
  list,
  async export(input,employee,signal){return list(input,employee,signal,'export');},
  async detail(input,employee,signal){identity(employee);if(!plain(input)||Object.keys(input).some(key=>key!=='id'))fail('INVALID_INPUT');return stored(input.id,employee,'read',signal);},
  async create(input,employee,signal){identity(employee);if(!plain(input)||!uuid(input.requestId)||!uuid(input.id)||!plain(input.record)||Object.keys(input).some(key=>!['requestId','id','record'].includes(key)))fail('INVALID_INPUT');const value=validateForm(input.record);targetOrganization(employee,'create',value.organization_id);const handler=await person(value.handler_id,value.organization_id,signal),location=await station(value.station_id,value.station_name,signal);const now=clock().toISOString();
   const row={...value,station_id:location.id,station_name:location.name,handler_name:handler.name,created_by:employee.personId,created_at:now,updated_by:employee.personId,updated_at:now,revision:1,intent_id:input.requestId,voided:false,voided_by:null,voided_at:null};
   await write(input.requestId,[{action:'insert',table:'records',id:input.id,values:row}],signal);return {id:input.id};
  },
  async update(input,employee,signal){identity(employee);if(!plain(input)||!uuid(input.requestId)||!uuid(input.id)||!Number.isInteger(input.revision)||input.revision<1||!plain(input.record)||Object.keys(input).some(key=>!['requestId','id','revision','record'].includes(key)))fail('INVALID_INPUT');const previous=await stored(input.id,employee,'update',signal);if(previous.revision!==input.revision)fail('CONFLICT');const value=validateForm(input.record);if(value.organization_id!==previous.organization_id)fail('ACCESS_DENIED');const handler=await person(value.handler_id,value.organization_id,signal),location=await station(value.station_id,value.station_name,signal);
   const values={...value,station_id:location.id,station_name:location.name,handler_name:handler.name,updated_by:employee.personId,updated_at:clock().toISOString(),revision:previous.revision+1,intent_id:input.requestId};
   await write(input.requestId,[{action:'update',table:'records',id:input.id,expected:{revision:previous.revision,voided:false},values}],signal);return {id:input.id};
  },
  async delete(input,employee,signal){identity(employee);if(!plain(input)||!uuid(input.requestId)||!uuid(input.id)||!Number.isInteger(input.revision)||input.revision<1||Object.keys(input).some(key=>!['requestId','id','revision'].includes(key)))fail('INVALID_INPUT');const previous=await stored(input.id,employee,'delete',signal);if(previous.revision!==input.revision)fail('CONFLICT');const now=clock().toISOString();await write(input.requestId,[{action:'update',table:'records',id:input.id,expected:{revision:previous.revision,voided:false},values:{voided:true,voided_by:employee.personId,voided_at:now,updated_at:now,updated_by:employee.personId,revision:previous.revision+1,intent_id:input.requestId}}],signal);return {id:input.id};}
 });
}
