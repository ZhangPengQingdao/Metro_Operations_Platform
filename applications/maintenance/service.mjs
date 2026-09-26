import {randomUUID} from 'node:crypto';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
import {allowed,scope} from './access.mjs';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Error(code);};
const text=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||value.trim())&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const finiteShare=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0.05&&value<=0.95;
const status=items=>items.every(item=>item.status==='completed')?'completed':'pending';

function validatePlan(input,previous,now,newId){
 if(!object(input)||!uuid(input.organizationId)||!day(input.scheduledDate)||!text(input.stationName,100,true)||input.stationId!=null&&!uuid(input.stationId)||!text(input.deviceTypeName,100,true)||!text(input.content,500)||!Array.isArray(input.items)||input.items.length<1||input.items.length>100)fail('INVALID_INPUT');
 const oldItems=new Map(previous?.items.map(item=>[item.id,item])??[]),seen=new Set();
 const items=input.items.map(item=>{
  if(!object(item)||item.id!=null&&!uuid(item.id)||!text(item.deviceNumber,100,true)||item.operatorId!=null&&!uuid(item.operatorId)||item.secondaryOperatorId!=null&&!uuid(item.secondaryOperatorId)||!['pending','completed'].includes(item.status))fail('INVALID_INPUT');
  const id=item.id??newId(),old=oldItems.get(id);
  if(seen.has(id)||item.id&&previous&&!old||item.id&&!previous||item.secondaryOperatorId&&!item.operatorId||item.secondaryOperatorId===item.operatorId&&item.secondaryOperatorId||item.status==='completed'&&!item.operatorId)fail('INVALID_INPUT');
  seen.add(id);
  if(old?.status==='completed'&&item.status!=='completed')fail('COMPLETED_PROTECTED');
  const share=item.secondaryOperatorId?(item.operatorShare??0.5):item.operatorId?1:null;
  if(item.secondaryOperatorId&&!finiteShare(share)||item.operatorShare!=null&&typeof item.operatorShare!=='number')fail('INVALID_INPUT');
  return {id,deviceNumber:item.deviceNumber.trim(),operatorId:item.operatorId??null,operatorName:old&&old.operatorId===item.operatorId?old.operatorName??'':'',secondaryOperatorId:item.secondaryOperatorId??null,secondaryOperatorName:old&&old.secondaryOperatorId===item.secondaryOperatorId?old.secondaryOperatorName??'':'',operatorShare:share,secondaryOperatorShare:item.secondaryOperatorId?Number((1-share).toFixed(4)):null,status:item.status,completedAt:item.status==='completed'?(old?.completedAt??now):null};
 });
 if(previous?.items.some(item=>item.status==='completed'&&!seen.has(item.id)))fail('COMPLETED_PROTECTED');
 return {organization_id:input.organizationId,scheduled_date:input.scheduledDate,station_id:input.stationId??null,station_name:input.stationName.trim(),device_type_name:input.deviceTypeName.trim(),content:input.content.trim(),items};
}

export function createMaintenanceService(gateway,{clock=()=>new Date(),newId=randomUUID}={}){
 const data=createAppDataClient(gateway);
 const identity=employee=>{if(!employee||!uuid(employee.personId)||!uuid(employee.organizationUnitId)||!employee.businessAuthorization)fail('EMPLOYEE_REQUIRED');return employee;};
 const canTarget=(employee,name,org)=>{const grant=employee.businessAuthorization.grants.find(item=>item.permission===`app.maintenance.${name}`);return !!grant&&(grant.all||grant.organizationIds.includes(org)||grant.self&&org===employee.organizationUnitId);};
 const target=(employee,name,org)=>{if(!canTarget(employee,name,org))fail('ACCESS_DENIED');};
 const current=async(id,employee,name,signal)=>{if(!uuid(id))fail('INVALID_INPUT');const {row}=await data.get('plans',id,signal);if(!row||row.deleted_at||!allowed(employee,name,row))fail('ACCESS_DENIED');return row;};
 const write=async(requestId,operations,signal)=>{if(Buffer.byteLength(JSON.stringify({requestId,operations}))>16384)fail('PLAN_TOO_LARGE');try{return await data.transaction(requestId,operations,signal);}catch(error){if(error?.code==='STORAGE_CONFLICT'&&error.writeOutcome==='not_started')fail('CONFLICT');throw error;}};
 async function list(input,employee,signal,name='read'){
  identity(employee);
  if(!object(input)||input.organizationId!=null&&!uuid(input.organizationId)||input.status!=null&&!['all','pending','completed'].includes(input.status)||input.stationName!=null&&!text(input.stationName,100,true)||input.search!=null&&!text(input.search,100)||input.sort!=null&&!['asc','desc'].includes(input.sort)||input.dateFrom!=null&&!day(input.dateFrom)||input.dateTo!=null&&!day(input.dateTo)||input.dateFrom&&input.dateTo&&input.dateFrom>input.dateTo||input.after!=null&&(!object(input.after)||typeof input.after.value!=='string'||!uuid(input.after.id))||input.pageSize!=null&&(!Number.isInteger(input.pageSize)||input.pageSize<1||input.pageSize>50))fail('INVALID_INPUT');
  const filters=[{column:'deleted_at',value:null}];
  if(input.organizationId){target(employee,name,input.organizationId);filters.push({column:'organization_id',value:input.organizationId});}
  if(input.status&&input.status!=='all')filters.push({column:'status',value:input.status});
  if(input.stationName)filters.push({column:'station_name',value:input.stationName});
  const query={...scope(employee,name),filters,order:{column:'scheduled_date',direction:input.sort??'asc'},...(input.search?.trim()?{search:{column:'search_text',text:input.search.trim().toLowerCase()}}:{}),...(input.dateFrom||input.dateTo?{range:{column:'scheduled_date',...(input.dateFrom?{from:input.dateFrom}:{}),...(input.dateTo?{to:input.dateTo}:{})}}:{}),...(input.after?{after:input.after}:{})};
  let pageSize=input.pageSize??20;
  for(;;){
   try{return await data.list('plans',{...query,pageSize},signal);}
   catch(error){if(error?.code!=='STORAGE_RESULT_LIMIT'||pageSize===1)throw error;pageSize=Math.max(1,Math.floor(pageSize/2));}
  }
 }
 async function save(input,employee,signal,mode){
  identity(employee);
  if(!object(input)||!uuid(input.requestId)||!uuid(input.id)||!object(input.plan)||mode==='update'&&(!Number.isInteger(input.revision)||input.revision<1))fail('INVALID_INPUT');
  const previous=mode==='update'?await current(input.id,employee,'update',signal):null;
  if(previous&&previous.revision!==input.revision)fail('CONFLICT');
  const now=clock().toISOString(),value=validatePlan(input.plan,previous,now,newId);
  if(previous){if(value.organization_id!==previous.organization_id)fail('ACCESS_DENIED');}else target(employee,'create',value.organization_id);
  if(value.station_id){const station=await gateway.invoke('platform.locations.get',{id:value.station_id},signal);if(station.status!=='active'||station.locationType!=='station'||station.name!==value.station_name)fail('INVALID_STATION');}
  const personIds=[...new Set(value.items.flatMap(item=>[item.operatorId&&!item.operatorName?item.operatorId:null,item.secondaryOperatorId&&!item.secondaryOperatorName?item.secondaryOperatorId:null]).filter(Boolean))];
  const people=[];
  for(let start=0;start<personIds.length;start+=50){const page=await gateway.invoke('platform.people.members',{organizationUnitId:value.organization_id,personIds:personIds.slice(start,start+50)},signal);people.push(...page.rows);}
  for(const item of value.items){
   if(item.operatorId&&!item.operatorName){const person=people.find(person=>person.id===item.operatorId);if(!person)fail('INVALID_PERSON');item.operatorName=person.name;}
   if(item.secondaryOperatorId&&!item.secondaryOperatorName){const person=people.find(person=>person.id===item.secondaryOperatorId);if(!person)fail('INVALID_PERSON');item.secondaryOperatorName=person.name;}
  }
  const values={...value,status:status(value.items),search_text:[value.station_name,value.device_type_name,value.content,...value.items.flatMap(item=>[item.deviceNumber,item.operatorName,item.secondaryOperatorName])].join(' ').toLowerCase(),created_by:previous?.created_by??employee.personId,created_at:previous?.created_at??now,updated_by:employee.personId,updated_at:now,revision:(previous?.revision??0)+1,intent_id:input.requestId,deleted_at:null,deleted_by:null};
  await write(input.requestId,[{action:previous?'update':'insert',table:'plans',id:input.id,values,...(previous?{expected:{revision:previous.revision,deleted_at:null}}:{})}],signal);
  return {id:input.id,revision:values.revision};
 }
 return Object.freeze({
  async session(_input,employee){identity(employee);return {personId:employee.personId,organizationId:employee.organizationUnitId,organizations:employee.businessAuthorization.organizations,permissions:employee.businessAuthorization.grants.map(item=>item.permission)};},
  async catalog(input,employee,signal){identity(employee);if(!object(input)||input.organizationId!=null&&!uuid(input.organizationId)||input.stationSearch!=null&&!text(input.stationSearch,100)||input.personSearch!=null&&!text(input.personSearch,100)||input.assetSearch!=null&&!text(input.assetSearch,100)||input.stationId!=null&&!uuid(input.stationId)||input.assetTypeName!=null&&!text(input.assetTypeName,100))fail('INVALID_INPUT');const org=input.organizationId??employee.organizationUnitId;
   if(!['read','create','update'].some(name=>canTarget(employee,name,org)))fail('ACCESS_DENIED');
   const people=await gateway.invoke('platform.people.members',{organizationUnitId:org,...(input.personSearch?{search:input.personSearch}:{})},signal);
   const locations=await gateway.invoke('platform.locations.list',{pageSize:50,status:'active',...(input.stationSearch?{search:input.stationSearch}:{})},signal).catch(()=>null);
   const assets=await gateway.invoke('platform.assets.list',{pageSize:50,organizationUnitId:org,lifecycleState:'active',...(input.assetSearch?{search:input.assetSearch}:{}),...(input.stationId?{locationId:input.stationId}:{}),...(input.assetTypeName?{typeName:input.assetTypeName}:{})},signal).catch(()=>null);
   return {people:people.rows,stations:locations?.rows.filter(row=>row.locationType==='station')??[],assets:assets?.rows??[],stationLookupAvailable:!!locations,assetLookupAvailable:!!assets};
  },
  list,
  async export(input,employee,signal){return list(input,employee,signal,'export');},
  async detail(input,employee,signal){identity(employee);return current(input.id,employee,'read',signal);},
  async create(input,employee,signal){return save(input,employee,signal,'create');},
  async update(input,employee,signal){return save(input,employee,signal,'update');},
  async delete(input,employee,signal){identity(employee);if(!object(input)||!uuid(input.requestId)||!uuid(input.id)||!Number.isInteger(input.revision)||input.revision<1)fail('INVALID_INPUT');const row=await current(input.id,employee,'delete',signal);if(row.revision!==input.revision)fail('CONFLICT');if(row.items.some(item=>item.status==='completed'))fail('COMPLETED_PROTECTED');const now=clock().toISOString();await write(input.requestId,[{action:'update',table:'plans',id:row.id,expected:{revision:row.revision,deleted_at:null},values:{deleted_at:now,deleted_by:employee.personId,updated_at:now,updated_by:employee.personId,revision:row.revision+1,intent_id:input.requestId}}],signal);return {id:row.id,deleted:true};}
 });
}
