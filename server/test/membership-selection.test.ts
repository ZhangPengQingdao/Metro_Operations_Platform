import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyAudience,included,selectPerson,selectOrganization} from '../../src/app-platform/employee/membership-selection.ts';
import {audienceIncludes} from '../src/app-platform/business-authorization/audience.ts';

const orgs=[{id:'dept',name:'部室',parentId:null},{id:'team',name:'工班',parentId:'dept'},{id:'other',name:'外班',parentId:'dept'}];
const people=Array.from({length:52},(_,i)=>({id:`p${i}`,name:`成员${i}`,employeeNo:String(i),organizationId:'team'}));
const excluded={...emptyAudience,departmentIds:['dept'],excludedOrganizationIds:['team'],excludedPersonIds:people.map(p=>p.id)};
test('reselecting a page in an excluded team admits only that page and survives a save round trip',()=>{
 let draft=excluded;
 for(const p of people.slice(0,50))draft=selectPerson(draft,p,true,orgs);
 draft=JSON.parse(JSON.stringify(draft));
 for(const [i,p] of people.entries()){
  assert.equal(included(draft,p,orgs),i<50);
  assert.equal(audienceIncludes(draft,p.id,p.organizationId,orgs),i<50);
 }
 const newJoiner={...people[0],id:'new'};
 assert.equal(included(draft,newJoiner,orgs),false);
 for(const p of people.slice(0,50))draft=selectPerson(draft,p,false,orgs);
 assert.ok(people.every(p=>!included(draft,p,orgs)));
 assert.deepEqual(draft.personOverrides,[]);
});
test('individual and filtered selection preserves teammates, sibling teams and old exclusion rules',()=>{
 const sibling={...people[0],id:'outside',organizationId:'other'};
 const before={...excluded,personIds:['p1']};
 assert.equal(included(before,people[1],orgs),false);
 let draft=selectPerson(before,people[0],true,orgs);
 assert.equal(included(draft,people[0],orgs),true);
 assert.equal(included(draft,people[1],orgs),false);
 assert.equal(included(draft,sibling,orgs),true);
 draft=selectPerson(draft,sibling,false,orgs);
 assert.equal(included(draft,sibling,orgs),false);
 draft=selectPerson(draft,sibling,true,orgs);
 assert.equal(included(draft,sibling,orgs),true);
 assert.equal(included(draft,{...people[0],organizationId:'unknown'},orgs),false);
 const removed=selectOrganization(draft,'dept',false,orgs);
 assert.equal(included(removed,people[0],orgs),false);
 assert.equal(included(removed,sibling,orgs),false);
 assert.deepEqual(removed.personOverrides,[]);
});
test('explicit re-selection cannot override individual exclusion or inactive/cyclic organizations',()=>{
 const draft=selectPerson(excluded,people[0],true,orgs);
 assert.equal(audienceIncludes({...draft,excludedPersonIds:['p0']},'p0','team',orgs),false);
 assert.equal(audienceIncludes(draft,'p0','team',orgs.map(o=>({...o,status:o.id==='dept'?'inactive':'active'}))),false);
 assert.equal(audienceIncludes(draft,'p0','team',orgs.map(o=>({...o,parentId:o.id==='dept'?'team':o.parentId}))),false);
 assert.equal(audienceIncludes(draft,'p0','other',[...orgs]),true); // Independent department inclusion still applies.
 assert.equal(audienceIncludes({...draft,departmentIds:[]},'p0','other',orgs),false);
});
