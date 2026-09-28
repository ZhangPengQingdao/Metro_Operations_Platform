import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNotificationGatewayOperations} from '../src/app-platform/gateway/notifications.ts';
import type {ConnectablePool,QueryableClient} from '../src/core/database/index.ts';

const pool={} as ConnectablePool&QueryableClient;
const [create,cancel]=createNotificationGatewayOperations(pool);
const person=randomUUID(),entityId=randomUUID(),id=randomUUID();
const bound={actorType:'service',execution:{type:'service',appId:'signatures'},employeeActor:{execution:{type:'application',appId:'signatures'}}} as any;

test('notification gateway exposes only bounded person reminders and app-owned cancellation',async()=>{
 assert.equal(create.name,'platform.notifications.create');
 assert.equal(create.permissionCode,'platform.notifications.create');
 assert.equal(create.validateParams({id,entityId,personId:person,title:'待签字',body:'请签字'}),true);
 assert.equal(create.validateParams({id,entityId,personId:person,title:'待签字',body:'请签字',route:'https://example.com'}),false);
 assert.equal(cancel.validateParams({id}),true);
 assert.equal(cancel.validateParams({id,personId:person}),false);
 assert.deepEqual(await create.resolveResources(bound,{id,entityId,personId:person,title:'待签字',body:'请签字'}),[{}]);
 await assert.rejects(create.resolveResources({...bound,employeeActor:{execution:{type:'application',appId:'other'}}} as any,{id,entityId,personId:person,title:'待签字',body:'请签字'}),/ACCESS_DENIED/);
});
