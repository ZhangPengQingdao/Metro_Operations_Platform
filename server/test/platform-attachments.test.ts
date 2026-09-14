import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { StorageObjectMetadata } from '../src/core/storage/index.ts';
import { PLATFORM_AUTHORIZATION_MIGRATIONS, buildAuthorizationSeed, createAuthorizationService, createMemoryAuthorizationRepository, type AppPermissionGrant, type AuthorizationDecision } from '../src/platform/authorization/index.ts';
import { createPlatformActorContextResolver, type PlatformActorContext, type PlatformExecution } from '../src/platform/context/index.ts';
import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS, createMemoryPeopleDirectoryRepository } from '../src/platform/people/index.ts';
import {
  ATTACHMENT_PERMISSION_CODES,
  PLATFORM_ATTACHMENT_MIGRATIONS,
  PLATFORM_ATTACHMENT_SQL,
  AttachmentError,
  createAttachmentService,
  createMemoryAttachmentRepository,
  createPostgresAttachmentRepository,
  reconcileLegacyAttachments,
  type AttachmentOperationHistory,
  type AttachmentRepository,
  type RegisterAttachmentInput
} from '../src/platform/attachments/index.ts';

const IDS = {
  company: '4d000000-0000-4000-8000-000000000001',
  workgroup: '4d000000-0000-4000-8000-000000000002',
  otherWorkgroup: '4d000000-0000-4000-8000-000000000003',
  position: '4d000000-0000-4000-8000-000000000004',
  uploader: '4d000000-0000-4000-8000-000000000011',
  teammate: '4d000000-0000-4000-8000-000000000012',
  outsider: '4d000000-0000-4000-8000-000000000013'
} as const;

const NOW = '2026-09-01T01:00:00.000Z';
const ALL_PERMISSIONS = new Set(Object.values(ATTACHMENT_PERMISSION_CODES));
const NO_PERMISSIONS = new Set<string>();

const organizations = new Map<string, { status: string; name: string }>([
  [IDS.company, { status: 'active', name: '运营公司' }],
  [IDS.workgroup, { status: 'active', name: 'AFC检修工班' }],
  [IDS.otherWorkgroup, { status: 'active', name: '供电检修工班' }]
]);

const people = new Map<string, { organizationUnitId: string; employmentStatus: string; employeeNo: string; name: string }>([
  [IDS.uploader, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06010001', name: '上传人' }],
  [IDS.teammate, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06010002', name: '同工班人员' }],
  [IDS.outsider, { organizationUnitId: IDS.otherWorkgroup, employmentStatus: 'active', employeeNo: '06010003', name: '外部人员' }]
]);

const storageObjects = new Map<string, StorageObjectMetadata>([
  ['photos/fault-1.jpg', metadata('photos', 'fault-1.jpg', 'image/jpeg', 2048, 'a')],
  ['photos/fault-2.jpg', metadata('photos', 'fault-2.jpg', 'image/jpeg', 4096, 'b')],
  ['reports/report-1.pdf', metadata('reports', 'report-1.pdf', 'application/pdf', 8192, 'c')]
]);

function metadata(kind: string, fileName: string, contentType: string, sizeBytes: number, hashChar: string): StorageObjectMetadata {
  return { kind, fileName, contentType, sizeBytes, sha256: hashChar.repeat(64), createdAt: NOW };
}

function harness(repository: AttachmentRepository = createMemoryAttachmentRepository()) {
  let now = new Date(NOW);
  let sequence = 100;
  const service = createAttachmentService(repository, {
    clock: () => new Date(now),
    createId: () => `4d100000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    findStorageMetadata: async (kind, fileName) => structuredClone(storageObjects.get(`${kind}/${fileName}`) ?? null),
    findPerson: async (id) => people.get(id) ?? null,
    findOrganizationUnit: async (id) => organizations.get(id) ?? null
  });
  return {
    repository,
    service,
    actor(personId: string = IDS.uploader, allowed: Set<string> = ALL_PERMISSIONS, execution: Exclude<PlatformExecution, { type: 'service' }> = { type: 'platform' }) {
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
        code: person.organizationUnitId === IDS.workgroup ? 'afc-team' : 'power-team',
        name: organizations.get(person.organizationUnitId)?.name ?? '未知组织',
        unitType: 'workgroup'
      },
      position: { id: IDS.position, code: 'maintainer', name: '检修工' }
    },
    execution,
    request: { requestId: `req-${personId}`, traceId: `trace-${personId}`, startedAt: clock().toISOString() },
    authorize: async (permissionCode: string): Promise<AuthorizationDecision> => {
      const granted = allowed.has(permissionCode);
      return {
        id: `decision-${permissionCode}`,
        allowed: granted,
        reasonCode: granted ? 'allowed' : 'permission_not_granted',
        permissionCode,
        subjectType: 'person',
        effectiveScopes: [],
        decidedAt: clock().toISOString()
      };
    }
  };
}

function attachmentCode(code: string) {
  return (error: unknown) => error instanceof AttachmentError && error.code === code;
}

function createInput(overrides: Partial<RegisterAttachmentInput> = {}): RegisterAttachmentInput {
  return {
    source: { appId: 'fault_management', entityType: 'fault', entityId: 'fault-1' },
    attachmentKey: 'fault-1:photo-1',
    idempotencyKey: 'register-fault-photo-1',
    purpose: 'fault_evidence',
    storage: { kind: 'photos', fileName: 'fault-1.jpg' },
    originalFileName: '故障照片.jpg',
    ...overrides
  };
}

test('Attachment registration uses verified L1 metadata, defaults private and is idempotent', async () => {
  const h = harness();
  const first = await h.service.registerAttachment(h.actor(), createInput());
  const second = await h.service.registerAttachment(h.actor(), createInput());
  assert.equal(second.attachment.id, first.attachment.id);
  assert.equal(first.attachment.visibility, 'private');
  assert.equal(first.attachment.retainUntil, null);
  assert.equal(first.attachment.legalHold, false);
  assert.equal(first.attachment.sizeBytes, 2048);
  assert.equal(first.attachment.sha256, 'a'.repeat(64));
  assert.equal(first.attachment.contentType, 'image/jpeg');
  assert.deepEqual(first.attachment.uploaderSnapshot, {
    personId: IDS.uploader,
    name: '上传人',
    organizationUnitId: IDS.workgroup
  });
  assert.equal(first.operationHistory.length, 1);
  assert.equal(first.operationHistory[0]?.operation, 'registered');

  await assert.rejects(
    h.service.registerAttachment(h.actor(IDS.uploader, NO_PERMISSIONS), createInput()),
    attachmentCode('ATTACHMENT_PERMISSION_DENIED')
  );

  await assert.rejects(
    h.service.registerAttachment(h.actor(), createInput({ purpose: 'other' })),
    attachmentCode('ATTACHMENT_KEY_CONFLICT')
  );
  await assert.rejects(
    h.service.registerAttachment(h.actor(), createInput({ attachmentKey: 'fault-1:photo-2', idempotencyKey: 'other-key' })),
    attachmentCode('STORAGE_REFERENCE_CONFLICT')
  );
  await assert.rejects(
    h.service.registerAttachment(h.actor(IDS.uploader, ALL_PERMISSIONS, { type: 'application', appId: 'other_app' }), createInput({ attachmentKey: 'other' })),
    attachmentCode('SOURCE_APP_MISMATCH')
  );
});

test('Registration rejects missing or invalid storage evidence and forged uploader identity', async () => {
  const h = harness();
  await assert.rejects(
    h.service.registerAttachment(h.actor(), createInput({ storage: { kind: 'photos', fileName: 'missing.jpg' } })),
    attachmentCode('STORAGE_OBJECT_NOT_FOUND')
  );
  await assert.rejects(
    h.service.registerAttachment(h.actor(), createInput({ storage: { kind: '../photos', fileName: 'fault-1.jpg' } })),
    attachmentCode('INVALID_STORAGE_NAMESPACE')
  );
  await assert.rejects(
    h.service.registerAttachment(h.actor(), createInput({ uploaderPersonId: IDS.teammate })),
    attachmentCode('UPLOADER_MISMATCH')
  );
  await assert.rejects(
    h.service.registerAttachment(
      h.actor(IDS.uploader, new Set([ATTACHMENT_PERMISSION_CODES.create])),
      createInput({ visibility: 'public_link' })
    ),
    attachmentCode('ATTACHMENT_PERMISSION_DENIED')
  );
  await assert.rejects(
    h.service.registerAttachment(
      h.actor(IDS.uploader, new Set([ATTACHMENT_PERMISSION_CODES.create])),
      createInput({
        attachmentKey: 'fault-2:photo-1',
        idempotencyKey: 'register-fault-photo-2',
        storage: { kind: 'photos', fileName: 'fault-2.jpg' },
        retainUntil: new Date('2026-09-02T01:00:00.000Z')
      })
    ),
    attachmentCode('ATTACHMENT_PERMISSION_DENIED')
  );
});

test('Repository rejects mutation of attachment business and storage identity', async () => {
  const repository = createMemoryAttachmentRepository();
  const h = harness(repository);
  const created = await h.service.registerAttachment(h.actor(), createInput());
  const registered = created.operationHistory[0];
  assert.ok(registered);
  const operation: AttachmentOperationHistory = {
    ...registered,
    id: '4d200000-0000-4000-8000-000000000001',
    operation: 'visibility_changed',
    before: { sourceEntityId: created.attachment.sourceEntityId },
    after: { sourceEntityId: 'fault-2' }
  };

  await assert.rejects(
    repository.updateAttachment({ ...created.attachment, sourceEntityId: 'fault-2' }, operation),
    attachmentCode('IMMUTABLE_ATTACHMENT_IDENTITY')
  );
  assert.equal((await repository.findAttachmentById(created.attachment.id))?.sourceEntityId, 'fault-1');
  assert.equal((await repository.listOperationHistory(created.attachment.id)).length, 1);
});

test('Visibility rules keep public_link metadata private and expose organization/application only to their actors', async () => {
  const h = harness();
  const created = await h.service.registerAttachment(h.actor(), createInput());
  await assert.rejects(h.service.getAttachment(h.actor(IDS.teammate, NO_PERMISSIONS), created.attachment.id), attachmentCode('ATTACHMENT_ACCESS_DENIED'));
  await assert.rejects(
    h.service.getAttachment(
      h.actor(IDS.outsider, NO_PERMISSIONS, { type: 'application', appId: 'fault_management' }),
      created.attachment.id
    ),
    attachmentCode('ATTACHMENT_ACCESS_DENIED')
  );

  const organization = await h.service.changeVisibility(h.actor(), { attachmentId: created.attachment.id, visibility: 'organization' });
  assert.equal((await h.service.getAttachment(h.actor(IDS.teammate, NO_PERMISSIONS), organization.attachment.id)).attachment.id, created.attachment.id);
  await assert.rejects(h.service.getAttachment(h.actor(IDS.outsider, NO_PERMISSIONS), created.attachment.id), attachmentCode('ATTACHMENT_ACCESS_DENIED'));

  await h.service.changeVisibility(h.actor(), { attachmentId: created.attachment.id, visibility: 'public_link' });
  await assert.rejects(h.service.getAttachment(h.actor(IDS.teammate, NO_PERMISSIONS), created.attachment.id), attachmentCode('ATTACHMENT_ACCESS_DENIED'));
  assert.equal((await h.service.getAttachment(h.actor(IDS.outsider, new Set([ATTACHMENT_PERMISSION_CODES.read])), created.attachment.id)).attachment.id, created.attachment.id);

  await h.service.changeVisibility(h.actor(), { attachmentId: created.attachment.id, visibility: 'application' });
  const appActor = h.actor(IDS.outsider, NO_PERMISSIONS, { type: 'application', appId: 'fault_management' });
  // This fixture represents a granted application, independently of the person's role permissions.
  appActor.authorizeApplication = h.actor().authorize;
  assert.equal((await h.service.getAttachment(
    appActor,
    created.attachment.id
  )).attachment.id, created.attachment.id);
  assert.deepEqual((await h.service.listAttachments(h.actor(IDS.teammate, NO_PERMISSIONS))).map((item) => item.id), []);
});

test('Attachment intrinsic uploader and source-app access is capped by fresh real resolver grants', async () => {
  const h = harness();
  const created = await h.service.registerAttachment(h.actor(), createInput({ visibility:'application' }));
  const directory = createMemoryPeopleDirectoryRepository({
    organizationUnits:[{ id:IDS.workgroup,parentId:null,code:'team',name:'Team',shortName:null,unitType:'workgroup',status:'active',sortOrder:0,createdAt:NOW,updatedAt:NOW }],
    positions:[{ id:IDS.position,code:'worker',name:'Worker',description:null,status:'active',createdAt:NOW,updatedAt:NOW }],
    people:[{ id:IDS.uploader,employeeNo:'1',name:'Uploader',phone:null,organizationUnitId:IDS.workgroup,positionId:IDS.position,employmentStatus:'active',avatarUrl:null,createdAt:NOW,updatedAt:NOW }]
  });
  const authorization = createAuthorizationService(createMemoryAuthorizationRepository(buildAuthorizationSeed(NOW)), {
    clock:() => new Date(NOW),findPerson:async id => directory.findPersonById(id)
  });
  await authorization.registerPermission({ code:ATTACHMENT_PERMISSION_CODES.read,name:'Read attachment' });
  let current: AppPermissionGrant | null = null;
  let lookups = 0;
  const resolver = createPlatformActorContextResolver({ people:directory,authorization,resolveAppGrant:async () => { lookups++; return current; } });
  const request = { requestId:'grant-read',traceId:'grant-read' };
  const person = await resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:IDS.uploader },execution:{ type:'application',appId:'fault_management' },...request });
  const service = await resolver.resolve({ actorType:'service',trustedIdentity:{ source:'service' },execution:{ type:'service',appId:'fault_management',serviceIdentityId:'runner' },...request });
  for (const actor of [person,service]) {
    const valid: AppPermissionGrant = { grantId:'grant',appId:'fault_management',mode:actor.actorType === 'person' ? 'delegated_user':'service',permissionCode:ATTACHMENT_PERMISSION_CODES.read,status:'active',effectiveFrom:NOW,effectiveTo:null,scope:{ kind:'explicit',targets:[{ type:'organization',id:IDS.workgroup }] } };
    current = valid;
    assert.equal((await h.service.getAttachment(actor,created.attachment.id)).attachment.id,created.attachment.id);
    for (const invalid of [null,{ ...valid,status:'inactive' as const },{ ...valid,effectiveTo:NOW },{ ...valid,appId:'other_app' },{ ...valid,scope:{ kind:'explicit' as const,targets:[{ type:'organization' as const,id:IDS.otherWorkgroup }] } }]) {
      current = invalid;
      await assert.rejects(h.service.getAttachment(actor,created.attachment.id),attachmentCode('ATTACHMENT_ACCESS_DENIED'));
      assert.deepEqual(await h.service.listAttachments(actor),[]);
    }
  }
  assert.equal(lookups,22);
  // Native platform ownership remains available without managerial role permissions or application grant.
  assert.equal((await h.service.getAttachment(h.actor(IDS.uploader,NO_PERMISSIONS),created.attachment.id)).attachment.id,created.attachment.id);
  assert.equal(lookups,22);
  await assert.rejects(h.service.getAttachment(h.actor(IDS.uploader,ALL_PERMISSIONS,{ type:'application',appId:'fault_management' }),created.attachment.id),attachmentCode('ATTACHMENT_ACCESS_DENIED'));
});

async function verifyConcurrentRetention(repository: AttachmentRepository) {
  const h = harness(repository);
  const created = await h.service.registerAttachment(h.actor(),createInput({ retainUntil:new Date('2026-09-02T01:00:00.000Z') }));
  h.setNow('2026-09-03T01:00:00.000Z');
  // Both commands read the same version before either is released to write.
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const actor = h.actor();
  const authorize = actor.authorize;
  actor.authorize = async (...args) => {
    const decision = await authorize(...args);
    if (++arrived === 2) release();
    await barrier;
    return decision;
  };
  const results = await Promise.allSettled([
    h.service.changeRetention(actor,{ attachmentId:created.attachment.id,legalHold:true }),
    h.service.removeAttachment(actor,{ attachmentId:created.attachment.id })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  const failed = results.find(result => result.status === 'rejected');
  assert.ok(failed?.status === 'rejected' && attachmentCode('ATTACHMENT_STATE_CONFLICT')(failed.reason));
  const final = await repository.findAttachmentById(created.attachment.id);
  assert.ok(final);
  assert.ok(final.lifecycle === 'active' && final.legalHold || final.lifecycle === 'removed' && !final.legalHold);
  assert.equal((await repository.listOperationHistory(created.attachment.id)).length,2);
  assert.equal(storageObjects.has('photos/fault-1.jpg'),true);
  return h;
}

test('Memory attachment stale retention/remove commands cannot overwrite evidence', async () => {
  await verifyConcurrentRetention(createMemoryAttachmentRepository());
});

test('Postgres attachment lock checks prior retention state and rolls back failed history', async () => {
  const database = new PGlite();
  let rejectHistory = false;
  const client = { query(text:string,values?:readonly unknown[]) {
    if (rejectHistory && text.includes('INSERT INTO platform_attachment_operation_history')) throw new Error('history unavailable');
    return !values && text.includes(';') ? database.exec(text) : database.query(text,values ? [...values] : undefined);
  } };
  try {
    for (const migration of [...PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS,...PLATFORM_AUTHORIZATION_MIGRATIONS,...PLATFORM_ATTACHMENT_MIGRATIONS]) await migration.run({ client });
    await seedDirectory(client);
    const repository = createPostgresAttachmentRepository(client);
    const h = await verifyConcurrentRetention(repository);
    const second = await h.service.registerAttachment(h.actor(),createInput({ attachmentKey:'second',idempotencyKey:'second',storage:{ kind:'photos',fileName:'fault-2.jpg' } }));
    rejectHistory = true;
    await assert.rejects(h.service.changeRetention(h.actor(),{ attachmentId:second.attachment.id,legalHold:true }),/history unavailable/);
    assert.equal((await repository.findAttachmentById(second.attachment.id))?.legalHold,false);
    assert.equal((await repository.listOperationHistory(second.attachment.id)).length,1);
  } finally { await database.close(); }
});

test('Visibility and retention changes require separate permissions and notes remain optional', async () => {
  const h = harness();
  const created = await h.service.registerAttachment(h.actor(), createInput());
  await assert.rejects(
    h.service.changeVisibility(h.actor(IDS.uploader, NO_PERMISSIONS), { attachmentId: created.attachment.id, visibility: 'organization' }),
    attachmentCode('ATTACHMENT_PERMISSION_DENIED')
  );
  await assert.rejects(
    h.service.changeRetention(h.actor(IDS.uploader, new Set([ATTACHMENT_PERMISSION_CODES.manage])), {
      attachmentId: created.attachment.id,
      retainUntil: new Date('2026-09-02T01:00:00.000Z')
    }),
    attachmentCode('ATTACHMENT_PERMISSION_DENIED')
  );
  const changed = await h.service.changeRetention(h.actor(), {
    attachmentId: created.attachment.id,
    retainUntil: new Date('2026-09-02T01:00:00.000Z'),
    legalHold: true
  });
  assert.equal(changed.attachment.legalHold, true);
  assert.equal(changed.operationHistory.at(-1)?.note, null);
  assert.equal(changed.operationHistory.at(-1)?.operation, 'retention_changed');
  await assert.rejects(
    h.service.changeRetention(h.actor(), { attachmentId: created.attachment.id }),
    attachmentCode('RETENTION_CHANGE_REQUIRED')
  );
});

test('Logical removal is blocked by indefinite retention, future deadlines and legal hold without deleting bytes', async () => {
  const h = harness();
  const created = await h.service.registerAttachment(h.actor(), createInput());
  await assert.rejects(h.service.removeAttachment(h.actor(), { attachmentId: created.attachment.id }), attachmentCode('ATTACHMENT_RETAINED_INDEFINITELY'));
  await h.service.changeRetention(h.actor(), {
    attachmentId: created.attachment.id,
    retainUntil: new Date('2026-09-02T01:00:00.000Z')
  });
  await assert.rejects(h.service.removeAttachment(h.actor(), { attachmentId: created.attachment.id }), attachmentCode('ATTACHMENT_RETENTION_ACTIVE'));
  await h.service.changeRetention(h.actor(), { attachmentId: created.attachment.id, legalHold: true });
  h.setNow('2026-09-03T01:00:00.000Z');
  await assert.rejects(h.service.removeAttachment(h.actor(), { attachmentId: created.attachment.id }), attachmentCode('ATTACHMENT_LEGAL_HOLD'));
  await h.service.changeRetention(h.actor(), { attachmentId: created.attachment.id, legalHold: false });
  const removed = await h.service.removeAttachment(h.actor(), { attachmentId: created.attachment.id });
  assert.equal(removed.attachment.lifecycle, 'removed');
  assert.equal(removed.attachment.removedAt, '2026-09-03T01:00:00.000Z');
  assert.equal(storageObjects.has('photos/fault-1.jpg'), true);
  assert.equal(removed.operationHistory.at(-1)?.operation, 'removed');
  assert.equal('deleteObject' in h.service, false);
});

test('Attachment migration runs twice and PostgreSQL repository round-trips records and history atomically', async () => {
  const database = new PGlite();
  const client = {
    query(text: string, values?: readonly unknown[]) {
      if (!values && text.includes(';')) return database.exec(text);
      return database.query(text, values ? [...values] : undefined);
    }
  };
  try {
    for (const migration of PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_AUTHORIZATION_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_ATTACHMENT_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_ATTACHMENT_MIGRATIONS) await migration.run({ client });
    await seedDirectory(client);

    const tableCheck = await client.query("SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name LIKE 'platform_attachment%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(tableCheck.rows[0]?.count), 2);
    const h = harness(createPostgresAttachmentRepository(client));
    const created = await h.service.registerAttachment(h.actor(), createInput({ attachmentKey: 'fault-1:postgres', idempotencyKey: 'postgres-1' }));
    const changed = await h.service.changeVisibility(h.actor(), { attachmentId: created.attachment.id, visibility: 'organization' });
    assert.equal(changed.attachment.visibility, 'organization');
    assert.deepEqual(changed.operationHistory.map((entry) => entry.operation), ['registered', 'visibility_changed']);
    assert.equal((await h.repository.findAttachmentByStorage('photos', 'fault-1.jpg'))?.id, created.attachment.id);
    await assert.rejects(
      client.query("UPDATE platform_attachments SET lifecycle='removed', removed_at=NULL WHERE id=$1", [created.attachment.id])
    );
    assert.equal((await h.repository.findAttachmentById(created.attachment.id))?.lifecycle, 'active');

    const permissionCheck = await client.query("SELECT COUNT(*)::text AS count FROM platform_permissions WHERE code LIKE 'platform.attachments.%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(permissionCheck.rows[0]?.count), 5);
    assert.doesNotMatch(PLATFORM_ATTACHMENT_SQL, /(?:DELETE\s+FROM|UPDATE\s+file_assets|ALTER\s+TABLE\s+file_assets)/i);
  } finally {
    await database.close();
  }
});

test('Legacy reconciliation reports ownership, association, storage and public-reference gaps without mutation', () => {
  const snapshot = {
    fileAssets: [
      { id: 'asset-1', kind: 'photos', fileName: 'fault-1.jpg', uploaderId: IDS.uploader, workgroupId: IDS.workgroup, purpose: 'fault', entityKey: 'fault-1' },
      { kind: 'photos', fileName: 'missing.jpg', purpose: null, entityKey: null },
      { id: 'asset-3', kind: 'photos', fileName: 'fault-1.jpg', purpose: 'duplicate', entityKey: 'fault-2' },
      { id: 'asset-4', kind: '../unsafe', fileName: '../secret', purpose: 'unsafe', entityKey: 'fault-3' }
    ],
    storageObjects: [
      metadata('photos', 'fault-1.jpg', 'image/jpeg', 2048, 'a'),
      metadata('reports', 'orphan.pdf', '', 10, 'd')
    ],
    publicReferences: [
      { id: 'public-1', value: '/api/files/public/photos/fault-1.jpg?sig=kept' },
      { id: 'public-2', value: '/api/files/public/photos/missing.jpg?sig=kept' },
      { id: 'public-3', value: 'not-a-storage-link' }
    ]
  } as const;
  const before = structuredClone(snapshot);
  const result = reconcileLegacyAttachments(snapshot);
  assert.deepEqual(snapshot, before);
  assert.equal(result.metadataCount, 4);
  assert.equal(result.storageObjectCount, 2);
  assert.equal(result.uploaderCoverageCount, 1);
  assert.equal(result.ownerOrganizationCoverageCount, 1);
  assert.equal(result.businessAssociationCoverageCount, 3);
  assert.equal(result.publicReferenceObjectCoverageCount, 1);
  assert.equal(result.issues.some((issue) => issue.sourceId === 'photos/missing.jpg'), true);
  assert.deepEqual(result.issues.map((issue) => issue.code), [
    'INVALID_STORAGE_METADATA',
    'MISSING_BUSINESS_ASSOCIATION',
    'MISSING_OWNERSHIP',
    'METADATA_WITHOUT_OBJECT',
    'MISSING_OWNERSHIP',
    'DUPLICATE_STORAGE_REFERENCE',
    'MISSING_OWNERSHIP',
    'UNSAFE_STORAGE_REFERENCE',
    'OBJECT_WITHOUT_METADATA',
    'PUBLIC_REFERENCE_WITHOUT_OBJECT',
    'UNSAFE_PUBLIC_REFERENCE'
  ]);
});

async function seedDirectory(client: { query(text: string, values?: readonly unknown[]): Promise<unknown> }) {
  await client.query(
    `INSERT INTO platform_organization_units (id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at)
     VALUES
       ($1,NULL,'company','运营公司',NULL,'company','active',1,$4,$4),
       ($2,$1,'afc-team','AFC检修工班',NULL,'workgroup','active',2,$4,$4),
       ($3,$1,'power-team','供电检修工班',NULL,'workgroup','active',3,$4,$4)`,
    [IDS.company, IDS.workgroup, IDS.otherWorkgroup, NOW]
  );
  await client.query(
    `INSERT INTO platform_positions (id,code,name,description,status,created_at,updated_at)
     VALUES ($1,'maintainer','检修工',NULL,'active',$2,$2)`,
    [IDS.position, NOW]
  );
  await client.query(
    `INSERT INTO platform_people (id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at)
     VALUES
       ($1,'06010001','上传人',NULL,$4,$6,'active',NULL,$7,$7),
       ($2,'06010002','同工班人员',NULL,$4,$6,'active',NULL,$7,$7),
       ($3,'06010003','外部人员',NULL,$5,$6,'active',NULL,$7,$7)`,
    [IDS.uploader, IDS.teammate, IDS.outsider, IDS.workgroup, IDS.otherWorkgroup, IDS.position, NOW]
  );
}
