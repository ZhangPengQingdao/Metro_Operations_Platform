import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS } from '../src/platform/people/index.ts';
import {
  PLATFORM_LOCATION_DIRECTORY_MIGRATIONS,
  createLocationDirectoryService,
  createPostgresLocationDirectoryRepository
} from '../src/platform/locations/index.ts';
import {
  PLATFORM_ASSET_DIRECTORY_MIGRATIONS,
  PLATFORM_ASSET_DIRECTORY_SQL,
  AssetDirectoryError,
  createAssetDirectoryService,
  createMemoryAssetDirectoryRepository,
  createPostgresAssetDirectoryRepository,
  legacyAssetTypeCode,
  reconcileLegacyAssets
} from '../src/platform/assets/index.ts';

const IDS = {
  afcSystem: '20000000-0000-4000-8000-000000000001',
  powerSystem: '20000000-0000-4000-8000-000000000002',
  terminalCategory: '20000000-0000-4000-8000-000000000003',
  gateType: '20000000-0000-4000-8000-000000000004',
  serverType: '20000000-0000-4000-8000-000000000005',
  stationA: '20000000-0000-4000-8000-000000000006',
  stationB: '20000000-0000-4000-8000-000000000007',
  assetA: '20000000-0000-4000-8000-000000000008',
  assetB: '20000000-0000-4000-8000-000000000009',
  alias: '20000000-0000-4000-8000-00000000000a',
  external: '20000000-0000-4000-8000-00000000000b'
} as const;

function createService() {
  const repository = createMemoryAssetDirectoryRepository();
  let nextId = 100;
  const service = createAssetDirectoryService(repository, {
    clock: () => new Date('2026-08-31T01:30:00.000Z'),
    createId: () => `20000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    findLocation: async (id) => [IDS.stationA, IDS.stationB].includes(id as typeof IDS.stationA | typeof IDS.stationB)
      ? { status: 'active' }
      : null
  });
  return { repository, service };
}

async function seedClassification(options: { withCategory?: boolean } = {}) {
  const context = createService();
  const { service } = context;
  await service.createSystem({ id: IDS.afcSystem, code: 'AFC', name: 'AFC' });
  if (options.withCategory) {
    await service.createCategory({
      id: IDS.terminalCategory,
      systemId: IDS.afcSystem,
      code: 'TERMINAL',
      name: '车站终端设备'
    });
  }
  await service.createType({
    id: IDS.gateType,
    systemId: IDS.afcSystem,
    categoryId: options.withCategory ? IDS.terminalCategory : null,
    code: 'ENTRY-GATE',
    name: '进站闸机'
  });
  await service.createType({
    id: IDS.serverType,
    systemId: IDS.afcSystem,
    code: 'SERVER',
    name: '服务器及网络设备'
  });
  return context;
}

test('Asset Directory requires System and Type while Category remains optional', async () => {
  const { repository, service } = await seedClassification();
  const asset = await service.createAsset({
    id: IDS.assetA,
    systemId: IDS.afcSystem,
    typeId: IDS.gateType,
    locationId: IDS.stationA,
    displayName: 'AGM01',
    assetCode: '01500401'
  });

  assert.equal(asset.categoryId, null);
  assert.equal(asset.lifecycleState, 'active');
  assert.equal(asset.dataQualityStatus, 'unverified');
  assert.deepEqual(Object.keys(repository.records().assets[0]).sort(), [
    'assetCode', 'categoryId', 'createdAt', 'dataQualityStatus', 'displayName', 'id',
    'lifecycleState', 'locationId', 'remark', 'systemId', 'typeId', 'updatedAt'
  ]);
});

test('Asset Category and Type must belong to the selected professional System', async () => {
  const { service } = await seedClassification({ withCategory: true });
  await service.createSystem({ id: IDS.powerSystem, code: 'POWER', name: '供电' });

  await assert.rejects(
    service.createType({
      systemId: IDS.powerSystem,
      categoryId: IDS.terminalCategory,
      code: 'POWER-GATE',
      name: '错误类型'
    }),
    (error: unknown) => error instanceof AssetDirectoryError && error.code === 'ASSET_CATEGORY_SYSTEM_MISMATCH'
  );
  await assert.rejects(
    service.createAsset({
      systemId: IDS.afcSystem,
      categoryId: null,
      typeId: IDS.gateType,
      locationId: IDS.stationA,
      displayName: 'AGM01'
    }),
    (error: unknown) => error instanceof AssetDirectoryError && error.code === 'ASSET_TYPE_CATEGORY_MISMATCH'
  );
});

test('asset display name is location/type scoped and optional asset code is globally unique', async () => {
  const { service } = await seedClassification();
  await service.createAsset({ id: IDS.assetA, systemId: IDS.afcSystem, typeId: IDS.gateType, locationId: IDS.stationA, displayName: 'AGM01', assetCode: '01500401' });
  await service.createAsset({ id: IDS.assetB, systemId: IDS.afcSystem, typeId: IDS.gateType, locationId: IDS.stationB, displayName: 'AGM01' });

  await assert.rejects(
    service.createAsset({ systemId: IDS.afcSystem, typeId: IDS.gateType, locationId: IDS.stationA, displayName: 'agm01' }),
    (error: unknown) => error instanceof AssetDirectoryError && error.code === 'DUPLICATE_ASSET_SCOPED_NAME'
  );
  await assert.rejects(
    service.createAsset({ systemId: IDS.afcSystem, typeId: IDS.serverType, locationId: IDS.stationB, displayName: '服务器01', assetCode: '01500401' }),
    (error: unknown) => error instanceof AssetDirectoryError && error.code === 'DUPLICATE_ASSET_CODE'
  );
});

test('relocating an asset preserves UUID and rejects a scoped-name collision', async () => {
  const { service } = await seedClassification();
  await service.createAsset({ id: IDS.assetA, systemId: IDS.afcSystem, typeId: IDS.gateType, locationId: IDS.stationA, displayName: 'AGM01' });
  const moved = await service.relocateAsset(IDS.assetA, IDS.stationB);
  assert.equal(moved.id, IDS.assetA);
  assert.equal(moved.locationId, IDS.stationB);

  await service.createAsset({ id: IDS.assetB, systemId: IDS.afcSystem, typeId: IDS.gateType, locationId: IDS.stationA, displayName: 'AGM01' });
  await assert.rejects(
    service.relocateAsset(IDS.assetB, IDS.stationB),
    (error: unknown) => error instanceof AssetDirectoryError && error.code === 'DUPLICATE_ASSET_SCOPED_NAME'
  );
});

test('lifecycle is stable asset state and retired assets remain queryable', async () => {
  const { service } = await seedClassification();
  await service.createAsset({
    id: IDS.assetA,
    systemId: IDS.afcSystem,
    typeId: IDS.gateType,
    locationId: IDS.stationA,
    displayName: 'AGM01'
  });

  assert.equal((await service.setLifecycleState(IDS.assetA, 'suspended')).lifecycleState, 'suspended');
  assert.equal((await service.setLifecycleState(IDS.assetA, 'retired')).lifecycleState, 'retired');
  assert.equal((await service.setDataQualityStatus(IDS.assetA, 'verified')).dataQualityStatus, 'verified');
  assert.equal((await service.getAssetProfile(IDS.assetA))?.asset.lifecycleState, 'retired');
  assert.equal((await service.searchAssets({ lifecycleState: 'retired' }))[0].asset.id, IDS.assetA);
});

test('aliases and verified external references resolve without adding application attributes', async () => {
  const { repository, service } = await seedClassification();
  await service.createAsset({ id: IDS.assetA, systemId: IDS.afcSystem, typeId: IDS.gateType, locationId: IDS.stationA, displayName: 'AGM01' });
  await service.addAlias({ id: IDS.alias, assetId: IDS.assetA, alias: '进站闸机1号' });
  await service.linkExternalReference({
    id: IDS.external,
    assetId: IDS.assetA,
    provider: 'asset-system',
    tenantKey: 'metro',
    externalAssetId: 'EXT-AGM-01',
    status: 'inactive'
  });

  assert.equal((await service.searchAssets({ query: '进站闸机1号' }))[0].asset.id, IDS.assetA);
  assert.equal(repository.records().externalReferences[0].verifiedAt, null);
  assert.equal(await service.resolveExternalReference('asset-system', 'EXT-AGM-01', 'metro'), null);
});

test('Asset Directory requires an active Location from the Location Directory contract', async () => {
  const repository = createMemoryAssetDirectoryRepository();
  const service = createAssetDirectoryService(repository, {
    findLocation: async () => ({ status: 'inactive' })
  });
  await service.createSystem({ id: IDS.afcSystem, code: 'AFC', name: 'AFC' });
  await service.createType({ id: IDS.gateType, systemId: IDS.afcSystem, code: 'GATE', name: '闸机' });

  await assert.rejects(
    service.createAsset({ systemId: IDS.afcSystem, typeId: IDS.gateType, locationId: IDS.stationA, displayName: 'AGM01' }),
    (error: unknown) => error instanceof AssetDirectoryError && error.code === 'ASSET_LOCATION_INACTIVE'
  );
});

test('legacy asset reconciliation preserves IDs and reports deferred network/import evidence', () => {
  const report = reconcileLegacyAssets({
    deviceTypes: [
      { id: IDS.gateType, name: '进站闸机' },
      { id: IDS.serverType, name: '进站闸机' }
    ],
    devices: [
      {
        id: IDS.assetA,
        locationId: IDS.stationA,
        typeId: IDS.gateType,
        displayName: 'AGM01',
        assetCode: '01500401',
        workgroupId: IDS.afcSystem,
        ipAddress: '10.0.0.1',
        subnetMask: '255.255.255.0',
        gateway: '10.0.0.254',
        sourceFile: 'devices.xlsx',
        sourceRow: 2
      },
      {
        id: IDS.assetB,
        locationId: IDS.stationA,
        typeId: IDS.gateType,
        displayName: 'AGM01',
        assetCode: '01500401'
      }
    ],
    faultDeviceReferenceCount: 7,
    resolutionAuditCount: 11
  });

  assert.deepEqual(report.preservedAssetIds, [IDS.assetA, IDS.assetB]);
  assert.deepEqual(report.preservedAssetTypeIds, [IDS.gateType, IDS.serverType]);
  assert.equal(report.targetSystemCode, 'AFC');
  assert.equal(report.responsibilitySourceCount, 1);
  assert.equal(report.deferredNetworkFieldCount, 1);
  assert.equal(report.importEvidenceCount, 1);
  assert.equal(report.faultDeviceReferenceCount, 7);
  assert.equal(report.resolutionAuditCount, 11);
  assert.deepEqual(report.issues.map((issue) => issue.code), [
    'DUPLICATE_DEVICE_TYPE_NAME',
    'DUPLICATE_LOCATION_TYPE_NAME',
    'DUPLICATE_ASSET_CODE'
  ]);
  assert.equal(legacyAssetTypeCode(IDS.gateType), `legacy-type:${IDS.gateType}`);
});

test('Asset Directory publishes an additive migration after the Location Directory', () => {
  const migration = PLATFORM_ASSET_DIRECTORY_MIGRATIONS[0];
  assert.equal(migration.id, 'platform-asset-directory-expand');
  assert.equal(migration.ownerTaskId, 'PLATFORM-L3-003');
  assert.deepEqual(migration.dataRows, ['DATA-003']);
  assert.deepEqual(migration.migrationRows, ['MIG-017']);
  assert.deepEqual(migration.dependsOn, ['platform-location-directory-expand']);
  assert.deepEqual(migration.targetTables, [
    'platform_asset_systems',
    'platform_asset_categories',
    'platform_asset_types',
    'platform_assets',
    'platform_asset_aliases',
    'platform_external_asset_references'
  ]);
  assert.match(PLATFORM_ASSET_DIRECTORY_SQL, /UNIQUE INDEX IF NOT EXISTS platform_assets_location_type_name_idx/);
  assert.match(PLATFORM_ASSET_DIRECTORY_SQL, /WHERE asset_code IS NOT NULL/);
  assert.match(PLATFORM_ASSET_DIRECTORY_SQL, /FOREIGN KEY \(type_id, system_id\)/);
  assert.match(PLATFORM_ASSET_DIRECTORY_SQL, /FOREIGN KEY \(type_id, system_id, category_id\)/);
  assert.doesNotMatch(PLATFORM_ASSET_DIRECTORY_SQL, /(ip_address|subnet_mask|gateway|jsonb|workgroup_id)/i);
});

test('Asset migration and PostgreSQL repository run twice against isolated PGlite', async () => {
  const database = new PGlite();
  const client = {
    query(text: string, values?: readonly unknown[]) {
      if (!values && text.includes(';')) return database.exec(text);
      return database.query(text, values ? [...values] : undefined);
    }
  };

  try {
    await PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_LOCATION_DIRECTORY_MIGRATIONS[0].run({ client });
    const locationRepository = createPostgresLocationDirectoryRepository(client);
    const locationService = createLocationDirectoryService(locationRepository);
    await locationService.createLocation({ id: IDS.stationA, code: 'station:a', name: '青岛站', locationType: 'station' });
    await locationService.createLocation({ id: IDS.stationB, code: 'station:b', name: '青岛北站', locationType: 'station' });

    await PLATFORM_ASSET_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_ASSET_DIRECTORY_MIGRATIONS[0].run({ client });
    const repository = createPostgresAssetDirectoryRepository(client);
    const service = createAssetDirectoryService(repository, {
      clock: () => new Date('2026-08-31T01:30:00.000Z'),
      findLocation: (id) => locationRepository.findLocationById(id)
    });
    await service.createSystem({ id: IDS.afcSystem, code: 'AFC', name: 'AFC' });
    await service.createCategory({ id: IDS.terminalCategory, systemId: IDS.afcSystem, code: 'TERMINAL', name: '车站终端设备' });
    await service.createType({ id: IDS.gateType, systemId: IDS.afcSystem, categoryId: IDS.terminalCategory, code: 'ENTRY-GATE', name: '进站闸机' });
    await service.createAsset({
      id: IDS.assetA,
      systemId: IDS.afcSystem,
      typeId: IDS.gateType,
      locationId: IDS.stationA,
      displayName: 'AGM01',
      assetCode: '01500401',
      dataQualityStatus: 'verified'
    });
    await service.addAlias({ id: IDS.alias, assetId: IDS.assetA, alias: '进站闸机1号' });
    await service.linkExternalReference({ id: IDS.external, assetId: IDS.assetA, provider: 'asset-system', tenantKey: 'metro', externalAssetId: 'EXT-AGM-01' });

    await service.createSystem({ id: IDS.powerSystem, code: 'POWER', name: '供电' });
    await assert.rejects(
      database.query(
        `INSERT INTO platform_assets
          (id, system_id, category_id, type_id, location_id, display_name, asset_code, lifecycle_state, data_quality_status, remark, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $4, '错误跨系统资产', NULL, 'active', 'unverified', NULL, NOW(), NOW())`,
        [IDS.assetB, IDS.powerSystem, IDS.gateType, IDS.stationA]
      ),
      /foreign key/i
    );

    assert.equal((await service.getAssetProfile(IDS.assetA))?.category?.name, '车站终端设备');
    assert.equal((await service.searchAssets({ query: '进站闸机1号' }))[0].asset.id, IDS.assetA);
    assert.equal((await service.resolveExternalReference('asset-system', 'EXT-AGM-01', 'metro'))?.asset.id, IDS.assetA);
    assert.equal((await service.relocateAsset(IDS.assetA, IDS.stationB)).id, IDS.assetA);
  } finally {
    await database.close();
  }
});

test('L3 Asset public model contains no network, responsibility, permission, runtime, or generic attribute bag', async () => {
  const modelSource = await readFile(new URL('../src/platform/assets/model.ts', import.meta.url), 'utf8');
  const coreModel = modelSource.slice(0, modelSource.indexOf('export interface LegacyDeviceReference'));
  assert.doesNotMatch(coreModel, /(ipAddress|subnetMask|gateway|workgroupId|permission|responsibility|fault|offline|maintenance|attributes|metadata)/i);
  assert.doesNotMatch(PLATFORM_ASSET_DIRECTORY_SQL, /(ip_address|subnet_mask|gateway|workgroup_id|jsonb)/i);
});
