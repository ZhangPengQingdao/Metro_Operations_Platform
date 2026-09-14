export const WORK_ITEM_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export const WORK_ITEM_BATCH_STATUSES = ['open', 'closed', 'cancelled'] as const;
export const WORK_ITEM_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const WORK_ITEM_CANDIDATE_TYPES = ['person', 'organization_unit'] as const;
export const WORK_ITEM_TARGET_TYPES = ['person', 'organization', 'location', 'asset'] as const;
export const WORK_ITEM_MISSED_OCCURRENCE_POLICIES = ['skip', 'latest_only', 'all'] as const;
export const WORK_ITEM_RECURRENCE_TYPES = ['daily', 'weekly', 'monthly'] as const;

export const WORK_ITEM_PERMISSION_CODES = {
  create: 'platform.work_items.create',
  read: 'platform.work_items.read',
  assign: 'platform.work_items.assign',
  manage: 'platform.work_items.manage',
  recurrenceManage: 'platform.work_items.recurrence.manage',
  completeOnBehalf: 'platform.work_items.complete_on_behalf'
} as const;

export const WORK_ITEM_PERMISSION_SEEDS = [
  { id: '45000000-0000-4000-8000-000000000011', code: WORK_ITEM_PERMISSION_CODES.create, name: '创建平台工作项' },
  { id: '45000000-0000-4000-8000-000000000012', code: WORK_ITEM_PERMISSION_CODES.read, name: '查看平台工作项' },
  { id: '45000000-0000-4000-8000-000000000013', code: WORK_ITEM_PERMISSION_CODES.assign, name: '分派平台工作项' },
  { id: '45000000-0000-4000-8000-000000000014', code: WORK_ITEM_PERMISSION_CODES.manage, name: '管理平台工作项' },
  { id: '45000000-0000-4000-8000-000000000015', code: WORK_ITEM_PERMISSION_CODES.recurrenceManage, name: '管理周期工作项' },
  { id: '45000000-0000-4000-8000-000000000016', code: WORK_ITEM_PERMISSION_CODES.completeOnBehalf, name: '代办结平台工作项' }
] as const;

export const WORK_ITEM_EVENT_TYPES = {
  created: 'platform.work-items.created.v1',
  assigned: 'platform.work-items.assigned.v1',
  claimed: 'platform.work-items.claimed.v1',
  progressUpdated: 'platform.work-items.progress-updated.v1',
  completed: 'platform.work-items.completed.v1',
  cancelled: 'platform.work-items.cancelled.v1',
  reopened: 'platform.work-items.reopened.v1',
  recurrenceGenerated: 'platform.work-items.recurrence-generated.v1',
  recurrenceGenerationSkipped: 'platform.work-items.recurrence-generation-skipped.v1'
} as const;

export type WorkItemStatus = typeof WORK_ITEM_STATUSES[number];
export type WorkItemBatchStatus = typeof WORK_ITEM_BATCH_STATUSES[number];
export type WorkItemPriority = typeof WORK_ITEM_PRIORITIES[number];
export type WorkItemCandidateType = typeof WORK_ITEM_CANDIDATE_TYPES[number];
export type WorkItemTargetType = typeof WORK_ITEM_TARGET_TYPES[number];
export type WorkItemMissedOccurrencePolicy = typeof WORK_ITEM_MISSED_OCCURRENCE_POLICIES[number];
export type WorkItemRecurrenceType = typeof WORK_ITEM_RECURRENCE_TYPES[number];
export type WorkItemPermissionCode = typeof WORK_ITEM_PERMISSION_CODES[keyof typeof WORK_ITEM_PERMISSION_CODES];
export type WorkItemEventType = typeof WORK_ITEM_EVENT_TYPES[keyof typeof WORK_ITEM_EVENT_TYPES];

export type WorkItemOperation =
  | 'created'
  | 'updated'
  | 'assigned'
  | 'claimed'
  | 'transferred'
  | 'returned'
  | 'progress_updated'
  | 'completed'
  | 'completed_on_behalf'
  | 'cancelled'
  | 'reopened'
  | 'recurrence_generated'
  | 'recurrence_generation_skipped';

export type WorkItemAssignmentAction = 'assigned' | 'claimed' | 'transferred' | 'returned' | 'completed_on_behalf';
export type WorkItemExecutionType = 'platform' | 'application' | 'service';
export type WorkItemActorType = 'person' | 'service';

export interface WorkItemSourceReference {
  appId: string;
  entityType: string;
  entityId: string;
}

export interface WorkItemDisplaySnapshot {
  title: string;
  summary: string | null;
  sourceLabel: string | null;
}

export interface WorkItemNavigationReference {
  href: string | null;
  routeName: string | null;
  params: Record<string, string>;
}

export interface WorkItemTargetReference {
  type: WorkItemTargetType;
  id: string;
  displayName: string | null;
}

export interface WorkItemCandidate {
  id: string;
  workItemId: string;
  candidateType: WorkItemCandidateType;
  candidateId: string;
  createdAt: string;
}

export interface CreateWorkItemCandidateInput {
  candidateType: WorkItemCandidateType;
  candidateId: string;
}

export interface WorkItemBatch {
  id: string;
  sourceAppId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  idempotencyKey: string | null;
  idempotencyPayloadHash: string | null;
  status: WorkItemBatchStatus;
  display: WorkItemDisplaySnapshot;
  navigation: WorkItemNavigationReference | null;
  defaultDueAt: string | null;
  createdByPersonId: string | null;
  createdByActorType: WorkItemActorType;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export interface WorkItem {
  id: string;
  batchId: string | null;
  sourceAppId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  idempotencyKey: string | null;
  idempotencyPayloadHash: string | null;
  recurrenceRuleId: string | null;
  recurrenceOccurrenceKey: string | null;
  recurrenceScheduledAt: string | null;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  display: WorkItemDisplaySnapshot;
  navigation: WorkItemNavigationReference | null;
  responsibilityAreaId: string | null;
  target: WorkItemTargetReference | null;
  currentAssigneePersonId: string | null;
  dueAt: string | null;
  createdByPersonId: string | null;
  createdByActorType: WorkItemActorType;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface WorkItemDetail {
  item: WorkItem;
  candidates: WorkItemCandidate[];
  assignmentHistory: WorkItemAssignmentHistory[];
  progressHistory: WorkItemProgressHistory[];
  completion: WorkItemCompletionEvidence | null;
  operationHistory: WorkItemOperationHistory[];
}

export interface WorkItemAssignmentHistory {
  id: string;
  workItemId: string;
  action: WorkItemAssignmentAction;
  fromAssigneePersonId: string | null;
  toAssigneePersonId: string | null;
  actorPersonId: string | null;
  note: string | null;
  occurredAt: string;
}

export interface WorkItemProgressHistory {
  id: string;
  workItemId: string;
  progressPercent: number | null;
  note: string | null;
  updaterPersonId: string | null;
  occurredAt: string;
}

export interface WorkItemCompletionEvidence {
  id: string;
  workItemId: string;
  assignedPersonId: string | null;
  actualCompleterPersonId: string | null;
  onBehalfOfPersonId: string | null;
  onBehalf: boolean;
  note: string | null;
  completedAt: string;
  sourceAppId: string;
}

export interface WorkItemOperationHistory {
  id: string;
  workItemId: string;
  operation: WorkItemOperation;
  actorType: WorkItemActorType;
  actorPersonId: string | null;
  serviceIdentityId: string | null;
  executionType: WorkItemExecutionType;
  sourceAppId: string | null;
  requestId: string | null;
  traceId: string | null;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}

export type WorkItemRecurrenceSchedule =
  | { type: 'daily'; triggerMinuteOfDay: number }
  | { type: 'weekly'; weekdays: readonly PlatformIsoWeekday[]; triggerMinuteOfDay: number }
  | { type: 'monthly'; dayOfMonth: number | 'last_day'; triggerMinuteOfDay: number };

export type PlatformIsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WorkItemRecurrenceRule {
  id: string;
  sourceAppId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  status: 'active' | 'disabled';
  schedule: WorkItemRecurrenceSchedule;
  missedOccurrencePolicy: WorkItemMissedOccurrencePolicy;
  dueAfterMinutes: number | null;
  priority: WorkItemPriority;
  display: WorkItemDisplaySnapshot;
  navigation: WorkItemNavigationReference | null;
  responsibilityAreaId: string | null;
  target: WorkItemTargetReference | null;
  candidates: CreateWorkItemCandidateInput[];
  currentAssigneePersonId: string | null;
  startAt: string;
  lastGeneratedScheduledAt: string | null;
  disabledAt: string | null;
  idempotencyKey: string | null;
  idempotencyPayloadHash: string | null;
  createdByPersonId: string | null;
  createdByActorType: WorkItemActorType;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkItemInput {
  id?: string;
  batchId?: string | null;
  source: WorkItemSourceReference;
  idempotencyKey?: string | null;
  display: WorkItemDisplaySnapshot;
  navigation?: WorkItemNavigationReference | null;
  priority?: WorkItemPriority;
  responsibilityAreaId?: string | null;
  target?: WorkItemTargetReference | null;
  candidates?: readonly CreateWorkItemCandidateInput[];
  currentAssigneePersonId?: string | null;
  dueAt?: Date | null;
}

export interface CreateWorkItemBatchInput {
  id?: string;
  source: WorkItemSourceReference;
  idempotencyKey?: string | null;
  display: WorkItemDisplaySnapshot;
  navigation?: WorkItemNavigationReference | null;
  defaultDueAt?: Date | null;
  items: readonly Omit<CreateWorkItemInput, 'batchId' | 'source' | 'idempotencyKey'>[];
}

export interface UpdateWorkItemInput {
  workItemId: string;
  display?: WorkItemDisplaySnapshot;
  navigation?: WorkItemNavigationReference | null;
  priority?: WorkItemPriority;
  responsibilityAreaId?: string | null;
  target?: WorkItemTargetReference | null;
  candidates?: readonly CreateWorkItemCandidateInput[];
  currentAssigneePersonId?: string | null;
  dueAt?: Date | null;
  note?: string | null;
}

export interface WorkItemProgressInput {
  workItemId: string;
  progressPercent?: number | null;
  note?: string | null;
}

export interface CompleteWorkItemInput {
  workItemId: string;
  note?: string | null;
  onBehalfOfPersonId?: string | null;
}

export interface WorkItemTransitionInput {
  workItemId: string;
  note?: string | null;
}

export interface AssignWorkItemInput {
  workItemId: string;
  assigneePersonId: string | null;
  note?: string | null;
}

export interface CreateWorkItemRecurrenceRuleInput {
  id?: string;
  source: WorkItemSourceReference;
  idempotencyKey?: string | null;
  schedule: WorkItemRecurrenceSchedule;
  missedOccurrencePolicy?: WorkItemMissedOccurrencePolicy;
  dueAfterMinutes?: number | null;
  display: WorkItemDisplaySnapshot;
  navigation?: WorkItemNavigationReference | null;
  priority?: WorkItemPriority;
  responsibilityAreaId?: string | null;
  target?: WorkItemTargetReference | null;
  candidates?: readonly CreateWorkItemCandidateInput[];
  currentAssigneePersonId?: string | null;
  startAt?: Date;
}

export interface UpdateWorkItemRecurrenceRuleInput {
  ruleId: string;
  schedule?: WorkItemRecurrenceSchedule;
  missedOccurrencePolicy?: WorkItemMissedOccurrencePolicy;
  dueAfterMinutes?: number | null;
  display?: WorkItemDisplaySnapshot;
  navigation?: WorkItemNavigationReference | null;
  priority?: WorkItemPriority;
  responsibilityAreaId?: string | null;
  target?: WorkItemTargetReference | null;
  candidates?: readonly CreateWorkItemCandidateInput[];
  currentAssigneePersonId?: string | null;
  note?: string | null;
}

export interface GenerateWorkItemRecurrencesInput {
  now?: Date;
  maxRules?: number;
}

export interface GenerateWorkItemRecurrencesResult {
  checkedRules: number;
  generatedWorkItemIds: string[];
  skippedOccurrences: number;
}

export interface WorkItemListInput {
  batchId?: string;
  status?: WorkItemStatus | readonly WorkItemStatus[];
  sourceAppId?: string;
  candidatePersonId?: string;
  candidateOrganizationUnitId?: string;
  currentAssigneePersonId?: string;
  target?: { type: WorkItemTargetType; id: string };
}

export interface LegacyTodoTaskReference {
  id: string;
  title: string;
  sourceAppId?: string | null;
  dueAt?: string | null;
  status?: string | null;
}

export interface LegacyTodoItemReference {
  id: string;
  taskId?: string | null;
  handlerId?: string | null;
  status?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  deepLink?: string | null;
}

export interface LegacyTodoRecurrenceTemplateReference {
  id: string;
  recurrenceType?: string | null;
  recurrenceValue?: number | null;
  triggerMinutes?: number | null;
  dueMinutes?: number | null;
  enabled?: boolean | null;
}

export interface LegacyTodoSnapshot {
  tasks: readonly LegacyTodoTaskReference[];
  items: readonly LegacyTodoItemReference[];
  recurringTemplates?: readonly LegacyTodoRecurrenceTemplateReference[];
}

export type LegacyWorkItemIssueCode =
  | 'MISSING_BATCH'
  | 'UNKNOWN_STATUS'
  | 'ITEM_WITHOUT_HANDLER'
  | 'INVALID_RECURRENCE_TYPE';

export interface LegacyWorkItemIssue {
  code: LegacyWorkItemIssueCode;
  sourceId: string;
}

export interface LegacyWorkItemReconciliation {
  taskCount: number;
  itemCount: number;
  batchCount: number;
  workItemCount: number;
  recurringTemplateCount: number;
  completedCount: number;
  preservedBatchIds: string[];
  preservedWorkItemIds: string[];
  deepLinkCount: number;
  issues: LegacyWorkItemIssue[];
}

export class WorkItemError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkItemError';
    this.code = code;
  }
}
