import { createHash } from 'node:crypto';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppInstallation } from '../registry/index.js';

export class AppStorageError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppStorageError'; }
}
export interface ManagedAppStorage {
  mode: 'managed'; installationId: string; appId: string; schema: string;
  ownerRole: string; runtimeRole: string; manifestDigest: string;
}
export type AppStorageBinding = ManagedAppStorage
  | { mode: 'none'; installationId: string; appId: string }
  | { mode: 'external'; installationId: string; appId: string; configurationRef: string };

export function binding(record: Pick<AppInstallation, 'id' | 'appId' | 'manifest'>): AppStorageBinding {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.id)
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(record.appId) || record.appId !== record.manifest.id) throw new AppStorageError('INVALID_INSTALLATION');
  const base = { installationId: record.id, appId: record.appId };
  if (record.manifest.storage.mode === 'none') return { ...base, mode: 'none' };
  if (record.manifest.storage.mode === 'external') return { ...base, mode: 'external', configurationRef: record.manifest.storage.configurationRef };
  const suffix = record.id.replaceAll('-', '');
  return { ...base, mode: 'managed', schema: `app_${suffix}`, ownerRole: `app_${suffix}_owner`, runtimeRole: `app_${suffix}_runtime`, manifestDigest: createHash('sha256').update(canonical(record.manifest)).digest('hex') };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function manage(context: PlatformManagementContext) {
  if (!isNativeManagementActor(context) || !(await context.authorize('platform.authorization.manage', {})).allowed) throw new AppStorageError('STORAGE_ACCESS_DENIED');
}
