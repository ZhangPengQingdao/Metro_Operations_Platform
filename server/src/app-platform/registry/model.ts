import type { AppManifest } from '../manifest/index.js';
import type { AppPermissionGrant } from '../../platform/authorization/index.js';

export interface InstallationGrant extends AppPermissionGrant { serviceIdentityId: string | null }
export type AppFrontendRunMode = 'standard' | 'trusted';
export function frontendRunMode(record:Pick<AppInstallation,'frontendRunMode'>):AppFrontendRunMode { return record.frontendRunMode === 'trusted' ? 'trusted' : 'standard'; }
export type AppLifecycleAction = 'install' | 'enable' | 'disable' | 'upgrade' | 'rollback' | 'uninstall';
export interface AppLifecycleOperation {
  operationId: string;
  action: AppLifecycleAction;
  status: 'running' | 'failed' | 'completed' | 'cancelled';
  baseManifest: AppManifest;
  targetManifest: AppManifest | null;
  startedAt: string;
  settledAt: string | null;
}
export interface AppInstallation {
  id: string;
  appId: string;
  manifest: AppManifest;
  enabled: boolean;
  /** Platform installation setting; absent legacy records are standard. Never read from the manifest. */
  frontendRunMode?: AppFrontendRunMode;
  lifecycle?: AppLifecycleOperation;
  revision: number;
  grants: InstallationGrant[];
  serviceIdentityId: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Infrastructure-only record. Never serialize outside the trusted registry. */
export interface StoredAppInstallation extends AppInstallation { credentialDigest: string | null }
export interface AppInstallationHistory {
  installationId: string;
  revision: number;
  action: 'registered' | 'enabled' | 'disabled' | 'frontend-mode-changed' | 'grant-approved' | 'grant-revoked' | 'credential-issued' | 'credential-revoked' | 'lifecycle-started' | 'lifecycle-completed' | 'lifecycle-failed' | 'lifecycle-cancelled';
  lifecycle?: AppLifecycleOperation;
  actorPersonId: string | null;
  actorAdministratorId?: string | null;
  at: string;
  reason: string | null;
  grantId: string | null;
  grant: InstallationGrant | null;
  serviceIdentityId: string | null;
}
export class AppRegistryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppRegistryError'; }
}
