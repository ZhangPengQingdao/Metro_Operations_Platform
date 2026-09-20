import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationStatus} from '../../src/app-platform/admin/application-status.ts';
import type {Installation} from '../../src/app-platform/admin/AdminApp.tsx';
test('application status distinguishes stopped, pending calls and interrupted lifecycle',()=>{
 const app={enabled:false} as Installation;
 assert.equal(applicationStatus(app,false),'已停用');
 assert.equal(applicationStatus(app,false,true),'调用结果待核对');
 assert.equal(applicationStatus({...app,lifecycle:{action:'enable',status:'failed'}},false),'启动结果待核对');
 assert.equal(applicationStatus({...app,lifecycle:{action:'upgrade',status:'running'}},false),'更新结果待核对');
 assert.equal(applicationStatus({...app,enabled:true},false),'运行中断，待核对');
 assert.equal(applicationStatus({...app,enabled:true},true),'正在运行');
 assert.equal(applicationStatus({...app,lifecycle:{action:'disable',status:'cancelled'}},false),'已停用');
});
