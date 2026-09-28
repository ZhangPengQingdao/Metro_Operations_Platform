import {createHash} from 'node:crypto';
import {createAppDataClient,createPlatformSignaturesClient,createPlatformNotificationsClient} from '@metro/platform-sdk/app-gateway';
import {allowsAppResource} from '@metro/platform-sdk/app-backend';
import {templates,templateFor,validateTemplateData} from './templates.mjs';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const notificationId=(recordId,personId)=>{const hex=createHash('sha256').update(`signatures:${recordId}:${personId}`).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;};
const can=(employee,permission,row)=>allowsAppResource(employee,`app.signatures.${permission}`,{organizationUnitId:row.organization_id,ownerPersonId:row.created_by});
const grant=(employee,permission)=>employee.businessAuthorization?.grants.find(item=>item.permission===`app.signatures.${permission}`);
const ownOrganization=(input,employee)=>{const org=employee.organizationUnitId;if(!uuid(org)||input.organizationId&&input.organizationId!==org)throw Error('ACCESS_DENIED');return org;};
const visible=(employee,row)=>can(employee,'read',row)||row.signer_ids.some(item=>item.id===employee.personId)&&can(employee,'sign',{...row,created_by:employee.personId});
const summary=(row,info,personId)=>({...row,signers:info?.signers??[],signatureUnavailable:!info?.associated,
 signed:(info?.signers??[]).filter(item=>item.status==='signed').length,total:row.signer_ids.length,
 status:row.cancelled?'cancelled':info?.signers?.length&&info.signers.every(item=>item.status==='signed')?'completed':'dispatched',
 myStatus:info?.signers?.find(item=>item.personId===personId)?.status??null});

export function createSignatureAppService(gateway){
 const data=createAppDataClient(gateway),signatures=createPlatformSignaturesClient(gateway),notifications=createPlatformNotificationsClient(gateway);
 async function rowFor(id,employee,signal){if(!uuid(id))throw Error('INVALID_INPUT');const {row}=await data.get('records',id,signal);if(!row||!visible(employee,row))throw Error('ACCESS_DENIED');return row;}
 async function signatureInfo(id,signal){try{return await signatures.get(id,signal);}catch{return null;}}
 async function resolvePeople(org,ids,signal){const people=[];for(let i=0;i<ids.length;i+=50){const page=await gateway.invoke('platform.people.members',{organizationUnitId:org,personIds:ids.slice(i,i+50)},signal);people.push(...page.rows);}return people;}
 return {
  async session(_input,employee){if(!employee.businessAuthorization)throw Error('ACCESS_DENIED');return {personId:employee.personId,organizationId:employee.organizationUnitId,organizations:employee.businessAuthorization.organizations,grants:employee.businessAuthorization.grants};},
  async templates(){return {rows:templates};},
  async members(input,employee,signal){const org=ownOrganization(input,employee);if(!['create','read'].some(permission=>can(employee,permission,{organization_id:org,created_by:employee.personId})))throw Error('ACCESS_DENIED');return gateway.invoke('platform.people.members',{organizationUnitId:org,...(input.search?{search:String(input.search).slice(0,100)}:{})},signal);},
  async list(input,employee,signal){
   const read=grant(employee,'read'),sign=grant(employee,'sign');if(!read&&!sign)throw Error('ACCESS_DENIED');
   if(input.organizationId&&!uuid(input.organizationId)||input.search!==undefined&&(typeof input.search!=='string'||input.search.length>100))throw Error('INVALID_INPUT');
   const anyOf=[];if(read?.all)anyOf.push([]);else if(read){for(const id of read.organizationIds)anyOf.push([{column:'organization_id',value:id}]);if(read.self)anyOf.push([{column:'created_by',value:employee.personId}]);}
   if(sign)anyOf.push([{column:'signer_ids',contains:[{id:employee.personId}]}]);
   if(!anyOf.length)throw Error('ACCESS_DENIED');
   const filters=[];if(input.organizationId)filters.push({column:'organization_id',value:input.organizationId});
   if(input.templateKey){if(!templateFor(input.templateKey))throw Error('INVALID_INPUT');filters.push({column:'template_key',value:input.templateKey});}
   const page=await data.list('records',{filters,...(anyOf.some(entry=>!entry.length)?{}:{anyOf}),...(input.search?.trim()?{search:{column:'search_text',text:input.search.trim()}}:{}),order:{column:'created_at',direction:'desc'},...(input.after?{after:input.after}:{}),pageSize:15},signal);
   const rows=await Promise.all(page.rows.map(async row=>summary(row,await signatureInfo(row.id,signal),employee.personId)));
   return {...page,rows};
  },
  async detail(input,employee,signal){const row=await rowFor(input.id,employee,signal);return summary(row,await signatureInfo(row.id,signal),employee.personId);},
  async evidence(input,employee,signal){
   const row=await rowFor(input.id,employee,signal);
   if(!uuid(input.signerId)||!row.signer_ids.some(item=>item.id===input.signerId))throw Error('INVALID_INPUT');
   const result=await signatures.get(row.id,signal,input.signerId);
   if(!result.associated||!result.signers.some(item=>item.personId===input.signerId&&item.status==='signed')||
    typeof result.image!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(result.image))throw Error('READ_FAILED');
   return {image:result.image};
  },
  async create(input,employee,signal){
   const org=ownOrganization(input,employee);if(!can(employee,'create',{organization_id:org,created_by:employee.personId}))throw Error('ACCESS_DENIED');
   if(!uuid(input.id)||!uuid(input.requestId)||!templateFor(input.templateKey)||typeof input.title!=='string'||!input.title.trim()||input.title.length>160)throw Error('INVALID_INPUT');
   const existing=(await data.get('records',input.id,signal)).row;
   if(existing){if(existing.intent_id===input.requestId&&existing.created_by===employee.personId)return {id:existing.id,created:true,notification:'unchanged'};throw Error('CONFLICT');}
   const fields=validateTemplateData(input.templateKey,input.fields,input.participantIds);
   const scoreRows=input.templateKey==='competition-score-sheet'?input.scoreRows:[];
   if(!Array.isArray(scoreRows)||scoreRows.length>100||input.templateKey==='competition-score-sheet'&&scoreRows.length!==input.participantIds.length)throw Error('INVALID_INPUT');
   const scores=scoreRows.map(item=>{if(!item||!uuid(item.personId)||!input.participantIds.includes(item.personId)||typeof item.score!=='string'||item.score.length>30||typeof item.duration!=='string'||item.duration.length>30)throw Error('INVALID_INPUT');return {personId:item.personId,score:item.score.trim(),duration:item.duration.trim()};});
   const personFields=templateFor(input.templateKey).fields.filter(field=>field[2]==='person').map(field=>fields[field[0]]).filter(Boolean);
   const signerIds=[...new Set([...input.participantIds,...personFields])];if(!signerIds.length||signerIds.length>100||signerIds.some(id=>!uuid(id)))throw Error('INVALID_INPUT');
   const people=await resolvePeople(org,signerIds,signal);if(people.length!==signerIds.length||signerIds.some(id=>!people.some(person=>person.id===id)))throw Error('INVALID_PERSON');
   const now=new Date().toISOString(),row={organization_id:org,created_by:employee.personId,created_at:now,updated_at:now,intent_id:input.requestId,template_key:input.templateKey,title:input.title.trim(),fields,participants:input.participantIds.map(id=>({id,name:people.find(person=>person.id===id).name})),score_rows:scores,signer_ids:signerIds.map(id=>({id})),signer_people:signerIds.map(id=>({id,name:people.find(person=>person.id===id).name})),search_text:[input.title,...Object.values(fields),...people.map(person=>person.name)].join(' ').slice(0,4000),cancelled:false};
   await data.transaction(input.requestId,[{action:'insert',table:'records',id:input.id,values:row}],signal);
   let signature='ready';try{await signatures.associate({entityId:input.id,title:input.title.trim(),organizationUnitId:org,personIds:signerIds},signal);}catch{signature='unconfirmed';}
   let notification=signature==='ready'?'ready':'not_started';
   if(signature==='ready')for(let i=0;i<signerIds.length;i+=4){
    const results=await Promise.allSettled(signerIds.slice(i,i+4).map(id=>notifications.create({id:notificationId(input.id,id),entityId:input.id,personId:id,title:`待签字：${input.title.trim()}`,body:'有一份新的在线签字任务需要您本人签署。'},signal)));
    if(results.some(result=>result.status==='rejected'))notification='unconfirmed';
   }
   return {id:input.id,created:true,signature,notification};
  },
  async sign(input,employee,signal){
   const row=await rowFor(input.id,employee,signal);if(row.cancelled||!row.signer_ids.some(item=>item.id===employee.personId)||!can(employee,'sign',{...row,created_by:employee.personId}))throw Error('ACCESS_DENIED');
   if(typeof input.image!=='string'||input.image.length>45000)throw Error('INVALID_INPUT');
   const info=await signatures.sign(row.id,input.image,signal);
   let notification='cleared';try{await notifications.cancel(notificationId(row.id,employee.personId),signal);}catch{notification='unconfirmed';}
   return {signed:info.signers.some(item=>item.personId===employee.personId&&item.status==='signed'),notification};
  }
 };
}
