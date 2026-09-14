import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import {
  PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS,
  PLATFORM_PEOPLE_DIRECTORY_SQL,
  PeopleDirectoryError,
  buildOrganizationTree,
  createMemoryPeopleDirectoryRepository,
  createPeopleDirectoryService,
  createPostgresPeopleDirectoryRepository,
  reconcileLegacyDirectory
} from '../src/platform/people/index.ts';

const IDS = {
  company: '00000000-0000-4000-8000-000000000001',
  center: '00000000-0000-4000-8000-000000000002',
  department: '00000000-0000-4000-8000-000000000003',
  stationArea: '00000000-0000-4000-8000-000000000004',
  workgroup: '00000000-0000-4000-8000-000000000005',
  stationOrganization: '00000000-0000-4000-8000-000000000006',
  afcMaintainer: '00000000-0000-4000-8000-000000000007',
  director: '00000000-0000-4000-8000-000000000008',
  personA: '00000000-0000-4000-8000-000000000009',
  personB: '00000000-0000-4000-8000-00000000000a',
  identity: '00000000-0000-4000-8000-00000000000b'
} as const;

function createService() {
  const repository = createMemoryPeopleDirectoryRepository();
  let nextId = 100;
  const service = createPeopleDirectoryService(repository, {
    clock: () => new Date('2026-08-30T15:00:00.000Z'),
    createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`
  });
  return { repository, service };
}

async function seedOrganizationAndPositions() {
  const context = createService();
  const { service } = context;
  await service.createOrganizationUnit({ id: IDS.company, code: 'company', name: '轨道交通集团', unitType: 'company' });
  await service.createOrganizationUnit({ id: IDS.center, parentId: IDS.company, code: 'operations-center', name: '运营中心', unitType: 'operations_center' });
  await service.createOrganizationUnit({ id: IDS.department, parentId: IDS.company, code: 'direct-department', name: '公司直属部门', unitType: 'department' });
  await service.createOrganizationUnit({ id: IDS.stationArea, parentId: IDS.center, code: 'station-area', name: '东部站区', unitType: 'station_area' });
  await service.createOrganizationUnit({ id: IDS.workgroup, parentId: IDS.stationArea, code: 'afc-team-1', name: 'AFC一工班', unitType: 'workgroup', sortOrder: 1 });
  await service.createOrganizationUnit({
    id: IDS.stationOrganization,
    parentId: IDS.stationArea,
    code: 'station-org-qingdao',
    name: '青岛站',
    unitType: 'station_organization',
    sortOrder: 2
  });
  await service.createPosition({ id: IDS.afcMaintainer, code: 'afc-maintainer', name: 'AFC检修工' });
  await service.createPosition({ id: IDS.director, code: 'director', name: '主任' });
  return context;
}

test('People Directory builds the real organization hierarchy including company-direct departments', async () => {
  const { service } = await seedOrganizationAndPositions();
  const tree = await service.getOrganizationTree();

  assert.equal(tree.length, 1);
  assert.equal(tree[0].unitType, 'company');
  assert.deepEqual(tree[0].children.map((unit) => unit.name), ['公司直属部门', '运营中心']);
  const center = tree[0].children.find((unit) => unit.id === IDS.center);
  assert.equal(center?.children[0].unitType, 'station_area');
  assert.deepEqual(center?.children[0].children.map((unit) => unit.unitType), ['workgroup', 'station_organization']);
});

test('People Directory assigns one current organization and position to a person', async () => {
  const { repository, service } = await seedOrganizationAndPositions();
  const person = await service.createPerson({
    id: IDS.personA,
    employeeNo: '06010001',
    name: '张三',
    phone: '13800000000',
    organizationUnitId: IDS.workgroup,
    positionId: IDS.afcMaintainer
  });

  assert.equal(person.organizationUnitId, IDS.workgroup);
  assert.equal(person.positionId, IDS.afcMaintainer);
  assert.deepEqual(Object.keys(repository.records().people[0]).sort(), [
    'avatarUrl',
    'createdAt',
    'employeeNo',
    'employmentStatus',
    'id',
    'name',
    'organizationUnitId',
    'phone',
    'positionId',
    'updatedAt'
  ]);
});

test('People Directory rejects cyclic organization data instead of returning an incomplete tree', () => {
  const now = '2026-08-30T15:00:00.000Z';
  assert.throws(
    () => buildOrganizationTree([
      {
        id: IDS.company,
        parentId: IDS.center,
        code: 'company',
        name: '公司',
        shortName: null,
        unitType: 'company',
        status: 'active',
        sortOrder: 0,
        createdAt: now,
        updatedAt: now
      },
      {
        id: IDS.center,
        parentId: IDS.company,
        code: 'center',
        name: '中心',
        shortName: null,
        unitType: 'operations_center',
        status: 'active',
        sortOrder: 0,
        createdAt: now,
        updatedAt: now
      }
    ]),
    (error: unknown) => error instanceof PeopleDirectoryError && error.code === 'CYCLIC_ORGANIZATION'
  );
});

test('People Directory resolves WeCom identities and disambiguates same-name people by organization and position', async () => {
  const { service } = await seedOrganizationAndPositions();
  await service.createPerson({
    id: IDS.personA,
    employeeNo: '06010001',
    name: '张三',
    organizationUnitId: IDS.workgroup,
    positionId: IDS.afcMaintainer
  });
  await service.createPerson({
    id: IDS.personB,
    employeeNo: '06010002',
    name: '张三',
    organizationUnitId: IDS.department,
    positionId: IDS.director
  });
  await service.linkExternalIdentity({
    id: IDS.identity,
    personId: IDS.personA,
    provider: 'wecom',
    tenantKey: 'qingdao-metro',
    externalUserId: 'zhangsan'
  });

  const candidates = await service.searchPeople({ query: '张三' });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => [
    candidate.person.employeeNo,
    candidate.organizationUnit.name,
    candidate.position.name
  ]), [
    ['06010001', 'AFC一工班', 'AFC检修工'],
    ['06010002', '公司直属部门', '主任']
  ]);
  assert.equal((await service.resolveExternalIdentity('wecom', 'zhangsan', 'qingdao-metro'))?.person.id, IDS.personA);
});

test('People Directory does not resolve inactive or unverified external identities', async () => {
  const { repository, service } = await seedOrganizationAndPositions();
  await service.createPerson({
    id: IDS.personA,
    employeeNo: '06010001',
    name: '张三',
    organizationUnitId: IDS.workgroup,
    positionId: IDS.afcMaintainer
  });
  await service.linkExternalIdentity({
    id: IDS.identity,
    personId: IDS.personA,
    provider: 'wecom',
    tenantKey: 'qingdao-metro',
    externalUserId: 'zhangsan',
    status: 'inactive'
  });

  assert.equal(repository.records().externalIdentities[0].verifiedAt, null);
  assert.equal(await service.resolveExternalIdentity('wecom', 'zhangsan', 'qingdao-metro'), null);
});

test('People Directory rejects missing or inactive organization and position references', async () => {
  const { service } = await seedOrganizationAndPositions();
  await assert.rejects(
    service.createPerson({
      employeeNo: '06010003',
      name: '李四',
      organizationUnitId: '00000000-0000-4000-8000-000000000099',
      positionId: IDS.afcMaintainer
    }),
    (error: unknown) => error instanceof PeopleDirectoryError && error.code === 'ORGANIZATION_NOT_FOUND'
  );

  const inactiveRepository = createMemoryPeopleDirectoryRepository({
    organizationUnits: [{
      id: IDS.company,
      parentId: null,
      code: 'company',
      name: '公司',
      shortName: null,
      unitType: 'company',
      status: 'inactive',
      sortOrder: 0,
      createdAt: '2026-08-30T15:00:00.000Z',
      updatedAt: '2026-08-30T15:00:00.000Z'
    }],
    positions: [{
      id: IDS.afcMaintainer,
      code: 'afc-maintainer',
      name: 'AFC检修工',
      description: null,
      status: 'active',
      createdAt: '2026-08-30T15:00:00.000Z',
      updatedAt: '2026-08-30T15:00:00.000Z'
    }]
  });
  const inactiveService = createPeopleDirectoryService(inactiveRepository);
  await assert.rejects(
    inactiveService.createPerson({
      employeeNo: '06010004',
      name: '王五',
      organizationUnitId: IDS.company,
      positionId: IDS.afcMaintainer
    }),
    (error: unknown) => error instanceof PeopleDirectoryError && error.code === 'ORGANIZATION_INACTIVE'
  );
});

test('legacy directory reconciliation preserves IDs and reports unsafe bindings without migrating data', () => {
  const report = reconcileLegacyDirectory({
    organizations: [{ id: IDS.workgroup, name: 'AFC一工班' }],
    users: [
      { id: IDS.personA, employeeNo: '06010001', name: '张三', wecomUserId: 'zhangsan', organizationUnitId: IDS.workgroup, positionName: 'AFC检修工' },
      { id: IDS.personB, employeeNo: '06010001', name: '李四', wecomUserId: 'zhangsan', organizationUnitId: null, positionName: null }
    ]
  });

  assert.deepEqual(report.preservedPersonIds, [IDS.personA, IDS.personB]);
  assert.deepEqual(report.preservedOrganizationUnitIds, [IDS.workgroup]);
  assert.equal(report.wecomBindingCount, 2);
  assert.deepEqual(report.issues.map((issue) => issue.code), [
    'DUPLICATE_EMPLOYEE_NO',
    'DUPLICATE_WECOM_USER_ID',
    'MISSING_ORGANIZATION',
    'MISSING_POSITION'
  ]);
});

test('People Directory publishes an additive idempotent expand migration', async () => {
  const migration = PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS[0];
  const queries: string[] = [];

  assert.equal(migration.id, 'platform-people-directory-expand');
  assert.equal(migration.ownerTaskId, 'PLATFORM-L3-001');
  assert.equal(migration.layer, 'L3');
  assert.deepEqual(migration.dataRows, ['DATA-001']);
  assert.deepEqual(migration.migrationRows, ['MIG-015']);
  assert.deepEqual(migration.targetTables, [
    'platform_organization_units',
    'platform_positions',
    'platform_people',
    'platform_external_identities'
  ]);
  assert.match(PLATFORM_PEOPLE_DIRECTORY_SQL, /organization_unit_id uuid NOT NULL/);
  assert.match(PLATFORM_PEOPLE_DIRECTORY_SQL, /position_id uuid NOT NULL/);
  assert.match(PLATFORM_PEOPLE_DIRECTORY_SQL, /UNIQUE \(provider, tenant_key, external_user_id\)/);

  await migration.run({
    client: {
      async query(text) {
        queries.push(text);
        return { rows: [] };
      }
    }
  });
  assert.deepEqual(queries, [PLATFORM_PEOPLE_DIRECTORY_SQL]);
});

test('People Directory migration and PostgreSQL repository run twice against isolated PGlite', async () => {
  const database = new PGlite();
  const client = {
    query(text: string, values?: readonly unknown[]) {
      if (!values && text.includes(';')) return database.exec(text);
      return database.query(text, values ? [...values] : undefined);
    }
  };

  try {
    await PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS[0].run({ client });

    const repository = createPostgresPeopleDirectoryRepository(client);
    const service = createPeopleDirectoryService(repository, {
      clock: () => new Date('2026-08-30T15:00:00.000Z')
    });
    await service.createOrganizationUnit({ id: IDS.company, code: 'company', name: '轨道交通集团', unitType: 'company' });
    await service.createOrganizationUnit({ id: IDS.workgroup, parentId: IDS.company, code: 'afc-team-1', name: 'AFC一工班', unitType: 'workgroup' });
    await service.createPosition({ id: IDS.afcMaintainer, code: 'afc-maintainer', name: 'AFC检修工' });
    await service.createPerson({
      id: IDS.personA,
      employeeNo: '06010001',
      name: '张三',
      organizationUnitId: IDS.workgroup,
      positionId: IDS.afcMaintainer
    });
    await service.linkExternalIdentity({
      id: IDS.identity,
      personId: IDS.personA,
      provider: 'wecom',
      tenantKey: 'qingdao-metro',
      externalUserId: 'zhangsan'
    });

    const profile = await service.resolveExternalIdentity('wecom', 'zhangsan', 'qingdao-metro');
    assert.equal(profile?.person.id, IDS.personA);
    assert.equal(profile?.organizationUnit.name, 'AFC一工班');
    assert.equal(profile?.position.name, 'AFC检修工');
    assert.equal((await service.searchPeople({ query: '06010001' }))[0].person.name, '张三');
  } finally {
    await database.close();
  }
});

test('L3 People Directory public model contains no permission, responsibility, or invented person classification', async () => {
  const [modelSource, migrationSource] = await Promise.all([
    readFile(new URL('../src/platform/people/model.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/platform/people/migration.ts', import.meta.url), 'utf8')
  ]);
  const publicSource = `${modelSource}\n${migrationSource}`;

  assert.doesNotMatch(publicSource, /\b(role|permission|responsibility|profession|membership)\b/i);
  assert.doesNotMatch(publicSource, /(part[_-]?time|module_ids|station_ids)/i);
});
