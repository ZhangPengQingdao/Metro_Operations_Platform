import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import {
  PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS,
  createPostgresPeopleDirectoryRepository
} from '../src/platform/people/index.ts';
import {
  PLATFORM_LOCATION_DIRECTORY_MIGRATIONS,
  PLATFORM_LOCATION_DIRECTORY_SQL,
  LocationDirectoryError,
  buildLocationTree,
  createLocationDirectoryService,
  createMemoryLocationDirectoryRepository,
  createPostgresLocationDirectoryRepository,
  legacyStationLocationCode,
  reconcileLegacyStations,
  splitLegacyAliases
} from '../src/platform/locations/index.ts';

const IDS = {
  companyOrg: '10000000-0000-4000-8000-000000000001',
  stationOrg: '10000000-0000-4000-8000-000000000002',
  area: '10000000-0000-4000-8000-000000000003',
  depot: '10000000-0000-4000-8000-000000000004',
  workshop: '10000000-0000-4000-8000-000000000005',
  room: '10000000-0000-4000-8000-000000000006',
  qingdaoStation: '10000000-0000-4000-8000-000000000007',
  otherStation: '10000000-0000-4000-8000-000000000008',
  line1: '10000000-0000-4000-8000-000000000009',
  line3: '10000000-0000-4000-8000-00000000000a',
  line1Qingdao: '10000000-0000-4000-8000-00000000000b',
  line3Qingdao: '10000000-0000-4000-8000-00000000000c',
  aliasA: '10000000-0000-4000-8000-00000000000d',
  aliasB: '10000000-0000-4000-8000-00000000000e',
  external: '10000000-0000-4000-8000-00000000000f'
} as const;

function createService() {
  const repository = createMemoryLocationDirectoryRepository();
  let nextId = 100;
  const service = createLocationDirectoryService(repository, {
    clock: () => new Date('2026-08-31T00:30:00.000Z'),
    createId: () => `10000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    findOrganizationUnit: async (id) => id === IDS.stationOrg
      ? { unitType: 'station_organization', status: 'active' }
      : id === IDS.companyOrg
        ? { unitType: 'company', status: 'active' }
        : null
  });
  return { repository, service };
}

async function seedStationsAndLines() {
  const context = createService();
  const { service } = context;
  await service.createLocation({
    id: IDS.qingdaoStation,
    organizationUnitId: IDS.stationOrg,
    code: 'station:qingdao',
    name: '青岛站',
    locationType: 'station'
  });
  await service.createLocation({
    id: IDS.otherStation,
    code: 'station:other',
    name: '青岛北站',
    locationType: 'station'
  });
  await service.createLine({ id: IDS.line1, code: 'L1', name: '1号线', sortOrder: 1 });
  await service.createLine({ id: IDS.line3, code: 'L3', name: '3号线', sortOrder: 3 });
  return context;
}

test('Location Directory builds operational area, depot, workshop, and room hierarchy', async () => {
  const { service } = createService();
  await service.createLocation({ id: IDS.area, code: 'area:west', name: '西海岸运营区域', locationType: 'operational_area' });
  await service.createLocation({ id: IDS.depot, parentId: IDS.area, code: 'depot:west', name: '西海岸车辆段', locationType: 'depot' });
  await service.createLocation({ id: IDS.workshop, parentId: IDS.depot, code: 'workshop:afc', name: 'AFC维修工区', locationType: 'workshop' });
  await service.createLocation({ id: IDS.room, parentId: IDS.workshop, code: 'room:spare', name: '备件间', locationType: 'equipment_room' });

  const tree = await service.getLocationTree();
  assert.equal(tree[0].locationType, 'operational_area');
  assert.equal(tree[0].children[0].locationType, 'depot');
  assert.equal(tree[0].children[0].children[0].locationType, 'workshop');
  assert.equal(tree[0].children[0].children[0].children[0].locationType, 'equipment_room');
});

test('one physical Station can belong to several Lines and becomes an interchange', async () => {
  const { service } = await seedStationsAndLines();
  await service.linkStationToLine({
    id: IDS.line1Qingdao,
    lineId: IDS.line1,
    stationId: IDS.qingdaoStation,
    stationCode: 'L1-14',
    sortOrder: 14
  });
  await service.linkStationToLine({
    id: IDS.line3Qingdao,
    lineId: IDS.line3,
    stationId: IDS.qingdaoStation,
    stationCode: 'L3-06',
    sortOrder: 6
  });

  const profile = await service.getLocationProfile(IDS.qingdaoStation);
  assert.equal(profile?.location.id, IDS.qingdaoStation);
  assert.equal(profile?.isInterchange, true);
  assert.deepEqual(profile?.stationLines.map((item) => [item.line.code, item.lineStation.stationCode, item.lineStation.sortOrder]), [
    ['L1', 'L1-14', 14],
    ['L3', 'L3-06', 6]
  ]);
});

test('LineStation keeps code and order unique inside each line', async () => {
  const { service } = await seedStationsAndLines();
  await service.linkStationToLine({
    id: IDS.line1Qingdao,
    lineId: IDS.line1,
    stationId: IDS.qingdaoStation,
    stationCode: 'L1-14',
    sortOrder: 14
  });

  await assert.rejects(
    service.linkStationToLine({
      lineId: IDS.line1,
      stationId: IDS.otherStation,
      stationCode: 'L1-14',
      sortOrder: 15
    }),
    (error: unknown) => error instanceof LocationDirectoryError && error.code === 'DUPLICATE_LINE_STATION_CODE'
  );
  await assert.rejects(
    service.linkStationToLine({
      lineId: IDS.line1,
      stationId: IDS.otherStation,
      stationCode: 'L1-15',
      sortOrder: 14
    }),
    (error: unknown) => error instanceof LocationDirectoryError && error.code === 'DUPLICATE_LINE_SORT_ORDER'
  );
});

test('inactive line memberships and aliases do not participate in current profiles or line search', async () => {
  const { service } = await seedStationsAndLines();
  await service.linkStationToLine({
    id: IDS.line1Qingdao,
    lineId: IDS.line1,
    stationId: IDS.qingdaoStation,
    stationCode: 'L1-14',
    sortOrder: 14
  });
  await service.linkStationToLine({
    id: IDS.line3Qingdao,
    lineId: IDS.line3,
    stationId: IDS.qingdaoStation,
    stationCode: 'L3-06',
    sortOrder: 6,
    status: 'inactive'
  });
  await service.addAlias({
    id: IDS.aliasA,
    locationId: IDS.qingdaoStation,
    alias: '旧车站名',
    status: 'inactive'
  });

  const profile = await service.getLocationProfile(IDS.qingdaoStation);
  assert.equal(profile?.isInterchange, false);
  assert.deepEqual(profile?.stationLines.map((item) => item.line.code), ['L1']);
  assert.deepEqual(profile?.aliases, []);
  assert.deepEqual(await service.searchLocations({ lineId: IDS.line3 }), []);
});

test('Location Directory searches standard names, codes, and aliases while preserving ambiguous candidates', async () => {
  const { service } = await seedStationsAndLines();
  await service.addAlias({ id: IDS.aliasA, locationId: IDS.qingdaoStation, alias: '火车站', aliasType: 'common' });
  await service.addAlias({ id: IDS.aliasB, locationId: IDS.otherStation, alias: '火车站', aliasType: 'common' });

  assert.equal((await service.searchLocations({ query: 'station:qingdao' }))[0].location.id, IDS.qingdaoStation);
  const ambiguous = await service.searchLocations({ query: '火车站', locationType: 'station' });
  assert.deepEqual(ambiguous.map((item) => item.location.name), ['青岛北站', '青岛站']);
});

test('station organization links are optional, one-to-one, and unavailable to other location types', async () => {
  const { service } = await seedStationsAndLines();
  await assert.rejects(
    service.createLocation({
      code: 'depot:linked',
      name: '关联车辆段',
      locationType: 'depot',
      organizationUnitId: IDS.companyOrg
    }),
    (error: unknown) => error instanceof LocationDirectoryError && error.code === 'ORGANIZATION_LINK_REQUIRES_STATION'
  );
  await assert.rejects(
    service.createLocation({
      code: 'station:wrong-org',
      name: '错误组织车站',
      locationType: 'station',
      organizationUnitId: IDS.companyOrg
    }),
    (error: unknown) => error instanceof LocationDirectoryError && error.code === 'ORGANIZATION_UNIT_IS_NOT_STATION'
  );
  await assert.rejects(
    service.createLocation({
      code: 'station:duplicate-org',
      name: '重复组织车站',
      locationType: 'station',
      organizationUnitId: IDS.stationOrg
    }),
    (error: unknown) => error instanceof LocationDirectoryError && error.code === 'DUPLICATE_ORGANIZATION_LOCATION'
  );
});

test('Location Directory rejects orphan and cyclic physical hierarchies', async () => {
  const { service } = createService();
  await assert.rejects(
    service.createLocation({
      parentId: IDS.area,
      code: 'room:orphan',
      name: '孤儿房间',
      locationType: 'equipment_room'
    }),
    (error: unknown) => error instanceof LocationDirectoryError && error.code === 'LOCATION_PARENT_NOT_FOUND'
  );

  const now = '2026-08-31T00:30:00.000Z';
  assert.throws(
    () => buildLocationTree([
      { id: IDS.area, parentId: IDS.depot, organizationUnitId: null, code: 'area:a', name: '区域', shortName: null, locationType: 'operational_area', status: 'active', sortOrder: 0, createdAt: now, updatedAt: now },
      { id: IDS.depot, parentId: IDS.area, organizationUnitId: null, code: 'depot:a', name: '车辆段', shortName: null, locationType: 'depot', status: 'active', sortOrder: 0, createdAt: now, updatedAt: now }
    ]),
    (error: unknown) => error instanceof LocationDirectoryError && error.code === 'CYCLIC_LOCATION'
  );
});

test('verified external references resolve while inactive references remain unavailable', async () => {
  const { repository, service } = await seedStationsAndLines();
  await service.linkExternalReference({
    id: IDS.external,
    locationId: IDS.qingdaoStation,
    provider: 'asset-system',
    tenantKey: 'metro',
    externalLocationId: 'QD-STATION',
    status: 'inactive'
  });
  assert.equal(repository.records().externalReferences[0].verifiedAt, null);
  assert.equal(await service.resolveExternalReference('asset-system', 'QD-STATION', 'metro'), null);
});

test('verified external references do not resolve inactive locations', async () => {
  const { service } = createService();
  await service.createLocation({
    id: IDS.qingdaoStation,
    code: 'station:inactive',
    name: '停用车站',
    locationType: 'station',
    status: 'inactive'
  });
  await service.linkExternalReference({
    id: IDS.external,
    locationId: IDS.qingdaoStation,
    provider: 'asset-system',
    tenantKey: 'metro',
    externalLocationId: 'INACTIVE-STATION'
  });

  assert.equal(await service.resolveExternalReference('asset-system', 'INACTIVE-STATION', 'metro'), null);
});

test('legacy station reconciliation preserves IDs and separates line/order/alias/responsibility facts', () => {
  const report = reconcileLegacyStations({
    stations: [
      { id: IDS.qingdaoStation, name: '青岛站', line: '1号线', code: 'L1-14', sortOrder: 14, alias: '火车站，青岛火车站', workgroupId: IDS.companyOrg },
      { id: IDS.otherStation, name: '青岛北站', line: '1号线', code: 'L1-14', sortOrder: 14, alias: null, workgroupId: null }
    ]
  });

  assert.deepEqual(report.preservedStationIds, [IDS.qingdaoStation, IDS.otherStation]);
  assert.equal(report.stationCount, 2);
  assert.equal(report.lineCount, 1);
  assert.equal(report.lineStationCount, 2);
  assert.equal(report.aliasCount, 2);
  assert.equal(report.responsibilitySourceCount, 1);
  assert.deepEqual(report.issues.map((issue) => issue.code), [
    'DUPLICATE_LINE_STATION_CODE',
    'DUPLICATE_LINE_SORT_ORDER'
  ]);
  assert.equal(legacyStationLocationCode(IDS.qingdaoStation), `station:${IDS.qingdaoStation}`);
  assert.deepEqual(splitLegacyAliases('火车站, 青岛火车站、火车站'), ['火车站', '青岛火车站']);
});

test('Location Directory publishes an additive migration after the People Directory', () => {
  const migration = PLATFORM_LOCATION_DIRECTORY_MIGRATIONS[0];
  assert.equal(migration.id, 'platform-location-directory-expand');
  assert.equal(migration.ownerTaskId, 'PLATFORM-L3-002');
  assert.equal(migration.layer, 'L3');
  assert.deepEqual(migration.dataRows, ['DATA-002']);
  assert.deepEqual(migration.migrationRows, ['MIG-016']);
  assert.deepEqual(migration.dependsOn, ['platform-people-directory-expand']);
  assert.deepEqual(migration.targetTables, [
    'platform_locations',
    'platform_lines',
    'platform_line_stations',
    'platform_location_aliases',
    'platform_external_location_references'
  ]);
  assert.match(PLATFORM_LOCATION_DIRECTORY_SQL, /UNIQUE \(line_id, station_id\)/);
  assert.match(PLATFORM_LOCATION_DIRECTORY_SQL, /UNIQUE \(line_id, station_code\)/);
  assert.match(PLATFORM_LOCATION_DIRECTORY_SQL, /UNIQUE \(line_id, sort_order\)/);
});

test('Location migration and PostgreSQL repository run twice against isolated PGlite', async () => {
  const database = new PGlite();
  const client = {
    query(text: string, values?: readonly unknown[]) {
      if (!values && text.includes(';')) return database.exec(text);
      return database.query(text, values ? [...values] : undefined);
    }
  };

  try {
    await PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS[0].run({ client });
    await database.query(
      `INSERT INTO platform_organization_units
        (id, parent_id, code, name, short_name, unit_type, status, sort_order, created_at, updated_at)
       VALUES ($1, NULL, 'station-org', '青岛站组织节点', NULL, 'station_organization', 'active', 0, NOW(), NOW())`,
      [IDS.stationOrg]
    );
    await PLATFORM_LOCATION_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_LOCATION_DIRECTORY_MIGRATIONS[0].run({ client });

    const repository = createPostgresLocationDirectoryRepository(client);
    const peopleRepository = createPostgresPeopleDirectoryRepository(client);
    const service = createLocationDirectoryService(repository, {
      clock: () => new Date('2026-08-31T00:30:00.000Z'),
      findOrganizationUnit: (id) => peopleRepository.findOrganizationUnitById(id)
    });
    await service.createLocation({
      id: IDS.qingdaoStation,
      organizationUnitId: IDS.stationOrg,
      code: 'station:qingdao',
      name: '青岛站',
      locationType: 'station'
    });
    await service.createLine({ id: IDS.line1, code: 'L1', name: '1号线', sortOrder: 1 });
    await service.createLine({ id: IDS.line3, code: 'L3', name: '3号线', sortOrder: 3 });
    await service.linkStationToLine({ id: IDS.line1Qingdao, lineId: IDS.line1, stationId: IDS.qingdaoStation, stationCode: 'L1-14', sortOrder: 14 });
    await service.linkStationToLine({ id: IDS.line3Qingdao, lineId: IDS.line3, stationId: IDS.qingdaoStation, stationCode: 'L3-06', sortOrder: 6 });
    await service.addAlias({ id: IDS.aliasA, locationId: IDS.qingdaoStation, alias: '火车站' });
    await service.linkExternalReference({ id: IDS.external, locationId: IDS.qingdaoStation, provider: 'asset-system', tenantKey: 'metro', externalLocationId: 'QD-STATION' });

    const profile = await service.getLocationProfile(IDS.qingdaoStation);
    assert.equal(profile?.isInterchange, true);
    assert.deepEqual(profile?.stationLines.map((item) => item.line.code), ['L1', 'L3']);
    assert.equal((await service.searchLocations({ query: '火车站' }))[0].location.id, IDS.qingdaoStation);
    assert.equal((await service.resolveExternalReference('asset-system', 'QD-STATION', 'metro'))?.location.id, IDS.qingdaoStation);
  } finally {
    await database.close();
  }
});

test('L3 Location Directory public model contains no asset, responsibility, permission, routing, or fare policy', async () => {
  const [modelSource, migrationSource] = await Promise.all([
    readFile(new URL('../src/platform/locations/model.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/platform/locations/migration.ts', import.meta.url), 'utf8')
  ]);
  const publicSource = `${modelSource}\n${migrationSource}`;
  assert.doesNotMatch(publicSource, /\b(asset|device|permission|responsibility|workgroup|fare|route_path|latitude|longitude)\b/i);
});
