import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { CORE_EVENTS_MIGRATIONS, createMemoryCoreOutboxRepository, createPostgresCoreOutboxRepository, type CoreEventPayload, type CoreOutboxRecord, type CoreOutboxRepository, type EnqueueCoreOutboxEventInput } from '../src/core/events/index.ts';
import { PLATFORM_AUTHORIZATION_MIGRATIONS } from '../src/platform/authorization/index.ts';
import type { AuthorizationDecision } from '../src/platform/authorization/index.ts';
import type { PlatformActorContext, PlatformExecution } from '../src/platform/context/index.ts';
import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS } from '../src/platform/people/index.ts';
import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_PERMISSION_CODES,
  PLATFORM_NOTIFICATION_MIGRATIONS,
  PLATFORM_NOTIFICATION_SQL,
  NotificationError,
  createMemoryNotificationRepository,
  createNotificationService,
  createPostgresNotificationRepository,
  reconcileLegacyNotifications,
  type NotificationRepository
} from '../src/platform/notifications/index.ts';

const IDS = {
  company: '49000000-0000-4000-8000-000000000001',
  workgroup: '49000000-0000-4000-8000-000000000002',
  childWorkgroup: '49000000-0000-4000-8000-000000000003',
  position: '49000000-0000-4000-8000-000000000004',
  creator: '49000000-0000-4000-8000-000000000011',
  recipientA: '49000000-0000-4000-8000-000000000012',
  recipientB: '49000000-0000-4000-8000-000000000013',
  childMember: '49000000-0000-4000-8000-000000000014',
  outsider: '49000000-0000-4000-8000-000000000015'
} as const;

const SOURCE = { appId: 'online_todo', entityType: 'todo_item', entityId: 'item-1' };
const NOW = '2026-08-31T14:00:00.000Z';
const ALL_PERMISSIONS = new Set(Object.values(NOTIFICATION_PERMISSION_CODES));
const DELIVERY_PERMISSION = new Set([NOTIFICATION_PERMISSION_CODES.deliveryManage]);
const PREFERENCE_PERMISSION = new Set([NOTIFICATION_PERMISSION_CODES.preferencesManage]);
const NO_PERMISSIONS = new Set<string>();

const organizations = new Map<string, { status: string; name: string }>([
  [IDS.company, { status: 'active', name: '运营公司' }],
  [IDS.workgroup, { status: 'active', name: 'AFC检修工班' }],
  [IDS.childWorkgroup, { status: 'active', name: 'AFC下级工班' }]
]);

const people = new Map<string, { organizationUnitId: string; organizationUnitName: string; employmentStatus: string; employeeNo: string; name: string }>([
  [IDS.creator, { organizationUnitId: IDS.company, organizationUnitName: '运营公司', employmentStatus: 'active', employeeNo: '06010001', name: '创建人' }],
  [IDS.recipientA, { organizationUnitId: IDS.workgroup, organizationUnitName: 'AFC检修工班', employmentStatus: 'active', employeeNo: '06010002', name: '检修工甲' }],
  [IDS.recipientB, { organizationUnitId: IDS.workgroup, organizationUnitName: 'AFC检修工班', employmentStatus: 'active', employeeNo: '06010003', name: '检修工乙' }],
  [IDS.childMember, { organizationUnitId: IDS.childWorkgroup, organizationUnitName: 'AFC下级工班', employmentStatus: 'active', employeeNo: '06010004', name: '下级工班人员' }],
  [IDS.outsider, { organizationUnitId: IDS.company, organizationUnitName: '运营公司', employmentStatus: 'active', employeeNo: '06010005', name: '外部人员' }]
]);

function memoryHarness(startAt = NOW) {
  const repository = createMemoryNotificationRepository();
  const outbox = createMemoryCoreOutboxRepository();
  return harness(repository, outbox, startAt);
}

function harness<T extends CoreOutboxRepository | undefined>(
  repository: NotificationRepository,
  outbox: T,
  startAt: string
) {
  let now = new Date(startAt);
  let idSequence = 100;
  let eventSequence = 900;
  const service = createNotificationService(repository, {
    clock: () => new Date(now),
    createId: () => `49000000-0000-4000-8000-${String(idSequence++).padStart(12, '0')}`,
    createEventId: () => `49100000-0000-4000-8000-${String(eventSequence++).padStart(12, '0')}`,
    outbox,
    findPerson: async (id) => people.get(id) ?? null,
    findOrganizationUnit: async (id) => organizations.get(id) ?? null,
    listActiveOrganizationMembers: async (organizationUnitId) => [...people.entries()]
      .filter(([, person]) => person.organizationUnitId === organizationUnitId && person.employmentStatus === 'active')
      .map(([id, person]) => ({ id, organizationUnitId: person.organizationUnitId, organizationUnitName: person.organizationUnitName, employmentStatus: person.employmentStatus, name: person.name }))
  });

  return {
    repository,
    outbox,
    service,
    setNow(value: string) {
      now = new Date(value);
    },
    actor(personId: string = IDS.creator, allowed: Set<string> = ALL_PERMISSIONS, execution: Exclude<PlatformExecution, { type: 'service' }> = { type: 'platform' }): PlatformActorContext {
      return personContext(personId, allowed, execution, () => now);
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
  assert.ok(person, `missing person fixture: ${personId}`);
  const decidedAt = () => clock().toISOString();
  return {
    actorType: 'person',
    trustedIdentity: { source: 'session', userId: personId },
    person: {
      id: personId,
      employeeNo: person.employeeNo,
      name: person.name,
      avatarUrl: null,
      organization: { id: person.organizationUnitId, code: 'org', name: person.organizationUnitName, unitType: 'workgroup' },
      position: { id: IDS.position, code: 'afc-maintainer', name: 'AFC检修工' }
    },
    execution,
    request: { requestId: `req-${personId}`, traceId: `trace-${personId}`, startedAt: decidedAt() },
    authorize: async (permissionCode: string): Promise<AuthorizationDecision> => {
      const isAllowed = allowed.has(permissionCode);
      return {
        id: `decision-${permissionCode}`,
        allowed: isAllowed,
        reasonCode: isAllowed ? 'allowed' : 'permission_not_granted',
        permissionCode,
        subjectType: 'person',
        effectiveScopes: [],
        decidedAt: decidedAt()
      };
    }
  };
}

function notificationCode(code: string) {
  return (error: unknown) => error instanceof NotificationError && error.code === code;
}

function display(title = '新的待办事项') {
  return { title, body: '检查 AFC 设备状态', severity: 'normal' as const, sourceLabel: '统一待办' };
}

function navigation() {
  return { href: '/todo?taskId=task-1&notificationKey=todo:item-1', routeName: 'todo.detail', params: { taskId: 'task-1' } };
}

async function createWorkgroupNotification(h: Pick<ReturnType<typeof memoryHarness>, 'service' | 'actor'> = memoryHarness(), overrides: Partial<Parameters<ReturnType<typeof createNotificationService>['createNotification']>[1]> = {}) {
  return h.service.createNotification(h.actor(), {
    source: SOURCE,
    notificationKey: 'todo:item-1',
    idempotencyKey: 'notify-item-1',
    category: 'work_item',
    readBehavior: 'mark_read',
    display: display(),
    template: {
      templateKey: 'todo.created',
      templateVersion: 'v1',
      locale: 'zh-CN',
      variables: { title: '检查 AFC 设备状态' }
    },
    navigation: navigation(),
    recipients: [
      { recipientType: 'organization_unit', recipientId: IDS.workgroup },
      { recipientType: 'person', recipientId: IDS.recipientA }
    ],
    channels: ['in_app', 'wecom'],
    ...overrides
  });
}

test('Notification create is idempotent, resolves direct recipients, and emits a lightweight event', async () => {
  const h = memoryHarness();
  const first = await createWorkgroupNotification(h);
  const second = await createWorkgroupNotification(h);
  const detail = await h.service.getNotification(h.actor(), first.id);

  assert.equal(second.id, first.id);
  assert.equal(detail.recipients.length, 2);
  assert.deepEqual(detail.recipients.map((recipient) => recipient.personId).sort(), [IDS.recipientA, IDS.recipientB]);
  assert.equal(detail.channelIntents.length, 4);
  assert.equal(detail.channelIntents.every((intent) => intent.status === 'pending'), true);
  assert.equal(h.outbox?.records().length, 1);
  const event = h.outbox?.records()[0].event;
  assert.equal(event?.type, NOTIFICATION_EVENT_TYPES.created);
  assert.equal((event?.payload as Record<string, unknown>).notificationId, first.id);
  assert.equal((event?.payload as Record<string, unknown>).sourceAppId, SOURCE.appId);
  assert.equal(Object.hasOwn(event?.payload as object, 'display'), false);
  assert.equal(Object.hasOwn(event?.payload as object, 'template'), false);

  await assert.rejects(
    createWorkgroupNotification(h, { display: display('改标题') }),
    notificationCode('NOTIFICATION_KEY_CONFLICT')
  );
  await assert.rejects(
    h.service.createNotification(h.actor(IDS.creator, ALL_PERMISSIONS, { type: 'application', appId: 'faults' }), {
      source: SOURCE,
      notificationKey: 'todo:item-2',
      display: display(),
      recipients: [{ recipientType: 'person', recipientId: IDS.recipientA }]
    }),
    notificationCode('SOURCE_APP_MISMATCH')
  );
});

test('direct recipients can list and mark read while non-recipients need permission', async () => {
  const h = memoryHarness();
  const item = await createWorkgroupNotification(h);

  assert.deepEqual((await h.service.listNotifications(h.actor(IDS.recipientA, NO_PERMISSIONS))).map((entry) => entry.id), [item.id]);
  assert.deepEqual(await h.service.listNotifications(h.actor(IDS.outsider, NO_PERMISSIONS)), []);
  await assert.rejects(h.service.getNotification(h.actor(IDS.outsider, NO_PERMISSIONS), item.id), notificationCode('NOTIFICATION_ACCESS_DENIED'));

  const read = await h.service.markRead(h.actor(IDS.recipientA, NO_PERMISSIONS), { notificationId: item.id });
  assert.equal(read.personId, IDS.recipientA);
  assert.deepEqual(await h.service.listNotifications(h.actor(IDS.recipientA, NO_PERMISSIONS), { unreadOnly: true }), []);
  const detail = await h.service.getNotification(h.actor(IDS.recipientA, NO_PERMISSIONS), item.id);
  assert.equal(detail.reads.length, 1);
  assert.equal(h.outbox?.records().at(-1)?.event.type, NOTIFICATION_EVENT_TYPES.read);
  await assert.rejects(
    h.service.listNotifications(h.actor(), { status: 'removed' as never }),
    notificationCode('INVALID_NOTIFICATION_STATUS')
  );
});

test('delivery state is permissioned platform state and records attempts without sending transport messages', async () => {
  const h = memoryHarness();
  const item = await createWorkgroupNotification(h, { channels: ['wecom'] });
  const intent = (await h.service.getNotification(h.actor(), item.id)).channelIntents[0];

  await assert.rejects(
    h.service.updateDelivery(h.actor(IDS.outsider, NO_PERMISSIONS), {
      channelIntentId: intent.id,
      status: 'failed',
      errorMessage: 'gateway timeout'
    }),
    notificationCode('NOTIFICATION_PERMISSION_DENIED')
  );

  const failed = await h.service.updateDelivery(h.actor(IDS.creator, DELIVERY_PERMISSION), {
    channelIntentId: intent.id,
    status: 'failed',
    errorMessage: 'gateway timeout'
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastError, 'gateway timeout');

  h.setNow('2026-08-31T14:05:00.000Z');
  const sent = await h.service.updateDelivery(h.actor(IDS.creator, DELIVERY_PERMISSION), {
    channelIntentId: intent.id,
    status: 'sent',
    providerMessageId: 'msg-1'
  });
  const detail = await h.service.getNotification(h.actor(), item.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.providerMessageId, 'msg-1');
  assert.equal(sent.attempts, 2);
  assert.equal(detail.deliveryAttempts.length, 2);
  assert.equal(h.outbox?.records().at(-1)?.event.type, NOTIFICATION_EVENT_TYPES.deliveryUpdated);
});

test('cancelling a notification closes open channel intents without erasing delivered evidence', async () => {
  const h = memoryHarness();
  const item = await createWorkgroupNotification(h, { channels: ['in_app', 'wecom'] });
  const detail = await h.service.getNotification(h.actor(), item.id);
  const sentIntent = detail.channelIntents.find((intent) => intent.channel === 'wecom');
  assert.ok(sentIntent);
  await h.service.updateDelivery(h.actor(IDS.creator, DELIVERY_PERMISSION), {
    channelIntentId: sentIntent.id,
    status: 'sent',
    providerMessageId: 'wecom-msg-1'
  });

  const cancelled = await h.service.cancelNotification(h.actor(), { notificationId: item.id });
  const next = await h.service.getNotification(h.actor(), item.id);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(next.channelIntents.find((intent) => intent.id === sentIntent.id)?.status, 'sent');
  assert.equal(next.channelIntents.filter((intent) => intent.id !== sentIntent.id).every((intent) => intent.status === 'cancelled'), true);
  assert.equal(next.deliveryAttempts.length, 1);
  assert.equal(h.outbox?.records().at(-1)?.event.type, NOTIFICATION_EVENT_TYPES.cancelled);
});

test('people can manage their own notification preferences, while cross-person changes require permission', async () => {
  const h = memoryHarness();
  const own = await h.service.setPreference(h.actor(IDS.recipientA, NO_PERMISSIONS), {
    sourceAppId: 'online_todo',
    category: 'work_item',
    channel: 'wecom',
    muted: true,
    quietWindow: { startMinuteOfDay: 1320, endMinuteOfDay: 420, timezone: 'Asia/Shanghai' }
  });
  assert.equal(own.personId, IDS.recipientA);
  assert.equal(own.muted, true);

  await assert.rejects(
    h.service.setPreference(h.actor(IDS.outsider, NO_PERMISSIONS), {
      personId: IDS.recipientA,
      channel: 'wecom',
      muted: false
    }),
    notificationCode('NOTIFICATION_PERMISSION_DENIED')
  );

  const managed = await h.service.setPreference(h.actor(IDS.outsider, PREFERENCE_PERMISSION), {
    personId: IDS.recipientA,
    sourceAppId: 'online_todo',
    category: 'work_item',
    channel: 'wecom',
    muted: false,
    note: '管理员调整'
  });
  assert.equal(managed.id, own.id);
  assert.equal(managed.muted, false);
  assert.equal(h.outbox?.records().at(-1)?.event.type, NOTIFICATION_EVENT_TYPES.preferenceUpdated);
});

test('Notification migration runs twice and PostgreSQL repository preserves reads and delivery state', async () => {
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
    for (const migration of PLATFORM_NOTIFICATION_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_NOTIFICATION_MIGRATIONS) await migration.run({ client });

    const tableCheck = await client.query("SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name LIKE 'platform_notification%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(tableCheck.rows[0]?.count ?? 0) >= 7, true);
    await seedPeople(client);

    const h = harness(createPostgresNotificationRepository(client), createPostgresCoreOutboxRepository(client), NOW);
    const notification = await createWorkgroupNotification(h);
    const read = await h.service.markRead(h.actor(IDS.recipientA, NO_PERMISSIONS), { notificationId: notification.id });
    const detail = await h.service.getNotification(h.actor(), notification.id);
    const intent = detail.channelIntents.find((item) => item.channel === 'wecom');
    assert.ok(intent);
    const delivered = await h.service.updateDelivery(h.actor(IDS.creator, DELIVERY_PERMISSION), {
      channelIntentId: intent.id,
      status: 'sent',
      providerMessageId: 'wecom-msg-1'
    });

    assert.equal(read.personId, IDS.recipientA);
    assert.equal(detail.recipients.length, 2);
    assert.equal(delivered.status, 'sent');
    assert.equal((await h.service.getNotification(h.actor(), notification.id)).deliveryAttempts.length, 1);
    const enqueue = h.outbox.enqueue;
    h.outbox.enqueue = async (...args: Parameters<typeof enqueue>) => {
      await enqueue(...args);
      throw new Error('postgres notification event failure');
    };
    const before = await client.query('SELECT (SELECT COUNT(*) FROM platform_notifications)::text AS notifications, (SELECT COUNT(*) FROM platform_notification_operation_history)::text AS history, (SELECT COUNT(*) FROM core_outbox_events)::text AS events');
    await assert.rejects(createWorkgroupNotification(h, {
      id: '49000000-0000-4000-8000-000000002000', notificationKey: 'failing-key', idempotencyKey: 'failing-key'
    }), /postgres notification event failure/);
    h.outbox.enqueue = enqueue;
    const after = await client.query('SELECT (SELECT COUNT(*) FROM platform_notifications)::text AS notifications, (SELECT COUNT(*) FROM platform_notification_operation_history)::text AS history, (SELECT COUNT(*) FROM core_outbox_events)::text AS events');
    assert.deepEqual(after, before);
  } finally {
    await database.close();
  }
});

test('legacy notification reconciliation keeps key, read behavior, and deep-link issues explicit', () => {
  const result = reconcileLegacyNotifications({
    reads: [
      { userId: IDS.recipientA, notificationKey: 'todo:item-1', sourceType: 'todo', sourceId: 'item-1' },
      { userId: IDS.recipientA, notificationKey: 'todo:item-1', sourceType: 'todo', sourceId: 'item-1' },
      { userId: IDS.recipientB, notificationKey: '', sourceType: 'todo', sourceId: 'item-2' }
    ],
    generated: [
      { key: 'todo:item-1', sourceType: 'todo', sourceId: 'item-1', readBehavior: 'mark_read', actionUrl: '/todo?taskId=task-1' },
      { key: 'fault-quality:fault-1', sourceType: 'fault_quality', sourceId: 'fault-1', readBehavior: 'state_bound', actionUrl: '' }
    ]
  });

  assert.equal(result.readCount, 3);
  assert.equal(result.generatedCount, 2);
  assert.equal(result.uniqueReadKeys, 1);
  assert.equal(result.markReadCount, 1);
  assert.equal(result.stateBoundCount, 1);
  assert.deepEqual(result.issues.map((issue) => issue.code), ['DUPLICATE_READ', 'MISSING_KEY', 'MISSING_ACTION_URL']);
});

test('Notification command rollback includes business records, history and configured Outbox', async () => {
  const repository = createMemoryNotificationRepository();
  const outbox = createMemoryCoreOutboxRepository();
  let fail = true;
  const faulting: CoreOutboxRepository = { ...outbox, async enqueue<TPayload extends CoreEventPayload>(input: EnqueueCoreOutboxEventInput<TPayload>): Promise<CoreOutboxRecord<TPayload>> {
    const saved = await outbox.enqueue(input);
    if (fail) throw new Error('injected enqueue failure');
    return saved;
  } };
  const h = harness(repository, faulting, NOW);
  await assert.rejects(createWorkgroupNotification(h), /injected enqueue failure/);
  assert.equal(Object.values(repository.records()).flat().length, 0);
  assert.equal(outbox.records().length, 0);
  fail = false;
  const created = await createWorkgroupNotification(h);
  const snapshot = repository.records();
  fail = true;
  await assert.rejects(h.service.markRead(h.actor(IDS.recipientA, NO_PERMISSIONS), { notificationId: created.id }), /injected enqueue failure/);
  assert.deepEqual(repository.records(), snapshot);
  assert.equal(outbox.records().length, 1);
});

test('Notification authorization applies before retry and on intrinsic recipient and preference paths', async () => {
  const h = memoryHarness();
  const item = await createWorkgroupNotification(h);
  await assert.rejects(createWorkgroupNotification({ ...h, actor: () => h.actor(IDS.outsider, NO_PERMISSIONS) }), notificationCode('NOTIFICATION_PERMISSION_DENIED'));
  const appRecipient = h.actor(IDS.recipientA, NO_PERMISSIONS, { type: 'application', appId: SOURCE.appId });
  await assert.rejects(h.service.getNotification(appRecipient, item.id), notificationCode('NOTIFICATION_ACCESS_DENIED'));
  await assert.rejects(h.service.markRead(appRecipient, { notificationId: item.id }), notificationCode('NOTIFICATION_ACCESS_DENIED'));
  await assert.rejects(h.service.setPreference(appRecipient, { muted: true }), notificationCode('NOTIFICATION_PERMISSION_DENIED'));
  const scoped = { ...appRecipient, authorizeApplication: (permissionCode: string) => h.actor().authorize(permissionCode) };
  assert.equal((await h.service.markRead(scoped, { notificationId: item.id })).personId, IDS.recipientA);
  await h.service.cancelNotification(h.actor(), { notificationId: item.id });
  await assert.rejects(h.service.cancelNotification(h.actor(IDS.outsider, NO_PERMISSIONS), { notificationId: item.id }), notificationCode('NOTIFICATION_PERMISSION_DENIED'));
});

test('Notification concurrent reads are idempotent and terminal delivery evidence cannot be overwritten', async () => {
  const h = memoryHarness();
  const item = await createWorkgroupNotification(h);
  const reads = await Promise.all([1, 2].map(() => h.service.markRead(h.actor(IDS.recipientA, NO_PERMISSIONS), { notificationId: item.id })));
  assert.equal(reads[0].id, reads[1].id);
  let detail = await h.service.getNotification(h.actor(), item.id);
  assert.equal(detail.operationHistory.filter((operation) => operation.operation === 'read').length, 1);
  const intent = detail.channelIntents[0];
  const delivered = await Promise.allSettled(['first', 'second'].map((providerMessageId) => h.service.updateDelivery(h.actor(), {
    channelIntentId: intent.id, status: 'sent', providerMessageId
  })));
  assert.equal(delivered.filter((result) => result.status === 'fulfilled').length, 1);
  detail = await h.service.getNotification(h.actor(), item.id);
  assert.equal(detail.deliveryAttempts.length, 1);
  assert.equal(detail.channelIntents.find((entry) => entry.id === intent.id)?.attempts, 1);
});

test('Notification create checks every recipient scope rather than only the first', async () => {
  const h = memoryHarness();
  const actor = h.actor();
  const scoped = { ...actor, authorize: async (permissionCode: string, resource?: import('../src/platform/authorization/index.ts').AuthorizationResource) => ({
    ...await actor.authorize(permissionCode, resource), allowed: resource?.ownerPersonId !== IDS.outsider
  }) };
  await assert.rejects(createWorkgroupNotification({ ...h, actor: () => scoped }, {
    recipients: [{ recipientType: 'person', recipientId: IDS.recipientA }, { recipientType: 'person', recipientId: IDS.outsider }]
  }), notificationCode('NOTIFICATION_PERMISSION_DENIED'));
  assert.equal((await h.repository.listNotifications()).length, 0);
});

async function seedPeople(client: { query(text: string, values?: readonly unknown[]): Promise<unknown> }) {
  await client.query(
     `INSERT INTO platform_organization_units (id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at)
     VALUES
       ($1,NULL,'company','运营公司',NULL,'company','active',1,$4,$4),
       ($2,$1,'afc-team','AFC检修工班',NULL,'workgroup','active',2,$4,$4),
       ($3,$2,'afc-child-team','AFC下级工班',NULL,'workgroup','active',3,$4,$4)`,
    [IDS.company, IDS.workgroup, IDS.childWorkgroup, NOW]
  );
  await client.query(
    `INSERT INTO platform_positions (id,code,name,description,status,created_at,updated_at)
     VALUES ($1,'afc-maintainer','AFC检修工',NULL,'active',$2,$2)`,
    [IDS.position, NOW]
  );
  await client.query(
    `INSERT INTO platform_people (id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at)
     VALUES
       ($1,'06010001','创建人',NULL,$6,$7,'active',NULL,$8,$8),
       ($2,'06010002','检修工甲',NULL,$5,$7,'active',NULL,$8,$8),
       ($3,'06010003','检修工乙',NULL,$5,$7,'active',NULL,$8,$8),
       ($4,'06010004','下级工班人员',NULL,$9,$7,'active',NULL,$8,$8)`,
    [IDS.creator, IDS.recipientA, IDS.recipientB, IDS.childMember, IDS.workgroup, IDS.company, IDS.position, NOW, IDS.childWorkgroup]
  );
}

void PLATFORM_NOTIFICATION_SQL;
