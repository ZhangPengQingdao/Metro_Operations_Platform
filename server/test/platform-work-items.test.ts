import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { CORE_EVENTS_MIGRATIONS, createMemoryCoreOutboxRepository, createPostgresCoreOutboxRepository, type CoreEventPayload, type CoreOutboxRecord, type CoreOutboxRepository, type EnqueueCoreOutboxEventInput } from '../src/core/events/index.ts';
import { runAtomicOperation, runDatabaseTransaction, type QueryableClient } from '../src/core/database/index.ts';
import { PLATFORM_ASSET_DIRECTORY_MIGRATIONS } from '../src/platform/assets/index.ts';
import { PLATFORM_AUTHORIZATION_MIGRATIONS } from '../src/platform/authorization/index.ts';
import type { AuthorizationDecision } from '../src/platform/authorization/index.ts';
import type { PlatformActorContext, PlatformExecution } from '../src/platform/context/index.ts';
import { PLATFORM_LOCATION_DIRECTORY_MIGRATIONS } from '../src/platform/locations/index.ts';
import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS } from '../src/platform/people/index.ts';
import { PLATFORM_RESPONSIBILITY_MIGRATIONS, RESPONSIBILITY_AREA_SEEDS } from '../src/platform/responsibility/index.ts';
import {
  PLATFORM_WORK_ITEM_MIGRATIONS,
  PLATFORM_WORK_ITEM_SQL,
  WORK_ITEM_EVENT_TYPES,
  WORK_ITEM_PERMISSION_CODES,
  WorkItemError,
  createMemoryWorkItemRepository,
  createPostgresWorkItemRepository,
  createWorkItemService,
  enumerateDueOccurrences,
  reconcileLegacyWorkItems,
  type WorkItemRepository
} from '../src/platform/work-items/index.ts';

const IDS = {
  company: '46000000-0000-4000-8000-000000000001',
  operationsCenter: '46000000-0000-4000-8000-000000000002',
  workgroup: '46000000-0000-4000-8000-000000000003',
  childWorkgroup: '46000000-0000-4000-8000-000000000004',
  otherWorkgroup: '46000000-0000-4000-8000-000000000005',
  position: '46000000-0000-4000-8000-000000000006',
  creator: '46000000-0000-4000-8000-000000000011',
  maintainer: '46000000-0000-4000-8000-000000000012',
  assignee: '46000000-0000-4000-8000-000000000013',
  childMember: '46000000-0000-4000-8000-000000000014',
  outsider: '46000000-0000-4000-8000-000000000015',
  station: '46000000-0000-4000-8000-000000000021',
  asset: '46000000-0000-4000-8000-000000000022',
  retiredAsset: '46000000-0000-4000-8000-000000000023',
  batch: '46000000-0000-4000-8000-000000000031'
} as const;

const RESPONSIBILITY_AREA_ID = RESPONSIBILITY_AREA_SEEDS[0].id;
const ALL_PERMISSIONS = new Set(Object.values(WORK_ITEM_PERMISSION_CODES));
const NO_PERMISSIONS = new Set<string>();
const SOURCE = { appId: 'online_todo', entityType: 'todo_task', entityId: 'task-1' };
const NOW = '2026-08-31T02:00:00.000Z';

const organizations = new Map<string, { status: string; unitType: string }>([
  [IDS.company, { status: 'active', unitType: 'company' }],
  [IDS.operationsCenter, { status: 'active', unitType: 'operations_center' }],
  [IDS.workgroup, { status: 'active', unitType: 'workgroup' }],
  [IDS.childWorkgroup, { status: 'active', unitType: 'workgroup' }],
  [IDS.otherWorkgroup, { status: 'active', unitType: 'workgroup' }]
]);

const people = new Map<string, { organizationUnitId: string; employmentStatus: string; employeeNo: string; name: string }>([
  [IDS.creator, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06010001', name: '创建人' }],
  [IDS.maintainer, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06010002', name: '检修工' }],
  [IDS.assignee, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06010003', name: '指定办理人' }],
  [IDS.childMember, { organizationUnitId: IDS.childWorkgroup, employmentStatus: 'active', employeeNo: '06010004', name: '下级工班人员' }],
  [IDS.outsider, { organizationUnitId: IDS.otherWorkgroup, employmentStatus: 'active', employeeNo: '06010005', name: '外部人员' }]
]);

const locations = new Map<string, { status: string }>([[IDS.station, { status: 'active' }]]);
const assets = new Map<string, { lifecycleState: string }>([
  [IDS.asset, { lifecycleState: 'active' }],
  [IDS.retiredAsset, { lifecycleState: 'retired' }]
]);

function memoryHarness(startAt = NOW) {
  const repository = createMemoryWorkItemRepository();
  const outbox = createMemoryCoreOutboxRepository();
  return harness(repository, outbox, startAt);
}

function harness<T extends CoreOutboxRepository | undefined>(
  repository: WorkItemRepository,
  outbox: T,
  startAt: string
) {
  let now = new Date(startAt);
  let idSequence = 100;
  let eventSequence = 900;
  const service = createWorkItemService(repository, {
    clock: () => new Date(now),
    createId: () => `46000000-0000-4000-8000-${String(idSequence++).padStart(12, '0')}`,
    createEventId: () => `47000000-0000-4000-8000-${String(eventSequence++).padStart(12, '0')}`,
    outbox,
    findPerson: async (id) => people.get(id) ?? null,
    findOrganizationUnit: async (id) => organizations.get(id) ?? null,
    listActiveOrganizationMembers: async (organizationUnitId) => [...people.entries()]
      .filter(([, person]) => person.organizationUnitId === organizationUnitId && person.employmentStatus === 'active')
      .map(([id, person]) => ({ id, organizationUnitId: person.organizationUnitId, employmentStatus: person.employmentStatus })),
    findLocation: async (id) => locations.get(id) ?? null,
    findAsset: async (id) => assets.get(id) ?? null,
    findResponsibilityArea: async (id) => id === RESPONSIBILITY_AREA_ID ? { status: 'active' } : null
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
      organization: { id: person.organizationUnitId, code: 'afc-team', name: 'AFC检修工班', unitType: 'workgroup' },
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

function workItemCode(code: string) {
  return (error: unknown) => error instanceof WorkItemError && error.code === code;
}

function display(title = '检查 AFC 设备') {
  return { title, summary: null, sourceLabel: '统一待办' };
}

function navigation() {
  return { href: '/todos/task-1', routeName: 'todo.detail', params: { id: 'task-1' } };
}

async function createOrgWorkItem(h = memoryHarness(), overrides: Partial<Parameters<ReturnType<typeof createWorkItemService>['createWorkItem']>[1]> = {}) {
  return h.service.createWorkItem(h.actor(), {
    source: SOURCE,
    idempotencyKey: 'org-work-item',
    display: display(),
    navigation: navigation(),
    responsibilityAreaId: RESPONSIBILITY_AREA_ID,
    target: { type: 'location', id: IDS.station, displayName: '薛家岛站' },
    candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }],
    ...overrides
  });
}

test('WorkItem create is idempotent, app-scoped, validated, and emits only a lightweight created event', async () => {
  const h = memoryHarness();
  const first = await h.service.createWorkItem(h.actor(), {
    source: SOURCE,
    idempotencyKey: 'create-1',
    display: display(),
    navigation: navigation(),
    responsibilityAreaId: RESPONSIBILITY_AREA_ID,
    target: { type: 'location', id: IDS.station, displayName: '薛家岛站' },
    candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }]
  });
  const second = await h.service.createWorkItem(h.actor(), {
    source: SOURCE,
    idempotencyKey: 'create-1',
    display: display(),
    navigation: navigation(),
    responsibilityAreaId: RESPONSIBILITY_AREA_ID,
    target: { type: 'location', id: IDS.station, displayName: '薛家岛站' },
    candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }]
  });

  assert.equal(second.id, first.id);
  assert.equal(h.outbox?.records().length, 1);
  const event = h.outbox?.records()[0].event;
  assert.equal(event?.type, WORK_ITEM_EVENT_TYPES.created);
  assert.equal((event?.payload as Record<string, unknown>).workItemId, first.id);
  assert.equal((event?.payload as Record<string, unknown>).sourceAppId, SOURCE.appId);
  assert.equal(Object.hasOwn(event?.payload as object, 'display'), false);
  assert.equal(Object.hasOwn(event?.payload as object, 'before'), false);

  await assert.rejects(
    h.service.createWorkItem(h.actor(), {
      source: SOURCE,
      idempotencyKey: 'create-1',
      display: display('改标题'),
      candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }]
    }),
    workItemCode('IDEMPOTENCY_CONFLICT')
  );
  await assert.rejects(
    h.service.createWorkItem(h.actor(IDS.creator, ALL_PERMISSIONS, { type: 'application', appId: 'other_app' }), {
      source: SOURCE,
      display: display(),
      candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }]
    }),
    workItemCode('SOURCE_APP_MISMATCH')
  );
  await assert.rejects(
    h.service.createWorkItem(h.actor(), {
      source: SOURCE,
      display: display(),
      target: { type: 'asset', id: IDS.retiredAsset, displayName: '退役设备' }
    }),
    workItemCode('ASSET_RETIRED')
  );
});

test('direct workgroup candidates can see, progress, and complete unassigned WorkItems without claim', async () => {
  const h = memoryHarness();
  const item = await createOrgWorkItem(h, { currentAssigneePersonId: null });

  assert.deepEqual((await h.service.listWorkItems(h.actor(IDS.maintainer, NO_PERMISSIONS))).map((entry) => entry.id), [item.id]);
  await assert.rejects(h.service.getWorkItem(h.actor(IDS.childMember, NO_PERMISSIONS), item.id), workItemCode('WORK_ITEM_ACCESS_DENIED'));

  const progressed = await h.service.updateProgress(h.actor(IDS.maintainer, NO_PERMISSIONS), {
    workItemId: item.id,
    progressPercent: 40
  });
  assert.equal(progressed.status, 'in_progress');
  const completed = await h.service.completeWorkItem(h.actor(IDS.maintainer, NO_PERMISSIONS), { workItemId: item.id });
  const detail = await h.service.getWorkItem(h.actor(IDS.maintainer, NO_PERMISSIONS), item.id);

  assert.equal(completed.status, 'completed');
  assert.equal(detail.progressHistory[0].updaterPersonId, IDS.maintainer);
  assert.equal(detail.assignmentHistory.length, 0);
  assert.equal(detail.completion?.assignedPersonId, null);
  assert.equal(detail.completion?.actualCompleterPersonId, IDS.maintainer);
  assert.equal(detail.completion?.onBehalf, false);
});

test('completion on behalf is explicit permission while note is optional and never mandatory', async () => {
  const h = memoryHarness();
  const item = await createOrgWorkItem(h, {
    currentAssigneePersonId: IDS.assignee,
    candidates: [{ candidateType: 'person', candidateId: IDS.assignee }]
  });

  await assert.rejects(
    h.service.completeWorkItem(h.actor(IDS.outsider, NO_PERMISSIONS), {
      workItemId: item.id,
      onBehalfOfPersonId: IDS.assignee
    }),
    workItemCode('WORK_ITEM_PERMISSION_DENIED')
  );

  await h.service.completeWorkItem(h.actor(IDS.creator, new Set([WORK_ITEM_PERMISSION_CODES.completeOnBehalf])), {
    workItemId: item.id,
    onBehalfOfPersonId: IDS.assignee
  });
  const detail = await h.service.getWorkItem(h.actor(IDS.creator), item.id);
  assert.equal(detail.completion?.onBehalf, true);
  assert.equal(detail.completion?.onBehalfOfPersonId, IDS.assignee);
  assert.equal(detail.completion?.note, null);
  assert.deepEqual(detail.assignmentHistory.map((entry) => entry.action), ['completed_on_behalf']);
});

test('batches group WorkItems but do not create hidden subtask or dependency semantics', async () => {
  const h = memoryHarness();
  const { batch, workItems } = await h.service.createBatch(h.actor(), {
    id: IDS.batch,
    source: { appId: 'drill', entityType: 'exercise', entityId: 'drill-1' },
    idempotencyKey: 'batch-1',
    display: display('月度演练批次'),
    defaultDueAt: new Date('2026-09-30T09:00:00+08:00'),
    items: [
      {
        display: display('演练发起'),
        candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }]
      },
      {
        display: display('演练归档'),
        dueAt: new Date('2026-10-01T09:00:00+08:00'),
        candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }]
      }
    ]
  });

  assert.equal(batch.status, 'open');
  assert.equal(workItems.length, 2);
  assert.equal(workItems.every((item) => item.batchId === IDS.batch), true);
  assert.equal(Object.hasOwn(workItems[0] as object, 'parentWorkItemId'), false);
  assert.equal(Object.hasOwn(workItems[0] as object, 'dependsOnWorkItemId'), false);

  await h.service.completeWorkItem(h.actor(IDS.maintainer, NO_PERMISSIONS), { workItemId: workItems[0].id });
  assert.equal((await h.repository.findBatchById(IDS.batch))?.status, 'open');
  await h.service.cancelWorkItem(h.actor(), { workItemId: workItems[1].id });
  assert.equal((await h.repository.findBatchById(IDS.batch))?.status, 'closed');
  await h.service.reopenWorkItem(h.actor(), { workItemId: workItems[1].id });
  assert.equal((await h.repository.findBatchById(IDS.batch))?.status, 'open');
  const cancelledDetail = await h.service.getWorkItem(h.actor(), workItems[1].id);
  assert.equal(cancelledDetail.operationHistory.at(-1)?.operation, 'reopened');
  assert.equal(cancelledDetail.operationHistory.at(-1)?.note, null);
  await assert.rejects(h.service.deleteWorkItem(), workItemCode('HARD_DELETE_NOT_SUPPORTED'));
});

test('recurrence uses Asia/Shanghai daily schedules, compensation policies, and no cron or RRULE parser', async () => {
  const h = memoryHarness('2026-09-01T00:00:00+08:00');
  const rule = await h.service.createRecurrenceRule(h.actor(), {
    source: { appId: 'safety', entityType: 'daily_check_template', entityId: 'template-1' },
    idempotencyKey: 'rule-latest',
    schedule: { type: 'daily', triggerMinuteOfDay: 9 * 60 },
    missedOccurrencePolicy: 'latest_only',
    dueAfterMinutes: 120,
    display: display('每日安全检查'),
    candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }],
    startAt: new Date('2026-09-01T00:00:00+08:00')
  });
  const generated = await h.service.generateDueRecurrences(h.actor(), { now: new Date('2026-09-03T10:00:00+08:00') });
  assert.equal(generated.checkedRules, 1);
  assert.deepEqual(generated.generatedWorkItemIds.length, 1);
  assert.equal(generated.skippedOccurrences, 2);
  const item = await h.repository.findWorkItemById(generated.generatedWorkItemIds[0]);
  assert.equal(item?.recurrenceRuleId, rule.id);
  assert.equal(item?.recurrenceScheduledAt, '2026-09-03T01:00:00.000Z');
  assert.equal(item?.dueAt, '2026-09-03T03:00:00.000Z');
  assert.equal((await h.repository.findRecurrenceRuleById(rule.id))?.lastGeneratedScheduledAt, '2026-09-03T01:00:00.000Z');
  assert.equal((await h.service.generateDueRecurrences(h.actor(), { now: new Date('2026-09-03T10:00:00+08:00') })).generatedWorkItemIds.length, 0);

  const skipHarness = memoryHarness('2026-09-01T00:00:00+08:00');
  await skipHarness.service.createRecurrenceRule(skipHarness.actor(), {
    source: { appId: 'safety', entityType: 'daily_check_template', entityId: 'template-skip' },
    idempotencyKey: 'rule-skip',
    schedule: { type: 'daily', triggerMinuteOfDay: 9 * 60 },
    missedOccurrencePolicy: 'skip',
    display: display('每日跳过策略'),
    candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }],
    startAt: new Date('2026-09-01T00:00:00+08:00')
  });
  const skipped = await skipHarness.service.generateDueRecurrences(skipHarness.actor(), { now: new Date('2026-09-03T10:00:00+08:00') });
  assert.equal(skipped.generatedWorkItemIds.length, 0);
  assert.equal(skipped.skippedOccurrences, 3);
  assert.equal(skipHarness.outbox?.records()[0].event.type, WORK_ITEM_EVENT_TYPES.recurrenceGenerationSkipped);

  assert.deepEqual(
    enumerateDueOccurrences(
      { type: 'monthly', dayOfMonth: 'last_day', triggerMinuteOfDay: 8 * 60 },
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-03-31T00:00:00.000Z')
    ).map((date) => date.toISOString()),
    ['2026-01-31T00:00:00.000Z', '2026-02-28T00:00:00.000Z', '2026-03-31T00:00:00.000Z']
  );
  assert.deepEqual(
    enumerateDueOccurrences(
      { type: 'monthly', dayOfMonth: 31, triggerMinuteOfDay: 8 * 60 },
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-03-31T00:00:00.000Z')
    ).map((date) => date.toISOString()),
    ['2026-01-31T00:00:00.000Z', '2026-03-31T00:00:00.000Z']
  );
  await assert.rejects(
    h.service.createRecurrenceRule(h.actor(), {
      source: { appId: 'safety', entityType: 'bad_template', entityId: 'template-cron' },
      schedule: { type: 'cron', expression: '0 0 * * *' } as never,
      display: display()
    }),
    workItemCode('INVALID_RECURRENCE_TYPE')
  );
});

test('WorkItem migration is L3-only, additive, and grants explicit platform permissions', () => {
  const migration = PLATFORM_WORK_ITEM_MIGRATIONS[0];
  assert.equal(migration.layer, 'L3');
  assert.equal(migration.ownerTaskId, 'PLATFORM-L3-008');
  assert.deepEqual(migration.dependsOn, [
    'core-events-outbox-expand',
    'platform-people-directory-expand',
    'platform-responsibility-expand',
    'platform-authorization-expand'
  ]);
  assert.deepEqual(migration.sourceTables, ['recurring_task_templates', 'todo_tasks', 'todo_items']);
  assert.match(PLATFORM_WORK_ITEM_SQL, /platform_work_items_occurrence_idx/);
  assert.match(PLATFORM_WORK_ITEM_SQL, /platform\.work_items\.complete_on_behalf/);
  assert.doesNotMatch(PLATFORM_WORK_ITEM_SQL, /(fastify|router|\/api\/|notification|wecom|mcp|prompt)/i);
});

test('WorkItem migration and PostgreSQL repository run twice in isolated PGlite', async () => {
  const database = new PGlite();
  let failOutbox = false;
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      if (!values && text.includes(';')) return database.exec(text);
      const result = await database.query(text, values ? [...values] : undefined);
      if (failOutbox && text.includes('INSERT INTO core_outbox_events')) throw new Error('pg-outbox-fault');
      return result;
    }
  };

  try {
    await CORE_EVENTS_MIGRATIONS[0].run({ client });
    await PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_LOCATION_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_ASSET_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_RESPONSIBILITY_MIGRATIONS[0].run({ client });
    await PLATFORM_AUTHORIZATION_MIGRATIONS[0].run({ client });
    await PLATFORM_WORK_ITEM_MIGRATIONS[0].run({ client });
    await PLATFORM_WORK_ITEM_MIGRATIONS[0].run({ client });
    await database.query(
      `INSERT INTO platform_organization_units(id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at)
       VALUES($1,NULL,'company','公司',NULL,'company','active',0,NOW(),NOW()),
             ($2,$1,'afc-team','AFC工班',NULL,'workgroup','active',1,NOW(),NOW())`,
      [IDS.company, IDS.workgroup]
    );
    await database.query(
      `INSERT INTO platform_positions(id,code,name,description,status,created_at,updated_at)
       VALUES($1,'afc-maintainer','AFC检修工',NULL,'active',NOW(),NOW())`,
      [IDS.position]
    );
    await database.query(
      `INSERT INTO platform_people(id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at)
       VALUES($1,'06010001','创建人',NULL,$2,$3,'active',NULL,NOW(),NOW()),
             ($4,'06010002','检修工',NULL,$2,$3,'active',NULL,NOW(),NOW())`,
      [IDS.creator, IDS.workgroup, IDS.position, IDS.maintainer]
    );

    const repository = createPostgresWorkItemRepository(client);
    const h = harness(repository, createPostgresCoreOutboxRepository(client), NOW);
    const created = await h.service.createWorkItem(h.actor(), {
      source: SOURCE,
      idempotencyKey: 'pg-item-1',
      display: display(),
      candidates: [{ candidateType: 'organization_unit', candidateId: IDS.workgroup }],
      currentAssigneePersonId: IDS.maintainer
    });
    assert.equal((await repository.listWorkItems({ status: ['pending', 'in_progress'] })).length, 1);
    await h.service.updateProgress(h.actor(IDS.maintainer, NO_PERMISSIONS), { workItemId: created.id, progressPercent: 100 });
    await h.service.completeWorkItem(h.actor(IDS.maintainer, NO_PERMISSIONS), { workItemId: created.id });
    const detail = await h.service.getWorkItem(h.actor(), created.id);
    assert.equal(detail.item.status, 'completed');
    assert.equal(detail.completion?.actualCompleterPersonId, IDS.maintainer);
    assert.deepEqual(detail.operationHistory.map((entry) => entry.operation), ['created', 'progress_updated', 'completed']);
    // An inner repository BEGIN/COMMIT must not escape the command rollback.
    failOutbox = true;
    const retryInput = { source: SOURCE, idempotencyKey: 'pg-atomic-retry', display: display(), currentAssigneePersonId: IDS.maintainer };
    await assert.rejects(h.service.createWorkItem(h.actor(), retryInput), /pg-outbox-fault/);
    assert.equal(await repository.findWorkItemByIdempotencyKey(SOURCE.appId, 'work_item', 'pg-atomic-retry'), null);
    assert.equal((await database.query('SELECT * FROM platform_work_item_operation_history')).rows.length, 3);
    assert.equal((await database.query('SELECT * FROM core_outbox_events')).rows.length, 3);
    failOutbox = false;
    const retried = await h.service.createWorkItem(h.actor(), retryInput);
    assert.equal((await h.service.createWorkItem(h.actor(), retryInput)).id, retried.id);
    const parallel = await Promise.allSettled([
      h.service.completeWorkItem(h.actor(IDS.maintainer, NO_PERMISSIONS), { workItemId: retried.id, note: 'pg-first' }),
      h.service.completeWorkItem(h.actor(IDS.maintainer, NO_PERMISSIONS), { workItemId: retried.id, note: 'pg-stale' })
    ]);
    assert.equal(parallel.filter((result) => result.status === 'fulfilled').length, 1);
    const retriedDetail = await h.service.getWorkItem(h.actor(), retried.id);
    assert.equal(retriedDetail.completion?.note, 'pg-first');
    assert.deepEqual(retriedDetail.operationHistory.map((record) => record.operation), ['created', 'completed']);
    assert.equal((await database.query('SELECT * FROM core_outbox_events')).rows.length, 5);
    const permissionRows = await database.query(
      `SELECT COUNT(*)::int AS count FROM platform_permissions WHERE code LIKE 'platform.work_items.%'`
    );
    assert.equal((permissionRows.rows[0] as { count: number }).count, Object.keys(WORK_ITEM_PERMISSION_CODES).length);
  } finally {
    await database.close();
  }
});

test('legacy todo reconciliation preserves batch/item/deep-link references and reports unsafe rows', () => {
  const report = reconcileLegacyWorkItems({
    tasks: [{ id: 'task-1', title: '巡检任务' }],
    items: [
      { id: 'item-1', taskId: 'task-1', handlerId: IDS.maintainer, status: 'done', completedAt: '2026-08-31T01:00:00.000Z', deepLink: '/todos/item-1' },
      { id: 'item-2', taskId: 'missing-task', handlerId: null, status: 'unknown' }
    ],
    recurringTemplates: [
      { id: 'tpl-1', recurrenceType: 'daily', enabled: true },
      { id: 'tpl-2', recurrenceType: 'cron', enabled: true }
    ]
  });
  assert.equal(report.batchCount, 1);
  assert.equal(report.workItemCount, 2);
  assert.equal(report.completedCount, 1);
  assert.equal(report.deepLinkCount, 1);
  assert.deepEqual(report.preservedBatchIds, ['task-1']);
  assert.deepEqual(report.preservedWorkItemIds, ['item-1', 'item-2']);
  assert.deepEqual(report.issues.map((issue) => issue.code), [
    'MISSING_BATCH',
    'UNKNOWN_STATUS',
    'ITEM_WITHOUT_HANDLER',
    'INVALID_RECURRENCE_TYPE'
  ]);
});

test('idempotent WorkItem, batch and recurrence retries require current create scope before disclosure', async () => {
  const h = memoryHarness();
  const input = { source: SOURCE, idempotencyKey: 'retry-private', display: display(), target: { type: 'organization' as const, id: IDS.workgroup, displayName: null } };
  await h.service.createWorkItem(h.actor(), input);
  await assert.rejects(h.service.createWorkItem(h.actor(IDS.outsider, NO_PERMISSIONS), input), workItemCode('WORK_ITEM_PERMISSION_DENIED'));
  const batchInput = { source: SOURCE, idempotencyKey: 'retry-batch', display: display(), items: [{ display: display(), target: input.target }] };
  await h.service.createBatch(h.actor(), batchInput);
  await assert.rejects(h.service.createBatch(h.actor(IDS.outsider, NO_PERMISSIONS), batchInput), workItemCode('WORK_ITEM_PERMISSION_DENIED'));
  const ruleInput = { ...input, schedule: { type: 'daily' as const, triggerMinuteOfDay: 540 }, startAt: new Date(NOW) };
  await h.service.createRecurrenceRule(h.actor(), ruleInput);
  await assert.rejects(h.service.createRecurrenceRule(h.actor(IDS.outsider, NO_PERMISSIONS), ruleInput), workItemCode('WORK_ITEM_PERMISSION_DENIED'));
});

test('batch creation applies single-item resource scope to every item and never leaves a prefix', async () => {
  const h = memoryHarness();
  const scoped = h.actor();
  const original = scoped.authorize;
  scoped.authorize = async (permission, resource) => ({
    ...await original(permission, resource),
    allowed: resource?.organizationUnitId !== IDS.otherWorkgroup
  });
  const item = { display: display(), target: { type: 'organization' as const, id: IDS.otherWorkgroup, displayName: null } };
  await assert.rejects(h.service.createWorkItem(scoped, { source: SOURCE, ...item }), workItemCode('WORK_ITEM_PERMISSION_DENIED'));
  await assert.rejects(h.service.createBatch(scoped, { source: SOURCE, display: display(), items: [{ display: display() }, item] }), workItemCode('WORK_ITEM_PERMISSION_DENIED'));
  assert.equal((await h.repository.listWorkItems()).length, 0);
  const bad = { source: SOURCE, idempotencyKey: 'invalid-batch', display: display(), items: [
    { display: display() }, { display: display(), currentAssigneePersonId: '46000000-0000-4000-8000-000000000099' }
  ] };
  await assert.rejects(h.service.createBatch(h.actor(), bad), workItemCode('PERSON_NOT_FOUND'));
  assert.equal(await h.repository.findBatchByIdempotencyKey(SOURCE.appId, 'invalid-batch'), null);
  assert.equal((await h.repository.listWorkItems()).length, 0);
});

test('memory command rolls back data/history/events on Outbox or history failure then retries once', async () => {
  const repository = createMemoryWorkItemRepository();
  const outbox = createMemoryCoreOutboxRepository();
  let fail = true;
  const faultingOutbox: CoreOutboxRepository = { ...outbox, async enqueue<TPayload extends CoreEventPayload>(input: EnqueueCoreOutboxEventInput<TPayload>): Promise<CoreOutboxRecord<TPayload>> {
    const result = await outbox.enqueue(input);
    if (fail) throw new Error('outbox-fault');
    return result;
  } };
  // Wrap a post-enqueue failure, including rollback of the already inserted event.
  const h = harness(repository, faultingOutbox, NOW);
  const input = { source: SOURCE, idempotencyKey: 'atomic-retry', display: display() };
  await assert.rejects(h.service.createWorkItem(h.actor(), input), /outbox-fault/);
  assert.equal(repository.records().items.length, 0);
  assert.equal(repository.records().operationHistory.length, 0);
  assert.equal(outbox.records().length, 0);
  fail = false;
  const created = await h.service.createWorkItem(h.actor(), input);
  assert.equal((await h.service.createWorkItem(h.actor(), input)).id, created.id);
  assert.equal(outbox.records().length, 1);
  const badHistory = harness({ ...repository, async addOperationHistory(record) {
    await repository.addOperationHistory(record);
    throw new Error('history-fault');
  } }, outbox, NOW);
  await assert.rejects(badHistory.service.cancelWorkItem(h.actor(), { workItemId: created.id }), /history-fault/);
  assert.equal((await repository.findWorkItemById(created.id))?.status, 'pending');
  assert.equal(repository.records().operationHistory.length, 1);
  assert.equal(outbox.records().length, 1);
});

test('competing complete/cancel/progress commands cannot overwrite completion evidence', async () => {
  const h = memoryHarness();
  const item = await createOrgWorkItem(h);
  const outcomes = await Promise.allSettled([
    h.service.completeWorkItem(h.actor(IDS.maintainer, NO_PERMISSIONS), { workItemId: item.id, note: 'first evidence' }),
    h.service.completeWorkItem(h.actor(IDS.assignee, NO_PERMISSIONS), { workItemId: item.id, note: 'second evidence' }),
    h.service.cancelWorkItem(h.actor(), { workItemId: item.id }),
    h.service.updateProgress(h.actor(), { workItemId: item.id, note: 'stale progress' })
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const detail = await h.service.getWorkItem(h.actor(), item.id);
  assert.equal(detail.completion?.note, 'first evidence');
  assert.deepEqual(detail.operationHistory.map((record) => record.operation), ['created', 'completed']);
  assert.equal(h.outbox.records().filter((record) => record.event.type === WORK_ITEM_EVENT_TYPES.completed).length, 1);
});

test('recurrence keyset pages visit every rule beyond default 100 and repeated scans are idempotent', async () => {
  const h = memoryHarness('2026-09-01T00:00:00+08:00');
  for (let index = 0; index < 103; index++) await h.service.createRecurrenceRule(h.actor(), {
    source: SOURCE, idempotencyKey: 'fair-' + index, display: display(),
    schedule: { type: 'daily', triggerMinuteOfDay: 540 }, missedOccurrencePolicy: 'latest_only',
    startAt: new Date('2026-09-01T00:00:00+08:00')
  });
  const now = new Date('2026-09-02T10:00:00+08:00');
  const generated = await h.service.generateDueRecurrences(h.actor(), { now });
  assert.equal(generated.checkedRules, 103);
  assert.equal(generated.generatedWorkItemIds.length, 103);
  const retry = await h.service.generateDueRecurrences(h.actor(), { now, maxRules: 1 });
  assert.equal(retry.checkedRules, 103);
  assert.equal(retry.generatedWorkItemIds.length, 0);
});

test('Core atomic contract rejects incompatible connections and caught nested failure cannot commit', async () => {
  const queries: string[] = [];
  const client = { async query(sql: string) { queries.push(sql); return { rows: [] }; } };
  await assert.rejects(runAtomicOperation([{ atomic: { client } }, createMemoryCoreOutboxRepository()], async () => {}), /ATOMIC_CONNECTION_MISMATCH/);
  await assert.rejects(runAtomicOperation([{ atomic: { client } }, { atomic: { client: { query: client.query } } }], async () => {}), /ATOMIC_CONNECTION_MISMATCH/);
  await assert.rejects(runDatabaseTransaction({ ...client, connect: async () => client } as QueryableClient, async () => {}), /DEDICATED_TRANSACTION_CLIENT_REQUIRED/);
  assert.deepEqual(queries, []);
  await assert.rejects(runDatabaseTransaction(client, async () => {
    try { await runDatabaseTransaction(client, async () => { throw new Error('inner-fault'); }); } catch {}
  }), /TRANSACTION_ABORTED/);
  assert.deepEqual(queries, ['BEGIN', 'ROLLBACK']);
});

test('escaped async transaction contexts reject writes after commit or memory unlock', async () => {
  const queries: string[] = [];
  const client = { async query(sql: string) { queries.push(sql); return { rows: [] }; } };
  let release!: () => void;
  let escaped!: Promise<unknown>;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await runDatabaseTransaction(client, async () => {
    escaped = gate.then(() => runDatabaseTransaction(client, async () => { await client.query('BAD WRITE'); }));
  });
  release();
  await assert.rejects(escaped, /ATOMIC_CONTEXT_CLOSED/);
  assert.deepEqual(queries, ['BEGIN', 'COMMIT']);
  const repository = createMemoryWorkItemRepository();
  let releaseMemory!: () => void;
  const memoryGate = new Promise<void>((resolve) => { releaseMemory = resolve; });
  await runAtomicOperation([repository], async () => {
    escaped = memoryGate.then(() => runAtomicOperation([repository], async () => {}));
  });
  releaseMemory();
  await assert.rejects(escaped, /ATOMIC_CONTEXT_CLOSED/);
});

test('memory readers and Outbox claims wait for failed command rollback, no dirty reads', async () => {
  const repository = createMemoryWorkItemRepository();
  const outbox = createMemoryCoreOutboxRepository();
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ ...repository, async addOperationHistory(record) {
    const saved = await repository.addOperationHistory(record);
    entered();
    await gate;
    throw new Error('late-history-fault');
  } }, outbox, NOW);
  const writing = h.service.createWorkItem(h.actor(), { source: SOURCE, display: display() });
  await ready;
  let readResolved = false;
  const reading = h.service.listWorkItems(h.actor()).then((value) => { readResolved = true; return value; });
  const claiming = outbox.claimBatch();
  await Promise.resolve();
  assert.equal(readResolved, false);
  release();
  await assert.rejects(writing, /late-history-fault/);
  assert.deepEqual(await reading, []);
  assert.deepEqual(await claiming, []);
});
