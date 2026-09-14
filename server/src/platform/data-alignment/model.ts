export const DATA_ALIGNMENT_PERMISSION_SEEDS = [
  { id: '52000000-0000-4000-8000-000000000001', code: 'platform.reference_data.read', name: '查看公共字典与对齐证据' },
  { id: '52000000-0000-4000-8000-000000000002', code: 'platform.reference_data.dictionary.manage', name: '管理公共字典' },
  { id: '52000000-0000-4000-8000-000000000003', code: 'platform.reference_data.external_system.manage', name: '管理外部系统目录' },
  { id: '52000000-0000-4000-8000-000000000004', code: 'platform.reference_data.mapping_profile.manage', name: '管理数据权威与映射配置标识' },
  { id: '52000000-0000-4000-8000-000000000005', code: 'platform.reference_data.sync.record', name: '记录同步运行与检查点' },
  { id: '52000000-0000-4000-8000-000000000006', code: 'platform.reference_data.conflict.resolve', name: '解决数据对齐冲突' }
] as const;

export const DATA_ALIGNMENT_PERMISSION_CODES = {
  read: 'platform.reference_data.read',
  dictionaryManage: 'platform.reference_data.dictionary.manage',
  externalSystemManage: 'platform.reference_data.external_system.manage',
  mappingProfileManage: 'platform.reference_data.mapping_profile.manage',
  syncRecord: 'platform.reference_data.sync.record',
  conflictResolve: 'platform.reference_data.conflict.resolve'
} as const;

export type DefinitionLifecycle = 'draft' | 'published' | 'retired';
export type RecordStatus = 'active' | 'inactive';
export type PlatformEntityType = string;
export type DirectoryEntityType = 'person' | 'location' | 'asset';
export type Authority = 'platform' | 'external' | 'manual_resolution';
export type MappingDirection = 'inbound' | 'outbound' | 'bidirectional';
export type ProfileOwnerType = 'platform' | 'application';
export type SyncRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type SyncRecordOutcome = 'created' | 'updated' | 'unchanged' | 'skipped' | 'conflict' | 'failed';
export type ConflictState = 'open' | 'resolved';
export type ConflictResolution = 'keep_platform' | 'accept_external' | 'custom';

export interface DictionaryVersion {
  id: string;
  dictionaryKey: string;
  version: number;
  name: string;
  description: string | null;
  status: DefinitionLifecycle;
  createdByPersonId: string | null;
  publishedByPersonId: string | null;
  retiredByPersonId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
}

export interface DictionaryItem {
  id: string;
  dictionaryVersionId: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalSystem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: RecordStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SourceOfTruthRule {
  id: string;
  externalSystemId: string;
  platformEntityType: PlatformEntityType;
  authorityScopeKey: string;
  authority: Authority;
  status: RecordStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MappingProfile {
  id: string;
  profileKey: string;
  version: number;
  name: string;
  description: string | null;
  ownerType: ProfileOwnerType;
  ownerAppId: string | null;
  externalSystemId: string;
  sourceOfTruthRuleId: string;
  platformEntityType: PlatformEntityType;
  direction: MappingDirection;
  status: DefinitionLifecycle;
  createdByPersonId: string | null;
  publishedByPersonId: string | null;
  retiredByPersonId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
}

export interface SyncRunCounters {
  requestedCount: number;
  processedCount: number;
  createdCount: number;
  updatedCount: number;
  succeededCount: number;
  unchangedCount: number;
  skippedCount: number;
  conflictCount: number;
  failedCount: number;
}

export interface SyncRun extends SyncRunCounters {
  id: string;
  mappingProfileId: string;
  requestKey: string;
  status: SyncRunStatus;
  version: number;
  failureCode: string | null;
  summary: string | null;
  actorType: 'person' | 'service';
  actorPersonId: string | null;
  serviceIdentityId: string | null;
  executionType: 'platform' | 'application' | 'service';
  sourceAppId: string | null;
  requestId: string;
  traceId: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface SyncRecordResult {
  id: string;
  syncRunId: string;
  sourceRecordKey: string;
  externalEntityId: string | null;
  platformEntityType: PlatformEntityType | null;
  platformEntityId: string | null;
  sourceAttachmentId: string | null;
  sourceRow: number | null;
  sourceSha256: string | null;
  targetSha256: string | null;
  outcome: SyncRecordOutcome;
  errorCode: string | null;
  errorSummary: string | null;
  conflictState: ConflictState | null;
  conflictResolution: ConflictResolution | null;
  resolutionNote: string | null;
  resolvedByPersonId: string | null;
  resolvedByServiceIdentityId: string | null;
  resolvedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SyncConflict {
  resultId: string;
  syncRunId: string;
  sourceRecordKey: string;
  externalEntityId: string | null;
  platformEntityType: PlatformEntityType | null;
  platformEntityId: string | null;
  sourceAttachmentId: string | null;
  sourceRow: number | null;
  sourceSha256: string;
  targetSha256: string;
  state: ConflictState;
  resolution: ConflictResolution | null;
  resolutionNote: string | null;
  resolvedByPersonId: string | null;
  resolvedByServiceIdentityId: string | null;
  resolvedAt: string | null;
  version: number;
}

export interface SyncCheckpoint {
  id: string;
  mappingProfileId: string;
  partitionKey: string;
  cursor: string;
  sourceWatermarkAt: string | null;
  lastSuccessfulRunId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type DataAlignmentOperation =
  | 'dictionary_version_created' | 'dictionary_item_set' | 'dictionary_published' | 'dictionary_retired'
  | 'external_system_created' | 'external_system_updated'
  | 'source_of_truth_rule_created' | 'source_of_truth_rule_closed'
  | 'mapping_profile_created' | 'mapping_profile_published' | 'mapping_profile_retired'
  | 'sync_run_created' | 'sync_run_started' | 'sync_result_recorded' | 'sync_run_completed' | 'sync_run_cancelled'
  | 'sync_conflict_resolved' | 'sync_checkpoint_advanced';

export interface DataAlignmentOperationHistory {
  id: string;
  operation: DataAlignmentOperation;
  entityType: 'dictionary_version' | 'dictionary_item' | 'external_system' | 'source_of_truth_rule' | 'mapping_profile' | 'sync_run' | 'sync_record_result' | 'sync_checkpoint';
  entityId: string;
  actorType: 'person' | 'service';
  actorPersonId: string | null;
  serviceIdentityId: string | null;
  executionType: 'platform' | 'application' | 'service';
  sourceAppId: string | null;
  requestId: string;
  traceId: string;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}

export interface ExternalEntityReference {
  entityType: DirectoryEntityType;
  entityId: string;
  externalSystemCode: string;
  tenantKey: string;
  externalId: string;
  status: RecordStatus;
  verifiedAt: string | null;
}

export interface DirectoryReferenceAdapter {
  list(entityType?: DirectoryEntityType, input?: DataAlignmentListInput): Promise<ExternalEntityReference[]>;
  resolve(entityType: DirectoryEntityType, externalSystemCode: string, tenantKey: string, externalId: string): Promise<ExternalEntityReference | null>;
}

export interface CreateDictionaryVersionInput { id?: string; dictionaryKey: string; version: number; name: string; description?: string | null; note?: string | null; }
export interface SetDictionaryItemInput { id?: string; dictionaryVersionId: string; code: string; label: string; description?: string | null; sortOrder?: number; active?: boolean; note?: string | null; }
export interface CreateExternalSystemInput { id?: string; code: string; name: string; description?: string | null; status?: RecordStatus; note?: string | null; }
export interface UpdateExternalSystemInput { id: string; expectedUpdatedAt: string; name?: string; description?: string | null; status?: RecordStatus; note?: string | null; }
export interface CreateSourceOfTruthRuleInput { id?: string; externalSystemId: string; platformEntityType: PlatformEntityType; authorityScopeKey: string; authority: Authority; status?: RecordStatus; effectiveFrom: string; effectiveTo?: string | null; note?: string | null; }
export interface CloseSourceOfTruthRuleInput { id: string; expectedUpdatedAt: string; effectiveTo: string; note?: string | null; }
export interface CreateMappingProfileInput { id?: string; profileKey: string; version: number; name: string; description?: string | null; ownerType: ProfileOwnerType; ownerAppId?: string | null; externalSystemId: string; sourceOfTruthRuleId: string; platformEntityType: PlatformEntityType; direction: MappingDirection; note?: string | null; }
export interface CreateSyncRunInput { id?: string; mappingProfileId: string; requestKey: string; requestedCount: number; note?: string | null; }
export interface RecordSyncResultInput { id?: string; syncRunId: string; sourceRecordKey: string; externalEntityId?: string | null; platformEntityType?: PlatformEntityType | null; platformEntityId?: string | null; sourceAttachmentId?: string | null; sourceRow?: number | null; sourceSha256?: string | null; targetSha256?: string | null; outcome: SyncRecordOutcome; errorCode?: string | null; errorSummary?: string | null; note?: string | null; }
export interface CompleteSyncRunInput { syncRunId: string; expectedVersion: number; status: Extract<SyncRunStatus, 'succeeded' | 'partial' | 'failed'>; failureCode?: string | null; summary?: string | null; note?: string | null; }
export interface ResolveSyncConflictInput { resultId: string; expectedVersion: number; resolution: ConflictResolution; note?: string | null; }
export interface AdvanceSyncCheckpointInput { id?: string; mappingProfileId: string; partitionKey: string; cursor: string; sourceWatermarkAt?: string | null; successfulRunId: string; expectedVersion: number; note?: string | null; }
export interface DataAlignmentListInput { limit?: number; }

export interface LegacyDataAlignmentSnapshot {
  registeredExternalSystemCodes: readonly string[];
  externalReferences: readonly ExternalEntityReference[];
  devices: readonly { id: string; sourceKey: string | null; sourceFile: string | null; sourceRow: number | null }[];
  cloudDocumentSyncs: readonly { id: string; status: string; remoteRecordId: string | null; payloadHash: string | null; attempts: number; lastSyncAt: string | null }[];
  applicationFieldMaps?: readonly { sourceId: string; ownerAppId: string; mappingKey: string }[];
  checkpointProfileKeys?: readonly string[];
}

export type LegacyDataAlignmentIssueCode =
  | 'UNREGISTERED_PROVIDER' | 'DUPLICATE_EXTERNAL_REFERENCE' | 'UNSAFE_SOURCE_KEY' | 'DUPLICATE_SOURCE_KEY'
  | 'MISSING_SOURCE_EVIDENCE' | 'APP_OWNED_FIELD_MAP' | 'INVALID_SYNC_STATUS' | 'MISSING_REMOTE_ID'
  | 'FAILED_SYNC_ROW' | 'CHECKPOINT_GAP';

export interface LegacyDataAlignmentIssue { code: LegacyDataAlignmentIssueCode; sourceId: string; value?: string; }
export interface LegacyDataAlignmentReconciliation {
  externalReferenceCount: number;
  deviceEvidenceCount: number;
  cloudSyncCount: number;
  applicationFieldMapCount: number;
  issues: LegacyDataAlignmentIssue[];
}

export class DataAlignmentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'DataAlignmentError'; this.code = code; }
}
