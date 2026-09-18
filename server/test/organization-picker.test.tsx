import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OrganizationPicker,organizationPath} from '../../src/components/ui/OrganizationPicker.tsx';
const options=[{id:'company',name:'公司'},{id:'department',name:'检修部',parentId:'company'},{id:'team',name:'一工班',parentId:'department'},{id:'other',name:'一工班',parentId:'company'},{id:'disabled',name:'旧组织',status:'inactive'}];
test('organization paths preserve hierarchy and distinguish same-name branches without looping on malformed cycles',()=>{
 assert.deepEqual(organizationPath(options,'team').map(x=>x.name),['公司','检修部','一工班']);
 assert.deepEqual(organizationPath(options,'other').map(x=>x.id),['company','other']);
 assert.deepEqual(organizationPath(options,'missing'),[]);
 assert.equal(organizationPath([{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}],'a').length,2);
});
test('picker accepts parent selection, displays full path and excludes inactive or descendant targets from required value',()=>{
 const render=(value:string,excludeId?:string)=>renderToStaticMarkup(<OrganizationPicker options={options} value={value} excludeId={excludeId} required onChange={()=>{}}/>);
 assert.match(render('department'),/公司 \/ 检修部/);assert.match(render('department'),/<option value="department" selected=""/);
 assert.match(render('team'),/公司 \/ 检修部 \/ 一工班/);
 assert.doesNotMatch(render('disabled'),/<option value="disabled"/);
 assert.doesNotMatch(render('team','department'),/<option value="team"/);
});
