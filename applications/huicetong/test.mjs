import {AsyncLocalStorage} from 'node:async_hooks';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {createReformService,createReformHandlers} from './src/reform-service.mjs';
import {annualMonths,relevantAnnual,reminderDue,parseWebhook,day} from './src/reform-rules.mjs';
import {DEFAULT_PLAN_PROMPT,DEFAULT_SUMMARY_PROMPT,PLAN_PROMPT_MAX_LENGTH,planSystemPrompt} from './src/plan-prompt.mjs';

const migrations=await Promise.all((await readdir(new URL('./migrations/',import.meta.url))).filter(name=>name.endsWith('.json')).sort().map(async name=>JSON.parse(await readFile(new URL('./migrations/'+name,import.meta.url),'utf8'))));
const schema={operations:migrations.flatMap(value=>value.operations)};
export function fixture(){
 const department=randomUUID(),otherDepartment=randomUUID(),team=randomUUID(),otherTeam=randomUUID(),foreignTeam=randomUUID(),person=randomUUID(),colleague=randomUUID(),outside=randomUUID();
 const tables=new Map(schema.operations.filter(op=>op.kind==='createTable').map(op=>[op.table,new Map()])),people=[{id:person,name:'张三',employeeNo:'001',organizationUnitId:team},{id:colleague,name:'李四',employeeNo:'002',organizationUnitId:otherTeam},{id:outside,name:'外部门',employeeNo:'003',organizationUnitId:foreignTeam}];
 const orgs=new Map([[team,department],[otherTeam,department],[foreignTeam,otherDepartment]]),writes=[],sent=[],attachments=new Map(),recorded=new Map();let instant=new Date('2026-10-26T01:05:00Z'),aiResult={content:'完成AFC设备排查',qualityStandard:'提交排查清单',startDate:'2026-10-01',endDate:'2026-10-31',missingInfo:[]};
 const clone=value=>structuredClone(value);
 const hostEmployee=new AsyncLocalStorage(),aiRequests=[];
 const gateway={async invoke(operation,payload){
  if(operation.startsWith('platform.knowledge.')){
   const e=hostEmployee.getStore()??employee,required=operation==='platform.knowledge.search'?['fill','corpus']:['corpus'];
   const grants=e.businessAuthorization.grants.filter(g=>required.includes(g.permission.split('.').at(-1)));
   if(!grants.some(g=>g.all||g.organizationIds.includes(payload.organizationId)||operation==='platform.knowledge.search'&&g.self&&orgs.get(e.organizationUnitId)===payload.organizationId))throw Error('ACCESS_DENIED');
   const terms=payload.libraryId==='terms',table=tables.get(terms?'corpus_terms':'corpus_examples');
   const entry=row=>({id:row.id,title:terms?row.term:row.content.slice(0,100),content:terms?row.explanation:row.content,metadata:terms?{}:{qualityStandard:row.quality_standard},version:row.version});
   if(operation==='platform.knowledge.list')return {entries:[...table.values()].filter(row=>!row.deleted&&row.organization_id===payload.organizationId).map(entry),nextCursor:null};
   if(operation==='platform.knowledge.search')return {entries:[...table.values()].filter(row=>!row.deleted&&row.organization_id===payload.organizationId&&(terms?payload.query.includes(row.term):[...payload.query].some(char=>row.content.includes(char)))).map(row=>({...entry(row),score:1}))};
   assert.equal(operation,'platform.knowledge.write');
   if(recorded.has(payload.requestId)){assert.deepEqual(recorded.get(payload.requestId).input,payload);return clone(recorded.get(payload.requestId).result);}
   const old=terms&&payload.action==='save'&&payload.expectedVersion===undefined?[...table.values()].find(row=>row.organization_id===payload.organizationId&&row.term===payload.title):table.get(payload.id);
   if(payload.expectedVersion!==undefined?(!old||old.deleted||old.version!==payload.expectedVersion):old&&!old.deleted)throw Error('KNOWLEDGE_CONFLICT');
   if(terms&&old&&payload.action==='save'&&payload.title!==old.term)throw Error('KNOWLEDGE_CONFLICT');
   const id=old?.id??payload.id,version=(old?.version??0)+1;
   table.set(id,{...old,id,organization_id:payload.organizationId,version,deleted:payload.action==='delete',...(payload.action==='save'?(terms?{term:payload.title,explanation:payload.content}:{content:payload.content,quality_standard:payload.metadata.qualityStandard}):{})});
   const result={id,version};recorded.set(payload.requestId,{input:clone(payload),result});return result;
  }
  if(operation==='platform.people.organization_context'){const parent=orgs.get(payload.organizationUnitId);return {organizations:parent?[{id:payload.organizationUnitId,name:'工班',unitType:'workgroup'},{id:parent,name:'维保部',unitType:'department'}]:[{id:payload.organizationUnitId,name:'维保部',unitType:'department'}]};}
  if(operation==='platform.people.workgroups')return {rows:[...orgs].filter(([,org])=>org===payload.organizationUnitId).map(([id])=>({id,name:id===team?'一班':'二班'}))};
  if(operation==='platform.people.assignees'){
   const e=hostEmployee.getStore()??employee;
   const grant=e.businessAuthorization.grants.find(g=>g.permission===`app.huicetong.${payload.permission}`);
   if(!grant)throw Error('ACCESS_DENIED');
   const rows=people.filter(row=>(grant.all||grant.organizationIds.includes(row.organizationUnitId)||grant.self&&row.id===e.personId)
     &&(!payload.personId||row.id===payload.personId)
     &&(!payload.search||(payload.exact?row.name===payload.search||row.employeeNo===payload.search:row.name.includes(payload.search)||row.employeeNo.includes(payload.search))));
   return {rows,nextCursor:null};
  }
  if(operation==='platform.people.members')return {organizationUnitId:payload.organizationUnitId,rows:people.filter(row=>row.organizationUnitId===payload.organizationUnitId&&(!payload.personIds||payload.personIds.includes(row.id))&&(!payload.search||row.name.includes(payload.search)||row.employeeNo.includes(payload.search)))};
  if(operation==='platform.attachments.list')return {attachments:clone(attachments.get(payload.entityId)??[]),nextCursor:null};
  if(operation==='platform.ai.complete'){
   aiRequests.push(clone(payload));
   if(aiResult instanceof Error)throw aiResult;
   return {content:typeof aiResult==='string'?aiResult:JSON.stringify(aiResult)};
  }
  if(operation==='platform.webhook.send'){sent.push(payload);return {sent:true};}
  if(operation==='platform.app_data.get')return {row:clone(tables.get(payload.table)?.get(payload.id)??null)};
  if(operation==='platform.app_data.list'){
   let rows=[...tables.get(payload.table).values()].filter(row=>(payload.filters??[]).every(filter=>('in' in filter?filter.in.includes(row[filter.column]):row[filter.column]===filter.value))&&(!payload.anyOf||payload.anyOf.some(group=>group.every(filter=>('in' in filter?filter.in.includes(row[filter.column]):row[filter.column]===filter.value))))&&(!payload.search||String(row[payload.search.column]).toLowerCase().includes(payload.search.text.toLowerCase())));
   if(payload.order){const key=payload.order.column,sign=payload.order.direction==='desc'?-1:1;const compare=(a,b)=>sign*(String(a[key]).localeCompare(String(b[key]))||a.id.localeCompare(b.id));rows.sort(compare);if(payload.after)rows=rows.filter(row=>compare(row,{[key]:payload.after.value,id:payload.after.id})>0);}
   const page=rows.slice(0,payload.pageSize??20),last=page.at(-1);return {rows:clone(page),nextCursor:rows.length>page.length?{id:last.id,value:String(last[payload.order.column])}:null};
  }
  assert.equal(operation,'platform.app_data.transaction');
  if(recorded.has(payload.requestId)){assert.deepEqual(payload.operations,recorded.get(payload.requestId));return {results:[]};}
  assert.ok(payload.operations.length<=16);assert.ok(Buffer.byteLength(JSON.stringify(payload))<16384);
  const next=new Map([...tables].map(([name,rows])=>[name,new Map([...rows].map(([id,row])=>[id,clone(row)]))]));
  for(const op of payload.operations){const rows=next.get(op.table),old=rows.get(op.id);assert.ok(rows,op.table);if(op.action==='insert'){if(old)throw Object.assign(Error('duplicate'),{code:'STORAGE_CONFLICT',writeOutcome:'not_started'});assert.ok(!('id' in op.values));rows.set(op.id,{id:op.id,...clone(op.values)});}else{if(!old||Object.entries(op.expected).some(([key,value])=>JSON.stringify(old[key])!==JSON.stringify(value)))throw Object.assign(Error('stale'),{code:'STORAGE_CONFLICT',writeOutcome:'not_started'});if(op.action==='delete')rows.delete(op.id);else rows.set(op.id,{...old,...clone(op.values)});}}
  tables.clear();for(const [key,value] of next)tables.set(key,value);writes.push(clone(payload));recorded.set(payload.requestId,clone(payload.operations));return {results:[]};
 }};
 const names=['approved_delete','read','fill','review','complete','extend','extension_review','export','attachment_export','supervision_read','supervision_manage','supervision_delete','supervision_complete','annual_read','annual_manage','annual_complete','corpus','settings'];
 const employee={personId:person,organizationUnitId:team,businessAuthorization:{revision:randomUUID(),organizations:[{id:team,name:'一班'},{id:otherTeam,name:'二班'}],grants:names.map(name=>({permission:`app.huicetong.${name}`,all:false,self:false,organizationIds:[department,team,otherTeam]}))}};
 const role=(names,options={})=>({...employee,...options,businessAuthorization:{...employee.businessAuthorization,grants:employee.businessAuthorization.grants.filter(g=>names.includes(g.permission.split('.').at(-1))).map(g=>({...g,...(options.self?{self:true,organizationIds:[]}:{}),...(options.foreign?{organizationIds:[otherDepartment,foreignTeam]}:{})}))}});
 const result=createReformService(gateway,{clock:()=>instant});
 result.service=Object.fromEntries(Object.entries(result.service).map(([name,run])=>[name,(input,e,signal)=>hostEmployee.run(e,()=>run(input,e,signal))]));
 const draft=(kind='monthly',extra={})=>({content:'AFC设备排查',qualityStandard:kind==='annual'?'':'提交排查清单',responsible:{personId:person,organizationUnitId:team},month:'2026-10',startDate:'2026-10-01',endDate:'2026-10-31',year:2026,startMonth:2,endMonth:5,...extra});
 const create=async(kind='monthly',extra={},actor=employee)=>{const id=randomUUID();await result.service['record-save']({id,requestId:randomUUID(),organizationId:department,kind,draft:draft(kind,extra),submit:kind==='monthly'},actor);return tables.get('work_records').get(id);};
 return {...result,department,otherDepartment,team,otherTeam,foreignTeam,person,colleague,outside,tables,people,writes,sent,attachments,gateway,employee,role,draft,create,aiRequests,setClock:value=>{instant=new Date(value);},setAi:value=>{aiResult=value;}};
}
const write=(f,name,payload,actor=f.employee)=>f.service[name]({...payload,requestId:randomUUID()},actor);
const review=(f,row,action='approve',comment='')=>write(f,'record-review',{id:row.id,expectedVersion:row.version,action,comment});

test('five pages and granular permissions replace the entire legacy workflow',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./app.json',import.meta.url),'utf8'));
 assert.deepEqual(manifest.pages.filter(p=>p.nav).map(p=>p.title),['月度计划','督办提醒','年度计划','语料库','基础配置']);
 assert.deepEqual(manifest.pages.find(p=>p.path==='/settings/prompts'),{path:'/settings/prompts',title:'基础配置',permission:'corpus',nav:false});
 assert.ok(!manifest.api.some(api=>/binding|category|cycle|signature|legacy|completion-review/.test(api.id)));
 const ui=await readFile(new URL('./src/plan-fields.jsx',import.meta.url),'utf8');assert.doesNotMatch(ui,/业务模块|更多选项|牵头人|拟提报中心/);
});
test('session exposes departments and workgroups; a self-only role can enter',async()=>{
 const f=fixture(),session=await f.service.session({},f.role(['read','fill'],{self:true}));assert.equal(session.organizations.length,1);assert.equal(session.organizations[0].id,f.department);assert.equal(session.workgroups.length,2);
});
test('submit, return with reason, resubmit and approve are independent of categories and month locks',async()=>{
 const f=fixture(),row=await f.create();assert.equal(row.status,'submitted');await assert.rejects(review(f,row,'return'),/INVALID_INPUT/);await review(f,row,'return','补充质量标准');const returned=f.tables.get('work_records').get(row.id);assert.equal(returned.status,'returned');
 await write(f,'record-save',{id:row.id,organizationId:f.department,kind:'monthly',expectedVersion:returned.version,draft:f.draft(),submit:true});await review(f,f.tables.get('work_records').get(row.id));assert.equal(f.tables.get('work_records').get(row.id).status,'in_progress');assert.ok(f.tables.get('work_events').size>=4);
 await assert.rejects(write(f,'record-save',{id:row.id,organizationId:f.department,kind:'monthly',expectedVersion:4,draft:f.draft({content:'篡改'}),submit:false}),/CONFLICT/);
});
test('self contributor cannot modify another author draft or review without review permission',async()=>{
 const f=fixture(),self=f.role(['read','fill','complete'],{self:true}),row=await f.create('monthly',{},self);await assert.rejects(write(f,'record-review',{id:row.id,expectedVersion:1,action:'approve'},self),/ACCESS_DENIED/);
 const other=f.role(['read','fill'],{personId:f.colleague,organizationUnitId:f.otherTeam,self:true});assert.equal((await f.service['record-list']({organizationId:f.department,kind:'monthly'},other)).rows.length,0);
 await assert.rejects(f.service['record-get']({id:row.id},other),/ACCESS_DENIED/);
 await assert.rejects(f.service['record-save']({id:randomUUID(),requestId:randomUUID(),organizationId:f.otherDepartment,kind:'monthly',draft:f.draft(),submit:true},self),/ACCESS_DENIED/);
});
test('a different responsible person can read their plan, but only the author can edit a returned plan',async()=>{
 const f=fixture(),row=await f.create('monthly',{responsible:{personId:f.colleague,organizationUnitId:f.otherTeam}});await review(f,row,'return','完善');const owner=f.role(['read','fill','complete'],{self:true,personId:f.colleague,organizationUnitId:f.otherTeam});
 assert.equal((await f.service['record-list']({organizationId:f.department,kind:'monthly'},owner)).rows.length,1);assert.equal((await f.service['record-get']({id:row.id},owner)).record.id,row.id);
 await assert.rejects(write(f,'record-save',{id:row.id,organizationId:f.department,kind:'monthly',expectedVersion:2,draft:f.draft(),submit:true},owner),/CONFLICT/);
});
test('monthly completion requires backend verified evidence; approval does not authorize a manager to complete for another person',async()=>{
 const f=fixture(),row=await f.create();await review(f,row);const current=f.tables.get('work_records').get(row.id),input={id:row.id,expectedVersion:current.version,summary:'完成核验',complete:true};
 await assert.rejects(write(f,'record-progress',input),/ATTACHMENT_REQUIRED/);f.attachments.set(randomUUID(),[{attachmentId:randomUUID()}]);await assert.rejects(write(f,'record-progress',input),/ATTACHMENT_REQUIRED/);
 f.attachments.set(row.id,[{attachmentId:randomUUID(),fileName:'报告.mp4'}]);await assert.rejects(write(f,'record-progress',input,f.role(['read','complete'],{personId:f.colleague,organizationUnitId:f.otherTeam})),/ACCESS_DENIED/);
 const result=await write(f,'record-progress',input);assert.equal(result.status,'completed');assert.ok(f.tables.get('work_records').get(row.id).completed_at);await assert.rejects(write(f,'record-progress',input),/ACCESS_DENIED/);
});
test('concurrent changes reject completion without appending false history',async()=>{
 const f=fixture(),row=await f.create();await review(f,row);f.attachments.set(row.id,[{attachmentId:randomUUID()}]);let conflict=false;
 const service=createReformService({invoke:(name,payload)=>{if(name==='platform.app_data.transaction'&&!conflict){conflict=true;f.tables.get('work_records').get(row.id).version++;}return f.gateway.invoke(name,payload);}}).service;
 const before=f.tables.get('work_events').size;await assert.rejects(service['record-progress']({id:row.id,requestId:randomUUID(),expectedVersion:2,summary:'完成',complete:true},f.employee),/CONFLICT/);assert.equal(f.tables.get('work_events').size,before);assert.equal(f.tables.get('work_records').get(row.id).status,'in_progress');
});
test('extension is pending until department approval, reason required, and duplicate pending requests are blocked',async()=>{
 const f=fixture(),row=await f.create();await review(f,row);const id=randomUUID(),input={id,recordId:row.id,expectedVersion:2,newDate:'2026-11-15',reason:'现场施工延期'};
 await assert.rejects(write(f,'extension-create',{...input,reason:''}),/INVALID_INPUT/);await write(f,'extension-create',input);assert.equal(f.tables.get('work_records').get(row.id).end_date,'2026-10-31');
 await assert.rejects(write(f,'extension-create',{...input,id:randomUUID(),expectedVersion:3}),/DEADLINE_PENDING/);
 await assert.rejects(write(f,'extension-review',{id,expectedVersion:1,action:'approve'},f.role(['read','complete'])),/ACCESS_DENIED/);
 await write(f,'extension-review',{id,expectedVersion:1,action:'approve'});assert.equal(f.tables.get('work_records').get(row.id).end_date,'2026-11-15');assert.equal(f.tables.get('deadline_requests').get(id).old_date,'2026-10-31');
 await assert.rejects(write(f,'extension-review',{id,expectedVersion:1,action:'approve'}),/CONFLICT/);
});
test('supervision fields, direct completion, modifications and deletion obey separate permissions',async()=>{
 const f=fixture(),row=await f.create('supervision',{remark:'会议要求'});assert.equal(row.remark,'会议要求');await write(f,'record-progress',{id:row.id,expectedVersion:1,summary:'已落实',complete:false});await write(f,'record-progress',{id:row.id,expectedVersion:2,summary:'办结',complete:true});assert.equal(f.tables.get('work_records').get(row.id).status,'completed');
 await assert.rejects(write(f,'record-delete',{id:row.id,expectedVersion:3},f.role(['supervision_read','supervision_manage'])),/ACCESS_DENIED/);await write(f,'record-save',{id:row.id,organizationId:f.department,kind:'supervision',expectedVersion:3,draft:f.draft('supervision',{content:'修正督办要求'})});assert.equal(f.tables.get('work_records').get(row.id).status,'completed');await write(f,'record-delete',{id:row.id,expectedVersion:4});assert.equal((await f.service['record-list']({organizationId:f.department,kind:'supervision'},f.employee)).rows.length,0);
});
test('single responsible person must be active and from the selected department',async()=>{
 const f=fixture();await assert.rejects(f.create('monthly',{responsible:{personId:f.outside,organizationUnitId:f.foreignTeam}}),/PERSON_INVALID/);await assert.rejects(f.create('monthly',{responsible:[{personId:f.person,organizationUnitId:f.team}]}),/PERSON_INVALID/);
});
test('annual range 2-5 includes all four months, is personal, and completion stops future hints',async()=>{
 const f=fixture(),row=await f.create('annual');for(const month of [1,2,3,4,5,6])assert.equal((await f.service['annual-hints']({organizationId:f.department,month:`2026-${String(month).padStart(2,'0')}`},f.employee)).rows.length,month>=2&&month<=5?1:0);
 assert.deepEqual(annualMonths('2-5月'),[2,5]);assert.deepEqual(annualMonths('2月至5月'),[2,5]);assert.deepEqual(annualMonths('全年'),[1,12]);assert.equal(annualMonths('5-2月'),null);assert.equal(annualMonths('0-13月'),null);
 const other=f.role(['fill','annual_read'],{self:true,personId:f.colleague,organizationUnitId:f.otherTeam});assert.equal((await f.service['annual-hints']({organizationId:f.department,month:'2026-03'},other)).rows.length,0);
 await write(f,'record-progress',{id:row.id,expectedVersion:1,summary:'',complete:true});assert.equal((await f.service['annual-hints']({organizationId:f.department,month:'2026-03'},f.employee)).rows.length,0);
});
test('annual import is batched, checks personnel and never duplicates a confirmed batch',async()=>{
 const f=fixture(),id=randomUUID(),rows=Array.from({length:5},(_,i)=>f.draft('annual',{content:`计划${i}`}));await write(f,'annual-import',{id,organizationId:f.department,rows,offset:0,total:6});assert.equal(f.tables.get('work_records').size,5);
 await assert.rejects(write(f,'annual-import',{id,organizationId:f.department,rows,offset:0,total:6}),/CONFLICT/);
 await write(f,'annual-import',{id,organizationId:f.department,rows:[f.draft('annual')],offset:5,total:6});assert.equal(f.tables.get('annual_imports').get(id).status,'completed');assert.equal(f.tables.get('work_records').size,6);
 const before=f.writes.length;await assert.rejects(write(f,'annual-import',{id:randomUUID(),organizationId:f.department,rows:[f.draft('annual',{startMonth:8,endMonth:2})],offset:0,total:1}),/ANNUAL_INVALID/);assert.equal(f.writes.length,before);
});
test('corpus permissions, protected terms and quality examples affect only new AI suggestions',async()=>{
 const f=fixture();await write(f,'corpus-save',{id:randomUUID(),organizationId:f.department,kind:'term',term:'AFC'});await write(f,'corpus-save',{id:randomUUID(),organizationId:f.department,kind:'example',content:'完成AFC排查',qualityStandard:'提交问题清单'});
 await assert.rejects(f.service['corpus-list']({organizationId:f.department},f.role(['read','fill'])),/ACCESS_DENIED/);
 let payload;const service=createReformService({invoke:(name,input)=>{if(name==='platform.ai.complete')payload=input;return f.gateway.invoke(name,input);}}).service;
 const writes=f.writes.length;const result=await service['plan-suggest']({organizationId:f.department,month:'2026-10',rawText:'本月底完成AFC设备排查'},f.employee);assert.ok(result.content.includes('AFC'));assert.match(payload.prompt,/提交问题清单/);assert.match(payload.prompt,/protectedTerms/);assert.equal(f.writes.length,writes);
 const {sources,retrieval,responsible,...modelResult}=result;f.setAi({...modelResult,content:'完成自动售检票设备排查'});await assert.rejects(service['plan-suggest']({organizationId:f.department,month:'2026-10',rawText:'完成AFC排查'},f.employee),/TERM_CHANGED/);
});
test('settings mask webhook, validate destination, and do not expose it in events',async()=>{
 const f=fixture(),url='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret';await write(f,'settings-save',{organizationId:f.department,expectedVersion:0,webhookUrl:url,enabled:true,advanceDays:3,sendHour:9,overdueEveryDays:1});const result=await f.service['settings-get']({organizationId:f.department},f.employee);assert.ok(result.webhookConfigured);assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify([...f.tables.get('work_events').values()]).includes('secret'));assert.throws(()=>parseWebhook('https://example.org/hook'),/INVALID_WEBHOOK/);
 await assert.rejects(f.service['settings-get']({organizationId:f.department},f.role(['read'])),/ACCESS_DENIED/);
});
test('reminders send with no employee session, deduplicate across scans and stop on completion',async()=>{
 const f=fixture(),row=await f.create('supervision',{endDate:'2026-10-29'});await write(f,'settings-save',{organizationId:f.department,expectedVersion:0,webhookUrl:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',enabled:true,advanceDays:3,sendHour:9,overdueEveryDays:1});
 await Promise.all([f.scanReminders(),f.scanReminders()]);await f.scanReminders();assert.equal(f.sent.length,1);assert.match(f.sent[0].message,/李四|张三/);
 f.setClock('2026-10-29T01:05:00Z');await f.scanReminders();assert.equal(f.sent.length,2);await write(f,'record-progress',{id:row.id,expectedVersion:1,summary:'',complete:true});f.setClock('2026-10-30T01:05:00Z');await f.scanReminders();assert.equal(f.sent.length,2);
});
test('unknown external delivery is not replayed on the next scan or process restart',async()=>{
 const f=fixture();await f.create('supervision',{endDate:'2026-10-29'});await write(f,'settings-save',{organizationId:f.department,expectedVersion:0,webhookUrl:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',enabled:true,advanceDays:3,sendHour:9,overdueEveryDays:1});let calls=0;
 const create=()=>createReformService({invoke:(name,input)=>{if(name==='platform.webhook.send'){calls++;throw Object.assign(Error('lost'),{writeOutcome:'unknown'});}return f.gateway.invoke(name,input);}},{clock:()=>new Date('2026-10-26T01:05:00Z')});await create().scanReminders();await create().scanReminders();assert.equal(calls,1);assert.equal([...f.tables.get('reminder_deliveries').values()][0].status,'unknown');
});
test('attachment upload and export independently require the current source permissions',async()=>{
 const f=fixture(),row=await f.create(),request=action=>({action,entityType:'work_record',entityId:row.id,requestId:randomUUID()});await assert.rejects(f.service['authorize-attachment'](request('upload'),f.employee),/ACCESS_DENIED/);await review(f,row);assert.equal((await f.service['authorize-attachment'](request('upload'),f.employee)).organizationId,f.department);
 await assert.rejects(f.service['authorize-attachment'](request('export'),f.role(['read','complete'])),/ACCESS_DENIED/);assert.equal((await f.service['authorize-attachment'](request('export'),f.employee)).organizationId,f.department);
 const raw=createReformHandlers(f.gateway).handlers['authorize-attachment'];assert.deepEqual(await raw(request('read'),{employee:f.employee}),{organizationId:f.department});
});
test('list filtering and cursor pagination operate on the complete dataset',async()=>{
 const f=fixture();for(let i=0;i<24;i++)await f.create('supervision',{content:`任务${i}`,endDate:'2026-10-29'});const first=await f.service['record-list']({organizationId:f.department,kind:'supervision'},f.employee),second=await f.service['record-list']({organizationId:f.department,kind:'supervision',after:first.nextCursor},f.employee);assert.equal(first.rows.length,8);assert.equal(second.rows.length,8);assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,16);assert.equal((await f.service['record-list']({organizationId:f.department,kind:'supervision',search:'任务23'},f.employee)).rows.length,1);
});
test('unknown application writes remain unknown and are never automatically replayed',async()=>{
 const f=fixture();let calls=0;const {handlers}=createReformHandlers({invoke:(name,input)=>{if(name==='platform.app_data.transaction'){calls++;throw Object.assign(Error('lost'),{writeOutcome:'unknown'});}return f.gateway.invoke(name,input);}});const result=await handlers['record-save']({id:randomUUID(),requestId:randomUUID(),organizationId:f.department,kind:'monthly',draft:f.draft(),submit:true},{employee:f.employee});assert.equal(result.error.writeOutcome,'unknown');assert.equal(calls,1);
});

test('concurrent identical terms have one winner and removed terms can be added again',async()=>{
 const f=fixture(),create=()=>write(f,'corpus-save',{id:randomUUID(),organizationId:f.department,kind:'term',term:'AFC'});const outcomes=await Promise.allSettled([create(),create()]);assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);const row=[...f.tables.get('corpus_terms').values()][0];await write(f,'corpus-save',{id:row.id,organizationId:f.department,kind:'term',expectedVersion:row.version,remove:true});await create();assert.equal([...f.tables.get('corpus_terms').values()].filter(row=>!row.deleted).length,1);
});
test('workgroup roles can fill, read and complete their own task without acquiring department-wide access',async()=>{
 const f=fixture(),employee=f.role(['read','fill','complete']);employee.businessAuthorization.grants=employee.businessAuthorization.grants.map(g=>({...g,organizationIds:[f.team]}));const row=await f.create('monthly',{},employee);await review(f,row);f.attachments.set(row.id,[{attachmentId:randomUUID()}]);await write(f,'record-progress',{id:row.id,expectedVersion:2,summary:'',complete:true},employee);assert.equal(f.tables.get('work_records').get(row.id).status,'completed');await f.create('monthly',{responsible:{personId:f.colleague,organizationUnitId:f.otherTeam}},f.employee);assert.equal((await f.service['record-list']({organizationId:f.department,kind:'monthly'},employee)).rows.length,1);
});
test('large annual imports store bounded progress instead of growing a row-id list',async()=>{
 const f=fixture(),id=randomUUID();f.tables.get('annual_imports').set(id,{id,organization_id:f.department,created_by:f.person,version:166,total:500,imported:497,status:'in_progress'});await write(f,'annual-import',{id,organizationId:f.department,rows:[f.draft('annual'),f.draft('annual'),f.draft('annual')],offset:497,total:500});const batch=f.tables.get('annual_imports').get(id);assert.equal(batch.imported,500);assert.equal(batch.status,'completed');assert.ok(!('row_ids' in batch));
});
test('personal reads include cross-department assignments but cannot select an unrelated creation department',async()=>{
 const f=fixture(),row=await f.create('annual');f.tables.get('work_records').get(row.id).organization_id=f.otherDepartment;const self=f.role(['annual_read'],{self:true});assert.equal((await f.service['record-get']({id:row.id},self)).record.id,row.id);assert.equal((await f.service['record-list']({organizationId:f.department,kind:'annual'},self)).rows.length,1);await assert.rejects(f.service['record-list']({organizationId:f.otherDepartment,kind:'annual'},self),/ACCESS_DENIED/);
});

test('short numbers are stable on edit, never reused after deletion, and allocated with annual batches',async()=>{
 const f=fixture(),first=await f.create('annual');assert.equal(first.number,'年001');
 await write(f,'record-save',{id:first.id,organizationId:f.department,kind:'annual',expectedVersion:1,draft:f.draft('annual',{content:'更新年度计划'})});assert.equal(f.tables.get('work_records').get(first.id).number,'年001');
 await write(f,'record-delete',{id:first.id,expectedVersion:2});
 const next=await f.create('annual');assert.equal(next.number,'年002');
 await write(f,'annual-import',{id:randomUUID(),organizationId:f.department,rows:[f.draft('annual'),f.draft('annual')],offset:0,total:2});
 assert.deepEqual([...f.tables.get('work_records').values()].map(row=>row.number),['年001','年002','年003','年004']);
 assert.equal((await f.create('monthly')).number,'月001');assert.equal((await f.create('supervision')).number,'督001');
 const before=structuredClone([...f.tables.get('number_counters').values()]);
 await assert.rejects(write(f,'annual-import',{id:randomUUID(),organizationId:f.department,rows:[f.draft('annual'),f.draft('annual',{endMonth:0})],offset:0,total:2}),/ANNUAL_INVALID/);
 assert.deepEqual([...f.tables.get('number_counters').values()],before);
});
test('concurrent number reservation rolls back the losing record without consuming a number',async()=>{
 const f=fixture(),results=await Promise.allSettled([f.create('annual'),f.create('annual')]);
 assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
 assert.match(results.find(row=>row.status==='rejected').reason.message,/CONFLICT/);
 assert.equal(f.tables.get('work_records').size,1);assert.equal(f.tables.get('work_events').size,1);
 assert.equal((await f.create('annual')).number,'年002');
});
test('term explanations can be created and edited, validate length and reach the AI prompt as data',async()=>{
 const f=fixture(),result=await write(f,'corpus-save',{id:randomUUID(),organizationId:f.department,kind:'term',term:'AFC',explanation:'自动售检票系统'});
 let row=f.tables.get('corpus_terms').get(result.id);assert.equal(row.explanation,'自动售检票系统');
 await write(f,'corpus-save',{id:row.id,organizationId:f.department,kind:'term',expectedVersion:row.version,term:'AFC',explanation:'包含闸机与售票设备的自动售检票系统'});
 row=f.tables.get('corpus_terms').get(result.id);assert.equal(row.version,2);
 await assert.rejects(write(f,'corpus-save',{id:row.id,organizationId:f.department,kind:'term',expectedVersion:2,term:'AFC改名',explanation:'说明'}),/KNOWLEDGE_CONFLICT/);
 await assert.rejects(write(f,'corpus-save',{id:row.id,organizationId:f.department,kind:'term',expectedVersion:1,term:'AFC',explanation:'旧版本覆盖'}),/KNOWLEDGE_CONFLICT/);
 await assert.rejects(write(f,'corpus-save',{id:randomUUID(),organizationId:f.department,kind:'term',term:'新名词',explanation:'x'.repeat(501)}),/INVALID_INPUT/);
 assert.equal((await f.service['corpus-list']({organizationId:f.department},f.employee)).terms[0].explanation,row.explanation);
 let prompt;const service=createReformService({invoke:(name,input)=>{if(name==='platform.ai.complete')prompt=JSON.parse(input.prompt);return f.gateway.invoke(name,input);}}).service;
 await service['plan-suggest']({organizationId:f.department,month:'2026-10',rawText:'完成AFC设备检查'},f.employee);
 assert.deepEqual(prompt.termExplanations,[{term:'AFC',explanation:row.explanation}]);assert.deepEqual(prompt.protectedTerms,['AFC']);
 await write(f,'corpus-save',{id:row.id,organizationId:f.department,kind:'term',expectedVersion:row.version,remove:true});
 await write(f,'corpus-save',{id:randomUUID(),organizationId:f.department,kind:'term',term:'AFC',explanation:'重新维护的解释'});
 assert.equal((await f.service['corpus-list']({organizationId:f.department},f.employee)).terms[0].explanation,'重新维护的解释');
});

test('shared plan suggestion resolves trusted department and returns a draft without writes',async()=>{
 const f=fixture(),suggest=f.service['plan-suggest'],input={month:'2027-01',rawText:'完成AFC设备排查'};
 const before=f.writes.length;
 const draft=await suggest(input,f.employee);
 assert.match(draft.content,/AFC/);assert.equal(f.writes.length,before);
 await assert.rejects(suggest({rawText:input.rawText},f.employee),/INVALID_INPUT/);
 await assert.rejects(suggest(input,f.role(['read'])),/ACCESS_DENIED/);
 await assert.rejects(suggest({...input,organizationId:f.otherDepartment},f.employee),/ACCESS_DENIED/);
});

test('session reuses verified ancestor paths only within one request and preserves nearest departments',async()=>{
 const f=fixture(),invoke=f.gateway.invoke.bind(f.gateway),calls=[];
 f.gateway.invoke=async(name,input,signal)=>{calls.push({name,id:input.organizationUnitId});return invoke(name,input,signal);};
 const e=structuredClone(f.employee);e.businessAuthorization.organizations=[{id:f.team,name:'一班'},{id:f.department,name:'维保部'},{id:f.otherTeam,name:'二班'},{id:f.department,name:'维保部'}];
 const result=await f.service.session({},e);
 assert.equal(calls.filter(c=>c.name==='platform.people.organization_context').length,2);
 assert.equal(calls.filter(c=>c.name==='platform.people.workgroups').length,1);
 assert.equal(new Set(result.workgroups.map(w=>w.id)).size,result.workgroups.length);
 assert.ok(result.workgroups.every(w=>w.departmentId===f.department));
 await f.service.session({},e);assert.equal(calls.filter(c=>c.name==='platform.people.organization_context').length,4,'no cross-request cache');
 const nested=randomUUID();
 f.gateway.invoke=async(name,input,signal)=>name==='platform.people.organization_context'&&input.organizationUnitId===f.otherTeam?{organizations:[{id:f.otherTeam,name:'二班',unitType:'workgroup'},{id:nested,name:'子部门',unitType:'department'},{id:f.department,name:'上级部门',unitType:'department'}]}:invoke(name,input,signal);
 const nestedResult=await f.service.session({},f.employee);
 assert.equal(nestedResult.workgroups.find(w=>w.id===f.otherTeam).departmentId,nested);
});

test('session exposes safe failure codes and diagnostic reference, without leaking provider text or retrying writes',async()=>{
 const f=fixture();
 for(const code of ['RATE_LIMITED','TIMEOUT','AUDIT_FAILED','ACCESS_DENIED']){
  const logs=[];const {handlers}=createReformHandlers({invoke:async()=>{throw Object.assign(Error('private details'),{code});}});
  const requestId=randomUUID(),result=await handlers.session({},{employee:{...f.employee,requestId},log:line=>logs.push(JSON.parse(line))});
  assert.equal(result.error.code,code);assert.equal(result.error.requestId,requestId);assert.equal(result.error.writeOutcome,'not_started');
  assert.ok(!JSON.stringify({result,logs}).includes('private details'));
 }
 const {handlers}=createReformHandlers({invoke:async()=>{throw TypeError('private internals');}});
 assert.equal((await handlers.session({},{employee:f.employee})).error.code,'READ_FAILED');
});

test('app response errors preserve safe diagnostic fields and uncertain write outcomes',async()=>{
 const {appResponseError}=await import('./src/request-error.mjs');
 const requestId=randomUUID(),error=appResponseError({error:{code:'RATE_LIMITED',writeOutcome:'not_started',requestId}});
 assert.equal(error.code,'RATE_LIMITED');assert.equal(error.requestId,requestId);assert.equal(error.definitive,true);
 const write=appResponseError({error:{code:'OPERATION_UNCONFIRMED',writeOutcome:'unknown'}},{write:true});assert.equal(write.definitive,false);
 assert.equal(appResponseError({error:{code:'READ_FAILED',requestId:'invalid'}}).requestId,undefined);
});

test('approved deletion is role-scoped, rejects stale versions and retains audit history',async()=>{
 const f=fixture(),row=await f.create();
 await assert.rejects(write(f,'record-delete',{id:row.id,expectedVersion:1}),/ACCESS_DENIED/);
 await review(f,row);
 await assert.rejects(write(f,'record-delete',{id:row.id,expectedVersion:2},f.role(['read','review'])),/ACCESS_DENIED/);
 await assert.rejects(write(f,'record-delete',{id:row.id,expectedVersion:2},f.role(['read','approved_delete'],{foreign:true})),/ACCESS_DENIED/);
 await assert.rejects(write(f,'record-delete',{id:row.id,expectedVersion:1}),/CONFLICT/);
 await write(f,'record-delete',{id:row.id,expectedVersion:2},f.role(['read','approved_delete'],{self:true}));
 assert.equal(f.tables.get('work_records').get(row.id).deleted,true);
 assert.ok([...f.tables.get('work_events').values()].some(e=>e.record_id===row.id&&e.action==='deleted'&&e.details.content===row.content));
 await assert.rejects(f.service['record-get']({id:row.id},f.employee),/NOT_FOUND/);
});

test('assignees include department employees, search by number and revalidate scope on save',async()=>{
 const f=fixture(),office={id:randomUUID(),name:'办公室员工',employeeNo:'OFFICE',organizationUnitId:f.department};f.people.push(office);
 const page=await f.service.members({kind:'supervision',search:'OFFICE'},f.employee);assert.deepEqual(page.rows,[office]);
 await f.create('supervision',{responsible:{personId:office.id,organizationUnitId:office.organizationUnitId}});
 const self=f.role(['fill','read'],{self:true});
 assert.deepEqual((await f.service.members({kind:'monthly'},self)).rows.map(p=>p.id),[f.person]);
 await assert.rejects(f.create('monthly',{responsible:{personId:office.id,organizationUnitId:office.organizationUnitId}},self),/PERSON_INVALID/);
 await assert.rejects(f.service.members({kind:'supervision'},f.role(['supervision_read'])),/ACCESS_DENIED/);
 await assert.rejects(f.create('supervision',{responsible:{personId:office.id,organizationUnitId:f.team}}),/PERSON_INVALID/);
});

test('meeting extraction returns multiple editable drafts without writes and rejects invalid model output',async()=>{
 const f=fixture(),items=[{content:'检查车站设备',qualityStandard:'提交检查记录',endDate:'2026-11-02',ownerName:'张三'},{content:'补充备件',qualityStandard:'',endDate:null,ownerName:''}];
 f.setAi(' \n```json\n'+JSON.stringify(items)+'\n``` \n');const before=f.writes.length;
 const result=await f.service['supervision-extract']({notes:'张三周一检查设备，另外要补充备件'},f.employee);
 assert.equal(result.items.length,2);assert.equal(result.items[1].endDate,'');assert.equal(f.writes.length,before);
 await assert.rejects(f.service['supervision-extract']({notes:'会议纪要'},f.role(['supervision_read'])),/ACCESS_DENIED/);
 await assert.rejects(f.service['supervision-extract']({notes:'字'.repeat(11501)},f.employee),/INVALID_INPUT/);
 f.setAi({items:[{...items[0],endDate:'2026-02-31'}]});await assert.rejects(f.service['supervision-extract']({notes:'会议纪要'},f.employee),/AI_INVALID_RESULT/);
 f.setAi({items:[]});assert.deepEqual((await f.service['supervision-extract']({notes:'暂无督办'},f.employee)).items,[]);
});

test('meeting extraction exposes actionable platform model failures without leaking meeting text',async()=>{
 const f=fixture(),{handlers}=createReformHandlers(f.gateway);
 const employee={...f.employee,requestId:randomUUID()},notes='会议正文不写入诊断日志',logs=[];
 for(const [providerCode,code] of [['AI_NOT_CONFIGURED','AI_NOT_CONFIGURED'],['ACCESS_DENIED','AI_PERMISSION_DENIED'],['TIMEOUT','TIMEOUT'],['AI_UNAVAILABLE','AI_UNAVAILABLE']]){
  f.setAi(Object.assign(Error('private upstream details'),{code:providerCode}));
  const result=await handlers['supervision-extract']({notes},{employee,log:message=>logs.push(message)});
  assert.deepEqual(result,{ok:false,error:{code,writeOutcome:'not_started',requestId:employee.requestId}});
 }
 assert.equal(logs.length,4);
 assert.ok(logs.every(message=>!message.includes(notes)&&!message.includes('private upstream details')));
});

test('transcription requires supervision management independently of plan permissions',async()=>{
 const f=fixture();assert.deepEqual(await f.service['authorize-transcription']({},f.role(['supervision_manage'])),{allowed:true});
 await assert.rejects(f.service['authorize-transcription']({},f.role(['read','fill'])),/ACCESS_DENIED/);
});

test('cross-department supervision assignments remain visible and completable to the responsible person',async()=>{
 const f=fixture(),manager=f.role(['supervision_manage','supervision_read']);
 manager.businessAuthorization.grants.forEach(g=>g.all=true);
 const row=await f.create('supervision',{responsible:{personId:f.outside,organizationUnitId:f.foreignTeam}},manager);
 const owner=f.role(['supervision_read','supervision_complete'],{self:true,personId:f.outside,organizationUnitId:f.foreignTeam});
 const page=await f.service['record-list']({organizationId:f.otherDepartment,kind:'supervision'},owner);
 assert.deepEqual(page.rows.map(r=>r.id),[row.id]);
 await write(f,'record-progress',{id:row.id,expectedVersion:1,summary:'',complete:true},owner);
 const unrelated=f.role(['supervision_read'],{self:true});
 assert.equal((await f.service['record-list']({organizationId:f.department,kind:'supervision'},unrelated)).rows.length,0);
 await assert.rejects(f.service['record-get']({id:row.id},unrelated),/ACCESS_DENIED/);
});

test('monthly suggestions default omitted dates and assignee without clarification, preserving explicit choices',async()=>{
 const f=fixture(),actor=f.role(['fill'],{self:true});
 f.setClock('2028-02-28T16:05:00Z');
 const base={content:'开展风险再排查工作',qualityStandard:'形成隐患排查台账',startDate:null,endDate:null,responsibleName:null,missingInfo:[]};
 f.setAi(base);
 const request={organizationId:f.department,month:'2028-02',rawText:'开展风险再排查工作'};
 const result=await f.service['plan-suggest'](request,actor);
 assert.equal(result.startDate,'2028-02-29');assert.equal(result.endDate,'2028-02-29');
 assert.deepEqual(result.responsible,{personId:f.person,organizationUnitId:f.team,name:'张三'});
 assert.deepEqual(result.missingInfo,[]);assert.equal(f.writes.length,0);
 assert.deepEqual((await f.service.session({},actor)).self,result.responsible);
 f.setAi({...base,startDate:'2028-03-01',endDate:'2028-03-15',responsibleName:'李四'});
 const named=await f.service['plan-suggest']({...request,rawText:'李四3月1日至15日开展风险再排查工作'},f.employee);
 assert.equal(named.startDate,'2028-03-01');assert.equal(named.endDate,'2028-03-15');assert.equal(named.responsible.personId,f.colleague);
 // A named person outside this actor's grant must never become self silently.
 assert.equal((await f.service['plan-suggest']({...request,rawText:'李四3月1日至15日开展风险再排查工作'},actor)).responsible,null);
 f.people.push({...f.people[1],id:randomUUID()});
 assert.equal((await f.service['plan-suggest']({...request,rawText:'李四开展风险再排查工作'},f.employee)).responsible,null);
 f.setAi({...base,responsibleName:'模型编造姓名'});
 await assert.rejects(f.service['plan-suggest'](request,actor),/AI_INVALID_RESULT/);
 f.setAi({...base,startDate:'2028-02-10'});
 assert.equal((await f.service['plan-suggest'](request,actor)).endDate,'2028-02-29');
 f.setAi({...base,endDate:'2028-03-10'});
 assert.equal((await f.service['plan-suggest'](request,actor)).startDate,'2028-02-29');
});

test('plan prompts are defaulted per department and only corpus maintainers can read, save or test them',async()=>{
 const f=fixture(),input={organizationId:f.department},manager=f.role(['corpus']);
 const config=await f.service['plan-prompt-get'](input,manager);
 assert.deepEqual(config,{prompt:DEFAULT_PLAN_PROMPT,defaultPrompt:DEFAULT_PLAN_PROMPT,version:0});
 const draft={...input,prompt:'结合语料补全工作对象与成果要求。',month:'2026-11',rawText:'开展风险辨识工作'};
 for(const actor of [f.role(['fill'],{self:true}),f.role(['settings']),f.role(['corpus'],{foreign:true})]){
  await assert.rejects(f.service['plan-prompt-get'](input,actor),/ACCESS_DENIED/);
  await assert.rejects(write(f,'plan-prompt-save',{...input,prompt:draft.prompt,expectedVersion:0},actor),/ACCESS_DENIED/);
  await assert.rejects(f.service['plan-prompt-test'](draft,actor),/ACCESS_DENIED/);
 }
 const saved=await write(f,'plan-prompt-save',{...input,prompt:` ${draft.prompt} `,expectedVersion:0},manager);
 assert.deepEqual(saved,{prompt:draft.prompt,version:1});
 const stored=f.tables.get('plan_prompt_settings').get(f.department);assert.equal(stored.updated_by,manager.personId);
 assert.equal((await f.service['plan-prompt-get'](input,manager)).prompt,draft.prompt);
 const foreign=await f.service['plan-prompt-get']({organizationId:f.otherDepartment},f.role(['corpus'],{foreign:true}));
 assert.equal(foreign.prompt,DEFAULT_PLAN_PROMPT);assert.equal(foreign.version,0);
});

test('saved prompts reach explicit and trusted-default department calls, without changing other departments',async()=>{
 const f=fixture(),requests=[],invoke=f.gateway.invoke.bind(f.gateway);
 f.gateway.invoke=async(name,input,signal)=>{if(name==='platform.ai.complete')requests.push(input);return invoke(name,input,signal);};
 const prompt='借鉴相关示例的句式，补全工作对象、动作和成果要求。';
 await write(f,'plan-prompt-save',{organizationId:f.department,prompt,expectedVersion:0});
 const before=f.writes.length;
 await f.service['plan-suggest']({organizationId:f.department,month:'2026-11',rawText:'开展风险辨识工作'},f.role(['fill'],{self:true}));
 await f.service['plan-suggest']({month:'2026-11',rawText:'开展风险辨识工作'},f.role(['fill'],{self:true}));
 assert.equal(requests.length,2);for(const request of requests)assert.equal(request.system,planSystemPrompt(prompt));
 const outsider=f.role(['fill'],{foreign:true,personId:f.outside,organizationUnitId:f.foreignTeam});
 await f.service['plan-suggest']({organizationId:f.otherDepartment,month:'2026-11',rawText:'开展设备检查'},outsider);
 assert.equal(requests.at(-1).system,planSystemPrompt(DEFAULT_PLAN_PROMPT));assert.equal(f.writes.length,before);
});

test('prompt preview uses unsaved instructions and retrieved examples without changing configuration or records',async()=>{
 const f=fixture(),manager=f.role(['corpus']),org={organizationId:f.department};
 await write(f,'corpus-save',{...org,id:randomUUID(),kind:'example',content:'根据设备系统或重要部件、重要作业环节等持续开展风险再辨识工作，并结合已知风险进行隐患排查。',qualityStandard:'形成隐患排查台账。'});
 await write(f,'plan-prompt-save',{...org,prompt:'已保存的规则',expectedVersion:0},manager);
 let request;const invoke=f.gateway.invoke.bind(f.gateway);
 f.gateway.invoke=async(name,input,signal)=>{if(name==='platform.ai.complete')request=input;return invoke(name,input,signal);};
 const before=f.writes.length,snapshot=structuredClone(f.tables.get('plan_prompt_settings'));
 const content='围绕设备系统、重要部件及重要作业环节开展风险辨识，梳理风险点并整理辨识结果。';
 f.setAi({content,qualityStandard:'形成风险辨识清单。',startDate:null,endDate:null,responsibleName:null,missingInfo:[]});
 const result=await f.service['plan-prompt-test']({...org,prompt:'当前未保存的测试规则',month:'2026-11',rawText:'开展风险辨识工作'},manager);
 assert.equal(request.system,planSystemPrompt('当前未保存的测试规则'));
 const context=JSON.parse(request.prompt);assert.equal(context.examples.length,1);assert.equal(context.examples[0].qualityStandard,'形成隐患排查台账。');
 assert.equal(result.content,content);assert.equal(result.sources.length,1);assert.equal(f.writes.length,before);
 assert.deepEqual(f.tables.get('plan_prompt_settings'),snapshot);assert.equal(f.tables.get('work_records').size,0);
 f.gateway.invoke=async(name,input,signal)=>{if(name==='platform.ai.complete')throw Error('provider failure');return invoke(name,input,signal);};
 await assert.rejects(f.service['plan-prompt-test']({...org,prompt:'测试规则',month:'2026-11',rawText:'开展风险辨识工作'},manager),/AI_UNAVAILABLE/);
 assert.deepEqual(f.tables.get('plan_prompt_settings'),snapshot);assert.equal(f.writes.length,before);
});

test('prompt saves reject stale or concurrent updates and never duplicate a retried write',async()=>{
 const f=fixture(),input={organizationId:f.department,prompt:'首版提示词',expectedVersion:0,requestId:randomUUID()};
 await f.service['plan-prompt-save'](input,f.employee);
 await assert.rejects(f.service['plan-prompt-save'](input,f.employee),/CONFLICT/);
 assert.equal(f.writes.length,1);
 const outcomes=await Promise.allSettled(['第二版甲','第二版乙'].map(prompt=>write(f,'plan-prompt-save',{organizationId:f.department,prompt,expectedVersion:1})));
 assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);assert.match(outcomes.find(item=>item.status==='rejected').reason.message,/CONFLICT/);
 assert.equal(f.tables.get('plan_prompt_settings').get(f.department).version,2);assert.equal(f.writes.length,2);
});

test('prompt limits fit the AI gateway contract and invalid preview/save inputs never invoke the model',async()=>{
 const f=fixture(),org={organizationId:f.department};let calls=0;const invoke=f.gateway.invoke.bind(f.gateway);
 f.gateway.invoke=async(name,input,signal)=>{if(name==='platform.ai.complete'){calls++;assert.ok(input.system.length<=3000);}return invoke(name,input,signal);};
 assert.ok(planSystemPrompt('字'.repeat(PLAN_PROMPT_MAX_LENGTH)).length<=3000);
 for(const prompt of ['', '  ', '字'.repeat(PLAN_PROMPT_MAX_LENGTH+1),'非法\u0000内容']){
  await assert.rejects(write(f,'plan-prompt-save',{...org,prompt,expectedVersion:0}),/INVALID_INPUT/);
  await assert.rejects(f.service['plan-prompt-test']({...org,prompt,month:'2026-11',rawText:'开展风险辨识工作'},f.employee),/INVALID_INPUT/);
 }
 for(const expectedVersion of [undefined,-1,1.5,'0'])await assert.rejects(write(f,'plan-prompt-save',{...org,prompt:'有效提示词',expectedVersion}),/INVALID_INPUT/);
 await assert.rejects(f.service['plan-prompt-test']({...org,prompt:'有效提示词',month:'2026-13',rawText:'测试计划'},f.employee),/INVALID_INPUT/);
 await assert.rejects(f.service['plan-prompt-test']({...org,prompt:'有效提示词',month:'2026-11',rawText:'测试计划',requestId:randomUUID()},f.employee),/INVALID_INPUT/);
 assert.equal(calls,0);assert.equal(f.writes.length,0);
 await write(f,'plan-prompt-save',{...org,prompt:'字'.repeat(PLAN_PROMPT_MAX_LENGTH),expectedVersion:0});
 await f.service['plan-suggest']({...org,month:'2026-11',rawText:'测试计划'},f.employee);assert.equal(calls,1);
});

test('summaries use only the selected readable monthly records and their real status',async()=>{
 const f=fixture(),first=await f.create(),second=await f.create('monthly',{content:'排查站台设备'});
 const unselected=await f.create('monthly',{content:'未选计划'}),annual=await f.create('annual');
 const foreign=await f.create('monthly',{content:'他人不可见计划',responsible:{personId:f.colleague,organizationUnitId:f.otherTeam}},
  f.role(['fill','read'],{self:true,personId:f.colleague,organizationUnitId:f.otherTeam}));
 await review(f,first);
 const actor=f.role(['read'],{self:true}),input={organizationId:f.department,ids:[second.id,first.id,second.id]};
 await write(f,'plan-prompt-save',{organizationId:f.department,kind:'summary',prompt:'按工作主题汇报。',expectedVersion:0});
 f.setAi('  工作主题汇总\n已进入执行阶段  ');
 const writes=f.writes.length;
 const result=await f.service['plan-summary'](input,actor);
 assert.deepEqual(result,{summary:'工作主题汇总\n已进入执行阶段'});
 const [{system,prompt}]=f.aiRequests;
 assert.match(system,/按工作主题汇报/);
 const plans=JSON.parse(prompt).plans;
 assert.deepEqual(plans.map(row=>[row.编号,row.状态]),[[second.number,'待审核'],[first.number,'执行中']]);
 assert.ok(!prompt.includes(unselected.content)&&!prompt.includes(foreign.content)&&!prompt.includes('original_text'));
 for(const id of [annual.id,foreign.id,randomUUID()])await assert.rejects(f.service['plan-summary']({...input,ids:[first.id,id]},actor),/ACCESS_DENIED/);
 await assert.rejects(f.service['plan-summary'](input,f.role(['attachment_export'])),/ACCESS_DENIED/);
 assert.equal(f.aiRequests.length,1);assert.equal(f.writes.length,writes);
});

test('summary prompts preserve the saved organize rule and test unsaved text without writing',async()=>{
 const f=fixture(),org={organizationId:f.department},summary={...org,kind:'summary'};
 assert.equal((await f.service['plan-prompt-get'](summary,f.employee)).prompt,DEFAULT_SUMMARY_PROMPT);
 await write(f,'plan-prompt-save',{...org,prompt:'原整理规则',expectedVersion:0});
 await write(f,'plan-prompt-save',{...summary,prompt:'按状态写总结',expectedVersion:0});
 assert.equal((await f.service['plan-prompt-get'](org,f.employee)).prompt,'原整理规则');
 assert.equal((await f.service['plan-prompt-get'](summary,f.employee)).prompt,'按状态写总结');
 await assert.rejects(f.service['plan-prompt-get'](summary,f.role(['settings'])),/ACCESS_DENIED/);
 f.setAi('测试总结');
 const writes=f.writes.length;
 assert.deepEqual(await f.service['plan-prompt-test']({...summary,prompt:'未保存的写法',month:'2026-10',rawText:'站台设备巡检已完成'},f.employee),{summary:'测试总结'});
 assert.match(f.aiRequests[0].system,/未保存的写法/);
 assert.equal(f.writes.length,writes);
 const ids=[];
 for(let index=0;index<12;index++)ids.push((await f.create('monthly',{content:'字'.repeat(500),qualityStandard:'验'.repeat(500)})).id);
 await assert.rejects(f.service['plan-summary']({...org,ids},f.employee),/SUMMARY_INPUT_LIMIT/);
 assert.equal(f.aiRequests.length,1);
});
