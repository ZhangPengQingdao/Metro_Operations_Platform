import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppServerContext} from '@metro/platform-sdk/server';
import server from '../src/server.js';

const org = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
function context(grants) {
  const calls = [];
  const employee = {version: '1.0', personId: person, organizationUnitId: org, requestId: 'r1', traceId: 't1',
    businessAuthorization: {revision: '33333333-3333-4333-8333-333333333333', organizations: [], grants}};
  const gateway = {invoke: async (operation, params) => {
    calls.push({operation, params});
    return operation === 'platform.app_data.transaction' ? {results: params.operations.map(op => ({row: {id: op.id, ...op.values}}))} : {rows: []};
  }};
  return {calls, ctx: createAppServerContext({appId: '__APP_ID__', gateway, employee, signal: new AbortController().signal})};
}
const grant = permission => ({permission: `app.__APP_ID__.${permission}`, all: false, self: true, organizationIds: []});

test('create writes one record in a transaction', async () => {
  const {calls, ctx} = context([grant('create')]);
  await server.handlers.create({requestId: '44444444-4444-4444-8444-444444444444', title: '第一条'}, ctx);
  assert.equal(calls[0].operation, 'platform.app_data.transaction');
  assert.equal(calls[0].params.operations[0].values.title, '第一条');
});

test('create is denied without the create permission', async () => {
  const {ctx} = context([grant('read')]);
  await assert.rejects(server.handlers.create({requestId: '44444444-4444-4444-8444-444444444444', title: '第一条'}, ctx), {code: 'ACCESS_DENIED'});
});
