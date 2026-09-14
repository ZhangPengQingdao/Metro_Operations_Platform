import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { FixedClock } from '../src/core/time/index.ts';
import { PLATFORM_AUTHORIZATION_MIGRATIONS, type AuthorizationDecision } from '../src/platform/authorization/index.ts';
import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS } from '../src/platform/people/index.ts';
import { PLATFORM_LOCATION_DIRECTORY_MIGRATIONS } from '../src/platform/locations/index.ts';
import { PLATFORM_ASSET_DIRECTORY_MIGRATIONS } from '../src/platform/assets/index.ts';
import { PLATFORM_ATTACHMENT_MIGRATIONS } from '../src/platform/attachments/index.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';
import {
  DATA_ALIGNMENT_PERMISSION_CODES,
  PLATFORM_DATA_ALIGNMENT_MIGRATIONS,
  PLATFORM_DATA_ALIGNMENT_SQL,
  DataAlignmentError,
  createDataAlignmentService,
  createMemoryDataAlignmentRepository,
  createMemoryDirectoryReferenceAdapter,
  createPostgresDirectoryReferenceAdapter,
  createPostgresDataAlignmentRepository,
  reconcileLegacyDataAlignment,
  type DataAlignmentOperationHistory,
  type DataAlignmentRepository
} from '../src/platform/data-alignment/index.ts';

const IDS = {
  company: '53000000-0000-4000-8000-000000000001',
  workgroup: '53000000-0000-4000-8000-000000000002',
  position: '53000000-0000-4000-8000-000000000003',
  manager: '53000000-0000-4000-8000-000000000011',
  person: '53000000-0000-4000-8000-000000000012',
  location: '53000000-0000-4000-8000-000000000021',
  asset: '53000000-0000-4000-8000-000000000031'
} as const;
const NOW = new Date('2026-09-01T08:00:00.000Z');
const ALL = new Set(Object.values(DATA_ALIGNMENT_PERMISSION_CODES));
let operationSequence = 1;

function harness(repository: DataAlignmentRepository = createMemoryDataAlignmentRepository()) {
  let sequence = 100;
  const clock = new FixedClock(NOW);
  const references = createMemoryDirectoryReferenceAdapter({
    people: [{ personId: IDS.person, provider: 'wecom', tenantKey: 'corp', externalUserId: 'zhangsan', status: 'active', verifiedAt: NOW.toISOString() }],
    locations: [{ locationId: IDS.location, provider: 'maintenance_cloud', tenantKey: 'default', externalLocationId: 'station-1', status: 'active', verifiedAt: NOW.toISOString() }],
    assets: [{ assetId: IDS.asset, provider: 'maintenance_cloud', tenantKey: 'default', externalAssetId: 'device-1', status: 'active', verifiedAt: NOW.toISOString() }]
  });
  const service = createDataAlignmentService(repository, {
    clock,
    createId: () => `53100000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    directoryReferences: references,
    findAttachment: async (id) => id === '53000000-0000-4000-8000-000000000099' ? { lifecycle: 'active' } : null
  });
  return {
    repository, service, clock,
    actor(allowed = ALL, execution: PlatformActorContext['execution'] = { type: 'platform' }): PlatformActorContext {
      return {
        actorType: 'person', trustedIdentity: { source: 'session', userId: IDS.manager },
        person: { id: IDS.manager, employeeNo: '001', name: '管理员', avatarUrl: null, organization: { id: IDS.workgroup, code: 'team', name: '工班', unitType: 'workgroup' }, position: { id: IDS.position, code: 'manager', name: '管理岗' } },
        execution: execution as { type: 'platform' } | { type: 'application'; appId: string },
        request: { requestId: 'request-data-alignment', traceId: 'trace-data-alignment', startedAt: NOW.toISOString() },
        authorize: async (permissionCode: string): Promise<AuthorizationDecision> => ({ id: `decision-${permissionCode}`, allowed: allowed.has(permissionCode), reasonCode: allowed.has(permissionCode) ? 'allowed' : 'permission_not_granted', permissionCode, subjectType: 'person', effectiveScopes: [], decidedAt: NOW.toISOString() })
      };
    }
  };
}

function errorCode(code: string) { return (error: unknown) => error instanceof DataAlignmentError && error.code === code; }

function operation(entityType: DataAlignmentOperationHistory['entityType'], entityId: string, before: Record<string, unknown>, after: Record<string, unknown>): DataAlignmentOperationHistory {
  return { id: `53900000-0000-4000-8000-${String(operationSequence++).padStart(12, '0')}`, operation: 'dictionary_retired', entityType, entityId, actorType: 'person', actorPersonId: IDS.manager, serviceIdentityId: null, executionType: 'platform', sourceAppId: null, requestId: 'request-direct', traceId: 'trace-direct', note: null, before, after, occurredAt: NOW.toISOString() };
}

async function createPublishedDictionary(h = harness()) {
  const dictionary = await h.service.createDictionaryVersion(h.actor(), { dictionaryKey: 'shared.priority', version: 1, name: '公共优先级' });
  await h.service.setDictionaryItem(h.actor(), { dictionaryVersionId: dictionary.id, code: 'normal', label: '普通' });
  await h.service.setDictionaryItem(h.actor(), { dictionaryVersionId: dictionary.id, code: 'urgent', label: '紧急', sortOrder: 1 });
  return h.service.publishDictionaryVersion(h.actor(), dictionary.id);
}

async function createPublishedProfile(h = harness(), entityType = 'fault', app = 'fault_management') {
  const platform = h.actor();
  const system = await h.service.createExternalSystem(platform, { code: 'maintenance_cloud', name: '维修云' });
  const rule = await h.service.createSourceOfTruthRule(platform, { externalSystemId: system.id, platformEntityType: entityType, authorityScopeKey: 'record', authority: 'manual_resolution', effectiveFrom: NOW.toISOString() });
  const application = h.actor(ALL, { type: 'application', appId: app });
  const profile = await h.service.createMappingProfile(application, { profileKey: `${app}.cloud`, version: 1, name: `${app} 云对齐`, ownerType: 'application', ownerAppId: app, externalSystemId: system.id, sourceOfTruthRuleId: rule.id, platformEntityType: entityType, direction: 'bidirectional' });
  return { system, rule, profile: await h.service.publishMappingProfile(application, profile.id), application };
}

test('Shared dictionaries publish immutable ordered versions without generic metadata bags', async () => {
  const h = harness();
  const published = await createPublishedDictionary(h);
  assert.equal(published.status, 'published');
  assert.deepEqual((await h.service.listDictionaryItems(h.actor(), published.id)).map((item) => item.code), ['normal', 'urgent']);
  await assert.rejects(h.service.setDictionaryItem(h.actor(), { dictionaryVersionId: published.id, code: 'low', label: '低' }), errorCode('DRAFT_DICTIONARY_REQUIRED'));
  assert.doesNotMatch(PLATFORM_DATA_ALIGNMENT_SQL, /metadata|attributes|field_map|payload_body/i);
  await h.service.retireDictionaryVersion(h.actor(), published.id);
  const versionTwo = await h.service.createDictionaryVersion(h.actor(), { dictionaryKey: 'shared.priority', version: 2, name: '公共优先级' });
  assert.equal(versionTwo.status, 'draft');
});

test('Repositories reject invalid definition lifecycle transitions independently of the service', async () => {
  const h = harness();
  const draft = await h.service.createDictionaryVersion(h.actor(), { dictionaryKey: 'shared.lifecycle', version: 1, name: '生命周期' });
  const invalid = { ...draft, status: 'retired' as const, publishedAt: NOW.toISOString(), retiredAt: NOW.toISOString() };
  await assert.rejects(h.repository.updateDictionaryVersion(invalid, 'draft', operation('dictionary_version', draft.id, draft as unknown as Record<string, unknown>, invalid as unknown as Record<string, unknown>)), errorCode('INVALID_DEFINITION_TRANSITION'));
});

test('Authority is immutable, closes by effective time, and app profiles support fault and hazard entities', async () => {
  const h = harness();
  const fault = await createPublishedProfile(h, 'fault', 'fault_management');
  assert.equal(fault.profile.platformEntityType, 'fault');
  await assert.rejects(h.service.createSourceOfTruthRule(h.actor(), { externalSystemId: fault.system.id, platformEntityType: 'fault', authorityScopeKey: 'record', authority: 'external', effectiveFrom: '2026-09-15T00:00:00.000Z' }), errorCode('SOURCE_OF_TRUTH_RULE_OVERLAP'));
  const closed = await h.service.closeSourceOfTruthRule(h.actor(), { id: fault.rule.id, expectedUpdatedAt: fault.rule.updatedAt, effectiveTo: '2026-09-30T00:00:00.000Z' });
  assert.equal(closed.authority, 'manual_resolution');
  assert.equal(closed.status, 'inactive');
  const hazardRule = await h.service.createSourceOfTruthRule(h.actor(), { externalSystemId: fault.system.id, platformEntityType: 'hazard', authorityScopeKey: 'record', authority: 'external', effectiveFrom: '2026-10-01T00:00:00.000Z' });
  const app = h.actor(ALL, { type: 'application', appId: 'hazard_management' });
  const hazard = await h.service.createMappingProfile(app, { profileKey: 'hazard_management.cloud', version: 1, name: '隐患云对齐', ownerType: 'application', ownerAppId: 'hazard_management', externalSystemId: fault.system.id, sourceOfTruthRuleId: hazardRule.id, platformEntityType: 'hazard', direction: 'outbound' });
  assert.equal(hazard.platformEntityType, 'hazard');
});

test('Mapping profiles cannot publish before their authority rule is effective', async () => {
  const h = harness();
  const system = await h.service.createExternalSystem(h.actor(), { code: 'future_cloud', name: '未来云' });
  const rule = await h.service.createSourceOfTruthRule(h.actor(), { externalSystemId: system.id, platformEntityType: 'fault', authorityScopeKey: 'record', authority: 'external', effectiveFrom: '2026-10-01T00:00:00.000Z' });
  const app = h.actor(ALL, { type: 'application', appId: 'fault_management' });
  const profile = await h.service.createMappingProfile(app, { profileKey: 'fault.future', version: 1, name: '未来映射', ownerType: 'application', ownerAppId: 'fault_management', externalSystemId: system.id, sourceOfTruthRuleId: rule.id, platformEntityType: 'fault', direction: 'inbound' });
  await assert.rejects(h.service.publishMappingProfile(app, profile.id), errorCode('MAPPING_PROFILE_RULE_MISMATCH'));
});

test('Permissions and application ownership fail closed', async () => {
  const h = harness();
  await assert.rejects(h.service.listExternalSystems(h.actor(new Set())), errorCode('DATA_ALIGNMENT_PERMISSION_DENIED'));
  const created = await createPublishedProfile(h);
  const other = h.actor(ALL, { type: 'application', appId: 'maintenance' });
  await assert.rejects(h.service.createSyncRun(other, { mappingProfileId: created.profile.id, requestKey: 'run-1', requestedCount: 1 }), errorCode('MAPPING_PROFILE_OWNER_MISMATCH'));
});

test('Idempotent run retries survive later external-system deactivation', async () => {
  const h = harness();
  const created = await createPublishedProfile(h);
  const run = await h.service.createSyncRun(created.application, { mappingProfileId: created.profile.id, requestKey: 'durable-retry', requestedCount: 1 });
  await h.service.updateExternalSystem(h.actor(), { id: created.system.id, expectedUpdatedAt: created.system.updatedAt, status: 'inactive' });
  assert.equal((await h.service.createSyncRun(created.application, { mappingProfileId: created.profile.id, requestKey: 'durable-retry', requestedCount: 1 })).id, run.id);
  await assert.rejects(h.service.createSyncRun(created.application, { mappingProfileId: created.profile.id, requestKey: 'new-run', requestedCount: 1 }), errorCode('ACTIVE_ALIGNMENT_DEFINITION_REQUIRED'));
});

test('Sync evidence is idempotent, counters are derived, conflicts resolve, and only success advances checkpoints', async () => {
  const h = harness();
  const { profile, application } = await createPublishedProfile(h);
  const queued = await h.service.createSyncRun(application, { mappingProfileId: profile.id, requestKey: 'batch-20260901', requestedCount: 3 });
  assert.equal((await h.service.createSyncRun(application, { mappingProfileId: profile.id, requestKey: 'batch-20260901', requestedCount: 3 })).id, queued.id);
  await assert.rejects(h.service.createSyncRun(application, { mappingProfileId: profile.id, requestKey: 'batch-20260901', requestedCount: 4 }), errorCode('SYNC_REQUEST_IDEMPOTENCY_CONFLICT'));
  const running = await h.service.startSyncRun(application, queued.id, 1);
  const firstResultInput = { syncRunId: running.id, sourceRecordKey: 'fault-1', platformEntityType: 'fault', platformEntityId: IDS.asset, externalEntityId: 'remote-1', sourceSha256: 'a'.repeat(64), targetSha256: 'a'.repeat(64), outcome: 'updated' as const };
  const firstResult = await h.service.recordSyncResult(application, firstResultInput);
  assert.equal((await h.service.recordSyncResult(application, firstResultInput)).id, firstResult.id);
  await assert.rejects(h.service.recordSyncResult(application, { ...firstResultInput, outcome: 'unchanged' }), errorCode('SYNC_SOURCE_RECORD_CONFLICT'));
  await h.service.recordSyncResult(application, { syncRunId: running.id, sourceRecordKey: 'fault-2', outcome: 'unchanged' });
  const conflict = await h.service.recordSyncResult(application, { syncRunId: running.id, sourceRecordKey: 'fault-3', sourceSha256: 'b'.repeat(64), targetSha256: 'c'.repeat(64), outcome: 'conflict' });
  const partial = await h.service.completeSyncRun(application, { syncRunId: running.id, expectedVersion: 2, status: 'partial' });
  assert.equal((await h.service.recordSyncResult(application, firstResultInput)).id, firstResult.id);
  assert.deepEqual([partial.processedCount, partial.updatedCount, partial.unchangedCount, partial.conflictCount], [3, 1, 1, 1]);
  const resolved = await h.service.resolveSyncConflict(application, { resultId: conflict.id, expectedVersion: 1, resolution: 'keep_platform' });
  assert.equal(resolved.state, 'resolved');
  await assert.rejects(h.service.advanceSyncCheckpoint(application, { mappingProfileId: profile.id, partitionKey: 'default', cursor: '3', successfulRunId: partial.id, expectedVersion: 0 }), errorCode('SUCCESSFUL_MATCHING_RUN_REQUIRED'));

  const successQueued = await h.service.createSyncRun(application, { mappingProfileId: profile.id, requestKey: 'batch-20260902', requestedCount: 1 });
  const successRunning = await h.service.startSyncRun(application, successQueued.id, 1);
  await h.service.recordSyncResult(application, { syncRunId: successRunning.id, sourceRecordKey: 'fault-4', outcome: 'created', sourceAttachmentId: '53000000-0000-4000-8000-000000000099', sourceRow: 8, sourceSha256: 'd'.repeat(64) });
  const success = await h.service.completeSyncRun(application, { syncRunId: successRunning.id, expectedVersion: 2, status: 'succeeded' });
  const checkpoint = await h.service.advanceSyncCheckpoint(application, { mappingProfileId: profile.id, partitionKey: 'default', cursor: 'fault-4', sourceWatermarkAt: success.completedAt, successfulRunId: success.id, expectedVersion: 0 });
  assert.equal(checkpoint.version, 1);
  await assert.rejects(h.service.advanceSyncCheckpoint(application, { mappingProfileId: profile.id, partitionKey: 'default', cursor: 'without-watermark', successfulRunId: success.id, expectedVersion: 1 }), errorCode('SYNC_CHECKPOINT_REGRESSION'));
  await assert.rejects(h.service.advanceSyncCheckpoint(application, { mappingProfileId: profile.id, partitionKey: 'default', cursor: 'older', sourceWatermarkAt: '2026-08-31T00:00:00.000Z', successfulRunId: success.id, expectedVersion: 1 }), errorCode('SYNC_CHECKPOINT_REGRESSION'));
});

test('Existing directory references are normalized without a duplicate mapping table', async () => {
  const h = harness();
  await h.service.createExternalSystem(h.actor(), { code: 'wecom', name: '企业微信' });
  await h.service.createExternalSystem(h.actor(), { code: 'maintenance_cloud', name: '维修云' });
  const resolved = await h.service.resolveExternalReference(h.actor(), 'person', 'wecom', 'corp', 'zhangsan');
  assert.equal(resolved?.entityId, IDS.person);
  assert.equal((await h.service.listExternalReferences(h.actor())).length, 3);
  assert.doesNotMatch(PLATFORM_DATA_ALIGNMENT_SQL, /external_entity_references/i);
});

test('Disabled systems, entity mismatches and result overflow fail at synchronization boundaries', async () => {
  const h = harness();
  const created = await createPublishedProfile(h);
  await h.service.updateExternalSystem(h.actor(), { id: created.system.id, expectedUpdatedAt: created.system.updatedAt, status: 'inactive' });
  await assert.rejects(h.service.createSyncRun(created.application, { mappingProfileId: created.profile.id, requestKey: 'disabled', requestedCount: 1 }), errorCode('ACTIVE_ALIGNMENT_DEFINITION_REQUIRED'));

  const h2 = harness();
  const active = await createPublishedProfile(h2, 'hazard', 'hazard_management');
  const queued = await h2.service.createSyncRun(active.application, { mappingProfileId: active.profile.id, requestKey: 'bounded', requestedCount: 1 });
  const running = await h2.service.startSyncRun(active.application, queued.id, 1);
  await assert.rejects(h2.service.recordSyncResult(active.application, { syncRunId: running.id, sourceRecordKey: 'wrong', platformEntityType: 'fault', platformEntityId: IDS.asset, outcome: 'created' }), errorCode('SYNC_RESULT_ENTITY_TYPE_MISMATCH'));
  await h2.service.recordSyncResult(active.application, { syncRunId: running.id, sourceRecordKey: 'hazard-1', platformEntityType: 'hazard', platformEntityId: IDS.asset, outcome: 'created' });
  await assert.rejects(h2.service.recordSyncResult(active.application, { syncRunId: running.id, sourceRecordKey: 'hazard-2', outcome: 'unchanged' }), errorCode('SYNC_RESULT_COUNT_EXCEEDS_REQUESTED'));
});

test('Sync summaries reject credentials and signed-link evidence', async () => {
  const h = harness();
  const created = await createPublishedProfile(h);
  const queued = await h.service.createSyncRun(created.application, { mappingProfileId: created.profile.id, requestKey: 'safe-evidence', requestedCount: 1 });
  const running = await h.service.startSyncRun(created.application, queued.id, 1);
  await assert.rejects(h.service.recordSyncResult(created.application, { syncRunId: running.id, sourceRecordKey: 'fault-secret', outcome: 'failed', errorCode: 'provider_error', errorSummary: 'Authorization: Bearer secret-value' }), errorCode('SENSITIVE_SYNC_EVIDENCE_DENIED'));
});

test('Legacy reconciliation reports provider, provenance, sync, field-map and checkpoint gaps without mutation', () => {
  const snapshot = {
    registeredExternalSystemCodes: ['wecom'],
    externalReferences: [
      { entityType: 'person' as const, entityId: IDS.person, externalSystemCode: 'unknown', tenantKey: 'default', externalId: '1', status: 'active' as const, verifiedAt: NOW.toISOString() },
      { entityType: 'person' as const, entityId: IDS.manager, externalSystemCode: 'unknown', tenantKey: 'default', externalId: '1', status: 'active' as const, verifiedAt: NOW.toISOString() }
    ],
    devices: [
      { id: IDS.asset, sourceKey: '../unsafe', sourceFile: null, sourceRow: null },
      { id: IDS.location, sourceKey: '../unsafe', sourceFile: 'devices.xlsx', sourceRow: 2 }
    ],
    cloudDocumentSyncs: [
      { id: 'sync-1', status: 'synced', remoteRecordId: null, payloadHash: 'a'.repeat(64), attempts: 1, lastSyncAt: NOW.toISOString() },
      { id: 'sync-2', status: 'failed', remoteRecordId: null, payloadHash: null, attempts: 5, lastSyncAt: null }
    ],
    applicationFieldMaps: [{ sourceId: 'fault-map', ownerAppId: 'fault_management', mappingKey: 'fault.cloud.v1' }],
    checkpointProfileKeys: []
  };
  const before = structuredClone(snapshot);
  const result = reconcileLegacyDataAlignment(snapshot);
  assert.deepEqual(snapshot, before);
  for (const code of ['UNREGISTERED_PROVIDER','DUPLICATE_EXTERNAL_REFERENCE','UNSAFE_SOURCE_KEY','DUPLICATE_SOURCE_KEY','MISSING_SOURCE_EVIDENCE','MISSING_REMOTE_ID','FAILED_SYNC_ROW','APP_OWNED_FIELD_MAP','CHECKPOINT_GAP']) assert.equal(result.issues.some((item) => item.code === code), true, code);
});

test('Migration runs twice and PostgreSQL repository round-trips public definitions', async () => {
  const database = new PGlite();
  const client = { query(text: string, values?: readonly unknown[]) { return !values && text.includes(';') ? database.exec(text) : database.query(text, values ? [...values] : undefined); } };
  try {
    for (const migration of PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_LOCATION_DIRECTORY_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_ASSET_DIRECTORY_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_AUTHORIZATION_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_ATTACHMENT_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_DATA_ALIGNMENT_MIGRATIONS) await migration.run({ client });
    for (const migration of PLATFORM_DATA_ALIGNMENT_MIGRATIONS) await migration.run({ client });
    await seedDirectory(client);
    const h = harness(createPostgresDataAlignmentRepository(client));
    assert.equal((await h.service.createExternalSystem(h.actor(), { code: 'cloud_docs', name: '云文档' })).code, 'cloud_docs');
    await h.service.createExternalSystem(h.actor(), { code: 'wecom', name: '企业微信' });
    await client.query(`INSERT INTO platform_external_identities (id,person_id,provider,tenant_key,external_user_id,status,verified_at,created_at,updated_at) VALUES ('53000000-0000-4000-8000-000000000090',$1,'wecom','corp','zhangsan','active',$2,$2,$2)`, [IDS.person, NOW.toISOString()]);
    const directoryAdapter = createPostgresDirectoryReferenceAdapter(client);
    assert.equal((await directoryAdapter.resolve('person', 'wecom', 'corp', 'zhangsan'))?.entityId, IDS.person);
    assert.equal((await createPublishedDictionary(h)).status, 'published');
    const { profile, application } = await createPublishedProfile(h, 'fault', 'fault_management');
    const queued = await h.service.createSyncRun(application, { mappingProfileId: profile.id, requestKey: 'pg-run', requestedCount: 1 });
    const running = await h.service.startSyncRun(application, queued.id, 1);
    await h.service.recordSyncResult(application, { syncRunId: running.id, sourceRecordKey: 'fault-pg-1', platformEntityType: 'fault', platformEntityId: IDS.asset, outcome: 'created' });
    const succeeded = await h.service.completeSyncRun(application, { syncRunId: running.id, expectedVersion: 2, status: 'succeeded' });
    assert.equal((await h.service.advanceSyncCheckpoint(application, { mappingProfileId: profile.id, partitionKey: 'default', cursor: 'fault-pg-1', successfulRunId: succeeded.id, expectedVersion: 0 })).version, 1);
    assert.equal((await h.repository.listOperationHistory('sync_run', succeeded.id)).length >= 3, true);
    const tables = await client.query("SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name LIKE 'platform_sync_%' OR table_name IN ('platform_dictionary_versions','platform_dictionary_items','platform_external_systems','platform_source_of_truth_rules','platform_mapping_profiles','platform_data_alignment_operation_history')") as { rows: Array<{ count: string }> };
    assert.equal(Number(tables.rows[0]?.count), 9);
    const permissions = await client.query("SELECT COUNT(*)::text AS count FROM platform_permissions WHERE code LIKE 'platform.reference_data.%'") as { rows: Array<{ count: string }> };
    assert.equal(Number(permissions.rows[0]?.count), 6);
  } finally { await database.close(); }
});

async function seedDirectory(client: { query(text: string, values?: readonly unknown[]): Promise<unknown> }) {
  await client.query(`INSERT INTO platform_organization_units (id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at) VALUES ($1,NULL,'company','公司',NULL,'company','active',1,$3,$3),($2,$1,'team','工班',NULL,'workgroup','active',2,$3,$3)`, [IDS.company, IDS.workgroup, NOW.toISOString()]);
  await client.query(`INSERT INTO platform_positions (id,code,name,description,status,created_at,updated_at) VALUES ($1,'manager','管理岗',NULL,'active',$2,$2)`, [IDS.position, NOW.toISOString()]);
  await client.query(`INSERT INTO platform_people (id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at) VALUES ($1,'001','管理员',NULL,$2,$3,'active',NULL,$4,$4),($5,'002','人员',NULL,$2,$3,'active',NULL,$4,$4)`, [IDS.manager, IDS.workgroup, IDS.position, NOW.toISOString(), IDS.person]);
}
