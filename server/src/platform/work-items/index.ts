import { runAtomicOperation } from '../../core/database/index.js';
import { applicationGrantAllows } from '../context/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { enqueueCoreEvent, type CoreOutboxRepository } from '../../core/events/index.js';
import type { CoreJobDefinition } from '../../core/jobs/index.js';
import { getPlatformDateTime, toPlatformInstant, type PlatformClock } from '../../core/time/index.js';
import type { AuthorizationResource, DataScopeTarget } from '../authorization/index.js';
import type { PlatformActorContext } from '../context/index.js';
import {
  WORK_ITEM_CANDIDATE_TYPES,
  WORK_ITEM_EVENT_TYPES,
  WORK_ITEM_MISSED_OCCURRENCE_POLICIES,
  WORK_ITEM_PERMISSION_CODES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_RECURRENCE_TYPES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TARGET_TYPES,
  WorkItemError,
  type AssignWorkItemInput,
  type CompleteWorkItemInput,
  type CreateWorkItemBatchInput,
  type CreateWorkItemCandidateInput,
  type CreateWorkItemInput,
  type CreateWorkItemRecurrenceRuleInput,
  type GenerateWorkItemRecurrencesInput,
  type GenerateWorkItemRecurrencesResult,
  type PlatformIsoWeekday,
  type UpdateWorkItemInput,
  type UpdateWorkItemRecurrenceRuleInput,
  type WorkItem,
  type WorkItemAssignmentAction,
  type WorkItemBatch,
  type WorkItemCandidate,
  type WorkItemDetail,
  type WorkItemDisplaySnapshot,
  type WorkItemListInput,
  type WorkItemNavigationReference,
  type WorkItemOperation,
  type WorkItemProgressInput,
  type WorkItemRecurrenceRule,
  type WorkItemRecurrenceSchedule,
  type WorkItemTargetReference,
  type WorkItemTransitionInput
} from './model.js';
import type { WorkItemRepository } from './repository.js';

export * from './migration.js';
export * from './model.js';
export * from './repository.js';

export interface WorkItemDirectoryPerson {
  organizationUnitId: string;
  employmentStatus: string;
}

export interface WorkItemDirectoryOrganizationUnit {
  status: string;
  unitType?: string;
}

export interface WorkItemDirectoryLocation {
  status: string;
}

export interface WorkItemDirectoryAsset {
  lifecycleState: string;
}

export interface WorkItemResponsibilityArea {
  status: string;
}

export interface WorkItemServiceOptions {
  clock?: PlatformClock | (() => Date);
  createId?: () => string;
  createEventId?: () => string;
  outbox?: CoreOutboxRepository;
  findPerson(id: string): Promise<WorkItemDirectoryPerson | null>;
  findOrganizationUnit(id: string): Promise<WorkItemDirectoryOrganizationUnit | null>;
  listActiveOrganizationMembers(organizationUnitId: string): Promise<Array<{ id: string; organizationUnitId: string; employmentStatus: string }>>;
  findLocation(id: string): Promise<WorkItemDirectoryLocation | null>;
  findAsset(id: string): Promise<WorkItemDirectoryAsset | null>;
  findResponsibilityArea?(id: string): Promise<WorkItemResponsibilityArea | null>;
}

export class WorkItemService {
  private readonly createId: () => string;
  private readonly createEventId: () => string;

  constructor(private readonly repository: WorkItemRepository, private readonly options: WorkItemServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.createEventId = options.createEventId ?? this.createId;
  }

  async createWorkItem(context: PlatformActorContext, input: CreateWorkItemInput): Promise<WorkItem> {
    return this.atomic(async () => {
      const draft = await this.prepareWorkItemDraft(context, input, null, null);
      const hash = payloadHash(draft.idempotencyPayload);
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.create, await this.resourceForDraft(draft.record));
      if (draft.record.idempotencyKey) {
        const existing = await this.repository.findWorkItemByIdempotencyKey(draft.record.sourceAppId, 'work_item', draft.record.idempotencyKey);
        if (existing) {
          await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.create, await this.resourceForItem(existing));
          return this.returnIdempotent(existing, hash);
        }
      }
      const saved = await this.repository.createWorkItem({ ...draft.record, idempotencyPayloadHash: hash }, draft.candidates);
      await this.recordOperation(context, saved, 'created', null, saved, null);
      await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.created, 'created', ['status', 'display']);
      return saved;
    });
  }

  async createBatch(context: PlatformActorContext, input: CreateWorkItemBatchInput): Promise<{ batch: WorkItemBatch; workItems: WorkItem[] }> {
    return this.atomic(async () => {
      const source = normalizeSource(input.source);
      assertExecutionSource(context, source.appId);
      const idempotencyKey = normalizeOptionalText(input.idempotencyKey, 200);
      const normalizedItems = input.items.map((item) => ({
        ...item,
        dueAt: item.dueAt ?? input.defaultDueAt ?? null
      }));
      const batchPayload = normalizePayload({
        source,
        display: normalizeDisplay(input.display),
        navigation: normalizeNavigation(input.navigation),
        defaultDueAt: input.defaultDueAt?.toISOString() ?? null,
        items: normalizedItems.map((item) => normalizeCreateInputForHash({ ...item, source }))
      });
      const hash = payloadHash(batchPayload);
      const batchId = uuid(input.id ?? this.createId(), 'batch id');
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.create, {});
      const drafts = [];
      for (const itemInput of normalizedItems) {
        const draft = await this.prepareWorkItemDraft(context, { ...itemInput, source, batchId }, batchId, null);
        await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.create, await this.resourceForDraft(draft.record));
        drafts.push(draft);
      }
      if (idempotencyKey) {
        const existing = await this.repository.findBatchByIdempotencyKey(source.appId, idempotencyKey);
        if (existing) {
          if (existing.idempotencyPayloadHash !== hash) throw new WorkItemError('IDEMPOTENCY_CONFLICT', '相同幂等键的批次请求内容不同');
          const workItems = await this.repository.listWorkItems({ batchId: existing.id });
          for (const item of workItems) await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.create, await this.resourceForItem(item));
          return { batch: existing, workItems };
        }
      }

      const now = this.now().toISOString();
      const batch: WorkItemBatch = {
        id: batchId,
        sourceAppId: source.appId,
        sourceEntityType: source.entityType,
        sourceEntityId: source.entityId,
        idempotencyKey,
        idempotencyPayloadHash: hash,
        status: 'open',
        display: normalizeDisplay(input.display),
        navigation: normalizeNavigation(input.navigation),
        defaultDueAt: input.defaultDueAt?.toISOString() ?? null,
        createdByPersonId: context.actorType === 'person' ? context.person.id : null,
        createdByActorType: context.actorType,
        createdAt: now,
        updatedAt: now,
        cancelledAt: null
      };
      const savedBatch = await this.repository.createBatch(batch);
      const workItems: WorkItem[] = [];
      for (const draft of drafts) {
        const saved = await this.repository.createWorkItem({
          ...draft.record,
          idempotencyKey: null,
          idempotencyPayloadHash: null
        }, draft.candidates);
        await this.recordOperation(context, saved, 'created', null, saved, null);
        await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.created, 'created', ['status', 'display']);
        workItems.push(saved);
      }
      return { batch: savedBatch, workItems };
    });
  }

  async getWorkItem(context: PlatformActorContext, workItemId: string): Promise<WorkItemDetail> {
    return runAtomicOperation([this.repository], async () => {
      const item = await this.requireReadableWorkItem(context, uuid(workItemId, 'work item id'));
      return this.detail(item);
    });
  }

  async listWorkItems(context: PlatformActorContext, input: WorkItemListInput = {}): Promise<WorkItem[]> {
    return runAtomicOperation([this.repository], async () => {
      const items = await this.repository.listWorkItems(normalizeListInput(input));
      const readable: WorkItem[] = [];
      for (const item of items) {
        if (await this.canRead(context, item, await this.repository.listCandidates(item.id))) readable.push(item);
      }
      return readable;
    });
  }

  async updateWorkItem(context: PlatformActorContext, input: UpdateWorkItemInput): Promise<WorkItem> {
    return this.atomic(async () => {
      const item = await this.requireExistingWorkItem(input.workItemId);
      assertEditable(item);
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.manage, await this.resourceForItem(item));
      const before = structuredClone(item);
      const next: WorkItem = {
        ...item,
        display: input.display === undefined ? item.display : normalizeDisplay(input.display),
        navigation: input.navigation === undefined ? item.navigation : normalizeNavigation(input.navigation),
        priority: input.priority === undefined ? item.priority : priority(input.priority),
        responsibilityAreaId: input.responsibilityAreaId === undefined ? item.responsibilityAreaId : await this.validateResponsibilityArea(input.responsibilityAreaId),
        target: input.target === undefined ? item.target : await this.validateTarget(input.target),
        currentAssigneePersonId: input.currentAssigneePersonId === undefined ? item.currentAssigneePersonId : await this.validateOptionalPerson(input.currentAssigneePersonId),
        dueAt: input.dueAt === undefined ? item.dueAt : input.dueAt?.toISOString() ?? null,
        updatedAt: this.now().toISOString()
      };
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.manage, await this.resourceForItem(next));
      const saved = await this.repository.updateWorkItem(next);
      if (input.candidates !== undefined) {
        await this.repository.replaceCandidates(saved.id, await this.prepareCandidates(saved.id, input.candidates, saved.createdAt));
      }
      await this.recordOperation(context, saved, 'updated', before, saved, input.note);
      return saved;
    });
  }

  async assignWorkItem(context: PlatformActorContext, input: AssignWorkItemInput): Promise<WorkItem> {
    return this.atomic(async () => {
      const item = await this.requireExistingWorkItem(input.workItemId);
      assertEditable(item);
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.assign, await this.resourceForItem(item));
      const assigneePersonId = await this.validateOptionalPerson(input.assigneePersonId);
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.assign, await this.resourceForItem({ ...item, currentAssigneePersonId: assigneePersonId }));
      const before = structuredClone(item);
      const action: WorkItemAssignmentAction = assigneePersonId === null ? 'returned' : item.currentAssigneePersonId ? 'transferred' : 'assigned';
      const saved = await this.repository.updateWorkItem({
        ...item,
        currentAssigneePersonId: assigneePersonId,
        updatedAt: this.now().toISOString()
      });
      await this.recordAssignment(context, saved, action, before.currentAssigneePersonId, assigneePersonId, input.note);
      await this.recordOperation(context, saved, action === 'returned' ? 'returned' : action, before, saved, input.note);
      await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.assigned, action, ['currentAssigneePersonId']);
      return saved;
    });
  }

  async claimWorkItem(context: PlatformActorContext, input: WorkItemTransitionInput): Promise<WorkItem> {
    return this.atomic(async () => {
      if (context.actorType !== 'person') throw new WorkItemError('PERSON_ACTOR_REQUIRED', '认领工作项需要人员上下文');
      const item = await this.requireExistingWorkItem(input.workItemId);
      assertEditable(item);
      const candidates = await this.repository.listCandidates(item.id);
      await this.requireApplicationGrant(context, WORK_ITEM_PERMISSION_CODES.assign, item);
      if (!await this.isDirectParticipant(context.person.id, item, candidates)) throw new WorkItemError('WORK_ITEM_ACCESS_DENIED', '只有候选范围内人员可以认领工作项');
      const before = structuredClone(item);
      const saved = await this.repository.updateWorkItem({
        ...item,
        status: 'in_progress',
        currentAssigneePersonId: context.person.id,
        updatedAt: this.now().toISOString()
      });
      await this.recordAssignment(context, saved, 'claimed', before.currentAssigneePersonId, context.person.id, input.note);
      await this.recordOperation(context, saved, 'claimed', before, saved, input.note);
      await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.claimed, 'claimed', ['status', 'currentAssigneePersonId']);
      return saved;
    });
  }

  async updateProgress(context: PlatformActorContext, input: WorkItemProgressInput): Promise<WorkItem> {
    return this.atomic(async () => {
      const item = await this.requireExistingWorkItem(input.workItemId);
      assertEditable(item);
      const candidates = await this.repository.listCandidates(item.id);
      if (!await this.isDirectParticipantOrManager(context, item, candidates, WORK_ITEM_PERMISSION_CODES.manage)) {
        throw new WorkItemError('WORK_ITEM_ACCESS_DENIED', '无权更新工作项进度');
      }
      const progressPercent = input.progressPercent === undefined ? null : normalizeProgressPercent(input.progressPercent);
      const before = structuredClone(item);
      const saved = await this.repository.updateWorkItem({
        ...item,
        status: item.status === 'pending' ? 'in_progress' : item.status,
        updatedAt: this.now().toISOString()
      });
      await this.repository.addProgressHistory({
        id: uuid(this.createId(), 'progress history id'),
        workItemId: saved.id,
        progressPercent,
        note: normalizeOptionalText(input.note, 2000),
        updaterPersonId: context.actorType === 'person' ? context.person.id : null,
        occurredAt: saved.updatedAt
      });
      await this.recordOperation(context, saved, 'progress_updated', before, { status: saved.status, progressPercent, note: normalizeOptionalText(input.note, 2000) }, input.note);
      await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.progressUpdated, 'progress_updated', ['status', 'progress']);
      return saved;
    });
  }

  async completeWorkItem(context: PlatformActorContext, input: CompleteWorkItemInput): Promise<WorkItem> {
    return this.atomic(async () => {
      const item = await this.requireExistingWorkItem(input.workItemId);
      assertEditable(item);
      const candidates = await this.repository.listCandidates(item.id);
      const onBehalfOfPersonId = input.onBehalfOfPersonId ? uuid(input.onBehalfOfPersonId, 'on behalf person id') : null;
      const directParticipant = context.actorType === 'person' && await this.isDirectParticipant(context.person.id, item, candidates);
      const completingOnBehalf = Boolean(onBehalfOfPersonId && (context.actorType !== 'person' || onBehalfOfPersonId !== context.person.id));
      if (completingOnBehalf) {
        await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.completeOnBehalf, await this.resourceForItem(item));
        if (onBehalfOfPersonId) await this.validateOptionalPerson(onBehalfOfPersonId);
      } else if (!directParticipant) {
        throw new WorkItemError('WORK_ITEM_ACCESS_DENIED', '只有办理人或候选范围内人员可以直接完成工作项');
      }
      if (!completingOnBehalf) await this.requireApplicationGrant(context, WORK_ITEM_PERMISSION_CODES.manage, item);
      const before = structuredClone(item);
      const now = this.now().toISOString();
      const saved = await this.repository.updateWorkItem({
        ...item,
        status: 'completed',
        updatedAt: now,
        completedAt: now,
        cancelledAt: null
      });
      await this.repository.addCompletionEvidence({
        id: uuid(this.createId(), 'completion evidence id'),
        workItemId: saved.id,
        assignedPersonId: before.currentAssigneePersonId,
        actualCompleterPersonId: context.actorType === 'person' ? context.person.id : null,
        onBehalfOfPersonId,
        onBehalf: completingOnBehalf,
        note: normalizeOptionalText(input.note, 2000),
        completedAt: now,
        sourceAppId: saved.sourceAppId
      });
      if (completingOnBehalf) await this.recordAssignment(context, saved, 'completed_on_behalf', before.currentAssigneePersonId, onBehalfOfPersonId, input.note);
      await this.recordOperation(context, saved, completingOnBehalf ? 'completed_on_behalf' : 'completed', before, saved, input.note);
      await this.closeBatchIfDone(saved.batchId);
      await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.completed, 'completed', ['status', 'completedAt']);
      return saved;
    });
  }

  async cancelWorkItem(context: PlatformActorContext, input: WorkItemTransitionInput): Promise<WorkItem> {
    return this.atomic(async () => {
      const item = await this.requireExistingWorkItem(input.workItemId);
      if (item.status === 'completed' || item.status === 'cancelled') throw new WorkItemError('INVALID_STATUS_TRANSITION', '已完成或已取消工作项不能直接取消');
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.manage, await this.resourceForItem(item));
      const before = structuredClone(item);
      const now = this.now().toISOString();
      const saved = await this.repository.updateWorkItem({ ...item, status: 'cancelled', cancelledAt: now, updatedAt: now });
      await this.recordOperation(context, saved, 'cancelled', before, saved, input.note);
      await this.closeBatchIfDone(saved.batchId);
      await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.cancelled, 'cancelled', ['status', 'cancelledAt']);
      return saved;
    });
  }

  async reopenWorkItem(context: PlatformActorContext, input: WorkItemTransitionInput): Promise<WorkItem> {
    return this.atomic(async () => {
      const item = await this.requireExistingWorkItem(input.workItemId);
      if (item.status !== 'completed' && item.status !== 'cancelled') throw new WorkItemError('INVALID_STATUS_TRANSITION', '只有已完成或已取消工作项可以重新打开');
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.manage, await this.resourceForItem(item));
      const before = structuredClone(item);
      const saved = await this.repository.updateWorkItem({
        ...item,
        status: item.currentAssigneePersonId ? 'in_progress' : 'pending',
        completedAt: null,
        cancelledAt: null,
        updatedAt: this.now().toISOString()
      });
      await this.recordOperation(context, saved, 'reopened', before, saved, input.note);
      await this.reopenBatchIfNeeded(saved.batchId);
      await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.reopened, 'reopened', ['status']);
      return saved;
    });
  }

  async createRecurrenceRule(context: PlatformActorContext, input: CreateWorkItemRecurrenceRuleInput): Promise<WorkItemRecurrenceRule> {
    return this.atomic(async () => {
      const source = normalizeSource(input.source);
      assertExecutionSource(context, source.appId);
      const idempotencyKey = normalizeOptionalText(input.idempotencyKey, 200);
      const normalized = await this.normalizeRecurrenceRuleInput(context, input);
      const hash = payloadHash(normalized.payload);
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.recurrenceManage, await this.resourceForRule(normalized.record));
      if (idempotencyKey) {
        const existing = await this.repository.findRecurrenceRuleByIdempotencyKey(source.appId, idempotencyKey);
        if (existing) {
          await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.recurrenceManage, await this.resourceForRule(existing));
          if (existing.idempotencyPayloadHash !== hash) throw new WorkItemError('IDEMPOTENCY_CONFLICT', '相同幂等键的周期规则请求内容不同');
          return existing;
        }
      }
      return this.repository.createRecurrenceRule({ ...normalized.record, idempotencyPayloadHash: hash });
    });
  }

  async updateRecurrenceRule(context: PlatformActorContext, input: UpdateWorkItemRecurrenceRuleInput): Promise<WorkItemRecurrenceRule> {
    return this.atomic(async () => {
      const current = await this.requireRecurrenceRule(input.ruleId);
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.recurrenceManage, await this.resourceForRule(current));
      const next: WorkItemRecurrenceRule = {
        ...current,
        schedule: input.schedule === undefined ? current.schedule : normalizeSchedule(input.schedule),
        missedOccurrencePolicy: input.missedOccurrencePolicy === undefined ? current.missedOccurrencePolicy : missedPolicy(input.missedOccurrencePolicy),
        dueAfterMinutes: input.dueAfterMinutes === undefined ? current.dueAfterMinutes : normalizeDueAfter(input.dueAfterMinutes),
        priority: input.priority === undefined ? current.priority : priority(input.priority),
        display: input.display === undefined ? current.display : normalizeDisplay(input.display),
        navigation: input.navigation === undefined ? current.navigation : normalizeNavigation(input.navigation),
        responsibilityAreaId: input.responsibilityAreaId === undefined ? current.responsibilityAreaId : await this.validateResponsibilityArea(input.responsibilityAreaId),
        target: input.target === undefined ? current.target : await this.validateTarget(input.target),
        candidates: input.candidates === undefined ? current.candidates : await this.validateCandidates(input.candidates),
        currentAssigneePersonId: input.currentAssigneePersonId === undefined ? current.currentAssigneePersonId : await this.validateOptionalPerson(input.currentAssigneePersonId),
        updatedAt: this.now().toISOString()
      };
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.recurrenceManage, await this.resourceForRule(next));
      return this.repository.updateRecurrenceRule(next);
    });
  }

  async disableRecurrenceRule(context: PlatformActorContext, input: { ruleId: string; note?: string | null }): Promise<WorkItemRecurrenceRule> {
    return this.atomic(async () => {
      const current = await this.requireRecurrenceRule(input.ruleId);
      await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.recurrenceManage, await this.resourceForRule(current));
      const now = this.now().toISOString();
      return this.repository.updateRecurrenceRule({ ...current, status: 'disabled', disabledAt: now, updatedAt: now });
    });
  }

  async generateDueRecurrences(context: PlatformActorContext, input: GenerateWorkItemRecurrencesInput = {}): Promise<GenerateWorkItemRecurrencesResult> {
    return this.atomic(async () => {
      const now = input.now ?? this.now();
      const pageSize = input.maxRules ?? 100;
      if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new WorkItemError('INVALID_RULE_LIMIT', '周期规则分页数量必须是正整数');
      const result: GenerateWorkItemRecurrencesResult = { checkedRules: 0, generatedWorkItemIds: [], skippedOccurrences: 0 };
      let afterId = '';
      while (true) {
        const rules = await this.repository.listActiveRecurrenceRules(pageSize, afterId);
        if (!rules.length) break;
        result.checkedRules += rules.length;
        afterId = rules[rules.length - 1].id;
        for (const rule of rules) {
        await this.requireAuthorized(context, WORK_ITEM_PERMISSION_CODES.recurrenceManage, await this.resourceForRule(rule));
        const occurrences = selectOccurrences(rule, now);
        result.skippedOccurrences += occurrences.skipped;
        if (occurrences.skipped > 0 && occurrences.toGenerate.length === 0) {
          const updated = { ...rule, lastGeneratedScheduledAt: occurrences.latestDue?.toISOString() ?? rule.lastGeneratedScheduledAt, updatedAt: now.toISOString() };
          await this.repository.updateRecurrenceRule(updated);
          await this.emitRuleEvent(context, updated, WORK_ITEM_EVENT_TYPES.recurrenceGenerationSkipped, occurrences.skipped);
          continue;
        }
        let latestGenerated = rule.lastGeneratedScheduledAt;
        for (const scheduledAt of occurrences.toGenerate) {
          const occurrenceKey = `${rule.id}:${scheduledAt.toISOString()}`;
          const existing = await this.repository.findWorkItemByOccurrence(rule.id, occurrenceKey);
          if (existing) {
            latestGenerated = scheduledAt.toISOString();
            continue;
          }
          const item = await this.createRecurringWorkItem(context, rule, scheduledAt, occurrenceKey);
          latestGenerated = scheduledAt.toISOString();
          result.generatedWorkItemIds.push(item.id);
        }
        if (latestGenerated !== rule.lastGeneratedScheduledAt || occurrences.latestDue) {
          await this.repository.updateRecurrenceRule({
            ...rule,
            lastGeneratedScheduledAt: (occurrences.latestDue ?? (latestGenerated ? new Date(latestGenerated) : null))?.toISOString() ?? latestGenerated,
            updatedAt: now.toISOString()
          });
        }
      }
      }
      return result;
    });
  }

  async deleteWorkItem(): Promise<never> {
    throw new WorkItemError('HARD_DELETE_NOT_SUPPORTED', '平台工作项不提供业务硬删除接口，请取消无效或过期工作项');
  }

  private async prepareWorkItemDraft(
    context: PlatformActorContext,
    input: CreateWorkItemInput,
    forcedBatchId: string | null,
    recurrence: { ruleId: string; occurrenceKey: string; scheduledAt: Date } | null
  ) {
    const source = normalizeSource(input.source);
    assertExecutionSource(context, source.appId);
    const now = this.now().toISOString();
    const record: WorkItem = {
      id: uuid(input.id ?? this.createId(), 'work item id'),
      batchId: forcedBatchId ?? (input.batchId ? uuid(input.batchId, 'batch id') : null),
      sourceAppId: source.appId,
      sourceEntityType: source.entityType,
      sourceEntityId: source.entityId,
      idempotencyKey: normalizeOptionalText(input.idempotencyKey, 200),
      idempotencyPayloadHash: null,
      recurrenceRuleId: recurrence?.ruleId ?? null,
      recurrenceOccurrenceKey: recurrence?.occurrenceKey ?? null,
      recurrenceScheduledAt: recurrence?.scheduledAt.toISOString() ?? null,
      status: 'pending',
      priority: priority(input.priority ?? 'normal'),
      display: normalizeDisplay(input.display),
      navigation: normalizeNavigation(input.navigation),
      responsibilityAreaId: await this.validateResponsibilityArea(input.responsibilityAreaId),
      target: await this.validateTarget(input.target),
      currentAssigneePersonId: await this.validateOptionalPerson(input.currentAssigneePersonId),
      dueAt: input.dueAt?.toISOString() ?? null,
      createdByPersonId: context.actorType === 'person' ? context.person.id : null,
      createdByActorType: context.actorType,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      cancelledAt: null
    };
    const candidates = await this.prepareCandidates(record.id, input.candidates ?? [], now);
    const idempotencyPayload = normalizeCreateInputForHash({ ...input, source, batchId: record.batchId, dueAt: input.dueAt ?? null });
    return { record, candidates, idempotencyPayload };
  }

  private async normalizeRecurrenceRuleInput(context: PlatformActorContext, input: CreateWorkItemRecurrenceRuleInput) {
    const source = normalizeSource(input.source);
    const now = this.now().toISOString();
    const record: WorkItemRecurrenceRule = {
      id: uuid(input.id ?? this.createId(), 'recurrence rule id'),
      sourceAppId: source.appId,
      sourceEntityType: source.entityType,
      sourceEntityId: source.entityId,
      status: 'active',
      schedule: normalizeSchedule(input.schedule),
      missedOccurrencePolicy: missedPolicy(input.missedOccurrencePolicy ?? 'latest_only'),
      dueAfterMinutes: normalizeDueAfter(input.dueAfterMinutes ?? null),
      priority: priority(input.priority ?? 'normal'),
      display: normalizeDisplay(input.display),
      navigation: normalizeNavigation(input.navigation),
      responsibilityAreaId: await this.validateResponsibilityArea(input.responsibilityAreaId),
      target: await this.validateTarget(input.target),
      candidates: await this.validateCandidates(input.candidates ?? []),
      currentAssigneePersonId: await this.validateOptionalPerson(input.currentAssigneePersonId),
      startAt: (input.startAt ?? this.now()).toISOString(),
      lastGeneratedScheduledAt: null,
      disabledAt: null,
      idempotencyKey: normalizeOptionalText(input.idempotencyKey, 200),
      idempotencyPayloadHash: null,
      createdByPersonId: context.actorType === 'person' ? context.person.id : null,
      createdByActorType: context.actorType,
      createdAt: now,
      updatedAt: now
    };
    return {
      record,
      payload: normalizePayload({
        source,
        schedule: record.schedule,
        missedOccurrencePolicy: record.missedOccurrencePolicy,
        dueAfterMinutes: record.dueAfterMinutes,
        priority: record.priority,
        display: record.display,
        navigation: record.navigation,
        responsibilityAreaId: record.responsibilityAreaId,
        target: record.target,
        candidates: record.candidates,
        currentAssigneePersonId: record.currentAssigneePersonId,
        startAt: record.startAt
      })
    };
  }

  private async createRecurringWorkItem(context: PlatformActorContext, rule: WorkItemRecurrenceRule, scheduledAt: Date, occurrenceKey: string) {
    const dueAt = rule.dueAfterMinutes === null ? null : new Date(scheduledAt.getTime() + rule.dueAfterMinutes * 60_000);
    const draft = await this.prepareWorkItemDraft(context, {
      source: { appId: rule.sourceAppId, entityType: rule.sourceEntityType, entityId: rule.sourceEntityId },
      idempotencyKey: `recurrence:${occurrenceKey}`,
      display: rule.display,
      navigation: rule.navigation,
      priority: rule.priority,
      responsibilityAreaId: rule.responsibilityAreaId,
      target: rule.target,
      candidates: rule.candidates,
      currentAssigneePersonId: rule.currentAssigneePersonId,
      dueAt
    }, null, { ruleId: rule.id, occurrenceKey, scheduledAt });
    const hash = payloadHash(draft.idempotencyPayload);
    const saved = await this.repository.createWorkItem({ ...draft.record, idempotencyPayloadHash: hash }, draft.candidates);
    await this.recordOperation(context, saved, 'recurrence_generated', null, saved, null);
    await this.emit(context, saved, WORK_ITEM_EVENT_TYPES.recurrenceGenerated, 'recurrence_generated', ['recurrenceOccurrenceKey']);
    return saved;
  }

  private async prepareCandidates(workItemId: string, input: readonly CreateWorkItemCandidateInput[], createdAt: string) {
    const candidates = await this.validateCandidates(input);
    return candidates.map((candidate) => ({
      id: uuid(this.createId(), 'candidate id'),
      workItemId,
      candidateType: candidate.candidateType,
      candidateId: candidate.candidateId,
      createdAt
    }));
  }

  private async validateCandidates(input: readonly CreateWorkItemCandidateInput[]) {
    const result: CreateWorkItemCandidateInput[] = [];
    const seen = new Set<string>();
    for (const candidate of input) {
      if (!WORK_ITEM_CANDIDATE_TYPES.includes(candidate.candidateType)) throw new WorkItemError('INVALID_CANDIDATE_TYPE', '候选类型无效');
      const candidateId = uuid(candidate.candidateId, 'candidate id');
      if (candidate.candidateType === 'person') await this.validateOptionalPerson(candidateId);
      else await this.validateOrganizationUnit(candidateId);
      const key = `${candidate.candidateType}:${candidateId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ candidateType: candidate.candidateType, candidateId });
    }
    return result;
  }

  private async validateOptionalPerson(personId: string | null | undefined) {
    if (!personId) return null;
    const id = uuid(personId, 'person id');
    const person = await this.options.findPerson(id);
    if (!person) throw new WorkItemError('PERSON_NOT_FOUND', '人员不存在');
    if (person.employmentStatus !== 'active') throw new WorkItemError('PERSON_INACTIVE', '人员不在岗');
    return id;
  }

  private async validateOrganizationUnit(organizationUnitId: string) {
    const id = uuid(organizationUnitId, 'organization unit id');
    const organization = await this.options.findOrganizationUnit(id);
    if (!organization) throw new WorkItemError('ORGANIZATION_NOT_FOUND', '组织不存在');
    if (organization.status !== 'active') throw new WorkItemError('ORGANIZATION_INACTIVE', '组织未启用');
    return id;
  }

  private async validateTarget(target: WorkItemTargetReference | null | undefined) {
    if (!target) return null;
    if (!WORK_ITEM_TARGET_TYPES.includes(target.type)) throw new WorkItemError('INVALID_TARGET_TYPE', '工作项目标类型无效');
    const id = uuid(target.id, 'target id');
    if (target.type === 'person') await this.validateOptionalPerson(id);
    else if (target.type === 'organization') await this.validateOrganizationUnit(id);
    else if (target.type === 'location') {
      const location = await this.options.findLocation(id);
      if (!location) throw new WorkItemError('LOCATION_NOT_FOUND', '位置不存在');
      if (location.status !== 'active') throw new WorkItemError('LOCATION_INACTIVE', '位置未启用');
    } else {
      const asset = await this.options.findAsset(id);
      if (!asset) throw new WorkItemError('ASSET_NOT_FOUND', '资产不存在');
      if (asset.lifecycleState === 'retired') throw new WorkItemError('ASSET_RETIRED', '退役资产不能作为新工作项目标');
    }
    return { type: target.type, id, displayName: normalizeOptionalText(target.displayName, 200) };
  }

  private async validateResponsibilityArea(id: string | null | undefined) {
    if (!id) return null;
    const value = uuid(id, 'responsibility area id');
    if (this.options.findResponsibilityArea) {
      const area = await this.options.findResponsibilityArea(value);
      if (!area) throw new WorkItemError('RESPONSIBILITY_AREA_NOT_FOUND', '责任事项不存在');
      if (area.status !== 'active') throw new WorkItemError('RESPONSIBILITY_AREA_INACTIVE', '责任事项未启用');
    }
    return value;
  }

  private async requireExistingWorkItem(id: string) {
    const item = await this.repository.findWorkItemById(uuid(id, 'work item id'));
    if (!item) throw new WorkItemError('WORK_ITEM_NOT_FOUND', '工作项不存在');
    return item;
  }

  private async requireReadableWorkItem(context: PlatformActorContext, id: string) {
    const item = await this.requireExistingWorkItem(id);
    if (!await this.canRead(context, item, await this.repository.listCandidates(item.id))) {
      throw new WorkItemError('WORK_ITEM_ACCESS_DENIED', '无权查看工作项');
    }
    return item;
  }

  private async requireRecurrenceRule(id: string) {
    const rule = await this.repository.findRecurrenceRuleById(uuid(id, 'recurrence rule id'));
    if (!rule) throw new WorkItemError('RECURRENCE_RULE_NOT_FOUND', '周期规则不存在');
    return rule;
  }

  private async detail(item: WorkItem): Promise<WorkItemDetail> {
    return {
      item,
      candidates: await this.repository.listCandidates(item.id),
      assignmentHistory: await this.repository.listAssignmentHistory(item.id),
      progressHistory: await this.repository.listProgressHistory(item.id),
      completion: await this.repository.findCompletionEvidence(item.id),
      operationHistory: await this.repository.listOperationHistory(item.id)
    };
  }

  private async canRead(context: PlatformActorContext, item: WorkItem, candidates: readonly WorkItemCandidate[]) {
    if (!await applicationGrantAllows(context, WORK_ITEM_PERMISSION_CODES.read, await this.resourceForItem(item))) return false;
    if (ownSourceExecution(context, item.sourceAppId)) return true;
    if (context.actorType === 'person') {
      if (item.createdByPersonId === context.person.id) return true;
      if (await this.isDirectParticipant(context.person.id, item, candidates)) return true;
    }
    return (await context.authorize(WORK_ITEM_PERMISSION_CODES.read, await this.resourceForItem(item))).allowed;
  }

  private async isDirectParticipantOrManager(
    context: PlatformActorContext,
    item: WorkItem,
    candidates: readonly WorkItemCandidate[],
    permissionCode: string
  ) {
    if (!await applicationGrantAllows(context, permissionCode, await this.resourceForItem(item))) return false;
    if (context.actorType === 'person' && await this.isDirectParticipant(context.person.id, item, candidates)) return true;
    return (await context.authorize(permissionCode, await this.resourceForItem(item))).allowed;
  }

  private async isDirectParticipant(personId: string, item: WorkItem, candidates: readonly WorkItemCandidate[]) {
    if (item.currentAssigneePersonId === personId) return true;
    if (candidates.some((candidate) => candidate.candidateType === 'person' && candidate.candidateId === personId)) return true;
    for (const candidate of candidates) {
      if (candidate.candidateType !== 'organization_unit') continue;
      const members = await this.options.listActiveOrganizationMembers(candidate.candidateId);
      if (members.some((member) => member.id === personId && member.organizationUnitId === candidate.candidateId && member.employmentStatus === 'active')) return true;
    }
    return false;
  }

  private atomic<T>(operation: () => Promise<T>): Promise<T> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], operation);
  }

  private async requireApplicationGrant(context: PlatformActorContext, permission: string, item: WorkItem) {
    if (!await applicationGrantAllows(context, permission, await this.resourceForItem(item))) {
      throw new WorkItemError('WORK_ITEM_PERMISSION_DENIED', '应用授权不允许访问该工作项');
    }
  }

  private async requireAuthorized(context: PlatformActorContext, permissionCode: string, resource: AuthorizationResource) {
    const decision = await context.authorize(permissionCode, resource);
    if (!decision.allowed) throw new WorkItemError('WORK_ITEM_PERMISSION_DENIED', `缺少权限: ${permissionCode}`);
  }

  private async resourceForDraft(item: Pick<WorkItem, 'target' | 'currentAssigneePersonId' | 'createdByPersonId'>): Promise<AuthorizationResource> {
    return this.resourceForParts(item.target, item.currentAssigneePersonId, item.createdByPersonId);
  }

  private async resourceForItem(item: WorkItem): Promise<AuthorizationResource> {
    return this.resourceForParts(item.target, item.currentAssigneePersonId, item.createdByPersonId);
  }

  private async resourceForRule(rule: WorkItemRecurrenceRule): Promise<AuthorizationResource> {
    return this.resourceForParts(rule.target, rule.currentAssigneePersonId, rule.createdByPersonId);
  }

  private async resourceForParts(target: WorkItemTargetReference | null, assigneePersonId: string | null, creatorPersonId: string | null): Promise<AuthorizationResource> {
    const targets: DataScopeTarget[] = [];
    let ownerPersonId = assigneePersonId ?? creatorPersonId;
    let organizationUnitId: string | null = null;
    if (target?.type === 'person') {
      ownerPersonId = target.id;
      organizationUnitId = (await this.options.findPerson(target.id))?.organizationUnitId ?? null;
    }
    if (assigneePersonId) organizationUnitId = (await this.options.findPerson(assigneePersonId))?.organizationUnitId ?? organizationUnitId;
    if (target?.type === 'organization') {
      organizationUnitId = target.id;
      targets.push({ type: 'organization', id: target.id });
    }
    if (target?.type === 'location') targets.push({ type: 'location', id: target.id });
    if (target?.type === 'asset') targets.push({ type: 'asset', id: target.id });
    return { ownerPersonId, organizationUnitId, targets };
  }

  private async recordAssignment(
    context: PlatformActorContext,
    item: WorkItem,
    action: WorkItemAssignmentAction,
    fromAssigneePersonId: string | null,
    toAssigneePersonId: string | null,
    note: string | null | undefined
  ) {
    await this.repository.addAssignmentHistory({
      id: uuid(this.createId(), 'assignment history id'),
      workItemId: item.id,
      action,
      fromAssigneePersonId,
      toAssigneePersonId,
      actorPersonId: context.actorType === 'person' ? context.person.id : null,
      note: normalizeOptionalText(note, 2000),
      occurredAt: item.updatedAt
    });
  }

  private async recordOperation(
    context: PlatformActorContext,
    item: WorkItem,
    operation: WorkItemOperation,
    before: unknown,
    after: unknown,
    note: string | null | undefined
  ) {
    await this.repository.addOperationHistory({
      id: uuid(this.createId(), 'operation history id'),
      workItemId: item.id,
      operation,
      actorType: context.actorType,
      actorPersonId: context.actorType === 'person' ? context.person.id : null,
      serviceIdentityId: context.actorType === 'service' ? context.execution.serviceIdentityId : null,
      executionType: context.execution.type,
      sourceAppId: context.execution.type === 'platform' ? null : context.execution.appId,
      requestId: context.request.requestId,
      traceId: context.request.traceId,
      note: normalizeOptionalText(note, 2000),
      before: operationPayload(before),
      after: operationPayload(after),
      occurredAt: item.updatedAt
    });
  }

  private async closeBatchIfDone(batchId: string | null) {
    if (!batchId) return;
    const batch = await this.repository.findBatchById(batchId);
    if (!batch || batch.status !== 'open') return;
    const children = await this.repository.listWorkItems({ batchId });
    if (children.length === 0 || children.some((item) => item.status !== 'completed' && item.status !== 'cancelled')) return;
    await this.repository.updateBatch({ ...batch, status: 'closed', updatedAt: this.now().toISOString() });
  }

  private async reopenBatchIfNeeded(batchId: string | null) {
    if (!batchId) return;
    const batch = await this.repository.findBatchById(batchId);
    if (!batch || batch.status !== 'closed') return;
    await this.repository.updateBatch({ ...batch, status: 'open', updatedAt: this.now().toISOString() });
  }

  private returnIdempotent(existing: WorkItem, hash: string) {
    if (existing.idempotencyPayloadHash !== hash) throw new WorkItemError('IDEMPOTENCY_CONFLICT', '相同幂等键的工作项请求内容不同');
    return existing;
  }

  private async emit(context: PlatformActorContext, item: WorkItem, type: string, operation: string, changedFieldsValue: readonly string[]) {
    if (!this.options.outbox) return;
    await enqueueCoreEvent(this.options.outbox, {
      type,
      source: 'platform/work-items',
      payload: {
        workItemId: item.id,
        batchId: item.batchId,
        sourceAppId: item.sourceAppId,
        operation,
        status: item.status,
        actorType: context.actorType,
        actorPersonId: context.actorType === 'person' ? context.person.id : null,
        changedFields: [...changedFieldsValue]
      },
      actorId: context.actorType === 'person' ? context.person.id : context.execution.serviceIdentityId,
      correlationId: context.request.traceId,
      causationId: context.request.requestId
    }, { clock: () => this.now(), createEventId: this.createEventId });
  }

  private async emitRuleEvent(context: PlatformActorContext, rule: WorkItemRecurrenceRule, type: string, skippedOccurrences: number) {
    if (!this.options.outbox) return;
    await enqueueCoreEvent(this.options.outbox, {
      type,
      source: 'platform/work-items',
      payload: {
        recurrenceRuleId: rule.id,
        sourceAppId: rule.sourceAppId,
        skippedOccurrences,
        actorType: context.actorType,
        actorPersonId: context.actorType === 'person' ? context.person.id : null
      },
      actorId: context.actorType === 'person' ? context.person.id : context.execution.serviceIdentityId,
      correlationId: context.request.traceId,
      causationId: context.request.requestId
    }, { clock: () => this.now(), createEventId: this.createEventId });
  }

  private now() {
    const clock = this.options.clock;
    return clock ? (typeof clock === 'function' ? clock() : clock.now()) : new Date();
  }
}

export function createWorkItemService(repository: WorkItemRepository, options: WorkItemServiceOptions) {
  return new WorkItemService(repository, options);
}

export function createWorkItemRecurrenceJob(
  service: Pick<WorkItemService, 'generateDueRecurrences'>,
  resolveActor: () => Promise<PlatformActorContext>,
  options: { id?: string; title?: string; intervalMs?: number; advisoryLockKey?: number } = {}
): CoreJobDefinition {
  return {
    id: options.id ?? 'platform-work-items-recurrence-sweep',
    title: options.title ?? 'Platform WorkItem recurrence sweep',
    intervalMs: options.intervalMs,
    advisoryLockKey: options.advisoryLockKey,
    run: async () => {
      await service.generateDueRecurrences(await resolveActor());
    }
  };
}

export function reconcileLegacyWorkItems(snapshot: import('./model.js').LegacyTodoSnapshot): import('./model.js').LegacyWorkItemReconciliation {
  const taskIds = new Set(snapshot.tasks.map((task) => task.id));
  const issues: import('./model.js').LegacyWorkItemIssue[] = [];
  let completedCount = 0;
  let deepLinkCount = 0;
  for (const item of snapshot.items) {
    if (item.taskId && !taskIds.has(item.taskId)) issues.push({ code: 'MISSING_BATCH', sourceId: item.id });
    if (item.status && !['pending', 'in_progress', 'completed', 'cancelled', 'done'].includes(item.status)) issues.push({ code: 'UNKNOWN_STATUS', sourceId: item.id });
    if (!item.handlerId) issues.push({ code: 'ITEM_WITHOUT_HANDLER', sourceId: item.id });
    if (item.status === 'completed' || item.status === 'done' || item.completedAt) completedCount += 1;
    if (item.deepLink) deepLinkCount += 1;
  }
  for (const template of snapshot.recurringTemplates ?? []) {
    if (template.recurrenceType && !WORK_ITEM_RECURRENCE_TYPES.includes(template.recurrenceType as never)) issues.push({ code: 'INVALID_RECURRENCE_TYPE', sourceId: template.id });
  }
  return {
    taskCount: snapshot.tasks.length,
    itemCount: snapshot.items.length,
    batchCount: snapshot.tasks.length,
    workItemCount: snapshot.items.length,
    recurringTemplateCount: snapshot.recurringTemplates?.length ?? 0,
    completedCount,
    preservedBatchIds: snapshot.tasks.map((task) => task.id),
    preservedWorkItemIds: snapshot.items.map((item) => item.id),
    deepLinkCount,
    issues
  };
}

function selectOccurrences(rule: WorkItemRecurrenceRule, now: Date) {
  const fromExclusive = new Date(rule.lastGeneratedScheduledAt ?? rule.startAt);
  const due = enumerateDueOccurrences(rule.schedule, fromExclusive, now);
  if (due.length === 0) return { toGenerate: [] as Date[], skipped: 0, latestDue: null as Date | null };
  if (rule.missedOccurrencePolicy === 'skip') return { toGenerate: [] as Date[], skipped: due.length, latestDue: due[due.length - 1] };
  if (rule.missedOccurrencePolicy === 'latest_only') return { toGenerate: [due[due.length - 1]], skipped: Math.max(0, due.length - 1), latestDue: due[due.length - 1] };
  const selected = due.slice(0, 31);
  return { toGenerate: selected, skipped: Math.max(0, due.length - selected.length), latestDue: selected[selected.length - 1] };
}

export function enumerateDueOccurrences(schedule: WorkItemRecurrenceSchedule, fromExclusive: Date, untilInclusive: Date): Date[] {
  const result: Date[] = [];
  if (untilInclusive <= fromExclusive) return result;
  let local = startOfPlatformDate(fromExclusive);
  const untilLocal = startOfPlatformDate(untilInclusive);
  let guard = 0;
  while (compareLocalDate(local, untilLocal) <= 0) {
    const scheduled = scheduledInstantForDate(schedule, local);
    if (scheduled && scheduled > fromExclusive && scheduled <= untilInclusive) result.push(scheduled);
    local = addLocalDays(local, 1);
    guard += 1;
    if (guard > 3660) throw new WorkItemError('RECURRENCE_RANGE_TOO_LARGE', '周期生成范围超过十年，请先压缩补偿窗口');
  }
  return result;
}

function scheduledInstantForDate(schedule: WorkItemRecurrenceSchedule, date: { year: number; month: number; day: number }) {
  const triggerMinuteOfDay = schedule.triggerMinuteOfDay;
  const hour = Math.floor(triggerMinuteOfDay / 60);
  const minute = triggerMinuteOfDay % 60;
  if (schedule.type === 'daily') return toPlatformInstant({ ...date, hour, minute });
  const weekday = isoWeekday(date.year, date.month, date.day);
  if (schedule.type === 'weekly') return schedule.weekdays.includes(weekday) ? toPlatformInstant({ ...date, hour, minute }) : null;
  const dayOfMonth = schedule.dayOfMonth === 'last_day' ? daysInMonth(date.year, date.month) : schedule.dayOfMonth;
  if (date.day !== dayOfMonth || dayOfMonth > daysInMonth(date.year, date.month)) return null;
  return toPlatformInstant({ ...date, hour, minute });
}

function startOfPlatformDate(instant: Date) {
  const local = getPlatformDateTime(instant);
  return { year: local.year, month: local.month, day: local.day };
}

function addLocalDays(date: { year: number; month: number; day: number }, days: number) {
  let year = date.year;
  let month = date.month;
  let day = date.day + days;
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return { year, month, day };
}

function compareLocalDate(left: { year: number; month: number; day: number }, right: { year: number; month: number; day: number }) {
  return left.year - right.year || left.month - right.month || left.day - right.day;
}

function normalizeSource(source: CreateWorkItemInput['source']) {
  return {
    appId: stableCode(source.appId, 'source app id'),
    entityType: stableCode(source.entityType, 'source entity type'),
    entityId: requiredText(source.entityId, 'source entity id', 200)
  };
}

function normalizeDisplay(display: WorkItemDisplaySnapshot): WorkItemDisplaySnapshot {
  return {
    title: requiredText(display.title, 'work item title', 200),
    summary: normalizeOptionalText(display.summary, 2000),
    sourceLabel: normalizeOptionalText(display.sourceLabel, 100)
  };
}

function normalizeNavigation(navigation: WorkItemNavigationReference | null | undefined): WorkItemNavigationReference | null {
  if (!navigation) return null;
  const params = Object.fromEntries(Object.entries(navigation.params ?? {}).map(([key, value]) => [stableCode(key, 'navigation param key'), requiredText(value, 'navigation param value', 500)]));
  return {
    href: normalizeOptionalText(navigation.href, 1000),
    routeName: normalizeOptionalText(navigation.routeName, 150),
    params
  };
}

function normalizeSchedule(schedule: WorkItemRecurrenceSchedule): WorkItemRecurrenceSchedule {
  if (!WORK_ITEM_RECURRENCE_TYPES.includes(schedule.type)) throw new WorkItemError('INVALID_RECURRENCE_TYPE', '周期类型无效');
  const triggerMinuteOfDay = minuteOfDay(schedule.triggerMinuteOfDay);
  if (schedule.type === 'daily') return { type: 'daily', triggerMinuteOfDay };
  if (schedule.type === 'weekly') {
    const weekdays = [...new Set(schedule.weekdays)].map(weekday);
    if (weekdays.length === 0) throw new WorkItemError('WEEKDAY_REQUIRED', '周周期必须指定星期');
    return { type: 'weekly', weekdays, triggerMinuteOfDay };
  }
  if (schedule.dayOfMonth !== 'last_day' && (!Number.isSafeInteger(schedule.dayOfMonth) || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) {
    throw new WorkItemError('INVALID_MONTH_DAY', '月周期日期必须为 1 到 31 或 last_day');
  }
  return { type: 'monthly', dayOfMonth: schedule.dayOfMonth, triggerMinuteOfDay };
}

function missedPolicy(value: string) {
  if (!WORK_ITEM_MISSED_OCCURRENCE_POLICIES.includes(value as never)) throw new WorkItemError('INVALID_MISSED_POLICY', '补偿策略无效');
  return value as WorkItemRecurrenceRule['missedOccurrencePolicy'];
}

function priority(value: string) {
  if (!WORK_ITEM_PRIORITIES.includes(value as never)) throw new WorkItemError('INVALID_PRIORITY', '优先级无效');
  return value as WorkItem['priority'];
}

function normalizeDueAfter(value: number | null) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new WorkItemError('INVALID_DUE_AFTER', '周期截止偏移必须为非负整数分钟');
  return value;
}

function normalizeProgressPercent(value: number | null) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new WorkItemError('INVALID_PROGRESS_PERCENT', '进度必须为 0 到 100 的整数');
  return value;
}

function normalizeListInput(input: WorkItemListInput): WorkItemListInput {
  const rawStatus = input.status;
  const normalizedStatus = Array.isArray(rawStatus)
    ? rawStatus.map((item) => status(item))
    : typeof rawStatus === 'string' ? status(rawStatus) : undefined;
  return {
    ...input,
    batchId: input.batchId ? uuid(input.batchId, 'batch id') : undefined,
    sourceAppId: input.sourceAppId ? stableCode(input.sourceAppId, 'source app id') : undefined,
    candidatePersonId: input.candidatePersonId ? uuid(input.candidatePersonId, 'candidate person id') : undefined,
    candidateOrganizationUnitId: input.candidateOrganizationUnitId ? uuid(input.candidateOrganizationUnitId, 'candidate organization id') : undefined,
    currentAssigneePersonId: input.currentAssigneePersonId ? uuid(input.currentAssigneePersonId, 'assignee person id') : undefined,
    target: input.target ? { type: input.target.type, id: uuid(input.target.id, 'target id') } : undefined,
    status: normalizedStatus
  };
}

function status(value: string) {
  if (!WORK_ITEM_STATUSES.includes(value as never)) throw new WorkItemError('INVALID_STATUS', '工作项状态无效');
  return value as WorkItem['status'];
}

function minuteOfDay(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1439) throw new WorkItemError('INVALID_TRIGGER_MINUTE', '触发分钟必须为 0 到 1439');
  return value;
}

function weekday(value: number): PlatformIsoWeekday {
  if (!Number.isSafeInteger(value) || value < 1 || value > 7) throw new WorkItemError('INVALID_WEEKDAY', '星期必须为 1 到 7 的 ISO 星期');
  return value as PlatformIsoWeekday;
}

function daysInMonth(year: number, month: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCDate();
}

function isoWeekday(year: number, month: number, day: number): PlatformIsoWeekday {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  const value = date.getUTCDay();
  return (value === 0 ? 7 : value) as PlatformIsoWeekday;
}

function assertEditable(item: WorkItem) {
  if (item.status === 'completed' || item.status === 'cancelled') {
    throw new WorkItemError('WORK_ITEM_NOT_EDITABLE', '已完成或已取消工作项不能直接修改，请先重新打开');
  }
}

function assertExecutionSource(context: PlatformActorContext, sourceAppId: string) {
  if (context.execution.type !== 'platform' && context.execution.appId !== sourceAppId) {
    throw new WorkItemError('SOURCE_APP_MISMATCH', '应用或服务执行只能创建自己来源的工作项');
  }
}

function ownSourceExecution(context: PlatformActorContext, sourceAppId: string) {
  return context.execution.type !== 'platform' && context.execution.appId === sourceAppId;
}

function changedFields(before: WorkItem, after: WorkItem) {
  const keys: Array<keyof WorkItem> = ['status', 'priority', 'display', 'navigation', 'responsibilityAreaId', 'target', 'currentAssigneePersonId', 'dueAt'];
  return keys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(String);
}

function operationPayload(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }
  return { value };
}

function normalizeCreateInputForHash(input: CreateWorkItemInput) {
  return normalizePayload({
    batchId: input.batchId ?? null,
    source: normalizeSource(input.source),
    display: normalizeDisplay(input.display),
    navigation: normalizeNavigation(input.navigation),
    priority: input.priority ?? 'normal',
    responsibilityAreaId: input.responsibilityAreaId ?? null,
    target: input.target ?? null,
    candidates: input.candidates ?? [],
    currentAssigneePersonId: input.currentAssigneePersonId ?? null,
    dueAt: input.dueAt?.toISOString() ?? null
  });
}

function payloadHash(value: unknown) {
  return createHash('sha256').update(stableStringify(normalizePayload(value))).digest('hex');
}

function normalizePayload(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, normalizePayload(item)]));
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function stableCode(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized) || normalized.length > 100) throw new WorkItemError('INVALID_CODE', `${label} 必须是稳定编码`);
  return normalized;
}

function requiredText(value: string, label: string, max: number) {
  const text = value.trim();
  if (!text || text.length > max) throw new WorkItemError('INVALID_TEXT', `${label} 无效`);
  return text;
}

function normalizeOptionalText(value: string | null | undefined, max: number) {
  if (value == null) return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new WorkItemError('INVALID_TEXT', '文本过长');
  return text;
}

function uuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) throw new WorkItemError('INVALID_ID', `${label} 必须是 UUID`);
  return normalized;
}
