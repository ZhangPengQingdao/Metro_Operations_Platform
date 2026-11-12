import {extractSupervision} from './supervision-drafts.mjs';
import {createPlatformKnowledgeClient} from '@metro/platform-sdk/app-knowledge';
import {randomUUID,createHash} from 'node:crypto';
import {allowsAppResource} from '@metro/platform-sdk/app-backend';
import {createAppDataClient,createPlatformAiClient,createPlatformWebhookClient,createPlatformAttachmentClient} from '@metro/platform-sdk/app-gateway';
import {readAppDashboard} from '@metro/platform-sdk/app-dashboard';
import {uuid,text,day,validMonth,shanghaiDay,fail,keys,permissions,relevantAnnual,reminderDue,parseWebhook,monthlyDates} from './reform-rules.mjs';
import {DEFAULT_PLAN_PROMPT,DEFAULT_SUMMARY_PROMPT,PLAN_PROMPT_MAX_LENGTH,PLAN_SUMMARY_MAX_RECORDS,planSystemPrompt,summarySystemPrompt} from './plan-prompt.mjs';
import {completeText} from './text-model.mjs';
import {PUBLIC_READ_ERRORS} from './request-error.mjs';

const READS=new Set(['plan-prompt-get','plan-prompt-test','plan-summary','authorize-transcription','supervision-extract','session','members','record-list','record-get','annual-hints','corpus-list','plan-suggest','settings-get','reminder-list','dashboard-summary','authorize-attachment']);
const DEFINITIVE=new Set(['INVALID_INPUT','ACCESS_DENIED','NOT_FOUND','CONFLICT','PERSON_INVALID','ATTACHMENT_REQUIRED','AI_NOT_CONFIGURED','AI_PERMISSION_DENIED','AI_UNAVAILABLE','AI_INVALID_RESULT','TERM_CHANGED','INVALID_WEBHOOK','LIMIT_EXCEEDED','SUMMARY_INPUT_LIMIT','ANNUAL_INVALID','DEADLINE_PENDING','STORAGE_CONFLICT','KNOWLEDGE_CONFLICT','KNOWLEDGE_LIMIT','KNOWLEDGE_EMBEDDING_UNAVAILABLE','REQUEST_ID_REUSED','INVALID_PARAMS']);
const DIAGNOSTIC_READS=new Set(['session','supervision-extract','plan-summary']);
const promptSettings={
 organize:{table:'plan_prompt_settings',defaultPrompt:DEFAULT_PLAN_PROMPT},
 summary:{table:'summary_prompt_settings',defaultPrompt:DEFAULT_SUMMARY_PROMPT}
};
const promptKind=kind=>{
 if(kind===undefined||kind==='organize')return promptSettings.organize;
 if(kind==='summary')return promptSettings.summary;
 fail('INVALID_INPUT');
};
const full=code=>`app.huicetong.${code}`;
const deterministic=value=>{const hex=createHash('sha256').update(value).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;};

/** New workflow is independent of the legacy category/cycle/signature state machine. */
export function createReformService(gateway,{clock=()=>new Date(),newId=randomUUID}={}){
 const knowledge=createPlatformKnowledgeClient(gateway),data=createAppDataClient(gateway),ai=createPlatformAiClient(gateway),webhook=createPlatformWebhookClient(gateway),attachments=createPlatformAttachmentClient(gateway);
 const now=()=>clock().toISOString(),today=()=>shanghaiDay(clock());
 const identity=employee=>{if(!employee||!uuid(employee.personId)||!employee.businessAuthorization)fail('ACCESS_DENIED');};
 const can=(e,code,org,owner=null)=>allowsAppResource(e,full(code),{organizationUnitId:org,ownerPersonId:owner});
 const require=(e,code,org,owner=null)=>{identity(e);if(!uuid(org))fail('INVALID_INPUT');if(!can(e,code,org,owner))fail('ACCESS_DENIED');};
 const requireRecord=(e,code,row,owner=row.responsible_id)=>{identity(e);if(!can(e,code,row.organization_id,owner)&&!can(e,code,row.responsible_organization_id,owner))fail('ACCESS_DENIED');};
 const grant=(e,code)=>e.businessAuthorization.grants.find(g=>g.permission===full(code));
 async function write(requestId,ops,signal){if(!uuid(requestId))fail('INVALID_INPUT');if(ops.length>16||Buffer.byteLength(JSON.stringify({requestId,operations:ops}))>16384)fail('LIMIT_EXCEEDED');try{return await data.transaction(requestId,ops,signal);}catch(error){if(error?.code==='STORAGE_CONFLICT'&&error.writeOutcome==='not_started')fail('CONFLICT');throw error;}}
 async function all(table,options={},signal){let after;const rows=[];do{const result=await data.list(table,{...options,order:{column:'created_at',direction:'asc'},pageSize:5,...(after?{after}:{})},signal);rows.push(...result.rows);after=result.nextCursor;if(rows.length>5000)fail('LIMIT_EXCEEDED');}while(after);return rows;}
 // Reserve numbers in the same transaction as the records; a failed write consumes none.
 async function numbers(kind,size,signal){
  const id=deterministic(`number:${kind}`),{row}=await data.get('number_counters',id,signal),start=row?.value??0;
  if(!Number.isSafeInteger(start)||start<0||start+size>2147483647)fail('LIMIT_EXCEEDED');
  return {values:Array.from({length:size},(_,index)=>`${{monthly:'月',annual:'年',supervision:'督'}[kind]}${String(start+index+1).padStart(3,'0')}`),operation:row
   ?{action:'update',table:'number_counters',id,expected:{value:start},values:{value:start+size}}
   :{action:'insert',table:'number_counters',id,values:{value:size}}};
 }
 const event=(row,action,summary,e,details=null)=>({action:'insert',table:'work_events',id:newId(),values:{organization_id:row.organization_id,record_id:row.id,created_by:e.personId,created_at:now(),action,summary,details}});
 const scoped=(e,code,creator=false)=>{
  const g=grant(e,code);if(!g)fail('ACCESS_DENIED');if(g.all)return {};
  const anyOf=g.organizationIds.length?[[{column:'organization_id',in:[...g.organizationIds]}],[{column:'responsible_organization_id',in:[...g.organizationIds]}]]:[];
  if(g.self){anyOf.push([{column:'responsible_id',value:e.personId}]);if(creator)anyOf.push([{column:'created_by',value:e.personId}]);}
  if(!anyOf.length)fail('ACCESS_DENIED');return {anyOf};
 };
 async function currentOrg(e,org,signal){const result=await gateway.invoke('platform.people.organization_context',{organizationUnitId:e.organizationUnitId},signal);if(!result.organizations?.some(value=>value.id===org))fail('ACCESS_DENIED');}
 async function candidates(e,kind,query,signal){
  identity(e);
  const permission=permissions[kind]?.write;
  if(!permission||!grant(e,permission))fail('ACCESS_DENIED');
  return gateway.invoke('platform.people.assignees',{permission,...query},signal);
 }
 async function person(e,kind,value,signal){
  if(!uuid(value?.personId)||!uuid(value.organizationUnitId))fail('PERSON_INVALID');
  const page=await candidates(e,kind,{personId:value.personId},signal);
  const row=page.rows.find(p=>p.id===value.personId&&p.organizationUnitId===value.organizationUnitId);
  if(!row)fail('PERSON_INVALID');
  return {responsible_id:row.id,responsible_organization_id:row.organizationUnitId,responsible_name:row.name};
 }
 function readAccess(e,row){const p=permissions[row.kind];if(!p)fail('INVALID_INPUT');if(!can(e,p.read,row.organization_id,row.responsible_id)&&!can(e,p.read,row.responsible_organization_id,row.responsible_id)&&!(row.kind==='monthly'&&row.created_by===e.personId&&can(e,p.read,row.organization_id,e.personId)))fail('ACCESS_DENIED');}
 async function record(id,e,signal){identity(e);if(!uuid(id))fail('INVALID_INPUT');const {row}=await data.get('work_records',id,signal);if(!row||row.deleted)fail('NOT_FOUND');readAccess(e,row);return row;}
 function version(input,row){if(input.expectedVersion!==row.version)fail('CONFLICT');}
 function update(row,values){return {action:'update',table:'work_records',id:row.id,expected:{version:row.version,status:row.status,deleted:false},values:{...values,version:row.version+1,updated_at:now()}};}
 async function draft(input,e,org,kind,signal){
  keys(input,['content','qualityStandard','startDate','endDate','responsible','month','year','startMonth','endMonth','originalText','annualId','remark']);
  if(!text(input.content)||!text(input.qualityStandard??'',500,kind!=='annual')||!text(input.remark??'',500,false)||!text(input.originalText??'',1500,false))fail('INVALID_INPUT');
  const who=await person(e,kind,input.responsible,signal);
  if(kind==='annual'){
   if(!Number.isInteger(input.year)||input.year<2000||input.year>2100||!Number.isInteger(input.startMonth)||!Number.isInteger(input.endMonth)||input.startMonth<1||input.endMonth>12||input.startMonth>input.endMonth)fail('ANNUAL_INVALID');
  }else if(!day(input.endDate)||kind==='monthly'&&(!validMonth(input.month)||!day(input.startDate)||input.startDate>input.endDate))fail('INVALID_INPUT');
  let annual=null;if(input.annualId){annual=await record(input.annualId,e,signal);if(kind!=='monthly'||annual.kind!=='annual'||annual.organization_id!==org||annual.responsible_id!==who.responsible_id||annual.status==='completed'||!relevantAnnual([annual],input.month,who.responsible_id).length)fail('ANNUAL_INVALID');}
  return {...who,content:input.content.trim(),quality_standard:(input.qualityStandard??'').trim(),month:kind==='monthly'?input.month:null,year:kind==='annual'?input.year:null,start_month:kind==='annual'?input.startMonth:null,end_month:kind==='annual'?input.endMonth:null,start_date:kind==='monthly'?input.startDate:null,end_date:kind==='annual'?null:input.endDate,original_text:kind==='monthly'?(input.originalText?.trim()||null):null,annual_id:annual?.id??null,remark:input.remark?.trim()||null};
 }
 async function corpus(org,signal){
  const result={terms:[],examples:[]};
  for(const libraryId of ['terms','examples']){
   let afterId;
   do{const page=await knowledge.list({libraryId,organizationId:org,...(afterId?{afterId}:{})},signal);
    result[libraryId].push(...page.entries.map(row=>libraryId==='terms'?{id:row.id,version:row.version,term:row.title,explanation:row.content}:{id:row.id,version:row.version,content:row.content,quality_standard:row.metadata.qualityStandard,indexStatus:row.indexStatus,...(row.indexError?{indexError:row.indexError}:{})}));
    afterId=page.nextCursor;if(result[libraryId].length>5000)fail('LIMIT_EXCEEDED');
   }while(afterId);
  }
  return result;
 }
 async function attachmentAccess(input,e,signal){
  keys(input,['action','entityType','entityId','attachmentId','requestId']);if(!uuid(input.entityId)||!uuid(input.requestId)||input.attachmentId!==undefined&&!uuid(input.attachmentId)||!['upload','read','export'].includes(input.action))fail('INVALID_INPUT');
  if(input.entityType!=='work_record')fail('INVALID_INPUT');const row=await record(input.entityId,e,signal);
  if(input.action==='upload'){if(row.kind!=='monthly')fail('ACCESS_DENIED');requireRecord(e,permissions[row.kind].complete,row);if(row.responsible_id!==e.personId||row.status!=='in_progress')fail('ACCESS_DENIED');}
  if(input.action==='export')requireRecord(e,'attachment_export',row);
  return {organizationId:row.organization_id};
 }
 async function planPrompt(org,signal,{table,defaultPrompt}=promptSettings.organize){
  const {row}=await data.get(table,org,signal);
  return {prompt:row?.prompt??defaultPrompt,version:row?.version??0};
 }
 async function summarizePlans(plans,instructions,signal){
  const prompt=JSON.stringify({plans});
  if(prompt.length>12000)fail('SUMMARY_INPUT_LIMIT');
  const summary=await completeText(ai,{system:summarySystemPrompt(instructions),prompt},signal);
  return {summary};
 }
 async function defaultDepartment(e,signal){
  identity(e);
  const context=await gateway.invoke('platform.people.organization_context',{organizationUnitId:e.organizationUnitId},signal);
  const department=context.organizations.find(unit=>unit.unitType==='department')??context.organizations.at(-1);
  if(!department)fail('ACCESS_DENIED');
  return department.id;
 }
 async function planReferences(org,query,signal){
  const [matched,related]=await Promise.all([
   knowledge.search({libraryId:'terms',organizationId:org,query},signal),
   knowledge.search({libraryId:'examples',organizationId:org,query,limit:5},signal)
  ]);
  return {organizationId:org,terms:matched.entries.map(row=>({term:row.title,explanation:row.content})),examples:related.entries.map(row=>({content:row.content,qualityStandard:row.metadata.qualityStandard})),sources:[...matched.entries,...related.entries].map(row=>({...row.reference,title:row.title})),retrieval:related.retrieval};
 }
 async function suggestPlan(input,signal,references,instructions){const terms=references.terms,scored=references.examples;const system=planSystemPrompt(instructions);let response;try{response=await ai.complete({system,prompt:JSON.stringify({rawText:input.rawText,month:input.month,today:today(),protectedTerms:terms.map(row=>row.term),termExplanations:terms.map(row=>({term:row.term,explanation:row.explanation??''})),examples:scored})},signal);}catch{fail('AI_UNAVAILABLE');}let result;try{result=JSON.parse(String(response.content).replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{fail('AI_INVALID_RESULT');}keys(result,['content','qualityStandard','startDate','endDate','responsibleName','missingInfo']);if(result.responsibleName!=null&&(!text(result.responsibleName,100)||!input.rawText.includes(result.responsibleName)))fail('AI_INVALID_RESULT');if(!text(result.content)||!text(result.qualityStandard)||![result.startDate,result.endDate].every(value=>value===null||day(value))||result.startDate&&result.endDate&&result.startDate>result.endDate||!Array.isArray(result.missingInfo)||result.missingInfo.length>6||result.missingInfo.some(value=>!text(value,100)))fail('AI_INVALID_RESULT');if(terms.some(row=>!result.content.includes(row.term)))fail('TERM_CHANGED');const defaults=monthlyDates(today());return {...result,startDate:result.startDate??defaults.startDate,endDate:result.endDate??defaults.endDate,missingInfo:[],sources:references.sources,retrieval:references.retrieval};}
 const service={
  async session(input,e,signal){
   keys(input,[]);identity(e);
   // Reuse only this request's verified ancestor paths; never cache permissions across requests.
   const contexts=new Map(),grants=e.businessAuthorization.grants,departments=new Map(),workgroups=[];
   const contextFor=async id=>{
    if(contexts.has(id))return contexts.get(id);
    const context=await gateway.invoke('platform.people.organization_context',{organizationUnitId:id},signal);
    context.organizations.forEach((unit,index)=>contexts.set(unit.id,{organizations:context.organizations.slice(index)}));
    return context;
   };
   const own=await contextFor(e.organizationUnitId);
   for(const team of e.businessAuthorization.organizations){
    const context=await contextFor(team.id),parent=context.organizations.find(unit=>unit.unitType==='department')??context.organizations.at(-1);
    if(parent){departments.set(parent.id,{id:parent.id,name:parent.name});if(!workgroups.some(row=>row.id===team.id))workgroups.push({...team,departmentId:parent.id});}
   }
   const current=own.organizations.find(unit=>unit.unitType==='department')??own.organizations.at(-1);
   if(current&&grants.some(g=>g.self||g.all||g.organizationIds.includes(current.id)))departments.set(current.id,{id:current.id,name:current.name});
   for(const parent of departments.values()){
    if(!grants.some(g=>g.all||g.organizationIds.includes(parent.id)||g.self&&parent.id===current?.id))continue;
    const directory=await gateway.invoke('platform.people.workgroups',{organizationUnitId:parent.id},signal);
    for(const team of directory.rows)if(!workgroups.some(row=>row.id===team.id))workgroups.push({...team,departmentId:parent.id});
   }
   const self=grant(e,'fill')?(await candidates(e,'monthly',{personId:e.personId},signal)).rows.find(p=>p.id===e.personId):null;
   return {self:self?{personId:self.id,organizationUnitId:self.organizationUnitId,name:self.name}:null,personId:e.personId,organizationId:e.organizationUnitId,organizations:[...departments.values()].sort((a,b)=>Number(b.id===current?.id)-Number(a.id===current?.id)),workgroups,approvedDelete:grant(e,'approved_delete')??null,permissions:grants.map(g=>g.permission)};
  },
  async members(input,e,signal){
   keys(input,['kind','search','afterId','exact']);
   if(!text(input.search??'',100,false)||input.afterId!==undefined&&!uuid(input.afterId)||input.exact!==undefined&&typeof input.exact!=='boolean')fail('INVALID_INPUT');
   const {kind,...query}=input;
   return candidates(e,kind,query,signal);
  },
  async 'authorize-transcription'(input,e){
   keys(input,[]);identity(e);
   if(!grant(e,'supervision_manage'))fail('ACCESS_DENIED');
   return {allowed:true};
  },
  async 'supervision-extract'(input,e,signal){
   keys(input,['notes']);identity(e);
   if(!grant(e,'supervision_manage'))fail('ACCESS_DENIED');
   return {items:await extractSupervision(ai,input.notes,today(),signal)};
  },
  async 'record-list'(input,e,signal){
   input={...input,organizationId:input.organizationId??await defaultDepartment(e,signal)};
   keys(input,['organizationId','kind','month','year','status','search','after','mine']);identity(e);const p=permissions[input.kind];if(!p||!uuid(input.organizationId)||input.month!==undefined&&!validMonth(input.month)||input.year!==undefined&&(!Number.isInteger(input.year)||input.year<2000||input.year>2100)||input.status!==undefined&&!['draft','submitted','in_progress','completed','returned'].includes(input.status)||!text(input.search??'',100,false)||input.mine!==undefined&&typeof input.mine!=='boolean')fail('INVALID_INPUT');
   const g=grant(e,p.read);if(g?.self&&!g.all&&!g.organizationIds.includes(input.organizationId))await currentOrg(e,input.organizationId,signal);const filters=[{column:'kind',value:input.kind},{column:'deleted',value:false},...(input.month?[{column:'month',value:input.month}]:[]),...(input.year?[{column:'year',value:input.year}]:[]),...(input.status?[{column:'status',value:input.status}]:[]),...(input.mine?[{column:'responsible_id',value:e.personId}]:[])];
   return data.list('work_records',{columns:['organization_id','kind','number','content','quality_standard','responsible_id','responsible_organization_id','responsible_name','status','month','year','start_month','end_month','start_date','end_date','remark','latest_progress','completed_at','created_by','version'],filters,...scoped(e,p.read,input.kind==='monthly'),order:{column:'created_at',direction:'desc'},pageSize:8,...(input.after?{after:input.after}:{}),...(input.search?{search:{column:'content',text:input.search}}:{})},signal);
  },
  async 'record-get'(input,e,signal){keys(input,['id','after']);const row=await record(input.id,e,signal);const events=await data.list('work_events',{filters:[{column:'record_id',value:row.id}],order:{column:'created_at',direction:'desc'},pageSize:8,...(input.after?{after:input.after}:{})},signal);const extensions=await all('deadline_requests',{filters:[{column:'record_id',value:row.id}]},signal);return {record:row,events,extensions};},
  async 'record-save'(input,e,signal){
   keys(input,['id','requestId','organizationId','kind','expectedVersion','draft','submit']);identity(e);if(!uuid(input.id)||!uuid(input.organizationId)||!permissions[input.kind]||input.submit!==undefined&&typeof input.submit!=='boolean')fail('INVALID_INPUT');
   const {row:old}=await data.get('work_records',input.id,signal);if(!old&&input.expectedVersion!==undefined)fail('CONFLICT');if(old){readAccess(e,old);version(input,old);if(old.organization_id!==input.organizationId||old.kind!==input.kind||old.deleted)fail('CONFLICT');if(old.kind==='monthly'&&(!['draft','returned'].includes(old.status)||old.created_by!==e.personId))fail('CONFLICT');if(old.kind==='annual'&&old.status==='completed')fail('CONFLICT');}
   if(!can(e,permissions[input.kind].write,input.organizationId,old?.created_by??e.personId)&&!can(e,permissions[input.kind].write,input.draft?.responsible?.organizationUnitId,old?.created_by??e.personId))fail('ACCESS_DENIED');
   if(!can(e,permissions[input.kind].write,input.organizationId))await currentOrg(e,input.organizationId,signal);
   const values=await draft(input.draft,e,input.organizationId,input.kind,signal),status=input.kind==='monthly'?(input.submit?'submitted':'draft'):(old?.status??'in_progress');
   const allocated=old?null:await numbers(input.kind,1,signal);
   const row={id:input.id,organization_id:input.organizationId,kind:input.kind,number:old?.number??allocated.values[0],...values,status,review_comment:null,intent_id:input.requestId};
   const changes=old?[update(old,row)]:[{action:'insert',table:'work_records',id:row.id,values:Object.fromEntries(Object.entries({...row,created_by:e.personId,created_at:now(),updated_at:now(),version:1,latest_progress:null,completed_at:null,deleted:false}).filter(([key])=>key!=='id'))}];
   if(old)delete changes[0].values.id;
   await write(input.requestId,[...(allocated?[allocated.operation]:[]),...changes,event(row,input.submit?'submitted':old?'updated':'created',input.submit?'提交计划审核':old?'更新记录':'创建记录',e)],signal);return {id:row.id,status,version:old?old.version+1:1};
  },
  async 'record-review'(input,e,signal){keys(input,['id','requestId','expectedVersion','action','comment']);const row=await record(input.id,e,signal);requireRecord(e,'review',row);version(input,row);if(row.kind!=='monthly'||row.status!=='submitted'||!['approve','return'].includes(input.action)||!text(input.comment??'',500,input.action==='return'))fail('INVALID_INPUT');const status=input.action==='approve'?'in_progress':'returned';await write(input.requestId,[update(row,{status,review_comment:input.comment?.trim()||null}),event(row,input.action,input.comment?.trim()||(input.action==='approve'?'审核通过':'退回修改'),e)],signal);return {id:row.id,status};},
  async 'record-progress'(input,e,signal){keys(input,['id','requestId','expectedVersion','summary','complete']);const row=await record(input.id,e,signal);requireRecord(e,permissions[row.kind].complete,row);if(row.responsible_id!==e.personId||row.status!=='in_progress')fail('ACCESS_DENIED');version(input,row);if(typeof input.complete!=='boolean'||!text(input.summary??'',500,!input.complete))fail('INVALID_INPUT');
   if(input.complete&&row.kind==='monthly'){const result=await attachments.list({entityType:'work_record',entityId:row.id,organizationId:row.organization_id,availableOnly:true},signal);if(!result.attachments?.length)fail('ATTACHMENT_REQUIRED');}
   const status=input.complete?'completed':'in_progress',summary=input.summary?.trim()||(input.complete?'责任人确认完成':'');await write(input.requestId,[update(row,{status,latest_progress:summary,completed_at:input.complete?now():null}),event(row,input.complete?'completed':'progress',summary,e)],signal);return {id:row.id,status};
  },
  async 'record-delete'(input,e,signal){keys(input,['id','requestId','expectedVersion']);const row=await record(input.id,e,signal);if(row.kind==='monthly'){if(!['in_progress','completed'].includes(row.status))fail('ACCESS_DENIED');requireRecord(e,'approved_delete',row);}else requireRecord(e,row.kind==='supervision'?'supervision_delete':'annual_manage',row,null);version(input,row);await write(input.requestId,[update(row,{deleted:true}),event(row,'deleted','删除记录',e,{content:row.content,responsibleId:row.responsible_id,endDate:row.end_date})],signal);return {id:row.id};},
  async 'extension-create'(input,e,signal){keys(input,['id','requestId','recordId','expectedVersion','newDate','reason']);if(!uuid(input.id)||!day(input.newDate)||!text(input.reason))fail('INVALID_INPUT');const row=await record(input.recordId,e,signal);requireRecord(e,'extend',row);if(row.kind!=='monthly'||row.responsible_id!==e.personId||row.status!=='in_progress'||input.newDate<=row.end_date)fail('INVALID_INPUT');version(input,row);const pending=await all('deadline_requests',{filters:[{column:'record_id',value:row.id},{column:'status',value:'pending'}]},signal);if(pending.length)fail('DEADLINE_PENDING');await write(input.requestId,[update(row,{}),{action:'insert',table:'deadline_requests',id:input.id,values:{organization_id:row.organization_id,record_id:row.id,old_date:row.end_date,new_date:input.newDate,reason:input.reason.trim(),status:'pending',created_by:e.personId,created_at:now(),updated_at:now(),version:1,reviewed_by:null,review_comment:null,record_version:row.version+1}},event(row,'extension-requested',input.reason.trim(),e,{oldDate:row.end_date,newDate:input.newDate})],signal);return {id:input.id};},
  async 'extension-review'(input,e,signal){keys(input,['id','requestId','expectedVersion','action','comment']);if(!uuid(input.id))fail('INVALID_INPUT');const {row:request}=await data.get('deadline_requests',input.id,signal);if(!request)fail('NOT_FOUND');const row=await record(request.record_id,e,signal);requireRecord(e,'extension_review',row,null);if(request.status!=='pending'||request.version!==input.expectedVersion||row.status!=='in_progress'||row.end_date!==request.old_date)fail('CONFLICT');if(!['approve','return'].includes(input.action)||!text(input.comment??'',500,input.action==='return'))fail('INVALID_INPUT');await write(input.requestId,[update(row,input.action==='approve'?{end_date:request.new_date}:{}),{action:'update',table:'deadline_requests',id:request.id,expected:{status:'pending',version:request.version},values:{status:input.action==='approve'?'approved':'returned',reviewed_by:e.personId,review_comment:input.comment?.trim()||null,updated_at:now(),version:request.version+1}},event(row,'extension-'+input.action,input.comment?.trim()||'批准延期',e,{oldDate:request.old_date,newDate:request.new_date,reason:request.reason})],signal);return {id:request.id};},
  async 'annual-hints'(input,e,signal){keys(input,['organizationId','month']);if(!validMonth(input.month)||!uuid(input.organizationId))fail('INVALID_INPUT');require(e,'fill',input.organizationId,e.personId);await currentOrg(e,input.organizationId,signal);const rows=await all('work_records',{filters:[{column:'kind',value:'annual'},{column:'responsible_id',value:e.personId},{column:'deleted',value:false},{column:'year',value:Number(input.month.slice(0,4))}]},signal);return {rows:relevantAnnual(rows,input.month,e.personId)};},
  async 'annual-import'(input,e,signal){keys(input,['id','requestId','organizationId','rows','offset','total']);if(!uuid(input.id)||!uuid(input.organizationId)||!Array.isArray(input.rows)||input.rows.length<1||input.rows.length>5||!Number.isInteger(input.offset)||!Number.isInteger(input.total)||input.offset<0||input.total>500||input.offset+input.rows.length>input.total)fail('INVALID_INPUT');require(e,'annual_manage',input.organizationId);const {row:batch}=await data.get('annual_imports',input.id,signal);if(batch&&(batch.organization_id!==input.organizationId||batch.created_by!==e.personId||batch.total!==input.total||batch.imported!==input.offset)||!batch&&input.offset!==0)fail('CONFLICT');const allocated=await numbers('annual',input.rows.length,signal),ops=[allocated.operation],ids=[];for(const [index,raw] of input.rows.entries()){const values=await draft(raw,e,input.organizationId,'annual',signal),id=deterministic(`${input.id}:${input.offset+index}`);ids.push(id);ops.push({action:'insert',table:'work_records',id,values:{...values,organization_id:input.organizationId,kind:'annual',number:allocated.values[index],status:'in_progress',review_comment:null,intent_id:input.requestId,created_by:e.personId,created_at:now(),updated_at:now(),version:1,latest_progress:null,completed_at:null,deleted:false}});ops.push(event({id,organization_id:input.organizationId},'imported','年度计划导入',e,{batchId:input.id}));}
   const imported=(batch?.imported??0)+ids.length,status=imported===input.total?'completed':'in_progress';ops.push(batch?{action:'update',table:'annual_imports',id:input.id,expected:{version:batch.version},values:{imported,status,version:batch.version+1,updated_at:now()}}:{action:'insert',table:'annual_imports',id:input.id,values:{organization_id:input.organizationId,created_by:e.personId,created_at:now(),updated_at:now(),version:1,imported,total:input.total,status}});await write(input.requestId,ops,signal);return {id:input.id,imported,status};
  },
  async 'corpus-list'(input,e,signal){keys(input,['organizationId']);return corpus(input.organizationId,signal);},
  async 'corpus-reindex'(input,e,signal){keys(input,['organizationId','id','requestId','expectedVersion']);return knowledge.write({...input,libraryId:'examples',action:'reindex'},signal);},
  async 'corpus-save'(input,e,signal){
   keys(input,['id','requestId','organizationId','kind','expectedVersion','term','explanation','content','qualityStandard','remove']);
   if(!['term','example'].includes(input.kind)||input.remove!==undefined&&typeof input.remove!=='boolean')fail('INVALID_INPUT');
   const target={libraryId:input.kind==='term'?'terms':'examples',organizationId:input.organizationId,id:input.id,requestId:input.requestId};
   if(input.remove)return knowledge.write({...target,action:'delete',expectedVersion:input.expectedVersion},signal);
   if(input.kind==='term'?(!text(input.term,100)||!text(input.explanation??'',500,false)):(!text(input.content)||!text(input.qualityStandard)))fail('INVALID_INPUT');
   return knowledge.write({...target,action:'save',...(input.expectedVersion!==undefined?{expectedVersion:input.expectedVersion}:{}),
    title:input.kind==='term'?input.term.trim():input.content.trim().slice(0,100),content:input.kind==='term'?(input.explanation??'').trim():input.content.trim(),
    metadata:input.kind==='term'?{}:{qualityStandard:input.qualityStandard.trim()}},signal);
  },
  async 'plan-prompt-get'(input,e,signal){
   keys(input,['organizationId','kind']);require(e,'corpus',input.organizationId);
   const config=promptKind(input.kind);
   return {...await planPrompt(input.organizationId,signal,config),defaultPrompt:config.defaultPrompt};
  },
  async 'plan-prompt-save'(input,e,signal){
   keys(input,['organizationId','kind','prompt','expectedVersion','requestId']);require(e,'corpus',input.organizationId);
   if(!text(input.prompt,PLAN_PROMPT_MAX_LENGTH)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fail('INVALID_INPUT');
   const config=promptKind(input.kind),{table}=config;
   const current=await planPrompt(input.organizationId,signal,config);
   if(current.version!==input.expectedVersion)fail('CONFLICT');
   const values={prompt:input.prompt.trim(),version:current.version+1,updated_by:e.personId,updated_at:now()};
   await write(input.requestId,[current.version
    ?{action:'update',table,id:input.organizationId,expected:{version:current.version},values}
    :{action:'insert',table,id:input.organizationId,values:{...values,organization_id:input.organizationId}}],signal);
   return {prompt:values.prompt,version:values.version};
  },
  async 'plan-prompt-test'(input,e,signal){
   keys(input,['organizationId','kind','prompt','month','rawText']);require(e,'corpus',input.organizationId);
   if(!text(input.prompt,PLAN_PROMPT_MAX_LENGTH)||!validMonth(input.month)||!text(input.rawText,1500))fail('INVALID_INPUT');
   if(promptKind(input.kind)===promptSettings.summary)return summarizePlans([{month:input.month,content:input.rawText.trim()}],input.prompt.trim(),signal);
   const references=await planReferences(input.organizationId,input.rawText,signal);
   return suggestPlan(input,signal,references,input.prompt.trim());
  },
  async 'plan-summary'(input,e,signal){
   input={...input,organizationId:input.organizationId??await defaultDepartment(e,signal)};
   keys(input,['organizationId','ids']);identity(e);
   if(!uuid(input.organizationId)||!Array.isArray(input.ids)||!input.ids.length||input.ids.length>PLAN_SUMMARY_MAX_RECORDS||!input.ids.every(uuid))fail('INVALID_INPUT');
   const ids=[...new Set(input.ids.map(id=>id.toLowerCase()))],scope=scoped(e,'read',true);
   if(!can(e,'read',input.organizationId))await currentOrg(e,input.organizationId,signal);
   const records=new Map();
   for(let start=0;start<ids.length;start+=10){
    const batch=ids.slice(start,start+10);
    const {rows}=await data.list('work_records',{
     columns:['number','month','content','quality_standard','responsible_name','status','latest_progress','start_date','end_date','completed_at'],
     filters:[{column:'id',in:batch},{column:'kind',value:'monthly'},{column:'deleted',value:false}],...scope,pageSize:batch.length
    },signal);
    if(rows.length!==batch.length)fail('ACCESS_DENIED');
    for(const row of rows){
     records.set(row.id,{编号:row.number,月份:row.month,工作内容:row.content,完成标准:row.quality_standard,责任人:row.responsible_name,
      状态:({draft:'草稿',submitted:'待审核',returned:'已退回',in_progress:'执行中',completed:'已完成'})[row.status],办理进度:row.latest_progress,开始日期:row.start_date,截止日期:row.end_date,完成时间:row.completed_at});
    }
   }
   const config=await planPrompt(input.organizationId,signal,promptSettings.summary);
   return summarizePlans(ids.map(id=>records.get(id)),config.prompt,signal);
  },
  async 'plan-suggest'(input,e,signal){
   input={...input,organizationId:input.organizationId??await defaultDepartment(e,signal)};
   keys(input,['organizationId','month','rawText']);require(e,'fill',input.organizationId,e.personId);await currentOrg(e,input.organizationId,signal);
   if(!validMonth(input.month)||!text(input.rawText,1500))fail('INVALID_INPUT');
   const [references,config]=await Promise.all([planReferences(input.organizationId,input.rawText,signal),planPrompt(input.organizationId,signal)]);
   const suggestion=await suggestPlan(input,signal,references,config.prompt);
   const named=suggestion.responsibleName;const page=await candidates(e,'monthly',named?{search:named,exact:true}:{personId:e.personId},signal);
   const found=named?(page.rows.length===1&&!page.nextCursor?page.rows[0]:null):page.rows.find(p=>p.id===e.personId);
   return {...suggestion,responsible:found?{personId:found.id,organizationUnitId:found.organizationUnitId,name:found.name}:null};},
  async 'settings-get'(input,e,signal){keys(input,['organizationId']);require(e,'settings',input.organizationId);const {row}=await data.get('reminder_settings',input.organizationId,signal);return {version:row?.version??0,enabled:row?.enabled??false,advanceDays:row?.advance_days??3,sendHour:row?.send_hour??9,overdueEveryDays:row?.overdue_every_days??1,webhookConfigured:!!row?.webhook_url};},
  async 'settings-save'(input,e,signal){keys(input,['organizationId','requestId','expectedVersion','webhookUrl','clearWebhook','enabled','advanceDays','sendHour','overdueEveryDays']);require(e,'settings',input.organizationId);if(typeof input.enabled!=='boolean'||!Number.isInteger(input.advanceDays)||input.advanceDays<1||input.advanceDays>30||!Number.isInteger(input.sendHour)||input.sendHour<0||input.sendHour>23||!Number.isInteger(input.overdueEveryDays)||input.overdueEveryDays<1||input.overdueEveryDays>30||input.webhookUrl!==undefined&&!text(input.webhookUrl,2048,false)||input.clearWebhook!==undefined&&typeof input.clearWebhook!=='boolean')fail('INVALID_INPUT');const {row}=await data.get('reminder_settings',input.organizationId,signal);if((row?.version??0)!==input.expectedVersion)fail('CONFLICT');const url=input.clearWebhook?'':input.webhookUrl?.trim()?parseWebhook(input.webhookUrl.trim()):row?.webhook_url??'';if(input.enabled&&!url)fail('INVALID_WEBHOOK');const values={webhook_url:url,enabled:input.enabled,advance_days:input.advanceDays,send_hour:input.sendHour,overdue_every_days:input.overdueEveryDays,updated_at:now(),version:(row?.version??0)+1};await write(input.requestId,[row?{action:'update',table:'reminder_settings',id:row.id,expected:{version:row.version},values}:{action:'insert',table:'reminder_settings',id:input.organizationId,values:{...values,organization_id:input.organizationId,created_by:e.personId,created_at:now()}},event({id:input.organizationId,organization_id:input.organizationId},'settings-updated','更新群提醒设置',e,{enabled:input.enabled,advanceDays:input.advanceDays,sendHour:input.sendHour})],signal);return {saved:true};},
  async 'reminder-list'(input,e,signal){keys(input,['organizationId','after']);require(e,'settings',input.organizationId);return data.list('reminder_deliveries',{filters:[{column:'organization_id',value:input.organizationId}],order:{column:'created_at',direction:'desc'},pageSize:8,...(input.after?{after:input.after}:{})},signal);},
  'authorize-attachment':attachmentAccess,
  async 'dashboard-summary'(input,e,signal){keys(input,[]);identity(e);const scope=scoped(e,'read',true);return readAppDashboard({readBatch:data.readBatch,table:'work_records',scope,filters:[{column:'kind',value:'monthly'},{column:'deleted',value:false}],done:[{column:'status',value:'completed'}],trend:{kind:'line',column:'created_at',label:'新增计划',days:14},previewColumns:['content','responsible_name'],labels:['待完成计划','已完成','计划总数'],unit:'项',clock,preview:row=>({id:row.id,title:row.content,description:row.responsible_name,occurredAt:row.created_at})},signal);}
 };
 let scanning=false;
 async function scanReminders(signal){
  if(scanning||signal?.aborted)return;scanning=true;
  try{const settings=await all('reminder_settings',{filters:[{column:'enabled',value:true}]},signal),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(clock()));
   for(const config of settings){if(signal?.aborted)return;if(hour<config.send_hour||!config.webhook_url)continue;const rows=await all('work_records',{filters:[{column:'organization_id',value:config.organization_id},{column:'deleted',value:false},{column:'status',value:'in_progress'}]},signal);
    for(const row of rows){if(signal?.aborted)return;if(!['monthly','supervision'].includes(row.kind)||!reminderDue(row,config,today()))continue;const id=deterministic(`${row.id}:${row.end_date}:${today()}`),{row:sent}=await data.get('reminder_deliveries',id,signal);if(sent)continue;
     try{await write(newId(),[{action:'insert',table:'reminder_deliveries',id,values:{organization_id:row.organization_id,record_id:row.id,created_by:config.created_by,created_at:now(),updated_at:now(),due_date:row.end_date,reminder_day:today(),status:'sending',error:null}}],signal);}catch(error){if(error.message==='CONFLICT')continue;throw error;}
     // Recheck source and configuration after the persistent claim, before external delivery.
     let status='skipped',error=null;try{const {row:fresh}=await data.get('work_records',row.id,signal),{row:live}=await data.get('reminder_settings',config.id,signal);if(fresh&&live?.enabled&&live.version===config.version&&fresh.end_date===row.end_date&&reminderDue(fresh,live,today())){await webhook.send({url:live.webhook_url,message:`【${row.kind==='monthly'?'月度计划':'督办提醒'}】\n编号：${row.number}\n事项：${row.content}\n责任人：${row.responsible_name}\n截止日期：${row.end_date}\n请及时办理。`,messageType:'text'},signal);status='sent';}}catch(failure){status=failure?.writeOutcome==='not_started'?'failed':'unknown';error='发送未确认，请核对群消息，勿自动重发';}
     await write(newId(),[{action:'update',table:'reminder_deliveries',id,expected:{status:'sending'},values:{status,error,updated_at:now()}}],signal);
    }
   }
  }finally{scanning=false;}
 }
 return {service,scanReminders};
}

export function createReformHandlers(gateway,options){const {service,scanReminders}=createReformService(gateway,options);const handlers=Object.fromEntries(Object.entries(service).map(([name,run])=>[name,async(input,ctx)=>{if(name==='authorize-attachment')return run(input,ctx.employee,ctx.signal);try{return {ok:true,result:await run(input,ctx.employee,ctx.signal)};}catch(error){const source=error?.code??error?.message;const code=DEFINITIVE.has(source)?source:READS.has(name)&&PUBLIC_READ_ERRORS.has(source)?source:READS.has(name)?'READ_FAILED':'OPERATION_UNCONFIRMED';const requestId=ctx.employee?.requestId;if(DIAGNOSTIC_READS.has(name))ctx.log?.(JSON.stringify({event:'hct.'+name+'.failed',code,requestId,errorType:error?.name??'Error'}));return {ok:false,error:{code,writeOutcome:DEFINITIVE.has(code)||READS.has(name)?'not_started':'unknown',...(DIAGNOSTIC_READS.has(name)&&requestId?{requestId}:{})}};}}]));return {handlers,scanReminders};}
