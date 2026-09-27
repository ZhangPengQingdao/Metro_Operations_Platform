import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHazardService,similarity} from './service.mjs';
import {qualityScore,validateRecord} from './policy.mjs';

const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const reporter='33333333-3333-4333-8333-333333333333',reviewer='44444444-4444-4444-8444-444444444444';
const uid=n=>'aaaaaaaa-aaaa-4aaa-8aaa-'+String(n).padStart(12,'0');
const grants=(person,organization=org)=>['read','create','update','review','photo'].map(name=>({permission:'app.hazards.'+name,all:false,self:false,organizationIds:[organization]}));
const employee=(person,organization=org)=>({personId:person,organizationUnitId:organization,businessAuthorization:{revision:uid(900),grants:grants(person,organization),organizations:[{id:organization,name:'测试工班'}]}});
const form=(organization=org)=>({organizationId:organization,inspectedAt:'2026-09-27T08:00:00.000Z',stationId:uid(901),location:'某站',line:'1号线',description:'站厅闸机紧急停止按钮防护盖破损',category:'设备运行维修',level:'一般隐患II级',temporaryControls:'围挡并安排值守',governanceMeasures:'更换防护盖并复查按钮功能',governanceDeadline:'2026-09-30T08:00:00.000Z',governanceDetails:'',responsiblePerson:'张三',responsiblePersonId:uid(902),beforePhotoId:null,afterPhotoId:null,status:'open',aiConfidence:null,aiBasis:''});
function fixture({maxCasePageSize=Infinity}={}){
 const tables=new Map(['records','cases','photos','photo_parts'].map(name=>[name,new Map()]));
 const gateway={async invoke(operation,params){
  if(operation==='platform.ai.complete')return {content:JSON.stringify({description:'站厅闸机紧急停止按钮防护盖破损',category:'设备运行维修',level:'一般隐患II级',measures:'更换防护盖并复查按钮功能',confidence:0.87,basis:'参考闭环案例',manualReview:false})};
  if(operation==='platform.locations.list')return {rows:[]};
  if(operation==='platform.locations.responsible_stations')return {lines:[{id:uid(903),name:'1号线'}],stations:params.lineName?[{id:uid(901),name:'某站',lineId:uid(903),lineName:'1号线'}].filter(row=>row.id===(params.stationId??row.id)&&params.organizationUnitId===org):[]};
  if(operation==='platform.people.members')return {rows:[{id:uid(902),name:'张三',employeeNo:'01',organizationUnitId:org}].filter(row=>params.organizationUnitId===org&&(!params.personId||params.personId===row.id))};
  if(operation==='platform.app_data.get')return {row:tables.get(params.table).get(params.id)??null};
  if(operation==='platform.app_data.list'){
   if(params.table==='cases'&&params.pageSize>maxCasePageSize)throw Object.assign(Error('STORAGE_RESULT_LIMIT'),{code:'STORAGE_RESULT_LIMIT'});
   let rows=[...tables.get(params.table).values()];
   const fieldMatch=(row,filter)=>filter.contains?filter.contains.some(group=>group.every(f=>Object.entries(f).every(([key,value])=>row[key]===value))):row[filter.column]===filter.value;
   rows=rows.filter(row=>(params.filters??[]).every(f=>fieldMatch(row,f))&&(!params.anyOf||params.anyOf.some(group=>group.every(f=>fieldMatch(row,f))))&&(!params.search||String(row[params.search.column]).includes(params.search.text)));
   if(params.order){const {column,direction}=params.order;rows.sort((a,b)=>String(a[column]).localeCompare(String(b[column]))*(direction==='desc'?-1:1)||a.id.localeCompare(b.id));}
   else rows.sort((a,b)=>a.id.localeCompare(b.id));
   if(params.afterId)rows=rows.filter(row=>row.id>params.afterId);
   if(params.after)rows=rows.filter(row=>params.order?.direction==='desc'?String(row[params.order.column])<params.after.value||String(row[params.order.column])===params.after.value&&row.id>params.after.id:String(row[params.order.column])>params.after.value||String(row[params.order.column])===params.after.value&&row.id>params.after.id);
   const page=rows.slice(0,params.pageSize??20),last=page.at(-1);
   return {rows:page,nextCursor:rows.length>page.length?params.order?{id:last.id,value:String(last[params.order.column])}:last.id:null};
  }
  if(operation==='platform.app_data.transaction'){
   for(const item of params.operations){const table=tables.get(item.table),old=table.get(item.id);if(item.action==='insert'&&old||item.action==='update'&&(!old||Object.entries(item.expected).some(([key,value])=>old[key]!==value)))throw Object.assign(Error('STORAGE_CONFLICT'),{code:'STORAGE_CONFLICT',writeOutcome:'not_started'});}
   for(const item of params.operations){const table=tables.get(item.table);if(item.action==='insert')table.set(item.id,{id:item.id,...item.values});else if(item.action==='update')table.set(item.id,{...table.get(item.id),...item.values});}
   return {ok:true};
  }
  throw Error('UNEXPECTED_OPERATION '+operation);
 }};
 return {tables,gateway,service:createHazardService(gateway,{clock:()=>new Date('2026-09-27T09:00:00.000Z')})};
}
test('field rules require review evidence and score closed cases',()=>{
 assert.throws(()=>validateRecord({...form(),status:'pending_review'}),/CLOSURE_EVIDENCE_REQUIRED/);
 const input={...form(),status:'pending_review',governanceDetails:'已完成更换和功能复查',afterPhotoId:uid(1)};
 assert.equal(validateRecord(input).status,'pending_review');
 assert.equal(qualityScore({...validateRecord(input),before_photo_id:uid(2)}),100);
 assert.ok(similarity('闸机防护盖破损','闸机紧急按钮防护盖破损')>similarity('闸机防护盖破损','站厅积水'));
});
test('catalog and writes keep stations and people within the selected workgroup',async()=>{
 const f=fixture(),a=employee(reporter),catalog=await f.service.catalog({organizationId:org,lineName:'1号线'},a);
 assert.equal(catalog.stations[0].name,'某站');assert.equal(catalog.people[0].name,'张三');
 await assert.rejects(f.service.create({requestId:uid(910),id:uid(911),record:{...form(),stationId:uid(912)}},a),/INVALID_STATION/);
 await assert.rejects(f.service.create({requestId:uid(913),id:uid(914),record:{...form(),responsiblePersonId:uid(915)}},a),/INVALID_PERSON/);
 await assert.rejects(f.service.catalog({organizationId:other},a),/ACCESS_DENIED/);
});
test('report, remedy and independent safety review atomically create a retrieval case',async()=>{
 const f=fixture(),a=employee(reporter),b=employee(reviewer),id=uid(10);
 await f.service.create({requestId:uid(11),id,record:form()},a);
 const first=await f.service.detail({id},a);
 assert.equal(first.status,'open');
 await assert.rejects(f.service.close({requestId:uid(12),id,revision:1},b),/NOT_READY_TO_CLOSE/);
 const image=Buffer.from([0xff,0xd8,0x12,0x34,0xff,0xd9]),photoId=uid(20);
 await f.service['photo-begin']({requestId:uid(21),id:photoId,organizationId:org,kind:'after',bytes:image.length,sha256:createHash('sha256').update(image).digest('hex'),parts:1},a);
 await f.service['photo-part']({requestId:uid(22),id:uid(23),photoId,index:0,data:image.toString('base64')},a);
 await f.service['photo-finish']({requestId:uid(24),photoId},a);
 const next={...form(),status:'pending_review',governanceDetails:'已完成更换和功能复查',afterPhotoId:photoId};
 await f.service.update({requestId:uid(25),id,revision:1,record:next},a);
 await assert.rejects(f.service.close({requestId:uid(26),id,revision:2},a),/SELF_REVIEW_DENIED/);
 const closed=await f.service.close({requestId:uid(27),id,revision:2},b);
 assert.equal(closed.retrievalEnabled,true);
 assert.equal(f.tables.get('cases').get(id).training_enabled,false);
 assert.equal((await f.service.detail({id},a)).status,'closed');
 assert.equal((await f.service.cases({search:'防护盖'},a)).rows.length,1);
 assert.equal((await f.service.cases({search:'站厅积水'},a)).rows.length,0);
 assert.equal((await f.service['photo-read']({recordId:id,photoId,index:0},a)).data,image.toString('base64'));
 await assert.rejects(f.service.update({requestId:uid(28),id,revision:3,record:next},a),/CONFLICT/);
 const suggestion=await f.service.suggest({organizationId:org,rawText:'站厅闸机紧急停止按钮防护盖破损'},a);
 assert.equal(suggestion.referenceCount,1);
 assert.equal(suggestion.manualReview,false);
});
test('business scope blocks foreign records and photographs; corrupt upload cannot be finalized',async()=>{
 const f=fixture(),a=employee(reporter),foreign=employee(reviewer,other),id=uid(30);
 await f.service.create({requestId:uid(31),id,record:form()},a);
 await assert.rejects(f.service.detail({id},foreign),/ACCESS_DENIED/);
 assert.equal((await f.service.list({organizationId:other},foreign)).rows.length,0);
 const photoId=uid(32),image=Buffer.from([0xff,0xd8,0x12,0x34,0xff,0xd9]);
 await f.service['photo-begin']({requestId:uid(33),id:photoId,organizationId:org,kind:'before',bytes:image.length,sha256:'0'.repeat(64),parts:1},a);
 await f.service['photo-part']({requestId:uid(34),id:uid(35),photoId,index:0,data:image.toString('base64')},a);
 await assert.rejects(f.service['photo-finish']({requestId:uid(36),photoId},a),/PHOTO_CORRUPT/);
 await assert.rejects(f.service['photo-read']({recordId:id,photoId,index:0},foreign),/ACCESS_DENIED/);
});
test('photo upload requires its own scoped grant and either create or update authority',async()=>{
 const f=fixture(),a=employee(reporter),image=Buffer.from([0xff,0xd8,0x12,0x34,0xff,0xd9]);
 const input={requestId:uid(80),id:uid(81),organizationId:org,kind:'before',bytes:image.length,sha256:createHash('sha256').update(image).digest('hex'),parts:1};
 a.businessAuthorization.grants=a.businessAuthorization.grants.filter(grant=>grant.permission!=='app.hazards.photo');
 await assert.rejects(f.service['photo-begin'](input,a),/ACCESS_DENIED/);
 a.businessAuthorization.grants=grants(reporter).filter(grant=>['app.hazards.read','app.hazards.update','app.hazards.photo'].includes(grant.permission));
 await f.service['photo-begin'](input,a);
 assert.equal(f.tables.get('photos').get(input.id).organization_id,org);
 a.businessAuthorization.grants=a.businessAuthorization.grants.map(grant=>grant.permission==='app.hazards.photo'?{...grant,organizationIds:[other]}:grant);
 await assert.rejects(f.service['photo-part']({requestId:uid(82),id:uid(83),photoId:input.id,index:0,data:image.toString('base64')},a),/ACCESS_DENIED/);
});
test('self-only permission cannot inspect another employee case through AI suggestions',async()=>{
 const f=fixture(),a=employee(reporter),id=uid(40);
 f.tables.get('cases').set(id,{id,organization_id:org,source_record_id:id,created_by:reviewer,created_at:'2026-09-27T09:00:00.000Z',description:'站厅闸机紧急停止按钮防护盖破损',category:'设备运行维修',level:'一般隐患II级',governance_measures:'更换防护盖并复查按钮功能',governance_details:'已完成更换',retrieval_enabled:true});
 a.businessAuthorization.grants=a.businessAuthorization.grants.map(grant=>grant.permission==='app.hazards.read'?{...grant,self:true,organizationIds:[]}:grant);
 const result=await f.service.suggest({organizationId:org,rawText:'站厅闸机紧急停止按钮防护盖破损'},a);
 assert.equal(result.referenceCount,0);
 assert.equal(result.manualReview,true);
});
test('reporter without case read permission still receives a manual-review AI suggestion',async()=>{
 const f=fixture(),a=employee(reporter),id=uid(41);
 f.tables.get('cases').set(id,{id,organization_id:org,source_record_id:id,created_by:reviewer,created_at:'2026-09-27T09:00:00.000Z',description:'站厅闸机紧急停止按钮防护盖破损',category:'设备运行维修',level:'一般隐患II级',governance_measures:'更换防护盖并复查按钮功能',governance_details:'已完成更换',retrieval_enabled:true});
 a.businessAuthorization.grants=a.businessAuthorization.grants.filter(grant=>grant.permission!=='app.hazards.read');
 const result=await f.service.suggest({organizationId:org,rawText:'站厅闸机紧急停止按钮防护盖破损'},a);
 assert.equal(result.referenceCount,0);
 assert.equal(result.manualReview,true);
 await assert.rejects(f.service.cases({},a),/ACCESS_DENIED/);
});
test('AI retrieval checks older cases beyond 100 rows and reduces oversized pages',async()=>{
 const f=fixture({maxCasePageSize:5}),a=employee(reporter),query='站厅闸机紧急停止按钮防护盖破损';
 for(let n=0;n<125;n++){
  const id=uid(1000+n);
  f.tables.get('cases').set(id,{id,organization_id:org,source_record_id:id,created_by:reviewer,created_at:new Date(Date.UTC(2026,8,20,0,0,n)).toISOString(),description:'列车门锁故障',category:'设备运行维修',level:'一般隐患II级',governance_measures:'检修车门',governance_details:'已检修',retrieval_enabled:true});
 }
 const id=uid(999);
 f.tables.get('cases').set(id,{id,organization_id:other,source_record_id:id,created_by:reviewer,created_at:'2020-01-01T00:00:00.000Z',description:query,category:'设备运行维修',level:'一般隐患II级',governance_measures:'更换防护盖',governance_details:'已更换',retrieval_enabled:true});
 assert.equal((await f.service.cases({pageSize:5},a)).rows.length,5);
 assert.equal((await f.service.suggest({organizationId:org,rawText:query},a)).referenceCount,0);
 a.businessAuthorization.grants=a.businessAuthorization.grants.map(grant=>grant.permission==='app.hazards.read'?{...grant,organizationIds:[org,other]}:grant);
 const result=await f.service.suggest({organizationId:org,rawText:query},a);
 assert.equal(result.referenceCount,1);
 assert.equal(result.manualReview,false);
 const blocked=fixture({maxCasePageSize:0});
 await assert.rejects(blocked.service.suggest({organizationId:org,rawText:query},a),/STORAGE_RESULT_LIMIT/);
});
