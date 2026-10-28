import {AsyncLocalStorage} from 'node:async_hooks';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {createReformService,createReformHandlers} from './src/reform-service.mjs';
import {annualMonths,relevantAnnual,reminderDue,parseWebhook,day} from './src/reform-rules.mjs';

const migrations=await Promise.all((await readdir(new URL('./migrations/',import.meta.url))).filter(name=>name.endsWith('.json')).sort().map(async name=>JSON.parse(await readFile(new URL('./migrations/'+name,import.meta.url),'utf8'))));
const schema={operations:migrations.flatMap(value=>value.operations)};
export function fixture(){
 const department=randomUUID(),otherDepartment=randomUUID(),team=randomUUID(),otherTeam=randomUUID(),foreignTeam=randomUUID(),person=randomUUID(),colleague=randomUUID(),outside=randomUUID();
 const tables=new Map(schema.operations.filter(op=>op.kind==='createTable').map(op=>[op.table,new Map()])),people=[{id:person,name:'张三',employeeNo:'001',organizationUnitId:team},{id:colleague,name:'李四',employeeNo:'002',organizationUnitId:otherTeam},{id:outside,name:'外部门',employeeNo:'003',organizationUnitId:foreignTeam}];
 const orgs=new Map([[team,department],[otherTeam,department],[foreignTeam,otherDepartment]]),writes=[],sent=[],attachments=new Map(),recorded=new Map();let instant=new Date('2026-10-26T01:05:00Z'),aiResult={content:'完成AFC设备排查',qualityStandard:'提交排查清单',startDate:'2026-10-01',endDate:'2026-10-31',missingInfo:[]};
 const clone=value=>structuredClone(value);
 const hostEmployee=new AsyncLocalStorage();
 const gateway={async invoke(operation,payload){
  if(operation==='platform.tools.call')return {ok:true,result:await result.service['tool-plan-reference'](payload.arguments,hostEmployee.getStore()??employee)};
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
  if(operation==='platform.people.members')return {organizationUnitId:payload.organizationUnitId,rows:people.filter(row=>row.organizationUnitId===payload.organizationUnitId&&(!payload.personIds||payload.personIds.includes(row.id))&&(!payload.search||row.name.includes(payload.search)||row.employeeNo.includes(payload.search)))};
  if(operation==='platform.attachments.list')return {attachments:clone(attachments.get(payload.entityId)??[]),nextCursor:null};
  if(operation==='platform.ai.complete')return {content:JSON.stringify(aiResult)};
  if(operation==='platform.webhook.send'){sent.push(payload);return {sent:true};}
  if(operation==='platform.app_data.get')return {row:clone(tables.get(payload.table)?.get(payload.id)??null)};
  if(operation==='platform.app_data.list'){
   let rows=[...tables.get(payload.table).values()].filter(row=>(payload.filters??[]).every(filter=>row[filter.column]===filter.value)&&(!payload.anyOf||payload.anyOf.some(group=>group.every(filter=>row[filter.column]===filter.value)))&&(!payload.search||String(row[payload.search.column]).toLowerCase().includes(payload.search.text.toLowerCase())));
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
 const names=['read','fill','review','complete','extend','extension_review','export','attachment_export','supervision_read','supervision_manage','supervision_delete','supervision_complete','annual_read','annual_manage','annual_complete','corpus','settings'];
 const employee={personId:person,organizationUnitId:team,businessAuthorization:{revision:randomUUID(),organizations:[{id:team,name:'一班'},{id:otherTeam,name:'二班'}],grants:names.map(name=>({permission:`app.huicetong.${name}`,all:false,self:false,organizationIds:[department,team,otherTeam]}))}};
 const role=(names,options={})=>({...employee,...options,businessAuthorization:{...employee.businessAuthorization,grants:employee.businessAuthorization.grants.filter(g=>names.includes(g.permission.split('.').at(-1))).map(g=>({...g,...(options.self?{self:true,organizationIds:[]}:{}),...(options.foreign?{organizationIds:[otherDepartment,foreignTeam]}:{})}))}});
 const result=createReformService(gateway,{clock:()=>instant});
 result.service=Object.fromEntries(Object.entries(result.service).map(([name,run])=>[name,(input,e,signal)=>hostEmployee.run(e,()=>run(input,e,signal))]));
 const draft=(kind='monthly',extra={})=>({content:'AFC设备排查',qualityStandard:kind==='annual'?'':'提交排查清单',responsible:{personId:person,organizationUnitId:team},month:'2026-10',startDate:'2026-10-01',endDate:'2026-10-31',year:2026,startMonth:2,endMonth:5,...extra});
 const create=async(kind='monthly',extra={},actor=employee)=>{const id=randomUUID();await result.service['record-save']({id,requestId:randomUUID(),organizationId:department,kind,draft:draft(kind,extra),submit:kind==='monthly'},actor);return tables.get('work_records').get(id);};
 return {...result,department,otherDepartment,team,otherTeam,foreignTeam,person,colleague,outside,tables,people,writes,sent,attachments,gateway,employee,role,draft,create,setClock:value=>{instant=new Date(value);},setAi:value=>{aiResult=value;}};
}
const write=(f,name,payload,actor=f.employee)=>f.service[name]({...payload,requestId:randomUUID()},actor);
const review=(f,row,action='approve',comment='')=>write(f,'record-review',{id:row.id,expectedVersion:row.version,action,comment});

test('five pages and granular permissions replace the entire legacy workflow',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./app.json',import.meta.url),'utf8'));
 assert.deepEqual(manifest.pages.map(p=>p.title),['月度计划','督办提醒','年度计划','语料库','基础配置']);
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
 const {sources,retrieval,...modelResult}=result;f.setAi({...modelResult,content:'完成自动售检票设备排查'});await assert.rejects(service['plan-suggest']({organizationId:f.department,month:'2026-10',rawText:'完成AFC排查'},f.employee),/TERM_CHANGED/);
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
test('personal reads cannot cross departments just because a person id matches',async()=>{
 const f=fixture(),row=await f.create('annual');f.tables.get('work_records').get(row.id).organization_id=f.otherDepartment;const self=f.role(['annual_read'],{self:true});await assert.rejects(f.service['record-get']({id:row.id},self),/ACCESS_DENIED/);await assert.rejects(f.service['record-list']({organizationId:f.otherDepartment,kind:'annual'},self),/ACCESS_DENIED/);
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

test('unified plan agent asks for month then uses knowledge and returns a draft without writes',async()=>{
 const f=fixture(),agent=f.service['agent-plan'],first={message:'帮我整理AFC设备排查计划',history:[],today:'2026-12-27'};
 const question=await agent(first,f.employee);assert.equal(question.kind,'clarify');assert.match(question.text,/哪个月/);
 const before=f.writes.length;
 const draft=await agent({message:'下个月',history:[{role:'user',content:first.message},{role:'assistant',content:question.text}],today:first.today},f.employee);
 assert.match(draft.text,/2027-01/);assert.match(draft.text,/AFC/);assert.match(draft.text,/尚未提交/);assert.equal(f.writes.length,before);
 await assert.rejects(agent({...first,message:'2026-11 完成AFC排查'},f.role(['read'])),/ACCESS_DENIED/);
 await assert.rejects(agent({...first,organizationId:f.otherDepartment},f.employee),/INVALID_INPUT/);
});
