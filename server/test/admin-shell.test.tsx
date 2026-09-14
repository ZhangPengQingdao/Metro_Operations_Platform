import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {AdminShell, applicationNavigation} from '../../src/app-platform/admin/AdminShell.tsx';
import {AdminLogin} from '../../src/app-platform/admin/AdminLogin.tsx';
const app = {id:'example',name:'测试应用',navigation:[{id:'home',label:'应用首页',path:'/admin/app/example/home'}]};
const render = (path:string) => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><AdminShell user={{id:'a',username:'owner',displayName:'管理员'}} applications={[app]} onLogout={async()=>{}}><h1>真实页面</h1></AdminShell></MemoryRouter>);
test('application navigation replaces platform menu inside the same sidebar',()=>{
 const html=render('/admin/app/example/home');
 assert.match(html,/data-rail="false" data-secondary="true"/);
 assert.equal((html.match(/class="afc-sidebar-island/g)||[]).length,1);
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
test('real login starts without sample credentials, employee fields or invitation routes',()=>{
 const html=renderToStaticMarkup(<AdminLogin onLogin={async()=>{}}/>);
 assert.match(html,/运管开放平台/); assert.match(html,/autocomplete="username"/i); assert.match(html,/autocomplete="current-password"/i);
 assert.doesNotMatch(html,/工号|激活|邀请|注册|value="admin"/);
 assert.match(html,/type="submit"[^>]*disabled/);
});

test('master data uses the same island secondary navigation and exact directory links',()=>{
 const html=render('/admin/data/positions');
 assert.match(html,/data-rail="false" data-secondary="true"/);
 assert.equal((html.match(/class="afc-sidebar-island/g)||[]).length,1);
 assert.match(html,/aria-label="基础数据导航"/);
 assert.match(html,/href="\/admin\/data\/positions"/);
 assert.match(html,/href="\/admin\/data\/people"/);
 assert.doesNotMatch(render('/admin/accounts'),/aria-label="基础数据导航"/);
});
