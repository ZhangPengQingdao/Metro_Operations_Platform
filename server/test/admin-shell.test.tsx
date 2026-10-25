import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {AdminShell, applicationNavigation} from '../../src/app-platform/admin/AdminShell.tsx';
import {AdminLogin} from '../../src/app-platform/admin/AdminLogin.tsx';
const app = {id:'example',name:'测试应用',navigation:[{id:'home',label:'应用首页',path:'/admin/app/example/home'},{id:'records',label:'应用记录',path:'/admin/app/example/records'}]};
const render = (path:string) => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><AdminShell user={{id:'a',username:'owner',displayName:'管理员'}} applications={[app]} onLogout={async()=>{}}><h1>真实页面</h1></AdminShell></MemoryRouter>);
test('application navigation replaces platform menu inside the same sidebar',()=>{
 const html=render('/admin/app/example/home');
 assert.match(html,/data-rail="false" data-secondary="true"/);
 assert.equal((html.match(/<aside class="afc-sidebar"/g)||[]).length,1);
 assert.doesNotMatch(html,/afc-sidebar-island/);
 assert.doesNotMatch(html,/aria-label="管理功能"/);
 assert.match(html,/aria-label="返回一级菜单"/);
 assert.match(html,/aria-label="测试应用导航"/);
 assert.match(render('/admin/apps'),/data-rail="false" data-secondary="false"/);
 assert.doesNotMatch(render('/admin/apps'),/class="afc-application-sidebar"/);
});
test('only authorized app identities and namespaced navigation participate',()=>{
 assert.equal(applicationNavigation('/admin/app/other/home',[app]),undefined);
 assert.equal(applicationNavigation('/admin/app/example-other/home',[app]),undefined);
 const invalid = { ...app, navigation:[{id:'escape',label:'escape',path:'/admin/accounts'},{id:'remote',label:'remote',path:'https://example.com'},{id:'parent',label:'parent',path:'/admin/app/example/../secret'}]};
 assert.equal(applicationNavigation('/admin/app/example/home',[invalid]),undefined);
});

test('single-page apps retain the primary sidebar and highlight their application',()=>{
 const faults={id:'faults',name:'故障记录',navigation:[{id:'home',label:'故障记录',path:'/employee/app/faults'}]};
 const html=renderToStaticMarkup(<MemoryRouter initialEntries={['/employee/app/faults']}><AdminShell mode="employee" user={{id:'e',username:'worker',displayName:'员工'}} applications={[faults]} onLogout={async()=>{}}><h1>故障记录</h1></AdminShell></MemoryRouter>);
 assert.equal((html.match(/>故障记录</g)||[]).length,2);
 assert.match(html,/href="\/employee\/app\/faults"/);
 assert.match(html,/aria-label="工作导航"/);
 assert.match(html,/data-secondary="false"/);
 assert.match(html,/<a(?=[^>]*href="\/employee\/app\/faults")(?=[^>]*class="afc-nav-link is-active(?: active)?")[^>]*>/);
 assert.doesNotMatch(html,/afc-page-header-title/);
 assert.doesNotMatch(html,/aria-label="返回一级菜单"/);
 const differentlyNamed={...faults,name:'检修管理',navigation:[{id:'home',label:'检修记录',path:'/employee/app/faults'}]};
 const other=renderToStaticMarkup(<MemoryRouter initialEntries={['/employee/app/faults']}><AdminShell mode="employee" user={{id:'e',username:'worker',displayName:'员工'}} applications={[differentlyNamed]} onLogout={async()=>{}}>内容</AdminShell></MemoryRouter>);
 assert.match(other,/data-secondary="false"/);
 assert.match(render('/admin/app/example/home'),/href="\/admin\/app\/example\/home"/);
});
test('real login starts without sample credentials, employee fields or invitation routes',()=>{
 const html=renderToStaticMarkup(<AdminLogin onLogin={async()=>{}}/>);
 assert.match(html,/运管开放平台/); assert.match(html,/autocomplete="username"/i); assert.match(html,/autocomplete="current-password"/i);
 assert.doesNotMatch(html,/工号|激活|邀请|注册|value="admin"/);
 assert.match(html,/type="submit"[^>]*disabled/);
});

test('master data uses the same full-height sidebar and exact directory links',()=>{
 const html=render('/admin/data/positions');
 assert.match(html,/data-rail="false" data-secondary="true"/);
 assert.equal((html.match(/<aside class="afc-sidebar"/g)||[]).length,1);
 assert.doesNotMatch(html,/afc-sidebar-island/);
 assert.match(html,/aria-label="基础数据导航"/);
 assert.match(html,/href="\/admin\/data\/positions"/);
 assert.match(html,/href="\/admin\/data\/people"/);
 assert.doesNotMatch(render('/admin/accounts'),/aria-label="基础数据导航"/);
});

test('employee workspace shares navigation, profile and messages without administrator links',()=>{
 const employeeApp={...app,navigation:[{id:'stock',label:'库存',path:'/employee/app/example/stock'},{id:'records',label:'记录',path:'/employee/app/example/records'}]};
 const page=(path:string)=>renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><AdminShell mode="employee" user={{id:'e',username:'worker',displayName:'员工'}} applications={[employeeApp]} onLogout={async()=>{}}>内容</AdminShell></MemoryRouter>);
 assert.match(page('/employee'),/工作台/);assert.match(page('/employee'),/href="\/employee\/apps"/);assert.match(page('/employee'),/通知/);assert.doesNotMatch(page('/employee'),/href="\/employee\/messages"/);assert.match(page('/employee'),/个人中心/);
 assert.doesNotMatch(page('/employee'),/系统更新|账号与权限|\/admin/);
 assert.match(page('/employee/app/example/stock'),/data-secondary="true"/);
 assert.match(page('/employee/app/example/stock'),/返回一级菜单/);
 assert.equal(applicationNavigation('/employee/app/example/stock',[{...employeeApp,navigation:[{id:'escape',label:'escape',path:'/admin/accounts'}]}],'/employee'),undefined);
});
