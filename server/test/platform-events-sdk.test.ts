import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PLATFORM_CAPABILITY_CATALOG,
  PLATFORM_EVENT_CATALOG,
  PlatformEventContractError,
  assertPlatformEventEnvelope,
  getPlatformCapability,
  getPlatformEventDescriptor
} from '../../packages/platform-sdk/src/index.ts';
import { WORK_ITEM_EVENT_TYPES, WORK_ITEM_PERMISSION_CODES } from '../src/platform/work-items/index.ts';
import { NOTIFICATION_EVENT_TYPES, NOTIFICATION_PERMISSION_CODES } from '../src/platform/notifications/index.ts';
import { SIGNATURE_EVENT_TYPES, SIGNATURE_PERMISSION_CODES } from '../src/platform/signatures/index.ts';
import { ATTACHMENT_PERMISSION_CODES } from '../src/platform/attachments/index.ts';
import { BUSINESS_AUDIT_PERMISSION_CODES } from '../src/platform/audit/index.ts';
import { DUTY_PERMISSION_CODES } from '../src/platform/duty/index.ts';
import { DATA_ALIGNMENT_PERMISSION_CODES } from '../src/platform/data-alignment/index.ts';
import { PLATFORM_MCP_CONTRACT_VERSION, PLATFORM_MCP_PERMISSION_CODES } from '../src/platform/mcp/index.ts';
import { AUTHORIZATION_PERMISSION_SEEDS } from '../src/platform/authorization/index.ts';
import { PlatformActorProvider, type PlatformActorSnapshot } from '../../src/platform/context/index.tsx';
import { PermissionGuard, ReferencePicker, WorkItemLink } from '../../src/platform/ui/index.ts';

const actor: PlatformActorSnapshot = {
  actorType: 'person', source: 'session', execution: { type: 'platform' },
  person: { id: 'person-1', employeeNo: '001', name: '张三', avatarUrl: null, organization: { id: 'org-1', code: 'team', name: '检修工班', unitType: 'workgroup' }, position: { id: 'position-1', code: 'maintainer', name: '检修工' } },
  capabilities: ['platform.work_items.read']
};

test('Platform event catalog is unique, versioned, source-bound, and honest about availability', () => {
  assert.equal(new Set(PLATFORM_EVENT_CATALOG.map((item) => item.type)).size, PLATFORM_EVENT_CATALOG.length);
  for (const item of PLATFORM_EVENT_CATALOG) {
    assert.match(item.type, /^platform\.[a-z0-9.-]+\.v1$/);
    assert.equal(item.version, 1);
    assert.match(item.source, /^platform\/[a-z0-9-]+$/);
    assert.ok(item.requiredPayloadKeys.length > 0);
  }
  const declared = PLATFORM_EVENT_CATALOG.filter((item) => item.availability === 'declared').map((item) => item.semanticName).sort();
  assert.deepEqual(declared, ['AssetChanged','AttachmentAdded','PermissionChanged','PersonOrganizationChanged','ResponsibilityChanged']);
  assert.equal(getPlatformEventDescriptor('platform.notifications.created.v1')?.semanticName, 'NotificationRequested');
});

test('Current emitted server event constants exactly match emitted SDK catalog entries', () => {
  const serverEvents = [...Object.values(WORK_ITEM_EVENT_TYPES), ...Object.values(NOTIFICATION_EVENT_TYPES), ...Object.values(SIGNATURE_EVENT_TYPES)].sort();
  const sdkEvents = PLATFORM_EVENT_CATALOG.filter((item) => item.availability === 'emitted').map((item) => item.type).sort();
  assert.deepEqual(sdkEvents, serverEvents);
});

test('Platform event validator accepts current envelopes and rejects drift or sensitive payloads', () => {
  const descriptor = getPlatformEventDescriptor(WORK_ITEM_EVENT_TYPES.completed)!;
  const payload = Object.fromEntries(descriptor.requiredPayloadKeys.map((key) => [key, key === 'changedFields' ? ['status'] : key === 'actorPersonId' ? null : key === 'actorType' ? 'person' : 'value']));
  const event = { id: 'event-1', type: descriptor.type, source: descriptor.source, occurredAt: '2026-09-01T00:00:00.000Z', payload };
  assert.doesNotThrow(() => assertPlatformEventEnvelope(event));
  assert.throws(() => assertPlatformEventEnvelope({ ...event, source: 'apps/faults' }), (error) => error instanceof PlatformEventContractError && error.code === 'EVENT_SOURCE_MISMATCH');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, payload: { ...payload, actor_token: 'forged' } }), (error) => error instanceof PlatformEventContractError && error.code === 'SENSITIVE_EVENT_PAYLOAD_DENIED');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, actor_token: 'forged' }), (error) => error instanceof PlatformEventContractError && error.code === 'SENSITIVE_EVENT_ENVELOPE_DENIED');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, payload: { ...payload, note: 'Authorization: Bearer secret-value' } }), (error) => error instanceof PlatformEventContractError && error.code === 'SENSITIVE_EVENT_PAYLOAD_DENIED');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, payload: { ...payload, bytes: new Uint8Array([1]) } }), (error) => error instanceof PlatformEventContractError && error.code === 'SENSITIVE_EVENT_PAYLOAD_DENIED');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, occurredAt: '2026-09-01' }), (error) => error instanceof PlatformEventContractError && error.code === 'INVALID_EVENT_INSTANT');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, payload: { ...payload, operation: undefined } }), (error) => error instanceof PlatformEventContractError && error.code === 'EVENT_PAYLOAD_KEY_REQUIRED');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, payload: { ...payload, score: Number.POSITIVE_INFINITY } }), (error) => error instanceof PlatformEventContractError && error.code === 'INVALID_EVENT_PAYLOAD_VALUE');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, payload: { ...payload, changedFields: 'status' } }), (error) => error instanceof PlatformEventContractError && error.code === 'INVALID_EVENT_PAYLOAD_FIELD');
  assert.throws(() => assertPlatformEventEnvelope({ ...event, payload: { ...payload, actorType: 'admin' } }), (error) => error instanceof PlatformEventContractError && error.code === 'INVALID_EVENT_PAYLOAD_FIELD');

  const preference = getPlatformEventDescriptor(NOTIFICATION_EVENT_TYPES.preferenceUpdated)!;
  assert.doesNotThrow(() => assertPlatformEventEnvelope({
    id: 'event-preference', type: preference.type, source: preference.source, occurredAt: '2026-09-01T00:00:00.000Z',
    payload: { preferenceId: 'preference-1', personId: 'person-1', sourceAppId: null, category: null, channel: null, muted: false, actorType: 'person', actorPersonId: 'person-1' }
  }));
});

test('Capability catalog covers all L3 capabilities and preserves current public permission strings', () => {
  assert.equal(PLATFORM_CAPABILITY_CATALOG.length, 16);
  assert.equal(new Set(PLATFORM_CAPABILITY_CATALOG.map((item) => item.id)).size, 16);
  assert.deepEqual(getPlatformCapability('work-items')?.permissions, Object.values(WORK_ITEM_PERMISSION_CODES));
  assert.deepEqual(getPlatformCapability('authorization')?.permissions, AUTHORIZATION_PERMISSION_SEEDS.map((item) => item.code));
  assert.deepEqual(getPlatformCapability('notifications')?.permissions, Object.values(NOTIFICATION_PERMISSION_CODES));
  assert.deepEqual(getPlatformCapability('signatures')?.permissions, Object.values(SIGNATURE_PERMISSION_CODES));
  assert.deepEqual(getPlatformCapability('attachments')?.permissions, Object.values(ATTACHMENT_PERMISSION_CODES));
  assert.deepEqual(getPlatformCapability('business-audit')?.permissions, Object.values(BUSINESS_AUDIT_PERMISSION_CODES));
  assert.deepEqual(getPlatformCapability('duty')?.permissions, Object.values(DUTY_PERMISSION_CODES));
  assert.deepEqual(getPlatformCapability('data-alignment')?.permissions, Object.values(DATA_ALIGNMENT_PERMISSION_CODES));
  assert.deepEqual(getPlatformCapability('platform-mcp')?.permissions, Object.values(PLATFORM_MCP_PERMISSION_CODES));
  for (const capability of PLATFORM_CAPABILITY_CATALOG) {
    assert.equal(capability.contractVersion, capability.id === 'platform-mcp' ? PLATFORM_MCP_CONTRACT_VERSION : '1.0');
    assert.equal(capability.availability, 'available');
    assert.equal(capability.backendEntrypoint?.includes('/repository') ?? false, false);
  }
  for (const descriptor of PLATFORM_EVENT_CATALOG) assert.equal(getPlatformCapability(descriptor.ownerCapabilityId)?.events.includes(descriptor.type), true, descriptor.type);
});

test('ReferencePicker, PermissionGuard and WorkItemLink render accessible caller-data UI', () => {
  const picker = renderToStaticMarkup(createElement(ReferencePicker, {
    id: 'person-picker', label: '办理人', value: null, onChange: () => undefined,
    options: [{ kind: 'person', id: 'person-1', code: '001', label: '张三' }]
  }));
  assert.match(picker, /<label[^>]+for="person-picker"/);
  assert.match(picker, /<select[^>]+id="person-picker"/);
  assert.match(picker, /张三 \(001\)/);
  assert.match(picker, /value="person:person-1"/);
  const empty = renderToStaticMarkup(createElement(ReferencePicker, { id: 'empty-picker', label: '位置', value: null, onChange: () => undefined, options: [] }));
  assert.match(empty, /disabled=""/);
  assert.match(empty, /暂无可选项/);

  const allowed = renderToStaticMarkup(createElement(PlatformActorProvider, { actor }, createElement(PermissionGuard, { permission: 'platform.work_items.read', fallback: 'DENIED' }, 'ALLOWED')));
  const denied = renderToStaticMarkup(createElement(PlatformActorProvider, { actor }, createElement(PermissionGuard, { permission: 'platform.work_items.manage', fallback: 'DENIED' }, 'ALLOWED')));
  assert.equal(allowed, 'ALLOWED');
  assert.equal(denied, 'DENIED');

  const link = renderToStaticMarkup(createElement(WorkItemLink, { workItem: { kind: 'work_item', id: 'work-1', label: '检修任务' }, href: '/work-items/work-1' }));
  assert.match(link, /href="\/work-items\/work-1"/);
  assert.match(link, /data-work-item-id="work-1"/);
  assert.throws(() => renderToStaticMarkup(createElement(WorkItemLink, { workItem: { kind: 'work_item', id: 'work-1' }, href: 'javascript:alert(1)' })), /platform-relative absolute path/);
  assert.throws(() => renderToStaticMarkup(createElement(WorkItemLink, { workItem: { kind: 'work_item', id: 'work-1' }, href: '/\\evil.example/path' })), /platform-relative absolute path/);
});

test('Platform SDK and UI public sources contain no runtime, database, app, API, or legacy-auth coupling', async () => {
  const sources = await Promise.all([
    readFile(new URL('../../packages/platform-sdk/src/events.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../packages/platform-sdk/src/capabilities.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/platform/ui/ReferencePicker.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/platform/ui/PermissionGuard.tsx', import.meta.url), 'utf8')
  ]);
  const source = sources.join('\n');
  assert.doesNotMatch(source, /from ['"].*(?:server\/src|\/apps\/)|getPool|fetch\(|axios|AuthContext|usePermissions|actor_token|actor_wecom_userid|CoreEventBus|core_outbox|enqueueCoreEvent/);
});
