import {isAppendOnlyStorageVersion} from '../manifest/storage-version.js';
import { runAtomicOperation, type AtomicParticipant, type QueryableClient } from '../../core/database/index.js';
import { validateAppManifest } from '../manifest/index.js';
import { isDeepStrictEqual } from 'node:util';
import { AppRegistryError, type StoredAppInstallation, type AppInstallationHistory } from './model.js';

export interface AppRegistryRepository extends AtomicParticipant {
  list?(limit: number): Promise<StoredAppInstallation[]>;
  findByAppId(appId: string, lock?: boolean): Promise<StoredAppInstallation | null>;
  insert(record: StoredAppInstallation): Promise<void>;
  save(record: StoredAppInstallation, expectedRevision: number): Promise<void>;
  saveLifecycle(record: StoredAppInstallation, expectedRevision: number): Promise<void>;
  appendHistory(record: AppInstallationHistory): Promise<void>;
  history(installationId: string, afterRevision: number, limit: number): Promise<AppInstallationHistory[]>;
}
export class MemoryAppRegistryRepository implements AppRegistryRepository {
  private records = new Map<string, StoredAppInstallation>();
  private histories: AppInstallationHistory[] = [];
  readonly atomic = { snapshot: () => {
    const records = structuredClone(this.records), histories = structuredClone(this.histories);
    return () => { this.records = records; this.histories = histories; };
  } };
  async list(limit: number) { return structuredClone([...this.records.values()].sort((a,b)=>a.appId.localeCompare(b.appId)).slice(0,limit)); }
  async findByAppId(appId: string) { return structuredClone(this.records.get(appId) ?? null); }
  async insert(record: StoredAppInstallation) {
    if (this.records.has(record.appId)) throw new AppRegistryError('APP_ALREADY_REGISTERED');
    this.records.set(record.appId, structuredClone(record));
  }
  async save(record: StoredAppInstallation, expectedRevision: number) {
    const current = this.records.get(record.appId);
    if (!current || current.revision !== expectedRevision) throw new AppRegistryError('STALE_REVISION');
    if (record.revision !== expectedRevision+1 || current.id !== record.id || current.createdAt !== record.createdAt || !isDeepStrictEqual(current.manifest,record.manifest) || !isDeepStrictEqual(current.lifecycle,record.lifecycle) || !!(current.lifecycle && !current.enabled && record.enabled)) throw new AppRegistryError('IMMUTABLE_INSTALLATION');
    this.records.set(record.appId, structuredClone(record));
  }
  async saveLifecycle(record: StoredAppInstallation, expectedRevision: number) {
    validateLifecycleTransition(this.records.get(record.appId) ?? null, record, expectedRevision);
    this.records.set(record.appId, structuredClone(record));
  }
  async appendHistory(record: AppInstallationHistory) {
    if (this.histories.some((h) => h.installationId === record.installationId && h.revision === record.revision)) throw new AppRegistryError('DUPLICATE_HISTORY');
    this.histories.push(structuredClone(record));
  }
  async history(id: string, after: number, limit: number) {
    return structuredClone(this.histories.filter((h) => h.installationId === id && h.revision > after).sort((a,b) => a.revision-b.revision).slice(0,limit));
  }
}
export class PostgresAppRegistryRepository implements AppRegistryRepository {
  readonly atomic;
  constructor(private readonly client: QueryableClient) { this.atomic = { client }; }
  async list(limit: number) {
    const result = await this.client.query('SELECT record FROM platform_app_installations ORDER BY app_id LIMIT $1',[limit]) as {rows:{record:StoredAppInstallation}[]};
    return result.rows.map(row=>row.record);
  }
  async findByAppId(appId: string, lock = false) {
    const result = await this.client.query(`SELECT record FROM platform_app_installations WHERE app_id=$1${lock ? ' FOR UPDATE' : ''}`, [appId]) as { rows: { record: StoredAppInstallation }[] };
    return result.rows[0]?.record ?? null;
  }
  async insert(record: StoredAppInstallation) {
    const result = await this.client.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id', [record.id,record.appId,record.revision,JSON.stringify(record)]) as { rows: unknown[] };
    if (!result.rows.length) throw new AppRegistryError('APP_ALREADY_REGISTERED');
  }
  async save(record: StoredAppInstallation, expectedRevision: number) {
    const result = await this.client.query(`UPDATE platform_app_installations SET revision=$3,record=$4::jsonb WHERE app_id=$1 AND revision=$2 AND $3=$2+1 AND id=$5 AND record->'manifest'=$4::jsonb->'manifest' AND record->'createdAt'=$4::jsonb->'createdAt' AND record->'lifecycle' IS NOT DISTINCT FROM $4::jsonb->'lifecycle' AND (NOT (record ? 'lifecycle') OR record->'enabled'='true'::jsonb OR $4::jsonb->'enabled'='false'::jsonb) RETURNING id`, [record.appId,expectedRevision,record.revision,JSON.stringify(record),record.id]) as { rows: unknown[] };
    if (!result.rows.length) throw new AppRegistryError('STALE_REVISION');
  }
  async saveLifecycle(record: StoredAppInstallation, expectedRevision: number) {
    // Also safe when called directly: shared validation executes under the same locked transaction.
    await runAtomicOperation([this], async () => {
      const current = await this.findByAppId(record.appId, true);
      validateLifecycleTransition(current, record, expectedRevision);
      const result = await this.client.query('UPDATE platform_app_installations SET revision=$3,record=$4::jsonb WHERE app_id=$1 AND revision=$2 RETURNING id', [record.appId, expectedRevision, record.revision, JSON.stringify(record)]) as { rows: unknown[] };
      if (!result.rows.length) throw new AppRegistryError('STALE_REVISION');
    });
  }
  async appendHistory(record: AppInstallationHistory) {
    await this.client.query('INSERT INTO platform_app_installation_history(installation_id,revision,record) VALUES($1,$2,$3::jsonb)', [record.installationId,record.revision,JSON.stringify(record)]);
  }
  async history(id: string, after: number, limit: number) {
    const result = await this.client.query('SELECT record FROM platform_app_installation_history WHERE installation_id=$1 AND revision>$2 ORDER BY revision LIMIT $3', [id,after,limit]) as { rows: { record: AppInstallationHistory }[] };
    return result.rows.map((r) => r.record);
  }
}

/** Only these exact transitions can alter an immutable manifest or lifecycle record. */
function validateLifecycleTransition(current: StoredAppInstallation | null, next: StoredAppInstallation, revision: number) {
  if (!current || !Number.isSafeInteger(revision) || revision < 1 || current.revision !== revision) throw new AppRegistryError('STALE_REVISION');
  const reject = () => { throw new AppRegistryError('INVALID_LIFECYCLE_TRANSITION'); };
  const op = next.lifecycle, prior = current.lifecycle;
  if (!op || !Number.isFinite(Date.parse(next.updatedAt)) || new Date(next.updatedAt).toISOString() !== next.updatedAt) return reject();
  const expected = structuredClone(current);
  expected.revision = revision + 1; expected.updatedAt = next.updatedAt; expected.enabled = false;
  if (!prior || op.operationId !== prior.operationId) {
    if (prior && (!['completed','cancelled'].includes(prior.status) || (prior.status === 'completed' && prior.action === 'uninstall'))) return reject();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(op.operationId) || !['install','enable','disable','upgrade','rollback','uninstall'].includes(op.action)) return reject();
    if (op.action === 'install' && (prior || current.enabled)) return reject();
    const versionChange = op.action === 'upgrade' || op.action === 'rollback';
    if (versionChange) {
      const parsed = validateAppManifest(op.targetManifest);
      if (!parsed.ok || !isDeepStrictEqual(parsed.manifest, op.targetManifest) || parsed.manifest.id !== current.appId || parsed.manifest.publisherId !== current.manifest.publisherId || parsed.manifest.version === current.manifest.version || !isAppendOnlyStorageVersion(current.manifest,parsed.manifest)) return reject();
    } else if (op.targetManifest !== null) return reject();
    expected.lifecycle = { operationId: op.operationId, action: op.action, status: 'running', baseManifest: structuredClone(current.manifest), targetManifest: structuredClone(op.targetManifest), startedAt: next.updatedAt, settledAt: null };
  } else {
    if (['completed','cancelled'].includes(prior.status) || !['completed','failed','cancelled'].includes(op.status)) return reject();
    expected.lifecycle = { ...structuredClone(prior), status: op.status, settledAt: next.updatedAt };
    if (op.status === 'completed') {
      expected.enabled = prior.action === 'install' || prior.action === 'enable';
      if (prior.action === 'upgrade' || prior.action === 'rollback') {
        if (!prior.targetManifest) return reject();
        expected.manifest = structuredClone(prior.targetManifest);
      }
      if (['upgrade','rollback','uninstall'].includes(prior.action)) { expected.grants = []; expected.serviceIdentityId = null; expected.credentialDigest = null; }
    }
  }
  if (!isDeepStrictEqual(expected, next)) return reject();
}
