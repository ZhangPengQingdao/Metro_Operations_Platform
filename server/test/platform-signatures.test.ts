import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { CORE_EVENTS_MIGRATIONS, createMemoryCoreOutboxRepository, createPostgresCoreOutboxRepository, type CoreEventPayload, type CoreOutboxRecord, type CoreOutboxRepository, type EnqueueCoreOutboxEventInput } from '../src/core/events/index.ts';
import { PLATFORM_AUTHORIZATION_MIGRATIONS, type AuthorizationDecision } from '../src/platform/authorization/index.ts';
import type { PlatformActorContext, PlatformExecution } from '../src/platform/context/index.ts';
import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS } from '../src/platform/people/index.ts';
import {
  PLATFORM_SIGNATURE_MIGRATIONS,
  PLATFORM_SIGNATURE_SQL,
  SIGNATURE_EVENT_TYPES,
  SIGNATURE_PERMISSION_CODES,
  SignatureError,
  createMemorySignatureRepository,
  createPostgresSignatureRepository,
  createSignatureService,
  reconcileLegacySignatures,
  type CreateSignatureRequestInput,
  type SignatureRepository
} from '../src/platform/signatures/index.ts';

const IDS = {
  company: '4b000000-0000-4000-8000-000000000001',
  workgroup: '4b000000-0000-4000-8000-000000000002',
  position: '4b000000-0000-4000-8000-000000000003',
  creator: '4b000000-0000-4000-8000-000000000011',
  signerA: '4b000000-0000-4000-8000-000000000012',
  signerB: '4b000000-0000-4000-8000-000000000013',
  outsider: '4b000000-0000-4000-8000-000000000014'
} as const;

const NOW = '2026-08-31T15:00:00.000Z';
const SOURCE = { appId: 'online_signature', entityType: 'document', entityId: 'document-1' };
const ALL_PERMISSIONS = new Set(Object.values(SIGNATURE_PERMISSION_CODES));
const NO_PERMISSIONS = new Set<string>();
const SIGN_ON_BEHALF = new Set([SIGNATURE_PERMISSION_CODES.signOnBehalf]);

const organizations = new Map<string, { status: string; name: string }>([
  [IDS.company, { status: 'active', name: '运营公司' }],
  [IDS.workgroup, { status: 'active', name: 'AFC检修工班' }]
]);

const people = new Map<string, { organizationUnitId: string; employmentStatus: string; employeeNo: string; name: string }>([
  [IDS.creator, { organizationUnitId: IDS.company, employmentStatus: 'active', employeeNo: '06010001', name: '创建人' }],
  [IDS.signerA, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06010002', name: '签字人甲' }],
  [IDS.signerB, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06010003', name: '签字人乙' }],
  [IDS.outsider, { organizationUnitId: IDS.company, employmentStatus: 'active', employeeNo: '06010004', name: '外部人员' }]
]);

function memoryHarness() {
  return harness(createMemorySignatureRepository(), createMemoryCoreOutboxRepository());
}

function harness<T extends CoreOutboxRepository | undefined>(
  repository: SignatureRepository,
  outbox: T
) {
  let now = new Date(NOW);
  let idSequence = 100;
  let eventSequence = 900;
  let tokenSequence = 1;
  const service = createSignatureService(repository, {
    clock: () => new Date(now),
    createId: () => `4b100000-0000-4000-8000-${String(idSequence++).padStart(12, '0')}`,
    createEventId: () => `4b200000-0000-4000-8000-${String(eventSequence++).padStart(12, '0')}`,
    createPublicToken: () => `signature-public-token-${String(tokenSequence++).padStart(12, '0')}`,
    outbox,
    findPerson: async (id) => people.get(id) ?? null,
    findOrganizationUnit: async (id) => organizations.get(id) ?? null
  });
  return {
    repository,
    outbox,
    service,
    actor(personId: string = IDS.creator, allowed: Set<string> = ALL_PERMISSIONS, execution: Exclude<PlatformExecution, { type: 'service' }> = { type: 'platform' }) {
      return personContext(personId, allowed, execution, () => now);
    },
    setNow(value: string) {
      now = new Date(value);
    }
  };
}

function personContext(
  personId: string,
  allowed: Set<string>,
  execution: Exclude<PlatformExecution, { type: 'service' }>,
  clock: () => Date
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
      organization: {
        id: person.organizationUnitId,
        code: person.organizationUnitId === IDS.workgroup ? 'afc-team' : 'company',
        name: person.organizationUnitId === IDS.workgroup ? 'AFC检修工班' : '运营公司',
        unitType: person.organizationUnitId === IDS.workgroup ? 'workgroup' : 'company'
      },
      position: { id: IDS.position, code: 'afc-maintainer', name: 'AFC检修工' }
    },
    execution,
    request: { requestId: `req-${personId}`, traceId: `trace-${personId}`, startedAt: clock().toISOString() },
    authorize: async (permissionCode: string): Promise<AuthorizationDecision> => {
      const allowedDecision = allowed.has(permissionCode);
      return {
        id: `decision-${permissionCode}`,
        allowed: allowedDecision,
        reasonCode: allowedDecision ? 'allowed' : 'permission_not_granted',
        permissionCode,
        subjectType: 'person',
        effectiveScopes: [],
        decidedAt: clock().toISOString()
      };
    }
  };
}

function signatureCode(code: string) {
  return (error: unknown) => error instanceof SignatureError && error.code === code;
}

function createInput(overrides: Partial<CreateSignatureRequestInput> = {}): CreateSignatureRequestInput {
  return {
    source: SOURCE,
    signatureKey: 'document:1',
    idempotencyKey: 'sign-document-1',
    document: {
      title: 'AFC 检修记录',
      description: '签字确认',
      originalFileName: 'maintenance.pdf',
      originalExtension: '.pdf',
      sourceFile: {
        kind: 'digital-signatures',
        fileName: 'maintenance.pdf',
        contentType: 'application/pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024
      }
    },
    signers: [{
      personId: IDS.signerA,
      positions: [{ page: 0, x0: 10, y0: 20, x1: 110, y1: 70, strategy: 'D' }]
    }],
    ...overrides
  };
}

test('Signature creation is idempotent and never stores raw public tokens in events or audit', async () => {
  const h = memoryHarness();
  const first = await h.service.createSignatureRequest(h.actor(), createInput());
  const second = await h.service.createSignatureRequest(h.actor(), createInput());
  const rawToken = first.publicToken;
  assert.ok(rawToken);
  assert.equal(second.request.id, first.request.id);
  assert.equal(second.publicToken, null);
  assert.equal(first.session.publicTokenHash, createHash('sha256').update(rawToken).digest('hex'));
  assert.notEqual(first.session.publicTokenHash, rawToken);

  const detail = await h.service.getSignatureRequest(h.actor(IDS.signerA, NO_PERMISSIONS), first.request.id);
  assert.equal(detail.signers[0]?.personId, IDS.signerA);
  assert.equal(detail.positions.length, 1);
  assert.equal(detail.operationHistory.length, 1);
  assert.equal(JSON.stringify(detail.operationHistory).includes(rawToken), false);
  assert.equal(JSON.stringify(h.outbox?.records()).includes(rawToken), false);
  assert.equal(h.outbox?.records()[0]?.event.type, SIGNATURE_EVENT_TYPES.requestCreated);

  const signer = detail.signers[0];
  assert.ok(signer);
  const mismatchedEvidenceId = '4b300000-0000-4000-8000-000000000001';
  await assert.rejects(
    h.repository.recordSignature({
      id: mismatchedEvidenceId,
      signatureRequestId: IDS.company,
      signerId: signer.id,
      submittedByPersonId: IDS.signerA,
      storageRef: null,
      signatureUrl: '/uploads/digital-signatures/mismatch.png',
      contentType: 'image/png',
      sha256: null,
      sizeBytes: null,
      width: null,
      height: null,
      clientMetadata: {},
      signedAt: NOW,
      createdAt: NOW
    }, { ...signer, status: 'signed', signatureEvidenceId: mismatchedEvidenceId, signedAt: NOW }),
    signatureCode('SIGNATURE_EVIDENCE_MISMATCH')
  );

  await assert.rejects(
    h.service.createSignatureRequest(h.actor(), createInput({ document: { ...createInput().document, title: '修改后的标题' } })),
    signatureCode('SIGNATURE_KEY_CONFLICT')
  );
  await assert.rejects(
    h.service.createSignatureRequest(h.actor(IDS.creator, ALL_PERMISSIONS, { type: 'application', appId: 'faults' }), createInput({ signatureKey: 'document:2' })),
    signatureCode('SOURCE_APP_MISMATCH')
  );
});

test('Signature lists expose only requests readable by the current person', async () => {
  const h = memoryHarness();
  const signerARequest = await h.service.createSignatureRequest(h.actor(), createInput());
  const signerBRequest = await h.service.createSignatureRequest(h.actor(), createInput({
    signatureKey: 'document:signer-b',
    idempotencyKey: 'sign-document-signer-b',
    signers: [{ personId: IDS.signerB, positions: [{ page: 0, x0: 1, y0: 1, x1: 51, y1: 31 }] }]
  }));

  assert.deepEqual((await h.service.listSignatureRequests(h.actor(IDS.signerA, NO_PERMISSIONS))).map((request) => request.id), [signerARequest.request.id]);
  assert.deepEqual((await h.service.listSignatureRequests(h.actor(IDS.signerB, NO_PERMISSIONS))).map((request) => request.id), [signerBRequest.request.id]);
  assert.deepEqual(await h.service.listSignatureRequests(h.actor(IDS.outsider, NO_PERMISSIONS)), []);
});

test('Expected people may sign only themselves and name-only signers require sign-on-behalf permission', async () => {
  const h = memoryHarness();
  const created = await h.service.createSignatureRequest(h.actor(), createInput({
    signers: [
      { personId: IDS.signerA, positions: [{ page: 0, x0: 1, y0: 1, x1: 51, y1: 31 }] },
      { name: '历史签字人', expectedOrganizationUnitId: IDS.workgroup, positions: [{ page: 0, x0: 60, y0: 1, x1: 110, y1: 31 }] }
    ]
  }));
  assert.ok(created.publicToken);
  const detail = await h.service.getSignatureRequest(h.actor(IDS.signerA, NO_PERMISSIONS), created.request.id);
  const ownSigner = detail.signers.find((signer) => signer.personId === IDS.signerA);
  const legacySigner = detail.signers.find((signer) => signer.personId === null);
  assert.ok(ownSigner && legacySigner);
  await assert.rejects(h.service.getSignatureRequest(h.actor(IDS.outsider, NO_PERMISSIONS), created.request.id), signatureCode('SIGNATURE_ACCESS_DENIED'));

  const afterOwn = await h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
    signerId: ownSigner.id,
    publicToken: created.publicToken,
    evidence: { storageRef: { kind: 'digital-signatures', fileName: 'signer-a.png' }, contentType: 'image/png', sha256: 'b'.repeat(64), width: 320, height: 120 }
  });
  assert.equal(afterOwn.request.status, 'dispatched');
  assert.equal(afterOwn.evidence.length, 1);

  await assert.rejects(
    h.service.submitSignature(h.actor(IDS.outsider, NO_PERMISSIONS), {
      signerId: legacySigner.id,
      sessionId: created.session.id,
      evidence: { signatureUrl: '/uploads/digital-signatures/legacy.png' }
    }),
    signatureCode('SIGNATURE_PERMISSION_DENIED')
  );
  const completed = await h.service.submitSignature(h.actor(IDS.outsider, SIGN_ON_BEHALF), {
    signerId: legacySigner.id,
    sessionId: created.session.id,
    evidence: { signatureUrl: '/uploads/digital-signatures/legacy.png', contentType: 'image/png' }
  });
  assert.equal(completed.request.status, 'completed');
  assert.equal(completed.session.status, 'completed');
  assert.equal(completed.evidence.length, 2);
  assert.deepEqual(h.outbox?.records().slice(-2).map((record) => record.event.type), [SIGNATURE_EVENT_TYPES.statusChanged, SIGNATURE_EVENT_TYPES.requestCompleted]);
  await assert.rejects(
    h.service.finalizeSignatureRequest(h.actor(IDS.outsider, NO_PERMISSIONS), { signatureRequestId: created.request.id }),
    signatureCode('SIGNATURE_PERMISSION_DENIED')
  );
});

test('Revoked signers remain in history and do not block completion', async () => {
  const h = memoryHarness();
  const created = await h.service.createSignatureRequest(h.actor(), createInput({
    signatureKey: 'document:revoke',
    idempotencyKey: 'sign-document-revoke',
    signers: [
      { personId: IDS.signerA, positions: [{ page: 0, x0: 1, y0: 1, x1: 51, y1: 31 }] },
      { personId: IDS.signerB, positions: [{ page: 0, x0: 60, y0: 1, x1: 110, y1: 31 }] }
    ]
  }));
  const before = await h.service.getSignatureRequest(h.actor(), created.request.id);
  const signerA = before.signers.find((signer) => signer.personId === IDS.signerA);
  const signerB = before.signers.find((signer) => signer.personId === IDS.signerB);
  assert.ok(created.publicToken && signerA && signerB);
  await h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
    signerId: signerA.id,
    publicToken: created.publicToken,
    evidence: { signatureUrl: '/uploads/digital-signatures/a.png' }
  });
  const completed = await h.service.revokeSigner(h.actor(), { signerId: signerB.id, note: '无需签字' });
  assert.equal(completed.request.status, 'completed');
  assert.equal(completed.signers.find((signer) => signer.id === signerB.id)?.status, 'revoked');
  assert.equal(completed.operationHistory.some((entry) => entry.operation === 'signer_revoked'), true);
  assert.equal(completed.operationHistory.some((entry) => entry.operation === 'completed'), true);
});

test('Cancel and finalize enforce lifecycle and preserve signature records', async () => {
  const h = memoryHarness();
  const created = await h.service.createSignatureRequest(h.actor(), createInput({ signatureKey: 'document:cancel', idempotencyKey: null }));
  const pending = await h.service.getSignatureRequest(h.actor(), created.request.id);
  await assert.rejects(
    h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
      signerId: pending.signers[0].id,
      sessionId: created.session.id,
      evidence: { signatureUrl: '/uploads/digital-signatures/a.png', clientMetadata: { nested: {} as never } }
    }),
    signatureCode('INVALID_CLIENT_METADATA')
  );
  await assert.rejects(
    h.service.finalizeSignatureRequest(h.actor(), { signatureRequestId: created.request.id }),
    signatureCode('SIGNATURE_NOT_READY')
  );
  const cancelled = await h.service.cancelSignatureRequest(h.actor(), { signatureRequestId: created.request.id });
  assert.equal(cancelled.request.status, 'cancelled');
  assert.equal(cancelled.signers.length, 1);
  assert.equal(cancelled.positions.length, 1);
  await assert.rejects(
    h.service.cancelSignatureRequest(h.actor(IDS.outsider, NO_PERMISSIONS), { signatureRequestId: created.request.id }),
    signatureCode('SIGNATURE_PERMISSION_DENIED')
  );
  await assert.rejects(
    h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
      signerId: cancelled.signers[0].id,
      sessionId: created.session.id,
      evidence: { signatureUrl: '/uploads/digital-signatures/a.png' }
    }),
    signatureCode('SIGNATURE_CANCELLED')
  );
  await assert.rejects(h.service.deleteSignatureRequest(), signatureCode('HARD_DELETE_NOT_SUPPORTED'));
});

test('Signature migration runs twice and PostgreSQL repository round-trips the platform records', async () => {
  assert.deepEqual(PLATFORM_SIGNATURE_MIGRATIONS[1].dataRows, []);
  assert.deepEqual(PLATFORM_SIGNATURE_MIGRATIONS[1].migrationRows, ['MIG-043']);
  const database = new PGlite();
  const client = {
    query(text: string, values?: readonly unknown[]) {
      if (!values && text.includes(';')) return database.exec(text);
      return database.query(text, values ? [...values] : undefined);
    }
  };
  try {
    for (const migration of CORE_EVENTS_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_AUTHORIZATION_MIGRATIONS) await migration.run({ client });
    await PLATFORM_SIGNATURE_MIGRATIONS[0].run({ client });
    await PLATFORM_SIGNATURE_MIGRATIONS[0].run({ client });
    const originalPermissionCheck = await client.query("SELECT COUNT(*)::text AS count FROM platform_permissions WHERE code LIKE 'platform.signatures.%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(originalPermissionCheck.rows[0]?.count), 5);
    assert.doesNotMatch(PLATFORM_SIGNATURE_SQL, /'platform\.signatures\.sign'/);
    await PLATFORM_SIGNATURE_MIGRATIONS[1].run({ client });
    await PLATFORM_SIGNATURE_MIGRATIONS[1].run({ client });
    await seedDirectory(client);

    const tableCheck = await client.query("SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name LIKE 'platform_signature%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(tableCheck.rows[0]?.count), 6);
    const h = harness(createPostgresSignatureRepository(client), createPostgresCoreOutboxRepository(client));
    const created = await h.service.createSignatureRequest(h.actor(), createInput({ signatureKey: 'document:postgres', idempotencyKey: 'postgres-1' }));
    const detail = await h.service.getSignatureRequest(h.actor(), created.request.id);
    assert.deepEqual((await h.service.listSignatureRequests(h.actor(IDS.signerA, NO_PERMISSIONS))).map((request) => request.id), [created.request.id]);
    assert.ok(created.publicToken);
    const signed = await h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
      signerId: detail.signers[0].id,
      publicToken: created.publicToken,
      evidence: { storageRef: { kind: 'digital-signatures', fileName: 'postgres.png' }, sha256: 'c'.repeat(64), sizeBytes: 512 }
    });
    assert.equal(signed.request.status, 'completed');
    assert.equal(signed.evidence[0]?.storageRef?.fileName, 'postgres.png');
    assert.equal(signed.operationHistory.map((entry) => entry.operation).join(','), 'created,signed,completed');

    const permissionCheck = await client.query("SELECT COUNT(*)::text AS count FROM platform_permissions WHERE code LIKE 'platform.signatures.%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(permissionCheck.rows[0]?.count), 6);
    const pending = await h.service.createSignatureRequest(h.actor(), createInput({ signatureKey: 'atomic-pg', idempotencyKey: 'atomic-pg' }));
    const pendingDetail = await h.service.getSignatureRequest(h.actor(), pending.request.id);
    const enqueue = h.outbox.enqueue;
    h.outbox.enqueue = async (...args: Parameters<typeof enqueue>) => {
      await enqueue(...args);
      throw new Error('postgres signature event failure');
    };
    await assert.rejects(h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
      signerId: pendingDetail.signers[0].id, sessionId: pending.session.id,
      evidence: { signatureUrl: '/uploads/digital-signatures/rollback-pg.png' }
    }), /postgres signature event failure/);
    h.outbox.enqueue = enqueue;
    assert.deepEqual(await h.service.getSignatureRequest(h.actor(), pending.request.id), pendingDetail);
    const replay = await h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
      signerId: pendingDetail.signers[0].id, sessionId: pending.session.id,
      evidence: { signatureUrl: '/uploads/digital-signatures/retry-pg.png' }
    });
    assert.equal(replay.request.status, 'completed');
  } finally {
    await database.close();
  }
});

test('Legacy reconciliation reports token, position, evidence, completion, and form inconsistencies', () => {
  const result = reconcileLegacySignatures({
    templates: [{ id: 'template-1' }],
    sessions: [
      { id: 'session-1', publicToken: 'legacy-token', status: 'completed' },
      { id: 'session-2', publicToken: '', status: 'unknown' }
    ],
    signers: [
      { id: 'signer-1', sessionId: 'session-1', userId: IDS.signerA, name: '签字人甲', status: 'signed', page: 0, x0: 1, y0: 1, x1: 20, y1: 10, strategy: 'D', signatureUrl: '/signatures/a.png' },
      { id: 'signer-2', sessionId: 'session-1', name: '历史人员', status: 'pending', page: 0, x0: 0, y0: 0, x1: 0, y1: 0 },
      { id: 'signer-3', sessionId: 'missing', name: '孤立人员', status: 'signed', page: 0, x0: 1, y0: 1, x1: 10, y1: 5 }
    ],
    forms: [{ kind: 'training', id: 'form-1', sessionId: 'missing' }]
  });
  assert.equal(result.templateCount, 1);
  assert.equal(result.personSignerCount, 1);
  assert.equal(result.nameOnlySignerCount, 2);
  assert.equal(result.positionedSignerCount, 2);
  assert.equal(result.evidenceReferenceCount, 1);
  assert.deepEqual(result.issues.map((issue) => issue.code), [
    'SIGNER_MISSING_POSITION',
    'SIGNER_WITHOUT_SESSION',
    'SIGNED_WITHOUT_EVIDENCE',
    'COMPLETED_WITH_UNSIGNED_SIGNER',
    'SESSION_MISSING_TOKEN',
    'INVALID_SESSION_STATUS',
    'FORM_WITHOUT_SESSION'
  ]);
});

test('Signature command failure restores evidence, signer, session, request, history and events', async () => {
  const repository = createMemorySignatureRepository();
  const outbox = createMemoryCoreOutboxRepository();
  let fail = false;
  const faulting: CoreOutboxRepository = { ...outbox, async enqueue<TPayload extends CoreEventPayload>(input: EnqueueCoreOutboxEventInput<TPayload>): Promise<CoreOutboxRecord<TPayload>> {
    const saved = await outbox.enqueue(input);
    if (fail) throw new Error('injected signature enqueue failure');
    return saved;
  } };
  const h = harness(repository, faulting);
  fail = true;
  await assert.rejects(h.service.createSignatureRequest(h.actor(), createInput()), /injected signature enqueue failure/);
  assert.equal(Object.values(repository.records()).flat().length, 0);
  assert.equal(outbox.records().length, 0);
  fail = false;
  const created = await h.service.createSignatureRequest(h.actor(), createInput());
  const detail = await h.service.getSignatureRequest(h.actor(), created.request.id);
  const before = repository.records();
  fail = true;
  await assert.rejects(h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
    signerId: detail.signers[0].id, sessionId: created.session.id,
    evidence: { signatureUrl: '/uploads/digital-signatures/failure.png' }
  }), /injected signature enqueue failure/);
  assert.deepEqual(repository.records(), before);
  assert.equal(outbox.records().length, 1);
  fail = false;
  const results = await Promise.allSettled(['first', 'second'].map((name) => h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), {
    signerId: detail.signers[0].id, sessionId: created.session.id,
    evidence: { signatureUrl: `/uploads/digital-signatures/${name}.png` }
  })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const final = await h.service.getSignatureRequest(h.actor(), created.request.id);
  assert.equal(final.request.status, 'completed');
  assert.equal(final.session.status, 'completed');
  assert.equal(final.evidence.length, 1);
  assert.deepEqual(final.operationHistory.map((operation) => operation.operation), ['created', 'signed', 'completed']);
});

test('Signature intrinsic access requires application grants and read-only apps cannot sign', async () => {
  const h = memoryHarness();
  const created = await h.service.createSignatureRequest(h.actor(), createInput());
  const detail = await h.service.getSignatureRequest(h.actor(), created.request.id);
  const signer = h.actor(IDS.signerA, NO_PERMISSIONS, { type: 'application', appId: SOURCE.appId });
  await assert.rejects(h.service.getSignatureRequest(signer, created.request.id), signatureCode('SIGNATURE_ACCESS_DENIED'));
  const readonly = { ...signer, authorizeApplication: (permissionCode: string) => h.actor(IDS.creator, new Set([SIGNATURE_PERMISSION_CODES.read])).authorize(permissionCode) };
  assert.equal((await h.service.getSignatureRequest(readonly, created.request.id)).request.id, created.request.id);
  const input = { signerId: detail.signers[0].id, sessionId: created.session.id, evidence: { signatureUrl: '/uploads/digital-signatures/authorized.png' } };
  await assert.rejects(h.service.submitSignature(readonly, input), signatureCode('SIGNATURE_PERMISSION_DENIED'));
  const signing = { ...signer, authorizeApplication: (permissionCode: string) => h.actor(IDS.creator, new Set([SIGNATURE_PERMISSION_CODES.sign])).authorize(permissionCode) };
  assert.equal((await h.service.submitSignature(signing, input)).request.status, 'completed');
});

test('Signature creation authorizes every signer and cancellation competes atomically with signing', async () => {
  const h = memoryHarness();
  const actor = h.actor();
  const scoped = { ...actor, authorize: async (permissionCode: string, resource?: import('../src/platform/authorization/index.ts').AuthorizationResource) => ({
    ...await actor.authorize(permissionCode, resource), allowed: resource?.ownerPersonId !== IDS.signerB
  }) };
  await assert.rejects(h.service.createSignatureRequest(scoped, createInput({ signers: [{ ...createInput().signers[0], personId: IDS.signerA }, { ...createInput().signers[0], personId: IDS.signerB }] })), signatureCode('SIGNATURE_PERMISSION_DENIED'));
  assert.equal((await h.repository.listRequests()).length, 0);
  const created = await h.service.createSignatureRequest(actor, createInput());
  const detail = await h.service.getSignatureRequest(actor, created.request.id);
  const results = await Promise.allSettled([
    h.service.cancelSignatureRequest(actor, { signatureRequestId: created.request.id }),
    h.service.submitSignature(h.actor(IDS.signerA, NO_PERMISSIONS), { signerId: detail.signers[0].id, sessionId: created.session.id, evidence: { signatureUrl: '/uploads/digital-signatures/race.png' } })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const final = await h.service.getSignatureRequest(actor, created.request.id);
  assert.equal(final.request.status, final.session.status);
  assert.equal(final.request.status, 'cancelled');
  assert.equal(final.evidence.length, 0);
});

async function seedDirectory(client: { query(text: string, values?: readonly unknown[]): Promise<unknown> }) {
  await client.query(
    `INSERT INTO platform_organization_units (id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at)
     VALUES
       ($1,NULL,'company','运营公司',NULL,'company','active',1,$3,$3),
       ($2,$1,'afc-team','AFC检修工班',NULL,'workgroup','active',2,$3,$3)`,
    [IDS.company, IDS.workgroup, NOW]
  );
  await client.query(
    `INSERT INTO platform_positions (id,code,name,description,status,created_at,updated_at)
     VALUES ($1,'afc-maintainer','AFC检修工',NULL,'active',$2,$2)`,
    [IDS.position, NOW]
  );
  await client.query(
    `INSERT INTO platform_people (id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at)
     VALUES
       ($1,'06010001','创建人',NULL,$5,$6,'active',NULL,$7,$7),
       ($2,'06010002','签字人甲',NULL,$4,$6,'active',NULL,$7,$7),
       ($3,'06010003','签字人乙',NULL,$4,$6,'active',NULL,$7,$7)`,
    [IDS.creator, IDS.signerA, IDS.signerB, IDS.workgroup, IDS.company, IDS.position, NOW]
  );
}

void PLATFORM_SIGNATURE_SQL;
