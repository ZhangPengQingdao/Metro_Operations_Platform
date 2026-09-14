import { toPlatformInstant } from '../../core/time/index.js';
import {
  DutyError,
  type DutyAssignment,
  type DutyStatus,
  type ShiftType,
  type TemporaryReplacement
} from './model.js';

export function isDutyCatalogEffective(record: ShiftType | DutyStatus, dateKey: string) {
  return record.status === 'active'
    && record.effectiveFrom <= dateKey
    && (!record.effectiveTo || record.effectiveTo >= dateKey);
}

export function addPlatformDays(dateKey: string, amount: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + amount));
  return value.toISOString().slice(0, 10);
}

export function getDutyShiftWindow(dateKey: string, shift: ShiftType) {
  const startsAt = platformInstant(dateKey, shift.startMinute);
  const endDate = shift.crossesMidnight ? addPlatformDays(dateKey, 1) : dateKey;
  const endsAt = platformInstant(endDate, shift.endMinute);
  return { startsAt, endsAt };
}

export function assertDutyWindowsDoNotOverlap(
  assignments: readonly DutyAssignment[],
  shiftTypes: readonly ShiftType[],
  replacements: readonly TemporaryReplacement[],
  code: string,
  message: string
) {
  const shifts = new Map(shiftTypes.map((shift) => [shift.id, shift]));
  const outgoing = new Map<string, TemporaryReplacement>();
  const returning = new Map<string, TemporaryReplacement>();
  for (const replacement of replacements) {
    if (replacement.status === 'cancelled') continue;
    if (outgoing.has(replacement.originalAssignmentId)) throw new DutyError('ACTIVE_REPLACEMENT_CONFLICT', '原排班存在多条生效中的替班记录');
    outgoing.set(replacement.originalAssignmentId, replacement);
    if (replacement.returnAssignmentId) {
      if (returning.has(replacement.returnAssignmentId)) throw new DutyError('REPLACEMENT_ASSIGNMENT_CONFLICT', '还班指派已被其他替班占用');
      returning.set(replacement.returnAssignmentId, replacement);
    }
  }
  const windowsByPerson = new Map<string, Array<{ assignmentId: string; startsAt: Date; endsAt: Date }>>();
  for (const assignment of assignments) {
    if (assignment.kind !== 'shift') continue;
    const outgoingReplacement = outgoing.get(assignment.id);
    const returningReplacement = returning.get(assignment.id);
    if (outgoingReplacement && returningReplacement) throw new DutyError('REPLACEMENT_ASSIGNMENT_CONFLICT', '同一指派不能同时作为替班和还班目标');
    const shiftId = outgoingReplacement?.replacementShiftTypeId ?? assignment.shiftTypeId;
    const shift = shiftId ? shifts.get(shiftId) : null;
    if (!shift) throw new DutyError('SHIFT_TYPE_NOT_FOUND', '班次不存在');
    if (!isDutyCatalogEffective(shift, assignment.dateKey)) throw new DutyError('SHIFT_TYPE_INACTIVE', '班次在指派日期未生效');
    const personId = outgoingReplacement?.substitutePersonId ?? returningReplacement?.absentPersonId ?? assignment.personId;
    const windows = windowsByPerson.get(personId) ?? [];
    windows.push({ assignmentId: assignment.id, ...getDutyShiftWindow(assignment.dateKey, shift) });
    windowsByPerson.set(personId, windows);
  }
  for (const windows of windowsByPerson.values()) {
    windows.sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime() || left.assignmentId.localeCompare(right.assignmentId));
    for (let index = 1; index < windows.length; index += 1) {
      if (windows[index].startsAt.getTime() < windows[index - 1].endsAt.getTime()) throw new DutyError(code, message);
    }
  }
}

function platformInstant(dateKey: string, minuteOfDay: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return toPlatformInstant({
    year,
    month,
    day,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60
  });
}
