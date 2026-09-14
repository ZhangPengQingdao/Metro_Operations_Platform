import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSignedActorToken,
  createTrustedActorIdentity,
  readActorNameFromHeaders,
  readActorWecomUserIdFromHeaders,
  readHeaderValue,
  stripModelVisibleTrustedIdentityFields
} from '../src/core/identity/index.ts';

test('Core Identity creates trusted actor identity without authorization fields', () => {
  const identity = createTrustedActorIdentity({
    id: ' user-1 ',
    name: ' 张三 ',
    employeeId: ' 1001 ',
    wecomUserId: ' 5359 '
  }, 'wecom');

  assert.deepEqual(identity, {
    source: 'wecom',
    userId: 'user-1',
    name: '张三',
    employeeId: '1001',
    wecomUserId: '5359'
  });
  assert.equal('role' in identity, false);
  assert.equal('workgroupId' in identity, false);
  assert.equal('isAdmin' in identity, false);
});

test('Core Identity reads trusted actor headers from plain and base64 forms', () => {
  const encodedName = Buffer.from(' 李四 ', 'utf8').toString('base64');

  assert.equal(readHeaderValue({ 'x-internal-api-token': ['token-a', 'token-b'] }, 'x-internal-api-token'), 'token-a');
  assert.equal(readActorNameFromHeaders({ 'x-actor-name-b64': encodedName }), '李四');
  assert.equal(readActorNameFromHeaders({ 'x-actor-name': ' 王五 ', 'x-actor-name-b64': encodedName }), '王五');
  assert.equal(readActorNameFromHeaders({ 'x-actor-name-b64': '@@@' }), undefined);
  assert.equal(readActorWecomUserIdFromHeaders({ 'x-actor-wecom-userid': ' 5359 ' }), '5359');
});

test('Core Identity strips model-visible trusted identity fields from MCP tool args', () => {
  assert.deepEqual(
    stripModelVisibleTrustedIdentityFields({
      actor_token: 'forged',
      actor_wecom_userid: '9999',
      actor_name: '冒充者',
      role: '管理员',
      workgroup_id: 'other-group',
      status: 'all',
      item_query: '周巡'
    }),
    {
      status: 'all',
      item_query: '周巡'
    }
  );
});

test('Core Identity signs short-lived actor tokens with trimmed identity payloads', () => {
  const token = createSignedActorToken(
    { actor_wecom_userid: ' 5359 ', actor_name: ' ' },
    'actor-secret',
    { now: new Date('2026-07-01T00:00:00.000Z'), expiresInSeconds: 300 }
  );
  const [encodedPayload, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

  assert.equal(signature.length > 20, true);
  assert.equal(payload.actor_wecom_userid, '5359');
  assert.equal(payload.actor_name, undefined);
  assert.equal(payload.exp - payload.iat, 300);
});
