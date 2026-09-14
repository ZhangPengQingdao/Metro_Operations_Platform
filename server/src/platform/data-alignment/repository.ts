import { runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import {
  DataAlignmentError,
  type DataAlignmentListInput,
  type DataAlignmentOperationHistory,
  type DictionaryItem,
  type DictionaryVersion,
  type ExternalSystem,
  type MappingProfile,
  type SourceOfTruthRule,
  type SyncCheckpoint,
  type SyncRecordResult,
  type SyncRun,
  type SyncRunCounters,
  type SyncRunStatus
} from './model.js';

export interface DataAlignmentRepository {
  createDictionaryVersion(record: DictionaryVersion, operation: DataAlignmentOperationHistory): Promise<DictionaryVersion>;
  updateDictionaryVersion(record: DictionaryVersion, expectedStatus: DictionaryVersion['status'], operation: DataAlignmentOperationHistory): Promise<DictionaryVersion>;
  findDictionaryVersionById(id: string): Promise<DictionaryVersion | null>;
  listDictionaryVersions(dictionaryKey?: string, input?: DataAlignmentListInput): Promise<DictionaryVersion[]>;
  setDictionaryItem(record: DictionaryItem, operation: DataAlignmentOperationHistory): Promise<DictionaryItem>;
  findDictionaryItem(versionId: string, code: string): Promise<DictionaryItem | null>;
  listDictionaryItems(versionId: string, input?: DataAlignmentListInput): Promise<DictionaryItem[]>;
  createExternalSystem(record: ExternalSystem, operation: DataAlignmentOperationHistory): Promise<ExternalSystem>;
  updateExternalSystem(record: ExternalSystem, expectedUpdatedAt: string, operation: DataAlignmentOperationHistory): Promise<ExternalSystem>;
  findExternalSystemById(id: string): Promise<ExternalSystem | null>;
  findExternalSystemByCode(code: string): Promise<ExternalSystem | null>;
  listExternalSystems(input?: DataAlignmentListInput): Promise<ExternalSystem[]>;
  createSourceOfTruthRule(record: SourceOfTruthRule, operation: DataAlignmentOperationHistory): Promise<SourceOfTruthRule>;
  updateSourceOfTruthRule(record: SourceOfTruthRule, expectedUpdatedAt: string, operation: DataAlignmentOperationHistory): Promise<SourceOfTruthRule>;
  findSourceOfTruthRuleById(id: string): Promise<SourceOfTruthRule | null>;
  listSourceOfTruthRules(externalSystemId?: string, input?: DataAlignmentListInput): Promise<SourceOfTruthRule[]>;
  createMappingProfile(record: MappingProfile, operation: DataAlignmentOperationHistory): Promise<MappingProfile>;
  updateMappingProfile(record: MappingProfile, expectedStatus: MappingProfile['status'], operation: DataAlignmentOperationHistory): Promise<MappingProfile>;
  findMappingProfileById(id: string): Promise<MappingProfile | null>;
  listMappingProfiles(profileKey?: string, input?: DataAlignmentListInput): Promise<MappingProfile[]>;
  createSyncRun(record: SyncRun, operation: DataAlignmentOperationHistory): Promise<{ record: SyncRun; created: boolean }>;
  updateSyncRun(record: SyncRun, expectedStatus: SyncRunStatus, expectedVersion: number, operation: DataAlignmentOperationHistory): Promise<SyncRun>;
  findSyncRunById(id: string): Promise<SyncRun | null>;
  findSyncRunByRequest(mappingProfileId: string, requestKey: string): Promise<SyncRun | null>;
  listSyncRuns(mappingProfileId: string, input?: DataAlignmentListInput): Promise<SyncRun[]>;
  createSyncRecordResult(record: SyncRecordResult, operation: DataAlignmentOperationHistory): Promise<SyncRecordResult>;
  updateSyncRecordResult(record: SyncRecordResult, expectedVersion: number, operation: DataAlignmentOperationHistory): Promise<SyncRecordResult>;
  findSyncRecordResultById(id: string): Promise<SyncRecordResult | null>;
  listSyncRecordResults(syncRunId: string, input?: DataAlignmentListInput): Promise<SyncRecordResult[]>;
  summarizeSyncRecordResults(syncRunId: string): Promise<Omit<SyncRunCounters, 'requestedCount'>>;
  advanceSyncCheckpoint(record: SyncCheckpoint, expectedVersion: number, operation: DataAlignmentOperationHistory): Promise<SyncCheckpoint>;
  findSyncCheckpoint(mappingProfileId: string, partitionKey: string): Promise<SyncCheckpoint | null>;
  listOperationHistory(entityType: DataAlignmentOperationHistory['entityType'], entityId: string): Promise<DataAlignmentOperationHistory[]>;
}

export interface MemoryDataAlignmentRepository extends DataAlignmentRepository {
  records(): {
    dictionaryVersions: DictionaryVersion[];
    dictionaryItems: DictionaryItem[];
    externalSystems: ExternalSystem[];
    sourceOfTruthRules: SourceOfTruthRule[];
    mappingProfiles: MappingProfile[];
    syncRuns: SyncRun[];
    syncRecordResults: SyncRecordResult[];
    syncCheckpoints: SyncCheckpoint[];
    operationHistory: DataAlignmentOperationHistory[];
  };
}

export function createMemoryDataAlignmentRepository(seed: Partial<ReturnType<MemoryDataAlignmentRepository['records']>> = {}): MemoryDataAlignmentRepository {
  const dictionaryVersions = toMap(seed.dictionaryVersions);
  const dictionaryItems = toMap(seed.dictionaryItems);
  const externalSystems = toMap(seed.externalSystems);
  const sourceOfTruthRules = toMap(seed.sourceOfTruthRules);
  const mappingProfiles = toMap(seed.mappingProfiles);
  const syncRuns = toMap(seed.syncRuns);
  const syncRecordResults = toMap(seed.syncRecordResults);
  const syncCheckpoints = toMap(seed.syncCheckpoints);
  const operationHistory = toMap(seed.operationHistory);
  const history = (operation: DataAlignmentOperationHistory) => {
    if (operationHistory.has(operation.id)) fail('DATA_ALIGNMENT_HISTORY_ID_CONFLICT', '操作历史 ID 已存在');
    operationHistory.set(operation.id, clone(operation));
  };

  return {
    async createDictionaryVersion(record, operation) {
      uniqueId(dictionaryVersions, record.id, 'DICTIONARY_VERSION_ID_CONFLICT');
      if ([...dictionaryVersions.values()].some((item) => item.dictionaryKey === record.dictionaryKey && item.version === record.version)) fail('DICTIONARY_VERSION_CONFLICT', '字典版本已存在');
      history(operation); dictionaryVersions.set(record.id, clone(record)); return clone(record);
    },
    async updateDictionaryVersion(record, expectedStatus, operation) {
      assertDefinitionTransition(expectedStatus, record.status);
      const current = required(dictionaryVersions, record.id, 'DICTIONARY_VERSION_NOT_FOUND');
      if (current.status !== expectedStatus) fail('DICTIONARY_VERSION_CONCURRENT_CHANGE', '字典版本已被其他操作更改');
      if (current.dictionaryKey !== record.dictionaryKey || current.version !== record.version) fail('DICTIONARY_VERSION_IDENTITY_IMMUTABLE', '字典版本标识不可修改');
      if (record.status === 'published' && [...dictionaryVersions.values()].some((item) => item.id !== record.id && item.dictionaryKey === record.dictionaryKey && item.status === 'published')) fail('PUBLISHED_DICTIONARY_EXISTS', '该字典已有发布版本');
      history(operation); dictionaryVersions.set(record.id, clone(record)); return clone(record);
    },
    async findDictionaryVersionById(id) { return cloneOrNull(dictionaryVersions.get(id)); },
    async listDictionaryVersions(dictionaryKey, input) { return limited([...dictionaryVersions.values()].filter((item) => !dictionaryKey || item.dictionaryKey === dictionaryKey).sort(compareVersion), input).map(clone); },
    async setDictionaryItem(record, operation) {
      const version = required(dictionaryVersions, record.dictionaryVersionId, 'DICTIONARY_VERSION_NOT_FOUND');
      if (version.status !== 'draft') fail('DRAFT_DICTIONARY_REQUIRED', '只能修改草稿字典');
      const sameCode = [...dictionaryItems.values()].find((item) => item.dictionaryVersionId === record.dictionaryVersionId && item.code === record.code);
      if (sameCode && sameCode.id !== record.id) fail('DICTIONARY_ITEM_CODE_CONFLICT', '字典项编码已存在');
      const sameId = dictionaryItems.get(record.id);
      if (sameId && (sameId.dictionaryVersionId !== record.dictionaryVersionId || sameId.code !== record.code)) fail('DICTIONARY_ITEM_IDENTITY_IMMUTABLE', '字典项标识不可修改');
      history(operation); dictionaryItems.set(record.id, clone(record)); return clone(record);
    },
    async findDictionaryItem(versionId, code) { return cloneOrNull([...dictionaryItems.values()].find((item) => item.dictionaryVersionId === versionId && item.code === code)); },
    async listDictionaryItems(versionId, input) { return limited([...dictionaryItems.values()].filter((item) => item.dictionaryVersionId === versionId).sort(compareItems), input).map(clone); },
    async createExternalSystem(record, operation) {
      uniqueId(externalSystems, record.id, 'EXTERNAL_SYSTEM_ID_CONFLICT');
      if ([...externalSystems.values()].some((item) => item.code === record.code)) fail('EXTERNAL_SYSTEM_CODE_CONFLICT', '外部系统编码已存在');
      history(operation); externalSystems.set(record.id, clone(record)); return clone(record);
    },
    async updateExternalSystem(record, expectedUpdatedAt, operation) {
      const current = required(externalSystems, record.id, 'EXTERNAL_SYSTEM_NOT_FOUND');
      if (current.updatedAt !== expectedUpdatedAt) fail('EXTERNAL_SYSTEM_CONCURRENT_CHANGE', '外部系统已被其他操作更改');
      if (current.code !== record.code) fail('EXTERNAL_SYSTEM_CODE_IMMUTABLE', '外部系统编码不可修改');
      history(operation); externalSystems.set(record.id, clone(record)); return clone(record);
    },
    async findExternalSystemById(id) { return cloneOrNull(externalSystems.get(id)); },
    async findExternalSystemByCode(code) { return cloneOrNull([...externalSystems.values()].find((item) => item.code === code)); },
    async listExternalSystems(input) { return limited([...externalSystems.values()].sort((a, b) => a.code.localeCompare(b.code)), input).map(clone); },
    async createSourceOfTruthRule(record, operation) {
      uniqueId(sourceOfTruthRules, record.id, 'SOURCE_OF_TRUTH_RULE_ID_CONFLICT');
      assertRuleUnique(sourceOfTruthRules.values(), record);
      history(operation); sourceOfTruthRules.set(record.id, clone(record)); return clone(record);
    },
    async updateSourceOfTruthRule(record, expectedUpdatedAt, operation) {
      const current = required(sourceOfTruthRules, record.id, 'SOURCE_OF_TRUTH_RULE_NOT_FOUND');
      if (current.updatedAt !== expectedUpdatedAt) fail('SOURCE_OF_TRUTH_RULE_CONCURRENT_CHANGE', '数据权威规则已被其他操作更改');
      if (current.externalSystemId !== record.externalSystemId || current.platformEntityType !== record.platformEntityType || current.authorityScopeKey !== record.authorityScopeKey || current.authority !== record.authority || current.effectiveFrom !== record.effectiveFrom) fail('SOURCE_OF_TRUTH_RULE_IDENTITY_IMMUTABLE', '数据权威规则标识与权威不可修改');
      if (current.status !== 'active' || record.status !== 'inactive' || current.effectiveTo !== null || record.effectiveTo === null) fail('SOURCE_OF_TRUTH_RULE_CLOSE_REQUIRED', '数据权威规则只能从启用状态关闭');
      assertRuleUnique(sourceOfTruthRules.values(), record, record.id);
      history(operation); sourceOfTruthRules.set(record.id, clone(record)); return clone(record);
    },
    async findSourceOfTruthRuleById(id) { return cloneOrNull(sourceOfTruthRules.get(id)); },
    async listSourceOfTruthRules(externalSystemId, input) { return limited([...sourceOfTruthRules.values()].filter((item) => !externalSystemId || item.externalSystemId === externalSystemId).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.id.localeCompare(b.id)), input).map(clone); },
    async createMappingProfile(record, operation) {
      uniqueId(mappingProfiles, record.id, 'MAPPING_PROFILE_ID_CONFLICT');
      if ([...mappingProfiles.values()].some((item) => item.profileKey === record.profileKey && item.version === record.version)) fail('MAPPING_PROFILE_VERSION_CONFLICT', '映射配置版本已存在');
      assertProfileReferences(record, externalSystems, sourceOfTruthRules);
      history(operation); mappingProfiles.set(record.id, clone(record)); return clone(record);
    },
    async updateMappingProfile(record, expectedStatus, operation) {
      assertDefinitionTransition(expectedStatus, record.status);
      const current = required(mappingProfiles, record.id, 'MAPPING_PROFILE_NOT_FOUND');
      if (current.status !== expectedStatus) fail('MAPPING_PROFILE_CONCURRENT_CHANGE', '映射配置已被其他操作更改');
      assertProfileIdentity(current, record);
      if (record.status === 'published' && [...mappingProfiles.values()].some((item) => item.id !== record.id && item.profileKey === record.profileKey && item.status === 'published')) fail('PUBLISHED_MAPPING_PROFILE_EXISTS', '该配置已有发布版本');
      assertProfileReferences(record, externalSystems, sourceOfTruthRules, record.status === 'published' ? record.publishedAt : null);
      history(operation); mappingProfiles.set(record.id, clone(record)); return clone(record);
    },
    async findMappingProfileById(id) { return cloneOrNull(mappingProfiles.get(id)); },
    async listMappingProfiles(profileKey, input) { return limited([...mappingProfiles.values()].filter((item) => !profileKey || item.profileKey === profileKey).sort(compareVersion), input).map(clone); },
    async createSyncRun(record, operation) {
      const existing = [...syncRuns.values()].find((item) => item.mappingProfileId === record.mappingProfileId && item.requestKey === record.requestKey);
      if (existing) return { record: clone(existing), created: false };
      uniqueId(syncRuns, record.id, 'SYNC_RUN_ID_CONFLICT');
      const profile = required(mappingProfiles, record.mappingProfileId, 'MAPPING_PROFILE_NOT_FOUND');
      if (profile.status !== 'published') fail('PUBLISHED_MAPPING_PROFILE_REQUIRED', '同步运行必须使用已发布配置');
      assertProfileReferences(profile, externalSystems, sourceOfTruthRules, record.queuedAt);
      assertRunOwner(profile, record);
      history(operation); syncRuns.set(record.id, clone(record)); return { record: clone(record), created: true };
    },
    async updateSyncRun(record, expectedStatus, expectedVersion, operation) {
      assertSyncRunTransition(expectedStatus, record.status);
      const current = required(syncRuns, record.id, 'SYNC_RUN_NOT_FOUND');
      if (current.status !== expectedStatus || current.version !== expectedVersion) fail('SYNC_RUN_CONCURRENT_CHANGE', '同步运行已被其他操作更改');
      assertRunIdentity(current, record);
      if (['succeeded', 'partial', 'failed'].includes(record.status)) assertRunCounters(record, [...syncRecordResults.values()].filter((item) => item.syncRunId === record.id));
      history(operation); syncRuns.set(record.id, clone(record)); return clone(record);
    },
    async findSyncRunById(id) { return cloneOrNull(syncRuns.get(id)); },
    async findSyncRunByRequest(mappingProfileId, requestKey) { return cloneOrNull([...syncRuns.values()].find((item) => item.mappingProfileId === mappingProfileId && item.requestKey === requestKey)); },
    async listSyncRuns(mappingProfileId, input) { return limited([...syncRuns.values()].filter((item) => item.mappingProfileId === mappingProfileId).sort((a, b) => b.queuedAt.localeCompare(a.queuedAt) || a.id.localeCompare(b.id)), input).map(clone); },
    async createSyncRecordResult(record, operation) {
      const run = required(syncRuns, record.syncRunId, 'SYNC_RUN_NOT_FOUND');
      const existing = [...syncRecordResults.values()].find((item) => item.syncRunId === record.syncRunId && item.sourceRecordKey === record.sourceRecordKey);
      if (existing) {
        if (!sameSyncResult(existing, record)) fail('SYNC_SOURCE_RECORD_CONFLICT', '相同来源记录键的同步证据不一致');
        return clone(existing);
      }
      uniqueId(syncRecordResults, record.id, 'SYNC_RESULT_ID_CONFLICT');
      if (run.status !== 'running') fail('RUNNING_SYNC_RUN_REQUIRED', '只能向运行中的同步写入结果');
      const profile = required(mappingProfiles, run.mappingProfileId, 'MAPPING_PROFILE_NOT_FOUND');
      if (record.platformEntityType && record.platformEntityType !== profile.platformEntityType) fail('SYNC_RESULT_ENTITY_TYPE_MISMATCH', '同步结果实体类型与映射档案不一致');
      if ([...syncRecordResults.values()].filter((item) => item.syncRunId === record.syncRunId).length >= run.requestedCount) fail('SYNC_RESULT_COUNT_EXCEEDS_REQUESTED', '逐条结果数超过请求数');
      history(operation); syncRecordResults.set(record.id, clone(record)); return clone(record);
    },
    async updateSyncRecordResult(record, expectedVersion, operation) {
      assertConflictResolution(record);
      const current = required(syncRecordResults, record.id, 'SYNC_RESULT_NOT_FOUND');
      if (current.version !== expectedVersion || current.outcome !== 'conflict' || current.conflictState !== 'open') fail('SYNC_CONFLICT_CONCURRENT_CHANGE', '同步冲突已被解决或更改');
      assertResultIdentity(current, record);
      history(operation); syncRecordResults.set(record.id, clone(record)); return clone(record);
    },
    async findSyncRecordResultById(id) { return cloneOrNull(syncRecordResults.get(id)); },
    async listSyncRecordResults(syncRunId, input) { return limited([...syncRecordResults.values()].filter((item) => item.syncRunId === syncRunId).sort((a, b) => a.sourceRecordKey.localeCompare(b.sourceRecordKey)), input).map(clone); },
    async summarizeSyncRecordResults(syncRunId) { return resultCounters([...syncRecordResults.values()].filter((item) => item.syncRunId === syncRunId)); },
    async advanceSyncCheckpoint(record, expectedVersion, operation) {
      const run = required(syncRuns, record.lastSuccessfulRunId, 'SYNC_RUN_NOT_FOUND');
      if (run.mappingProfileId !== record.mappingProfileId || run.status !== 'succeeded') fail('SUCCESSFUL_MATCHING_RUN_REQUIRED', '检查点只能由同一配置的成功运行推进');
      const current = [...syncCheckpoints.values()].find((item) => item.mappingProfileId === record.mappingProfileId && item.partitionKey === record.partitionKey);
      if (!current) {
        if (expectedVersion !== 0) fail('SYNC_CHECKPOINT_CONCURRENT_CHANGE', '检查点版本不一致');
        uniqueId(syncCheckpoints, record.id, 'SYNC_CHECKPOINT_ID_CONFLICT');
      } else {
        if (current.id !== record.id || current.version !== expectedVersion) fail('SYNC_CHECKPOINT_CONCURRENT_CHANGE', '检查点已被其他操作推进');
        if (current.sourceWatermarkAt && (!record.sourceWatermarkAt || record.sourceWatermarkAt < current.sourceWatermarkAt)) fail('SYNC_CHECKPOINT_REGRESSION', '检查点水位不能清空或回退');
        const previousRun = required(syncRuns, current.lastSuccessfulRunId, 'SYNC_RUN_NOT_FOUND');
        if ((run.completedAt ?? '') < (previousRun.completedAt ?? '')) fail('SYNC_CHECKPOINT_REGRESSION', '检查点不能由更早运行覆盖');
      }
      history(operation); syncCheckpoints.set(record.id, clone(record)); return clone(record);
    },
    async findSyncCheckpoint(mappingProfileId, partitionKey) { return cloneOrNull([...syncCheckpoints.values()].find((item) => item.mappingProfileId === mappingProfileId && item.partitionKey === partitionKey)); },
    async listOperationHistory(entityType, entityId) { return [...operationHistory.values()].filter((item) => item.entityType === entityType && item.entityId === entityId).sort(compareHistory).map(clone); },
    records() {
      return {
        dictionaryVersions: [...dictionaryVersions.values()].sort(compareVersion).map(clone), dictionaryItems: [...dictionaryItems.values()].sort(compareItems).map(clone),
        externalSystems: [...externalSystems.values()].sort((a, b) => a.code.localeCompare(b.code)).map(clone), sourceOfTruthRules: [...sourceOfTruthRules.values()].map(clone),
        mappingProfiles: [...mappingProfiles.values()].sort(compareVersion).map(clone), syncRuns: [...syncRuns.values()].map(clone), syncRecordResults: [...syncRecordResults.values()].map(clone),
        syncCheckpoints: [...syncCheckpoints.values()].map(clone), operationHistory: [...operationHistory.values()].sort(compareHistory).map(clone)
      };
    }
  };
}

export function createPostgresDataAlignmentRepository(client: QueryableClient): DataAlignmentRepository {
  const atomic = <T>(write: (db: QueryableClient) => Promise<T>, operation: DataAlignmentOperationHistory) =>
    runDatabaseTransaction(client, async (db) => { const value = await write(db); await insertHistory(db, operation); return value; });

  return {
    async createDictionaryVersion(record, operation) {
      return atomic(async (db) => mapDictionaryVersion(one(await db.query(
        `INSERT INTO platform_dictionary_versions
         (id,dictionary_key,version,name,description,status,created_by_person_id,published_by_person_id,retired_by_person_id,created_at,updated_at,published_at,retired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        dictionaryVersionValues(record)
      ), 'DICTIONARY_VERSION_INSERT_FAILED')), operation);
    },
    async updateDictionaryVersion(record, expectedStatus, operation) {
      assertDefinitionTransition(expectedStatus, record.status);
      return atomic(async (db) => mapDictionaryVersion(one(await db.query(
        `UPDATE platform_dictionary_versions SET status=$2,published_by_person_id=$3,retired_by_person_id=$4,updated_at=$5,published_at=$6,retired_at=$7
         WHERE id=$1 AND status=$8 RETURNING *`,
        [record.id, record.status, record.publishedByPersonId, record.retiredByPersonId, record.updatedAt, record.publishedAt, record.retiredAt, expectedStatus]
      ), 'DICTIONARY_VERSION_CONCURRENT_CHANGE')), operation);
    },
    async findDictionaryVersionById(id) { return optional(await client.query('SELECT * FROM platform_dictionary_versions WHERE id=$1', [id]), mapDictionaryVersion); },
    async listDictionaryVersions(dictionaryKey, input) {
      const limit = limitOf(input);
      return rows(await client.query(
        `SELECT * FROM platform_dictionary_versions WHERE ($1::text IS NULL OR dictionary_key=$1) ORDER BY dictionary_key,version DESC,id LIMIT $2`,
        [dictionaryKey ?? null, limit]
      )).map(mapDictionaryVersion);
    },
    async setDictionaryItem(record, operation) {
      return atomic(async (db) => {
        const version = optional(await db.query('SELECT * FROM platform_dictionary_versions WHERE id=$1 FOR UPDATE', [record.dictionaryVersionId]), mapDictionaryVersion);
        if (!version) fail('DICTIONARY_VERSION_NOT_FOUND', '字典版本不存在');
        if (version.status !== 'draft') fail('DRAFT_DICTIONARY_REQUIRED', '只能修改草稿字典');
        const existing = optional(await db.query('SELECT * FROM platform_dictionary_items WHERE dictionary_version_id=$1 AND code=$2 FOR UPDATE', [record.dictionaryVersionId, record.code]), mapDictionaryItem);
        if (existing && existing.id !== record.id) fail('DICTIONARY_ITEM_CODE_CONFLICT', '字典项编码已存在');
        const query = existing
          ? db.query(`UPDATE platform_dictionary_items SET label=$2,description=$3,sort_order=$4,active=$5,updated_at=$6 WHERE id=$1 RETURNING *`, [record.id, record.label, record.description, record.sortOrder, record.active, record.updatedAt])
          : db.query(`INSERT INTO platform_dictionary_items (id,dictionary_version_id,code,label,description,sort_order,active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, dictionaryItemValues(record));
        return mapDictionaryItem(one(await query, 'DICTIONARY_ITEM_WRITE_FAILED'));
      }, operation);
    },
    async findDictionaryItem(versionId, code) { return optional(await client.query('SELECT * FROM platform_dictionary_items WHERE dictionary_version_id=$1 AND code=$2', [versionId, code]), mapDictionaryItem); },
    async listDictionaryItems(versionId, input) { return rows(await client.query('SELECT * FROM platform_dictionary_items WHERE dictionary_version_id=$1 ORDER BY sort_order,code,id LIMIT $2', [versionId, limitOf(input)])).map(mapDictionaryItem); },
    async createExternalSystem(record, operation) {
      return atomic(async (db) => mapExternalSystem(one(await db.query(
        `INSERT INTO platform_external_systems (id,code,name,description,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [record.id, record.code, record.name, record.description, record.status, record.createdAt, record.updatedAt]
      ), 'EXTERNAL_SYSTEM_INSERT_FAILED')), operation);
    },
    async updateExternalSystem(record, expectedUpdatedAt, operation) {
      return atomic(async (db) => mapExternalSystem(one(await db.query(
        `UPDATE platform_external_systems SET name=$2,description=$3,status=$4,updated_at=$5 WHERE id=$1 AND updated_at=$6 RETURNING *`,
        [record.id, record.name, record.description, record.status, record.updatedAt, expectedUpdatedAt]
      ), 'EXTERNAL_SYSTEM_CONCURRENT_CHANGE')), operation);
    },
    async findExternalSystemById(id) { return optional(await client.query('SELECT * FROM platform_external_systems WHERE id=$1', [id]), mapExternalSystem); },
    async findExternalSystemByCode(code) { return optional(await client.query('SELECT * FROM platform_external_systems WHERE code=$1', [code]), mapExternalSystem); },
    async listExternalSystems(input) { return rows(await client.query('SELECT * FROM platform_external_systems ORDER BY code,id LIMIT $1', [limitOf(input)])).map(mapExternalSystem); },
    async createSourceOfTruthRule(record, operation) {
      return atomic(async (db) => {
        await db.query('SELECT id FROM platform_external_systems WHERE id=$1 FOR UPDATE', [record.externalSystemId]);
        if (record.status === 'active') {
          const overlaps = rows(await db.query(
            `SELECT id FROM platform_source_of_truth_rules
             WHERE external_system_id=$1 AND platform_entity_type=$2 AND authority_scope_key=$3 AND status='active'
               AND effective_from<=COALESCE($5::timestamptz,'infinity'::timestamptz)
               AND COALESCE(effective_to,'infinity'::timestamptz)>=$4::timestamptz
             LIMIT 1`,
            [record.externalSystemId, record.platformEntityType, record.authorityScopeKey, record.effectiveFrom, record.effectiveTo]
          ));
          if (overlaps.length > 0) fail('SOURCE_OF_TRUTH_RULE_OVERLAP', '同一权威范围的生效时间重叠');
        }
        return mapSourceOfTruthRule(one(await db.query(
          `INSERT INTO platform_source_of_truth_rules
           (id,external_system_id,platform_entity_type,authority_scope_key,authority,status,effective_from,effective_to,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, sourceOfTruthRuleValues(record)
        ), 'SOURCE_OF_TRUTH_RULE_INSERT_FAILED'));
      }, operation);
    },
    async updateSourceOfTruthRule(record, expectedUpdatedAt, operation) {
      return atomic(async (db) => mapSourceOfTruthRule(one(await db.query(
        `UPDATE platform_source_of_truth_rules SET status='inactive',effective_to=$2,updated_at=$3
         WHERE id=$1 AND updated_at=$4 AND status='active' AND effective_to IS NULL RETURNING *`,
        [record.id, record.effectiveTo, record.updatedAt, expectedUpdatedAt]
      ), 'SOURCE_OF_TRUTH_RULE_CONCURRENT_CHANGE')), operation);
    },
    async findSourceOfTruthRuleById(id) { return optional(await client.query('SELECT * FROM platform_source_of_truth_rules WHERE id=$1', [id]), mapSourceOfTruthRule); },
    async listSourceOfTruthRules(externalSystemId, input) { return rows(await client.query(
      `SELECT * FROM platform_source_of_truth_rules WHERE ($1::uuid IS NULL OR external_system_id=$1) ORDER BY effective_from,id LIMIT $2`,
      [externalSystemId ?? null, limitOf(input)]
    )).map(mapSourceOfTruthRule); },
    async createMappingProfile(record, operation) {
      return atomic(async (db) => mapMappingProfile(one(await db.query(
        `INSERT INTO platform_mapping_profiles
         (id,profile_key,version,name,description,owner_type,owner_app_id,external_system_id,source_of_truth_rule_id,platform_entity_type,direction,status,created_by_person_id,published_by_person_id,retired_by_person_id,created_at,updated_at,published_at,retired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`, mappingProfileValues(record)
      ), 'MAPPING_PROFILE_INSERT_FAILED')), operation);
    },
    async updateMappingProfile(record, expectedStatus, operation) {
      assertDefinitionTransition(expectedStatus, record.status);
      return atomic(async (db) => {
        if (record.status === 'published') {
          const valid = rows(await db.query(
            `SELECT profile.id FROM platform_mapping_profiles profile
             JOIN platform_external_systems system ON system.id=profile.external_system_id AND system.status='active'
             JOIN platform_source_of_truth_rules rule ON rule.id=profile.source_of_truth_rule_id AND rule.status='active'
             WHERE profile.id=$1 AND profile.external_system_id=rule.external_system_id
               AND profile.platform_entity_type=rule.platform_entity_type
               AND rule.effective_from<=$2::timestamptz
               AND (rule.effective_to IS NULL OR rule.effective_to>=$2::timestamptz)
             FOR UPDATE OF profile,system,rule`,
            [record.id, record.publishedAt]
          ));
          if (valid.length === 0) fail('MAPPING_PROFILE_RULE_MISMATCH', '映射档案的外部系统或数据权威规则未生效');
        }
        return mapMappingProfile(one(await db.query(
          `UPDATE platform_mapping_profiles SET status=$2,published_by_person_id=$3,retired_by_person_id=$4,updated_at=$5,published_at=$6,retired_at=$7 WHERE id=$1 AND status=$8 RETURNING *`,
          [record.id, record.status, record.publishedByPersonId, record.retiredByPersonId, record.updatedAt, record.publishedAt, record.retiredAt, expectedStatus]
        ), 'MAPPING_PROFILE_CONCURRENT_CHANGE'));
      }, operation);
    },
    async findMappingProfileById(id) { return optional(await client.query('SELECT * FROM platform_mapping_profiles WHERE id=$1', [id]), mapMappingProfile); },
    async listMappingProfiles(profileKey, input) { return rows(await client.query(
      `SELECT * FROM platform_mapping_profiles WHERE ($1::text IS NULL OR profile_key=$1) ORDER BY profile_key,version DESC,id LIMIT $2`,
      [profileKey ?? null, limitOf(input)]
    )).map(mapMappingProfile); },
    async createSyncRun(record, operation) {
      return runDatabaseTransaction(client, async (db) => {
        const existing = optional(await db.query('SELECT * FROM platform_sync_runs WHERE mapping_profile_id=$1 AND request_key=$2 FOR UPDATE', [record.mappingProfileId, record.requestKey]), mapSyncRun);
        if (existing) return { record: existing, created: false };
        const valid = rows(await db.query(
          `SELECT profile.id FROM platform_mapping_profiles profile
           JOIN platform_external_systems system ON system.id=profile.external_system_id AND system.status='active'
           JOIN platform_source_of_truth_rules rule ON rule.id=profile.source_of_truth_rule_id AND rule.status='active'
           WHERE profile.id=$1 AND profile.status='published'
             AND profile.external_system_id=rule.external_system_id
             AND profile.platform_entity_type=rule.platform_entity_type
             AND rule.effective_from<=$2::timestamptz
             AND (rule.effective_to IS NULL OR rule.effective_to>=$2::timestamptz)
             AND ((profile.owner_type='platform' AND $3::varchar='platform' AND $4::varchar IS NULL)
               OR (profile.owner_type='application' AND profile.owner_app_id=$4::varchar))
           FOR UPDATE OF profile,system,rule`,
          [record.mappingProfileId, record.queuedAt, record.executionType, record.sourceAppId]
        ));
        if (valid.length === 0) fail('PUBLISHED_MAPPING_PROFILE_REQUIRED', '同步运行必须使用当前有效且所有者匹配的已发布配置');
        const concurrentExisting = optional(await db.query('SELECT * FROM platform_sync_runs WHERE mapping_profile_id=$1 AND request_key=$2 FOR UPDATE', [record.mappingProfileId, record.requestKey]), mapSyncRun);
        if (concurrentExisting) return { record: concurrentExisting, created: false };
        const saved = mapSyncRun(one(await db.query(
          `INSERT INTO platform_sync_runs
           (id,mapping_profile_id,request_key,status,version,requested_count,processed_count,created_count,updated_count,succeeded_count,unchanged_count,skipped_count,conflict_count,failed_count,failure_code,summary,actor_type,actor_person_id,service_identity_id,execution_type,source_app_id,request_id,trace_id,queued_at,started_at,completed_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
           RETURNING *`,
          syncRunValues(record)
        ), 'SYNC_RUN_INSERT_FAILED'));
        await insertHistory(db, operation);
        return { record: saved, created: true };
      });
    },
    async updateSyncRun(record, expectedStatus, expectedVersion, operation) {
      assertSyncRunTransition(expectedStatus, record.status);
      return atomic(async (db) => {
        const current = optional(await db.query('SELECT * FROM platform_sync_runs WHERE id=$1 FOR UPDATE', [record.id]), mapSyncRun);
        if (!current || current.status !== expectedStatus || current.version !== expectedVersion) fail('SYNC_RUN_CONCURRENT_CHANGE', '同步运行已被其他操作更改');
        if (['succeeded', 'partial', 'failed'].includes(record.status)) {
          const results = rows(await db.query('SELECT * FROM platform_sync_record_results WHERE sync_run_id=$1 ORDER BY source_record_key FOR UPDATE', [record.id])).map(mapSyncRecordResult);
          assertRunCounters(record, results);
        }
        return mapSyncRun(one(await db.query(
          `UPDATE platform_sync_runs SET status=$2,version=$3,processed_count=$4,created_count=$5,updated_count=$6,succeeded_count=$7,unchanged_count=$8,skipped_count=$9,conflict_count=$10,failed_count=$11,failure_code=$12,summary=$13,started_at=$14,completed_at=$15,updated_at=$16
           WHERE id=$1 AND status=$17 AND version=$18 RETURNING *`,
          [record.id, record.status, record.version, record.processedCount, record.createdCount, record.updatedCount, record.succeededCount, record.unchangedCount, record.skippedCount, record.conflictCount, record.failedCount, record.failureCode, record.summary, record.startedAt, record.completedAt, record.updatedAt, expectedStatus, expectedVersion]
        ), 'SYNC_RUN_CONCURRENT_CHANGE'));
      }, operation);
    },
    async findSyncRunById(id) { return optional(await client.query('SELECT * FROM platform_sync_runs WHERE id=$1', [id]), mapSyncRun); },
    async findSyncRunByRequest(mappingProfileId, requestKey) { return optional(await client.query('SELECT * FROM platform_sync_runs WHERE mapping_profile_id=$1 AND request_key=$2', [mappingProfileId, requestKey]), mapSyncRun); },
    async listSyncRuns(mappingProfileId, input) { return rows(await client.query('SELECT * FROM platform_sync_runs WHERE mapping_profile_id=$1 ORDER BY queued_at DESC,id LIMIT $2', [mappingProfileId, limitOf(input)])).map(mapSyncRun); },
    async createSyncRecordResult(record, operation) {
      return runDatabaseTransaction(client, async (db) => {
        const run = optional(await db.query('SELECT * FROM platform_sync_runs WHERE id=$1 FOR UPDATE', [record.syncRunId]), mapSyncRun);
        if (!run) fail('SYNC_RUN_NOT_FOUND', '同步运行不存在');
        const existing = optional(await db.query('SELECT * FROM platform_sync_record_results WHERE sync_run_id=$1 AND source_record_key=$2 FOR UPDATE', [record.syncRunId, record.sourceRecordKey]), mapSyncRecordResult);
        if (existing) {
          if (!sameSyncResult(existing, record)) fail('SYNC_SOURCE_RECORD_CONFLICT', '相同来源记录键的同步证据不一致');
          return existing;
        }
        if (run.status !== 'running') fail('RUNNING_SYNC_RUN_REQUIRED', '只能向运行中的同步写入结果');
        const profile = optional(await db.query('SELECT * FROM platform_mapping_profiles WHERE id=$1', [run.mappingProfileId]), mapMappingProfile);
        if (!profile) fail('MAPPING_PROFILE_NOT_FOUND', '映射档案不存在');
        if (record.platformEntityType && record.platformEntityType !== profile.platformEntityType) fail('SYNC_RESULT_ENTITY_TYPE_MISMATCH', '同步结果实体类型与映射档案不一致');
        const resultCount = rows(await db.query('SELECT id FROM platform_sync_record_results WHERE sync_run_id=$1', [record.syncRunId])).length;
        if (resultCount >= run.requestedCount) fail('SYNC_RESULT_COUNT_EXCEEDS_REQUESTED', '逐条结果数超过请求数');
        const saved = mapSyncRecordResult(one(await db.query(
          `INSERT INTO platform_sync_record_results
           (id,sync_run_id,source_record_key,external_entity_id,platform_entity_type,platform_entity_id,source_attachment_id,source_row,source_sha256,target_sha256,outcome,error_code,error_summary,conflict_state,conflict_resolution,resolution_note,resolved_by_person_id,resolved_by_service_identity_id,resolved_at,version,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`, syncRecordResultValues(record)
        ), 'SYNC_RESULT_INSERT_FAILED'));
        await insertHistory(db, operation);
        return saved;
      });
    },
    async updateSyncRecordResult(record, expectedVersion, operation) {
      assertConflictResolution(record);
      return atomic(async (db) => mapSyncRecordResult(one(await db.query(
        `UPDATE platform_sync_record_results SET conflict_state=$2,conflict_resolution=$3,resolution_note=$4,resolved_by_person_id=$5,resolved_by_service_identity_id=$6,resolved_at=$7,version=$8,updated_at=$9
         WHERE id=$1 AND version=$10 AND outcome='conflict' AND conflict_state='open' RETURNING *`,
        [record.id, record.conflictState, record.conflictResolution, record.resolutionNote, record.resolvedByPersonId, record.resolvedByServiceIdentityId, record.resolvedAt, record.version, record.updatedAt, expectedVersion]
      ), 'SYNC_CONFLICT_CONCURRENT_CHANGE')), operation);
    },
    async findSyncRecordResultById(id) { return optional(await client.query('SELECT * FROM platform_sync_record_results WHERE id=$1', [id]), mapSyncRecordResult); },
    async listSyncRecordResults(syncRunId, input) { return rows(await client.query('SELECT * FROM platform_sync_record_results WHERE sync_run_id=$1 ORDER BY source_record_key,id LIMIT $2', [syncRunId, limitOf(input)])).map(mapSyncRecordResult); },
    async summarizeSyncRecordResults(syncRunId) {
      const row = one(await client.query(
        `SELECT COUNT(*)::text AS processed_count,
          COUNT(*) FILTER (WHERE outcome='created')::text AS created_count,
          COUNT(*) FILTER (WHERE outcome='updated')::text AS updated_count,
          COUNT(*) FILTER (WHERE outcome='unchanged')::text AS unchanged_count,
          COUNT(*) FILTER (WHERE outcome='skipped')::text AS skipped_count,
          COUNT(*) FILTER (WHERE outcome='conflict')::text AS conflict_count,
          COUNT(*) FILTER (WHERE outcome='failed')::text AS failed_count
         FROM platform_sync_record_results WHERE sync_run_id=$1`,
        [syncRunId]
      ), 'SYNC_RESULT_SUMMARY_FAILED');
      const value = object(row);
      const createdCount = numberRow(value.created_count); const updatedCount = numberRow(value.updated_count);
      return { processedCount: numberRow(value.processed_count), createdCount, updatedCount, succeededCount: createdCount + updatedCount, unchangedCount: numberRow(value.unchanged_count), skippedCount: numberRow(value.skipped_count), conflictCount: numberRow(value.conflict_count), failedCount: numberRow(value.failed_count) };
    },
    async advanceSyncCheckpoint(record, expectedVersion, operation) {
      return atomic(async (db) => {
        const run = optional(await db.query('SELECT * FROM platform_sync_runs WHERE id=$1 FOR UPDATE', [record.lastSuccessfulRunId]), mapSyncRun);
        if (!run || run.mappingProfileId !== record.mappingProfileId || run.status !== 'succeeded') fail('SUCCESSFUL_MATCHING_RUN_REQUIRED', '检查点只能由同一配置的成功运行推进');
        const current = optional(await db.query('SELECT * FROM platform_sync_checkpoints WHERE mapping_profile_id=$1 AND partition_key=$2 FOR UPDATE', [record.mappingProfileId, record.partitionKey]), mapSyncCheckpoint);
        if (!current) {
          if (expectedVersion !== 0) fail('SYNC_CHECKPOINT_CONCURRENT_CHANGE', '检查点版本不一致');
          return mapSyncCheckpoint(one(await db.query(
            `INSERT INTO platform_sync_checkpoints (id,mapping_profile_id,partition_key,cursor,source_watermark_at,last_successful_run_id,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, checkpointValues(record)
          ), 'SYNC_CHECKPOINT_INSERT_FAILED'));
        }
        if (current.id !== record.id || current.version !== expectedVersion) fail('SYNC_CHECKPOINT_CONCURRENT_CHANGE', '检查点已被其他操作推进');
        if (current.sourceWatermarkAt && (!record.sourceWatermarkAt || record.sourceWatermarkAt < current.sourceWatermarkAt)) fail('SYNC_CHECKPOINT_REGRESSION', '检查点水位不能清空或回退');
        const previousRun = optional(await db.query('SELECT * FROM platform_sync_runs WHERE id=$1', [current.lastSuccessfulRunId]), mapSyncRun);
        if (!previousRun || (run.completedAt ?? '') < (previousRun.completedAt ?? '')) fail('SYNC_CHECKPOINT_REGRESSION', '检查点不能由更早运行覆盖');
        return mapSyncCheckpoint(one(await db.query(
          `UPDATE platform_sync_checkpoints SET cursor=$2,source_watermark_at=$3,last_successful_run_id=$4,version=$5,updated_at=$6 WHERE id=$1 AND version=$7 RETURNING *`,
          [record.id, record.cursor, record.sourceWatermarkAt, record.lastSuccessfulRunId, record.version, record.updatedAt, expectedVersion]
        ), 'SYNC_CHECKPOINT_CONCURRENT_CHANGE'));
      }, operation);
    },
    async findSyncCheckpoint(mappingProfileId, partitionKey) { return optional(await client.query('SELECT * FROM platform_sync_checkpoints WHERE mapping_profile_id=$1 AND partition_key=$2', [mappingProfileId, partitionKey]), mapSyncCheckpoint); },
    async listOperationHistory(entityType, entityId) { return rows(await client.query('SELECT * FROM platform_data_alignment_operation_history WHERE entity_type=$1 AND entity_id=$2 ORDER BY occurred_at,id', [entityType, entityId])).map(mapHistory); }
  };
}

async function insertHistory(client: QueryableClient, record: DataAlignmentOperationHistory) {
  await client.query(
    `INSERT INTO platform_data_alignment_operation_history
     (id,operation,entity_type,entity_id,actor_type,actor_person_id,service_identity_id,execution_type,source_app_id,request_id,trace_id,note,before_summary,after_summary,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
    [record.id, record.operation, record.entityType, record.entityId, record.actorType, record.actorPersonId, record.serviceIdentityId, record.executionType, record.sourceAppId, record.requestId, record.traceId, record.note, json(record.before), json(record.after), record.occurredAt]
  );
}

function dictionaryVersionValues(record: DictionaryVersion) { return [record.id, record.dictionaryKey, record.version, record.name, record.description, record.status, record.createdByPersonId, record.publishedByPersonId, record.retiredByPersonId, record.createdAt, record.updatedAt, record.publishedAt, record.retiredAt]; }
function dictionaryItemValues(record: DictionaryItem) { return [record.id, record.dictionaryVersionId, record.code, record.label, record.description, record.sortOrder, record.active, record.createdAt, record.updatedAt]; }
function sourceOfTruthRuleValues(record: SourceOfTruthRule) { return [record.id, record.externalSystemId, record.platformEntityType, record.authorityScopeKey, record.authority, record.status, record.effectiveFrom, record.effectiveTo, record.createdAt, record.updatedAt]; }
function mappingProfileValues(record: MappingProfile) { return [record.id, record.profileKey, record.version, record.name, record.description, record.ownerType, record.ownerAppId, record.externalSystemId, record.sourceOfTruthRuleId, record.platformEntityType, record.direction, record.status, record.createdByPersonId, record.publishedByPersonId, record.retiredByPersonId, record.createdAt, record.updatedAt, record.publishedAt, record.retiredAt]; }
function syncRunValues(record: SyncRun) { return [record.id, record.mappingProfileId, record.requestKey, record.status, record.version, record.requestedCount, record.processedCount, record.createdCount, record.updatedCount, record.succeededCount, record.unchangedCount, record.skippedCount, record.conflictCount, record.failedCount, record.failureCode, record.summary, record.actorType, record.actorPersonId, record.serviceIdentityId, record.executionType, record.sourceAppId, record.requestId, record.traceId, record.queuedAt, record.startedAt, record.completedAt, record.updatedAt]; }
function syncRecordResultValues(record: SyncRecordResult) { return [record.id, record.syncRunId, record.sourceRecordKey, record.externalEntityId, record.platformEntityType, record.platformEntityId, record.sourceAttachmentId, record.sourceRow, record.sourceSha256, record.targetSha256, record.outcome, record.errorCode, record.errorSummary, record.conflictState, record.conflictResolution, record.resolutionNote, record.resolvedByPersonId, record.resolvedByServiceIdentityId, record.resolvedAt, record.version, record.createdAt, record.updatedAt]; }
function checkpointValues(record: SyncCheckpoint) { return [record.id, record.mappingProfileId, record.partitionKey, record.cursor, record.sourceWatermarkAt, record.lastSuccessfulRunId, record.version, record.createdAt, record.updatedAt]; }

function mapDictionaryVersion(value: unknown): DictionaryVersion { const row = object(value); return { id: textRow(row.id), dictionaryKey: textRow(row.dictionary_key), version: numberRow(row.version), name: textRow(row.name), description: nullableTextRow(row.description), status: textRow(row.status) as DictionaryVersion['status'], createdByPersonId: nullableTextRow(row.created_by_person_id), publishedByPersonId: nullableTextRow(row.published_by_person_id), retiredByPersonId: nullableTextRow(row.retired_by_person_id), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), publishedAt: nullableInstant(row.published_at), retiredAt: nullableInstant(row.retired_at) }; }
function mapDictionaryItem(value: unknown): DictionaryItem { const row = object(value); return { id: textRow(row.id), dictionaryVersionId: textRow(row.dictionary_version_id), code: textRow(row.code), label: textRow(row.label), description: nullableTextRow(row.description), sortOrder: numberRow(row.sort_order), active: booleanRow(row.active), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) }; }
function mapExternalSystem(value: unknown): ExternalSystem { const row = object(value); return { id: textRow(row.id), code: textRow(row.code), name: textRow(row.name), description: nullableTextRow(row.description), status: textRow(row.status) as ExternalSystem['status'], createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) }; }
function mapSourceOfTruthRule(value: unknown): SourceOfTruthRule { const row = object(value); return { id: textRow(row.id), externalSystemId: textRow(row.external_system_id), platformEntityType: textRow(row.platform_entity_type) as SourceOfTruthRule['platformEntityType'], authorityScopeKey: textRow(row.authority_scope_key), authority: textRow(row.authority) as SourceOfTruthRule['authority'], status: textRow(row.status) as SourceOfTruthRule['status'], effectiveFrom: instant(row.effective_from), effectiveTo: nullableInstant(row.effective_to), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) }; }
function mapMappingProfile(value: unknown): MappingProfile { const row = object(value); return { id: textRow(row.id), profileKey: textRow(row.profile_key), version: numberRow(row.version), name: textRow(row.name), description: nullableTextRow(row.description), ownerType: textRow(row.owner_type) as MappingProfile['ownerType'], ownerAppId: nullableTextRow(row.owner_app_id), externalSystemId: textRow(row.external_system_id), sourceOfTruthRuleId: textRow(row.source_of_truth_rule_id), platformEntityType: textRow(row.platform_entity_type) as MappingProfile['platformEntityType'], direction: textRow(row.direction) as MappingProfile['direction'], status: textRow(row.status) as MappingProfile['status'], createdByPersonId: nullableTextRow(row.created_by_person_id), publishedByPersonId: nullableTextRow(row.published_by_person_id), retiredByPersonId: nullableTextRow(row.retired_by_person_id), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), publishedAt: nullableInstant(row.published_at), retiredAt: nullableInstant(row.retired_at) }; }
function mapSyncRun(value: unknown): SyncRun { const row = object(value); return { id: textRow(row.id), mappingProfileId: textRow(row.mapping_profile_id), requestKey: textRow(row.request_key), status: textRow(row.status) as SyncRun['status'], version: numberRow(row.version), requestedCount: numberRow(row.requested_count), processedCount: numberRow(row.processed_count), createdCount: numberRow(row.created_count), updatedCount: numberRow(row.updated_count), succeededCount: numberRow(row.succeeded_count), unchangedCount: numberRow(row.unchanged_count), skippedCount: numberRow(row.skipped_count), conflictCount: numberRow(row.conflict_count), failedCount: numberRow(row.failed_count), failureCode: nullableTextRow(row.failure_code), summary: nullableTextRow(row.summary), actorType: textRow(row.actor_type) as SyncRun['actorType'], actorPersonId: nullableTextRow(row.actor_person_id), serviceIdentityId: nullableTextRow(row.service_identity_id), executionType: textRow(row.execution_type) as SyncRun['executionType'], sourceAppId: nullableTextRow(row.source_app_id), requestId: textRow(row.request_id), traceId: textRow(row.trace_id), queuedAt: instant(row.queued_at), startedAt: nullableInstant(row.started_at), completedAt: nullableInstant(row.completed_at), updatedAt: instant(row.updated_at) }; }
function mapSyncRecordResult(value: unknown): SyncRecordResult { const row = object(value); return { id: textRow(row.id), syncRunId: textRow(row.sync_run_id), sourceRecordKey: textRow(row.source_record_key), externalEntityId: nullableTextRow(row.external_entity_id), platformEntityType: nullableTextRow(row.platform_entity_type) as SyncRecordResult['platformEntityType'], platformEntityId: nullableTextRow(row.platform_entity_id), sourceAttachmentId: nullableTextRow(row.source_attachment_id), sourceRow: nullableNumberRow(row.source_row), sourceSha256: nullableTextRow(row.source_sha256), targetSha256: nullableTextRow(row.target_sha256), outcome: textRow(row.outcome) as SyncRecordResult['outcome'], errorCode: nullableTextRow(row.error_code), errorSummary: nullableTextRow(row.error_summary), conflictState: nullableTextRow(row.conflict_state) as SyncRecordResult['conflictState'], conflictResolution: nullableTextRow(row.conflict_resolution) as SyncRecordResult['conflictResolution'], resolutionNote: nullableTextRow(row.resolution_note), resolvedByPersonId: nullableTextRow(row.resolved_by_person_id), resolvedByServiceIdentityId: nullableTextRow(row.resolved_by_service_identity_id), resolvedAt: nullableInstant(row.resolved_at), version: numberRow(row.version), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) }; }
function mapSyncCheckpoint(value: unknown): SyncCheckpoint { const row = object(value); return { id: textRow(row.id), mappingProfileId: textRow(row.mapping_profile_id), partitionKey: textRow(row.partition_key), cursor: textRow(row.cursor), sourceWatermarkAt: nullableInstant(row.source_watermark_at), lastSuccessfulRunId: textRow(row.last_successful_run_id), version: numberRow(row.version), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) }; }
function mapHistory(value: unknown): DataAlignmentOperationHistory { const row = object(value); return { id: textRow(row.id), operation: textRow(row.operation) as DataAlignmentOperationHistory['operation'], entityType: textRow(row.entity_type) as DataAlignmentOperationHistory['entityType'], entityId: textRow(row.entity_id), actorType: textRow(row.actor_type) as DataAlignmentOperationHistory['actorType'], actorPersonId: nullableTextRow(row.actor_person_id), serviceIdentityId: nullableTextRow(row.service_identity_id), executionType: textRow(row.execution_type) as DataAlignmentOperationHistory['executionType'], sourceAppId: nullableTextRow(row.source_app_id), requestId: textRow(row.request_id), traceId: textRow(row.trace_id), note: nullableTextRow(row.note), before: nullableObject(row.before_summary), after: nullableObject(row.after_summary), occurredAt: instant(row.occurred_at) }; }

function assertRunCounters(run: SyncRun, results: SyncRecordResult[]) {
  const expected = resultCounters(results);
  for (const [key, value] of Object.entries(expected)) if (run[key as keyof typeof expected] !== value) fail('SYNC_RUN_COUNTER_MISMATCH', '同步运行计数与记录结果不一致');
  if (results.length > run.requestedCount) fail('SYNC_RESULT_COUNT_EXCEEDS_REQUESTED', '逐条结果数超过请求数');
}
function resultCounters(results: SyncRecordResult[]): Omit<SyncRunCounters, 'requestedCount'> { const count = (outcome: SyncRecordResult['outcome']) => results.filter((item) => item.outcome === outcome).length; const createdCount = count('created'); const updatedCount = count('updated'); return { processedCount: results.length, createdCount, updatedCount, succeededCount: createdCount + updatedCount, unchangedCount: count('unchanged'), skippedCount: count('skipped'), conflictCount: count('conflict'), failedCount: count('failed') }; }
function assertRuleUnique(records: Iterable<SourceOfTruthRule>, record: SourceOfTruthRule, ignoredId?: string) { if (record.status === 'active' && [...records].some((item) => item.id !== ignoredId && item.status === 'active' && item.externalSystemId === record.externalSystemId && item.platformEntityType === record.platformEntityType && item.authorityScopeKey === record.authorityScopeKey && rangesOverlap(item.effectiveFrom, item.effectiveTo, record.effectiveFrom, record.effectiveTo))) fail('SOURCE_OF_TRUTH_RULE_OVERLAP', '同一权威范围的生效时间重叠'); }
function assertProfileReferences(record: MappingProfile, systems: Map<string, ExternalSystem>, rules: Map<string, SourceOfTruthRule>, at: string | null = null) { const system = required(systems, record.externalSystemId, 'EXTERNAL_SYSTEM_NOT_FOUND'); const rule = required(rules, record.sourceOfTruthRuleId, 'SOURCE_OF_TRUTH_RULE_NOT_FOUND'); if (system.status !== 'active') fail('ACTIVE_EXTERNAL_SYSTEM_REQUIRED', '外部系统未启用'); if (rule.status !== 'active' || rule.externalSystemId !== system.id || rule.platformEntityType !== record.platformEntityType || (at !== null && (rule.effectiveFrom > at || (rule.effectiveTo !== null && rule.effectiveTo < at)))) fail('MAPPING_PROFILE_RULE_MISMATCH', '映射配置与当前生效的数据权威规则不一致'); }
function assertProfileIdentity(current: MappingProfile, next: MappingProfile) { for (const key of ['profileKey','version','ownerType','ownerAppId','externalSystemId','sourceOfTruthRuleId','platformEntityType','direction'] as const) if (current[key] !== next[key]) fail('MAPPING_PROFILE_IDENTITY_IMMUTABLE', '映射配置标识不可修改'); }
function assertRunIdentity(current: SyncRun, next: SyncRun) { for (const key of ['mappingProfileId','requestKey','requestedCount','actorType','actorPersonId','serviceIdentityId','executionType','sourceAppId','requestId','traceId','queuedAt'] as const) if (current[key] !== next[key]) fail('SYNC_RUN_IDENTITY_IMMUTABLE', '同步运行来源标识不可修改'); }
function assertRunOwner(profile: MappingProfile, run: SyncRun) { if ((profile.ownerType === 'platform' && (run.executionType !== 'platform' || run.sourceAppId !== null)) || (profile.ownerType === 'application' && run.sourceAppId !== profile.ownerAppId)) fail('MAPPING_PROFILE_OWNER_MISMATCH', '同步运行与映射档案所有者不一致'); }
function assertResultIdentity(current: SyncRecordResult, next: SyncRecordResult) { for (const key of ['syncRunId','sourceRecordKey','externalEntityId','platformEntityType','platformEntityId','sourceAttachmentId','sourceRow','sourceSha256','targetSha256','outcome','errorCode','errorSummary','createdAt'] as const) if (current[key] !== next[key]) fail('SYNC_RESULT_IMMUTABLE', '已记录的同步结果不可修改'); }
function sameSyncResult(current: SyncRecordResult, next: SyncRecordResult) { return (['syncRunId','sourceRecordKey','externalEntityId','platformEntityType','platformEntityId','sourceAttachmentId','sourceRow','sourceSha256','targetSha256','outcome','errorCode','errorSummary'] as const).every((key) => current[key] === next[key]); }
function assertDefinitionTransition(current: DictionaryVersion['status'] | MappingProfile['status'], next: DictionaryVersion['status'] | MappingProfile['status']) { if (!((current === 'draft' && next === 'published') || (current === 'published' && next === 'retired'))) fail('INVALID_DEFINITION_TRANSITION', '定义生命周期转移无效'); }
function assertSyncRunTransition(current: SyncRunStatus, next: SyncRunStatus) { if (!((current === 'queued' && ['running','cancelled'].includes(next)) || (current === 'running' && ['succeeded','partial','failed','cancelled'].includes(next)))) fail('INVALID_SYNC_RUN_TRANSITION', '同步运行状态转移无效'); }
function assertConflictResolution(record: SyncRecordResult) { if (record.outcome !== 'conflict' || record.conflictState !== 'resolved' || record.conflictResolution === null || record.resolvedAt === null || ((record.resolvedByPersonId === null) === (record.resolvedByServiceIdentityId === null))) fail('INVALID_SYNC_CONFLICT_TRANSITION', '同步冲突只能从开放状态转为已解决'); }

function compareVersion<T extends { version: number }>(a: T, b: T) { const ak = 'dictionaryKey' in a ? String(a.dictionaryKey) : 'profileKey' in a ? String(a.profileKey) : ''; const bk = 'dictionaryKey' in b ? String(b.dictionaryKey) : 'profileKey' in b ? String(b.profileKey) : ''; return ak.localeCompare(bk) || b.version - a.version; }
function compareItems(a: DictionaryItem, b: DictionaryItem) { return a.sortOrder - b.sortOrder || a.code.localeCompare(b.code) || a.id.localeCompare(b.id); }
function compareHistory(a: DataAlignmentOperationHistory, b: DataAlignmentOperationHistory) { return a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id); }
function rangesOverlap(aStart: string, aEnd: string | null, bStart: string, bEnd: string | null) { return aStart <= (bEnd ?? '9999-12-31T23:59:59.999Z') && bStart <= (aEnd ?? '9999-12-31T23:59:59.999Z'); }
function limited<T>(values: T[], input?: DataAlignmentListInput) { return values.slice(0, limitOf(input)); }
function limitOf(input?: DataAlignmentListInput) { const value = input?.limit ?? 100; if (!Number.isSafeInteger(value) || value < 1 || value > 500) fail('INVALID_LIST_LIMIT', '列表数量必须介于 1 与 500'); return value; }
function toMap<T extends { id: string }>(records: readonly T[] | undefined) { return new Map((records ?? []).map((record) => [record.id, clone(record)])); }
function uniqueId<T>(records: Map<string, T>, id: string, code: string) { if (records.has(id)) fail(code, '记录 ID 已存在'); }
function required<T>(records: Map<string, T>, id: string, code: string) { const value = records.get(id); if (!value) fail(code, '记录不存在'); return value; }
function clone<T>(value: T): T { return structuredClone(value); }
function cloneOrNull<T>(value: T | undefined): T | null { return value === undefined ? null : clone(value); }
function fail(code: string, message: string): never { throw new DataAlignmentError(code, message); }
function rows(result: unknown): unknown[] { const value = object(result); return Array.isArray(value.rows) ? value.rows : []; }
function one(result: unknown, code: string) { const value = rows(result)[0]; if (!value) fail(code, '数据库写入未返回记录'); return value; }
function optional<T>(result: unknown, mapper: (value: unknown) => T): T | null { const value = rows(result)[0]; return value === undefined ? null : mapper(value); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_DATABASE_ROW', '数据库返回行无效'); return value as Record<string, unknown>; }
function textRow(value: unknown) { if (typeof value !== 'string') fail('INVALID_DATABASE_ROW', '数据库文本字段无效'); return value; }
function nullableTextRow(value: unknown) { return value === null || value === undefined ? null : textRow(value); }
function numberRow(value: unknown) { const normalized = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN; if (!Number.isSafeInteger(normalized)) fail('INVALID_DATABASE_ROW', '数据库数字字段无效'); return normalized; }
function nullableNumberRow(value: unknown) { return value === null || value === undefined ? null : numberRow(value); }
function booleanRow(value: unknown) { if (typeof value !== 'boolean') fail('INVALID_DATABASE_ROW', '数据库布尔字段无效'); return value; }
function instant(value: unknown) { if (value instanceof Date) return value.toISOString(); if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString(); fail('INVALID_DATABASE_ROW', '数据库时间字段无效'); }
function nullableInstant(value: unknown) { return value === null || value === undefined ? null : instant(value); }
function nullableObject(value: unknown) { return value === null || value === undefined ? null : clone(object(value)); }
function json(value: Record<string, unknown> | null) { return value === null ? null : JSON.stringify(value); }
