import {randomUUID} from 'node:crypto';
import {allowsAppResource} from '@metro/platform-sdk/app-backend';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
import * as XLSX from 'xlsx';
import {planRows,planWorkbook} from './plan-export.mjs';

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
const missingBinding=names=>{const error=Error('BINDING_MISSING');error.details=names;throw error;};

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
 async function listAll(table,filters,signal){
  const rows=[];let after;
  do{const page=await data.list(table,{filters,order:{column:'created_at',direction:'asc'},pageSize:50,...(after?{after}:{})},signal);rows.push(...page.rows);after=page.nextCursor;if(rows.length>2000)fail('ITEM_TOO_LARGE');}while(after);
  return rows;
 }
 const cycleItems=(parent,signal)=>listAll('plan_items',[{column:'organization_id',value:parent.organization_id},{column:'cycle_id',value:parent.id}],signal);
 const bindings=(organizationId,signal)=>listAll('review_bindings',[{column:'organization_id',value:organizationId}],signal);
 async function bindingFor(categoryId,organizationId,signal){
  const path=await categoryPath(categoryId,organizationId,signal);
  const rows=await bindings(organizationId,signal);
  if(!rows.some(row=>row.category_id===path.parent.id))missingBinding([path.parent.name]);
  return {path,rows:rows.filter(row=>row.category_id===path.parent.id)};
 }
 async function reviewAccess(employee,categoryId,organizationId,signal){
  const {rows}=await bindingFor(categoryId,organizationId,signal);
  if(!await isCurrentOrganization(employee,organizationId,signal))fail('ACCESS_DENIED');
  if(can(employee,'manage',organizationId))return;
  requireAccess(employee,'review',organizationId);
  if(!rows.some(row=>row.person_id===employee.personId))fail('ACCESS_DENIED');
 }
 async function changeRecord(id,employee,signal){
  if(!uuid(id))fail('INVALID_INPUT');const {row}=await data.get('change_records',id,signal);
  if(!row)fail('NOT_FOUND');requireAccess(employee,'read',row.organization_id);return row;
 }
 async function applyChange(record,parent,employee,requestId,signal){
  const operations=[],payload=record.payload,old=record.item_id?(await data.get('plan_items',record.item_id,signal)).row:null;
  if(record.type!=='add'&&(!old||old.organization_id!==parent.organization_id||old.cycle_id!==parent.id||old.version!==payload.expectedVersion))fail('CONFLICT');
  if(record.type==='add'){
   const draft=payload.draft;
   operations.push({action:'insert',table:'plan_items',id:payload.itemId,values:{organization_id:parent.organization_id,cycle_id:parent.id,...draft,status:'in_progress',source:'manual',via_change:true,supervision_entry_id:null,created_by:record.requested_by,created_at:now(),updated_at:now(),version:1,intent_id:requestId}});
   for(const person of draft.assignees)operations.push({action:'insert',table:'plan_item_assignees',id:newId(),values:{organization_id:parent.organization_id,item_id:payload.itemId,person_id:person.personId,person_organization_id:person.organizationUnitId,person_name:person.personName,is_lead:person.isLead,sort:person.sort}});
  }else{
   const values={updated_at:now(),version:old.version+1,intent_id:requestId};
   if(record.type==='update')Object.assign(values,payload.draft);
   if(record.type==='extend')values.end_date=payload.endDate;
   if(record.type==='cancel')values.status='cancelled';
   operations.push({action:'update',table:'plan_items',id:old.id,expected:{organization_id:parent.organization_id,cycle_id:parent.id,version:old.version,status:old.status},values});
   if(record.type==='update'){
    const {rows:previous,nextCursor}=await data.list('plan_item_assignees',{filters:[{column:'item_id',value:old.id}],pageSize:20},signal);
    if(nextCursor||previous.length>6||previous.some(row=>row.organization_id!==parent.organization_id))fail('CONFLICT');
    for(const row of previous)operations.push({action:'delete',table:'plan_item_assignees',id:row.id,expected:{item_id:old.id,person_id:row.person_id}});
    for(const person of payload.draft.assignees)operations.push({action:'insert',table:'plan_item_assignees',id:newId(),values:{organization_id:parent.organization_id,item_id:old.id,person_id:person.personId,person_organization_id:person.organizationUnitId,person_name:person.personName,is_lead:person.isLead,sort:person.sort}});
   }
  }
  operations.push(audit(parent.organization_id,'change',record.id,'effective',employee,requestId,null,{type:record.type,itemId:record.item_id??payload.itemId}));return operations;
 }
 async function transition(input,employee,signal,from,to,action,guard){
  identity(employee);if(!ownKeys(input,['cycleId','requestId','expectedRevision'])||!uuid(input.cycleId)||!uuid(input.requestId)||!Number.isInteger(input.expectedRevision))fail('INVALID_INPUT');
  const parent=await cycle(input.cycleId,employee,'manage',signal);
  if(parent.revision!==input.expectedRevision)fail('CONFLICT');if(parent.status!==from)fail('CYCLE_LOCKED');
  const items=await cycleItems(parent,signal),extra=guard?await guard(parent,items,signal):[];
  await write(input.requestId,[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:parent.organization_id,revision:parent.revision,status:from},values:{status:to,revision:parent.revision+1,updated_at:now(),intent_id:input.requestId}},...extra,audit(parent.organization_id,'cycle',parent.id,action,employee,input.requestId,{status:from},{status:to})],signal);
  return {status:to,revision:parent.revision+1};
 }
 return Object.freeze({
  async session(input,employee){identity(employee);if(!ownKeys(input,[])||Object.keys(input).length)fail('INVALID_INPUT');const read=employee.businessAuthorization.grants.find(grant=>grant.permission===permission('read'));return {personId:employee.personId,organizationId:employee.organizationUnitId,organizations:employee.businessAuthorization.organizations.filter(row=>read?.all||read?.organizationIds.includes(row.id)),permissions:employee.businessAuthorization.grants.map(grant=>grant.permission)};},
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
   const categories=await listAll('category_nodes',[{column:'organization_id',value:input.organizationId}],signal),assigned=await bindings(input.organizationId,signal);
   return {id:input.id,revision:1,status:'drafting',unboundCategories:categories.filter(row=>row.level===2&&row.enabled&&!assigned.some(binding=>binding.category_id===row.id)).map(row=>row.name)};},
  async 'binding-list'(input,employee,signal){identity(employee);if(!ownKeys(input,['organizationId'])||!uuid(input.organizationId))fail('INVALID_INPUT');requireAccess(employee,'read',input.organizationId);return {rows:await bindings(input.organizationId,signal)};},
  async 'binding-upsert'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','organizationId','categoryId','personId','personOrganizationId','requestId'])||!uuid(input.id)||!uuid(input.organizationId)||!uuid(input.categoryId)||!uuid(input.personId)||!uuid(input.personOrganizationId)||!uuid(input.requestId))fail('INVALID_INPUT');requireAccess(employee,'manage',input.organizationId);
   const node=await category(input.categoryId,input.organizationId,signal);if(node.level!==2)fail('CATEGORY_INVALID');await resolveAssignees([{personId:input.personId,organizationUnitId:input.personOrganizationId,isLead:true}],input.organizationId,signal);
   if((await bindings(input.organizationId,signal)).some(row=>row.category_id===input.categoryId&&row.person_id===input.personId))fail('CONFLICT');
   await write(input.requestId,[{action:'insert',table:'review_bindings',id:input.id,values:{organization_id:input.organizationId,category_id:node.id,person_id:input.personId,created_at:now()}},audit(input.organizationId,'binding',input.id,'created',employee,input.requestId,null,{categoryId:node.id,personId:input.personId})],signal);return {id:input.id};},
  async 'binding-delete'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId'])||!uuid(input.id)||!uuid(input.requestId))fail('INVALID_INPUT');const {row}=await data.get('review_bindings',input.id,signal);if(!row)fail('NOT_FOUND');requireAccess(employee,'manage',row.organization_id);
   await write(input.requestId,[{action:'delete',table:'review_bindings',id:row.id,expected:{organization_id:row.organization_id,category_id:row.category_id,person_id:row.person_id}},audit(row.organization_id,'binding',row.id,'deleted',employee,input.requestId,{categoryId:row.category_id,personId:row.person_id},null)],signal);return {id:row.id};},
  async 'cycle-submit-review'(input,employee,signal){return transition(input,employee,signal,'drafting','reviewing','submit-review',async(parent,_items,signal)=>{const assigned=await bindings(parent.organization_id,signal),categories=await listAll('category_nodes',[{column:'organization_id',value:parent.organization_id}],signal);const missing=categories.filter(row=>row.enabled&&row.level===2&&!assigned.some(binding=>binding.category_id===row.id)).map(row=>row.name);if(missing.length)missingBinding(missing);return [];});},
  async 'cycle-return-draft'(input,employee,signal){return transition(input,employee,signal,'reviewing','drafting','return-draft',async(parent,items,signal)=>{
   // TODO: When platform notification delivery is wired, notify these returned-item creators; audit remains authoritative.
   const reviews=await listAll('review_records',[{column:'organization_id',value:parent.organization_id},{column:'cycle_id',value:parent.id}],signal);
   const returned=new Set(reviews.filter(row=>row.action==='return').map(row=>row.item_id));
   return [...new Set(items.filter(row=>row.status==='draft'&&returned.has(row.id)).map(row=>row.created_by))].map(personId=>audit(parent.organization_id,'cycle',parent.id,'return-notification-pending',employee,input.requestId,null,{personId}));});},
  async 'cycle-submit-countersign'(input,employee,signal){return transition(input,employee,signal,'reviewing','countersigning','submit-countersign',async(_parent,items)=>{if(items.some(row=>row.status!=='approved'))fail('REVIEW_PENDING');return [];});},
  async 'cycle-signature-status'(input,employee,signal){identity(employee);if(!ownKeys(input,['cycleId'])||!uuid(input.cycleId))fail('INVALID_INPUT');const parent=await cycle(input.cycleId,employee,'read',signal);return {mode:'in-app-confirmation',status:parent.confirmed_by?'completed':'pending',confirmedBy:parent.confirmed_by??null,confirmedAt:parent.confirmed_at??null};},
  async 'cycle-confirm-signature'(input,employee,signal){identity(employee);if(!ownKeys(input,['cycleId','requestId','expectedRevision'])||!uuid(input.cycleId)||!uuid(input.requestId)||!Number.isInteger(input.expectedRevision))fail('INVALID_INPUT');const parent=await cycle(input.cycleId,employee,'read',signal);requireAccess(employee,'sign',parent.organization_id);if(!await isCurrentOrganization(employee,parent.organization_id,signal))fail('ACCESS_DENIED');if(parent.status!=='countersigning')fail('CYCLE_LOCKED');if(parent.revision!==input.expectedRevision||parent.confirmed_by)fail('CONFLICT');
   // M2 fallback: in-app owner confirmation + audit; replace with server-verified platform signatures when L2 signing UI is available.
   await write(input.requestId,[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:parent.organization_id,status:'countersigning',revision:parent.revision},values:{confirmed_by:employee.personId,confirmed_at:now(),revision:parent.revision+1,updated_at:now(),intent_id:input.requestId}},audit(parent.organization_id,'cycle',parent.id,'signature-confirmed-fallback',employee,input.requestId,null,{confirmedBy:employee.personId})],signal);return {status:'completed',revision:parent.revision+1};},
  async 'cycle-lock'(input,employee,signal){return transition(input,employee,signal,'countersigning','locked','locked',async(parent,items)=>{if(!parent.confirmed_by)fail('SIGNATURE_PENDING');if(items.some(row=>row.status!=='approved'))fail('REVIEW_PENDING');return items.map(row=>({action:'update',table:'plan_items',id:row.id,expected:{organization_id:parent.organization_id,cycle_id:parent.id,status:'approved',version:row.version},values:{status:'in_progress',version:row.version+1,updated_at:now(),intent_id:input.requestId}}));});},
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
  async 'item-submit'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','expectedVersion'])||!uuid(input.id)||!uuid(input.requestId)||!Number.isInteger(input.expectedVersion))fail('INVALID_INPUT');const old=await item(input.id,employee,signal),parent=await cycle(old.cycle_id,employee,'read',signal);
   if(parent.status!=='drafting')fail('CYCLE_LOCKED');if(old.version!==input.expectedVersion)fail('CONFLICT');if(old.status!=='draft')fail('CONFLICT');if(!can(employee,'manage',old.organization_id)&&(!can(employee,'fill',old.organization_id,old.created_by)||old.created_by!==employee.personId||!await isCurrentOrganization(employee,old.organization_id,signal)))fail('ACCESS_DENIED');await bindingFor(old.category_id,old.organization_id,signal);
   await write(input.requestId,[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:old.organization_id,status:'drafting',revision:parent.revision},values:{revision:parent.revision+1,updated_at:now()}},{action:'update',table:'plan_items',id:old.id,expected:{organization_id:old.organization_id,cycle_id:parent.id,status:'draft',version:old.version},values:{status:'submitted',version:old.version+1,updated_at:now(),intent_id:input.requestId}},{action:'insert',table:'review_records',id:newId(),values:{organization_id:old.organization_id,cycle_id:parent.id,item_id:old.id,reviewer_id:employee.personId,action:'submit',comment:null,created_at:now()}},audit(old.organization_id,'item',old.id,'submitted',employee,input.requestId,{status:'draft'},{status:'submitted'})],signal);return {status:'submitted',version:old.version+1};},
  async 'item-review'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','expectedVersion','action','comment'])||!uuid(input.id)||!uuid(input.requestId)||!Number.isInteger(input.expectedVersion)||!['approve','return'].includes(input.action)||input.comment!==undefined&&!validText(input.comment,500,false)||input.action==='return'&&!validText(input.comment,500))fail('INVALID_INPUT');const old=await item(input.id,employee,signal),parent=await cycle(old.cycle_id,employee,'read',signal);
   if(parent.status!=='reviewing')fail('REVIEW_NOT_OPEN');if(old.version!==input.expectedVersion||old.status!=='submitted')fail('CONFLICT');await reviewAccess(employee,old.category_id,old.organization_id,signal);
   const status=input.action==='approve'?'approved':'draft';await write(input.requestId,[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:old.organization_id,status:'reviewing',revision:parent.revision},values:{revision:parent.revision+1,updated_at:now()}},{action:'update',table:'plan_items',id:old.id,expected:{organization_id:old.organization_id,cycle_id:parent.id,status:'submitted',version:old.version},values:{status,version:old.version+1,updated_at:now(),intent_id:input.requestId}},{action:'insert',table:'review_records',id:newId(),values:{organization_id:old.organization_id,cycle_id:parent.id,item_id:old.id,reviewer_id:employee.personId,action:input.action,comment:input.comment?.trim()||null,created_at:now()}},audit(old.organization_id,'item',old.id,input.action,employee,input.requestId,{status:'submitted'},{status,comment:input.comment?.trim()||null})],signal);return {status,version:old.version+1};},
  async 'item-create'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','cycleId','organizationId','year','month','draft'])||!uuid(input.id)||!uuid(input.requestId)||!(uuid(input.cycleId)&&input.organizationId===undefined&&input.year===undefined&&input.month===undefined||input.cycleId===undefined&&uuid(input.organizationId)&&Number.isInteger(input.year)&&input.year>=2000&&input.year<=2100&&Number.isInteger(input.month)&&input.month>=1&&input.month<=12))fail('INVALID_INPUT');
   const monthly=!input.cycleId;
   if(monthly){requireAccess(employee,'fill',input.organizationId,employee.personId);if(!await isCurrentOrganization(employee,input.organizationId,signal))fail('ACCESS_DENIED');}
   const findMonth=async()=>{const page=await data.list('plan_cycles',{filters:[{column:'organization_id',value:input.organizationId},{column:'year',value:input.year},{column:'month',value:input.month}],pageSize:2},signal);return page.rows[0]??null;};
   let parent=monthly?await findMonth():await cycle(input.cycleId,employee,'read',signal);
   if(!parent&&monthly)parent={id:newId(),organization_id:input.organizationId,year:input.year,month:input.month,status:'drafting',fill_deadline:null,created_by:employee.personId,created_at:now(),updated_at:now(),revision:0,intent_id:input.requestId};
   requireAccess(employee,'read',parent.organization_id,parent.created_by);
   if(parent.status!=='drafting')fail('CYCLE_LOCKED');if(!can(employee,'manage',parent.organization_id)&&(!can(employee,'fill',parent.organization_id,employee.personId)||!await isCurrentOrganization(employee,parent.organization_id,signal)))fail('ACCESS_DENIED');
   const draft=await buildDraft(input.draft,parent.organization_id,signal),timestamp=now();
   const row={organization_id:parent.organization_id,cycle_id:parent.id,...draft,status:'draft',source:'manual',supervision_entry_id:null,created_by:employee.personId,created_at:timestamp,updated_at:timestamp,version:1,intent_id:input.requestId};
   const assigneeRows=draft.assignees.map(person=>({action:'insert',table:'plan_item_assignees',id:newId(),values:{organization_id:parent.organization_id,item_id:input.id,person_id:person.personId,person_organization_id:person.organizationUnitId,person_name:person.personName,is_lead:person.isLead,sort:person.sort}}));
   const operations=current=>[current.revision===0?{action:'insert',table:'plan_cycles',id:current.id,values:{organization_id:current.organization_id,year:current.year,month:current.month,status:'drafting',fill_deadline:null,created_by:employee.personId,created_at:timestamp,updated_at:timestamp,revision:1,intent_id:input.requestId}}:{action:'update',table:'plan_cycles',id:current.id,expected:{organization_id:current.organization_id,status:'drafting',revision:current.revision},values:{revision:current.revision+1,updated_at:timestamp}},{action:'insert',table:'plan_items',id:input.id,values:{...row,cycle_id:current.id}},...assigneeRows,audit(current.organization_id,'item',input.id,'created',employee,input.requestId,null,{cycleId:current.id,version:1})];
   try{await write(input.requestId,operations(parent),signal);}catch(error){if(!monthly||parent.revision!==0||error.message!=='CONFLICT')throw error;const existing=await findMonth();if(!existing||existing.status!=='drafting')throw error;requireAccess(employee,'read',existing.organization_id,existing.created_by);await write(input.requestId,operations(existing),signal);}
   return {id:input.id,version:1,status:'draft'};},
  async 'item-progress'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','expectedVersion','status','remark'])||!uuid(input.id)||!uuid(input.requestId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1||!['in_progress','completed','cancelled'].includes(input.status)||!validText(input.remark,500))fail('INVALID_INPUT');
   const old=await item(input.id,employee,signal),parent=await cycle(old.cycle_id,employee,'read',signal);
   if(!['drafting','locked','closing'].includes(parent.status))fail('CYCLE_LOCKED');
   if(!can(employee,'manage',old.organization_id)&&(!can(employee,'fill',old.organization_id,employee.personId)||!old.assignees?.some(person=>person.personId===employee.personId)||!await isCurrentOrganization(employee,old.organization_id,signal)))fail('ACCESS_DENIED');
   if(old.version!==input.expectedVersion||!['draft','in_progress'].includes(old.status)||old.status==='draft'&&parent.status!=='drafting')fail('CONFLICT');
   await write(input.requestId,[{action:'update',table:'plan_items',id:old.id,expected:{organization_id:old.organization_id,cycle_id:old.cycle_id,status:old.status,version:old.version},values:{status:input.status,remark:input.remark.trim(),version:old.version+1,updated_at:now(),intent_id:input.requestId}},audit(old.organization_id,'item',old.id,'progress',employee,input.requestId,{status:old.status,version:old.version,remark:old.remark},{status:input.status,version:old.version+1,remark:input.remark.trim()})],signal);
   return {id:old.id,status:input.status,version:old.version+1};},
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
   return {id:old.id,version,status:'draft'};},
  async 'change-list'(input,employee,signal){identity(employee);if(!ownKeys(input,['cycleId'])||!uuid(input.cycleId))fail('INVALID_INPUT');const parent=await cycle(input.cycleId,employee,'read',signal);return {rows:await listAll('change_records',[{column:'organization_id',value:parent.organization_id},{column:'cycle_id',value:parent.id}],signal)};},
  async 'change-create'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','itemId','cycleId','requestId','type','draft','endDate','reason','expectedVersion'])||!uuid(input.id)||!uuid(input.itemId)||!uuid(input.cycleId)||!uuid(input.requestId)||!['add','update','cancel','extend'].includes(input.type)||input.type!=='add'&&!Number.isInteger(input.expectedVersion)||['cancel','extend'].includes(input.type)&&!validText(input.reason,500)||input.type==='extend'&&!day(input.endDate))fail('INVALID_INPUT');const parent=await cycle(input.cycleId,employee,'manage',signal);if(parent.status!=='locked')fail('CYCLE_LOCKED');
   const old=input.type==='add'?null:await item(input.itemId,employee,signal);if(old&&(old.cycle_id!==parent.id||old.status!=='in_progress'||old.version!==input.expectedVersion))fail('CONFLICT');
   const draft=['add','update'].includes(input.type)?await buildDraft(input.draft,parent.organization_id,signal):null;
   if(input.type==='extend'&&input.endDate<=old.end_date)fail('INVALID_INPUT');
   const categoryId=draft?.category_id??old.category_id;await bindingFor(categoryId,parent.organization_id,signal);
   const payload={...(draft?{draft}:{}) ,...(old?{expectedVersion:old.version}:{}),...(input.type==='add'?{itemId:input.itemId}:{}),...(input.endDate?{endDate:input.endDate}:{}),...(input.reason?{reason:input.reason.trim()}:{}),categoryId,escalated:old?.escalated||draft?.escalated||false};
   const recordId=input.id;const record={organization_id:parent.organization_id,cycle_id:parent.id,item_id:old?.id??null,type:input.type,payload,status:'pending',requested_by:employee.personId,reviewed_by:null,countersigned_by:null,created_at:now()};
   await write(input.requestId,[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:parent.organization_id,status:'locked',revision:parent.revision},values:{revision:parent.revision+1,updated_at:now()}},{action:'insert',table:'change_records',id:recordId,values:record},audit(parent.organization_id,'change',recordId,'created',employee,input.requestId,null,{type:input.type,categoryId})],signal);return {id:recordId,status:'pending'};},
  async 'change-review'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId','action','comment'])||!uuid(input.id)||!uuid(input.requestId)||!['approve','reject'].includes(input.action)||input.action==='reject'&&!validText(input.comment,500)||input.comment!==undefined&&!validText(input.comment,500,false))fail('INVALID_INPUT');const record=await changeRecord(input.id,employee,signal),parent=await cycle(record.cycle_id,employee,'read',signal);if(parent.status!=='locked')fail('CYCLE_LOCKED');if(record.status!=='pending')fail('CONFLICT');await reviewAccess(employee,record.payload.categoryId,parent.organization_id,signal);
   const status=input.action==='reject'?'rejected':'approved',effective=status==='approved'&&!record.payload.escalated;
   const operations=[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:parent.organization_id,status:'locked',revision:parent.revision},values:{revision:parent.revision+1,updated_at:now()}},{action:'update',table:'change_records',id:record.id,expected:{organization_id:parent.organization_id,status:'pending'},values:{status,reviewed_by:employee.personId}},audit(parent.organization_id,'change',record.id,input.action,employee,input.requestId,{status:'pending'},{status,comment:input.comment?.trim()||null})];
   if(effective)operations.push(...await applyChange(record,parent,employee,input.requestId,signal));await write(input.requestId,operations,signal);return {status,effective};},
  async 'change-countersign'(input,employee,signal){identity(employee);if(!ownKeys(input,['id','requestId'])||!uuid(input.id)||!uuid(input.requestId))fail('INVALID_INPUT');const record=await changeRecord(input.id,employee,signal),parent=await cycle(record.cycle_id,employee,'read',signal);requireAccess(employee,'sign',parent.organization_id);if(!await isCurrentOrganization(employee,parent.organization_id,signal))fail('ACCESS_DENIED');if(parent.status!=='locked')fail('CYCLE_LOCKED');if(record.status!=='approved'||!record.payload.escalated)fail('CONFLICT');
   const operations=[{action:'update',table:'plan_cycles',id:parent.id,expected:{organization_id:parent.organization_id,status:'locked',revision:parent.revision},values:{revision:parent.revision+1,updated_at:now()}},{action:'update',table:'change_records',id:record.id,expected:{organization_id:parent.organization_id,status:'approved'},values:{status:'countersigned',countersigned_by:employee.personId}},audit(parent.organization_id,'change',record.id,'countersigned-fallback',employee,input.requestId,{status:'approved'},{status:'countersigned'}),...await applyChange(record,parent,employee,input.requestId,signal)];
   await write(input.requestId,operations,signal);return {status:'countersigned',effective:true};},
  async 'export-plan'(input,employee,signal){identity(employee);if(!ownKeys(input,['cycleId','scope','requestId'])||!uuid(input.cycleId)||!uuid(input.requestId)||!['all','escalated'].includes(input.scope))fail('INVALID_INPUT');const parent=await cycle(input.cycleId,employee,'read',signal);
   const organization=employee.businessAuthorization.organizations.find(row=>row.id===parent.organization_id);if(!organization)fail('ACCESS_DENIED');const rows=planRows(await cycleItems(parent,signal),input.scope),book=planWorkbook(`${organization.name}${parent.month}月份工作计划`,rows);
   const bytes=XLSX.write(book,{bookType:'xlsx',type:'buffer'});if(bytes.length>40_000)fail('ITEM_TOO_LARGE');
   await write(input.requestId,[audit(parent.organization_id,'cycle',parent.id,'export',employee,input.requestId,null,{scope:input.scope,count:rows.length})],signal);
   return {fileName:`${parent.year}年${parent.month}月工作计划${input.scope==='escalated'?'_拟提报':''}.xlsx`,base64:bytes.toString('base64'),count:rows.length};}
 });
}
