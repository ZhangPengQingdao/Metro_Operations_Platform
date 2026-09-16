import {isAppendOnlyStorageVersion} from '../manifest/storage-version.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { runAtomicOperation } from '../../core/database/index.js';
import { verifySecretToken } from '../../core/security/index.js';
import { validateScope, type AuthorizationService, type DataScope } from '../../platform/authorization/index.js';
import type { AppGrantResolver, ResolvePlatformActorInput } from '../../platform/context/index.js';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import { checkAppManifestCompatibility, validateAppManifest, type AppManifestHost } from '../manifest/index.js';
import { AppRegistryError, type AppLifecycleAction, type AppInstallation, type AppInstallationHistory, type InstallationGrant, type StoredAppInstallation } from './model.js';
import type { AppRegistryRepository } from './repository.js';
export * from './model.js';
export * from './repository.js';
export * from './migration.js';

export interface AppRegistryOptions {
  host: () => AppManifestHost | Promise<AppManifestHost>;
  authorization: Pick<AuthorizationService, 'listPermissions'>;
  clock?: () => Date;
}
export interface ApproveAppGrantInput {
  mode: 'delegated_user' | 'service';
  permissionCode: string;
  scope: DataScope;
  serviceIdentityId?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}
export class AppRegistryService {
  private readonly clock: () => Date;
  constructor(private readonly repository: AppRegistryRepository, private readonly options: AppRegistryOptions) { this.clock = options.clock ?? (() => new Date()); }

  /** Expose the existing boundary for atomic first-install identity and package binding. */
  get atomic() { return this.repository.atomic; }

  async register(context: PlatformManagementContext, manifestInput: unknown, reason?: string): Promise<AppInstallation> {
    const parsed = validateAppManifest(manifestInput);
    return runAtomicOperation([this.repository], async () => {
      await admin(context, 'manage');
      if (!parsed.ok) throw new AppRegistryError('INVALID_MANIFEST');
      if (!checkAppManifestCompatibility(parsed.manifest, await this.options.host()).ok) throw new AppRegistryError('INCOMPATIBLE_MANIFEST');
      const now = this.clock().toISOString();
      const record: StoredAppInstallation = { id: randomUUID(), appId: parsed.manifest.id, manifest: parsed.manifest, enabled: false, revision: 1, grants: [], serviceIdentityId: null, credentialDigest: null, createdAt: now, updatedAt: now };
      await this.repository.insert(record);
      await this.audit(context, record, 'registered', reason);
      return publicRecord(record);
    });
  }
  /** Trusted host only. Starts no executable work; settlement requires executor reconciliation. */
  async beginLifecycle(context: PlatformManagementContext, appId: string, revision: number, action: AppLifecycleAction, targetManifest?: unknown): Promise<AppInstallation> {
    const parsed = targetManifest === undefined ? null : validateAppManifest(targetManifest);
    return runAtomicOperation([this.repository], async () => {
      await admin(context, 'manage');
      const record = await this.require(appId, true);
      checkRevision(record, revision);
      if (!['install','enable','disable','upgrade','rollback','uninstall'].includes(action)) throw new AppRegistryError('INVALID_LIFECYCLE_ACTION');
      if (record.lifecycle && (!['completed','cancelled'].includes(record.lifecycle.status) || (record.lifecycle.status === 'completed' && record.lifecycle.action === 'uninstall'))) throw new AppRegistryError('LIFECYCLE_BLOCKED');
      if (action === 'install' && (record.lifecycle || record.enabled)) throw new AppRegistryError('LIFECYCLE_BLOCKED');
      const versionChange = action === 'upgrade' || action === 'rollback';
      if (versionChange) {
        if (!parsed?.ok) throw new AppRegistryError('INVALID_MANIFEST');
        if (parsed.manifest.id !== record.appId || parsed.manifest.publisherId !== record.manifest.publisherId || !isAppendOnlyStorageVersion(record.manifest,parsed.manifest)) throw new AppRegistryError('IMMUTABLE_INSTALLATION');
        if (parsed.manifest.version === record.manifest.version) throw new AppRegistryError('UNCHANGED_VERSION');
        if (!checkAppManifestCompatibility(parsed.manifest, await this.options.host()).ok) throw new AppRegistryError('INCOMPATIBLE_MANIFEST');
      } else if (parsed !== null) throw new AppRegistryError('UNEXPECTED_TARGET_MANIFEST');
      const now = this.clock().toISOString();
      record.enabled = false;
      record.lifecycle = { operationId: randomUUID(), action, status: 'running', baseManifest: structuredClone(record.manifest), targetManifest: versionChange && parsed?.ok ? parsed.manifest : null, startedAt: now, settledAt: null };
      record.revision++; record.updatedAt = now;
      await this.repository.saveLifecycle(record, revision);
      await this.audit(context, record, 'lifecycle-started');
      return publicRecord(record);
    });
  }
  /** Platform executor attestation, never wire input. Failed/unknown work must reconcile this same ID. */
  async settleLifecycle(context: PlatformManagementContext, appId: string, revision: number, operationId: string, outcome: 'completed' | 'failed' | 'cancelled'): Promise<AppInstallation> {
    return runAtomicOperation([this.repository], async () => {
      await admin(context, 'manage');
      const record = await this.require(appId, true);
      checkRevision(record, revision);
      const op = record.lifecycle;
      if (!op || op.operationId !== operationId || ['completed','cancelled'].includes(op.status)) throw new AppRegistryError('LIFECYCLE_BLOCKED');
      if (!['completed','failed','cancelled'].includes(outcome)) throw new AppRegistryError('INVALID_LIFECYCLE_OUTCOME');
      if (outcome === 'completed' && ['install','enable','upgrade','rollback'].includes(op.action) && !checkAppManifestCompatibility(op.targetManifest ?? record.manifest, await this.options.host()).ok) throw new AppRegistryError('INCOMPATIBLE_MANIFEST');
      record.enabled = outcome === 'completed' && (op.action === 'install' || op.action === 'enable');
      if (outcome === 'completed' && (op.action === 'upgrade' || op.action === 'rollback')) record.manifest = structuredClone(op.targetManifest!);
      if (outcome === 'completed' && ['upgrade','rollback','uninstall'].includes(op.action)) { record.grants = []; record.serviceIdentityId = null; record.credentialDigest = null; }
      op.status = outcome; op.settledAt = this.clock().toISOString();
      record.revision++; record.updatedAt = op.settledAt;
      await this.repository.saveLifecycle(record, revision);
      await this.audit(context, record, outcome === 'completed' ? 'lifecycle-completed' : outcome === 'cancelled' ? 'lifecycle-cancelled' : 'lifecycle-failed');
      return publicRecord(record);
    });
  }
  async list(context: PlatformManagementContext, limit = 200) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AppRegistryError('INVALID_PAGE');
    return runAtomicOperation([this.repository], async () => {
      await admin(context,'read');
      if (!this.repository.list) throw new AppRegistryError('CATALOG_UNAVAILABLE');
      return (await this.repository.list(limit)).map(publicRecord);
    });
  }
  async get(context: PlatformManagementContext, appId: string) {
    return runAtomicOperation([this.repository], async () => { await admin(context,'read'); return publicRecord(await this.require(appId)); });
  }
  /** Internal runtime snapshot only; transport callers require independent admission. */
  async runtimeSnapshot(appId:string){return publicRecord(await this.require(appId));}
  async listHistory(context: PlatformManagementContext, appId: string, afterRevision = 0, limit = 100) {
    return runAtomicOperation([this.repository], async () => {
      await admin(context,'read');
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new AppRegistryError('INVALID_PAGE');
      return this.repository.history((await this.require(appId)).id, afterRevision, limit);
    });
  }
  setEnabled(context: PlatformManagementContext, appId: string, expectedRevision: number, enabled: boolean, reason?: string) {
    return this.change(context,appId,expectedRevision,enabled ? 'enabled' : 'disabled',reason, async (record) => {
      if (typeof enabled !== 'boolean') throw new AppRegistryError('INVALID_ENABLED');
      if (enabled && !checkAppManifestCompatibility(record.manifest, await this.options.host()).ok) throw new AppRegistryError('INCOMPATIBLE_MANIFEST');
      record.enabled = enabled;
    });
  }
  approveGrant(context: PlatformManagementContext, appId: string, expectedRevision: number, input: ApproveAppGrantInput, reason?: string) {
    if (!input?.scope || !Array.isArray(input.scope.targets) || input.scope.targets.length > 128) {
      return Promise.reject(new AppRegistryError('INVALID_DATA_SCOPE'));
    }
    // Snapshot before asynchronous authorization; callers cannot mutate an in-flight request.
    const draft = structuredClone(input);
    return this.change(context,appId,expectedRevision,'grant-approved',reason,async (record) => {
      if (!['delegated_user','service'].includes(draft.mode)) throw new AppRegistryError('INVALID_GRANT_MODE');
      if (!record.manifest.permissions.requested.includes(draft.permissionCode) && !record.manifest.permissions.defined.some((p) => p.code === draft.permissionCode)) throw new AppRegistryError('UNDECLARED_PERMISSION');
      if (!(await this.options.authorization.listPermissions()).some((p) => p.code === draft.permissionCode && p.status === 'active')) throw new AppRegistryError('PERMISSION_NOT_ACTIVE');
      const scope = validateScope(draft.scope);
      if (draft.mode === 'service') {
        if (!record.credentialDigest || !draft.serviceIdentityId || draft.serviceIdentityId !== record.serviceIdentityId) throw new AppRegistryError('SERVICE_IDENTITY_MISMATCH');
        if (!['explicit','all'].includes(scope.kind)) throw new AppRegistryError('SERVICE_RELATIVE_SCOPE');
      } else if (draft.serviceIdentityId !== undefined) throw new AppRegistryError('UNEXPECTED_SERVICE_IDENTITY');
      const now = this.clock().toISOString(), effectiveFrom = instant(draft.effectiveFrom ?? now), effectiveTo = draft.effectiveTo == null ? null : instant(draft.effectiveTo);
      if (effectiveTo !== null && (effectiveTo <= effectiveFrom || effectiveTo <= now)) throw new AppRegistryError('INVALID_GRANT_INTERVAL');
      // Exactly one current ceiling per mode/permission. Prior approvals remain in immutable audit.
      record.grants = record.grants.filter((g) => !(g.mode === draft.mode && g.permissionCode === draft.permissionCode));
      if (record.grants.length >= 256) throw new AppRegistryError('GRANT_LIMIT');
      const grant: InstallationGrant = { grantId: randomUUID(), appId: record.appId, mode: draft.mode, permissionCode: draft.permissionCode, scope, status:'active', effectiveFrom,effectiveTo,serviceIdentityId:draft.mode === 'service' ? record.serviceIdentityId : null };
      record.grants.push(grant);
      return grant.grantId;
    });
  }
  revokeGrant(context: PlatformManagementContext, appId: string, revision: number, grantId: string, reason?: string) {
    return this.change(context,appId,revision,'grant-revoked',reason,async (record) => {
      const grant = record.grants.find((g) => g.grantId === grantId);
      if (!grant) throw new AppRegistryError('GRANT_NOT_FOUND');
      grant.status='inactive'; return grant.grantId;
    });
  }
  async issueServiceCredential(context: PlatformManagementContext, appId: string, revision: number) {
    const secret = randomBytes(32).toString('base64url');
    const installation = await this.change(context,appId,revision,'credential-issued',undefined,async (record) => {
      record.serviceIdentityId = randomUUID(); record.credentialDigest = digest(secret);
      record.grants = record.grants.filter((g) => g.mode !== 'service');
    });
    return { installation, credential: `${installation.id}.${installation.serviceIdentityId}.${secret}` };
  }
  revokeServiceCredential(context: PlatformManagementContext, appId: string, revision: number, reason?: string) {
    return this.change(context,appId,revision,'credential-revoked',reason,async (record) => {
      record.serviceIdentityId=null; record.credentialDigest=null; record.grants=record.grants.filter((g) => g.mode !== 'service');
    });
  }
  /** Gateway-only credential verification. No transport is mounted by this module. */
  async authenticateServiceCredential(appId: string, credential: unknown): Promise<Pick<Extract<ResolvePlatformActorInput,{actorType:'service'}>,'actorType'|'trustedIdentity'|'execution'>> {
    return runAtomicOperation([this.repository],async () => {
      if (typeof credential !== 'string' || credential.length > 200) throw new AppRegistryError('INVALID_CREDENTIAL');
      const [installationId,identityId,secret,...extra] = credential.split('.');
      if (extra.length || !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new AppRegistryError('INVALID_CREDENTIAL');
      const record = await this.repository.findByAppId(validAppId(appId));
      if (!record || !record.enabled || installationId !== record.id || identityId !== record.serviceIdentityId || !record.credentialDigest || !verifySecretToken(digest(secret),record.credentialDigest)) throw new AppRegistryError('INVALID_CREDENTIAL');
      return { actorType:'service',trustedIdentity:{ source:'service' },execution:{ type:'service',appId:record.appId,serviceIdentityId:identityId } };
    });
  }
  createGrantResolver(): AppGrantResolver {
    return async (input) => runAtomicOperation([this.repository],async () => {
      const record = await this.repository.findByAppId(validAppId(input.appId));
      if (!record?.enabled) return null;
      if (input.mode === 'delegated_user' && (!input.personId || input.serviceIdentityId !== undefined)) return null;
      if (input.mode === 'service' && (!record.credentialDigest || !input.serviceIdentityId || input.serviceIdentityId !== record.serviceIdentityId || input.personId !== undefined)) return null;
      const now=this.clock().toISOString();
      const grant=record.grants.find((g) => g.appId === input.appId && g.mode === input.mode && g.permissionCode === input.permissionCode && g.status === 'active' && g.effectiveFrom <= now && (g.effectiveTo === null || now < g.effectiveTo) && (g.mode !== 'service' || g.serviceIdentityId === input.serviceIdentityId));
      return grant ? structuredClone(grant) : null;
    });
  }
  private async change(context: PlatformManagementContext, appId: string, revision: number, action: AppInstallationHistory['action'], reason: string | undefined, operation: (record: StoredAppInstallation) => Promise<string | void>) {
    return runAtomicOperation([this.repository],async () => {
      await admin(context,'manage');
      const record=await this.require(appId,true);
      if (!Number.isSafeInteger(revision) || revision < 1 || record.revision !== revision) throw new AppRegistryError('STALE_REVISION');
      if (record.lifecycle && (action === 'enabled' || ((!['completed','cancelled'].includes(record.lifecycle.status) || (record.lifecycle.status === 'completed' && record.lifecycle.action === 'uninstall')) && !['disabled','grant-revoked','credential-revoked'].includes(action)))) throw new AppRegistryError('LIFECYCLE_BLOCKED');
      const grantId=await operation(record);
      record.revision++; record.updatedAt=this.clock().toISOString();
      await this.repository.save(record,revision);
      await this.audit(context,record,action,reason,typeof grantId === 'string' ? grantId : null);
      return publicRecord(record);
    });
  }
  private async require(appId: string, lock=false) {
    const record=await this.repository.findByAppId(validAppId(appId),lock);
    if (!record) throw new AppRegistryError('APP_NOT_FOUND'); return record;
  }
  private async audit(context: PlatformManagementContext, record: StoredAppInstallation, action: AppInstallationHistory['action'], reason?: string, grantId: string | null = null) {
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) throw new AppRegistryError('INVALID_REASON');
    await this.repository.appendHistory({ installationId:record.id,revision:record.revision,action,actorPersonId:context.actorType === 'person' ? context.person.id : null,actorAdministratorId:context.actorType === 'administrator' ? context.administrator.id : null,at:record.updatedAt,reason:reason?.trim() || null,grantId,grant:structuredClone(record.grants.find((g) => g.grantId === grantId) ?? null),serviceIdentityId:record.serviceIdentityId,...(record.lifecycle && action.startsWith('lifecycle-') ? { lifecycle: structuredClone(record.lifecycle) } : {}) });
  }
}
async function admin(context: PlatformManagementContext, action:'read'|'manage') {
  if (!isNativeManagementActor(context) || !(await context.authorize(`platform.authorization.${action}`,{})).allowed) throw new AppRegistryError('REGISTRY_ACCESS_DENIED');
}
function publicRecord(record: StoredAppInstallation): AppInstallation { const { credentialDigest: _digest,...rest }=record; return structuredClone(rest); }
function digest(secret: string) { return createHash('sha256').update(secret).digest('hex'); }
function instant(value: string) { if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new AppRegistryError('INVALID_INSTANT'); return value; }
function validAppId(value: string) { if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) throw new AppRegistryError('INVALID_APP_ID'); return value; }

function checkRevision(record: StoredAppInstallation, revision: number) { if (!Number.isSafeInteger(revision) || revision < 1 || record.revision !== revision) throw new AppRegistryError('STALE_REVISION'); }
