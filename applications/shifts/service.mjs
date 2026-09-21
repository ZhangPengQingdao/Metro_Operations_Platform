import {randomUUID,createHash} from 'node:crypto';
import {createAppDataClient,createPlatformSignaturesClient,createPlatformWebhookClient} from '@metro/platform-sdk/app-gateway';
import {defaults,validateModules,validateForm,lineItems} from './modules.mjs';
import {grant,allowed,requireAccess,scope} from './business-policy.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const kind=v=>{if(!['handover','meeting'].includes(v))throw Error('INVALID_INPUT');return v;};
const date=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;};
const ownOrganization=(input,employee)=>{const org=employee.organizationUnitId;if(!uuid(org)||input.organizationId&&input.organizationId!==org)throw Error('ACCESS_DENIED');return org;};
const configId=(org,type)=>{const h=createHash('sha256').update(`${org??'global'}:${type}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
export function createShiftsService(gateway){
 const data=createAppDataClient(gateway),signatures=createPlatformSignaturesClient(gateway),webhook=createPlatformWebhookClient(gateway);
 const readConfig=async(org,type,signal)=>(await data.get('configs',configId(org,type),signal)).row;
 async function ancestry(org,signal){return (await gateway.invoke('platform.people.organization_context',{organizationUnitId:org},signal)).organizations;}
 async function effective(org,type,signal){
  const chain=await ancestry(org,signal);
  for(const node of [...chain.filter((o,i)=>i===0||o.unitType==='department'),{id:null}]){const row=await readConfig(node.id,type,signal);if(row&&row.value.mode!=='inherit')return {value:row.value,source:node.id,revision:row.revision};}
  return {value:type==='webhook'?{mode:'disabled',url:'',handover:false,meeting:false}:{mode:'override',modules:defaults[type]},source:null,revision:0};
 }
 function canRead(employee,row){return grant(employee,'app.shifts.read')?.self&&row.people.some(p=>p.id===employee.personId)||allowed(employee,'app.shifts.read',row.organization_id,row.created_by)||(grant(employee,'app.shifts.sign')&&row.kind==='meeting'&&row.people.some(p=>p.id===employee.personId));}
 async function record(id,employee,signal){if(!uuid(id))throw Error('INVALID_INPUT');const {row}=await data.get('records',id,signal);if(!row||!canRead(employee,row))throw Error('ACCESS_DENIED');return row;}
 async function member(id,org,signal){if(!uuid(id))throw Error('INVALID_INPUT');const page=await gateway.invoke('platform.people.members',{organizationUnitId:org,personId:id},signal);if(!page.rows[0])throw Error('INVALID_PERSON');return page.rows[0];}
 async function notify(row,signal){
  try{const cfg=(await effective(row.organization_id,'webhook',signal)).value;if(cfg.mode==='disabled'||!cfg[row.kind]||!cfg.url)return 'disabled';
   const title=row.kind==='meeting'?'晨会记录':'交接班记录';
   await webhook.send({url:cfg.url,messageType:'text',message:`${title}\n日期：${row.record_date} ${row.record_time}\n${row.people.map(p=>p.name).join('、')}\n`+row.module_snapshot.filter(m=>m.enabled&&m.type==='text'&&row.form_data[m.id]).map(m=>`${m.label}：${lineItems(row.form_data[m.id]).map(r=>r.text+(r.remark?'（'+r.remark+'）':'')).join('；')}`).join('\n')},signal);return 'sent';
  }catch{return 'unconfirmed';}
 }
 return {
  async session(_input,employee){if(!employee.businessAuthorization)throw Error('ACCESS_DENIED');return {personId:employee.personId,organizationId:employee.organizationUnitId,organizations:employee.businessAuthorization.organizations,grants:employee.businessAuthorization.grants};},
  async members(input,employee,signal){
   const org=ownOrganization(input,employee);
   if(!uuid(org)||!['app.shifts.submit','app.shifts.config','app.shifts.read'].some(p=>allowed(employee,p,org,employee.personId)))throw Error('ACCESS_DENIED');
   return gateway.invoke('platform.people.members',{organizationUnitId:org,...(input.search?{search:String(input.search).slice(0,100)}:{})},signal);
  },
  async template(input,employee,signal){
   const k=kind(input.kind),org=ownOrganization(input,employee);requireAccess(employee,'app.shifts.submit',org,employee.personId);
   const value=await effective(org,k,signal);return {modules:value.value.modules,source:value.source,revision:value.revision};
  },
  async 'load-draft'(input,employee,signal){const org=ownOrganization(input,employee);requireAccess(employee,'app.shifts.submit',org,employee.personId);const {row}=await data.get('drafts',configId(org,employee.personId+':'+kind(input.kind)),signal);return {draft:row?.value??null,revision:row?.revision??0};},
  async 'save-draft'(input,employee,signal){const org=ownOrganization(input,employee);requireAccess(employee,'app.shifts.submit',org,employee.personId);if(!uuid(input.requestId)||(!input.value||typeof input.value!=='object'||Array.isArray(input.value)||JSON.stringify(input.value).length>10000))throw Error('INVALID_INPUT');const id=configId(org,employee.personId+':'+kind(input.kind)),old=(await data.get('drafts',id,signal)).row;if((old?.revision??0)!==input.revision)throw Error('CONFLICT');await data.transaction(input.requestId,[{table:'drafts',id,action:old?'update':'insert',values:{owner_id:employee.personId,organization_id:org,value:input.value,revision:(old?.revision??0)+1},...(old?{expected:{revision:old.revision}}:{})}],signal);return {revision:(old?.revision??0)+1};},
  async previous(input,employee,signal){
   const org=ownOrganization(input,employee);requireAccess(employee,'app.shifts.submit',org,employee.personId);
   if(!allowed(employee,'app.shifts.read',org,employee.personId))return {row:null};
   const page=await data.list('records',{...scope(employee,'app.shifts.read'),filters:[{column:'organization_id',value:org},{column:'kind',value:kind(input.kind)}],order:{column:'record_order',direction:'desc'},pageSize:1},signal);
   const row=page.rows[0];return {row:row?{id:row.id,shiftType:row.shift_type,handoverIds:row.people.filter(p=>p.role==='takeover').map(p=>p.id),form:{other_matters:row.form_data.other_matters??''}}:null};
  },
  async settings(input,employee,signal){
   const org=input.organizationId??null;
   if(org===null?!grant(employee,'app.shifts.config')?.all:!allowed(employee,'app.shifts.config',org))throw Error('ACCESS_DENIED');
   const values={};for(const type of ['handover','meeting','webhook']){const row=await readConfig(org,type,signal),resolved=row??(org?await effective(org,type,signal):null);
    const value=structuredClone(resolved?.value??(type==='webhook'?{mode:'disabled',url:'',handover:false,meeting:false}:{mode:'override',modules:defaults[type]}));
    if(type==='webhook'){value.configured=!!value.url;delete value.url;}
    values[type]={value,revision:row?.revision??0,inherited:!row&&org!==null};
   }return values;
  },
  async configure(input,employee,signal){
   const org=input.organizationId??null,type=input.type;if(!['handover','meeting','webhook'].includes(type)||!uuid(input.requestId))throw Error('INVALID_INPUT');
   if(org===null?!grant(employee,'app.shifts.config')?.all:!allowed(employee,'app.shifts.config',org))throw Error('ACCESS_DENIED');
   const previous=await readConfig(org,type,signal);if((previous?.revision??0)!==input.revision)throw Error('CONFLICT');
   let value;if(type==='webhook'){
    if(!['inherit','override','disabled'].includes(input.value?.mode))throw Error('INVALID_INPUT');
    const url=input.value.url===undefined?previous?.value.url??'':input.value.url;
    if(typeof url!=='string'||url.length>2048)throw Error('INVALID_INPUT');
    if(url){const u=new URL(url);if(u.protocol!=='https:'||!['qyapi.weixin.qq.com','oapi.dingtalk.com'].includes(u.hostname)||u.username||u.password||u.hash||u.port)throw Error('INVALID_INPUT');}
    value={mode:input.value.mode,url,handover:input.value.handover===true,meeting:input.value.meeting===true};
   }else{if(!['inherit','override'].includes(input.value?.mode))throw Error('INVALID_INPUT');value={mode:input.value.mode,modules:validateModules(type,input.value.modules)};}
   const values={organization_id:org,scope_key:org??'global',config_type:type,value,revision:(previous?.revision??0)+1,updated_by:employee.personId,updated_at:new Date().toISOString()};
   await data.transaction(input.requestId,[{action:previous?'update':'insert',table:'configs',id:configId(org,type),values,...(previous?{expected:{revision:previous.revision}}:{})}],signal);return {saved:true};
  },
  async 'test-webhook'(input,employee,signal){const org=input.organizationId??null;if(org===null?!grant(employee,'app.shifts.config')?.all:!allowed(employee,'app.shifts.config',org))throw Error('ACCESS_DENIED');
   const cfg=org?(await effective(org,'webhook',signal)).value:(await readConfig(null,'webhook',signal))?.value;if(!cfg?.url||cfg.mode==='disabled')throw Error('INVALID_INPUT');await webhook.send({url:cfg.url,message:'晨会交接：测试消息',messageType:'text'},signal);return {sent:true};},
  async list(input,employee,signal){const k=kind(input.kind);const filters=[{column:'kind',value:k}];
   if(input.organizationId){requireAccess(employee,'app.shifts.read',input.organizationId,employee.personId);filters.push({column:'organization_id',value:input.organizationId});}
   if(input.from&&!date(input.from)||input.to&&!date(input.to)||input.from&&input.to&&input.from>input.to||input.search!==undefined&&(typeof input.search!=='string'||input.search.length>100))throw Error('INVALID_INPUT');
   if(input.shiftType)filters.push({column:'shift_type',value:input.shiftType});
   return data.list('records',{...scope(employee,'app.shifts.read'),filters,...(input.search?.trim()?{search:{column:'search_text',text:input.search.trim()}}:{}),order:{column:'record_order',direction:'desc'},...(input.after?{after:input.after}:{}),...(input.from||input.to?{range:{column:'record_date',...(input.from?{from:input.from}:{}),...(input.to?{to:input.to}:{})}}:{}),pageSize:10},signal);
  },
  async detail(input,employee,signal){const row=await record(input.id,employee,signal);let signatureInfo=null;if(row.kind==='meeting')try{signatureInfo=await signatures.get(row.id,signal);}catch{signatureInfo={unavailable:true};}return {...row,signatureInfo};},
  async save(input,employee,signal){
   const k=kind(input.kind),org=ownOrganization(input,employee);
   requireAccess(employee,'app.shifts.submit',org,employee.personId);
   if(!uuid(input.requestId)||!uuid(input.id)||!date(input.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)||k==='handover'&&!['day','night'].includes(input.shiftType))throw Error('INVALID_INPUT');
   const existing=(await data.get('records',input.id,signal)).row;
   if(existing){if(existing.organization_id!==org||existing.kind!==k||existing.created_by!==employee.personId&&!allowed(employee,'app.shifts.config',org))throw Error('ACCESS_DENIED');if(existing.intent_id===input.requestId)return {id:existing.id,saved:true,notification:'unchanged'};if(existing.revision!==input.revision)throw Error('CONFLICT');}
   const config=existing?.module_snapshot??(input.modules?validateModules(k,input.modules):(await effective(org,k,signal)).value.modules);
   const personIds=[...new Set(k==='meeting'?[input.hostId,...(input.participantIds??[])]:[employee.personId,...(input.handoverIds??[]),...(input.takeoverIds??[])])];
   if(personIds.length>100||!personIds.length)throw Error('INVALID_INPUT');
   const form=validateForm(config,input.form,personIds);
   const resolved=[];for(let offset=0;offset<personIds.length;offset+=50){if(personIds.slice(offset,offset+50).some(id=>!uuid(id)))throw Error('INVALID_INPUT');resolved.push(...(await gateway.invoke('platform.people.members',{organizationUnitId:org,personIds:personIds.slice(offset,offset+50)},signal)).rows);}
   const people=[];for(const id of personIds){const p=resolved.find(p=>p.id===id);if(!p)throw Error('INVALID_PERSON');people.push({id:p.id,name:p.name,role:k==='meeting'?(id===input.hostId?'host':'participant'):(id===employee.personId||input.takeoverIds?.includes(id)?'takeover':'handover')});}
   const now=new Date().toISOString(),row={id:input.id,organization_id:org,record_date:input.date,record_time:input.time,record_order:input.date+'T'+input.time,kind:k,shift_type:k==='handover'?input.shiftType:'',host_id:k==='meeting'?input.hostId:null,people,search_text:people.map(p=>p.name).join(' ')+ ' '+Object.values(form).map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' '),module_snapshot:config,form_data:form,created_by:existing?.created_by??employee.personId,created_at:existing?.created_at??now,updated_by:employee.personId,updated_at:now,revision:(existing?.revision??0)+1,intent_id:input.requestId};
   const {id,...values}=row;await data.transaction(input.requestId,[{action:existing?'update':'insert',table:'records',id,values,...(existing?{expected:{revision:existing.revision}}:{})}],signal);
   let signatureStatus='none';if(k==='meeting'){try{await signatures.associate({entityId:id,title:'晨会记录',organizationUnitId:org,personIds:people.map(p=>p.id)},signal);signatureStatus='ready';}catch{signatureStatus='unconfirmed';}}
   return {id,saved:true,signatureStatus,notification:await notify(row,signal)};
  },
  async 'signature-image'(input,employee,signal){const row=await record(input.id,employee,signal);if(row.kind!=='meeting'||!row.people.some(p=>p.id===input.signerPersonId))throw Error('ACCESS_DENIED');return signatures.get(row.id,signal,input.signerPersonId);},
  async sign(input,employee,signal){const row=await record(input.id,employee,signal);if(row.kind!=='meeting'||!grant(employee,'app.shifts.sign')||!row.people.some(p=>p.id===employee.personId))throw Error('ACCESS_DENIED');await signatures.associate({entityId:row.id,title:'晨会记录',organizationUnitId:row.organization_id,personIds:row.people.map(p=>p.id)},signal);return signatures.sign(row.id,input.image,signal);},
 };
}
