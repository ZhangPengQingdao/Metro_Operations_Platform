import { createHash } from 'node:crypto';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import { validateAppManifest } from '../manifest/index.js';
import type { AppRegistryService } from '../registry/index.js';
import { binding, manage, AppStorageError, type ManagedAppStorage } from './binding.js';

import { compileAppMigration, APP_MIGRATION_FILE_MAX_BYTES } from './declarative-migration.js';
export { APP_MIGRATION_FILE_MAX_BYTES } from './declarative-migration.js';
export const APP_MIGRATION_TOTAL_MAX_BYTES = 8_388_608;
export interface AppMigrationArtifactRequest {
  readonly installationId: string; readonly appId: string; readonly revision: number;
  readonly manifestDigest: string; readonly artifactId: string; readonly path: string;
  readonly sha256: string; readonly bytes: number; readonly maxBytes: number;
}
/** Trusted package infrastructure must bound allocation while reading; never an arbitrary URL/FS reader. */
export interface AppMigrationArtifactReader {
  read(request: AppMigrationArtifactRequest): Promise<Uint8Array>;
}
export interface AppMigrationStep {
  readonly id: string; readonly artifactId: string; readonly path: string;
  readonly sha256: string; readonly bytes: number; readonly sql: string; readonly declarationJson: string;
}
export interface AppMigrationPlan {
  readonly binding: Readonly<ManagedAppStorage>; readonly revision: number;
  readonly steps: readonly AppMigrationStep[]; readonly totalBytes: number;
}

/** Verify registered bytes and compile declarative JSON; does not execute or authorize execution. */
export class AppMigrationPlanner {
  constructor(private readonly registry: Pick<AppRegistryService, 'get'>, private readonly reader: AppMigrationArtifactReader) {}

  async prepare(context: PlatformManagementContext, appId: string): Promise<AppMigrationPlan> {
    await manage(context);
    const record = await this.registry.get(context, appId);
    // Validation produces a detached manifest; capture scalars before the first provider await.
    const parsed = validateAppManifest(record.manifest);
    if (!parsed.ok) throw new AppStorageError('MIGRATION_INVALID_MANIFEST');
    const revision = record.revision;
    if (record.appId !== appId || !Number.isSafeInteger(revision) || revision < 1) throw new AppStorageError('INVALID_INSTALLATION');
    const storage = binding({ id: record.id, appId: record.appId, manifest: parsed.manifest });
    if (storage.mode !== 'managed' || parsed.manifest.storage.mode !== 'managed') throw new AppStorageError('MIGRATION_STORAGE_NOT_MANAGED');
    Object.freeze(storage);
    const artifacts = new Map(parsed.manifest.artifacts.map(artifact => [artifact.id, artifact]));
    const declarations = parsed.manifest.storage.migrations.map(migration => {
      const artifact = artifacts.get(migration.artifactId)!; // Validated references and kinds.
      return { id: migration.id, artifactId: artifact.id, path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes };
    });
    const totalBytes = declarations.reduce((sum, item) => sum + item.bytes, 0);
    if (declarations.some(item => item.bytes > APP_MIGRATION_FILE_MAX_BYTES) || totalBytes > APP_MIGRATION_TOTAL_MAX_BYTES) throw new AppStorageError('MIGRATION_SIZE_LIMIT');
    const steps: AppMigrationStep[] = [];
    for (const item of declarations) {
      const request = Object.freeze({ installationId: storage.installationId, appId: storage.appId, revision,
        manifestDigest: storage.manifestDigest, artifactId: item.artifactId, path: item.path,
        sha256: item.sha256, bytes: item.bytes, maxBytes: item.bytes });
      let result: Uint8Array;
      try { result = await this.reader.read(request); }
      catch { throw new AppStorageError('MIGRATION_ARTIFACT_UNAVAILABLE'); }
      if (!(result instanceof Uint8Array)) throw new AppStorageError('MIGRATION_INVALID_ARTIFACT');
      if (result.byteLength !== item.bytes) throw new AppStorageError('MIGRATION_BYTE_LENGTH_MISMATCH');
      const bytes = Uint8Array.from(result);
      if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new AppStorageError('MIGRATION_HASH_MISMATCH');
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new AppStorageError('MIGRATION_INVALID_ENCODING');
      let sql: string;
      try { sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new AppStorageError('MIGRATION_INVALID_ENCODING'); }
      if (sql.includes('\0') || sql.trim().length === 0) throw new AppStorageError('MIGRATION_INVALID_SQL_TEXT');
      steps.push(Object.freeze({ ...item, declarationJson: sql, sql: compileAppMigration(sql, storage.schema).join('\n') }));
    }
    return Object.freeze({ binding: storage, revision, steps: Object.freeze(steps), totalBytes });
  }
}
