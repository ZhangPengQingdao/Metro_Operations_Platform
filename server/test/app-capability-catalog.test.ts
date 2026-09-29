import test from 'node:test';
import assert from 'node:assert/strict';
import {appCapabilityCatalog} from '../../src/app-platform/admin/app-capability-catalog.ts';

test('business API titles stay distinct when endpoints share one permission',()=>{
 const catalog=appCapabilityCatalog([{appId:'huicetong',enabled:true,manifest:{
  id:'huicetong',name:'慧策通',version:'0.1.2',
  permissions:{defined:[{code:'app.huicetong.read',description:'查看本部门计划'}],requested:[]},
  api:[
   {id:'cycle-list',method:'POST',path:'/cycle-list',handler:'cycle-list',permission:'app.huicetong.read',businessPermission:'app.huicetong.read',expose:{contractVersion:'1.0',mode:'read',title:'查询计划周期列表'}},
   {id:'category-list',method:'POST',path:'/category-list',handler:'category-list',permission:'app.huicetong.read',businessPermission:'app.huicetong.read',expose:{contractVersion:'1.0',mode:'read',title:'查询分类列表'}},
   {id:'legacy',method:'POST',path:'/legacy',handler:'legacy',permission:'app.huicetong.read',businessPermission:'app.huicetong.read',expose:{contractVersion:'1.0',mode:'read'}},
  ],
 }}],[]);
 assert.deepEqual(catalog[0].capabilities.map(cap=>[cap.title,cap.permissionDescription]),[
  ['查询计划周期列表','查看本部门计划'],
  ['查询分类列表','查看本部门计划'],
  ['POST /legacy','查看本部门计划'],
 ]);
});
