import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PLATFORM_AUTHORIZATION_MIGRATIONS, type AuthorizationDecision } from '../src/platform/authorization/index.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';
import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS } from '../src/platform/people/index.ts';
import { FixedClock, toPlatformInstant } from '../src/core/time/index.ts';
import {
  DUTY_PERMISSION_CODES,
  PLATFORM_DUTY_MIGRATIONS,
  PLATFORM_DUTY_SQL,
  STANDARD_DUTY_STATUS_SEEDS,
  STANDARD_SHIFT_TYPE_SEEDS,
  DutyError,
  createDutyService,
  createMemoryDutyRepository,
  createPostgresDutyRepository,
  reconcileLegacyDutyEvidence,
  type DutyAssignment,
  type DutyOperationHistory,
  type DutyPeriod,
  type DutyRepository,
  type TemporaryReplacement
} from '../src/platform/duty/index.ts';

const IDS = {
  company: '52000000-0000-4000-8000-000000000001',
  workgroup: '52000000-0000-4000-8000-000000000002',
  otherWorkgroup: '52000000-0000-4000-8000-000000000003',
  position: '52000000-0000-4000-8000-000000000004',
  manager: '52000000-0000-4000-8000-000000000011',
  personA: '52000000-0000-4000-8000-000000000012',
  personB: '52000000-0000-4000-8000-000000000013',
  outsider: '52000000-0000-4000-8000-000000000014',
  inactive: '52000000-0000-4000-8000-000000000015'
} as const;

const NOW = new Date('2026-09-01T00:00:00.000Z');
const ALL_PERMISSIONS = new Set(Object.values(DUTY_PERMISSION_CODES));
const NO_PERMISSIONS = new Set<string>();
const organizations = new Map([
  [IDS.company, { status: 'active' }],
  [IDS.workgroup, { status: 'active' }],
  [IDS.otherWorkgroup, { status: 'active' }]
]);
type TestDirectoryPerson = { organizationUnitId: string; employmentStatus: string; employeeNo: string; name: string };

const people = new Map<string, TestDirectoryPerson>([
  [IDS.manager, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06000001', name: '排班管理人' }],
  [IDS.personA, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06000002', name: '甲' }],
  [IDS.personB, { organizationUnitId: IDS.workgroup, employmentStatus: 'active', employeeNo: '06000003', name: '乙' }],
  [IDS.outsider, { organizationUnitId: IDS.otherWorkgroup, employmentStatus: 'active', employeeNo: '06000004', name: '外部人员' }],
  [IDS.inactive, { organizationUnitId: IDS.workgroup, employmentStatus: 'inactive', employeeNo: '06000005', name: '离岗人员' }]
]);

function harness(repository: DutyRepository = createMemoryDutyRepository(), directoryPeople: Map<string, TestDirectoryPerson> = people) {
  let sequence = 100;
  const clock = new FixedClock(NOW);
  const service = createDutyService(repository, {
    clock,
    createId: () => `52100000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    findPerson: async (id) => directoryPeople.get(id) ?? null,
    findOrganizationUnit: async (id) => organizations.get(id) ?? null
  });
  return {
    repository,
    service,
    clock,
    actor(personId = IDS.manager, allowed = ALL_PERMISSIONS): PlatformActorContext {
      const person = directoryPeople.get(personId);
      assert.ok(person);
      return {
        actorType: 'person',
        trustedIdentity: { source: 'session', userId: personId },
        person: {
          id: personId,
          employeeNo: person.employeeNo,
          name: person.name,
          avatarUrl: null,
          organization: { id: person.organizationUnitId, code: 'team', name: '检修工班', unitType: 'workgroup' },
          position: { id: IDS.position, code: 'maintainer', name: '检修工' }
        },
        execution: { type: 'platform' },
        request: { requestId: `req-${personId}`, traceId: `trace-${personId}`, startedAt: clock.now().toISOString() },
        authorize: async (permissionCode: string): Promise<AuthorizationDecision> => {
          const granted = allowed.has(permissionCode);
          return { id: `decision-${permissionCode}`, allowed: granted, reasonCode: granted ? 'allowed' : 'permission_not_granted', permissionCode, subjectType: 'person', effectiveScopes: [], decidedAt: clock.now().toISOString() };
        }
      };
    }
  };
}

function dutyCode(code: string) {
  return (error: unknown) => error instanceof DutyError && error.code === code;
}

function assignmentHistory(assignment: DutyAssignment, id: string): DutyOperationHistory {
  return {
    id,
    operation: 'assignment_set',
    entityType: 'assignment',
    entityId: assignment.id,
    organizationUnitId: assignment.organizationUnitId,
    actorType: 'person',
    actorPersonId: IDS.manager,
    serviceIdentityId: null,
    executionType: 'platform',
    sourceAppId: null,
    requestId: `request-${id}`,
    traceId: `trace-${id}`,
    note: null,
    before: null,
    after: assignment,
    occurredAt: NOW.toISOString()
  };
}

function periodHistory(period: DutyPeriod, id: string): DutyOperationHistory {
  return {
    id,
    operation: 'period_published',
    entityType: 'period',
    entityId: period.id,
    organizationUnitId: period.organizationUnitId,
    actorType: 'person',
    actorPersonId: IDS.manager,
    serviceIdentityId: null,
    executionType: 'platform',
    sourceAppId: null,
    requestId: `request-${id}`,
    traceId: `trace-${id}`,
    note: null,
    before: period,
    after: period,
    occurredAt: NOW.toISOString()
  };
}

function replacementHistory(replacement: TemporaryReplacement, id: string): DutyOperationHistory {
  return {
    id,
    operation: 'replacement_proposed',
    entityType: 'replacement',
    entityId: replacement.id,
    organizationUnitId: replacement.organizationUnitId,
    actorType: 'person',
    actorPersonId: IDS.manager,
    serviceIdentityId: null,
    executionType: 'platform',
    sourceAppId: null,
    requestId: `request-${id}`,
    traceId: `trace-${id}`,
    note: null,
    before: null,
    after: replacement,
    occurredAt: NOW.toISOString()
  };
}

async function createSeptemberPeriod(h = harness(), version = 1) {
  return h.service.createPeriod(h.actor(), {
    organizationUnitId: IDS.workgroup,
    periodKey: '2026-09',
    version,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    sourceAppId: 'scheduling',
    sourceEntityId: `roster-${version}`,
    importSha256: 'a'.repeat(64)
  });
}

test('Standard duty catalogs match the company roster without importing attendance summary fields', async () => {
  const h = harness();
  const shifts = await h.repository.listShiftTypes();
  const statuses = await h.repository.listDutyStatuses();
  assert.deepEqual(Object.fromEntries(shifts.map((item) => [item.code, [item.startMinute, item.endMinute, item.crossesMidnight, item.creditedMinutes, item.dutyClass]])), {
    A1: [510, 1170, false, 600, 'day'],
    A2: [1140, 540, true, 720, 'night'],
    A3: [510, 1050, false, 480, 'day'],
    常白班: [540, 1050, false, null, 'day'],
    晚班: [900, 1320, false, null, 'other'],
    早班: [420, 900, false, null, 'day']
  });
  assert.deepEqual(Object.fromEntries(statuses.map((item) => [item.code, [item.category, item.creditedMinutes, item.countsAsOnDuty]])), {
    婚: ['leave', 480, false],
    休: ['rest', 0, false]
  });
  assert.equal(JSON.stringify({ shifts, statuses }).includes('carriedHours'), false);
  assert.doesNotMatch(PLATFORM_DUTY_SQL, /(?:carried|standard_hours|variance|night_count|holiday_hours|confirmation|remark)/i);
  assert.equal(STANDARD_SHIFT_TYPE_SEEDS.length, 6);
  assert.equal(STANDARD_DUTY_STATUS_SEEDS.length, 2);
});

test('Catalog versions can be closed before a replacement version becomes effective', async () => {
  const h = harness();
  const a1 = (await h.service.listShiftTypes(h.actor(), 'A1'))[0];
  const closedShift = await h.service.closeShiftTypeVersion(h.actor(), { id: a1.id, effectiveTo: '2026-09-30' });
  assert.equal(closedShift.effectiveTo, '2026-09-30');
  const replacementShift = await h.service.createShiftType(h.actor(), {
    code: 'A1',
    name: 'A1 新版',
    startMinute: 540,
    endMinute: 1200,
    crossesMidnight: false,
    creditedMinutes: 600,
    dutyClass: 'day',
    effectiveFrom: '2026-10-01'
  });
  assert.equal(replacementShift.effectiveFrom, '2026-10-01');

  const rest = (await h.service.listDutyStatuses(h.actor(), '休'))[0];
  const closedStatus = await h.service.closeDutyStatusVersion(h.actor(), { id: rest.id, effectiveTo: '2026-09-30' });
  assert.equal(closedStatus.effectiveTo, '2026-09-30');
  await h.service.createDutyStatus(h.actor(), {
    code: '休',
    name: '休息',
    category: 'rest',
    creditedMinutes: 0,
    countsAsOnDuty: false,
    effectiveFrom: '2026-10-01'
  });
  assert.equal((await h.service.listDutyStatuses(h.actor(), '休')).length, 2);
});

test('Draft periods accept shift/status assignments, publish once and become immutable', async () => {
  const h = harness();
  const period = await createSeptemberPeriod(h);
  const a1 = (await h.repository.listShiftTypes('A1'))[0];
  const rest = (await h.repository.listDutyStatuses('休'))[0];
  const assignmentA = await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', shiftTypeId: a1.id, origin: 'imported' });
  await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personB, dateKey: '2026-09-01', dutyStatusId: rest.id, origin: 'imported' });
  const published = await h.service.publishPeriod(h.actor(), period.id);
  assert.equal(published.status, 'published');
  await assert.rejects(
    h.repository.updatePeriod(published, periodHistory(published, '52900000-0000-4000-8000-000000000000')),
    dutyCode('DRAFT_DUTY_PERIOD_REQUIRED')
  );
  await assert.rejects(
    h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', dutyStatusId: rest.id }),
    dutyCode('DRAFT_DUTY_PERIOD_REQUIRED')
  );
  await assert.rejects(
    h.repository.setAssignment(
      { ...assignmentA, updatedAt: new Date(NOW.getTime() + 1_000).toISOString() },
      assignmentHistory(assignmentA, '52900000-0000-4000-8000-000000000001')
    ),
    dutyCode('DRAFT_DUTY_PERIOD_REQUIRED')
  );
  assert.equal((await h.repository.findAssignmentById(assignmentA.id))?.kind, 'shift');
  const resolved = await h.service.resolveDutyAt(h.actor(), IDS.workgroup, toPlatformInstant({ year: 2026, month: 9, day: 1, hour: 9 }));
  assert.deepEqual(resolved.map((item) => [item.scheduledPersonId, item.code, item.countsAsOnDuty]), [
    [IDS.personA, 'A1', true],
    [IDS.personB, '休', false]
  ]);
  const context = await h.service.getCurrentDutyContext(h.actor(), IDS.workgroup, toPlatformInstant({ year: 2026, month: 9, day: 1, hour: 9 }));
  assert.deepEqual(context.onDutyPersonIds, [IDS.personA]);

  const overlapping = await createSeptemberPeriod(h, 2);
  await h.service.setAssignment(h.actor(), { periodId: overlapping.id, personId: IDS.personA, dateKey: '2026-09-02', shiftTypeId: a1.id });
  await assert.rejects(h.service.publishPeriod(h.actor(), overlapping.id), dutyCode('PUBLISHED_DUTY_PERIOD_OVERLAP'));
});

test('A2 remains effective after midnight from the previous assignment date and ends at 09:00', async () => {
  const h = harness();
  const period = await createSeptemberPeriod(h);
  const a2 = (await h.repository.listShiftTypes('A2'))[0];
  await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', shiftTypeId: a2.id });
  await h.service.publishPeriod(h.actor(), period.id);
  const atEight = await h.service.resolveDutyAt(h.actor(), IDS.workgroup, toPlatformInstant({ year: 2026, month: 9, day: 2, hour: 8 }));
  assert.equal(atEight.length, 1);
  assert.equal(atEight[0].assignmentDate, '2026-09-01');
  assert.equal(atEight[0].code, 'A2');
  assert.equal(atEight[0].startsAt, toPlatformInstant({ year: 2026, month: 9, day: 1, hour: 19 }).toISOString());
  assert.equal(atEight[0].endsAt, toPlatformInstant({ year: 2026, month: 9, day: 2, hour: 9 }).toISOString());
  assert.equal((await h.service.resolveDutyAt(h.actor(), IDS.workgroup, toPlatformInstant({ year: 2026, month: 9, day: 2, hour: 9 }))).length, 0);
});

test('Publishing rejects adjacent-date shifts whose actual Asia/Shanghai windows overlap', async () => {
  const h = harness();
  const period = await createSeptemberPeriod(h);
  const a2 = (await h.repository.listShiftTypes('A2'))[0];
  const a3 = (await h.repository.listShiftTypes('A3'))[0];
  await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', shiftTypeId: a2.id });
  await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-02', shiftTypeId: a3.id });
  await assert.rejects(h.service.publishPeriod(h.actor(), period.id), dutyCode('DUTY_ASSIGNMENT_TIME_OVERLAP'));
});

test('Publishing revalidates people against the current directory state', async () => {
  const directoryPeople = new Map(people);
  const h = harness(createMemoryDutyRepository(), directoryPeople);
  const period = await createSeptemberPeriod(h);
  const a1 = (await h.repository.listShiftTypes('A1'))[0];
  await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', shiftTypeId: a1.id });
  directoryPeople.set(IDS.personA, { ...directoryPeople.get(IDS.personA)!, employmentStatus: 'inactive' });
  await assert.rejects(h.service.publishPeriod(h.actor(), period.id), dutyCode('PERSON_INACTIVE'));
});

test('Replacement proposals reject a substitute whose own shift overlaps the covered duty', async () => {
  const h = harness();
  const period = await createSeptemberPeriod(h);
  const a1 = (await h.repository.listShiftTypes('A1'))[0];
  const a3 = (await h.repository.listShiftTypes('A3'))[0];
  const original = await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', shiftTypeId: a1.id });
  await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personB, dateKey: '2026-09-01', shiftTypeId: a3.id });
  await h.service.publishPeriod(h.actor(), period.id);
  await assert.rejects(
    h.service.proposeReplacement(h.actor(), { originalAssignmentId: original.id, substitutePersonId: IDS.personB }),
    dutyCode('DUTY_REPLACEMENT_TIME_OVERLAP')
  );
});

test('Repository final validation rejects concurrent replacements that double-book one substitute', async () => {
  const h = harness();
  const period = await createSeptemberPeriod(h);
  const a1 = (await h.repository.listShiftTypes('A1'))[0];
  const originalA = await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', shiftTypeId: a1.id });
  const originalB = await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personB, dateKey: '2026-09-01', shiftTypeId: a1.id });
  await h.service.publishPeriod(h.actor(), period.id);
  const first = await h.service.proposeReplacement(h.actor(), { originalAssignmentId: originalA.id, substitutePersonId: IDS.manager });
  const concurrent: TemporaryReplacement = {
    ...first,
    id: '52900000-0000-4000-8000-000000000021',
    originalAssignmentId: originalB.id,
    absentPersonId: IDS.personB,
    createdAt: new Date(NOW.getTime() + 1_000).toISOString(),
    updatedAt: new Date(NOW.getTime() + 1_000).toISOString()
  };
  await assert.rejects(
    h.repository.createReplacement(concurrent, replacementHistory(concurrent, '52900000-0000-4000-8000-000000000022')),
    dutyCode('DUTY_REPLACEMENT_TIME_OVERLAP')
  );
});

test('Approved replacements preserve original assignments, apply return duty and reject cross-organization people', async () => {
  const h = harness();
  const period = await createSeptemberPeriod(h);
  const a1 = (await h.repository.listShiftTypes('A1'))[0];
  const a3 = (await h.repository.listShiftTypes('A3'))[0];
  const original = await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', shiftTypeId: a1.id });
  const returning = await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personB, dateKey: '2026-09-02', shiftTypeId: a3.id });
  await h.service.publishPeriod(h.actor(), period.id);
  await assert.rejects(
    h.service.proposeReplacement(h.actor(), { originalAssignmentId: original.id, substitutePersonId: IDS.outsider }),
    dutyCode('PERSON_ORGANIZATION_MISMATCH')
  );
  const proposed = await h.service.proposeReplacement(h.actor(), {
    originalAssignmentId: original.id,
    substitutePersonId: IDS.personB,
    returnAssignmentId: returning.id,
    reason: null
  });
  await h.service.approveReplacement(h.actor(), proposed.id);
  const dayOne = await h.service.resolveDutyAt(h.actor(), IDS.workgroup, toPlatformInstant({ year: 2026, month: 9, day: 1, hour: 9 }));
  const dayTwo = await h.service.resolveDutyAt(h.actor(), IDS.workgroup, toPlatformInstant({ year: 2026, month: 9, day: 2, hour: 9 }));
  assert.equal(dayOne[0].scheduledPersonId, IDS.personA);
  assert.equal(dayOne[0].effectivePersonId, IDS.personB);
  assert.equal(dayTwo[0].scheduledPersonId, IDS.personB);
  assert.equal(dayTwo[0].effectivePersonId, IDS.personA);
  assert.equal((await h.repository.findAssignmentById(original.id))?.personId, IDS.personA);
  assert.equal((await h.repository.findAssignmentById(returning.id))?.personId, IDS.personB);
});

test('Duty permissions and organization scope fail closed', async () => {
  const h = harness();
  await assert.rejects(
    h.service.createPeriod(h.actor(IDS.manager, NO_PERMISSIONS), { organizationUnitId: IDS.workgroup, periodKey: '2026-09', version: 1, startDate: '2026-09-01', endDate: '2026-09-30' }),
    dutyCode('DUTY_PERMISSION_DENIED')
  );
  await assert.rejects(
    h.service.createPeriod(h.actor(), { organizationUnitId: '52000000-0000-4000-8000-000000000099', periodKey: '2026-09', version: 1, startDate: '2026-09-01', endDate: '2026-09-30' }),
    dutyCode('ORGANIZATION_NOT_FOUND')
  );
  await assert.rejects(
    h.service.createPeriod(h.actor(), { organizationUnitId: IDS.workgroup, periodKey: 'invalid-date', version: 1, startDate: '2026-02-30', endDate: '2026-03-01' }),
    dutyCode('INVALID_DATE_KEY')
  );
  const period = await createSeptemberPeriod(h);
  const a1 = (await h.repository.listShiftTypes('A1'))[0];
  await assert.rejects(
    h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.inactive, dateKey: '2026-09-01', shiftTypeId: a1.id }),
    dutyCode('PERSON_INACTIVE')
  );
  await assert.rejects(h.service.listShiftTypes(h.actor(IDS.manager, NO_PERMISSIONS)), dutyCode('DUTY_PERMISSION_DENIED'));
  await assert.rejects(
    h.service.createDutyStatus(h.actor(), {
      code: '测试状态',
      name: '测试状态',
      category: 'other',
      countsAsOnDuty: 'yes' as never,
      effectiveFrom: '2026-09-01'
    }),
    dutyCode('INVALID_BOOLEAN')
  );
});

test('Authorized application reads expose catalogs, calendar, assignments and replacements through the service', async () => {
  const h = harness();
  const period = await createSeptemberPeriod(h);
  const a1 = (await h.service.listShiftTypes(h.actor(), 'A1'))[0];
  assert.equal((await h.service.listDutyStatuses(h.actor(), '休'))[0].category, 'rest');
  await h.service.setCalendarDay(h.actor(), { dateKey: '2026-09-03', kind: 'statutory_holiday', holidayCode: 'victory-day', holidayName: '中国人民抗日战争胜利纪念日' });
  assert.equal((await h.service.getCalendarDay(h.actor(), '2026-09-03'))?.kind, 'statutory_holiday');
  const original = await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-03', shiftTypeId: a1.id });
  await h.service.publishPeriod(h.actor(), period.id);
  const replacement = await h.service.proposeReplacement(h.actor(), { originalAssignmentId: original.id, substitutePersonId: IDS.personB });
  assert.deepEqual((await h.service.listAssignments(h.actor(), period.id)).map((item) => item.id), [original.id]);
  assert.deepEqual((await h.service.listReplacements(h.actor(), period.id)).map((item) => item.id), [replacement.id]);
});

test('Duty migration runs twice and PostgreSQL repository round-trips periods and assignments', async () => {
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
    for (const migration of PLATFORM_DUTY_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_DUTY_MIGRATIONS) await migration.run({ client });
    await seedDirectory(client);
    const h = harness(createPostgresDutyRepository(client));
    const period = await createSeptemberPeriod(h);
    const a1 = (await h.repository.listShiftTypes('A1'))[0];
    const assignment = await h.service.setAssignment(h.actor(), { periodId: period.id, personId: IDS.personA, dateKey: '2026-09-01', shiftTypeId: a1.id, origin: 'imported' });
    const conflictingAssignment = { ...assignment, id: '52900000-0000-4000-8000-000000000011' };
    await assert.rejects(
      h.repository.setAssignment(
        conflictingAssignment,
        assignmentHistory(conflictingAssignment, '52900000-0000-4000-8000-000000000012')
      ),
      dutyCode('DUTY_ASSIGNMENT_CONFLICT')
    );
    await h.service.publishPeriod(h.actor(), period.id);
    assert.equal((await h.service.closeShiftTypeVersion(h.actor(), { id: a1.id, effectiveTo: '2026-09-30' })).effectiveTo, '2026-09-30');
    const rest = (await h.repository.listDutyStatuses('休'))[0];
    assert.equal((await h.service.closeDutyStatusVersion(h.actor(), { id: rest.id, effectiveTo: '2026-09-30' })).effectiveTo, '2026-09-30');
    const published = await h.repository.findPeriodById(period.id);
    assert.ok(published);
    await assert.rejects(
      h.repository.updatePeriod(published, periodHistory(published, '52900000-0000-4000-8000-000000000014')),
      dutyCode('DRAFT_DUTY_PERIOD_REQUIRED')
    );
    await assert.rejects(
      h.repository.setAssignment(
        { ...assignment, updatedAt: new Date(NOW.getTime() + 1_000).toISOString() },
        assignmentHistory(assignment, '52900000-0000-4000-8000-000000000013')
      ),
      dutyCode('DRAFT_DUTY_PERIOD_REQUIRED')
    );
    assert.equal((await h.service.listPeriods(h.actor(), IDS.workgroup, 'published')).length, 1);
    assert.equal((await h.service.resolveDutyAt(h.actor(), IDS.workgroup, toPlatformInstant({ year: 2026, month: 9, day: 1, hour: 9 }))).length, 1);
    const tables = await client.query("SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name LIKE 'platform_duty%' OR table_name IN ('platform_shift_types','platform_business_calendar_days','platform_temporary_replacements')") as { rows: Array<{ count: string }> };
    assert.equal(Number(tables.rows[0]?.count), 7);
    const permissions = await client.query("SELECT COUNT(*)::text AS count FROM platform_permissions WHERE code LIKE 'platform.duty.%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(permissions.rows[0]?.count), 6);
  } finally {
    await database.close();
  }
});

test('Standard roster reconciliation reports unknown codes, gaps, mismatches and excluded external fields', () => {
  const snapshot = {
    standardRoster: {
      sourceId: '202609-roster',
      dateKeys: ['2026-09-01', '2026-09-02'],
      people: [
        { sourcePersonKey: '0601', personId: IDS.personA },
        { sourcePersonKey: '0602', personId: null }
      ],
      cells: [
        { sourcePersonKey: '0601', dateKey: '2026-09-01', code: 'A1', creditedMinutes: 600 },
        { sourcePersonKey: '0601', dateKey: '2026-09-02', code: 'A2', creditedMinutes: 600 },
        { sourcePersonKey: '0602', dateKey: '2026-09-01', code: '未知', creditedMinutes: 0 },
        { sourcePersonKey: '0602', dateKey: '2026-09-01', code: '未知', creditedMinutes: 0 }
      ],
      catalog: [{ code: 'A2', startMinute: 1140, endMinute: 540, crossesMidnight: true, creditedMinutes: 720 }],
      excludedFieldNames: ['上月结转工时', '个人确认', '备注']
    },
    schedulingEntries: [{ sourceId: 'schedule-1', personId: IDS.personA, dateKey: '2026-09-01', shift: 'night' as const, code: 'A1' }],
    handoverRecords: [{ sourceId: 'handover-1', shift: 'day' as const }],
    adjustmentShiftCodes: ['A1', 'A4']
  };
  const before = structuredClone(snapshot);
  const result = reconcileLegacyDutyEvidence(snapshot);
  assert.deepEqual(snapshot, before);
  assert.equal(result.peopleCount, 2);
  assert.equal(result.expectedCellCount, 4);
  assert.equal(result.issues.some((issue) => issue.code === 'UNRESOLVED_PERSON'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'UNKNOWN_DUTY_CODE'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'CREDITED_MINUTES_MISMATCH'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'DUPLICATE_ASSIGNMENT_CELL'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'MISSING_ASSIGNMENT_CELL'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'SCHEDULING_SHIFT_MISMATCH'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'UNKNOWN_ADJUSTMENT_SHIFT'), true);
  assert.equal(result.issues.filter((issue) => issue.code === 'EXTERNAL_SUMMARY_FIELD').length, 3);
});

async function seedDirectory(client: { query(text: string, values?: readonly unknown[]): Promise<unknown> }) {
  await client.query(
    `INSERT INTO platform_organization_units (id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at)
     VALUES ($1,NULL,'company','运营公司',NULL,'company','active',1,$4,$4),
            ($2,$1,'afc-team','AFC检修工班',NULL,'workgroup','active',2,$4,$4),
            ($3,$1,'other-team','其他工班',NULL,'workgroup','active',3,$4,$4)`,
    [IDS.company, IDS.workgroup, IDS.otherWorkgroup, NOW.toISOString()]
  );
  await client.query(
    `INSERT INTO platform_positions (id,code,name,description,status,created_at,updated_at)
     VALUES ($1,'maintainer','检修工',NULL,'active',$2,$2)`,
    [IDS.position, NOW.toISOString()]
  );
  await client.query(
    `INSERT INTO platform_people (id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at)
     VALUES ($1,'06000001','排班管理人',NULL,$5,$6,'active',NULL,$7,$7),
            ($2,'06000002','甲',NULL,$5,$6,'active',NULL,$7,$7),
            ($3,'06000003','乙',NULL,$5,$6,'active',NULL,$7,$7),
            ($4,'06000004','外部人员',NULL,$8,$6,'active',NULL,$7,$7)`,
    [IDS.manager, IDS.personA, IDS.personB, IDS.outsider, IDS.workgroup, IDS.position, NOW.toISOString(), IDS.otherWorkgroup]
  );
}
