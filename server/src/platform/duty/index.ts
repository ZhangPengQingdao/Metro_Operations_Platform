import { randomUUID } from 'node:crypto';
import {
  SystemClock,
  getPlatformDateKey,
  toPlatformInstant,
  type PlatformClock
} from '../../core/time/index.js';
import type { AuthorizationResource } from '../authorization/index.js';
import type { PlatformActorContext } from '../context/index.js';
import {
  DUTY_PERMISSION_CODES,
  DutyError,
  STANDARD_DUTY_STATUS_SEEDS,
  STANDARD_SHIFT_TYPE_SEEDS,
  type BusinessCalendarDay,
  type BusinessCalendarDayKind,
  type CloseDutyCatalogVersionInput,
  type CreateDutyPeriodInput,
  type CreateDutyStatusInput,
  type CreateShiftTypeInput,
  type DutyAssignment,
  type DutyClass,
  type DutyOperation,
  type DutyOperationHistory,
  type DutyPeriod,
  type DutyRecordStatus,
  type DutyStatus,
  type DutyStatusCategory,
  type LegacyDutyEvidenceSnapshot,
  type LegacyDutyReconciliation,
  type ProposeTemporaryReplacementInput,
  type ResolvedDuty,
  type SetBusinessCalendarDayInput,
  type SetDutyAssignmentInput,
  type ShiftType,
  type TemporaryReplacement
} from './model.js';
import type { DutyRepository } from './repository.js';
import {
  addPlatformDays,
  assertDutyWindowsDoNotOverlap,
  getDutyShiftWindow,
  isDutyCatalogEffective
} from './validation.js';

export * from './migration.js';
export * from './model.js';
export * from './repository.js';

export interface DutyDirectoryPerson {
  organizationUnitId: string;
  employmentStatus: string;
}

export interface DutyDirectoryOrganizationUnit {
  status: string;
}

export interface DutyServiceOptions {
  clock?: PlatformClock;
  createId?: () => string;
  findPerson(id: string): Promise<DutyDirectoryPerson | null>;
  findOrganizationUnit(id: string): Promise<DutyDirectoryOrganizationUnit | null>;
}

export class DutyService {
  private readonly clock: PlatformClock;
  private readonly createId: () => string;

  constructor(private readonly repository: DutyRepository, private readonly options: DutyServiceOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.createId = options.createId ?? randomUUID;
  }

  async createShiftType(context: PlatformActorContext, input: CreateShiftTypeInput) {
    await this.authorize(context, DUTY_PERMISSION_CODES.catalogManage, {});
    const effectiveFrom = dateKey(input.effectiveFrom, 'effective from');
    const effectiveTo = optionalDateKey(input.effectiveTo, 'effective to');
    if (effectiveTo && effectiveTo < effectiveFrom) throw new DutyError('INVALID_EFFECTIVE_PERIOD', '班次失效日期不能早于生效日期');
    const code = stableCode(input.code, 50, 'shift code');
    const existing = await this.repository.listShiftTypes(code);
    if (existing.some((item) => rangesOverlap(item.effectiveFrom, item.effectiveTo ?? '9999-12-31', effectiveFrom, effectiveTo ?? '9999-12-31'))) {
      throw new DutyError('SHIFT_TYPE_EFFECTIVE_OVERLAP', '同一班次编码的生效期间重叠');
    }
    const startMinute = minute(input.startMinute, 'shift start minute');
    const endMinute = minute(input.endMinute, 'shift end minute');
    const crossesMidnight = booleanValue(input.crossesMidnight, 'crosses midnight');
    if ((crossesMidnight && endMinute >= startMinute) || (!crossesMidnight && endMinute <= startMinute)) {
      throw new DutyError('INVALID_SHIFT_WINDOW', '班次时间窗口与跨日标记不一致');
    }
    const now = this.nowIso();
    const record: ShiftType = {
      id: uuid(input.id ?? this.createId(), 'shift type id'),
      code,
      name: text(input.name, 100, 'shift name'),
      startMinute,
      endMinute,
      crossesMidnight,
      creditedMinutes: nullableMinutes(input.creditedMinutes, 'credited minutes'),
      dutyClass: dutyClass(input.dutyClass),
      status: recordStatus(input.status ?? 'active'),
      effectiveFrom,
      effectiveTo,
      createdAt: now,
      updatedAt: now
    };
    return this.repository.createShiftType(record, this.history(context, 'shift_type_created', 'shift_type', record.id, null, null, record, input.note));
  }

  async createDutyStatus(context: PlatformActorContext, input: CreateDutyStatusInput) {
    await this.authorize(context, DUTY_PERMISSION_CODES.catalogManage, {});
    const effectiveFrom = dateKey(input.effectiveFrom, 'effective from');
    const effectiveTo = optionalDateKey(input.effectiveTo, 'effective to');
    if (effectiveTo && effectiveTo < effectiveFrom) throw new DutyError('INVALID_EFFECTIVE_PERIOD', '状态失效日期不能早于生效日期');
    const code = stableCode(input.code, 50, 'duty status code');
    const existing = await this.repository.listDutyStatuses(code);
    if (existing.some((item) => rangesOverlap(item.effectiveFrom, item.effectiveTo ?? '9999-12-31', effectiveFrom, effectiveTo ?? '9999-12-31'))) {
      throw new DutyError('DUTY_STATUS_EFFECTIVE_OVERLAP', '同一值班状态编码的生效期间重叠');
    }
    const now = this.nowIso();
    const record: DutyStatus = {
      id: uuid(input.id ?? this.createId(), 'duty status id'),
      code,
      name: text(input.name, 100, 'duty status name'),
      category: statusCategory(input.category),
      creditedMinutes: nullableMinutes(input.creditedMinutes, 'credited minutes'),
      countsAsOnDuty: booleanValue(input.countsAsOnDuty ?? false, 'counts as on duty'),
      status: recordStatus(input.status ?? 'active'),
      effectiveFrom,
      effectiveTo,
      createdAt: now,
      updatedAt: now
    };
    return this.repository.createDutyStatus(record, this.history(context, 'duty_status_created', 'duty_status', record.id, null, null, record, input.note));
  }

  async listShiftTypes(context: PlatformActorContext, code?: string) {
    await this.authorize(context, DUTY_PERMISSION_CODES.read, {});
    return this.repository.listShiftTypes(code ? stableCode(code, 50, 'shift code') : undefined);
  }

  async closeShiftTypeVersion(context: PlatformActorContext, input: CloseDutyCatalogVersionInput) {
    await this.authorize(context, DUTY_PERMISSION_CODES.catalogManage, {});
    const id = uuid(input.id, 'shift type id');
    const current = await this.repository.findShiftTypeById(id);
    if (!current) throw new DutyError('SHIFT_TYPE_NOT_FOUND', '班次不存在');
    if (current.effectiveTo !== null) throw new DutyError('CATALOG_VERSION_ALREADY_CLOSED', '班次版本已关闭');
    const effectiveTo = dateKey(input.effectiveTo, 'effective to');
    if (effectiveTo < current.effectiveFrom) throw new DutyError('INVALID_EFFECTIVE_PERIOD', '班次失效日期不能早于生效日期');
    const next = { ...current, effectiveTo, updatedAt: this.nowIso() };
    return this.repository.updateShiftType(next, this.history(context, 'shift_type_closed', 'shift_type', id, null, current, next, input.note));
  }

  async listDutyStatuses(context: PlatformActorContext, code?: string) {
    await this.authorize(context, DUTY_PERMISSION_CODES.read, {});
    return this.repository.listDutyStatuses(code ? stableCode(code, 50, 'duty status code') : undefined);
  }

  async closeDutyStatusVersion(context: PlatformActorContext, input: CloseDutyCatalogVersionInput) {
    await this.authorize(context, DUTY_PERMISSION_CODES.catalogManage, {});
    const id = uuid(input.id, 'duty status id');
    const current = await this.repository.findDutyStatusById(id);
    if (!current) throw new DutyError('DUTY_STATUS_NOT_FOUND', '值班状态不存在');
    if (current.effectiveTo !== null) throw new DutyError('CATALOG_VERSION_ALREADY_CLOSED', '值班状态版本已关闭');
    const effectiveTo = dateKey(input.effectiveTo, 'effective to');
    if (effectiveTo < current.effectiveFrom) throw new DutyError('INVALID_EFFECTIVE_PERIOD', '值班状态失效日期不能早于生效日期');
    const next = { ...current, effectiveTo, updatedAt: this.nowIso() };
    return this.repository.updateDutyStatus(next, this.history(context, 'duty_status_closed', 'duty_status', id, null, current, next, input.note));
  }

  async setCalendarDay(context: PlatformActorContext, input: SetBusinessCalendarDayInput) {
    await this.authorize(context, DUTY_PERMISSION_CODES.calendarManage, {});
    const key = dateKey(input.dateKey, 'calendar date');
    const before = await this.repository.findCalendarDay(key);
    const kind = calendarKind(input.kind);
    const holidayCode = optionalStableCode(input.holidayCode, 100, 'holiday code');
    const holidayName = optionalText(input.holidayName, 200);
    if (kind !== 'statutory_holiday' && (holidayCode || holidayName)) {
      throw new DutyError('HOLIDAY_METADATA_CONFLICT', '非法定节假日不能包含节假日信息');
    }
    const source = sourceReference(context, input.sourceAppId, input.sourceEntityId);
    const now = this.nowIso();
    const personId = context.actorType === 'person' ? context.person.id : null;
    const record: BusinessCalendarDay = {
      dateKey: key,
      kind,
      holidayCode,
      holidayName,
      sourceAppId: source.appId,
      sourceEntityId: source.entityId,
      createdByPersonId: before?.createdByPersonId ?? personId,
      updatedByPersonId: personId,
      createdAt: before?.createdAt ?? now,
      updatedAt: now
    };
    return this.repository.setCalendarDay(record, this.history(context, 'calendar_day_set', 'calendar_day', key, null, before, record, input.note));
  }

  async getCalendarDay(context: PlatformActorContext, value: string) {
    await this.authorize(context, DUTY_PERMISSION_CODES.read, {});
    return this.repository.findCalendarDay(dateKey(value, 'calendar date'));
  }

  async createPeriod(context: PlatformActorContext, input: CreateDutyPeriodInput) {
    const organizationUnitId = uuid(input.organizationUnitId, 'organization id');
    await this.authorize(context, DUTY_PERMISSION_CODES.periodManage, organizationResource(organizationUnitId));
    await this.requireActiveOrganization(organizationUnitId);
    const startDate = dateKey(input.startDate, 'period start');
    const endDate = dateKey(input.endDate, 'period end');
    if (endDate < startDate) throw new DutyError('INVALID_DUTY_PERIOD', '值班周期结束日期不能早于开始日期');
    const source = sourceReference(context, input.sourceAppId, input.sourceEntityId);
    const now = this.nowIso();
    const record: DutyPeriod = {
      id: uuid(input.id ?? this.createId(), 'duty period id'),
      organizationUnitId,
      periodKey: stableCode(input.periodKey, 100, 'period key'),
      version: positiveInteger(input.version, 'period version'),
      startDate,
      endDate,
      status: 'draft',
      sourceAppId: source.appId,
      sourceEntityId: source.entityId,
      importSha256: optionalSha256(input.importSha256),
      createdByPersonId: context.actorType === 'person' ? context.person.id : null,
      publishedByPersonId: null,
      cancelledByPersonId: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      cancelledAt: null
    };
    return this.repository.createPeriod(record, this.history(context, 'period_created', 'period', record.id, organizationUnitId, null, record, input.note));
  }

  async setAssignment(context: PlatformActorContext, input: SetDutyAssignmentInput) {
    const period = await this.requirePeriod(input.periodId);
    await this.authorize(context, DUTY_PERMISSION_CODES.assignmentManage, organizationResource(period.organizationUnitId));
    this.requireDraft(period);
    const personId = uuid(input.personId, 'person id');
    await this.requireActivePersonInOrganization(personId, period.organizationUnitId);
    const assignmentDate = dateKey(input.dateKey, 'assignment date');
    if (assignmentDate < period.startDate || assignmentDate > period.endDate) {
      throw new DutyError('ASSIGNMENT_OUTSIDE_PERIOD', '值班指派日期不在周期内');
    }
    const hasShift = Boolean(input.shiftTypeId);
    const hasStatus = Boolean(input.dutyStatusId);
    if (hasShift === hasStatus) throw new DutyError('ASSIGNMENT_TARGET_REQUIRED', '必须且只能指定班次或非值班状态');
    const shift = hasShift ? await this.requireEffectiveShiftType(input.shiftTypeId!, assignmentDate) : null;
    const status = hasStatus ? await this.requireEffectiveDutyStatus(input.dutyStatusId!, assignmentDate) : null;
    const existing = await this.repository.findAssignment(period.id, personId, assignmentDate);
    const now = this.nowIso();
    const record: DutyAssignment = {
      id: existing?.id ?? uuid(input.id ?? this.createId(), 'duty assignment id'),
      periodId: period.id,
      organizationUnitId: period.organizationUnitId,
      personId,
      dateKey: assignmentDate,
      kind: shift ? 'shift' : 'status',
      shiftTypeId: shift?.id ?? null,
      dutyStatusId: status?.id ?? null,
      codeSnapshot: shift?.code ?? status!.code,
      nameSnapshot: shift?.name ?? status!.name,
      creditedMinutesSnapshot: shift?.creditedMinutes ?? status?.creditedMinutes ?? null,
      origin: assignmentOrigin(input.origin ?? 'manual'),
      createdByPersonId: existing?.createdByPersonId ?? (context.actorType === 'person' ? context.person.id : null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    return this.repository.setAssignment(record, this.history(context, 'assignment_set', 'assignment', record.id, period.organizationUnitId, existing, record, input.note));
  }

  async publishPeriod(context: PlatformActorContext, periodId: string, note?: string | null) {
    const period = await this.requirePeriod(periodId);
    await this.authorize(context, DUTY_PERMISSION_CODES.periodManage, organizationResource(period.organizationUnitId));
    this.requireDraft(period);
    const assignments = await this.repository.listAssignments(period.id);
    if (assignments.length === 0) throw new DutyError('DUTY_PERIOD_EMPTY', '空值班周期不能发布');
    await this.requireActiveOrganization(period.organizationUnitId);
    await Promise.all(assignments.map(async (assignment) => {
      await this.requireActivePersonInOrganization(assignment.personId, period.organizationUnitId);
      if (assignment.kind === 'shift') {
        await this.requireEffectiveShiftType(assignment.shiftTypeId!, assignment.dateKey);
      } else {
        await this.requireEffectiveDutyStatus(assignment.dutyStatusId!, assignment.dateKey);
      }
    }));
    await this.assertDutyWindowsDoNotOverlap(assignments, [], 'DUTY_ASSIGNMENT_TIME_OVERLAP', '同一人员存在时间重叠的班次');
    const overlaps = await this.repository.listPublishedPeriodsOverlapping(period.organizationUnitId, period.startDate, period.endDate);
    if (overlaps.some((item) => item.id !== period.id)) throw new DutyError('PUBLISHED_DUTY_PERIOD_OVERLAP', '同组织已有重叠的已发布周期');
    const now = this.nowIso();
    const next: DutyPeriod = {
      ...period,
      status: 'published',
      publishedByPersonId: context.actorType === 'person' ? context.person.id : null,
      updatedAt: now,
      publishedAt: now
    };
    return this.repository.updatePeriod(next, this.history(context, 'period_published', 'period', period.id, period.organizationUnitId, period, next, note));
  }

  async cancelPeriod(context: PlatformActorContext, periodId: string, note?: string | null) {
    const period = await this.requirePeriod(periodId);
    await this.authorize(context, DUTY_PERMISSION_CODES.periodManage, organizationResource(period.organizationUnitId));
    if (period.status === 'cancelled') return period;
    const now = this.nowIso();
    const next: DutyPeriod = {
      ...period,
      status: 'cancelled',
      cancelledByPersonId: context.actorType === 'person' ? context.person.id : null,
      updatedAt: now,
      cancelledAt: now
    };
    return this.repository.updatePeriod(next, this.history(context, 'period_cancelled', 'period', period.id, period.organizationUnitId, period, next, note));
  }

  async proposeReplacement(context: PlatformActorContext, input: ProposeTemporaryReplacementInput) {
    const original = await this.requireAssignment(input.originalAssignmentId);
    const period = await this.requirePeriod(original.periodId);
    await this.authorize(context, DUTY_PERMISSION_CODES.replacementManage, organizationResource(period.organizationUnitId));
    if (period.status !== 'published') throw new DutyError('PUBLISHED_PERIOD_REQUIRED', '只能对已发布排班提出替班');
    if (original.kind !== 'shift') throw new DutyError('WORKING_SHIFT_REQUIRED', '非值班状态不能创建替班');
    const substitutePersonId = uuid(input.substitutePersonId, 'substitute person id');
    await this.requireActivePersonInOrganization(substitutePersonId, period.organizationUnitId);
    if (substitutePersonId === original.personId) throw new DutyError('SAME_REPLACEMENT_PERSON', '替班人员不能与原人员相同');
    const replacementShift = input.replacementShiftTypeId
      ? await this.requireEffectiveShiftType(input.replacementShiftTypeId, original.dateKey)
      : null;
    const returnAssignment = input.returnAssignmentId ? await this.requireAssignment(input.returnAssignmentId) : null;
    if (returnAssignment) {
      if (returnAssignment.organizationUnitId !== period.organizationUnitId || returnAssignment.periodId !== period.id) {
        throw new DutyError('RETURN_ASSIGNMENT_SCOPE_MISMATCH', '还班指派不属于同一组织和值班周期');
      }
      if (returnAssignment.personId !== substitutePersonId) throw new DutyError('RETURN_ASSIGNMENT_PERSON_MISMATCH', '还班指派必须属于替班人员');
      if (returnAssignment.kind !== 'shift') throw new DutyError('RETURN_WORKING_SHIFT_REQUIRED', '还班指派必须是工作班次');
    }
    const source = sourceReference(context, input.sourceAppId, input.sourceEntityId);
    const now = this.nowIso();
    const record: TemporaryReplacement = {
      id: uuid(input.id ?? this.createId(), 'replacement id'),
      originalAssignmentId: original.id,
      returnAssignmentId: returnAssignment?.id ?? null,
      organizationUnitId: period.organizationUnitId,
      absentPersonId: original.personId,
      substitutePersonId,
      replacementShiftTypeId: replacementShift?.id ?? null,
      status: 'proposed',
      reason: optionalText(input.reason, 2_000),
      sourceAppId: source.appId,
      sourceEntityId: source.entityId,
      createdByPersonId: context.actorType === 'person' ? context.person.id : null,
      approvedByPersonId: null,
      cancelledByPersonId: null,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      cancelledAt: null
    };
    await this.validateReplacement(record, period, original, returnAssignment);
    return this.repository.createReplacement(record, this.history(context, 'replacement_proposed', 'replacement', record.id, period.organizationUnitId, null, record, input.note));
  }

  async approveReplacement(context: PlatformActorContext, replacementId: string, note?: string | null) {
    const record = await this.requireReplacement(replacementId);
    await this.authorize(context, DUTY_PERMISSION_CODES.replacementManage, organizationResource(record.organizationUnitId));
    if (record.status !== 'proposed') throw new DutyError('PROPOSED_REPLACEMENT_REQUIRED', '只有待审批替班可以批准');
    const original = await this.requireAssignment(record.originalAssignmentId);
    const period = await this.requirePeriod(original.periodId);
    const returnAssignment = record.returnAssignmentId ? await this.requireAssignment(record.returnAssignmentId) : null;
    await this.validateReplacement(record, period, original, returnAssignment);
    const now = this.nowIso();
    const next: TemporaryReplacement = {
      ...record,
      status: 'approved',
      approvedByPersonId: context.actorType === 'person' ? context.person.id : null,
      updatedAt: now,
      approvedAt: now
    };
    return this.repository.updateReplacement(next, this.history(context, 'replacement_approved', 'replacement', record.id, record.organizationUnitId, record, next, note));
  }

  async cancelReplacement(context: PlatformActorContext, replacementId: string, note?: string | null) {
    const record = await this.requireReplacement(replacementId);
    await this.authorize(context, DUTY_PERMISSION_CODES.replacementManage, organizationResource(record.organizationUnitId));
    if (record.status === 'cancelled') return record;
    const now = this.nowIso();
    const next: TemporaryReplacement = {
      ...record,
      status: 'cancelled',
      cancelledByPersonId: context.actorType === 'person' ? context.person.id : null,
      updatedAt: now,
      cancelledAt: now
    };
    return this.repository.updateReplacement(next, this.history(context, 'replacement_cancelled', 'replacement', record.id, record.organizationUnitId, record, next, note));
  }

  async listPeriods(context: PlatformActorContext, organizationUnitId: string, status?: DutyPeriod['status']) {
    const organizationId = uuid(organizationUnitId, 'organization id');
    await this.authorize(context, DUTY_PERMISSION_CODES.read, organizationResource(organizationId));
    return this.repository.listPeriods({ organizationUnitId: organizationId, status, limit: 500 });
  }

  async listAssignments(context: PlatformActorContext, periodId: string, assignmentDate?: string) {
    const period = await this.requirePeriod(periodId);
    await this.authorize(context, DUTY_PERMISSION_CODES.read, organizationResource(period.organizationUnitId));
    const date = assignmentDate ? dateKey(assignmentDate, 'assignment date') : undefined;
    return this.repository.listAssignments(period.id, date);
  }

  async listReplacements(context: PlatformActorContext, periodId: string) {
    const period = await this.requirePeriod(periodId);
    await this.authorize(context, DUTY_PERMISSION_CODES.read, organizationResource(period.organizationUnitId));
    return this.repository.listReplacementsForPeriod(period.id);
  }

  async resolveDutyAt(context: PlatformActorContext, organizationUnitId: string, instant: Date): Promise<ResolvedDuty[]> {
    const organizationId = uuid(organizationUnitId, 'organization id');
    await this.authorize(context, DUTY_PERMISSION_CODES.read, organizationResource(organizationId));
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) throw new DutyError('INVALID_DUTY_INSTANT', '值班查询时间无效');
    const currentDate = getPlatformDateKey(instant);
    const previousDate = addPlatformDays(currentDate, -1);
    const periods = uniqueById(await this.repository.listPublishedPeriodsOverlapping(organizationId, previousDate, currentDate));
    assertNoPeriodOverlap(periods, previousDate, currentDate);
    const resolved: ResolvedDuty[] = [];
    for (const period of periods) {
      const replacements = (await this.repository.listReplacementsForPeriod(period.id)).filter((item) => item.status === 'approved');
      for (const assignmentDate of [previousDate, currentDate]) {
        if (assignmentDate < period.startDate || assignmentDate > period.endDate) continue;
        for (const assignment of await this.repository.listAssignments(period.id, assignmentDate)) {
          const duty = await this.resolveAssignmentAt(assignment, replacements, instant);
          if (duty) resolved.push(duty);
        }
      }
    }
    return resolved.sort((left, right) => left.effectivePersonId.localeCompare(right.effectivePersonId) || left.assignment.id.localeCompare(right.assignment.id));
  }

  async getCurrentDutyContext(context: PlatformActorContext, organizationUnitId: string, instant = this.clock.now()) {
    const duties = await this.resolveDutyAt(context, organizationUnitId, instant);
    return {
      organizationUnitId: uuid(organizationUnitId, 'organization id'),
      platformDate: getPlatformDateKey(instant),
      instant: instant.toISOString(),
      duties,
      onDutyPersonIds: [...new Set(duties.filter((item) => item.countsAsOnDuty).map((item) => item.effectivePersonId))]
    };
  }

  private async resolveAssignmentAt(
    assignment: DutyAssignment,
    replacements: TemporaryReplacement[],
    instant: Date
  ): Promise<ResolvedDuty | null> {
    const outgoing = replacements.find((item) => item.originalAssignmentId === assignment.id);
    const returning = replacements.find((item) => item.returnAssignmentId === assignment.id);
    const effectivePersonId = outgoing?.substitutePersonId ?? returning?.absentPersonId ?? assignment.personId;
    if (assignment.kind === 'status') {
      if (assignment.dateKey !== getPlatformDateKey(instant)) return null;
      const status = await this.repository.findDutyStatusById(assignment.dutyStatusId!);
      if (!status || !isDutyCatalogEffective(status, assignment.dateKey)) return null;
      return resolvedDuty(assignment, effectivePersonId, outgoing?.id ?? returning?.id ?? null, null, status, null, null);
    }
    const shiftId = outgoing?.replacementShiftTypeId ?? assignment.shiftTypeId;
    const shift = shiftId ? await this.repository.findShiftTypeById(shiftId) : null;
    if (!shift || !isDutyCatalogEffective(shift, assignment.dateKey)) return null;
    const { startsAt, endsAt } = getDutyShiftWindow(assignment.dateKey, shift);
    if (instant.getTime() < startsAt.getTime() || instant.getTime() >= endsAt.getTime()) return null;
    return resolvedDuty(assignment, effectivePersonId, outgoing?.id ?? returning?.id ?? null, shift, null, startsAt.toISOString(), endsAt.toISOString());
  }

  private async requirePeriod(value: string) {
    const record = await this.repository.findPeriodById(uuid(value, 'period id'));
    if (!record) throw new DutyError('DUTY_PERIOD_NOT_FOUND', '值班周期不存在');
    return record;
  }

  private async requireAssignment(value: string) {
    const record = await this.repository.findAssignmentById(uuid(value, 'assignment id'));
    if (!record) throw new DutyError('DUTY_ASSIGNMENT_NOT_FOUND', '值班指派不存在');
    return record;
  }

  private async requireReplacement(value: string) {
    const record = await this.repository.findReplacementById(uuid(value, 'replacement id'));
    if (!record) throw new DutyError('DUTY_REPLACEMENT_NOT_FOUND', '替班记录不存在');
    return record;
  }

  private async requireEffectiveShiftType(value: string, date: string) {
    const record = await this.repository.findShiftTypeById(uuid(value, 'shift type id'));
    if (!record) throw new DutyError('SHIFT_TYPE_NOT_FOUND', '班次不存在');
    if (!isDutyCatalogEffective(record, date)) throw new DutyError('SHIFT_TYPE_INACTIVE', '班次在指派日期未生效');
    return record;
  }

  private async requireEffectiveDutyStatus(value: string, date: string) {
    const record = await this.repository.findDutyStatusById(uuid(value, 'duty status id'));
    if (!record) throw new DutyError('DUTY_STATUS_NOT_FOUND', '值班状态不存在');
    if (!isDutyCatalogEffective(record, date)) throw new DutyError('DUTY_STATUS_INACTIVE', '值班状态在指派日期未生效');
    return record;
  }

  private async validateReplacement(
    record: TemporaryReplacement,
    period: DutyPeriod,
    original: DutyAssignment,
    returnAssignment: DutyAssignment | null
  ) {
    if (period.status !== 'published') throw new DutyError('PUBLISHED_PERIOD_REQUIRED', '只能对已发布排班执行替班');
    if (original.periodId !== period.id || original.organizationUnitId !== period.organizationUnitId || original.kind !== 'shift') {
      throw new DutyError('REPLACEMENT_ORIGINAL_SCOPE_MISMATCH', '替班原指派与值班周期不一致');
    }
    if (record.organizationUnitId !== period.organizationUnitId || record.absentPersonId !== original.personId) {
      throw new DutyError('REPLACEMENT_SCOPE_MISMATCH', '替班记录与原指派范围不一致');
    }
    await this.requireActivePersonInOrganization(record.absentPersonId, period.organizationUnitId);
    await this.requireActivePersonInOrganization(record.substitutePersonId, period.organizationUnitId);
    await this.requireEffectiveShiftType(record.replacementShiftTypeId ?? original.shiftTypeId!, original.dateKey);
    if (returnAssignment) {
      if (returnAssignment.periodId !== period.id || returnAssignment.organizationUnitId !== period.organizationUnitId) {
        throw new DutyError('RETURN_ASSIGNMENT_SCOPE_MISMATCH', '还班指派不属于同一组织和值班周期');
      }
      if (returnAssignment.personId !== record.substitutePersonId) throw new DutyError('RETURN_ASSIGNMENT_PERSON_MISMATCH', '还班指派必须属于替班人员');
      if (returnAssignment.kind !== 'shift') throw new DutyError('RETURN_WORKING_SHIFT_REQUIRED', '还班指派必须是工作班次');
      await this.requireEffectiveShiftType(returnAssignment.shiftTypeId!, returnAssignment.dateKey);
    }
    const active = (await this.repository.listReplacementsForPeriod(period.id))
      .filter((item) => item.status !== 'cancelled' && item.id !== record.id);
    if (active.some((item) => item.originalAssignmentId === record.originalAssignmentId)) {
      throw new DutyError('ACTIVE_REPLACEMENT_CONFLICT', '原排班已有生效中的替班记录');
    }
    if (active.some((item) =>
      item.returnAssignmentId === record.originalAssignmentId
      || (record.returnAssignmentId !== null
        && (item.originalAssignmentId === record.returnAssignmentId || item.returnAssignmentId === record.returnAssignmentId)))) {
      throw new DutyError('REPLACEMENT_ASSIGNMENT_CONFLICT', '原指派或还班指派已被其他替班占用');
    }
    const assignments = await this.repository.listAssignments(period.id);
    await this.assertDutyWindowsDoNotOverlap(
      assignments,
      [...active, record],
      'DUTY_REPLACEMENT_TIME_OVERLAP',
      '替班后同一人员存在时间重叠的班次'
    );
  }

  private async assertDutyWindowsDoNotOverlap(
    assignments: DutyAssignment[],
    replacements: TemporaryReplacement[],
    code: string,
    message: string
  ) {
    const shiftIds = new Set<string>();
    for (const assignment of assignments) if (assignment.kind === 'shift' && assignment.shiftTypeId) shiftIds.add(assignment.shiftTypeId);
    for (const replacement of replacements) if (replacement.replacementShiftTypeId) shiftIds.add(replacement.replacementShiftTypeId);
    const shifts = new Map<string, ShiftType>();
    await Promise.all([...shiftIds].map(async (id) => {
      const shift = await this.repository.findShiftTypeById(id);
      if (!shift) throw new DutyError('SHIFT_TYPE_NOT_FOUND', '班次不存在');
      shifts.set(id, shift);
    }));
    assertDutyWindowsDoNotOverlap(assignments, [...shifts.values()], replacements, code, message);
  }

  private async requireActiveOrganization(id: string) {
    const record = await this.options.findOrganizationUnit(id);
    if (!record) throw new DutyError('ORGANIZATION_NOT_FOUND', '组织不存在');
    if (record.status !== 'active') throw new DutyError('ORGANIZATION_INACTIVE', '组织未启用');
  }

  private async requireActivePersonInOrganization(id: string, organizationId: string) {
    const record = await this.options.findPerson(id);
    if (!record) throw new DutyError('PERSON_NOT_FOUND', '人员不存在');
    if (record.employmentStatus !== 'active') throw new DutyError('PERSON_INACTIVE', '人员不在岗');
    if (record.organizationUnitId !== organizationId) throw new DutyError('PERSON_ORGANIZATION_MISMATCH', '人员不属于值班周期组织');
  }

  private requireDraft(period: DutyPeriod) {
    if (period.status !== 'draft') throw new DutyError('DRAFT_DUTY_PERIOD_REQUIRED', '已发布或已取消排班不可直接修改');
  }

  private async authorize(context: PlatformActorContext, permission: string, resource: AuthorizationResource) {
    if (!(await context.authorize(permission, resource)).allowed) throw new DutyError('DUTY_PERMISSION_DENIED', `缺少权限: ${permission}`);
  }

  private history(
    context: PlatformActorContext,
    operation: DutyOperation,
    entityType: DutyOperationHistory['entityType'],
    entityId: string,
    organizationUnitId: string | null,
    before: unknown,
    after: unknown,
    note: string | null | undefined
  ): DutyOperationHistory {
    return {
      id: uuid(this.createId(), 'duty history id'),
      operation,
      entityType,
      entityId,
      organizationUnitId,
      actorType: context.actorType,
      actorPersonId: context.actorType === 'person' ? context.person.id : null,
      serviceIdentityId: context.actorType === 'service' ? context.execution.serviceIdentityId : null,
      executionType: context.execution.type,
      sourceAppId: context.execution.type === 'platform' ? null : context.execution.appId,
      requestId: context.request.requestId,
      traceId: context.request.traceId,
      note: optionalText(note, 2_000),
      before: plainObjectOrNull(before),
      after: plainObjectOrNull(after),
      occurredAt: this.nowIso()
    };
  }

  private nowIso() { return this.clock.now().toISOString(); }
}

export function createDutyService(repository: DutyRepository, options: DutyServiceOptions) {
  return new DutyService(repository, options);
}

export function reconcileLegacyDutyEvidence(snapshot: LegacyDutyEvidenceSnapshot): LegacyDutyReconciliation {
  const roster = snapshot.standardRoster;
  const issues: LegacyDutyReconciliation['issues'] = [];
  const knownShifts = new Map<string, typeof STANDARD_SHIFT_TYPE_SEEDS[number]>(STANDARD_SHIFT_TYPE_SEEDS.map((item) => [item.code, item]));
  const knownStatuses = new Map<string, typeof STANDARD_DUTY_STATUS_SEEDS[number]>(STANDARD_DUTY_STATUS_SEEDS.map((item) => [item.code, item]));
  const people = roster?.people ?? [];
  const dates = roster?.dateKeys ?? [];
  const cells = roster?.cells ?? [];
  for (const person of people) {
    if (!person.personId) issues.push({ code: 'UNRESOLVED_PERSON', sourceId: person.sourcePersonKey });
  }
  for (const catalog of roster?.catalog ?? []) {
    const expected = knownShifts.get(catalog.code);
    if (!expected || expected.startMinute !== catalog.startMinute || expected.endMinute !== catalog.endMinute || expected.crossesMidnight !== catalog.crossesMidnight) {
      issues.push({ code: 'CATALOG_DEFINITION_MISMATCH', sourceId: `${roster!.sourceId}:catalog:${catalog.code}`, value: catalog.code });
    } else if (expected.creditedMinutes !== catalog.creditedMinutes) {
      issues.push({ code: 'CREDITED_MINUTES_MISMATCH', sourceId: `${roster!.sourceId}:catalog:${catalog.code}`, value: catalog.code });
    }
  }
  const cellKeys = new Set<string>();
  for (const cell of cells) {
    const key = `${cell.sourcePersonKey}\u0000${cell.dateKey}`;
    if (cellKeys.has(key)) issues.push({ code: 'DUPLICATE_ASSIGNMENT_CELL', sourceId: key });
    cellKeys.add(key);
    const expected = knownShifts.get(cell.code) ?? knownStatuses.get(cell.code);
    if (!expected) issues.push({ code: 'UNKNOWN_DUTY_CODE', sourceId: key, value: cell.code });
    else if (expected.creditedMinutes !== cell.creditedMinutes) issues.push({ code: 'CREDITED_MINUTES_MISMATCH', sourceId: key, value: cell.code });
  }
  for (const person of people) {
    for (const date of dates) {
      const key = `${person.sourcePersonKey}\u0000${date}`;
      if (!cellKeys.has(key)) issues.push({ code: 'MISSING_ASSIGNMENT_CELL', sourceId: key });
    }
  }
  for (const entry of snapshot.schedulingEntries ?? []) {
    const expected = entry.code === 'A2' ? 'night' : entry.code === 'A1' || entry.code === 'A3' ? 'day' : null;
    if (expected && entry.shift !== expected) issues.push({ code: 'SCHEDULING_SHIFT_MISMATCH', sourceId: entry.sourceId, value: entry.code ?? '' });
  }
  for (const code of snapshot.adjustmentShiftCodes ?? []) {
    if (!['A1', 'A2', 'A3'].includes(code)) issues.push({ code: 'UNKNOWN_ADJUSTMENT_SHIFT', sourceId: `adjustment:${code}`, value: code });
  }
  for (const field of roster?.excludedFieldNames ?? []) {
    issues.push({ code: 'EXTERNAL_SUMMARY_FIELD', sourceId: roster!.sourceId, value: field });
  }
  return {
    peopleCount: people.length,
    dateCount: dates.length,
    expectedCellCount: people.length * dates.length,
    assignmentCellCount: cells.length,
    schedulingEntryCount: snapshot.schedulingEntries?.length ?? 0,
    handoverRecordCount: snapshot.handoverRecords?.length ?? 0,
    adjustmentShiftCodeCount: snapshot.adjustmentShiftCodes?.length ?? 0,
    issues
  };
}

function resolvedDuty(
  assignment: DutyAssignment,
  effectivePersonId: string,
  replacementId: string | null,
  shiftType: ShiftType | null,
  dutyStatus: DutyStatus | null,
  startsAt: string | null,
  endsAt: string | null
): ResolvedDuty {
  return {
    assignment,
    scheduledPersonId: assignment.personId,
    effectivePersonId,
    replacementId,
    assignmentDate: assignment.dateKey,
    code: shiftType?.code ?? dutyStatus?.code ?? assignment.codeSnapshot,
    name: shiftType?.name ?? dutyStatus?.name ?? assignment.nameSnapshot,
    kind: assignment.kind,
    shiftType,
    dutyStatus,
    startsAt,
    endsAt,
    countsAsOnDuty: shiftType ? true : dutyStatus?.countsAsOnDuty ?? false
  };
}

function platformInstant(date: string, minuteOfDay: number) {
  const [year, month, day] = date.split('-').map(Number);
  return toPlatformInstant({ year, month, day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 });
}

function assertNoPeriodOverlap(periods: DutyPeriod[], start: string, end: string) {
  for (const date of [start, end]) {
    if (periods.filter((item) => item.startDate <= date && item.endDate >= date).length > 1) {
      throw new DutyError('PUBLISHED_DUTY_PERIOD_OVERLAP', '同一日期存在多个已发布周期');
    }
  }
}

function uniqueById<T extends { id: string }>(records: T[]) {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function sourceReference(context: PlatformActorContext, appValue: string | null | undefined, entityValue: string | null | undefined) {
  const app = appValue ? appId(appValue) : context.execution.type === 'platform' ? null : context.execution.appId;
  if (context.execution.type !== 'platform' && app !== context.execution.appId) throw new DutyError('SOURCE_APP_MISMATCH', '执行上下文与来源应用不一致');
  return { appId: app, entityId: optionalText(entityValue, 200) };
}

function organizationResource(id: string): AuthorizationResource {
  return { organizationUnitId: id, targets: [{ type: 'organization', id }] };
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string) { return aStart <= bEnd && bStart <= aEnd; }
function dutyClass(value: DutyClass) { if (!['day', 'night', 'other'].includes(value)) throw new DutyError('INVALID_DUTY_CLASS', '班次分类无效'); return value; }
function recordStatus(value: DutyRecordStatus) { if (!['active', 'inactive'].includes(value)) throw new DutyError('INVALID_DUTY_STATUS', '目录状态无效'); return value; }
function statusCategory(value: DutyStatusCategory) { if (!['rest', 'leave', 'training', 'absence', 'other'].includes(value)) throw new DutyError('INVALID_DUTY_STATUS_CATEGORY', '值班状态分类无效'); return value; }
function calendarKind(value: BusinessCalendarDayKind) { if (!['working_day', 'rest_day', 'statutory_holiday', 'adjusted_workday'].includes(value)) throw new DutyError('INVALID_CALENDAR_KIND', '业务日历类型无效'); return value; }
function assignmentOrigin(value: DutyAssignment['origin']) { if (!['imported', 'manual'].includes(value)) throw new DutyError('INVALID_ASSIGNMENT_ORIGIN', '指派来源无效'); return value; }
function minute(value: number, label: string) { if (!Number.isSafeInteger(value) || value < 0 || value > 1439) throw new DutyError('INVALID_MINUTE_OF_DAY', `${label} 无效`); return value; }
function nullableMinutes(value: number | null | undefined, label: string) { if (value === null || value === undefined) return null; if (!Number.isSafeInteger(value) || value < 0 || value > 1440) throw new DutyError('INVALID_CREDITED_MINUTES', `${label} 无效`); return value; }
function positiveInteger(value: number, label: string) { if (!Number.isSafeInteger(value) || value <= 0) throw new DutyError('INVALID_POSITIVE_INTEGER', `${label} 无效`); return value; }
function booleanValue(value: unknown, label: string) { if (typeof value !== 'boolean') throw new DutyError('INVALID_BOOLEAN', `${label} 无效`); return value; }
function optionalSha256(value: string | null | undefined) { const normalized = optionalText(value, 64); if (normalized && !/^[0-9a-f]{64}$/i.test(normalized)) throw new DutyError('INVALID_SHA256', '导入文件 SHA-256 无效'); return normalized?.toLowerCase() ?? null; }
function dateKey(value: string, label: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DutyError('INVALID_DATE_KEY', `${label} 无效`);
  try { platformInstant(value, 0); } catch { throw new DutyError('INVALID_DATE_KEY', `${label} 无效`); }
  return value;
}
function optionalDateKey(value: string | null | undefined, label: string) { return value ? dateKey(value, label) : null; }
function stableCode(value: unknown, max: number, label: string) { const normalized = text(value, max, label); if (!/^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9_.:\-\u4e00-\u9fff]*$/.test(normalized)) throw new DutyError('INVALID_STABLE_CODE', `${label} 格式无效`); return normalized; }
function optionalStableCode(value: unknown, max: number, label: string) { const normalized = optionalText(value, max); return normalized ? stableCode(normalized, max, label) : null; }
function appId(value: string) { if (!/^[a-z][a-z0-9_-]{1,98}[a-z0-9]$/.test(value)) throw new DutyError('INVALID_APP_ID', '应用 ID 无效'); return value; }
function text(value: unknown, max: number, label: string) { if (typeof value !== 'string') throw new DutyError('INVALID_TEXT', `${label} 必须是字符串`); const normalized = value.trim(); if (!normalized) throw new DutyError('TEXT_REQUIRED', `${label} 不能为空`); if (normalized.length > max) throw new DutyError('TEXT_TOO_LONG', `${label} 超过长度限制`); return normalized; }
function optionalText(value: unknown, max: number) { if (value === null || value === undefined) return null; if (typeof value !== 'string') throw new DutyError('INVALID_TEXT', '可选文本必须是字符串'); const normalized = value.trim(); if (!normalized) return null; if (normalized.length > max) throw new DutyError('TEXT_TOO_LONG', '可选文本超过长度限制'); return normalized; }
function uuid(value: unknown, label: string) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())) throw new DutyError('INVALID_UUID', `${label} 无效`); return value.trim().toLowerCase(); }
function plainObjectOrNull(value: unknown) { if (value === null || value === undefined) return null; return structuredClone(value) as Record<string, unknown>; }
