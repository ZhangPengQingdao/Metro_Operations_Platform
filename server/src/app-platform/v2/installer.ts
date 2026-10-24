import { createHash } from 'node:crypto';
import { readMopkg } from '@metro/platform-sdk/mopkg';
import type { AppManifestIssueV2 } from '@metro/platform-sdk/manifest';
import { runDatabaseTransaction, type ConnectablePool } from '../../core/database/index.js';
import type { PlatformManagementContext } from '../../platform/context/index.js';
import { previewAppPackageV2, summarizeInstallation } from '../install/package-v2.js';
import { approveInstalledPlatformGrants } from '../management/platform-grants.js';
import type { AppInstallation, AppRegistryService, AppRuntimePackage } from '../registry/index.js';
import type { AppHostV2 } from './host.js';
import { applyAppMigrationsV2 } from './migration.js';
import { adoptV1Storage } from './conversion.js';
import { projectV2Manifest } from './projection.js';
import type { AppPackageStoreV2 } from './store.js';

export class AppInstallV2Error extends Error {
  constructor(readonly code: string, readonly issues: AppManifestIssueV2[] = []) { super(code); this.name = 'AppInstallV2Error'; }
}
export interface AppInstallerV2Options {
  registry: AppRegistryService;
  findInstallation(appId: string): Promise<AppInstallation | null>;
  pool: ConnectablePool;
  store: AppPackageStoreV2;
  host(appId: string): AppHostV2;
  platformVersion(): string;
}
export interface AppInstallV2Result { state: 'installed' | 'updated' | 'repaired' | 'converted'; appId: string; version: string; enabled: boolean }

/**
 * Installs or upgrades a `.mopkg`. Order: verify → store files → migrations (append-only, safe for the running
 * version) → registry version switch → service identity and platform grants → start. Every step is repeatable,
 * so a failed attempt can be retried by uploading the same package again.
 */
export class AppInstallerV2 {
  constructor(private readonly options: AppInstallerV2Options) {}

  /** `dev` (development mode only) also accepts a rebuilt package of the same version while the app is running. */
  async install(context: PlatformManagementContext, bytes: Uint8Array, options: { dev?: boolean } = {}): Promise<AppInstallV2Result> {
    const { registry } = this.options;
    const preview = await previewAppPackageV2(bytes, {
      platformVersion: this.options.platformVersion(), installAvailable: true,
      findInstalled: async appId => { const record = await this.options.findInstallation(appId); return record ? summarizeInstallation(record) : null; },
    });
    if (preview.issues.length || !preview.manifest || !preview.change) throw new AppInstallV2Error('PACKAGE_INVALID', preview.issues);
    if (!preview.installable) throw new AppInstallV2Error(preview.installed?.model === 'v1' ? (preview.installed.enabled ? 'V1_APP_DISABLE_REQUIRED' : 'VERSION_NOT_NEWER') : 'PACKAGE_NOT_INSTALLABLE');
    const manifest = preview.manifest, appId = manifest.id, kind = preview.change.kind;
    const files = readMopkg(bytes);
    const digest = (path: string) => createHash('sha256').update(files.get(path)!).digest('hex');
    const projection = projectV2Manifest(manifest, preview, digest);
    const runtime: AppRuntimePackage = { model: 'v2', sha256: preview.sha256, manifest };
    await this.options.store.write(appId, preview.sha256, files);
    const migrations = preview.migrations.map(migration => ({ id: migration.id, file: migration.file, text: files.get(migration.file)!.toString('utf8') }));
    const host = this.options.host(appId);

    let record: AppInstallation;
    const existing = await this.options.findInstallation(appId);
    if (!existing) record = await registry.register(context, projection, `Install ${appId} ${manifest.version}`, 'standard', runtime);
    else {
      record = await registry.get(context, appId);
      // v1 → v2 conversion keeps the installation; the administrator stops the v1 app first.
      if (existing.runtime?.model !== 'v2' && (record.enabled || kind !== 'upgrade')) throw new AppInstallV2Error(record.enabled ? 'V1_APP_DISABLE_REQUIRED' : 'VERSION_NOT_NEWER');
      // Same version is only accepted as a repair of a stopped installation.
      if (kind === 'reinstall' && record.enabled && !options.dev) throw new AppInstallV2Error('VERSION_NOT_NEWER');
      if (options.dev && kind === 'reinstall' && record.runtime?.sha256 === preview.sha256 && record.enabled) return { state: 'repaired', appId, version: manifest.version, enabled: true };
      if (record.enabled) record = await host.execute(context, { revision: record.revision, action: 'disable' });
    }
    const conversion = !!existing && existing.runtime?.model !== 'v2';
    const wasEnabled = !!existing?.enabled;

    const client = await this.options.pool.connect();
    try {
      await runDatabaseTransaction(client, async () => {
        if (conversion) await adoptV1Storage(client, record.id, migrations);
        await applyAppMigrationsV2(client, record.id, migrations);
      });
    } finally { client.release(); }

    if (conversion) record = await registry.convertToV2(context, appId, record.revision, projection, runtime);
    else if (existing && kind === 'upgrade') {
      record = await registry.beginLifecycle(context, appId, record.revision, 'upgrade', projection);
      record = await registry.settleLifecycle(context, appId, record.revision, record.lifecycle!.operationId, 'completed');
    }
    if (existing && record.runtime?.sha256 !== preview.sha256) record = await registry.setRuntimePackage(context, appId, record.revision, runtime);
    // Upgrades clear the service identity and grants; issue them again for the new version.
    if (!record.serviceIdentityId) record = (await registry.issueServiceCredential(context, appId, record.revision)).installation;
    if (!record.grants.some(grant => grant.status === 'active')) record = await approveInstalledPlatformGrants(registry, context, appId);

    const start = !existing || kind === 'reinstall' || wasEnabled || conversion;
    if (start) record = record.lifecycle ? await host.execute(context, { revision: record.revision, action: 'enable' }) : await host.install(context, record.revision);
    return { state: !existing ? 'installed' : conversion ? 'converted' : kind === 'upgrade' ? 'updated' : 'repaired', appId, version: manifest.version, enabled: record.enabled };
  }
}
