import { runDatabaseTransaction, type AtomicParticipant, type QueryableClient } from '../../core/database/index.js';
import {
  WorkItemError,
  type WorkItem,
  type WorkItemAssignmentHistory,
  type WorkItemBatch,
  type WorkItemCandidate,
  type WorkItemCompletionEvidence,
  type WorkItemListInput,
  type WorkItemOperationHistory,
  type WorkItemProgressHistory,
  type WorkItemRecurrenceRule,
  type WorkItemTargetType
} from './model.js';

export interface WorkItemRepository extends AtomicParticipant {
  createBatch(record: WorkItemBatch): Promise<WorkItemBatch>;
  updateBatch(record: WorkItemBatch): Promise<WorkItemBatch>;
  findBatchById(id: string): Promise<WorkItemBatch | null>;
  findBatchByIdempotencyKey(sourceAppId: string, idempotencyKey: string): Promise<WorkItemBatch | null>;

  createWorkItem(record: WorkItem, candidates: readonly WorkItemCandidate[]): Promise<WorkItem>;
  updateWorkItem(record: WorkItem): Promise<WorkItem>;
  replaceCandidates(workItemId: string, candidates: readonly WorkItemCandidate[]): Promise<void>;
  findWorkItemById(id: string): Promise<WorkItem | null>;
  findWorkItemByIdempotencyKey(sourceAppId: string, scope: string, idempotencyKey: string): Promise<WorkItem | null>;
  findWorkItemByOccurrence(ruleId: string, occurrenceKey: string): Promise<WorkItem | null>;
  listWorkItems(input?: WorkItemListInput): Promise<WorkItem[]>;
  listCandidates(workItemId: string): Promise<WorkItemCandidate[]>;

  addAssignmentHistory(record: WorkItemAssignmentHistory): Promise<WorkItemAssignmentHistory>;
  addProgressHistory(record: WorkItemProgressHistory): Promise<WorkItemProgressHistory>;
  addCompletionEvidence(record: WorkItemCompletionEvidence): Promise<WorkItemCompletionEvidence>;
  clearCompletionEvidence(workItemId: string): Promise<void>;
  addOperationHistory(record: WorkItemOperationHistory): Promise<WorkItemOperationHistory>;
  listAssignmentHistory(workItemId: string): Promise<WorkItemAssignmentHistory[]>;
  listProgressHistory(workItemId: string): Promise<WorkItemProgressHistory[]>;
  findCompletionEvidence(workItemId: string): Promise<WorkItemCompletionEvidence | null>;
  listOperationHistory(workItemId: string): Promise<WorkItemOperationHistory[]>;

  createRecurrenceRule(record: WorkItemRecurrenceRule): Promise<WorkItemRecurrenceRule>;
  updateRecurrenceRule(record: WorkItemRecurrenceRule): Promise<WorkItemRecurrenceRule>;
  findRecurrenceRuleById(id: string): Promise<WorkItemRecurrenceRule | null>;
  findRecurrenceRuleByIdempotencyKey(sourceAppId: string, idempotencyKey: string): Promise<WorkItemRecurrenceRule | null>;
  listActiveRecurrenceRules(limit?: number, afterId?: string): Promise<WorkItemRecurrenceRule[]>;
}

export interface MemoryWorkItemRepository extends WorkItemRepository {
  records(): {
    batches: WorkItemBatch[];
    items: WorkItem[];
    candidates: WorkItemCandidate[];
    assignmentHistory: WorkItemAssignmentHistory[];
    progressHistory: WorkItemProgressHistory[];
    completionEvidence: WorkItemCompletionEvidence[];
    operationHistory: WorkItemOperationHistory[];
    recurrenceRules: WorkItemRecurrenceRule[];
  };
}

export function createMemoryWorkItemRepository(seed: {
  batches?: readonly WorkItemBatch[];
  items?: readonly WorkItem[];
  candidates?: readonly WorkItemCandidate[];
  assignmentHistory?: readonly WorkItemAssignmentHistory[];
  progressHistory?: readonly WorkItemProgressHistory[];
  completionEvidence?: readonly WorkItemCompletionEvidence[];
  operationHistory?: readonly WorkItemOperationHistory[];
  recurrenceRules?: readonly WorkItemRecurrenceRule[];
} = {}): MemoryWorkItemRepository {
  const batches = toMap(seed.batches);
  const items = toMap(seed.items);
  let candidates = (seed.candidates ?? []).map(clone);
  const assignmentHistory = toMap(seed.assignmentHistory);
  const progressHistory = toMap(seed.progressHistory);
  const completionEvidence = toMap(seed.completionEvidence);
  const operationHistory = toMap(seed.operationHistory);
  const recurrenceRules = toMap(seed.recurrenceRules);

  return {
    atomic: { snapshot() {
      const restoreMaps = [snapshotMap(batches), snapshotMap(items), snapshotMap(assignmentHistory), snapshotMap(progressHistory), snapshotMap(completionEvidence), snapshotMap(operationHistory), snapshotMap(recurrenceRules)];
      const savedCandidates = structuredClone(candidates);
      return () => { for (const restore of restoreMaps) restore(); candidates = savedCandidates; };
    } },
    async createBatch(record) {
      assertUniqueId(batches, record.id);
      assertBatchIdempotency(batches, record);
      batches.set(record.id, clone(record));
      return clone(record);
    },
    async updateBatch(record) {
      if (!batches.has(record.id)) throw new WorkItemError('BATCH_NOT_FOUND', '工作项批次不存在');
      batches.set(record.id, clone(record));
      return clone(record);
    },
    async findBatchById(id) {
      return cloneOrNull(batches.get(id));
    },
    async findBatchByIdempotencyKey(sourceAppId, idempotencyKey) {
      return cloneOrNull([...batches.values()].find((item) => item.sourceAppId === sourceAppId && item.idempotencyKey === idempotencyKey));
    },
    async createWorkItem(record, itemCandidates) {
      assertUniqueId(items, record.id);
      assertWorkItemIdempotency(items, record);
      assertWorkItemOccurrence(items, record);
      items.set(record.id, clone(record));
      candidates = candidates.filter((candidate) => candidate.workItemId !== record.id);
      candidates.push(...itemCandidates.map(clone));
      return clone(record);
    },
    async updateWorkItem(record) {
      if (!items.has(record.id)) throw new WorkItemError('WORK_ITEM_NOT_FOUND', '工作项不存在');
      items.set(record.id, clone(record));
      return clone(record);
    },
    async replaceCandidates(workItemId, itemCandidates) {
      candidates = candidates.filter((candidate) => candidate.workItemId !== workItemId);
      candidates.push(...itemCandidates.map(clone));
    },
    async findWorkItemById(id) {
      return cloneOrNull(items.get(id));
    },
    async findWorkItemByIdempotencyKey(sourceAppId, scope, idempotencyKey) {
      return cloneOrNull([...items.values()].find((item) => item.sourceAppId === sourceAppId && item.idempotencyKey === idempotencyKey && scope === 'work_item'));
    },
    async findWorkItemByOccurrence(ruleId, occurrenceKey) {
      return cloneOrNull([...items.values()].find((item) => item.recurrenceRuleId === ruleId && item.recurrenceOccurrenceKey === occurrenceKey));
    },
    async listWorkItems(input = {}) {
      return [...items.values()]
        .filter((item) => matchesListFilter(item, candidates, input))
        .map(clone)
        .sort(compareWorkItems);
    },
    async listCandidates(workItemId) {
      return candidates.filter((candidate) => candidate.workItemId === workItemId).map(clone).sort(compareCandidates);
    },
    async addAssignmentHistory(record) {
      assertUniqueId(assignmentHistory, record.id);
      assignmentHistory.set(record.id, clone(record));
      return clone(record);
    },
    async addProgressHistory(record) {
      assertUniqueId(progressHistory, record.id);
      progressHistory.set(record.id, clone(record));
      return clone(record);
    },
    async addCompletionEvidence(record) {
      assertUniqueId(completionEvidence, record.id);
      for (const [id, item] of completionEvidence) {
        if (item.workItemId === record.workItemId) {
          completionEvidence.delete(id);
        }
      }
      completionEvidence.set(record.id, clone(record));
      return clone(record);
    },
    async clearCompletionEvidence(workItemId) {
      for (const [id, evidence] of completionEvidence) {
        if (evidence.workItemId === workItemId) completionEvidence.delete(id);
      }
    },
    async addOperationHistory(record) {
      assertUniqueId(operationHistory, record.id);
      operationHistory.set(record.id, clone(record));
      return clone(record);
    },
    async listAssignmentHistory(workItemId) {
      return [...assignmentHistory.values()].filter((item) => item.workItemId === workItemId).map(clone).sort(compareOccurredAt);
    },
    async listProgressHistory(workItemId) {
      return [...progressHistory.values()].filter((item) => item.workItemId === workItemId).map(clone).sort(compareOccurredAt);
    },
    async findCompletionEvidence(workItemId) {
      return cloneOrNull([...completionEvidence.values()].find((item) => item.workItemId === workItemId));
    },
    async listOperationHistory(workItemId) {
      return [...operationHistory.values()].filter((item) => item.workItemId === workItemId).map(clone).sort(compareOccurredAt);
    },
    async createRecurrenceRule(record) {
      assertUniqueId(recurrenceRules, record.id);
      assertRecurrenceIdempotency(recurrenceRules, record);
      recurrenceRules.set(record.id, clone(record));
      return clone(record);
    },
    async updateRecurrenceRule(record) {
      if (!recurrenceRules.has(record.id)) throw new WorkItemError('RECURRENCE_RULE_NOT_FOUND', '周期规则不存在');
      recurrenceRules.set(record.id, clone(record));
      return clone(record);
    },
    async findRecurrenceRuleById(id) {
      return cloneOrNull(recurrenceRules.get(id));
    },
    async findRecurrenceRuleByIdempotencyKey(sourceAppId, idempotencyKey) {
      return cloneOrNull([...recurrenceRules.values()].find((rule) => rule.sourceAppId === sourceAppId && rule.idempotencyKey === idempotencyKey));
    },
    async listActiveRecurrenceRules(limit = 100, afterId = '') {
      return [...recurrenceRules.values()]
        .filter((rule) => rule.status === 'active' && rule.id > afterId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone);
    },
    records() {
      return {
        batches: [...batches.values()].map(clone),
        items: [...items.values()].map(clone),
        candidates: candidates.map(clone),
        assignmentHistory: [...assignmentHistory.values()].map(clone),
        progressHistory: [...progressHistory.values()].map(clone),
        completionEvidence: [...completionEvidence.values()].map(clone),
        operationHistory: [...operationHistory.values()].map(clone),
        recurrenceRules: [...recurrenceRules.values()].map(clone)
      };
    }
  };
}

export function createPostgresWorkItemRepository(client: QueryableClient): WorkItemRepository {
  return {
    atomic: { client },
    async createBatch(record) {
      return mapBatch(requireRow(await client.query(
        `INSERT INTO platform_work_item_batches
         (id,source_app_id,source_entity_type,source_entity_id,idempotency_key,idempotency_payload_hash,status,display_snapshot,navigation_ref,default_due_at,created_by_person_id,created_by_actor_type,created_at,updated_at,cancelled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [record.id, record.sourceAppId, record.sourceEntityType, record.sourceEntityId, record.idempotencyKey, record.idempotencyPayloadHash, record.status, JSON.stringify(record.display), jsonOrNull(record.navigation), record.defaultDueAt, record.createdByPersonId, record.createdByActorType, record.createdAt, record.updatedAt, record.cancelledAt]
      )));
    },
    async updateBatch(record) {
      return mapBatch(requireRow(await client.query(
        `UPDATE platform_work_item_batches
         SET status=$2,display_snapshot=$3::jsonb,navigation_ref=$4::jsonb,default_due_at=$5,updated_at=$6,cancelled_at=$7
         WHERE id=$1 RETURNING *`,
        [record.id, record.status, JSON.stringify(record.display), jsonOrNull(record.navigation), record.defaultDueAt, record.updatedAt, record.cancelledAt]
      )));
    },
    async findBatchById(id) {
      return optional(await client.query('SELECT * FROM platform_work_item_batches WHERE id=$1 FOR UPDATE', [id]), mapBatch);
    },
    async findBatchByIdempotencyKey(sourceAppId, idempotencyKey) {
      await lockIdempotency(client, 'batch', sourceAppId, idempotencyKey);
      return optional(await client.query('SELECT * FROM platform_work_item_batches WHERE source_app_id=$1 AND idempotency_key=$2', [sourceAppId, idempotencyKey]), mapBatch);
    },
    async createWorkItem(record, candidates) {
      return runDatabaseTransaction(client, async (transaction) => {
        const saved = await insertWorkItem(transaction, record);
        for (const candidate of candidates) await insertCandidate(transaction, candidate);
        return saved;
      });
    },
    async updateWorkItem(record) {
      return mapWorkItem(requireRow(await client.query(
        `UPDATE platform_work_items
         SET status=$2,priority=$3,display_snapshot=$4::jsonb,navigation_ref=$5::jsonb,responsibility_area_id=$6,
             target_entity_type=$7,target_entity_id=$8,target_display_name=$9,current_assignee_person_id=$10,due_at=$11,
             updated_at=$12,completed_at=$13,cancelled_at=$14
         WHERE id=$1 RETURNING *`,
        [record.id, record.status, record.priority, JSON.stringify(record.display), jsonOrNull(record.navigation), record.responsibilityAreaId, record.target?.type ?? null, record.target?.id ?? null, record.target?.displayName ?? null, record.currentAssigneePersonId, record.dueAt, record.updatedAt, record.completedAt, record.cancelledAt]
      )));
    },
    async replaceCandidates(workItemId, candidates) {
      await runDatabaseTransaction(client, async (transaction) => {
        await transaction.query('DELETE FROM platform_work_item_candidates WHERE work_item_id=$1', [workItemId]);
        for (const candidate of candidates) await insertCandidate(transaction, candidate);
      });
    },
    async findWorkItemById(id) {
      return optional(await client.query('SELECT * FROM platform_work_items WHERE id=$1 FOR UPDATE', [id]), mapWorkItem);
    },
    async findWorkItemByIdempotencyKey(sourceAppId, scope, idempotencyKey) {
      await lockIdempotency(client, scope, sourceAppId, idempotencyKey);
      return optional(await client.query(
        'SELECT * FROM platform_work_items WHERE source_app_id=$1 AND idempotency_scope=$2 AND idempotency_key=$3 FOR UPDATE',
        [sourceAppId, scope, idempotencyKey]
      ), mapWorkItem);
    },
    async findWorkItemByOccurrence(ruleId, occurrenceKey) {
      return optional(await client.query(
        'SELECT * FROM platform_work_items WHERE recurrence_rule_id=$1 AND recurrence_occurrence_key=$2',
        [ruleId, occurrenceKey]
      ), mapWorkItem);
    },
    async listWorkItems(input = {}) {
      const { where, values } = buildListWhere(input);
      return rows(await client.query(`SELECT * FROM platform_work_items ${where} ORDER BY updated_at DESC, id`, values)).map(mapWorkItem);
    },
    async listCandidates(workItemId) {
      return rows(await client.query('SELECT * FROM platform_work_item_candidates WHERE work_item_id=$1 ORDER BY candidate_type,candidate_id', [workItemId])).map(mapCandidate);
    },
    async addAssignmentHistory(record) {
      return mapAssignment(requireRow(await client.query(
        `INSERT INTO platform_work_item_assignment_history
         (id,work_item_id,action,from_assignee_person_id,to_assignee_person_id,actor_person_id,note,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [record.id, record.workItemId, record.action, record.fromAssigneePersonId, record.toAssigneePersonId, record.actorPersonId, record.note, record.occurredAt]
      )));
    },
    async addProgressHistory(record) {
      return mapProgress(requireRow(await client.query(
        `INSERT INTO platform_work_item_progress_history
         (id,work_item_id,progress_percent,note,updater_person_id,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [record.id, record.workItemId, record.progressPercent, record.note, record.updaterPersonId, record.occurredAt]
      )));
    },
    async addCompletionEvidence(record) {
      return mapCompletion(requireRow(await client.query(
        `INSERT INTO platform_work_item_completion_evidence
         (id,work_item_id,assigned_person_id,actual_completer_person_id,on_behalf_of_person_id,on_behalf,note,completed_at,source_app_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (work_item_id) DO UPDATE SET
           id=EXCLUDED.id,
           assigned_person_id=EXCLUDED.assigned_person_id,
           actual_completer_person_id=EXCLUDED.actual_completer_person_id,
           on_behalf_of_person_id=EXCLUDED.on_behalf_of_person_id,
           on_behalf=EXCLUDED.on_behalf,
           note=EXCLUDED.note,
           completed_at=EXCLUDED.completed_at,
           source_app_id=EXCLUDED.source_app_id
         RETURNING *`,
        [record.id, record.workItemId, record.assignedPersonId, record.actualCompleterPersonId, record.onBehalfOfPersonId, record.onBehalf, record.note, record.completedAt, record.sourceAppId]
      )));
    },
    async clearCompletionEvidence(workItemId) {
      await client.query('DELETE FROM platform_work_item_completion_evidence WHERE work_item_id=$1', [workItemId]);
    },
    async addOperationHistory(record) {
      return mapOperation(requireRow(await client.query(
        `INSERT INTO platform_work_item_operation_history
         (id,work_item_id,operation,actor_type,actor_person_id,service_identity_id,execution_type,source_app_id,request_id,trace_id,note,before_payload,after_payload,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14) RETURNING *`,
        [record.id, record.workItemId, record.operation, record.actorType, record.actorPersonId, record.serviceIdentityId, record.executionType, record.sourceAppId, record.requestId, record.traceId, record.note, jsonOrNull(record.before), jsonOrNull(record.after), record.occurredAt]
      )));
    },
    async listAssignmentHistory(workItemId) {
      return rows(await client.query('SELECT * FROM platform_work_item_assignment_history WHERE work_item_id=$1 ORDER BY occurred_at,id', [workItemId])).map(mapAssignment);
    },
    async listProgressHistory(workItemId) {
      return rows(await client.query('SELECT * FROM platform_work_item_progress_history WHERE work_item_id=$1 ORDER BY occurred_at,id', [workItemId])).map(mapProgress);
    },
    async findCompletionEvidence(workItemId) {
      return optional(await client.query('SELECT * FROM platform_work_item_completion_evidence WHERE work_item_id=$1', [workItemId]), mapCompletion);
    },
    async listOperationHistory(workItemId) {
      return rows(await client.query('SELECT * FROM platform_work_item_operation_history WHERE work_item_id=$1 ORDER BY occurred_at,id', [workItemId])).map(mapOperation);
    },
    async createRecurrenceRule(record) {
      return mapRecurrenceRule(requireRow(await client.query(
        `INSERT INTO platform_work_item_recurrence_rules
         (id,source_app_id,source_entity_type,source_entity_id,status,schedule,missed_occurrence_policy,due_after_minutes,priority,display_snapshot,navigation_ref,responsibility_area_id,target_entity_type,target_entity_id,target_display_name,candidates,current_assignee_person_id,start_at,last_generated_scheduled_at,disabled_at,idempotency_key,idempotency_payload_hash,created_by_person_id,created_by_actor_type,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
        [record.id, record.sourceAppId, record.sourceEntityType, record.sourceEntityId, record.status, JSON.stringify(record.schedule), record.missedOccurrencePolicy, record.dueAfterMinutes, record.priority, JSON.stringify(record.display), jsonOrNull(record.navigation), record.responsibilityAreaId, record.target?.type ?? null, record.target?.id ?? null, record.target?.displayName ?? null, JSON.stringify(record.candidates), record.currentAssigneePersonId, record.startAt, record.lastGeneratedScheduledAt, record.disabledAt, record.idempotencyKey, record.idempotencyPayloadHash, record.createdByPersonId, record.createdByActorType, record.createdAt, record.updatedAt]
      )));
    },
    async updateRecurrenceRule(record) {
      return mapRecurrenceRule(requireRow(await client.query(
        `UPDATE platform_work_item_recurrence_rules
         SET status=$2,schedule=$3::jsonb,missed_occurrence_policy=$4,due_after_minutes=$5,priority=$6,
             display_snapshot=$7::jsonb,navigation_ref=$8::jsonb,responsibility_area_id=$9,target_entity_type=$10,
             target_entity_id=$11,target_display_name=$12,candidates=$13::jsonb,current_assignee_person_id=$14,
             last_generated_scheduled_at=$15,disabled_at=$16,updated_at=$17
         WHERE id=$1 RETURNING *`,
        [record.id, record.status, JSON.stringify(record.schedule), record.missedOccurrencePolicy, record.dueAfterMinutes, record.priority, JSON.stringify(record.display), jsonOrNull(record.navigation), record.responsibilityAreaId, record.target?.type ?? null, record.target?.id ?? null, record.target?.displayName ?? null, JSON.stringify(record.candidates), record.currentAssigneePersonId, record.lastGeneratedScheduledAt, record.disabledAt, record.updatedAt]
      )));
    },
    async findRecurrenceRuleById(id) {
      return optional(await client.query('SELECT * FROM platform_work_item_recurrence_rules WHERE id=$1 FOR UPDATE', [id]), mapRecurrenceRule);
    },
    async findRecurrenceRuleByIdempotencyKey(sourceAppId, idempotencyKey) {
      await lockIdempotency(client, 'recurrence', sourceAppId, idempotencyKey);
      return optional(await client.query('SELECT * FROM platform_work_item_recurrence_rules WHERE source_app_id=$1 AND idempotency_key=$2', [sourceAppId, idempotencyKey]), mapRecurrenceRule);
    },
    async listActiveRecurrenceRules(limit = 100, afterId = '') {
      return rows(await client.query(
        `SELECT * FROM platform_work_item_recurrence_rules
         WHERE status='active' AND id::text > $2
         ORDER BY id
         LIMIT $1 FOR UPDATE`,
        [limit, afterId]
      )).map(mapRecurrenceRule);
    }
  };
}

async function lockIdempotency(client: QueryableClient, scope: string, sourceAppId: string, key: string) {
  // Transaction-scoped; serializes only competing requests for the same source/key, never replays writes.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['platform.work_items', scope, sourceAppId, key])]);
}

async function insertWorkItem(client: QueryableClient, record: WorkItem) {
  return mapWorkItem(requireRow(await client.query(
    `INSERT INTO platform_work_items
     (id,batch_id,source_app_id,source_entity_type,source_entity_id,idempotency_key,idempotency_payload_hash,idempotency_scope,recurrence_rule_id,recurrence_occurrence_key,recurrence_scheduled_at,status,priority,display_snapshot,navigation_ref,responsibility_area_id,target_entity_type,target_entity_id,target_display_name,current_assignee_person_id,due_at,created_by_person_id,created_by_actor_type,created_at,updated_at,completed_at,cancelled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'work_item',$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING *`,
    [record.id, record.batchId, record.sourceAppId, record.sourceEntityType, record.sourceEntityId, record.idempotencyKey, record.idempotencyPayloadHash, record.recurrenceRuleId, record.recurrenceOccurrenceKey, record.recurrenceScheduledAt, record.status, record.priority, JSON.stringify(record.display), jsonOrNull(record.navigation), record.responsibilityAreaId, record.target?.type ?? null, record.target?.id ?? null, record.target?.displayName ?? null, record.currentAssigneePersonId, record.dueAt, record.createdByPersonId, record.createdByActorType, record.createdAt, record.updatedAt, record.completedAt, record.cancelledAt]
  )));
}

async function insertCandidate(client: QueryableClient, record: WorkItemCandidate) {
  await client.query(
    `INSERT INTO platform_work_item_candidates (id,work_item_id,candidate_type,candidate_id,created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [record.id, record.workItemId, record.candidateType, record.candidateId, record.createdAt]
  );
}

function buildListWhere(input: WorkItemListInput) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace('?', `$${values.length}`));
  };
  if (input.batchId) add('batch_id=?', input.batchId);
  if (input.sourceAppId) add('source_app_id=?', input.sourceAppId);
  if (input.currentAssigneePersonId) add('current_assignee_person_id=?', input.currentAssigneePersonId);
  if (input.target) {
    add('target_entity_type=?', input.target.type);
    add('target_entity_id=?', input.target.id);
  }
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    values.push(statuses);
    clauses.push(`status = ANY($${values.length}::text[])`);
  }
  if (input.candidatePersonId) {
    values.push(input.candidatePersonId);
    clauses.push(`EXISTS (SELECT 1 FROM platform_work_item_candidates c WHERE c.work_item_id=platform_work_items.id AND c.candidate_type='person' AND c.candidate_id=$${values.length})`);
  }
  if (input.candidateOrganizationUnitId) {
    values.push(input.candidateOrganizationUnitId);
    clauses.push(`EXISTS (SELECT 1 FROM platform_work_item_candidates c WHERE c.work_item_id=platform_work_items.id AND c.candidate_type='organization_unit' AND c.candidate_id=$${values.length})`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function matchesListFilter(item: WorkItem, candidates: readonly WorkItemCandidate[], input: WorkItemListInput) {
  if (input.batchId && item.batchId !== input.batchId) return false;
  if (input.sourceAppId && item.sourceAppId !== input.sourceAppId) return false;
  if (input.currentAssigneePersonId && item.currentAssigneePersonId !== input.currentAssigneePersonId) return false;
  if (input.target && (item.target?.type !== input.target.type || item.target.id !== input.target.id)) return false;
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    if (!statuses.includes(item.status)) return false;
  }
  if (input.candidatePersonId && !candidates.some((candidate) => candidate.workItemId === item.id && candidate.candidateType === 'person' && candidate.candidateId === input.candidatePersonId)) return false;
  if (input.candidateOrganizationUnitId && !candidates.some((candidate) => candidate.workItemId === item.id && candidate.candidateType === 'organization_unit' && candidate.candidateId === input.candidateOrganizationUnitId)) return false;
  return true;
}

function assertUniqueId<T>(records: Map<string, T>, id: string) {
  if (records.has(id)) throw new WorkItemError('DUPLICATE_ID', `工作项 ID 已存在: ${id}`);
}

function assertBatchIdempotency(records: Map<string, WorkItemBatch>, record: WorkItemBatch) {
  if (!record.idempotencyKey) return;
  const existing = [...records.values()].find((item) => item.sourceAppId === record.sourceAppId && item.idempotencyKey === record.idempotencyKey);
  if (existing) throw new WorkItemError('IDEMPOTENCY_CONFLICT', '批次幂等键已存在');
}

function assertWorkItemIdempotency(records: Map<string, WorkItem>, record: WorkItem) {
  if (!record.idempotencyKey) return;
  const existing = [...records.values()].find((item) => item.sourceAppId === record.sourceAppId && item.idempotencyKey === record.idempotencyKey);
  if (existing) throw new WorkItemError('IDEMPOTENCY_CONFLICT', '工作项幂等键已存在');
}

function assertWorkItemOccurrence(records: Map<string, WorkItem>, record: WorkItem) {
  if (!record.recurrenceRuleId || !record.recurrenceOccurrenceKey) return;
  const existing = [...records.values()].find((item) => item.recurrenceRuleId === record.recurrenceRuleId && item.recurrenceOccurrenceKey === record.recurrenceOccurrenceKey);
  if (existing) throw new WorkItemError('DUPLICATE_RECURRENCE_OCCURRENCE', '周期工作项已生成');
}

function assertRecurrenceIdempotency(records: Map<string, WorkItemRecurrenceRule>, record: WorkItemRecurrenceRule) {
  if (!record.idempotencyKey) return;
  const existing = [...records.values()].find((item) => item.sourceAppId === record.sourceAppId && item.idempotencyKey === record.idempotencyKey);
  if (existing) throw new WorkItemError('IDEMPOTENCY_CONFLICT', '周期规则幂等键已存在');
}

function compareWorkItems(left: WorkItem, right: WorkItem) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function compareCandidates(left: WorkItemCandidate, right: WorkItemCandidate) {
  return left.candidateType.localeCompare(right.candidateType) || left.candidateId.localeCompare(right.candidateId);
}

function compareOccurredAt<T extends { occurredAt: string; id: string }>(left: T, right: T) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function jsonOrNull(value: unknown) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function rows(result: unknown): Record<string, unknown>[] {
  return Array.isArray((result as { rows?: unknown[] })?.rows) ? (result as { rows: Record<string, unknown>[] }).rows : [];
}

function requireRow(result: unknown) {
  const row = rows(result)[0];
  if (!row) throw new WorkItemError('DATABASE_WRITE_FAILED', '工作项数据写入失败');
  return row;
}

function optional<T>(result: unknown, mapper: (row: Record<string, unknown>) => T) {
  const row = rows(result)[0];
  return row ? mapper(row) : null;
}

function text(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new WorkItemError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return value == null ? null : text(row, key);
}

function instant(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new WorkItemError('INVALID_DATABASE_ROW', `字段 ${key} 时间无效`);
}

function nullableInstant(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new WorkItemError('INVALID_DATABASE_ROW', `字段 ${key} 时间无效`);
}

function bool(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'boolean') throw new WorkItemError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function jsonObject(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new WorkItemError('INVALID_DATABASE_ROW', `字段 ${key} JSON 无效`);
}

function nullableJsonObject(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value == null) return null;
  return jsonObject(row, key);
}

function jsonArray(row: Record<string, unknown>, key: string) {
  const value = row[key];
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new WorkItemError('INVALID_DATABASE_ROW', `字段 ${key} JSON 数组无效`);
  return parsed;
}

function integer(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new WorkItemError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
}

function nullableInteger(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value == null) return null;
  return integer(row, key);
}

function mapBatch(row: Record<string, unknown>): WorkItemBatch {
  return {
    id: text(row, 'id'),
    sourceAppId: text(row, 'source_app_id'),
    sourceEntityType: text(row, 'source_entity_type'),
    sourceEntityId: text(row, 'source_entity_id'),
    idempotencyKey: nullableText(row, 'idempotency_key'),
    idempotencyPayloadHash: nullableText(row, 'idempotency_payload_hash'),
    status: text(row, 'status') as WorkItemBatch['status'],
    display: jsonObject(row, 'display_snapshot') as unknown as WorkItemBatch['display'],
    navigation: nullableJsonObject(row, 'navigation_ref') as WorkItemBatch['navigation'],
    defaultDueAt: nullableInstant(row, 'default_due_at'),
    createdByPersonId: nullableText(row, 'created_by_person_id'),
    createdByActorType: text(row, 'created_by_actor_type') as WorkItemBatch['createdByActorType'],
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at'),
    cancelledAt: nullableInstant(row, 'cancelled_at')
  };
}

function mapWorkItem(row: Record<string, unknown>): WorkItem {
  const targetType = nullableText(row, 'target_entity_type');
  const targetId = nullableText(row, 'target_entity_id');
  return {
    id: text(row, 'id'),
    batchId: nullableText(row, 'batch_id'),
    sourceAppId: text(row, 'source_app_id'),
    sourceEntityType: text(row, 'source_entity_type'),
    sourceEntityId: text(row, 'source_entity_id'),
    idempotencyKey: nullableText(row, 'idempotency_key'),
    idempotencyPayloadHash: nullableText(row, 'idempotency_payload_hash'),
    recurrenceRuleId: nullableText(row, 'recurrence_rule_id'),
    recurrenceOccurrenceKey: nullableText(row, 'recurrence_occurrence_key'),
    recurrenceScheduledAt: nullableInstant(row, 'recurrence_scheduled_at'),
    status: text(row, 'status') as WorkItem['status'],
    priority: text(row, 'priority') as WorkItem['priority'],
    display: jsonObject(row, 'display_snapshot') as unknown as WorkItem['display'],
    navigation: nullableJsonObject(row, 'navigation_ref') as WorkItem['navigation'],
    responsibilityAreaId: nullableText(row, 'responsibility_area_id'),
    target: targetType && targetId ? { type: targetType as WorkItemTargetType, id: targetId, displayName: nullableText(row, 'target_display_name') } : null,
    currentAssigneePersonId: nullableText(row, 'current_assignee_person_id'),
    dueAt: nullableInstant(row, 'due_at'),
    createdByPersonId: nullableText(row, 'created_by_person_id'),
    createdByActorType: text(row, 'created_by_actor_type') as WorkItem['createdByActorType'],
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at'),
    completedAt: nullableInstant(row, 'completed_at'),
    cancelledAt: nullableInstant(row, 'cancelled_at')
  };
}

function mapCandidate(row: Record<string, unknown>): WorkItemCandidate {
  return {
    id: text(row, 'id'),
    workItemId: text(row, 'work_item_id'),
    candidateType: text(row, 'candidate_type') as WorkItemCandidate['candidateType'],
    candidateId: text(row, 'candidate_id'),
    createdAt: instant(row, 'created_at')
  };
}

function mapAssignment(row: Record<string, unknown>): WorkItemAssignmentHistory {
  return {
    id: text(row, 'id'),
    workItemId: text(row, 'work_item_id'),
    action: text(row, 'action') as WorkItemAssignmentHistory['action'],
    fromAssigneePersonId: nullableText(row, 'from_assignee_person_id'),
    toAssigneePersonId: nullableText(row, 'to_assignee_person_id'),
    actorPersonId: nullableText(row, 'actor_person_id'),
    note: nullableText(row, 'note'),
    occurredAt: instant(row, 'occurred_at')
  };
}

function mapProgress(row: Record<string, unknown>): WorkItemProgressHistory {
  return {
    id: text(row, 'id'),
    workItemId: text(row, 'work_item_id'),
    progressPercent: nullableInteger(row, 'progress_percent'),
    note: nullableText(row, 'note'),
    updaterPersonId: nullableText(row, 'updater_person_id'),
    occurredAt: instant(row, 'occurred_at')
  };
}

function mapCompletion(row: Record<string, unknown>): WorkItemCompletionEvidence {
  return {
    id: text(row, 'id'),
    workItemId: text(row, 'work_item_id'),
    assignedPersonId: nullableText(row, 'assigned_person_id'),
    actualCompleterPersonId: nullableText(row, 'actual_completer_person_id'),
    onBehalfOfPersonId: nullableText(row, 'on_behalf_of_person_id'),
    onBehalf: bool(row, 'on_behalf'),
    note: nullableText(row, 'note'),
    completedAt: instant(row, 'completed_at'),
    sourceAppId: text(row, 'source_app_id')
  };
}

function mapOperation(row: Record<string, unknown>): WorkItemOperationHistory {
  return {
    id: text(row, 'id'),
    workItemId: text(row, 'work_item_id'),
    operation: text(row, 'operation') as WorkItemOperationHistory['operation'],
    actorType: text(row, 'actor_type') as WorkItemOperationHistory['actorType'],
    actorPersonId: nullableText(row, 'actor_person_id'),
    serviceIdentityId: nullableText(row, 'service_identity_id'),
    executionType: text(row, 'execution_type') as WorkItemOperationHistory['executionType'],
    sourceAppId: nullableText(row, 'source_app_id'),
    requestId: nullableText(row, 'request_id'),
    traceId: nullableText(row, 'trace_id'),
    note: nullableText(row, 'note'),
    before: nullableJsonObject(row, 'before_payload'),
    after: nullableJsonObject(row, 'after_payload'),
    occurredAt: instant(row, 'occurred_at')
  };
}

function mapRecurrenceRule(row: Record<string, unknown>): WorkItemRecurrenceRule {
  const targetType = nullableText(row, 'target_entity_type');
  const targetId = nullableText(row, 'target_entity_id');
  return {
    id: text(row, 'id'),
    sourceAppId: text(row, 'source_app_id'),
    sourceEntityType: text(row, 'source_entity_type'),
    sourceEntityId: text(row, 'source_entity_id'),
    status: text(row, 'status') as WorkItemRecurrenceRule['status'],
    schedule: jsonObject(row, 'schedule') as unknown as WorkItemRecurrenceRule['schedule'],
    missedOccurrencePolicy: text(row, 'missed_occurrence_policy') as WorkItemRecurrenceRule['missedOccurrencePolicy'],
    dueAfterMinutes: nullableInteger(row, 'due_after_minutes'),
    priority: text(row, 'priority') as WorkItemRecurrenceRule['priority'],
    display: jsonObject(row, 'display_snapshot') as unknown as WorkItemRecurrenceRule['display'],
    navigation: nullableJsonObject(row, 'navigation_ref') as WorkItemRecurrenceRule['navigation'],
    responsibilityAreaId: nullableText(row, 'responsibility_area_id'),
    target: targetType && targetId ? { type: targetType as WorkItemTargetType, id: targetId, displayName: nullableText(row, 'target_display_name') } : null,
    candidates: jsonArray(row, 'candidates') as unknown as WorkItemRecurrenceRule['candidates'],
    currentAssigneePersonId: nullableText(row, 'current_assignee_person_id'),
    startAt: instant(row, 'start_at'),
    lastGeneratedScheduledAt: nullableInstant(row, 'last_generated_scheduled_at'),
    disabledAt: nullableInstant(row, 'disabled_at'),
    idempotencyKey: nullableText(row, 'idempotency_key'),
    idempotencyPayloadHash: nullableText(row, 'idempotency_payload_hash'),
    createdByPersonId: nullableText(row, 'created_by_person_id'),
    createdByActorType: text(row, 'created_by_actor_type') as WorkItemRecurrenceRule['createdByActorType'],
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at')
  };
}

function toMap<T extends { id: string }>(records: readonly T[] = []) {
  return new Map(records.map((record) => [record.id, clone(record)]));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}

function snapshotMap<T>(map: Map<string, T>): () => void {
  const saved = structuredClone(map);
  return () => { map.clear(); for (const [key, value] of saved) map.set(key, value); };
}
