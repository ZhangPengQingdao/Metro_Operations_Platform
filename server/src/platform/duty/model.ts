export const DUTY_PERMISSION_SEEDS = [
  { id: '51000000-0000-4000-8000-000000000001', code: 'platform.duty.read', name: '查看业务日历与值班' },
  { id: '51000000-0000-4000-8000-000000000002', code: 'platform.duty.catalog.manage', name: '管理班次与值班状态目录' },
  { id: '51000000-0000-4000-8000-000000000003', code: 'platform.duty.calendar.manage', name: '管理业务日历' },
  { id: '51000000-0000-4000-8000-000000000004', code: 'platform.duty.period.manage', name: '管理值班周期' },
  { id: '51000000-0000-4000-8000-000000000005', code: 'platform.duty.assignment.manage', name: '管理值班指派' },
  { id: '51000000-0000-4000-8000-000000000006', code: 'platform.duty.replacement.manage', name: '管理临时替班' }
] as const;

export const DUTY_PERMISSION_CODES = {
  read: 'platform.duty.read',
  catalogManage: 'platform.duty.catalog.manage',
  calendarManage: 'platform.duty.calendar.manage',
  periodManage: 'platform.duty.period.manage',
  assignmentManage: 'platform.duty.assignment.manage',
  replacementManage: 'platform.duty.replacement.manage'
} as const;

export const STANDARD_SHIFT_TYPE_SEEDS = [
  { id: '51000000-0000-4000-8000-000000000101', code: 'A1', name: 'A1', startMinute: 510, endMinute: 1170, crossesMidnight: false, creditedMinutes: 600, dutyClass: 'day' },
  { id: '51000000-0000-4000-8000-000000000102', code: 'A2', name: 'A2', startMinute: 1140, endMinute: 540, crossesMidnight: true, creditedMinutes: 720, dutyClass: 'night' },
  { id: '51000000-0000-4000-8000-000000000103', code: 'A3', name: 'A3', startMinute: 510, endMinute: 1050, crossesMidnight: false, creditedMinutes: 480, dutyClass: 'day' },
  { id: '51000000-0000-4000-8000-000000000104', code: '早班', name: '早班', startMinute: 420, endMinute: 900, crossesMidnight: false, creditedMinutes: null, dutyClass: 'day' },
  { id: '51000000-0000-4000-8000-000000000105', code: '晚班', name: '晚班', startMinute: 900, endMinute: 1320, crossesMidnight: false, creditedMinutes: null, dutyClass: 'other' },
  { id: '51000000-0000-4000-8000-000000000106', code: '常白班', name: '常白班', startMinute: 540, endMinute: 1050, crossesMidnight: false, creditedMinutes: null, dutyClass: 'day' }
] as const;

export const STANDARD_DUTY_STATUS_SEEDS = [
  { id: '51000000-0000-4000-8000-000000000201', code: '休', name: '休', category: 'rest', creditedMinutes: 0, countsAsOnDuty: false },
  { id: '51000000-0000-4000-8000-000000000202', code: '婚', name: '婚假', category: 'leave', creditedMinutes: 480, countsAsOnDuty: false }
] as const;

export type DutyRecordStatus = 'active' | 'inactive';
export type DutyClass = 'day' | 'night' | 'other';
export type DutyStatusCategory = 'rest' | 'leave' | 'training' | 'absence' | 'other';
export type BusinessCalendarDayKind = 'working_day' | 'rest_day' | 'statutory_holiday' | 'adjusted_workday';
export type DutyPeriodStatus = 'draft' | 'published' | 'cancelled';
export type DutyAssignmentKind = 'shift' | 'status';
export type DutyAssignmentOrigin = 'imported' | 'manual';
export type TemporaryReplacementStatus = 'proposed' | 'approved' | 'cancelled';
export type DutyOperation =
  | 'shift_type_created'
  | 'shift_type_closed'
  | 'duty_status_created'
  | 'duty_status_closed'
  | 'calendar_day_set'
  | 'period_created'
  | 'assignment_set'
  | 'period_published'
  | 'period_cancelled'
  | 'replacement_proposed'
  | 'replacement_approved'
  | 'replacement_cancelled';

export interface ShiftType {
  id: string;
  code: string;
  name: string;
  startMinute: number;
  endMinute: number;
  crossesMidnight: boolean;
  creditedMinutes: number | null;
  dutyClass: DutyClass;
  status: DutyRecordStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DutyStatus {
  id: string;
  code: string;
  name: string;
  category: DutyStatusCategory;
  creditedMinutes: number | null;
  countsAsOnDuty: boolean;
  status: DutyRecordStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessCalendarDay {
  dateKey: string;
  kind: BusinessCalendarDayKind;
  holidayCode: string | null;
  holidayName: string | null;
  sourceAppId: string | null;
  sourceEntityId: string | null;
  createdByPersonId: string | null;
  updatedByPersonId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DutyPeriod {
  id: string;
  organizationUnitId: string;
  periodKey: string;
  version: number;
  startDate: string;
  endDate: string;
  status: DutyPeriodStatus;
  sourceAppId: string | null;
  sourceEntityId: string | null;
  importSha256: string | null;
  createdByPersonId: string | null;
  publishedByPersonId: string | null;
  cancelledByPersonId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  cancelledAt: string | null;
}

export interface DutyAssignment {
  id: string;
  periodId: string;
  organizationUnitId: string;
  personId: string;
  dateKey: string;
  kind: DutyAssignmentKind;
  shiftTypeId: string | null;
  dutyStatusId: string | null;
  codeSnapshot: string;
  nameSnapshot: string;
  creditedMinutesSnapshot: number | null;
  origin: DutyAssignmentOrigin;
  createdByPersonId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemporaryReplacement {
  id: string;
  originalAssignmentId: string;
  returnAssignmentId: string | null;
  organizationUnitId: string;
  absentPersonId: string;
  substitutePersonId: string;
  replacementShiftTypeId: string | null;
  status: TemporaryReplacementStatus;
  reason: string | null;
  sourceAppId: string | null;
  sourceEntityId: string | null;
  createdByPersonId: string | null;
  approvedByPersonId: string | null;
  cancelledByPersonId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  cancelledAt: string | null;
}

export interface DutyOperationHistory {
  id: string;
  operation: DutyOperation;
  entityType: 'shift_type' | 'duty_status' | 'calendar_day' | 'period' | 'assignment' | 'replacement';
  entityId: string;
  organizationUnitId: string | null;
  actorType: 'person' | 'service';
  actorPersonId: string | null;
  serviceIdentityId: string | null;
  executionType: 'platform' | 'application' | 'service';
  sourceAppId: string | null;
  requestId: string | null;
  traceId: string | null;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}

export interface ResolvedDuty {
  assignment: DutyAssignment;
  scheduledPersonId: string;
  effectivePersonId: string;
  replacementId: string | null;
  assignmentDate: string;
  code: string;
  name: string;
  kind: DutyAssignmentKind;
  shiftType: ShiftType | null;
  dutyStatus: DutyStatus | null;
  startsAt: string | null;
  endsAt: string | null;
  countsAsOnDuty: boolean;
}

export interface CreateShiftTypeInput {
  id?: string;
  code: string;
  name: string;
  startMinute: number;
  endMinute: number;
  crossesMidnight: boolean;
  creditedMinutes?: number | null;
  dutyClass: DutyClass;
  status?: DutyRecordStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
  note?: string | null;
}

export interface CreateDutyStatusInput {
  id?: string;
  code: string;
  name: string;
  category: DutyStatusCategory;
  creditedMinutes?: number | null;
  countsAsOnDuty?: boolean;
  status?: DutyRecordStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
  note?: string | null;
}

export interface CloseDutyCatalogVersionInput {
  id: string;
  effectiveTo: string;
  note?: string | null;
}

export interface SetBusinessCalendarDayInput {
  dateKey: string;
  kind: BusinessCalendarDayKind;
  holidayCode?: string | null;
  holidayName?: string | null;
  sourceAppId?: string | null;
  sourceEntityId?: string | null;
  note?: string | null;
}

export interface CreateDutyPeriodInput {
  id?: string;
  organizationUnitId: string;
  periodKey: string;
  version: number;
  startDate: string;
  endDate: string;
  sourceAppId?: string | null;
  sourceEntityId?: string | null;
  importSha256?: string | null;
  note?: string | null;
}

export interface SetDutyAssignmentInput {
  id?: string;
  periodId: string;
  personId: string;
  dateKey: string;
  shiftTypeId?: string | null;
  dutyStatusId?: string | null;
  origin?: DutyAssignmentOrigin;
  note?: string | null;
}

export interface ProposeTemporaryReplacementInput {
  id?: string;
  originalAssignmentId: string;
  substitutePersonId: string;
  replacementShiftTypeId?: string | null;
  returnAssignmentId?: string | null;
  reason?: string | null;
  sourceAppId?: string | null;
  sourceEntityId?: string | null;
  note?: string | null;
}

export interface DutyListInput {
  organizationUnitId?: string;
  status?: DutyPeriodStatus;
  limit?: number;
}

export interface StandardRosterCatalogEvidence {
  code: string;
  startMinute: number;
  endMinute: number;
  crossesMidnight: boolean;
  creditedMinutes: number | null;
}

export interface StandardRosterPersonEvidence {
  sourcePersonKey: string;
  personId: string | null;
}

export interface StandardRosterCellEvidence {
  sourcePersonKey: string;
  dateKey: string;
  code: string;
  creditedMinutes: number | null;
}

export interface LegacyDutyEvidenceSnapshot {
  standardRoster?: {
    sourceId: string;
    dateKeys: readonly string[];
    people: readonly StandardRosterPersonEvidence[];
    cells: readonly StandardRosterCellEvidence[];
    catalog: readonly StandardRosterCatalogEvidence[];
    excludedFieldNames?: readonly string[];
  };
  schedulingEntries?: readonly { sourceId: string; personId: string; dateKey: string; shift: 'day' | 'night'; code?: string | null }[];
  handoverRecords?: readonly { sourceId: string; shift: 'day' | 'night' }[];
  adjustmentShiftCodes?: readonly string[];
}

export type LegacyDutyIssueCode =
  | 'UNRESOLVED_PERSON'
  | 'UNKNOWN_DUTY_CODE'
  | 'CATALOG_DEFINITION_MISMATCH'
  | 'CREDITED_MINUTES_MISMATCH'
  | 'DUPLICATE_ASSIGNMENT_CELL'
  | 'MISSING_ASSIGNMENT_CELL'
  | 'SCHEDULING_SHIFT_MISMATCH'
  | 'UNKNOWN_ADJUSTMENT_SHIFT'
  | 'EXTERNAL_SUMMARY_FIELD';

export interface LegacyDutyIssue {
  code: LegacyDutyIssueCode;
  sourceId: string;
  value?: string;
}

export interface LegacyDutyReconciliation {
  peopleCount: number;
  dateCount: number;
  expectedCellCount: number;
  assignmentCellCount: number;
  schedulingEntryCount: number;
  handoverRecordCount: number;
  adjustmentShiftCodeCount: number;
  issues: LegacyDutyIssue[];
}

export class DutyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DutyError';
    this.code = code;
  }
}
