import type { PlatformEventType } from './events.js';

export interface PlatformCapabilityDescriptor {
  id: string;
  contractVersion: '1.0' | '2.0';
  backendEntrypoint: string | null;
  frontendEntrypoint: string | null;
  permissions: readonly string[];
  events: readonly PlatformEventType[];
  availability: 'available';
}

export const PLATFORM_CAPABILITY_CATALOG = [
  capability('people', 'server/src/platform/people/index.ts', null, [], ['platform.people.organization-changed.v1']),
  capability('locations', 'server/src/platform/locations/index.ts', null),
  capability('assets', 'server/src/platform/assets/index.ts', null, [], ['platform.assets.changed.v1']),
  capability('responsibility', 'server/src/platform/responsibility/index.ts', null, [], ['platform.responsibility.changed.v1']),
  capability('authorization', 'server/src/platform/authorization/index.ts', null, ['platform.authorization.read','platform.authorization.manage'], ['platform.authorization.permission-changed.v1']),
  capability('context', 'server/src/platform/context/index.ts', 'src/platform/context/index.tsx'),
  capability('entity-resolution', 'server/src/platform/entity-resolution/index.ts', null),
  capability('work-items', 'server/src/platform/work-items/index.ts', null, ['platform.work_items.create','platform.work_items.read','platform.work_items.assign','platform.work_items.manage','platform.work_items.recurrence.manage','platform.work_items.complete_on_behalf'], ['platform.work-items.created.v1','platform.work-items.assigned.v1','platform.work-items.claimed.v1','platform.work-items.progress-updated.v1','platform.work-items.completed.v1','platform.work-items.cancelled.v1','platform.work-items.reopened.v1','platform.work-items.recurrence-generated.v1','platform.work-items.recurrence-generation-skipped.v1']),
  capability('notifications', 'server/src/platform/notifications/index.ts', null, ['platform.notifications.create','platform.notifications.read','platform.notifications.manage','platform.notifications.delivery.manage','platform.notifications.preferences.manage'], ['platform.notifications.created.v1','platform.notifications.read.v1','platform.notifications.delivery-updated.v1','platform.notifications.preference-updated.v1','platform.notifications.cancelled.v1']),
  capability('signatures', 'server/src/platform/signatures/index.ts', null, ['platform.signatures.create','platform.signatures.read','platform.signatures.sign','platform.signatures.manage','platform.signatures.sign_on_behalf','platform.signatures.finalize'], ['platform.signatures.request-created.v1','platform.signatures.signer-signed.v1','platform.signatures.status-changed.v1','platform.signatures.request-completed.v1']),
  capability('attachments', 'server/src/platform/attachments/index.ts', null, ['platform.attachments.create','platform.attachments.read','platform.attachments.manage','platform.attachments.retention.manage','platform.attachments.remove'], ['platform.attachments.added.v1']),
  capability('business-audit', 'server/src/platform/audit/index.ts', null, ['platform.audit.record','platform.audit.read']),
  capability('duty', 'server/src/platform/duty/index.ts', null, ['platform.duty.read','platform.duty.catalog.manage','platform.duty.calendar.manage','platform.duty.period.manage','platform.duty.assignment.manage','platform.duty.replacement.manage']),
  capability('data-alignment', 'server/src/platform/data-alignment/index.ts', null, ['platform.reference_data.read','platform.reference_data.dictionary.manage','platform.reference_data.external_system.manage','platform.reference_data.mapping_profile.manage','platform.reference_data.sync.record','platform.reference_data.conflict.resolve']),
  { ...capability('platform-mcp', 'server/src/platform/mcp/index.ts', null, ['platform.mcp.use']), contractVersion: '2.0' },
  capability('platform-sdk', null, 'src/platform/index.ts')
] as const satisfies readonly PlatformCapabilityDescriptor[];

export type PlatformCapabilityId = typeof PLATFORM_CAPABILITY_CATALOG[number]['id'];
export function getPlatformCapability(id: string) { return PLATFORM_CAPABILITY_CATALOG.find((item) => item.id === id) ?? null; }

function capability<TId extends string>(id: TId, backendEntrypoint: string | null, frontendEntrypoint: string | null, permissions: readonly string[] = [], events: readonly PlatformEventType[] = []): PlatformCapabilityDescriptor & { id: TId } { return { id, contractVersion: '1.0', backendEntrypoint, frontendEntrypoint, permissions, events, availability: 'available' }; }
