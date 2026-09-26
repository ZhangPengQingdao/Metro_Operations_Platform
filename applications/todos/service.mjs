import {createHash,randomUUID} from 'node:crypto';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
import {permit,scope} from './policy.mjs';
import {dueAt,occurrence} from './schedule.mjs';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail=code=>{throw Error(code);};
const label=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const optionalText=(value,max)=>value==null||typeof value==='string'&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const shape=(value,required,optional=[])=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!(key in value))||Object.keys(value).some(key=>![...required,...optional].includes(key)))fail('INVALID_INPUT');
};
const guard=employee=>{if(!employee||!uuid(employee.personId)||!employee.businessAuthorization)fail('EMPLOYEE_REQUIRED');};
const can=(employee,action,organizationId,owner)=>permit(employee,action,{organization_id:organizationId,created_by:owner});
const requireAction=(employee,action,organizationId,owner)=>{guard(employee);if(!uuid(organizationId)||!can(employee,action,organizationId,owner))fail('ACCESS_DENIED');};
const stamp=clock=>clock().toISOString();
const scoreFields=(input,employee,org)=>{
 const scored=input.isScored===true;
 if(input.isScored!==undefined&&typeof input.isScored!=='boolean'||input.scoreValue!==undefined&&(!Number.isInteger(input.scoreValue)||input.scoreValue<0||input.scoreValue>10000))fail('INVALID_INPUT');
 if(scored&&!can(employee,'score',org))fail('ACCESS_DENIED');
 return {is_scored:scored,score_value:scored?(input.scoreValue??0):0};
};
const checkSchedule=input=>{
 if(!['daily','weekly','monthly'].includes(input.recurrenceType)||!Number.isInteger(input.recurrenceValue)||!Number.isInteger(input.dueValue)||
  !Number.isInteger(input.triggerMinutes)||input.triggerMinutes<0||input.triggerMinutes>1439||!Number.isInteger(input.dueMinutes)||input.dueMinutes<0||input.dueMinutes>1439)fail('INVALID_INPUT');
 if(input.recurrenceType==='daily'&&(input.recurrenceValue!==0||input.dueValue!==0))fail('INVALID_INPUT');
 if(input.recurrenceType==='weekly'&&(!between(input.recurrenceValue,1,7)||!between(input.dueValue,1,7)))fail('INVALID_INPUT');
 if(input.recurrenceType==='monthly'&&(!between(input.recurrenceValue,1,31)||!between(input.dueValue,1,31)))fail('INVALID_INPUT');
 if(input.recurrenceType!=='daily'&&(input.dueValue<input.recurrenceValue||input.dueValue===input.recurrenceValue&&input.dueMinutes<input.triggerMinutes))fail('INVALID_INPUT');
};
const between=(value,min,max)=>value>=min&&value<=max;
const due=value=>value==null?null:typeof value==='string'&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value?value:fail('INVALID_INPUT');
const taskItems=targets=>targets.map(target=>({id:randomUUID(),target_id:target.id,target_name:target.name,handler_id:target.handlerId??(target.type==='person'?target.id:null),handler_name:target.type==='person'?target.name:null,status:'pending',remarks:null,completed_by:null,completed_at:null}));
const occurrenceId=(templateId,key)=>{
 const bytes=createHash('sha256').update(`${templateId}:${key}`).digest();
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
};

/** All business writes are guarded by the current host-signed grant, then by row scope. */
export function createTodosService(gateway,{clock=()=>new Date()}={}){
 const data=createAppDataClient(gateway);
 const uncertainOccurrences=new Set();
 const commit=(requestId,operations,signal)=>{
  if(Buffer.byteLength(JSON.stringify({requestId,operations}))>16000)fail('PAYLOAD_LIMIT');
  return data.transaction(requestId,operations,signal);
 };
 const getTask=async(id,employee,action,signal)=>{
  if(!uuid(id))fail('INVALID_INPUT');const {row}=await data.get('tasks',id,signal);
  if(!row||row.status==='deleted'||!permit(employee,action,row))fail('ACCESS_DENIED');
  return row;
 };
 const getTemplate=async(id,employee,signal)=>{
  if(!uuid(id))fail('INVALID_INPUT');const {row}=await data.get('templates',id,signal);
  if(!row||row.deleted||!permit(employee,'recurring',row))fail('ACCESS_DENIED');return row;
 };
 async function targets(input,org,signal){
  if(!['station','person'].includes(input.scopeType)||!Array.isArray(input.targetIds)||input.targetIds.length<1||input.targetIds.some(id=>!uuid(id))||new Set(input.targetIds).size!==input.targetIds.length)fail('INVALID_INPUT');
  if(input.scopeType==='person'){
   const rows=[];
   for(let start=0;start<input.targetIds.length;start+=50){
    const page=await gateway.invoke('platform.people.members',{organizationUnitId:org,personIds:input.targetIds.slice(start,start+50)},signal);
    rows.push(...page.rows);
   }
   if(rows.length!==input.targetIds.length)fail('INVALID_TARGET');const byId=new Map(rows.map(row=>[row.id,row]));
   return input.targetIds.map(id=>({id,name:byId.get(id).name.slice(0,50),type:'person'}));
  }
  const resolved=[];
  for(let start=0;start<input.targetIds.length;start+=8){
   const rows=await Promise.all(input.targetIds.slice(start,start+8).map(id=>gateway.invoke('platform.locations.get',{id},signal)));
   resolved.push(...rows.map(row=>{if(row.locationType!=='station'||row.status!=='active')fail('INVALID_TARGET');return {id:row.id,name:row.name.slice(0,50),type:'station'};}));
  }
  return resolved;
 }
 async function insertTask({id,requestId,org,title,description,scopeType,targets:resolved,dueAt:deadline,scoring,templateId=null,occurrenceKey=null,creatorId},signal){
  const at=stamp(clock),row={organization_id:org,title:title.trim(),description:description?.trim()||null,scope_type:scopeType,status:'active',items:taskItems(resolved),total_items:resolved.length,completed_items:0,due_at:deadline,...scoring,template_id:templateId,occurrence_key:occurrenceKey,created_by:creatorId,created_at:at,updated_at:at,revision:0};
  await commit(requestId,[{action:'insert',table:'tasks',id,values:row}],signal);return {id};
 }
 async function saveTask(input,employee,signal){
  guard(employee);shape(input,['requestId','organizationId','title','scopeType','targetIds'],['description','dueAt','isScored','scoreValue']);
  if(!uuid(input.requestId)||!label(input.title,200)||!optionalText(input.description,2000))fail('INVALID_INPUT');
  requireAction(employee,'create',input.organizationId);
  const scoring=scoreFields(input,employee,input.organizationId),resolved=await targets(input,input.organizationId,signal);
  return insertTask({id:input.requestId,requestId:input.requestId,org:input.organizationId,title:input.title,description:input.description,scopeType:input.scopeType,targets:resolved,dueAt:due(input.dueAt),scoring,creatorId:employee.personId},signal);
 }
 async function changeTask(input,employee,signal){
  guard(employee);shape(input,['requestId','taskId','revision','title'],['description','dueAt','isScored','scoreValue']);
  if(!uuid(input.requestId)||!Number.isInteger(input.revision)||!label(input.title,200)||!optionalText(input.description,2000))fail('INVALID_INPUT');
  const row=await getTask(input.taskId,employee,'manage',signal);if(row.revision!==input.revision)fail('CONFLICT');
  if(input.isScored!==undefined&&typeof input.isScored!=='boolean'||input.scoreValue!==undefined&&(!Number.isInteger(input.scoreValue)||input.scoreValue<0||input.scoreValue>10000))fail('INVALID_INPUT');
  const scoring=input.isScored===undefined?{is_scored:row.is_scored,score_value:row.score_value}:{is_scored:input.isScored,score_value:input.isScored?(input.scoreValue??row.score_value):0};
  if((scoring.is_scored!==row.is_scored||scoring.score_value!==row.score_value)&&!can(employee,'score',row.organization_id))fail('ACCESS_DENIED');
  await commit(input.requestId,[{action:'update',table:'tasks',id:row.id,expected:{revision:row.revision,status:row.status},values:{title:input.title.trim(),description:input.description?.trim()||null,due_at:input.dueAt===undefined?row.due_at:due(input.dueAt),...scoring,revision:row.revision+1,updated_at:stamp(clock)}}],signal);return {id:row.id};
 }
 async function removeTask(input,employee,signal){
  guard(employee);shape(input,['requestId','taskId','revision']);if(!uuid(input.requestId)||!Number.isInteger(input.revision))fail('INVALID_INPUT');
  const row=await getTask(input.taskId,employee,'manage',signal);if(row.revision!==input.revision)fail('CONFLICT');
  await commit(input.requestId,[{action:'update',table:'tasks',id:row.id,expected:{revision:row.revision,status:row.status},values:{status:'deleted',revision:row.revision+1,updated_at:stamp(clock)}}],signal);return {id:row.id};
 }
 async function handleItem(input,employee,signal){
  guard(employee);shape(input,['requestId','taskId','itemId','revision','completed'],['remarks','handlerId']);
  if(!uuid(input.requestId)||!uuid(input.itemId)||!Number.isInteger(input.revision)||typeof input.completed!=='boolean'||!optionalText(input.remarks,100)||input.handlerId!==undefined&&input.handlerId!==null&&!uuid(input.handlerId))fail('INVALID_INPUT');
  const row=await getTask(input.taskId,employee,'read',signal);
  if(!['active','completed'].includes(row.status)||row.revision!==input.revision||!Array.isArray(row.items))fail('CONFLICT');
  const item=row.items.find(value=>value.id===input.itemId);if(!item)fail('INVALID_INPUT');
  if(row.scope_type==='person'&&item.target_id!==employee.personId&&!can(employee,'manage',row.organization_id,row.created_by))fail('ACCESS_DENIED');
  if(!can(employee,'handle',row.organization_id,item.target_id)&&!can(employee,'manage',row.organization_id,row.created_by))fail('ACCESS_DENIED');
  if(row.scope_type==='person'&&input.handlerId!==undefined)fail('INVALID_INPUT');
  const handlerId=row.scope_type==='station'&&input.handlerId!==undefined?input.handlerId:item.handler_id;
  let handlerName=item.handler_name??null;
  if(row.scope_type==='station'&&input.handlerId!==undefined&&input.handlerId!==item.handler_id){
   handlerName=input.handlerId?(await targets({scopeType:'person',targetIds:[input.handlerId]},row.organization_id,signal))[0].name:null;
  }
  const remarks=input.remarks===undefined?item.remarks:input.remarks?.trim()||null;
  const nextStatus=input.completed?'completed':'pending';
  if(item.status===nextStatus&&handlerId===item.handler_id&&remarks===item.remarks)fail('CONFLICT');
  const now=stamp(clock),items=row.items.map(value=>value.id===item.id?{...value,handler_id:handlerId,handler_name:handlerName,status:nextStatus,remarks,completed_by:input.completed?(value.status==='completed'?value.completed_by:employee.personId):null,completed_at:input.completed?(value.status==='completed'?value.completed_at:now):null}:value);
  const complete=items.filter(value=>value.status==='completed').length;
  await commit(input.requestId,[{action:'update',table:'tasks',id:row.id,expected:{revision:row.revision,status:row.status},values:{items,completed_items:complete,status:complete===items.length?'completed':'active',revision:row.revision+1,updated_at:now}}],signal);
  return {id:row.id,completedItems:complete};
 }
 async function saveTemplate(input,employee,signal){
  guard(employee);shape(input,['requestId','organizationId','title','scopeType','targetIds','recurrenceType','recurrenceValue','dueValue','triggerMinutes','dueMinutes'],['id','revision','description','isScored','scoreValue','active']);
  if(!uuid(input.requestId)||!label(input.title,200)||!optionalText(input.description,2000)||input.active!==undefined&&typeof input.active!=='boolean')fail('INVALID_INPUT');
  requireAction(employee,'recurring',input.organizationId);checkSchedule(input);
  let scoring;
  if(input.id){
   if(input.isScored!==undefined&&typeof input.isScored!=='boolean'||input.scoreValue!==undefined&&(!Number.isInteger(input.scoreValue)||input.scoreValue<0||input.scoreValue>10000))fail('INVALID_INPUT');
   scoring={is_scored:input.isScored===true,score_value:input.isScored===true?(input.scoreValue??0):0};
  }else scoring=scoreFields(input,employee,input.organizationId);
  const resolved=await targets(input,input.organizationId,signal),now=stamp(clock);
  const values={title:input.title.trim(),description:input.description?.trim()||null,scope_type:input.scopeType,targets:resolved,recurrence_type:input.recurrenceType,recurrence_value:input.recurrenceValue,due_value:input.dueValue,trigger_minutes:input.triggerMinutes,due_minutes:input.dueMinutes,...scoring,active:input.active??true,updated_at:now};
  if(input.id){
   const previous=await getTemplate(input.id,employee,signal);
   if(previous.organization_id!==input.organizationId||previous.revision!==input.revision)fail('CONFLICT');
   if((previous.is_scored!==scoring.is_scored||previous.score_value!==scoring.score_value)&&!can(employee,'score',input.organizationId))fail('ACCESS_DENIED');
   await commit(input.requestId,[{action:'update',table:'templates',id:previous.id,expected:{revision:previous.revision,deleted:false},values:{...values,revision:previous.revision+1}}],signal);return {id:previous.id};
  }
  const id=input.requestId;await commit(input.requestId,[{action:'insert',table:'templates',id,values:{organization_id:input.organizationId,...values,deleted:false,created_by:employee.personId,created_at:now,revision:0}}],signal);return {id};
 }
 async function templateState(input,employee,signal){
  guard(employee);shape(input,['requestId','templateId','revision','action'],['active']);
  if(!uuid(input.requestId)||!Number.isInteger(input.revision)||!['delete','active'].includes(input.action)||input.action==='active'&&typeof input.active!=='boolean')fail('INVALID_INPUT');
  const row=await getTemplate(input.templateId,employee,signal);if(row.revision!==input.revision)fail('CONFLICT');
  await commit(input.requestId,[{action:'update',table:'templates',id:row.id,expected:{revision:row.revision,deleted:false},values:{...(input.action==='delete'?{deleted:true,active:false}:{active:input.active}),revision:row.revision+1,updated_at:stamp(clock)}}],signal);return {id:row.id};
 }
 async function generate(template,key,signal,requestedId){
  const existing=await data.list('tasks',{filters:[{column:'template_id',value:template.id},{column:'occurrence_key',value:key}],pageSize:1},signal);
  if(existing.rows.length)return {id:existing.rows[0].id,existing:true};
  const id=requestedId??occurrenceId(template.id,key);
  if(uncertainOccurrences.has(id))return null;
  try {
   return await insertTask({id,requestId:id,org:template.organization_id,title:template.title,description:template.description,scopeType:template.scope_type,targets:template.targets,dueAt:dueAt(template,clock()),scoring:{is_scored:template.is_scored,score_value:template.score_value},templateId:template.id,occurrenceKey:key,creatorId:template.created_by},signal);
  }catch(error){if(!requestedId&&error?.writeOutcome!=='not_started')uncertainOccurrences.add(id);throw error;}
 }
 async function trigger(input,employee,signal){
  guard(employee);shape(input,['requestId','templateId']);if(!uuid(input.requestId))fail('INVALID_INPUT');const template=await getTemplate(input.templateId,employee,signal);
  if(!template.active)fail('INACTIVE_TEMPLATE');
  return generate(template,`manual-${input.requestId}`,signal,input.requestId);
 }
 async function sweep(signal){
  let cursor;const results=[];
  do {
   const page=await data.list('templates',{filters:[{column:'active',value:true},{column:'deleted',value:false}],pageSize:2,...(cursor?{afterId:cursor}:{})},signal);
   for(const template of page.rows){
    const key=occurrence(template,clock());if(!key)continue;
    try {const result=await generate(template,key,signal);if(result)results.push(result);}
    catch(error){
     if(error?.code==='STORAGE_CONFLICT'){
      const current=await data.list('tasks',{filters:[{column:'template_id',value:template.id},{column:'occurrence_key',value:key}],pageSize:1},signal);
      if(current.rows.length)continue;
     }
     throw error;
    }
   }
   cursor=page.nextCursor;
  }while(cursor&&!signal?.aborted);
  return results;
 }
 return Object.freeze({
  async session(input,employee){guard(employee);shape(input,[]);return {personId:employee.personId,organizationUnitId:employee.organizationUnitId,organizations:employee.businessAuthorization.organizations,grants:employee.businessAuthorization.grants};},
  async directory(input,employee,signal){guard(employee);shape(input,['kind'],['organizationId','search','afterId']);
   if(!['person','station'].includes(input.kind)||input.search!==undefined&&!label(input.search,100)||input.afterId!==undefined&&!uuid(input.afterId))fail('INVALID_INPUT');
   if(input.kind==='person'){
   if(!uuid(input.organizationId)||!['create','recurring','handle','manage'].some(action=>can(employee,action,input.organizationId,input.organizationId===employee.organizationUnitId?employee.personId:undefined)))fail('ACCESS_DENIED');
    return gateway.invoke('platform.people.members',{organizationUnitId:input.organizationId,...(input.search?{search:input.search}:{})},signal);
   }
   if(!employee.businessAuthorization.grants.some(grant=>['app.todos.create','app.todos.recurring'].includes(grant.permission)))fail('ACCESS_DENIED');
   const page=await gateway.invoke('platform.locations.list',{pageSize:50,status:'active',...(input.search?{search:input.search}:{}),...(input.afterId?{afterId:input.afterId}:{})},signal);
   return {...page,rows:page.rows.filter(row=>row.locationType==='station')};
  },
  async list(input,employee,signal){guard(employee);shape(input,['kind'],['organizationId','after','status','search']);
   if(!['tasks','templates'].includes(input.kind)||input.organizationId!==undefined&&!uuid(input.organizationId)||input.after!==undefined&&(!input.after||typeof input.after!=='object'||Array.isArray(input.after)||Object.keys(input.after).sort().join(',')!=='id,value'||!uuid(input.after.id)||typeof input.after.value!=='string'||Number.isNaN(Date.parse(input.after.value)))||input.status!==undefined&&!['active','completed'].includes(input.status)||input.search!==undefined&&(!label(input.search,100)))fail('INVALID_INPUT');
   const action=input.kind==='tasks'?'read':'recurring',filters=[];
   if(input.organizationId){requireAction(employee,action,input.organizationId,employee.personId);filters.push({column:'organization_id',value:input.organizationId});}
   if(input.kind==='tasks'&&input.status)filters.push({column:'status',value:input.status});
   if(input.kind==='templates')filters.push({column:'deleted',value:false});
   const page=await data.list(input.kind,{...scope(employee,action),filters,pageSize:2,order:{column:'created_at',direction:'desc'},...(input.search?{search:{column:'title',text:input.search.trim()}}:{}),...(input.after?{after:input.after}:{})},signal);
   return {...page,rows:page.rows.filter(row=>row.status!=='deleted').map(row=>({...row,can_manage:input.kind==='tasks'&&permit(employee,'manage',row),can_score:permit(employee,'score',row)}))};
  },
  async detail(input,employee,signal){guard(employee);shape(input,['taskId']);const row=await getTask(input.taskId,employee,'read',signal);const manage=permit(employee,'manage',row);return {...row,items:row.items.map(item=>({...item,can_handle:manage||(row.scope_type!=='person'||item.target_id===employee.personId)&&can(employee,'handle',row.organization_id,item.target_id)})),can_manage:manage,can_score:permit(employee,'score',row)};},
  createTask:saveTask,updateTask:changeTask,deleteTask:removeTask,handleItem,
  saveTemplate,templateState,trigger,sweep,
 });
}
