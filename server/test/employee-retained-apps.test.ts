import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberApp} from '../../src/app-platform/employee/retained-apps.ts';

const app=(accountId:string,appId:string,path=`/employee/app/${appId}`)=>({accountId,appId,path,prefetch:false});

test('keeps two recent applications and restores each last route',()=>{
 let entries=rememberApp([],app('employee-1','materials'));
 entries=rememberApp(entries,app('employee-1','shifts','/employee/app/shifts/meeting'));
 assert.deepEqual(entries.map(item=>item.appId),['materials','shifts']);
 entries=rememberApp(entries,app('employee-1','materials','/employee/app/materials/records'));
 assert.deepEqual(entries.map(item=>[item.appId,item.path]),[
  ['shifts','/employee/app/shifts/meeting'],['materials','/employee/app/materials/records'],
 ]);
 entries=rememberApp(entries,app('employee-1','third'));
 assert.deepEqual(entries.map(item=>item.appId),['materials','third']);
});

test('does not retain another employee account',()=>{
 const previous=[app('employee-1','materials'),app('employee-1','shifts')];
 assert.deepEqual(rememberApp(previous,app('employee-2','materials')),[app('employee-2','materials')]);
});
