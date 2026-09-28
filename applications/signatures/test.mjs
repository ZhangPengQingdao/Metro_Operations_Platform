import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSignatureHandlers} from './handlers.mjs';
import {templates} from './templates.mjs';

function fixture(){
 const org=randomUUID(),otherOrg=randomUUID(),owner=randomUUID(),signer=randomUUID(),outsider=randomUUID();
 const people=[{id:owner,name:'创建人',employeeNo:'01',organizationUnitId:org},{id:signer,name:'签字人',employeeNo:'02',organizationUnitId:org}];
 const grants=['read','create','sign'].map(name=>({permission:'app.signatures.'+name,all:false,self:name==='sign',organizationIds:name==='sign'?[]:[org]}));
 const employee={personId:owner,organizationUnitId:org,businessAuthorization:{organizations:[{id:org,name:'测试工班'}],grants}};
 const records=new Map(),signatures=new Map(),notifications=new Map(),calls=[];
 const matches=(row,filter)=>'contains' in filter?filter.contains.every(value=>row[filter.column].some(item=>Object.entries(value).every(([key,expected])=>item[key]===expected))):row[filter.column]===filter.value;
 const gateway={async invoke(op,p){calls.push({op,p});
  if(op==='platform.app_data.get')return {row:structuredClone(records.get(p.id)??null)};
  if(op==='platform.app_data.transaction'){for(const item of p.operations){assert.equal(item.action,'insert');records.set(item.id,{id:item.id,...item.values});}return {results:[]};}
  if(op==='platform.app_data.list'){const rows=[...records.values()].filter(row=>(p.filters??[]).every(filter=>matches(row,filter))&&(!p.anyOf||p.anyOf.some(group=>group.every(filter=>matches(row,filter)))));return {rows:structuredClone(rows),nextCursor:null};}
  if(op==='platform.people.members')return {rows:people.filter(person=>!p.personIds||p.personIds.includes(person.id))};
  if(op==='platform.signatures.associate'){signatures.set(p.entityId,p.personIds.map(personId=>({personId,status:'unsigned'})));return {associated:true,signers:signatures.get(p.entityId)};}
  if(op==='platform.signatures.get')return {associated:signatures.has(p.entityId),signers:signatures.get(p.entityId)??[],...(p.evidencePersonId?{image:signatures.get(p.entityId)?.find(item=>item.personId===p.evidencePersonId)?.status==='signed'?'data:image/png;base64,AAAA':null}:{})};
  if(op==='platform.signatures.sign'){const own=signatures.get(p.entityId);const target=own.find(item=>item.personId===currentPerson);if(!target)throw Error('ACCESS_DENIED');target.status='signed';return {associated:true,signers:own};}
  if(op==='platform.notifications.create'){notifications.set(p.id,p);return {id:p.id};}
  if(op==='platform.notifications.cancel'){notifications.delete(p.id);return {cancelled:true};}
  throw Error('Unexpected '+op);
 }};
 let currentPerson=owner;
 const handlers=createSignatureHandlers(gateway),call=(name,p={},actor=employee)=>{currentPerson=actor.personId;return handlers.get(name).execute(p,new AbortController().signal,actor);};
 const base=(key='offline-training-sheet')=>({id:randomUUID(),requestId:randomUUID(),organizationId:org,templateKey:key,title:'测试签字任务',fields:{},participantIds:[signer],scoreRows:[]});
 const complete=value=>{const template=templates.find(item=>item.key===value.templateKey);for(const [key,,type,required] of template.fields){value.fields[key]=type==='person'?owner:type==='date'?'2026-09-28':type==='time'?'08:30':type==='month'?'2026-09':type.startsWith('select:')?type.slice(7).split('|')[0]:required?'测试':'';}if(value.templateKey==='employee-shift-adjustment'){value.participantIds=[];value.fields.adjustmentType='调休';}if(value.templateKey==='competition-score-sheet')value.scoreRows=[{personId:signer,score:'95',duration:'01:20'}];return value;};
 return {org,otherOrg,owner,signer,outsider,employee,records,notifications,calls,call,form:key=>complete(base(key))};
}

test('four reference templates produce structured tasks and personal reminders',async()=>{
 const f=fixture();for(const template of templates){const payload=f.form(template.key),result=await f.call('create',payload);assert.equal(result.ok,true,template.key);assert.equal(result.result.signature,'ready');assert.equal(result.result.notification,'ready');assert.equal(f.records.get(payload.id).template_key,template.key);}
 assert.equal(f.records.size,4);assert.ok(f.notifications.size>=4);
});

test('signer sees task, signs only as bound employee, and reminder is cancelled',async()=>{
 const f=fixture(),payload=f.form(),created=await f.call('create',payload);assert.equal(created.ok,true);
 const actor={...f.employee,personId:f.signer,businessAuthorization:{...f.employee.businessAuthorization,grants:[{permission:'app.signatures.sign',all:false,self:true,organizationIds:[]}]}};
 assert.equal((await f.call('list',{},actor)).result.rows.length,1);
 assert.equal((await f.call('detail',{id:payload.id},actor)).ok,true);
 assert.equal((await f.call('sign',{id:payload.id,image:'data:image/png;base64,AAAA'},actor)).ok,true);
 assert.equal((await f.call('detail',{id:payload.id},actor)).result.myStatus,'signed');
 const evidence=await f.call('evidence',{id:payload.id,signerId:f.signer},actor);assert.equal(evidence.ok,true,JSON.stringify(evidence));assert.equal(evidence.result.image,'data:image/png;base64,AAAA');
 assert.equal((await f.call('evidence',{id:payload.id,signerId:f.outsider},actor)).error.code,'INVALID_INPUT');
 assert.equal(f.notifications.size,1);
 const outsider={...actor,personId:f.outsider};assert.equal((await f.call('detail',{id:payload.id},outsider)).error.code,'ACCESS_DENIED');
 assert.equal((await f.call('evidence',{id:payload.id,signerId:f.signer},outsider)).error.code,'ACCESS_DENIED');
 assert.equal((await f.call('create',{...f.form(),organizationId:f.otherOrg})).error.code,'ACCESS_DENIED');
});

test('invalid template data is rejected before storage or public signing',async()=>{
 const f=fixture(),payload=f.form('employee-shift-adjustment');payload.fields.adjustmentType='换班';
 assert.equal((await f.call('create',payload)).error.code,'INVALID_INPUT');
 assert.equal(f.records.size,0);assert.equal(f.calls.some(item=>item.op==='platform.signatures.associate'),false);
});
