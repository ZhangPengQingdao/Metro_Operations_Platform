import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { CORE_OBSERVABILITY_MIGRATIONS } from '../src/core/observability/index.ts';
import { PLATFORM_AUTHORIZATION_MIGRATIONS, type AuthorizationDecision } from '../src/platform/authorization/index.ts';
import type { PlatformActorContext, PlatformExecution } from '../src/platform/context/index.ts';
import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS } from '../src/platform/people/index.ts';
import {
  BUSINESS_AUDIT_PERMISSION_CODES,
  PLATFORM_BUSINESS_AUDIT_MIGRATIONS,
  PLATFORM_BUSINESS_AUDIT_SQL,
  BusinessAuditError,
  createBusinessAuditService,
  createMemoryBusinessAuditRepository,
  createPostgresBusinessAuditRepository,
  reconcileExistingBusinessAuditEvidence,
  type BusinessAuditRepository,
  type RecordBusinessOperationInput
} from '../src/platform/audit/index.ts';

const IDS = {
  company: '4f000000-0000-4000-8000-000000000001',
  workgroup: '4f000000-0000-4000-8000-000000000002',
  position: '4f000000-0000-4000-8000-000000000003',
  actor: '4f000000-0000-4000-8000-000000000011',
  owner: '4f000000-0000-4000-8000-000000000012',
  outsider: '4f000000-0000-4000-8000-000000000013'
} as const;

const NOW = '2026-09-01T03:00:00.000Z';
const ALL_PERMISSIONS = new Set(Object.values(BUSINESS_AUDIT_PERMISSION_CODES));
const NO_PERMISSIONS = new Set<string>();
const organizations = new Map([
  [IDS.company, { status: 'active' }],
  [IDS.workgroup, { status: 'active' }]
]);
const people = new Map([
  [IDS.actor, { employmentStatus: 'active', organizationUnitId: IDS.workgroup, employeeNo: '06010001', name: '操作人' }],
  [IDS.owner, { employmentStatus: 'active', organizationUnitId: IDS.workgroup, employeeNo: '06010002', name: '负责人' }],
  [IDS.outsider, { employmentStatus: 'active', organizationUnitId: IDS.company, employeeNo: '06010003', name: '外部人员' }]
]);

function harness(repository: BusinessAuditRepository = createMemoryBusinessAuditRepository()) {
  let sequence = 100;
  const service = createBusinessAuditService(repository, {
    clock: () => new Date(NOW),
    createId: () => `4f100000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    findPerson: async (id) => people.get(id) ?? null,
    findOrganizationUnit: async (id) => organizations.get(id) ?? null
  });
  return {
    repository,
    service,
    actor(personId = IDS.actor, allowed = ALL_PERMISSIONS, execution: Exclude<PlatformExecution, { type: 'service' }> = { type: 'platform' }) {
      return personContext(personId, allowed, execution);
    },
    serviceActor(allowed = ALL_PERMISSIONS) {
      return serviceContext(allowed);
    }
  };
}

function personContext(
  personId: string,
  allowed: Set<string>,
  execution: Exclude<PlatformExecution, { type: 'service' }>
): PlatformActorContext {
  const person = people.get(personId);
  assert.ok(person);
  return {
    actorType: 'person',
    trustedIdentity: { source: 'session', userId: personId },
    person: {
      id: personId,
      employeeNo: person.employeeNo,
      name: person.name,
      avatarUrl: null,
      organization: { id: person.organizationUnitId, code: 'afc-team', name: 'AFC检修工班', unitType: 'workgroup' },
      position: { id: IDS.position, code: 'maintainer', name: '检修工' }
    },
    execution,
    request: { requestId: 'request-trusted-1', traceId: 'trace-trusted-1', startedAt: NOW },
    authorize: decision(allowed, 'person')
  };
}

function serviceContext(allowed: Set<string>): PlatformActorContext {
  return {
    actorType: 'service',
    trustedIdentity: { source: 'service' },
    execution: { type: 'service', appId: 'fault_management', serviceIdentityId: 'fault-sync-service' },
    request: { requestId: 'request-service-1', traceId: 'trace-service-1', startedAt: NOW },
    authorize: decision(allowed, 'service')
  };
}

function decision(allowed: Set<string>, subjectType: 'person' | 'service') {
  return async (permissionCode: string): Promise<AuthorizationDecision> => {
    const granted = allowed.has(permissionCode);
    return {
      id: `decision-${permissionCode}`,
      allowed: granted,
      reasonCode: granted ? 'allowed' : 'permission_not_granted',
      permissionCode,
      subjectType,
      effectiveScopes: [],
      decidedAt: NOW
    };
  };
}

function input(overrides: Partial<RecordBusinessOperationInput> = {}): RecordBusinessOperationInput {
  return {
    auditKey: 'fault-1:reported',
    operationCode: 'fault.reported',
    outcome: 'succeeded',
    business: {
      appId: 'fault_management',
      entityType: 'fault',
      entityId: 'fault-1',
      displayLabel: '青岛站闸机故障',
      ownerPersonId: IDS.owner,
      ownerOrganizationUnitId: IDS.workgroup
    },
    changedFields: ['status', 'description'],
    before: { status: 'draft', password: 'secret' },
    after: {
      status: 'reported',
      attachmentUrl: '/api/files/public/photos/a.jpg?sig=secret',
      nested: { authorization: 'Bearer secret' }
    },
    resultSummary: { status: 'reported' },
    ...overrides
  };
}

function auditCode(code: string) {
  return (error: unknown) => error instanceof BusinessAuditError && error.code === code;
}

test('Business Audit derives trusted context, redacts summaries and resolves idempotent retries', async () => {
  const h = harness();
  const first = await h.service.recordBusinessOperation(h.actor(), input());
  const second = await h.service.recordBusinessOperation(h.actor(), input({ changedFields: ['description', 'status'] }));
  assert.equal(second.id, first.id);
  assert.equal(first.actor.personId, IDS.actor);
  assert.equal(first.actor.personSnapshot?.name, '操作人');
  assert.equal(first.source.identitySource, 'session');
  assert.equal(first.source.executionType, 'platform');
  assert.equal(first.source.requestId, 'request-trusted-1');
  assert.equal(first.source.traceId, 'trace-trusted-1');
  assert.equal(first.change?.before?.password, '[REDACTED]');
  assert.equal(first.change?.after?.attachmentUrl, '[REDACTED]');
  assert.equal((first.change?.after?.nested as Record<string, unknown>).authorization, '[REDACTED]');
  assert.equal(JSON.stringify(first).includes('secret'), false);
  await assert.rejects(
    h.service.recordBusinessOperation(h.actor(), input({ resultSummary: { status: 'different' } })),
    auditCode('AUDIT_KEY_CONFLICT')
  );
});

test('Recording and reading require permissions and execution source cannot be forged', async () => {
  const h = harness();
  await assert.rejects(h.service.recordBusinessOperation(h.actor(IDS.actor, NO_PERMISSIONS), input({
    business: { ...input().business, ownerPersonId: '4f000000-0000-4000-8000-000000000099' }
  })), auditCode('BUSINESS_AUDIT_PERMISSION_DENIED'));
  await assert.rejects(
    h.service.recordBusinessOperation(h.actor(IDS.actor, ALL_PERMISSIONS, { type: 'application', appId: 'other_app' }), input()),
    auditCode('SOURCE_APP_MISMATCH')
  );
  const record = await h.service.recordBusinessOperation(h.actor(), input());
  await assert.rejects(h.service.getBusinessOperation(h.actor(IDS.outsider, NO_PERMISSIONS), record.id), auditCode('BUSINESS_AUDIT_PERMISSION_DENIED'));
  assert.equal((await h.service.getBusinessOperation(h.actor(IDS.outsider), record.id)).id, record.id);
  assert.deepEqual((await h.service.listBusinessOperations(h.actor(), { entityType: 'fault', traceId: 'trace-trusted-1' })).map((item) => item.id), [record.id]);
});

test('Concurrent idempotent retries resolve the same append-only record', async () => {
  const memory = createMemoryBusinessAuditRepository();
  const originalFind = memory.findByAuditKey.bind(memory);
  let emptyLookups = 0;
  let releaseLookups!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookups = resolve; });
  const repository: BusinessAuditRepository = {
    ...memory,
    async findByAuditKey(businessAppId, auditKey) {
      const existing = await originalFind(businessAppId, auditKey);
      if (existing) return existing;
      emptyLookups += 1;
      if (emptyLookups === 2) releaseLookups();
      await lookupGate;
      return null;
    }
  };
  const h = harness(repository);
  const [first, second] = await Promise.all([
    h.service.recordBusinessOperation(h.actor(), input()),
    h.service.recordBusinessOperation(h.actor(), input())
  ]);
  assert.equal(first.id, second.id);
  assert.equal(memory.records().length, 1);
});

test('Succeeded, denied and failed records enforce result and change consistency', async () => {
  const h = harness();
  await assert.rejects(h.service.recordBusinessOperation(h.actor(), input({ errorCode: 'SHOULD_NOT_EXIST' })), auditCode('SUCCESS_ERROR_CONFLICT'));
  await assert.rejects(h.service.recordBusinessOperation(h.actor(), input({ outcome: 'denied', errorCode: 'FORBIDDEN' })), auditCode('NON_SUCCESS_CHANGE_CONFLICT'));
  await assert.rejects(h.service.recordBusinessOperation(h.actor(), input({
    outcome: 'denied', changedFields: [], before: null, after: null, resultSummary: { allowed: false }, errorCode: 'FORBIDDEN'
  })), auditCode('DENIED_RESULT_CONFLICT'));
  const denied = await h.service.recordBusinessOperation(h.actor(), input({
    auditKey: 'fault-1:denied', outcome: 'denied', changedFields: [], before: null, after: null,
    resultSummary: null, errorCode: 'FORBIDDEN', reason: null
  }));
  assert.equal(denied.operation.outcome, 'denied');
  assert.equal(denied.change, null);
  const failed = await h.service.recordBusinessOperation(h.actor(), input({
    auditKey: 'fault-1:failed', outcome: 'failed', changedFields: [], before: null, after: null,
    resultSummary: { requestBody: 'hidden', safe: 'provider unavailable' }, errorCode: 'PROVIDER_DOWN',
    reason: { text: 'token=raw-secret' }
  }));
  assert.equal(failed.resultSummary?.requestBody, '[REDACTED]');
  assert.equal(failed.reason?.text, '[REDACTED]');
});

test('Service actors are derived from trusted service context and binary summaries are rejected', async () => {
  const h = harness();
  const serviceRecord = await h.service.recordBusinessOperation(h.serviceActor(), input({ auditKey: 'fault-1:service' }));
  assert.equal(serviceRecord.actor.type, 'service');
  assert.equal(serviceRecord.actor.serviceIdentityId, 'fault-sync-service');
  assert.equal(serviceRecord.source.executionAppId, 'fault_management');
  assert.equal(serviceRecord.source.identitySource, 'service');
  await assert.rejects(
    h.service.recordBusinessOperation(h.actor(), input({ auditKey: 'fault-1:binary', before: { bytes: Buffer.from('secret') } })),
    auditCode('BINARY_AUDIT_SUMMARY_DENIED')
  );
  assert.equal('update' in h.repository, false);
  assert.equal('delete' in h.repository, false);
});

test('Business Audit migration runs twice and PostgreSQL repository remains append-only', async () => {
  const database = new PGlite();
  const client = {
    query(text: string, values?: readonly unknown[]) {
      if (!values && text.includes(';')) return database.exec(text);
      return database.query(text, values ? [...values] : undefined);
    }
  };
  try {
    for (const migration of CORE_OBSERVABILITY_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_AUTHORIZATION_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_BUSINESS_AUDIT_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_BUSINESS_AUDIT_MIGRATIONS) await migration.run({ client });
    await seedDirectory(client);
    const h = harness(createPostgresBusinessAuditRepository(client));
    const record = await h.service.recordBusinessOperation(h.actor(), input());
    assert.equal((await h.repository.findByAuditKey('fault_management', 'fault-1:reported'))?.id, record.id);
    assert.equal((await h.service.listBusinessOperations(h.actor(), { outcome: 'succeeded', ownerOrganizationUnitId: IDS.workgroup })).length, 1);
    const permissionCount = await client.query("SELECT COUNT(*)::text AS count FROM platform_permissions WHERE code LIKE 'platform.audit.%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(permissionCount.rows[0]?.count), 2);
    assert.doesNotMatch(PLATFORM_BUSINESS_AUDIT_SQL, /(?:UPDATE|DELETE)\s+platform_business_audit_records/i);
  } finally {
    await database.close();
  }
});

test('Existing audit reconciliation reports coverage, unsafe keys and incomplete mappings without mutation', () => {
  const snapshot = {
    workItemHistory: [{
      sourceId: 'work-1', operation: 'completed', outcome: 'succeeded', actorPersonId: IDS.actor,
      sourceAppId: 'online_todo', entityType: 'work_item', entityId: 'work-1', requestId: 'req-1',
      traceId: 'trace-1', before: { status: 'in_progress' }, after: { status: 'completed' }, occurredAt: NOW
    }],
    notificationHistory: [{
      sourceId: 'notification-1', operation: 'read', outcome: null, actorPersonId: IDS.actor,
      sourceAppId: 'message_center', entityType: 'notification', entityId: 'notification-1', occurredAt: NOW
    }],
    signatureHistory: [],
    attachmentHistory: [{
      sourceId: 'attachment-1', operation: 'removed', outcome: 'succeeded', actorPersonId: IDS.actor,
      sourceAppId: 'files', entityType: 'attachment', entityId: 'attachment-1', requestId: 'req-2',
      traceId: 'trace-2', before: { signedUrl: '/api/files/public/a?sig=secret' }, occurredAt: NOW
    }],
    deviceResolutionAudits: [{ sourceId: 'device-1', operation: null, outcome: 'unknown', occurredAt: 'invalid' }]
  } as const;
  const before = structuredClone(snapshot);
  const result = reconcileExistingBusinessAuditEvidence(snapshot);
  assert.deepEqual(snapshot, before);
  assert.equal(result.totalCount, 4);
  assert.equal(result.sourceCounts.work_item_history, 1);
  assert.equal(result.coverage.trace, 2);
  assert.equal(result.mappableCount, 1);
  assert.equal(result.issues.some((issue) => issue.code === 'UNSAFE_PAYLOAD_KEY' && issue.key === 'signedUrl'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'MISSING_OUTCOME'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'INVALID_OCCURRED_AT'), true);
});

async function seedDirectory(client: { query(text: string, values?: readonly unknown[]): Promise<unknown> }) {
  await client.query(
    `INSERT INTO platform_organization_units (id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at)
     VALUES ($1,NULL,'company','运营公司',NULL,'company','active',1,$3,$3),
            ($2,$1,'afc-team','AFC检修工班',NULL,'workgroup','active',2,$3,$3)`,
    [IDS.company, IDS.workgroup, NOW]
  );
  await client.query(
    `INSERT INTO platform_positions (id,code,name,description,status,created_at,updated_at)
     VALUES ($1,'maintainer','检修工',NULL,'active',$2,$2)`,
    [IDS.position, NOW]
  );
  await client.query(
    `INSERT INTO platform_people (id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at)
     VALUES ($1,'06010001','操作人',NULL,$4,$5,'active',NULL,$6,$6),
            ($2,'06010002','负责人',NULL,$4,$5,'active',NULL,$6,$6),
            ($3,'06010003','外部人员',NULL,$7,$5,'active',NULL,$6,$6)`,
    [IDS.actor, IDS.owner, IDS.outsider, IDS.workgroup, IDS.position, NOW, IDS.company]
  );
}
