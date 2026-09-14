import { randomUUID } from 'node:crypto';
import { SystemClock, type PlatformClock } from '../../core/time/index.js';
import type { AuthorizationResource } from '../authorization/index.js';
import type { PlatformActorContext } from '../context/index.js';
import {
  DATA_ALIGNMENT_PERMISSION_CODES,
  DataAlignmentError,
  type AdvanceSyncCheckpointInput,
  type CloseSourceOfTruthRuleInput,
  type CompleteSyncRunInput,
  type CreateDictionaryVersionInput,
  type CreateExternalSystemInput,
  type CreateMappingProfileInput,
  type CreateSourceOfTruthRuleInput,
  type CreateSyncRunInput,
  type DataAlignmentListInput,
  type DataAlignmentOperation,
  type DataAlignmentOperationHistory,
  type DictionaryItem,
  type DictionaryVersion,
  type DirectoryEntityType,
  type DirectoryReferenceAdapter,
  type ExternalSystem,
  type LegacyDataAlignmentReconciliation,
  type LegacyDataAlignmentSnapshot,
  type MappingProfile,
  type RecordSyncResultInput,
  type ResolveSyncConflictInput,
  type SetDictionaryItemInput,
  type SourceOfTruthRule,
  type SyncCheckpoint,
  type SyncConflict,
  type SyncRecordResult,
  type SyncRun,
  type UpdateExternalSystemInput
} from './model.js';
import type { DataAlignmentRepository } from './repository.js';

export * from './adapters.js';
export * from './migration.js';
export * from './model.js';
export * from './repository.js';

export interface DataAlignmentServiceOptions {
  clock?: PlatformClock;
  createId?: () => string;
  directoryReferences: DirectoryReferenceAdapter;
  findAttachment?(id: string): Promise<{ lifecycle: string } | null>;
}

export class DataAlignmentService {
  private readonly clock: PlatformClock;
  private readonly createId: () => string;

  constructor(private readonly repository: DataAlignmentRepository, private readonly options: DataAlignmentServiceOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.createId = options.createId ?? randomUUID;
  }

  async createDictionaryVersion(context: PlatformActorContext, input: CreateDictionaryVersionInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.dictionaryManage);
    const now = this.now();
    const record: DictionaryVersion = {
      id: uuid(input.id ?? this.createId(), 'dictionary version id'),
      dictionaryKey: code(input.dictionaryKey, 100, 'dictionary key'),
      version: positiveInteger(input.version, 'dictionary version'),
      name: text(input.name, 200, 'dictionary name'),
      description: safeOptionalText(input.description, 1_000),
      status: 'draft',
      createdByPersonId: personId(context), publishedByPersonId: null, retiredByPersonId: null,
      createdAt: now, updatedAt: now, publishedAt: null, retiredAt: null
    };
    return this.repository.createDictionaryVersion(record, this.history(context, 'dictionary_version_created', 'dictionary_version', record.id, null, record, input.note));
  }

  async setDictionaryItem(context: PlatformActorContext, input: SetDictionaryItemInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.dictionaryManage);
    const versionId = uuid(input.dictionaryVersionId, 'dictionary version id');
    const version = await this.requireDictionaryVersion(versionId);
    if (version.status !== 'draft') fail('DRAFT_DICTIONARY_REQUIRED', '只能修改草稿字典');
    const itemCode = code(input.code, 100, 'dictionary item code');
    const existing = await this.repository.findDictionaryItem(versionId, itemCode);
    const now = this.now();
    const record: DictionaryItem = {
      id: existing?.id ?? uuid(input.id ?? this.createId(), 'dictionary item id'),
      dictionaryVersionId: versionId,
      code: itemCode,
      label: text(input.label, 200, 'dictionary item label'),
      description: safeOptionalText(input.description, 1_000),
      sortOrder: integer(input.sortOrder ?? 0, -1_000_000, 1_000_000, 'sort order'),
      active: bool(input.active ?? true, 'active'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    return this.repository.setDictionaryItem(record, this.history(context, 'dictionary_item_set', 'dictionary_item', record.id, existing, record, input.note));
  }

  async publishDictionaryVersion(context: PlatformActorContext, value: string, note?: string | null) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.dictionaryManage);
    const current = await this.requireDictionaryVersion(value);
    if (current.status !== 'draft') fail('DRAFT_DICTIONARY_REQUIRED', '只能发布草稿字典');
    if ((await this.repository.listDictionaryItems(current.id, { limit: 500 })).length === 0) fail('DICTIONARY_ITEMS_REQUIRED', '空字典不能发布');
    const now = this.now();
    const next = { ...current, status: 'published' as const, publishedByPersonId: personId(context), updatedAt: now, publishedAt: now };
    return this.repository.updateDictionaryVersion(next, 'draft', this.history(context, 'dictionary_published', 'dictionary_version', current.id, current, next, note));
  }

  async retireDictionaryVersion(context: PlatformActorContext, value: string, note?: string | null) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.dictionaryManage);
    const current = await this.requireDictionaryVersion(value);
    if (current.status !== 'published') fail('PUBLISHED_DICTIONARY_REQUIRED', '只能退役已发布字典');
    const now = this.now();
    const next = { ...current, status: 'retired' as const, retiredByPersonId: personId(context), updatedAt: now, retiredAt: now };
    return this.repository.updateDictionaryVersion(next, 'published', this.history(context, 'dictionary_retired', 'dictionary_version', current.id, current, next, note));
  }

  async listDictionaryVersions(context: PlatformActorContext, dictionaryKey?: string, input?: DataAlignmentListInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    return this.repository.listDictionaryVersions(dictionaryKey ? code(dictionaryKey, 100, 'dictionary key') : undefined, listInput(input));
  }

  async listDictionaryItems(context: PlatformActorContext, dictionaryVersionId: string, input?: DataAlignmentListInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    return this.repository.listDictionaryItems(uuid(dictionaryVersionId, 'dictionary version id'), listInput(input));
  }

  async createExternalSystem(context: PlatformActorContext, input: CreateExternalSystemInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.externalSystemManage);
    const systemCode = code(input.code, 100, 'external system code');
    if (await this.repository.findExternalSystemByCode(systemCode)) fail('EXTERNAL_SYSTEM_CODE_CONFLICT', '外部系统编码已存在');
    const now = this.now();
    const record: ExternalSystem = {
      id: uuid(input.id ?? this.createId(), 'external system id'), code: systemCode,
      name: text(input.name, 200, 'external system name'), description: safeOptionalText(input.description, 1_000),
      status: recordStatus(input.status ?? 'active'), createdAt: now, updatedAt: now
    };
    return this.repository.createExternalSystem(record, this.history(context, 'external_system_created', 'external_system', record.id, null, record, input.note));
  }

  async updateExternalSystem(context: PlatformActorContext, input: UpdateExternalSystemInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.externalSystemManage);
    const current = await this.requireExternalSystem(input.id);
    const next: ExternalSystem = {
      ...current,
      name: input.name === undefined ? current.name : text(input.name, 200, 'external system name'),
      description: input.description === undefined ? current.description : safeOptionalText(input.description, 1_000),
      status: input.status === undefined ? current.status : recordStatus(input.status),
      updatedAt: this.now()
    };
    return this.repository.updateExternalSystem(next, instant(input.expectedUpdatedAt, 'expected updated at'), this.history(context, 'external_system_updated', 'external_system', current.id, current, next, input.note));
  }

  async listExternalSystems(context: PlatformActorContext, input?: DataAlignmentListInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    return this.repository.listExternalSystems(listInput(input));
  }

  async createSourceOfTruthRule(context: PlatformActorContext, input: CreateSourceOfTruthRuleInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.mappingProfileManage);
    const externalSystemId = uuid(input.externalSystemId, 'external system id');
    const system = await this.requireExternalSystem(externalSystemId);
    if (system.status !== 'active') fail('ACTIVE_EXTERNAL_SYSTEM_REQUIRED', '外部系统未启用');
    const effectiveFrom = instant(input.effectiveFrom, 'effective from');
    const effectiveTo = optionalInstant(input.effectiveTo, 'effective to');
    if (effectiveTo && effectiveTo < effectiveFrom) fail('INVALID_EFFECTIVE_PERIOD', '权威规则失效时间不能早于生效时间');
    const now = this.now();
    const overlaps = await this.repository.listSourceOfTruthRules(externalSystemId, { limit: 500 });
    if ((input.status ?? 'active') === 'active' && overlaps.some((item) => item.status === 'active' && item.platformEntityType === code(input.platformEntityType, 100, 'platform entity type') && item.authorityScopeKey === code(input.authorityScopeKey, 100, 'authority scope key') && rangesOverlap(item.effectiveFrom, item.effectiveTo, effectiveFrom, effectiveTo))) fail('SOURCE_OF_TRUTH_RULE_OVERLAP', '同一权威范围的生效时间重叠');
    const record: SourceOfTruthRule = {
      id: uuid(input.id ?? this.createId(), 'source of truth rule id'), externalSystemId,
      platformEntityType: code(input.platformEntityType, 100, 'platform entity type'),
      authorityScopeKey: code(input.authorityScopeKey, 100, 'authority scope key'),
      authority: authority(input.authority), status: recordStatus(input.status ?? 'active'),
      effectiveFrom, effectiveTo, createdAt: now, updatedAt: now
    };
    return this.repository.createSourceOfTruthRule(record, this.history(context, 'source_of_truth_rule_created', 'source_of_truth_rule', record.id, null, record, input.note));
  }

  async closeSourceOfTruthRule(context: PlatformActorContext, input: CloseSourceOfTruthRuleInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.mappingProfileManage);
    const current = await this.requireSourceOfTruthRule(input.id);
    if (current.status !== 'active' || current.effectiveTo !== null) fail('SOURCE_OF_TRUTH_RULE_CLOSE_REQUIRED', '只能关闭当前启用的权威规则');
    const effectiveTo = instant(input.effectiveTo, 'effective to');
    if (effectiveTo < current.effectiveFrom) fail('INVALID_EFFECTIVE_PERIOD', '权威规则失效时间不能早于生效时间');
    const next = { ...current, status: 'inactive' as const, effectiveTo, updatedAt: this.now() };
    return this.repository.updateSourceOfTruthRule(next, instant(input.expectedUpdatedAt, 'expected updated at'), this.history(context, 'source_of_truth_rule_closed', 'source_of_truth_rule', current.id, current, next, input.note));
  }

  async listSourceOfTruthRules(context: PlatformActorContext, externalSystemId?: string, input?: DataAlignmentListInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    return this.repository.listSourceOfTruthRules(externalSystemId ? uuid(externalSystemId, 'external system id') : undefined, listInput(input));
  }

  async createMappingProfile(context: PlatformActorContext, input: CreateMappingProfileInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.mappingProfileManage);
    const ownerAppId = input.ownerType === 'application' ? appId(input.ownerAppId) : null;
    if (input.ownerType === 'platform' && input.ownerAppId) fail('MAPPING_PROFILE_OWNER_CONFLICT', '平台映射档案不能指定应用所有者');
    if (context.execution.type !== 'platform' && ownerAppId !== context.execution.appId) fail('MAPPING_PROFILE_OWNER_MISMATCH', '应用只能创建自己的映射档案');
    const externalSystemId = uuid(input.externalSystemId, 'external system id');
    const rule = await this.requireSourceOfTruthRule(input.sourceOfTruthRuleId);
    const entityType = code(input.platformEntityType, 100, 'platform entity type');
    const system = await this.requireExternalSystem(externalSystemId);
    if (system.status !== 'active') fail('ACTIVE_EXTERNAL_SYSTEM_REQUIRED', '外部系统未启用');
    if (rule.status !== 'active' || rule.externalSystemId !== externalSystemId || rule.platformEntityType !== entityType) fail('MAPPING_PROFILE_RULE_MISMATCH', '映射档案与数据权威规则不一致');
    const now = this.now();
    const record: MappingProfile = {
      id: uuid(input.id ?? this.createId(), 'mapping profile id'), profileKey: code(input.profileKey, 100, 'mapping profile key'),
      version: positiveInteger(input.version, 'mapping profile version'), name: text(input.name, 200, 'mapping profile name'),
      description: safeOptionalText(input.description, 1_000), ownerType: profileOwnerType(input.ownerType), ownerAppId,
      externalSystemId, sourceOfTruthRuleId: rule.id, platformEntityType: entityType,
      direction: mappingDirection(input.direction), status: 'draft',
      createdByPersonId: personId(context), publishedByPersonId: null, retiredByPersonId: null,
      createdAt: now, updatedAt: now, publishedAt: null, retiredAt: null
    };
    return this.repository.createMappingProfile(record, this.history(context, 'mapping_profile_created', 'mapping_profile', record.id, null, record, input.note));
  }

  async publishMappingProfile(context: PlatformActorContext, value: string, note?: string | null) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.mappingProfileManage);
    const current = await this.requireMappingProfile(value);
    this.assertOwner(context, current);
    if (current.status !== 'draft') fail('DRAFT_MAPPING_PROFILE_REQUIRED', '只能发布草稿映射档案');
    const now = this.now();
    const [system, rule] = await Promise.all([this.requireExternalSystem(current.externalSystemId), this.requireSourceOfTruthRule(current.sourceOfTruthRuleId)]);
    if (system.status !== 'active' || rule.status !== 'active' || rule.externalSystemId !== system.id || rule.platformEntityType !== current.platformEntityType || rule.effectiveFrom > now || (rule.effectiveTo !== null && rule.effectiveTo < now)) fail('MAPPING_PROFILE_RULE_MISMATCH', '映射档案的外部系统或数据权威规则当前未生效');
    const next = { ...current, status: 'published' as const, publishedByPersonId: personId(context), updatedAt: now, publishedAt: now };
    return this.repository.updateMappingProfile(next, 'draft', this.history(context, 'mapping_profile_published', 'mapping_profile', current.id, current, next, note));
  }

  async retireMappingProfile(context: PlatformActorContext, value: string, note?: string | null) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.mappingProfileManage);
    const current = await this.requireMappingProfile(value);
    this.assertOwner(context, current);
    if (current.status !== 'published') fail('PUBLISHED_MAPPING_PROFILE_REQUIRED', '只能退役已发布映射档案');
    const now = this.now();
    const next = { ...current, status: 'retired' as const, retiredByPersonId: personId(context), updatedAt: now, retiredAt: now };
    return this.repository.updateMappingProfile(next, 'published', this.history(context, 'mapping_profile_retired', 'mapping_profile', current.id, current, next, note));
  }

  async listMappingProfiles(context: PlatformActorContext, profileKey?: string, input?: DataAlignmentListInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    const requested = listInput(input);
    const records = await this.repository.listMappingProfiles(profileKey ? code(profileKey, 100, 'mapping profile key') : undefined, { limit: 500 });
    return records.filter((item) => context.execution.type === 'platform' || (item.ownerType === 'application' && item.ownerAppId === context.execution.appId)).slice(0, requested.limit);
  }

  async createSyncRun(context: PlatformActorContext, input: CreateSyncRunInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.syncRecord);
    const mappingProfileId = uuid(input.mappingProfileId, 'mapping profile id');
    const requestKey = text(input.requestKey, 200, 'sync request key');
    const requestedCount = integer(input.requestedCount, 0, 1_000_000, 'requested count');
    const profile = await this.requireMappingProfile(mappingProfileId);
    this.assertOwner(context, profile);
    const existing = await this.repository.findSyncRunByRequest(profile.id, requestKey);
    if (existing) {
      const retry = { ...existing, requestedCount, actorType: context.actorType, actorPersonId: personId(context), serviceIdentityId: serviceIdentityId(context), executionType: context.execution.type, sourceAppId: executionAppId(context) };
      if (!sameSyncRequest(existing, retry)) fail('SYNC_REQUEST_IDEMPOTENCY_CONFLICT', '相同请求键的同步参数不一致');
      return existing;
    }
    if (profile.status !== 'published') fail('PUBLISHED_MAPPING_PROFILE_REQUIRED', '同步运行必须使用已发布映射档案');
    const system = await this.requireExternalSystem(profile.externalSystemId);
    const rule = await this.requireSourceOfTruthRule(profile.sourceOfTruthRuleId);
    const now = this.now();
    if (system.status !== 'active' || rule.status !== 'active' || rule.effectiveFrom > now || (rule.effectiveTo !== null && rule.effectiveTo < now)) fail('ACTIVE_ALIGNMENT_DEFINITION_REQUIRED', '外部系统或数据权威规则未生效');
    const record: SyncRun = {
      id: uuid(input.id ?? this.createId(), 'sync run id'), mappingProfileId: profile.id,
      requestKey, status: 'queued', version: 1,
      requestedCount,
      processedCount: 0, createdCount: 0, updatedCount: 0, succeededCount: 0, unchangedCount: 0,
      skippedCount: 0, conflictCount: 0, failedCount: 0, failureCode: null, summary: null,
      actorType: context.actorType, actorPersonId: personId(context), serviceIdentityId: serviceIdentityId(context),
      executionType: context.execution.type, sourceAppId: executionAppId(context),
      requestId: text(context.request.requestId, 120, 'request id'), traceId: text(context.request.traceId, 120, 'trace id'),
      queuedAt: now, startedAt: null, completedAt: null, updatedAt: now
    };
    const result = await this.repository.createSyncRun(record, this.history(context, 'sync_run_created', 'sync_run', record.id, null, record, input.note));
    if (!result.created && !sameSyncRequest(result.record, record)) fail('SYNC_REQUEST_IDEMPOTENCY_CONFLICT', '相同请求键的同步参数不一致');
    return result.record;
  }

  async startSyncRun(context: PlatformActorContext, syncRunId: string, expectedVersion: number, note?: string | null) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.syncRecord);
    const current = await this.requireSyncRun(syncRunId);
    await this.assertRunOwner(context, current);
    if (current.status !== 'queued') fail('QUEUED_SYNC_RUN_REQUIRED', '只能启动排队中的同步运行');
    const now = this.now();
    const next = { ...current, status: 'running' as const, version: expectedVersion + 1, startedAt: now, updatedAt: now };
    return this.repository.updateSyncRun(next, 'queued', positiveInteger(expectedVersion, 'expected version'), this.history(context, 'sync_run_started', 'sync_run', current.id, current, next, note));
  }

  async recordSyncResult(context: PlatformActorContext, input: RecordSyncResultInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.syncRecord);
    const run = await this.requireSyncRun(input.syncRunId);
    await this.assertRunOwner(context, run);
    const platformEntityType = input.platformEntityType == null ? null : code(input.platformEntityType, 100, 'platform entity type');
    const platformEntityId = input.platformEntityId == null ? null : uuid(input.platformEntityId, 'platform entity id');
    if ((platformEntityType === null) !== (platformEntityId === null)) fail('PLATFORM_ENTITY_REFERENCE_INCOMPLETE', '平台实体类型和 ID 必须同时提供');
    const profile = await this.requireMappingProfile(run.mappingProfileId);
    if (platformEntityType && platformEntityType !== profile.platformEntityType) fail('SYNC_RESULT_ENTITY_TYPE_MISMATCH', '同步结果实体类型与映射档案不一致');
    const sourceAttachmentId = input.sourceAttachmentId == null ? null : uuid(input.sourceAttachmentId, 'source attachment id');
    if (sourceAttachmentId) {
      if (!this.options.findAttachment) fail('ATTACHMENT_RESOLVER_REQUIRED', '校验来源附件需要 Attachment 查询器');
      const attachment = await this.options.findAttachment(sourceAttachmentId);
      if (!attachment || attachment.lifecycle !== 'active') fail('ACTIVE_SOURCE_ATTACHMENT_REQUIRED', '来源附件不存在或已移除');
    }
    const outcome = syncOutcome(input.outcome);
    const sourceSha256 = optionalHash(input.sourceSha256);
    const targetSha256 = optionalHash(input.targetSha256);
    if (outcome === 'conflict' && (!sourceSha256 || !targetSha256)) fail('CONFLICT_HASHES_REQUIRED', '冲突结果必须包含双方哈希');
    const errorCode = optionalCode(input.errorCode, 100, 'error code');
    const errorSummary = safeOptionalText(input.errorSummary, 2_000);
    if (outcome === 'failed' && (!errorCode || !errorSummary)) fail('FAILED_RESULT_ERROR_REQUIRED', '失败结果必须包含错误编码和摘要');
    if (outcome !== 'failed' && (errorCode || errorSummary)) fail('UNEXPECTED_RESULT_ERROR', '非失败结果不能包含错误信息');
    const now = this.now();
    const record: SyncRecordResult = {
      id: uuid(input.id ?? this.createId(), 'sync result id'), syncRunId: run.id,
      sourceRecordKey: text(input.sourceRecordKey, 300, 'source record key'),
      externalEntityId: optionalText(input.externalEntityId, 300), platformEntityType, platformEntityId,
      sourceAttachmentId, sourceRow: input.sourceRow == null ? null : integer(input.sourceRow, 1, 1_000_000_000, 'source row'),
      sourceSha256, targetSha256, outcome, errorCode, errorSummary,
      conflictState: outcome === 'conflict' ? 'open' : null, conflictResolution: null, resolutionNote: null,
      resolvedByPersonId: null, resolvedByServiceIdentityId: null, resolvedAt: null,
      version: 1, createdAt: now, updatedAt: now
    };
    return this.repository.createSyncRecordResult(record, this.history(context, 'sync_result_recorded', 'sync_record_result', record.id, null, record, input.note));
  }

  async completeSyncRun(context: PlatformActorContext, input: CompleteSyncRunInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.syncRecord);
    const current = await this.requireSyncRun(input.syncRunId);
    await this.assertRunOwner(context, current);
    if (current.status !== 'running') fail('RUNNING_SYNC_RUN_REQUIRED', '只能完成运行中的同步');
    const summaryCounters = await this.repository.summarizeSyncRecordResults(current.id);
    if (summaryCounters.processedCount > current.requestedCount) fail('SYNC_RESULT_COUNT_EXCEEDS_REQUESTED', '逐条结果数超过请求数');
    const counters = summaryCounters;
    const status = completionStatus(input.status);
    if (status === 'succeeded' && (counters.processedCount !== current.requestedCount || counters.conflictCount > 0 || counters.failedCount > 0)) fail('SUCCESSFUL_RUN_INCOMPLETE', '成功运行必须覆盖全部请求且无冲突/失败');
    if (status === 'partial' && counters.processedCount === current.requestedCount && counters.conflictCount === 0 && counters.failedCount === 0) fail('PARTIAL_RUN_NOT_JUSTIFIED', '无缺口、冲突或失败时不能标记部分成功');
    const failureCode = optionalCode(input.failureCode, 100, 'failure code');
    if (status === 'failed' && !failureCode) fail('FAILED_RUN_CODE_REQUIRED', '失败运行必须包含错误编码');
    if (status !== 'failed' && failureCode) fail('UNEXPECTED_RUN_FAILURE_CODE', '非失败运行不能包含失败编码');
    const now = this.now();
    const next: SyncRun = { ...current, ...counters, status, version: input.expectedVersion + 1, failureCode, summary: safeOptionalText(input.summary, 2_000), completedAt: now, updatedAt: now };
    return this.repository.updateSyncRun(next, 'running', positiveInteger(input.expectedVersion, 'expected version'), this.history(context, 'sync_run_completed', 'sync_run', current.id, current, next, input.note));
  }

  async cancelSyncRun(context: PlatformActorContext, syncRunId: string, expectedVersion: number, note?: string | null) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.syncRecord);
    const current = await this.requireSyncRun(syncRunId);
    await this.assertRunOwner(context, current);
    if (!['queued', 'running'].includes(current.status)) fail('CANCELLABLE_SYNC_RUN_REQUIRED', '只能取消排队中或运行中的同步');
    const now = this.now();
    const next = { ...current, status: 'cancelled' as const, version: expectedVersion + 1, completedAt: now, updatedAt: now };
    return this.repository.updateSyncRun(next, current.status, positiveInteger(expectedVersion, 'expected version'), this.history(context, 'sync_run_cancelled', 'sync_run', current.id, current, next, note));
  }

  async resolveSyncConflict(context: PlatformActorContext, input: ResolveSyncConflictInput): Promise<SyncConflict> {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.conflictResolve);
    const current = await this.requireSyncResult(input.resultId);
    const run = await this.requireSyncRun(current.syncRunId);
    await this.assertRunOwner(context, run);
    if (current.outcome !== 'conflict' || current.conflictState !== 'open') fail('OPEN_SYNC_CONFLICT_REQUIRED', '只能解决开放中的同步冲突');
    const now = this.now();
    const next: SyncRecordResult = {
      ...current, conflictState: 'resolved', conflictResolution: conflictResolution(input.resolution),
      resolutionNote: safeOptionalText(input.note, 2_000), resolvedByPersonId: personId(context),
      resolvedByServiceIdentityId: serviceIdentityId(context), resolvedAt: now,
      version: input.expectedVersion + 1, updatedAt: now
    };
    const saved = await this.repository.updateSyncRecordResult(next, positiveInteger(input.expectedVersion, 'expected version'), this.history(context, 'sync_conflict_resolved', 'sync_record_result', current.id, current, next, input.note));
    return conflictFrom(saved);
  }

  async advanceSyncCheckpoint(context: PlatformActorContext, input: AdvanceSyncCheckpointInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.syncRecord);
    const profile = await this.requireMappingProfile(input.mappingProfileId);
    this.assertOwner(context, profile);
    const run = await this.requireSyncRun(input.successfulRunId);
    if (run.mappingProfileId !== profile.id || run.status !== 'succeeded') fail('SUCCESSFUL_MATCHING_RUN_REQUIRED', '检查点只能由同一映射档案的成功运行推进');
    const partitionKey = text(input.partitionKey, 200, 'partition key');
    const existing = await this.repository.findSyncCheckpoint(profile.id, partitionKey);
    const now = this.now();
    const record: SyncCheckpoint = {
      id: existing?.id ?? uuid(input.id ?? this.createId(), 'sync checkpoint id'), mappingProfileId: profile.id,
      partitionKey, cursor: text(input.cursor, 2_000, 'checkpoint cursor'),
      sourceWatermarkAt: optionalInstant(input.sourceWatermarkAt, 'source watermark'),
      lastSuccessfulRunId: run.id, version: input.expectedVersion + 1,
      createdAt: existing?.createdAt ?? now, updatedAt: now
    };
    return this.repository.advanceSyncCheckpoint(record, integer(input.expectedVersion, 0, 1_000_000_000, 'expected version'), this.history(context, 'sync_checkpoint_advanced', 'sync_checkpoint', record.id, existing, record, input.note));
  }

  async listSyncRuns(context: PlatformActorContext, mappingProfileId: string, input?: DataAlignmentListInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    const profile = await this.requireMappingProfile(mappingProfileId); this.assertOwner(context, profile);
    return this.repository.listSyncRuns(profile.id, listInput(input));
  }

  async listSyncRecordResults(context: PlatformActorContext, syncRunId: string, input?: DataAlignmentListInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    const run = await this.requireSyncRun(syncRunId); await this.assertRunOwner(context, run);
    return this.repository.listSyncRecordResults(run.id, listInput(input));
  }

  async listExternalReferences(context: PlatformActorContext, entityType?: DirectoryEntityType, input?: DataAlignmentListInput) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    const requested = listInput(input);
    const [references, systems] = await Promise.all([
      this.options.directoryReferences.list(entityType ? directoryEntityType(entityType) : undefined, { limit: 500 }),
      this.repository.listExternalSystems({ limit: 500 })
    ]);
    const activeCodes = new Set(systems.filter((item) => item.status === 'active').map((item) => item.code));
    return references.filter((item) => activeCodes.has(item.externalSystemCode)).slice(0, requested.limit);
  }

  async resolveExternalReference(context: PlatformActorContext, entityType: DirectoryEntityType, externalSystemCode: string, tenantKey: string, externalId: string) {
    await this.authorize(context, DATA_ALIGNMENT_PERMISSION_CODES.read);
    const systemCode = code(externalSystemCode, 100, 'external system code');
    const system = await this.repository.findExternalSystemByCode(systemCode);
    if (!system || system.status !== 'active') fail('ACTIVE_EXTERNAL_SYSTEM_REQUIRED', '外部系统未注册或未启用');
    return this.options.directoryReferences.resolve(directoryEntityType(entityType), systemCode, code(tenantKey, 100, 'tenant key'), text(externalId, 300, 'external id'));
  }

  private async requireDictionaryVersion(value: string) { const result = await this.repository.findDictionaryVersionById(uuid(value, 'dictionary version id')); if (!result) fail('DICTIONARY_VERSION_NOT_FOUND', '字典版本不存在'); return result; }
  private async requireExternalSystem(value: string) { const result = await this.repository.findExternalSystemById(uuid(value, 'external system id')); if (!result) fail('EXTERNAL_SYSTEM_NOT_FOUND', '外部系统不存在'); return result; }
  private async requireSourceOfTruthRule(value: string) { const result = await this.repository.findSourceOfTruthRuleById(uuid(value, 'source of truth rule id')); if (!result) fail('SOURCE_OF_TRUTH_RULE_NOT_FOUND', '数据权威规则不存在'); return result; }
  private async requireMappingProfile(value: string) { const result = await this.repository.findMappingProfileById(uuid(value, 'mapping profile id')); if (!result) fail('MAPPING_PROFILE_NOT_FOUND', '映射档案不存在'); return result; }
  private async requireSyncRun(value: string) { const result = await this.repository.findSyncRunById(uuid(value, 'sync run id')); if (!result) fail('SYNC_RUN_NOT_FOUND', '同步运行不存在'); return result; }
  private async requireSyncResult(value: string) { const result = await this.repository.findSyncRecordResultById(uuid(value, 'sync result id')); if (!result) fail('SYNC_RESULT_NOT_FOUND', '同步结果不存在'); return result; }
  private async assertRunOwner(context: PlatformActorContext, run: SyncRun) { const profile = await this.requireMappingProfile(run.mappingProfileId); this.assertOwner(context, profile); }
  private assertOwner(context: PlatformActorContext, profile: MappingProfile) { if (context.execution.type === 'platform') return; if (profile.ownerType !== 'application' || profile.ownerAppId !== context.execution.appId) fail('MAPPING_PROFILE_OWNER_MISMATCH', '应用不能操作其他所有者的映射档案'); }
  private async authorize(context: PlatformActorContext, permission: string, resource: AuthorizationResource = {}) { if (!(await context.authorize(permission, resource)).allowed) fail('DATA_ALIGNMENT_PERMISSION_DENIED', `缺少权限: ${permission}`); }
  private history(context: PlatformActorContext, operation: DataAlignmentOperation, entityType: DataAlignmentOperationHistory['entityType'], entityId: string, before: unknown, after: unknown, note?: string | null): DataAlignmentOperationHistory {
    return { id: uuid(this.createId(), 'operation history id'), operation, entityType, entityId, actorType: context.actorType, actorPersonId: personId(context), serviceIdentityId: serviceIdentityId(context), executionType: context.execution.type, sourceAppId: executionAppId(context), requestId: text(context.request.requestId, 120, 'request id'), traceId: text(context.request.traceId, 120, 'trace id'), note: safeOptionalText(note, 2_000), before: summary(before), after: summary(after), occurredAt: this.now() };
  }
  private now() { return this.clock.now().toISOString(); }
}

export function createDataAlignmentService(repository: DataAlignmentRepository, options: DataAlignmentServiceOptions) { return new DataAlignmentService(repository, options); }

export function reconcileLegacyDataAlignment(snapshot: LegacyDataAlignmentSnapshot): LegacyDataAlignmentReconciliation {
  const issues: LegacyDataAlignmentReconciliation['issues'] = [];
  const registered = new Set(snapshot.registeredExternalSystemCodes.map((item) => item.trim().toLowerCase()));
  const references = new Set<string>();
  for (const reference of snapshot.externalReferences) {
    if (!registered.has(reference.externalSystemCode.trim().toLowerCase())) issues.push({ code: 'UNREGISTERED_PROVIDER', sourceId: reference.entityId, value: reference.externalSystemCode });
    const key = `${reference.entityType}\0${reference.externalSystemCode}\0${reference.tenantKey}\0${reference.externalId}`;
    if (references.has(key)) issues.push({ code: 'DUPLICATE_EXTERNAL_REFERENCE', sourceId: reference.entityId, value: reference.externalId });
    references.add(key);
  }
  const sourceKeys = new Set<string>();
  for (const device of snapshot.devices) {
    const sourceKey = device.sourceKey?.trim() ?? '';
    if (sourceKey && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,299}$/.test(sourceKey)) issues.push({ code: 'UNSAFE_SOURCE_KEY', sourceId: device.id, value: sourceKey });
    if (sourceKey && sourceKeys.has(sourceKey)) issues.push({ code: 'DUPLICATE_SOURCE_KEY', sourceId: device.id, value: sourceKey });
    if (sourceKey) sourceKeys.add(sourceKey);
    if (!sourceKey || (!device.sourceFile && device.sourceRow == null)) issues.push({ code: 'MISSING_SOURCE_EVIDENCE', sourceId: device.id });
  }
  const validSyncStatuses = new Set(['pending', 'syncing', 'synced', 'failed', 'archived']);
  for (const sync of snapshot.cloudDocumentSyncs) {
    if (!validSyncStatuses.has(sync.status)) issues.push({ code: 'INVALID_SYNC_STATUS', sourceId: sync.id, value: sync.status });
    if (['synced', 'archived'].includes(sync.status) && !sync.remoteRecordId) issues.push({ code: 'MISSING_REMOTE_ID', sourceId: sync.id });
    if (sync.status === 'failed') issues.push({ code: 'FAILED_SYNC_ROW', sourceId: sync.id });
  }
  for (const fieldMap of snapshot.applicationFieldMaps ?? []) issues.push({ code: 'APP_OWNED_FIELD_MAP', sourceId: fieldMap.sourceId, value: `${fieldMap.ownerAppId}:${fieldMap.mappingKey}` });
  const checkpoints = new Set(snapshot.checkpointProfileKeys ?? []);
  if (snapshot.cloudDocumentSyncs.some((item) => item.status === 'synced') && checkpoints.size === 0) issues.push({ code: 'CHECKPOINT_GAP', sourceId: 'cloud_document_syncs' });
  return { externalReferenceCount: snapshot.externalReferences.length, deviceEvidenceCount: snapshot.devices.length, cloudSyncCount: snapshot.cloudDocumentSyncs.length, applicationFieldMapCount: snapshot.applicationFieldMaps?.length ?? 0, issues };
}

function conflictFrom(result: SyncRecordResult): SyncConflict { if (result.outcome !== 'conflict' || !result.sourceSha256 || !result.targetSha256 || !result.conflictState) fail('INVALID_SYNC_CONFLICT', '同步结果不是有效冲突'); return { resultId: result.id, syncRunId: result.syncRunId, sourceRecordKey: result.sourceRecordKey, externalEntityId: result.externalEntityId, platformEntityType: result.platformEntityType, platformEntityId: result.platformEntityId, sourceAttachmentId: result.sourceAttachmentId, sourceRow: result.sourceRow, sourceSha256: result.sourceSha256, targetSha256: result.targetSha256, state: result.conflictState, resolution: result.conflictResolution, resolutionNote: result.resolutionNote, resolvedByPersonId: result.resolvedByPersonId, resolvedByServiceIdentityId: result.resolvedByServiceIdentityId, resolvedAt: result.resolvedAt, version: result.version }; }
function sameSyncRequest(left: SyncRun, right: SyncRun) { return left.mappingProfileId === right.mappingProfileId && left.requestKey === right.requestKey && left.requestedCount === right.requestedCount && left.actorType === right.actorType && left.actorPersonId === right.actorPersonId && left.serviceIdentityId === right.serviceIdentityId && left.executionType === right.executionType && left.sourceAppId === right.sourceAppId; }
function personId(context: PlatformActorContext) { return context.actorType === 'person' ? context.person.id : null; }
function serviceIdentityId(context: PlatformActorContext) { return context.actorType === 'service' ? context.execution.serviceIdentityId : null; }
function executionAppId(context: PlatformActorContext) { return context.execution.type === 'platform' ? null : context.execution.appId; }
function listInput(input?: DataAlignmentListInput) { const limit = input?.limit ?? 100; integer(limit, 1, 500, 'list limit'); return { limit }; }
function summary(value: unknown): Record<string, unknown> | null { if (value == null) return null; if (typeof value !== 'object' || Array.isArray(value)) fail('INVALID_HISTORY_SUMMARY', '操作历史摘要无效'); return structuredClone(value) as Record<string, unknown>; }
function completionStatus(value: CompleteSyncRunInput['status']) { if (!['succeeded','partial','failed'].includes(value)) fail('INVALID_SYNC_COMPLETION_STATUS', '同步完成状态无效'); return value; }
function syncOutcome(value: SyncRecordResult['outcome']) { if (!['created','updated','unchanged','skipped','conflict','failed'].includes(value)) fail('INVALID_SYNC_RESULT_OUTCOME', '同步结果无效'); return value; }
function conflictResolution(value: ResolveSyncConflictInput['resolution']) { if (!['keep_platform','accept_external','custom'].includes(value)) fail('INVALID_CONFLICT_RESOLUTION', '冲突决策无效'); return value; }
function authority(value: SourceOfTruthRule['authority']) { if (!['platform','external','manual_resolution'].includes(value)) fail('INVALID_AUTHORITY', '数据权威无效'); return value; }
function mappingDirection(value: MappingProfile['direction']) { if (!['inbound','outbound','bidirectional'].includes(value)) fail('INVALID_MAPPING_DIRECTION', '映射方向无效'); return value; }
function profileOwnerType(value: MappingProfile['ownerType']) { if (!['platform','application'].includes(value)) fail('INVALID_PROFILE_OWNER_TYPE', '映射档案所有者类型无效'); return value; }
function recordStatus(value: ExternalSystem['status']) { if (!['active','inactive'].includes(value)) fail('INVALID_RECORD_STATUS', '记录状态无效'); return value; }
function directoryEntityType(value: DirectoryEntityType) { if (!['person','location','asset'].includes(value)) fail('INVALID_DIRECTORY_ENTITY_TYPE', '目录实体类型无效'); return value; }
function optionalHash(value: unknown) { if (value == null || value === '') return null; const normalized = text(value, 64, 'sha256').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(normalized)) fail('INVALID_SHA256', 'SHA-256 无效'); return normalized; }
function optionalCode(value: unknown, max: number, label: string) { if (value == null || value === '') return null; return code(value, max, label); }
function code(value: unknown, max: number, label: string) { const normalized = text(value, max, label).toLowerCase(); if (!/^[a-z0-9][a-z0-9_.:-]*$/.test(normalized)) fail('INVALID_STABLE_CODE', `${label} 必须是稳定 ASCII 编码`); return normalized; }
function appId(value: unknown) { const normalized = code(value, 100, 'app id'); if (normalized.length < 3) fail('INVALID_APP_ID', '应用 ID 过短'); return normalized; }
function uuid(value: unknown, label: string) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())) fail('INVALID_UUID', `${label} 无效`); return value.trim().toLowerCase(); }
function text(value: unknown, max: number, label: string) { if (typeof value !== 'string') fail('INVALID_TEXT', `${label} 必须是字符串`); const normalized = value.trim(); if (!normalized) fail('TEXT_REQUIRED', `${label} 不能为空`); if (normalized.length > max) fail('TEXT_TOO_LONG', `${label} 超过长度限制`); return normalized; }
function optionalText(value: unknown, max: number) { if (value == null) return null; if (typeof value !== 'string') fail('INVALID_TEXT', '可选文本必须是字符串'); const normalized = value.trim(); if (!normalized) return null; if (normalized.length > max) fail('TEXT_TOO_LONG', '可选文本超过长度限制'); return normalized; }
function safeOptionalText(value: unknown, max: number) { const normalized = optionalText(value, max); if (normalized && (/(?:bearer\s+\S+|(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|sig|signature)\s*[:=]\s*\S+)/i.test(normalized) || /(?:\/api\/files\/(?:public|preview)\/|[?&](?:sig|signature|token)=)/i.test(normalized))) fail('SENSITIVE_SYNC_EVIDENCE_DENIED', '同步证据不能包含凭证或签名链接'); return normalized; }
function bool(value: unknown, label: string) { if (typeof value !== 'boolean') fail('INVALID_BOOLEAN', `${label} 无效`); return value; }
function positiveInteger(value: unknown, label: string) { return integer(value, 1, 1_000_000_000, label); }
function integer(value: unknown, min: number, max: number, label: string) { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('INVALID_INTEGER', `${label} 无效`); return value as number; }
function instant(value: unknown, label: string) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_INSTANT', `${label} 无效`); return new Date(value).toISOString(); }
function optionalInstant(value: unknown, label: string) { return value == null || value === '' ? null : instant(value, label); }
function rangesOverlap(aStart: string, aEnd: string | null, bStart: string, bEnd: string | null) { return aStart <= (bEnd ?? '9999-12-31T23:59:59.999Z') && bStart <= (aEnd ?? '9999-12-31T23:59:59.999Z'); }
function fail(codeValue: string, message: string): never { throw new DataAlignmentError(codeValue, message); }
