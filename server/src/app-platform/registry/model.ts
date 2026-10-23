import type { AppManifest } from '../manifest/index.js';
import type { AppPermissionGrant } from '../../platform/authorization/index.js';
import type { AppManifestV2 } from '@metro/platform-sdk/manifest';

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
/** Installed v2 package identity, set only by the v2 installer. */
export interface AppRuntimePackage { model: 'v2'; sha256: string; manifest: AppManifestV2 }
export interface AppInstallation {
  id: string;
  appId: string;
  manifest: AppManifest;
  enabled: boolean;
  /** Platform installation setting; absent legacy records are standard. Never read from the manifest. */
  frontendRunMode?: AppFrontendRunMode;
  /** Application model v2 package; `manifest` above is its v1-shaped projection used by shared services. */
  runtime?: AppRuntimePackage;
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
  action: 'registered' | 'enabled' | 'disabled' | 'frontend-mode-changed' | 'runtime-package-changed' | 'grant-approved' | 'grant-revoked' | 'credential-issued' | 'credential-revoked' | 'lifecycle-started' | 'lifecycle-completed' | 'lifecycle-failed' | 'lifecycle-cancelled';
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
