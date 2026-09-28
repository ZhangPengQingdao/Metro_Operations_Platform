import {randomUUID} from 'node:crypto';
import {allowsAppResource} from '@metro/platform-sdk/app-backend';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Error(code);};
const validText=(value,max,required=true)=>typeof value==='string'&&value.length<=max&&(!required||value.trim().length>0)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const ownKeys=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const validCursor=value=>value===undefined||object(value)&&ownKeys(value,['id','value'])&&uuid(value.id)&&typeof value.value==='string'&&value.value.length<=1024;
const permission=name=>`app.huicetong.${name}`;
const identity=employee=>{if(!employee||!uuid(employee.personId)||!uuid(employee.organizationUnitId)||!employee.businessAuthorization)fail('EMPLOYEE_REQUIRED');return employee;};
const can=(employee,name,organizationId,owner=null)=>allowsAppResource(employee,permission(name),{organizationUnitId:organizationId,ownerPersonId:owner});
const requireAccess=(employee,name,organizationId,owner=null)=>{if(!can(employee,name,organizationId,owner))fail('ACCESS_DENIED');};
const readableScope=employee=>{
 const grant=employee.businessAuthorization.grants.find(value=>value.permission===permission('read'));
 if(!grant)fail('ACCESS_DENIED');
 if(grant.all)return {};
 const anyOf=grant.organizationIds.map(id=>[{column:'organization_id',value:id}]);
 if(grant.self)anyOf.push([{column:'created_by',value:employee.personId}]);
 if(!anyOf.length)fail('ACCESS_DENIED');
 return {anyOf};
};
const asConflict=error=>{if(error?.code==='STORAGE_CONFLICT'&&error.writeOutcome==='not_started')fail('CONFLICT');throw error;};

export function createHuicetongService(gateway,{clock=()=>new Date(),newId=randomUUID}={}){
 const data=createAppDataClient(gateway);
 const now=()=>clock().toISOString();
 const audit=(organizationId,entityType,entityId,action,employee,requestId,before,after)=>({action:'insert',table:'audit_events',id:newId(),values:{organization_id:organizationId,created_at:now(),entity_type:entityType,entity_id:entityId,action,actor_id:employee.personId,request_id:requestId,before,after}});
 async function write(requestId,operations,signal){
  if(!uuid(requestId)||Buffer.byteLength(JSON.stringify({requestId,operations}))>16_384)fail('ITEM_TOO_LARGE');
  try{return await data.transaction(requestId,operations,signal);}catch(error){asConflict(error);}
 }
 async function cycle(id,employee,name='read',signal){
  if(!uuid(id))fail('INVALID_INPUT');
  const {row}=await data.get('plan_cycles',id,signal);
  if(!row)fail('NOT_FOUND');requireAccess(employee,name,row.organization_id,row.created_by);
  return row;
 }
 async function category(id,organizationId,signal){
  if(!uuid(id))fail('CATEGORY_INVALID');
  const {row}=await data.get('category_nodes',id,signal);
  if(!row||row.organization_id!==organizationId||!row.enabled)fail('CATEGORY_INVALID');
  return row;
 }
 async function categoryPath(id,organizationId,signal){
  const leaf=await category(id,organizationId,signal);
  if(leaf.level!==3||!leaf.parent_id)fail('CATEGORY_INVALID');
  const parent=await category(leaf.parent_id,organizationId,signal);
  if(parent.level!==2||!parent.parent_id)fail('CATEGORY_INVALID');
  const root=await category(parent.parent_id,organizationId,signal);
  if(root.level!==1)fail('CATEGORY_INVALID');
  return {root,parent,leaf};
 }
 async function item(id,employee,signal){
  if(!uuid(id))fail('INVALID_INPUT');
  const {row}=await data.get('plan_items',id,signal);
  if(!row)fail('NOT_FOUND');requireAccess(employee,'read',row.organization_id,row.created_by);
  return row;
 }
 async function resolveAssignees(values,organizationId,signal){
  if(!Array.isArray(values)||values.length<1||values.length>6||values.some(value=>!object(value)||!uuid(value.personId)||!uuid(value.organizationUnitId)||typeof value.isLead!=='boolean')||new Set(values.map(value=>value.personId)).size!==values.length||values.filter(value=>value.isLead).length!==1)fail('INVALID_INPUT');
  const rows=[];
  for(const workgroupId of new Set(values.map(value=>value.organizationUnitId))){
   const context=await gateway.invoke('platform.people.organization_context',{organizationUnitId:workgroupId},signal);
   if(!Array.isArray(context?.organizations)||!context.organizations.some(unit=>unit.id===organizationId)||context.organizations[0]?.unitType!=='workgroup')fail('PERSON_INVALID');
   const personIds=values.filter(value=>value.organizationUnitId===workgroupId).map(value=>value.personId);
   const result=await gateway.invoke('platform.people.members',{organizationUnitId:workgroupId,personIds},signal);
   if(!Array.isArray(result?.rows)||result.rows.length!==personIds.length)fail('PERSON_INVALID');
   rows.push(...result.rows);
  }
  return values.map((value,sort)=>{
   const found=rows.find(row=>row.id===value.personId&&row.organizationUnitId===value.organizationUnitId);
   if(!found||!validText(found.name,120))fail('PERSON_INVALID');
   return {personId:value.personId,organizationUnitId:value.organizationUnitId,personName:found.name,isLead:value.isLead,sort};
  });
 }
 async function isCurrentOrganization(employee,organizationId,signal){
  const context=await gateway.invoke('platform.people.organization_context',{organizationUnitId:employee.organizationUnitId},signal);
  return Array.isArray(context?.organizations)&&context.organizations.some(unit=>unit.id===organizationId);
 }
 function validateDraft(value){
  if(!ownKeys(value,['categoryId','content','qualityStandard','startDate','endDate','assignees','escalated','remark'])||!uuid(value.categoryId)||!validText(value.content,500)||!validText(value.qualityStandard,500)||!day(value.startDate)||!day(value.endDate)||value.startDate>value.endDate||typeof value.escalated!=='boolean'||value.remark!==undefined&&!validText(value.remark,500,false))fail('INVALID_INPUT');
 }
 async function buildDraft(value,organizationId,signal){
  validateDraft(value);
  const [path,assignees]=await Promise.all([categoryPath(value.categoryId,organizationId,signal),resolveAssignees(value.assignees,organizationId,signal)]);
  return {category_id:value.categoryId,root_name:path.root.name,parent_name:path.parent.name,category_name:path.leaf.name,content:value.content.trim(),quality_standard:value.qualityStandard.trim(),start_date:value.startDate,end_date:value.endDate,escalated:value.escalated,remark:value.remark?.trim()||null,lead_person_id:assignees.find(person=>person.isLead).personId,assignees};
 }
 return Object.freeze({
  async session(input,employee){identity(employee);if(!ownKeys(input,[])||Object.keys(input).length)fail('INVALID_INPUT');return {personId:employee.personId,organizationId:employee.organizationUnitId,organizations:employee.businessAuthorization.organizations,permissions:employee.businessAuthorization.grants.map(grant=>grant.permission)};},
  async members(input,employee,signal){identity(employee);if(!ownKeys(input,['organizationId','workgroupId','search'])||!uuid(input.organizationId)||!uuid(input.workgroupId)||input.search!==undefined&&!validText(input.search,100,false))fail('INVALID_INPUT');requireAccess(employee,'read',input.organizationId);
   const context=await gateway.invoke('platform.people.organization_context',{organizationUnitId:input.workgroupId},signal);
   if(!Array.isArray(context?.organizations)||!context.organizations.some(unit=>unit.id===input.organizationId)||context.organizations[0]?.unitType!=='workgroup')fail('ACCESS_DENIED');
   const page=await gateway.invoke('platform.people.members',{organizationUnitId:input.workgroupId,...(input.search?{search:input.search}:{})},signal);
   return {rows:page.rows};},
  async 'cycle-list'(input,employee,signal){identity(employee);if(!ownKeys(input,['organizationId','after'])||input.organizationId!==undefined&&!uuid(input.organizationId)||!validCursor(input.after))fail('INVALID_INPUT');
   if(input.organizationId)requireAccess(employee,'read',input.organizationId);
   return data.list('plan_cycles',{...readableScope(employee),filters:input.organizationId?[{column:'organization_id',value:input.organizationId}]:[],order:{column:'created_at',direction:'desc'},pageSize:50,...(input.after?{after:input.after}:{})},signal);},
  async 'cycle-get'(input,employee,signal){identity(employee);if(!ownKeys(input,['id'])||!uuid(input.id))fail('INVALID_INPUT');return cycle(input.id,employee,'read',signal);},
  async 'cycle-create'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','organizationId','year','month','fillDeadline'])||!uuid(input.id)||!uuid(input.requestId)||!uuid(input.organizationId)||!Number.isInteger(input.year)||input.year<2000||input.year>2100||!Number.isInteger(input.month)||input.month<1||input.month>12||input.fillDeadline!==undefined&&input.fillDeadline!==null&&!day(input.fillDeadline))fail('INVALID_INPUT');
   requireAccess(employee,'manage',input.organizationId);const timestamp=now();
   const row={organization_id:input.organizationId,year:input.year,month:input.month,status:'drafting',fill_deadline:input.fillDeadline??null,created_by:employee.personId,created_at:timestamp,updated_at:timestamp,revision:1,intent_id:input.requestId};
   await write(input.requestId,[{action:'insert',table:'plan_cycles',id:input.id,values:row},audit(input.organizationId,'cycle',input.id,'created',employee,input.requestId,null,{year:input.year,month:input.month})],signal);
   return {id:input.id,revision:1,status:'drafting'};},
  async 'category-list'(input,employee,signal){identity(employee);if(!ownKeys(input,['organizationId','after'])||!uuid(input.organizationId)||!validCursor(input.after))fail('INVALID_INPUT');requireAccess(employee,'read',input.organizationId);return data.list('category_nodes',{filters:[{column:'organization_id',value:input.organizationId}],order:{column:'name',direction:'asc'},pageSize:50,...(input.after?{after:input.after}:{})},signal);},
  async 'category-upsert'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','organizationId','parentId','level','name','sort','enabled','expectedRevision'])||!uuid(input.id)||!uuid(input.requestId)||!uuid(input.organizationId)||!Number.isInteger(input.level)||input.level<1||input.level>3||input.level===1&&input.parentId!==null||input.level>1&&!uuid(input.parentId)||!validText(input.name,100)||!Number.isInteger(input.sort)||input.sort<0||input.sort>10000||typeof input.enabled!=='boolean'||input.expectedRevision!==undefined&&(!Number.isInteger(input.expectedRevision)||input.expectedRevision<1))fail('INVALID_INPUT');
   requireAccess(employee,'manage',input.organizationId);
   if(input.level>1){const parent=await category(input.parentId,input.organizationId,signal);if(parent.level!==input.level-1)fail('CATEGORY_INVALID');}
   const {row:old}=await data.get('category_nodes',input.id,signal);if(old&&(old.organization_id!==input.organizationId||old.parent_id!==input.parentId||old.level!==input.level))fail('ACCESS_DENIED');
   if((old?.revision??undefined)!==input.expectedRevision)fail('CONFLICT');
   const values={organization_id:input.organizationId,parent_id:input.parentId,level:input.level,name:input.name.trim(),sort:input.sort,enabled:input.enabled,created_at:old?.created_at??now(),updated_at:now(),revision:(old?.revision??0)+1};
   await write(input.requestId,[old?{action:'update',table:'category_nodes',id:input.id,values,expected:{revision:old.revision,organization_id:old.organization_id}}:{action:'insert',table:'category_nodes',id:input.id,values},audit(input.organizationId,'category',input.id,old?'updated':'created',employee,input.requestId,old?{name:old.name,enabled:old.enabled}:null,{name:values.name,enabled:values.enabled})],signal);
   return {id:input.id,revision:values.revision};},
  async 'item-list'(input,employee,signal){identity(employee);if(!ownKeys(input,['cycleId','after'])||!uuid(input.cycleId)||!validCursor(input.after))fail('INVALID_INPUT');const parent=await cycle(input.cycleId,employee,'read',signal);return data.list('plan_items',{...readableScope(employee),filters:[{column:'organization_id',value:parent.organization_id},{column:'cycle_id',value:parent.id}],order:{column:'created_at',direction:'desc'},pageSize:20,...(input.after?{after:input.after}:{})},signal);},
  async 'item-get'(input,employee,signal){identity(employee);if(!ownKeys(input,['id'])||!uuid(input.id))fail('INVALID_INPUT');return item(input.id,employee,signal);},
  async 'item-create'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','cycleId','draft'])||!uuid(input.id)||!uuid(input.requestId)||!uuid(input.cycleId))fail('INVALID_INPUT');const parent=await cycle(input.cycleId,employee,'read',signal);
   if(parent.status!=='drafting')fail('CYCLE_LOCKED');if(!can(employee,'manage',parent.organization_id)&&(!can(employee,'fill',parent.organization_id,employee.personId)||!await isCurrentOrganization(employee,parent.organization_id,signal)))fail('ACCESS_DENIED');
   const draft=await buildDraft(input.draft,parent.organization_id,signal),timestamp=now();
   const row={organization_id:parent.organization_id,cycle_id:parent.id,...draft,status:'draft',source:'manual',supervision_entry_id:null,created_by:employee.personId,created_at:timestamp,updated_at:timestamp,version:1,intent_id:input.requestId};
   const assigneeRows=draft.assignees.map(person=>({action:'insert',table:'plan_item_assignees',id:newId(),values:{organization_id:parent.organization_id,item_id:input.id,person_id:person.personId,person_organization_id:person.organizationUnitId,person_name:person.personName,is_lead:person.isLead,sort:person.sort}}));
   await write(input.requestId,[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:parent.organization_id,status:'drafting',revision:parent.revision},values:{revision:parent.revision+1,updated_at:timestamp}},{action:'insert',table:'plan_items',id:input.id,values:row},...assigneeRows,audit(parent.organization_id,'item',input.id,'created',employee,input.requestId,null,{cycleId:parent.id,version:1})],signal);
   return {id:input.id,version:1,status:'draft'};},
  async 'item-update'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','expectedVersion','draft'])||!uuid(input.id)||!uuid(input.requestId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)fail('INVALID_INPUT');
   const old=await item(input.id,employee,signal),parent=await cycle(old.cycle_id,employee,'read',signal);
   if(parent.status!=='drafting'||old.status!=='draft')fail('CYCLE_LOCKED');if(!can(employee,'manage',old.organization_id)&&(!can(employee,'fill',old.organization_id,old.created_by)||!await isCurrentOrganization(employee,old.organization_id,signal)))fail('ACCESS_DENIED');if(old.version!==input.expectedVersion)fail('CONFLICT');
   const draft=await buildDraft(input.draft,old.organization_id,signal);
   const {rows:previous,nextCursor}=await data.list('plan_item_assignees',{filters:[{column:'item_id',value:old.id}],pageSize:20},signal);
   if(nextCursor||previous.length>6||previous.some(row=>row.organization_id!==old.organization_id))fail('CONFLICT');
   const updates=[];for(const row of previous){const next=draft.assignees.find(person=>person.personId===row.person_id);if(!next)updates.push({action:'delete',table:'plan_item_assignees',id:row.id,expected:{item_id:old.id,person_id:row.person_id}});else if(row.is_lead!==next.isLead||row.sort!==next.sort||row.person_name!==next.personName||row.person_organization_id!==next.organizationUnitId)updates.push({action:'update',table:'plan_item_assignees',id:row.id,expected:{item_id:old.id,person_id:row.person_id},values:{is_lead:next.isLead,sort:next.sort,person_name:next.personName,person_organization_id:next.organizationUnitId}});}
   for(const person of draft.assignees)if(!previous.some(row=>row.person_id===person.personId))updates.push({action:'insert',table:'plan_item_assignees',id:newId(),values:{organization_id:old.organization_id,item_id:old.id,person_id:person.personId,person_organization_id:person.organizationUnitId,person_name:person.personName,is_lead:person.isLead,sort:person.sort}});
   const version=old.version+1;
   await write(input.requestId,[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:parent.organization_id,status:'drafting',revision:parent.revision},values:{revision:parent.revision+1,updated_at:now()}},{action:'update',table:'plan_items',id:old.id,expected:{organization_id:old.organization_id,version:old.version,status:'draft'},values:{...draft,updated_at:now(),version,intent_id:input.requestId}},...updates,audit(old.organization_id,'item',old.id,'updated',employee,input.requestId,{version:old.version},{version})],signal);
   return {id:old.id,version,status:'draft'};}
 });
}
