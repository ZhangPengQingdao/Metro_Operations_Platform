import { runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import {
  DutyError,
  STANDARD_DUTY_STATUS_SEEDS,
  STANDARD_SHIFT_TYPE_SEEDS,
  type BusinessCalendarDay,
  type DutyAssignment,
  type DutyListInput,
  type DutyOperationHistory,
  type DutyPeriod,
  type DutyStatus,
  type ShiftType,
  type TemporaryReplacement
} from './model.js';
import { assertDutyWindowsDoNotOverlap, isDutyCatalogEffective } from './validation.js';

export interface DutyRepository {
  createShiftType(record: ShiftType, operation: DutyOperationHistory): Promise<ShiftType>;
  updateShiftType(record: ShiftType, operation: DutyOperationHistory): Promise<ShiftType>;
  findShiftTypeById(id: string): Promise<ShiftType | null>;
  listShiftTypes(code?: string): Promise<ShiftType[]>;
  createDutyStatus(record: DutyStatus, operation: DutyOperationHistory): Promise<DutyStatus>;
  updateDutyStatus(record: DutyStatus, operation: DutyOperationHistory): Promise<DutyStatus>;
  findDutyStatusById(id: string): Promise<DutyStatus | null>;
  listDutyStatuses(code?: string): Promise<DutyStatus[]>;
  setCalendarDay(record: BusinessCalendarDay, operation: DutyOperationHistory): Promise<BusinessCalendarDay>;
  findCalendarDay(dateKey: string): Promise<BusinessCalendarDay | null>;
  createPeriod(record: DutyPeriod, operation: DutyOperationHistory): Promise<DutyPeriod>;
  updatePeriod(record: DutyPeriod, operation: DutyOperationHistory): Promise<DutyPeriod>;
  findPeriodById(id: string): Promise<DutyPeriod | null>;
  listPeriods(input?: DutyListInput): Promise<DutyPeriod[]>;
  listPublishedPeriodsOverlapping(organizationUnitId: string, startDate: string, endDate: string): Promise<DutyPeriod[]>;
  setAssignment(record: DutyAssignment, operation: DutyOperationHistory): Promise<DutyAssignment>;
  findAssignmentById(id: string): Promise<DutyAssignment | null>;
  findAssignment(periodId: string, personId: string, dateKey: string): Promise<DutyAssignment | null>;
  listAssignments(periodId: string, dateKey?: string): Promise<DutyAssignment[]>;
  createReplacement(record: TemporaryReplacement, operation: DutyOperationHistory): Promise<TemporaryReplacement>;
  updateReplacement(record: TemporaryReplacement, operation: DutyOperationHistory): Promise<TemporaryReplacement>;
  findReplacementById(id: string): Promise<TemporaryReplacement | null>;
  listReplacementsForPeriod(periodId: string): Promise<TemporaryReplacement[]>;
  listOperationHistory(entityType: DutyOperationHistory['entityType'], entityId: string): Promise<DutyOperationHistory[]>;
}

export interface MemoryDutyRepository extends DutyRepository {
  records(): {
    shiftTypes: ShiftType[];
    dutyStatuses: DutyStatus[];
    calendarDays: BusinessCalendarDay[];
    periods: DutyPeriod[];
    assignments: DutyAssignment[];
    replacements: TemporaryReplacement[];
    operationHistory: DutyOperationHistory[];
  };
}

export function createMemoryDutyRepository(seed: {
  shiftTypes?: readonly ShiftType[];
  dutyStatuses?: readonly DutyStatus[];
  calendarDays?: readonly BusinessCalendarDay[];
  periods?: readonly DutyPeriod[];
  assignments?: readonly DutyAssignment[];
  replacements?: readonly TemporaryReplacement[];
  operationHistory?: readonly DutyOperationHistory[];
} = {}): MemoryDutyRepository {
  const shiftTypes = toMap(seed.shiftTypes ?? standardShiftTypeRecords());
  const dutyStatuses = toMap(seed.dutyStatuses ?? standardDutyStatusRecords());
  const calendarDays = new Map((seed.calendarDays ?? []).map((record) => [record.dateKey, clone(record)]));
  const periods = toMap(seed.periods);
  const assignments = toMap(seed.assignments);
  const replacements = toMap(seed.replacements);
  const operationHistory = toMap(seed.operationHistory);

  const saveHistory = (operation: DutyOperationHistory) => {
    if (operationHistory.has(operation.id)) throw new DutyError('DUTY_HISTORY_ID_CONFLICT', '值班操作历史 ID 已存在');
    operationHistory.set(operation.id, clone(operation));
  };

  return {
    async createShiftType(record, operation) {
      assertUniqueId(shiftTypes, record.id, 'SHIFT_TYPE_ID_CONFLICT');
      if ([...shiftTypes.values()].some((item) => item.code === record.code && item.effectiveFrom === record.effectiveFrom)) {
        throw new DutyError('SHIFT_TYPE_VERSION_CONFLICT', '班次编码与生效日期已存在');
      }
      saveHistory(operation);
      shiftTypes.set(record.id, clone(record));
      return clone(record);
    },
    async updateShiftType(record, operation) {
      const current = shiftTypes.get(record.id);
      if (!current) throw new DutyError('SHIFT_TYPE_NOT_FOUND', '班次不存在');
      assertCatalogIdentity(current, record);
      if (current.effectiveTo !== null) throw new DutyError('CATALOG_VERSION_ALREADY_CLOSED', '班次版本已关闭');
      if (!record.effectiveTo) throw new DutyError('CATALOG_EFFECTIVE_TO_REQUIRED', '关闭班次版本必须指定失效日期');
      if ([...assignments.values()].some((item) => item.shiftTypeId === record.id && item.dateKey > record.effectiveTo!)) {
        throw new DutyError('CATALOG_VERSION_IN_USE', '班次版本在失效日期后仍有指派引用');
      }
      saveHistory(operation);
      shiftTypes.set(record.id, clone(record));
      return clone(record);
    },
    async findShiftTypeById(id) { return cloneOrNull(shiftTypes.get(id)); },
    async listShiftTypes(code) {
      return [...shiftTypes.values()].filter((item) => !code || item.code === code).sort(compareCatalog).map(clone);
    },
    async createDutyStatus(record, operation) {
      assertUniqueId(dutyStatuses, record.id, 'DUTY_STATUS_ID_CONFLICT');
      if ([...dutyStatuses.values()].some((item) => item.code === record.code && item.effectiveFrom === record.effectiveFrom)) {
        throw new DutyError('DUTY_STATUS_VERSION_CONFLICT', '值班状态编码与生效日期已存在');
      }
      saveHistory(operation);
      dutyStatuses.set(record.id, clone(record));
      return clone(record);
    },
    async updateDutyStatus(record, operation) {
      const current = dutyStatuses.get(record.id);
      if (!current) throw new DutyError('DUTY_STATUS_NOT_FOUND', '值班状态不存在');
      assertCatalogIdentity(current, record);
      if (current.effectiveTo !== null) throw new DutyError('CATALOG_VERSION_ALREADY_CLOSED', '值班状态版本已关闭');
      if (!record.effectiveTo) throw new DutyError('CATALOG_EFFECTIVE_TO_REQUIRED', '关闭值班状态版本必须指定失效日期');
      if ([...assignments.values()].some((item) => item.dutyStatusId === record.id && item.dateKey > record.effectiveTo!)) {
        throw new DutyError('CATALOG_VERSION_IN_USE', '值班状态版本在失效日期后仍有指派引用');
      }
      saveHistory(operation);
      dutyStatuses.set(record.id, clone(record));
      return clone(record);
    },
    async findDutyStatusById(id) { return cloneOrNull(dutyStatuses.get(id)); },
    async listDutyStatuses(code) {
      return [...dutyStatuses.values()].filter((item) => !code || item.code === code).sort(compareCatalog).map(clone);
    },
    async setCalendarDay(record, operation) {
      saveHistory(operation);
      calendarDays.set(record.dateKey, clone(record));
      return clone(record);
    },
    async findCalendarDay(dateKey) { return cloneOrNull(calendarDays.get(dateKey)); },
    async createPeriod(record, operation) {
      assertUniqueId(periods, record.id, 'DUTY_PERIOD_ID_CONFLICT');
      if ([...periods.values()].some((item) => item.organizationUnitId === record.organizationUnitId && item.periodKey === record.periodKey && item.version === record.version)) {
        throw new DutyError('DUTY_PERIOD_VERSION_CONFLICT', '组织排班周期版本已存在');
      }
      saveHistory(operation);
      periods.set(record.id, clone(record));
      return clone(record);
    },
    async updatePeriod(record, operation) {
      const current = periods.get(record.id);
      if (!current) throw new DutyError('DUTY_PERIOD_NOT_FOUND', '值班周期不存在');
      if (current.status !== operationBeforeStatus(operation)) throw new DutyError('DUTY_PERIOD_CONCURRENT_CHANGE', '值班周期已被其他操作更改');
      if (record.status === 'published' && current.status !== 'draft') {
        throw new DutyError('DRAFT_DUTY_PERIOD_REQUIRED', '已发布或已取消排班不能重复发布');
      }
      if (record.status === 'published' && [...periods.values()].some((item) =>
        item.id !== record.id
        && item.organizationUnitId === record.organizationUnitId
        && item.status === 'published'
        && rangesOverlap(item.startDate, item.endDate, record.startDate, record.endDate))) {
        throw new DutyError('PUBLISHED_DUTY_PERIOD_OVERLAP', '同组织已有重叠的已发布周期');
      }
      if (record.status === 'published') {
        const periodAssignments = [...assignments.values()].filter((item) => item.periodId === record.id);
        validatePublishableAssignments(periodAssignments, [...shiftTypes.values()], [...dutyStatuses.values()]);
      }
      saveHistory(operation);
      periods.set(record.id, clone(record));
      return clone(record);
    },
    async findPeriodById(id) { return cloneOrNull(periods.get(id)); },
    async listPeriods(input = {}) {
      return [...periods.values()]
        .filter((item) => (!input.organizationUnitId || item.organizationUnitId === input.organizationUnitId) && (!input.status || item.status === input.status))
        .sort(comparePeriods)
        .slice(0, normalizeLimit(input.limit))
        .map(clone);
    },
    async listPublishedPeriodsOverlapping(organizationUnitId, startDate, endDate) {
      return [...periods.values()]
        .filter((item) => item.organizationUnitId === organizationUnitId && item.status === 'published' && rangesOverlap(item.startDate, item.endDate, startDate, endDate))
        .sort(comparePeriods)
        .map(clone);
    },
    async setAssignment(record, operation) {
      const period = periods.get(record.periodId);
      if (!period) throw new DutyError('DUTY_PERIOD_NOT_FOUND', '值班周期不存在');
      if (period.organizationUnitId !== record.organizationUnitId) {
        throw new DutyError('DUTY_ASSIGNMENT_SCOPE_MISMATCH', '值班指派与周期组织不一致');
      }
      if (period.status !== 'draft') throw new DutyError('DRAFT_DUTY_PERIOD_REQUIRED', '已发布或已取消排班不可直接修改');
      const duplicate = [...assignments.values()].find((item) => item.periodId === record.periodId && item.personId === record.personId && item.dateKey === record.dateKey);
      if (duplicate && duplicate.id !== record.id) throw new DutyError('DUTY_ASSIGNMENT_CONFLICT', '人员在该日期已有排班');
      const duplicateId = assignments.get(record.id);
      if (duplicateId && (duplicateId.periodId !== record.periodId || duplicateId.personId !== record.personId || duplicateId.dateKey !== record.dateKey)) {
        throw new DutyError('DUTY_ASSIGNMENT_ID_CONFLICT', '值班指派 ID 已属于其他记录');
      }
      saveHistory(operation);
      assignments.set(record.id, clone(record));
      return clone(record);
    },
    async findAssignmentById(id) { return cloneOrNull(assignments.get(id)); },
    async findAssignment(periodId, personId, dateKey) {
      return cloneOrNull([...assignments.values()].find((item) => item.periodId === periodId && item.personId === personId && item.dateKey === dateKey));
    },
    async listAssignments(periodId, dateKey) {
      return [...assignments.values()].filter((item) => item.periodId === periodId && (!dateKey || item.dateKey === dateKey)).sort(compareAssignments).map(clone);
    },
    async createReplacement(record, operation) {
      assertUniqueId(replacements, record.id, 'DUTY_REPLACEMENT_ID_CONFLICT');
      if ([...replacements.values()].some((item) => item.originalAssignmentId === record.originalAssignmentId && item.status !== 'cancelled')) {
        throw new DutyError('ACTIVE_REPLACEMENT_CONFLICT', '原排班已有生效中的替班记录');
      }
      if (record.returnAssignmentId && [...replacements.values()].some((item) => item.returnAssignmentId === record.returnAssignmentId && item.status !== 'cancelled')) {
        throw new DutyError('REPLACEMENT_ASSIGNMENT_CONFLICT', '还班指派已被其他替班占用');
      }
      validateMemoryReplacement(record, periods, assignments, replacements, shiftTypes);
      saveHistory(operation);
      replacements.set(record.id, clone(record));
      return clone(record);
    },
    async updateReplacement(record, operation) {
      const current = replacements.get(record.id);
      if (!current) throw new DutyError('DUTY_REPLACEMENT_NOT_FOUND', '替班记录不存在');
      if (current.status !== operationBeforeStatus(operation)) throw new DutyError('DUTY_REPLACEMENT_CONCURRENT_CHANGE', '替班记录已被其他操作更改');
      if (record.status !== 'cancelled' && [...replacements.values()].some((item) => item.id !== record.id && item.originalAssignmentId === record.originalAssignmentId && item.status !== 'cancelled')) {
        throw new DutyError('ACTIVE_REPLACEMENT_CONFLICT', '原排班已有生效中的替班记录');
      }
      if (record.status !== 'cancelled' && record.returnAssignmentId && [...replacements.values()].some((item) => item.id !== record.id && item.returnAssignmentId === record.returnAssignmentId && item.status !== 'cancelled')) {
        throw new DutyError('REPLACEMENT_ASSIGNMENT_CONFLICT', '还班指派已被其他替班占用');
      }
      saveHistory(operation);
      replacements.set(record.id, clone(record));
      return clone(record);
    },
    async findReplacementById(id) { return cloneOrNull(replacements.get(id)); },
    async listReplacementsForPeriod(periodId) {
      const assignmentIds = new Set([...assignments.values()].filter((item) => item.periodId === periodId).map((item) => item.id));
      return [...replacements.values()].filter((item) => assignmentIds.has(item.originalAssignmentId)).sort(compareReplacements).map(clone);
    },
    async listOperationHistory(entityType, entityId) {
      return [...operationHistory.values()].filter((item) => item.entityType === entityType && item.entityId === entityId).sort(compareHistory).map(clone);
    },
    records() {
      return {
        shiftTypes: [...shiftTypes.values()].sort(compareCatalog).map(clone),
        dutyStatuses: [...dutyStatuses.values()].sort(compareCatalog).map(clone),
        calendarDays: [...calendarDays.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey)).map(clone),
        periods: [...periods.values()].sort(comparePeriods).map(clone),
        assignments: [...assignments.values()].sort(compareAssignments).map(clone),
        replacements: [...replacements.values()].sort(compareReplacements).map(clone),
        operationHistory: [...operationHistory.values()].sort(compareHistory).map(clone)
      };
    }
  };
}

export function createPostgresDutyRepository(client: QueryableClient): DutyRepository {
  const withHistory = async <T>(write: (transaction: QueryableClient) => Promise<T>, operation: DutyOperationHistory) =>
    runDatabaseTransaction(client, async (transaction) => {
      const saved = await write(transaction);
      await insertHistory(transaction, operation);
      return saved;
    });

  return {
    async createShiftType(record, operation) {
      return withHistory(async (db) => mapShiftType(requireRow(await db.query(
        `INSERT INTO platform_shift_types
         (id,code,name,start_minute,end_minute,crosses_midnight,credited_minutes,duty_class,status,effective_from,effective_to,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [record.id, record.code, record.name, record.startMinute, record.endMinute, record.crossesMidnight, record.creditedMinutes, record.dutyClass, record.status, record.effectiveFrom, record.effectiveTo, record.createdAt, record.updatedAt]
      ))), operation);
    },
    async updateShiftType(shiftType, operation) {
      return withHistory(async (db) => {
        const current = optional(await db.query('SELECT * FROM platform_shift_types WHERE id=$1 FOR UPDATE', [shiftType.id]), mapShiftType);
        if (!current) throw new DutyError('SHIFT_TYPE_NOT_FOUND', '班次不存在');
        assertCatalogIdentity(current, shiftType);
        if (current.effectiveTo !== null) throw new DutyError('CATALOG_VERSION_ALREADY_CLOSED', '班次版本已关闭');
        if (!shiftType.effectiveTo) throw new DutyError('CATALOG_EFFECTIVE_TO_REQUIRED', '关闭班次版本必须指定失效日期');
        if (rows(await db.query('SELECT id FROM platform_duty_assignments WHERE shift_type_id=$1 AND date_key>$2::date LIMIT 1', [shiftType.id, shiftType.effectiveTo])).length > 0) {
          throw new DutyError('CATALOG_VERSION_IN_USE', '班次版本在失效日期后仍有指派引用');
        }
        return mapShiftType(requireRow(await db.query(
          'UPDATE platform_shift_types SET effective_to=$2::date,updated_at=$3 WHERE id=$1 RETURNING *',
          [shiftType.id, shiftType.effectiveTo, shiftType.updatedAt]
        )));
      }, operation);
    },
    async findShiftTypeById(id) { return optional(await client.query('SELECT * FROM platform_shift_types WHERE id=$1', [id]), mapShiftType); },
    async listShiftTypes(code) {
      return rows(await client.query(`SELECT * FROM platform_shift_types ${code ? 'WHERE code=$1' : ''} ORDER BY code,effective_from,id`, code ? [code] : undefined)).map(mapShiftType);
    },
    async createDutyStatus(record, operation) {
      return withHistory(async (db) => mapDutyStatus(requireRow(await db.query(
        `INSERT INTO platform_duty_statuses
         (id,code,name,category,credited_minutes,counts_as_on_duty,status,effective_from,effective_to,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [record.id, record.code, record.name, record.category, record.creditedMinutes, record.countsAsOnDuty, record.status, record.effectiveFrom, record.effectiveTo, record.createdAt, record.updatedAt]
      ))), operation);
    },
    async updateDutyStatus(dutyStatus, operation) {
      return withHistory(async (db) => {
        const current = optional(await db.query('SELECT * FROM platform_duty_statuses WHERE id=$1 FOR UPDATE', [dutyStatus.id]), mapDutyStatus);
        if (!current) throw new DutyError('DUTY_STATUS_NOT_FOUND', '值班状态不存在');
        assertCatalogIdentity(current, dutyStatus);
        if (current.effectiveTo !== null) throw new DutyError('CATALOG_VERSION_ALREADY_CLOSED', '值班状态版本已关闭');
        if (!dutyStatus.effectiveTo) throw new DutyError('CATALOG_EFFECTIVE_TO_REQUIRED', '关闭值班状态版本必须指定失效日期');
        if (rows(await db.query('SELECT id FROM platform_duty_assignments WHERE duty_status_id=$1 AND date_key>$2::date LIMIT 1', [dutyStatus.id, dutyStatus.effectiveTo])).length > 0) {
          throw new DutyError('CATALOG_VERSION_IN_USE', '值班状态版本在失效日期后仍有指派引用');
        }
        return mapDutyStatus(requireRow(await db.query(
          'UPDATE platform_duty_statuses SET effective_to=$2::date,updated_at=$3 WHERE id=$1 RETURNING *',
          [dutyStatus.id, dutyStatus.effectiveTo, dutyStatus.updatedAt]
        )));
      }, operation);
    },
    async findDutyStatusById(id) { return optional(await client.query('SELECT * FROM platform_duty_statuses WHERE id=$1', [id]), mapDutyStatus); },
    async listDutyStatuses(code) {
      return rows(await client.query(`SELECT * FROM platform_duty_statuses ${code ? 'WHERE code=$1' : ''} ORDER BY code,effective_from,id`, code ? [code] : undefined)).map(mapDutyStatus);
    },
    async setCalendarDay(record, operation) {
      return withHistory(async (db) => mapCalendarDay(requireRow(await db.query(
        `INSERT INTO platform_business_calendar_days
         (date_key,kind,holiday_code,holiday_name,source_app_id,source_entity_id,created_by_person_id,updated_by_person_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (date_key) DO UPDATE SET kind=EXCLUDED.kind,holiday_code=EXCLUDED.holiday_code,
           holiday_name=EXCLUDED.holiday_name,source_app_id=EXCLUDED.source_app_id,
           source_entity_id=EXCLUDED.source_entity_id,updated_by_person_id=EXCLUDED.updated_by_person_id,updated_at=EXCLUDED.updated_at
         RETURNING *`,
        [record.dateKey, record.kind, record.holidayCode, record.holidayName, record.sourceAppId, record.sourceEntityId, record.createdByPersonId, record.updatedByPersonId, record.createdAt, record.updatedAt]
      ))), operation);
    },
    async findCalendarDay(dateKey) { return optional(await client.query('SELECT * FROM platform_business_calendar_days WHERE date_key=$1', [dateKey]), mapCalendarDay); },
    async createPeriod(record, operation) {
      return withHistory(async (db) => mapPeriod(requireRow(await db.query(
        `INSERT INTO platform_duty_periods
         (id,organization_unit_id,period_key,version,start_date,end_date,status,source_app_id,source_entity_id,import_sha256,
          created_by_person_id,published_by_person_id,cancelled_by_person_id,created_at,updated_at,published_at,cancelled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [record.id, record.organizationUnitId, record.periodKey, record.version, record.startDate, record.endDate, record.status, record.sourceAppId, record.sourceEntityId, record.importSha256, record.createdByPersonId, record.publishedByPersonId, record.cancelledByPersonId, record.createdAt, record.updatedAt, record.publishedAt, record.cancelledAt]
      ))), operation);
    },
    async updatePeriod(periodUpdate, operation) {
      return withHistory(async (db) => {
        if (periodUpdate.status === 'published') {
          await db.query('SELECT id FROM platform_organization_units WHERE id=$1 FOR UPDATE', [periodUpdate.organizationUnitId]);
        }
        const currentRow = rows(await db.query(
          'SELECT status FROM platform_duty_periods WHERE id=$1 FOR UPDATE',
          [periodUpdate.id]
        ))[0];
        if (!currentRow) throw new DutyError('DUTY_PERIOD_NOT_FOUND', '值班周期不存在');
        const currentStatus = text(record(currentRow).status);
        if (currentStatus !== operationBeforeStatus(operation)) throw new DutyError('DUTY_PERIOD_CONCURRENT_CHANGE', '值班周期已被其他操作更改');
        if (periodUpdate.status === 'published') {
          if (currentStatus !== 'draft') throw new DutyError('DRAFT_DUTY_PERIOD_REQUIRED', '已发布或已取消排班不能重复发布');
          const conflicts = rows(await db.query(
            `SELECT id FROM platform_duty_periods
             WHERE id<>$1 AND organization_unit_id=$2 AND status='published'
               AND start_date <= $4::date AND end_date >= $3::date
             LIMIT 1`,
            [periodUpdate.id, periodUpdate.organizationUnitId, periodUpdate.startDate, periodUpdate.endDate]
          ));
          if (conflicts.length > 0) throw new DutyError('PUBLISHED_DUTY_PERIOD_OVERLAP', '同组织已有重叠的已发布周期');
          const state = await loadPostgresDutyWindowState(db, periodUpdate.id);
          validatePublishableAssignments(state.assignments, state.shiftTypes, state.dutyStatuses);
          const invalidPeople = rows(await db.query(
            `SELECT assignment.id FROM platform_duty_assignments assignment
             JOIN platform_people person ON person.id=assignment.person_id
             WHERE assignment.period_id=$1
               AND (person.employment_status<>'active' OR person.organization_unit_id<>$2)
             LIMIT 1`,
            [periodUpdate.id, periodUpdate.organizationUnitId]
          ));
          if (invalidPeople.length > 0) throw new DutyError('PERSON_INACTIVE', '值班指派包含离岗或跨组织人员');
        }
        return mapPeriod(requireRow(await db.query(
          `UPDATE platform_duty_periods SET status=$2,published_by_person_id=$3,cancelled_by_person_id=$4,
           updated_at=$5,published_at=$6,cancelled_at=$7 WHERE id=$1 RETURNING *`,
          [periodUpdate.id, periodUpdate.status, periodUpdate.publishedByPersonId, periodUpdate.cancelledByPersonId, periodUpdate.updatedAt, periodUpdate.publishedAt, periodUpdate.cancelledAt]
        )));
      }, operation);
    },
    async findPeriodById(id) { return optional(await client.query('SELECT * FROM platform_duty_periods WHERE id=$1', [id]), mapPeriod); },
    async listPeriods(input = {}) {
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (input.organizationUnitId) { values.push(input.organizationUnitId); clauses.push(`organization_unit_id=$${values.length}`); }
      if (input.status) { values.push(input.status); clauses.push(`status=$${values.length}`); }
      return rows(await client.query(
        `SELECT * FROM platform_duty_periods ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY start_date DESC,version DESC,id LIMIT ${normalizeLimit(input.limit)}`,
        values
      )).map(mapPeriod);
    },
    async listPublishedPeriodsOverlapping(organizationUnitId, startDate, endDate) {
      return rows(await client.query(
        `SELECT * FROM platform_duty_periods WHERE organization_unit_id=$1 AND status='published'
         AND start_date <= $3::date AND end_date >= $2::date ORDER BY version DESC,id`,
        [organizationUnitId, startDate, endDate]
      )).map(mapPeriod);
    },
    async setAssignment(assignment, operation) {
      return withHistory(async (db) => {
        const periodRow = rows(await db.query(
          'SELECT organization_unit_id,status FROM platform_duty_periods WHERE id=$1 FOR UPDATE',
          [assignment.periodId]
        ))[0];
        if (!periodRow) throw new DutyError('DUTY_PERIOD_NOT_FOUND', '值班周期不存在');
        const period = record(periodRow);
        if (text(period.organization_unit_id) !== assignment.organizationUnitId) {
          throw new DutyError('DUTY_ASSIGNMENT_SCOPE_MISMATCH', '值班指派与周期组织不一致');
        }
        if (text(period.status) !== 'draft') {
          throw new DutyError('DRAFT_DUTY_PERIOD_REQUIRED', '已发布或已取消排班不可直接修改');
        }
        if (assignment.kind === 'shift') {
          const shift = optional(await db.query('SELECT * FROM platform_shift_types WHERE id=$1 FOR SHARE', [assignment.shiftTypeId]), mapShiftType);
          if (!shift) throw new DutyError('SHIFT_TYPE_NOT_FOUND', '班次不存在');
          if (!isDutyCatalogEffective(shift, assignment.dateKey)) throw new DutyError('SHIFT_TYPE_INACTIVE', '班次在指派日期未生效');
        } else {
          const status = optional(await db.query('SELECT * FROM platform_duty_statuses WHERE id=$1 FOR SHARE', [assignment.dutyStatusId]), mapDutyStatus);
          if (!status) throw new DutyError('DUTY_STATUS_NOT_FOUND', '值班状态不存在');
          if (!isDutyCatalogEffective(status, assignment.dateKey)) throw new DutyError('DUTY_STATUS_INACTIVE', '值班状态在指派日期未生效');
        }
        const existingRow = rows(await db.query(
          'SELECT id FROM platform_duty_assignments WHERE period_id=$1 AND person_id=$2 AND date_key=$3::date',
          [assignment.periodId, assignment.personId, assignment.dateKey]
        ))[0];
        if (existingRow && text(record(existingRow).id) !== assignment.id) {
          throw new DutyError('DUTY_ASSIGNMENT_CONFLICT', '人员在该日期已有排班');
        }
        return mapAssignment(requireRow(await db.query(
          `INSERT INTO platform_duty_assignments
           (id,period_id,organization_unit_id,person_id,date_key,kind,shift_type_id,duty_status_id,code_snapshot,name_snapshot,
            credited_minutes_snapshot,origin,created_by_person_id,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (period_id,person_id,date_key) DO UPDATE SET kind=EXCLUDED.kind,shift_type_id=EXCLUDED.shift_type_id,
            duty_status_id=EXCLUDED.duty_status_id,code_snapshot=EXCLUDED.code_snapshot,name_snapshot=EXCLUDED.name_snapshot,
            credited_minutes_snapshot=EXCLUDED.credited_minutes_snapshot,origin=EXCLUDED.origin,updated_at=EXCLUDED.updated_at
           RETURNING *`,
          [assignment.id, assignment.periodId, assignment.organizationUnitId, assignment.personId, assignment.dateKey, assignment.kind, assignment.shiftTypeId, assignment.dutyStatusId, assignment.codeSnapshot, assignment.nameSnapshot, assignment.creditedMinutesSnapshot, assignment.origin, assignment.createdByPersonId, assignment.createdAt, assignment.updatedAt]
        )));
      }, operation);
    },
    async findAssignmentById(id) { return optional(await client.query('SELECT * FROM platform_duty_assignments WHERE id=$1', [id]), mapAssignment); },
    async findAssignment(periodId, personId, dateKey) {
      return optional(await client.query('SELECT * FROM platform_duty_assignments WHERE period_id=$1 AND person_id=$2 AND date_key=$3', [periodId, personId, dateKey]), mapAssignment);
    },
    async listAssignments(periodId, dateKey) {
      return rows(await client.query(
        `SELECT * FROM platform_duty_assignments WHERE period_id=$1 ${dateKey ? 'AND date_key=$2' : ''} ORDER BY date_key,person_id,id`,
        dateKey ? [periodId, dateKey] : [periodId]
      )).map(mapAssignment);
    },
    async createReplacement(record, operation) {
      return withHistory(async (db) => {
        await db.query('SELECT id FROM platform_organization_units WHERE id=$1 FOR UPDATE', [record.organizationUnitId]);
        await validatePostgresReplacement(db, record);
        return mapReplacement(requireRow(await db.query(
          `INSERT INTO platform_temporary_replacements
           (id,original_assignment_id,return_assignment_id,organization_unit_id,absent_person_id,substitute_person_id,
            replacement_shift_type_id,status,reason,source_app_id,source_entity_id,created_by_person_id,approved_by_person_id,
            cancelled_by_person_id,created_at,updated_at,approved_at,cancelled_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [record.id, record.originalAssignmentId, record.returnAssignmentId, record.organizationUnitId, record.absentPersonId, record.substitutePersonId, record.replacementShiftTypeId, record.status, record.reason, record.sourceAppId, record.sourceEntityId, record.createdByPersonId, record.approvedByPersonId, record.cancelledByPersonId, record.createdAt, record.updatedAt, record.approvedAt, record.cancelledAt]
        )));
      }, operation);
    },
    async updateReplacement(record, operation) {
      return withHistory(async (db) => {
        await db.query('SELECT id FROM platform_organization_units WHERE id=$1 FOR UPDATE', [record.organizationUnitId]);
        const current = optional(await db.query('SELECT * FROM platform_temporary_replacements WHERE id=$1 FOR UPDATE', [record.id]), mapReplacement);
        if (!current) throw new DutyError('DUTY_REPLACEMENT_NOT_FOUND', '替班记录不存在');
        if (current.status !== operationBeforeStatus(operation)) throw new DutyError('DUTY_REPLACEMENT_CONCURRENT_CHANGE', '替班记录已被其他操作更改');
        return mapReplacement(requireRow(await db.query(
          `UPDATE platform_temporary_replacements SET status=$2,approved_by_person_id=$3,cancelled_by_person_id=$4,
           updated_at=$5,approved_at=$6,cancelled_at=$7 WHERE id=$1 RETURNING *`,
          [record.id, record.status, record.approvedByPersonId, record.cancelledByPersonId, record.updatedAt, record.approvedAt, record.cancelledAt]
        )));
      }, operation);
    },
    async findReplacementById(id) { return optional(await client.query('SELECT * FROM platform_temporary_replacements WHERE id=$1', [id]), mapReplacement); },
    async listReplacementsForPeriod(periodId) {
      return rows(await client.query(
        `SELECT replacement.* FROM platform_temporary_replacements replacement
         JOIN platform_duty_assignments assignment ON assignment.id=replacement.original_assignment_id
         WHERE assignment.period_id=$1 ORDER BY replacement.created_at,replacement.id`,
        [periodId]
      )).map(mapReplacement);
    },
    async listOperationHistory(entityType, entityId) {
      return rows(await client.query(
        'SELECT * FROM platform_duty_operation_history WHERE entity_type=$1 AND entity_id=$2 ORDER BY occurred_at,id',
        [entityType, entityId]
      )).map(mapHistory);
    }
  };
}

async function insertHistory(client: QueryableClient, record: DutyOperationHistory) {
  await client.query(
    `INSERT INTO platform_duty_operation_history
     (id,operation,entity_type,entity_id,organization_unit_id,actor_type,actor_person_id,service_identity_id,
      execution_type,source_app_id,request_id,trace_id,note,before_payload,after_payload,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16)`,
    [record.id, record.operation, record.entityType, record.entityId, record.organizationUnitId, record.actorType, record.actorPersonId, record.serviceIdentityId, record.executionType, record.sourceAppId, record.requestId, record.traceId, record.note, jsonOrNull(record.before), jsonOrNull(record.after), record.occurredAt]
  );
}

function validatePublishableAssignments(
  assignments: readonly DutyAssignment[],
  shiftTypes: readonly ShiftType[],
  dutyStatuses: readonly DutyStatus[]
) {
  if (assignments.length === 0) throw new DutyError('DUTY_PERIOD_EMPTY', '空值班周期不能发布');
  const shifts = new Map(shiftTypes.map((item) => [item.id, item]));
  const statuses = new Map(dutyStatuses.map((item) => [item.id, item]));
  for (const assignment of assignments) {
    if (assignment.kind === 'shift') {
      const shift = assignment.shiftTypeId ? shifts.get(assignment.shiftTypeId) : null;
      if (!shift) throw new DutyError('SHIFT_TYPE_NOT_FOUND', '班次不存在');
      if (!isDutyCatalogEffective(shift, assignment.dateKey)) throw new DutyError('SHIFT_TYPE_INACTIVE', '班次在指派日期未生效');
    } else {
      const status = assignment.dutyStatusId ? statuses.get(assignment.dutyStatusId) : null;
      if (!status) throw new DutyError('DUTY_STATUS_NOT_FOUND', '值班状态不存在');
      if (!isDutyCatalogEffective(status, assignment.dateKey)) throw new DutyError('DUTY_STATUS_INACTIVE', '值班状态在指派日期未生效');
    }
  }
  assertDutyWindowsDoNotOverlap(assignments, shiftTypes, [], 'DUTY_ASSIGNMENT_TIME_OVERLAP', '同一人员存在时间重叠的班次');
}

function validateMemoryReplacement(
  replacement: TemporaryReplacement,
  periods: Map<string, DutyPeriod>,
  assignments: Map<string, DutyAssignment>,
  replacements: Map<string, TemporaryReplacement>,
  shiftTypes: Map<string, ShiftType>
) {
  const original = assignments.get(replacement.originalAssignmentId);
  if (!original || original.kind !== 'shift') throw new DutyError('WORKING_SHIFT_REQUIRED', '替班原指派必须是工作班次');
  const period = periods.get(original.periodId);
  if (!period || period.status !== 'published') throw new DutyError('PUBLISHED_PERIOD_REQUIRED', '只能对已发布排班提出替班');
  if (original.organizationUnitId !== replacement.organizationUnitId || original.personId !== replacement.absentPersonId) {
    throw new DutyError('REPLACEMENT_SCOPE_MISMATCH', '替班记录与原指派范围不一致');
  }
  const returnAssignment = replacement.returnAssignmentId ? assignments.get(replacement.returnAssignmentId) : null;
  if (replacement.returnAssignmentId && (!returnAssignment || returnAssignment.periodId !== period.id || returnAssignment.organizationUnitId !== period.organizationUnitId)) {
    throw new DutyError('RETURN_ASSIGNMENT_SCOPE_MISMATCH', '还班指派不属于同一组织和值班周期');
  }
  if (returnAssignment && (returnAssignment.kind !== 'shift' || returnAssignment.personId !== replacement.substitutePersonId)) {
    throw new DutyError('RETURN_ASSIGNMENT_PERSON_MISMATCH', '还班指派必须是替班人员的工作班次');
  }
  const periodAssignmentIds = new Set([...assignments.values()].filter((item) => item.periodId === period.id).map((item) => item.id));
  const active = [...replacements.values()].filter((item) => item.status !== 'cancelled' && periodAssignmentIds.has(item.originalAssignmentId));
  if (active.some((item) =>
    item.originalAssignmentId === replacement.originalAssignmentId
    || item.returnAssignmentId === replacement.originalAssignmentId
    || (replacement.returnAssignmentId !== null
      && (item.originalAssignmentId === replacement.returnAssignmentId || item.returnAssignmentId === replacement.returnAssignmentId)))) {
    throw new DutyError('REPLACEMENT_ASSIGNMENT_CONFLICT', '原指派或还班指派已被其他替班占用');
  }
  assertDutyWindowsDoNotOverlap(
    [...assignments.values()].filter((item) => item.periodId === period.id),
    [...shiftTypes.values()],
    [...active, replacement],
    'DUTY_REPLACEMENT_TIME_OVERLAP',
    '替班后同一人员存在时间重叠的班次'
  );
}

async function loadPostgresDutyWindowState(client: QueryableClient, periodId: string) {
  const assignments = rows(await client.query(
    'SELECT * FROM platform_duty_assignments WHERE period_id=$1 ORDER BY date_key,person_id,id',
    [periodId]
  )).map(mapAssignment);
  const shiftTypes = rows(await client.query(
    `SELECT shift.* FROM platform_shift_types shift
     WHERE EXISTS (
       SELECT 1 FROM platform_duty_assignments assignment
       WHERE assignment.period_id=$1 AND assignment.shift_type_id=shift.id
     ) OR EXISTS (
       SELECT 1 FROM platform_temporary_replacements replacement
       JOIN platform_duty_assignments original ON original.id=replacement.original_assignment_id
       WHERE original.period_id=$1 AND replacement.status<>'cancelled' AND replacement.replacement_shift_type_id=shift.id
     )`,
    [periodId]
  )).map(mapShiftType);
  const dutyStatuses = rows(await client.query(
    `SELECT status.* FROM platform_duty_statuses status
     WHERE EXISTS (
       SELECT 1 FROM platform_duty_assignments assignment
       WHERE assignment.period_id=$1 AND assignment.duty_status_id=status.id
     )`,
    [periodId]
  )).map(mapDutyStatus);
  const replacements = rows(await client.query(
    `SELECT replacement.* FROM platform_temporary_replacements replacement
     JOIN platform_duty_assignments original ON original.id=replacement.original_assignment_id
     WHERE original.period_id=$1 AND replacement.status<>'cancelled'
     ORDER BY replacement.created_at,replacement.id`,
    [periodId]
  )).map(mapReplacement);
  return { assignments, shiftTypes, dutyStatuses, replacements };
}

async function validatePostgresReplacement(client: QueryableClient, replacement: TemporaryReplacement) {
  const original = optional(await client.query('SELECT * FROM platform_duty_assignments WHERE id=$1', [replacement.originalAssignmentId]), mapAssignment);
  if (!original || original.kind !== 'shift') throw new DutyError('WORKING_SHIFT_REQUIRED', '替班原指派必须是工作班次');
  const period = optional(await client.query('SELECT * FROM platform_duty_periods WHERE id=$1', [original.periodId]), mapPeriod);
  if (!period || period.status !== 'published') throw new DutyError('PUBLISHED_PERIOD_REQUIRED', '只能对已发布排班提出替班');
  if (original.organizationUnitId !== replacement.organizationUnitId || original.personId !== replacement.absentPersonId) {
    throw new DutyError('REPLACEMENT_SCOPE_MISMATCH', '替班记录与原指派范围不一致');
  }
  const people = rows(await client.query(
    `SELECT id FROM platform_people
     WHERE id IN ($1,$2) AND organization_unit_id=$3 AND employment_status='active'`,
    [replacement.absentPersonId, replacement.substitutePersonId, replacement.organizationUnitId]
  ));
  if (people.length !== 2) throw new DutyError('PERSON_INACTIVE', '替班包含离岗或跨组织人员');
  const returnAssignment = replacement.returnAssignmentId
    ? optional(await client.query('SELECT * FROM platform_duty_assignments WHERE id=$1', [replacement.returnAssignmentId]), mapAssignment)
    : null;
  if (replacement.returnAssignmentId && (!returnAssignment || returnAssignment.periodId !== period.id || returnAssignment.organizationUnitId !== period.organizationUnitId)) {
    throw new DutyError('RETURN_ASSIGNMENT_SCOPE_MISMATCH', '还班指派不属于同一组织和值班周期');
  }
  if (returnAssignment && (returnAssignment.kind !== 'shift' || returnAssignment.personId !== replacement.substitutePersonId)) {
    throw new DutyError('RETURN_ASSIGNMENT_PERSON_MISMATCH', '还班指派必须是替班人员的工作班次');
  }
  const state = await loadPostgresDutyWindowState(client, period.id);
  if (state.replacements.some((item) =>
    item.originalAssignmentId === replacement.originalAssignmentId
    || item.returnAssignmentId === replacement.originalAssignmentId
    || (replacement.returnAssignmentId !== null
      && (item.originalAssignmentId === replacement.returnAssignmentId || item.returnAssignmentId === replacement.returnAssignmentId)))) {
    throw new DutyError('REPLACEMENT_ASSIGNMENT_CONFLICT', '原指派或还班指派已被其他替班占用');
  }
  if (replacement.replacementShiftTypeId && !state.shiftTypes.some((item) => item.id === replacement.replacementShiftTypeId)) {
    const shift = optional(await client.query('SELECT * FROM platform_shift_types WHERE id=$1', [replacement.replacementShiftTypeId]), mapShiftType);
    if (shift) state.shiftTypes.push(shift);
  }
  assertDutyWindowsDoNotOverlap(
    state.assignments,
    state.shiftTypes,
    [...state.replacements, replacement],
    'DUTY_REPLACEMENT_TIME_OVERLAP',
    '替班后同一人员存在时间重叠的班次'
  );
}

function assertCatalogIdentity(current: ShiftType | DutyStatus, next: ShiftType | DutyStatus) {
  const currentIdentity = { ...current, effectiveTo: null, updatedAt: null };
  const nextIdentity = { ...next, effectiveTo: null, updatedAt: null };
  if (JSON.stringify(currentIdentity) !== JSON.stringify(nextIdentity)) {
    throw new DutyError('CATALOG_IDENTITY_IMMUTABLE', '目录版本只允许关闭失效日期');
  }
}

function operationBeforeStatus(operation: DutyOperationHistory) {
  const value = operation.before?.status;
  if (typeof value !== 'string') throw new DutyError('DUTY_CONCURRENCY_PRECONDITION_REQUIRED', '更新值班记录必须携带原状态');
  return value;
}

function mapShiftType(value: unknown): ShiftType {
  const row = record(value);
  return { id: text(row.id), code: text(row.code), name: text(row.name), startMinute: integer(row.start_minute), endMinute: integer(row.end_minute), crossesMidnight: bool(row.crosses_midnight), creditedMinutes: nullableInteger(row.credited_minutes), dutyClass: text(row.duty_class) as ShiftType['dutyClass'], status: text(row.status) as ShiftType['status'], effectiveFrom: date(row.effective_from), effectiveTo: nullableDate(row.effective_to), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) };
}

function mapDutyStatus(value: unknown): DutyStatus {
  const row = record(value);
  return { id: text(row.id), code: text(row.code), name: text(row.name), category: text(row.category) as DutyStatus['category'], creditedMinutes: nullableInteger(row.credited_minutes), countsAsOnDuty: bool(row.counts_as_on_duty), status: text(row.status) as DutyStatus['status'], effectiveFrom: date(row.effective_from), effectiveTo: nullableDate(row.effective_to), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) };
}

function mapCalendarDay(value: unknown): BusinessCalendarDay {
  const row = record(value);
  return { dateKey: date(row.date_key), kind: text(row.kind) as BusinessCalendarDay['kind'], holidayCode: nullableText(row.holiday_code), holidayName: nullableText(row.holiday_name), sourceAppId: nullableText(row.source_app_id), sourceEntityId: nullableText(row.source_entity_id), createdByPersonId: nullableText(row.created_by_person_id), updatedByPersonId: nullableText(row.updated_by_person_id), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) };
}

function mapPeriod(value: unknown): DutyPeriod {
  const row = record(value);
  return { id: text(row.id), organizationUnitId: text(row.organization_unit_id), periodKey: text(row.period_key), version: integer(row.version), startDate: date(row.start_date), endDate: date(row.end_date), status: text(row.status) as DutyPeriod['status'], sourceAppId: nullableText(row.source_app_id), sourceEntityId: nullableText(row.source_entity_id), importSha256: nullableText(row.import_sha256), createdByPersonId: nullableText(row.created_by_person_id), publishedByPersonId: nullableText(row.published_by_person_id), cancelledByPersonId: nullableText(row.cancelled_by_person_id), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), publishedAt: nullableInstant(row.published_at), cancelledAt: nullableInstant(row.cancelled_at) };
}

function mapAssignment(value: unknown): DutyAssignment {
  const row = record(value);
  return { id: text(row.id), periodId: text(row.period_id), organizationUnitId: text(row.organization_unit_id), personId: text(row.person_id), dateKey: date(row.date_key), kind: text(row.kind) as DutyAssignment['kind'], shiftTypeId: nullableText(row.shift_type_id), dutyStatusId: nullableText(row.duty_status_id), codeSnapshot: text(row.code_snapshot), nameSnapshot: text(row.name_snapshot), creditedMinutesSnapshot: nullableInteger(row.credited_minutes_snapshot), origin: text(row.origin) as DutyAssignment['origin'], createdByPersonId: nullableText(row.created_by_person_id), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) };
}

function mapReplacement(value: unknown): TemporaryReplacement {
  const row = record(value);
  return { id: text(row.id), originalAssignmentId: text(row.original_assignment_id), returnAssignmentId: nullableText(row.return_assignment_id), organizationUnitId: text(row.organization_unit_id), absentPersonId: text(row.absent_person_id), substitutePersonId: text(row.substitute_person_id), replacementShiftTypeId: nullableText(row.replacement_shift_type_id), status: text(row.status) as TemporaryReplacement['status'], reason: nullableText(row.reason), sourceAppId: nullableText(row.source_app_id), sourceEntityId: nullableText(row.source_entity_id), createdByPersonId: nullableText(row.created_by_person_id), approvedByPersonId: nullableText(row.approved_by_person_id), cancelledByPersonId: nullableText(row.cancelled_by_person_id), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), approvedAt: nullableInstant(row.approved_at), cancelledAt: nullableInstant(row.cancelled_at) };
}

function mapHistory(value: unknown): DutyOperationHistory {
  const row = record(value);
  return { id: text(row.id), operation: text(row.operation) as DutyOperationHistory['operation'], entityType: text(row.entity_type) as DutyOperationHistory['entityType'], entityId: text(row.entity_id), organizationUnitId: nullableText(row.organization_unit_id), actorType: text(row.actor_type) as DutyOperationHistory['actorType'], actorPersonId: nullableText(row.actor_person_id), serviceIdentityId: nullableText(row.service_identity_id), executionType: text(row.execution_type) as DutyOperationHistory['executionType'], sourceAppId: nullableText(row.source_app_id), requestId: nullableText(row.request_id), traceId: nullableText(row.trace_id), note: nullableText(row.note), before: nullableJson(row.before_payload), after: nullableJson(row.after_payload), occurredAt: instant(row.occurred_at) };
}

function rows(result: unknown): unknown[] { return result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows) ? result.rows : []; }
function requireRow(result: unknown) { const value = rows(result)[0]; if (!value) throw new DutyError('DUTY_DATABASE_WRITE_FAILED', '值班数据库写入未返回记录'); return value; }
function optional<T>(result: unknown, mapper: (value: unknown) => T) { const value = rows(result)[0]; return value ? mapper(value) : null; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DutyError('INVALID_DUTY_DATABASE_ROW', '值班数据库返回无效'); return value as Record<string, unknown>; }
function text(value: unknown) { if (typeof value !== 'string' || !value) throw new DutyError('INVALID_DUTY_DATABASE_ROW', '值班数据库文本字段无效'); return value; }
function nullableText(value: unknown) { return typeof value === 'string' && value ? value : null; }
function integer(value: unknown) { const normalized = typeof value === 'number' ? value : Number(value); if (!Number.isSafeInteger(normalized)) throw new DutyError('INVALID_DUTY_DATABASE_ROW', '值班数据库整数字段无效'); return normalized; }
function nullableInteger(value: unknown) { return value === null || value === undefined ? null : integer(value); }
function bool(value: unknown) { if (typeof value !== 'boolean') throw new DutyError('INVALID_DUTY_DATABASE_ROW', '值班数据库布尔字段无效'); return value; }
function instant(value: unknown) { const parsed = value instanceof Date ? value : new Date(String(value)); if (Number.isNaN(parsed.getTime())) throw new DutyError('INVALID_DUTY_DATABASE_ROW', '值班数据库时间字段无效'); return parsed.toISOString(); }
function nullableInstant(value: unknown) { return value === null || value === undefined ? null : instant(value); }
function date(value: unknown) { if (value instanceof Date) return value.toISOString().slice(0, 10); const normalized = String(value).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new DutyError('INVALID_DUTY_DATABASE_ROW', '值班数据库日期字段无效'); return normalized; }
function nullableDate(value: unknown) { return value === null || value === undefined ? null : date(value); }
function nullableJson(value: unknown) { if (value === null || value === undefined) return null; const parsed = typeof value === 'string' ? JSON.parse(value) : value; return record(parsed); }
function jsonOrNull(value: unknown) { return value === null || value === undefined ? null : JSON.stringify(value); }
function toMap<T extends { id: string }>(values: readonly T[] | undefined) { return new Map((values ?? []).map((value) => [value.id, clone(value)])); }
function assertUniqueId<T>(records: Map<string, T>, id: string, code: string) { if (records.has(id)) throw new DutyError(code, '值班记录 ID 已存在'); }
function clone<T>(value: T): T { return structuredClone(value); }
function cloneOrNull<T>(value: T | undefined) { return value === undefined ? null : clone(value); }
function rangesOverlap(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string) { return leftStart <= rightEnd && rightStart <= leftEnd; }
function compareCatalog(left: ShiftType | DutyStatus, right: ShiftType | DutyStatus) { return left.code.localeCompare(right.code, 'zh-CN') || left.effectiveFrom.localeCompare(right.effectiveFrom) || left.id.localeCompare(right.id); }
function comparePeriods(left: DutyPeriod, right: DutyPeriod) { return right.startDate.localeCompare(left.startDate) || right.version - left.version || left.id.localeCompare(right.id); }
function compareAssignments(left: DutyAssignment, right: DutyAssignment) { return left.dateKey.localeCompare(right.dateKey) || left.personId.localeCompare(right.personId) || left.id.localeCompare(right.id); }
function compareReplacements(left: TemporaryReplacement, right: TemporaryReplacement) { return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id); }
function compareHistory(left: DutyOperationHistory, right: DutyOperationHistory) { return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id); }
function normalizeLimit(value: number | undefined) { return Number.isSafeInteger(value) ? Math.max(1, Math.min(500, value!)) : 100; }

function standardShiftTypeRecords(): ShiftType[] {
  return STANDARD_SHIFT_TYPE_SEEDS.map((seed) => ({
    ...seed,
    dutyClass: seed.dutyClass as ShiftType['dutyClass'],
    status: 'active',
    effectiveFrom: '1970-01-01',
    effectiveTo: null,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z'
  }));
}

function standardDutyStatusRecords(): DutyStatus[] {
  return STANDARD_DUTY_STATUS_SEEDS.map((seed) => ({
    ...seed,
    category: seed.category as DutyStatus['category'],
    status: 'active',
    effectiveFrom: '1970-01-01',
    effectiveTo: null,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z'
  }));
}
