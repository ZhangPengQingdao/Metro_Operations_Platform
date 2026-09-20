import test from 'node:test';
import assert from 'node:assert/strict';
import {audienceIncludes} from '../src/app-platform/business-authorization/audience.ts';
const orgs=[{id:'department',parentId:null},{id:'team',parentId:'department'},{id:'child',parentId:'team'},{id:'other',parentId:null}];
const a={all:false,personIds:[],organizationIds:[],departmentIds:['department'],excludedPersonIds:[],excludedOrganizationIds:[]};
test('dynamic organization membership includes descendants and exclusions override individual includes',()=>{
 assert.equal(audienceIncludes(a,'new-joiner','child',orgs),true);
 assert.equal(audienceIncludes(a,'new-joiner','other',orgs),false);
 assert.equal(audienceIncludes({...a,personIds:['member'],excludedOrganizationIds:['team']},'member','child',orgs),false);
 assert.equal(audienceIncludes({...a,excludedPersonIds:['member']},'member','team',orgs),false);
 assert.equal(audienceIncludes({...a,all:true,excludedOrganizationIds:['team']},'member','team',orgs),false);
 assert.equal(audienceIncludes(a,'member','team',orgs.map(o=>({...o,status:o.id==='department'?'inactive':'active'}))),false);
 assert.equal(audienceIncludes(a,'member','team',[{id:'department',parentId:'team'},{id:'team',parentId:'department'}]),false);
});
