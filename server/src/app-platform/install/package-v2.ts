import { appPermissionCode, compareAppVersions, satisfiesPlatformRange, type AppManifestIssueV2, type AppManifestV2 } from '@metro/platform-sdk/manifest';
import { inspectMopkg } from '@metro/platform-sdk/mopkg';
import type { AppManifest } from '../manifest/index.js';
import type { AppInstallation } from '../registry/index.js';
import { compileAppMigration } from '../storage/declarative-migration.js';

/** Application model v2 packages can be previewed now; installation and runtime arrive with the v2 runtime (0.27.0). */
export const MOPKG_INSTALL_BLOCKED_REASON = '应用模型 v2 的安装需要在平台配置中启用应用管理。';
const V1_ENABLED_REASON = '该应用目前以旧版签名包运行。请先在应用列表中停用，再上传此包转换为新版运行方式（数据与授权保留）。';

function installability(hasIssues: boolean, installed: InstalledAppSummary | null, change: AppPackageV2Preview['change'], available: boolean): Pick<AppPackageV2Preview, 'installable' | 'blockedReason'> {
  if (hasIssues || !change || change.kind === 'downgrade') return { installable: false, blockedReason: null };
  if (installed?.model === 'v1' && (installed.enabled || change.kind !== 'upgrade')) return { installable: false, blockedReason: installed.enabled ? V1_ENABLED_REASON : '转换为新版运行方式时，版本号需高于当前旧版版本。' };
  if (!available) return { installable: false, blockedReason: MOPKG_INSTALL_BLOCKED_REASON };
  return { installable: true, blockedReason: null };
}
const PREVIEW_SCHEMA = `app_${'0'.repeat(32)}`;

export interface InstalledAppSummary { version: string; model: 'v1' | 'v2'; permissions: string[]; platformAccess: string[]; enabled?: boolean }
export interface AppPackageV2Preview {
  format: 'mopkg';
  sha256: string;
  bytes: number;
  manifest: AppManifestV2 | null;
  icon: { contentType: string; dataUrl: string } | null;
  readme: string | null;
  changelog: string | null;
  files: { path: string; bytes: number }[];
  migrations: { id: string; file: string; bytes: number; sha256: string; statements: number }[];
  issues: AppManifestIssueV2[];
  platform: { version: string; compatible: boolean };
  installed: { version: string; model: 'v1' | 'v2'; enabled?: boolean } | null;
  change: { kind: 'install' | 'upgrade' | 'reinstall' | 'downgrade'; addedPermissions: string[]; removedPermissions: string[]; addedPlatformAccess: string[] } | null;
  installable: boolean;
  /** Why installation is unavailable when the package itself is valid; null when installable or when `issues` explain it. */
  blockedReason: string | null;
}

/** Permission and platform-access view of a v1 installation, in v2 terms, for upgrade comparison. */
export function summarizeV1Installation(manifest: AppManifest): InstalledAppSummary {
  return {
    version: manifest.version, model: 'v1',
    permissions: manifest.permissions.defined.map(permission => permission.code),
    platformAccess: manifest.permissions.requested.filter(code => code.startsWith('platform.') && !code.startsWith('platform.app_data.')).map(code => code.slice('platform.'.length)),
  };
}

/** Comparison view of any installation: v2 records use their stored app.json, v1 records their manifest. */
export function summarizeInstallation(record: AppInstallation): InstalledAppSummary {
  if (record.runtime?.model !== 'v2') return { ...summarizeV1Installation(record.manifest), enabled: record.enabled };
  const manifest = record.runtime.manifest;
  return { version: manifest.version, model: 'v2', permissions: manifest.permissions.map(permission => appPermissionCode(manifest.id, permission.code)), platformAccess: [...manifest.platformAccess] };
}

/** Read-only: parses and validates the package, nothing is written or installed. */
export async function previewAppPackageV2(bytes: Uint8Array, options: { platformVersion: string; installAvailable?: boolean; findInstalled(appId: string): Promise<InstalledAppSummary | null> }): Promise<AppPackageV2Preview> {
  const inspection = inspectMopkg(bytes);
  const issues = [...inspection.issues];
  const migrations = inspection.migrations.map(migration => {
    let statements = 0;
    try { statements = compileAppMigration(migration.text, PREVIEW_SCHEMA).length; }
    catch (error) { issues.push({ path: migration.file, message: `迁移无法编译（${error instanceof Error ? error.message : 'MIGRATION_INVALID_DECLARATION'}）` }); }
    return { id: migration.id, file: migration.file, bytes: migration.bytes, sha256: migration.sha256, statements };
  });
  const manifest = inspection.manifest;
  const compatible = !!manifest && satisfiesPlatformRange(manifest.platform, options.platformVersion);
  if (manifest && !compatible) issues.push({ path: 'app.json#platform', message: `应用要求平台 ${manifest.platform}，当前平台为 ${options.platformVersion}` });

  const installedSummary = manifest ? await options.findInstalled(manifest.id) : null;
  let change: AppPackageV2Preview['change'] = null;
  if (manifest) {
    const next = manifest.permissions.map(permission => appPermissionCode(manifest.id, permission.code));
    const previous = installedSummary?.permissions ?? [];
    const order = installedSummary ? compareAppVersions(manifest.version, installedSummary.version) : 1;
    change = {
      kind: !installedSummary ? 'install' : order > 0 ? 'upgrade' : order === 0 ? 'reinstall' : 'downgrade',
      addedPermissions: next.filter(code => !previous.includes(code)),
      removedPermissions: previous.filter(code => !next.includes(code)),
      addedPlatformAccess: manifest.platformAccess.filter(code => !(installedSummary?.platformAccess ?? []).includes(code)),
    };
    if (change.kind === 'downgrade') issues.push({ path: 'app.json#version', message: `已安装 ${installedSummary!.version}，不能降级到 ${manifest.version}` });
  }
  return {
    format: 'mopkg', sha256: inspection.sha256, bytes: inspection.bytes, manifest,
    icon: inspection.icon ? { contentType: inspection.icon.contentType, dataUrl: `data:${inspection.icon.contentType};base64,${inspection.icon.data.toString('base64')}` } : null,
    readme: inspection.readme, changelog: inspection.changelog, files: inspection.files, migrations, issues,
    platform: { version: options.platformVersion, compatible },
    installed: installedSummary ? { version: installedSummary.version, model: installedSummary.model, ...(installedSummary.enabled !== undefined ? { enabled: installedSummary.enabled } : {}) } : null,
    change, ...installability(issues.length > 0, installedSummary, change, options.installAvailable === true),
  };
}
