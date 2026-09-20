import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OrganizationPeoplePicker} from '../../src/components/ui/OrganizationPeoplePicker.tsx';
test('L2 people selector exposes hierarchy, current-page selection, pagination and caller role actions',()=>{
 const html=renderToStaticMarkup(<OrganizationPeoplePicker organizations={[{id:'d',name:'部室',parentId:null},{id:'t',name:'工班',parentId:'d'}]} people={[{id:'p',name:'成员',employeeNo:'001',organizationId:'t'}]} organizationId="t" onOrganizationChange={()=>{}} search="" onSearchChange={()=>{}} page={2} hasNext onPageChange={()=>{}} selected={()=>true} onPersonChange={()=>{}} organizationSelection={id=>id==='d'?'mixed':true} onOrganizationSelection={()=>{}} renderPersonAction={()=> <select aria-label="成员角色"><option>普通成员</option></select>}/>);
 assert.match(html,/aria-checked="mixed"/);assert.match(html,/选择工班/);assert.match(html,/选择本页成员/);assert.match(html,/成员角色/);assert.match(html,/下一页/);assert.doesNotMatch(html,/multiple=""/);
});
