import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hasActiveDatabaseTransaction, runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import type { AppDockerPolicy } from './docker-policy.js';
import type { AppDockerImageApproval } from './docker-executor.js';

export type AppDockerDispatchAction = 'create' | 'start' | 'stop' | 'remove';
export interface AppDockerDispatchInput {
 installationId: string;
 operationId: string;
 registeredRevision: number;
 appId: string;
 manifestDigest: string;
 action: AppDockerDispatchAction;
 containerId: string | null;
 policy: AppDockerPolicy;
 approval: AppDockerImageApproval;
 expectedSequence: number;
}
export interface AppDockerObservation {
 containerId: string;
 state: 'created' | 'running' | 'stopped' | 'absent';
}
export interface AppDockerDispatchAttempt extends Omit<AppDockerDispatchInput, 'expectedSequence'> {
 id: string;
 sequence: number;
 status: 'dispatched' | 'uncertain' | 'confirmed' | 'rejected';
 observation: AppDockerObservation | null;
 startedAt: string;
 updatedAt: string;
}
export type AppDockerDispatchOutcome = { status: 'rejected' } | { status: 'uncertain' } | { status: 'confirmed'; observation: AppDockerObservation };
export class AppDockerJournalError extends Error {
 constructor(readonly code: string) { super(code); this.name = 'AppDockerJournalError'; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const target = { create: 'created', start: 'running', stop: 'stopped', remove: 'absent' } as const;
const columns = `id,installation_id AS "installationId",sequence,operation_id AS "operationId",
 registered_revision AS "registeredRevision",app_id AS "appId",manifest_digest AS "manifestDigest",
 action,container_id AS "containerId",policy,approval,status,observation,started_at AS "startedAt",updated_at AS "updatedAt"`;
function fail(code: string): never { throw new AppDockerJournalError(code); }
function identifier(value: string): void { if (typeof value !== 'string' || !uuid.test(value)) fail('INVALID_INPUT'); }
function sequence(value: number, minimum: number): void {
 if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) fail('INVALID_INPUT');
}
function snapshot<T>(value: T): T {
 try {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 65536) fail('INVALID_INPUT');
  return JSON.parse(encoded) as T;
 } catch { fail('INVALID_INPUT'); }
}
function inputSnapshot(value: AppDockerDispatchInput): AppDockerDispatchInput {
 const input = snapshot(value);
 identifier(input.installationId); identifier(input.operationId);
 sequence(input.registeredRevision, 1); sequence(input.expectedSequence, 0);
 if (input.expectedSequence === 2147483647 || typeof input.appId !== 'string' || input.appId.length > 64
  || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.appId) || typeof input.manifestDigest !== 'string'
  || !hex.test(input.manifestDigest) || !Object.hasOwn(target, input.action)
  || (input.action === 'create' ? input.containerId !== null : typeof input.containerId !== 'string' || !hex.test(input.containerId))) fail('INVALID_INPUT');
 const labels = input.policy?.body?.Labels;
 if (!labels || labels['afc.app.installation'] !== input.installationId || labels['afc.app.id'] !== input.appId
  || !uuid.test(labels['afc.app.operation'])
  || input.policy.name !== `afc-app-${input.installationId}-${labels['afc.app.operation']}`
  || (input.action === 'create' && labels['afc.app.operation'] !== input.operationId)
  || !input.approval || !/^sha256:[0-9a-f]{64}$/.test(input.approval.imageId)
  || !input.approval.config || typeof input.approval.config !== 'object' || Array.isArray(input.approval.config)) fail('INVALID_BINDING');
 return input;
}

/** Trusted platform metadata on one dedicated connection. Caller authorizes native administrator,
 * validates manifest/policy approval and commits reserve BEFORE calling Docker (never inside an outer transaction).
 * No expiry, cancellation or automatic retry. Confirmation is host observation attestation only.
 */
export class AppDockerJournal {
 constructor(private readonly client: QueryableClient, private readonly clock: () => Date = () => new Date()) {}
 async reserve(value: AppDockerDispatchInput): Promise<AppDockerDispatchAttempt> {
  if (hasActiveDatabaseTransaction(this.client)) fail('OUTER_TRANSACTION_FORBIDDEN');
  const input = inputSnapshot(value);
  return runDatabaseTransaction(this.client, async () => {
   await this.lock(input.installationId);
   const registry = (await this.rows<{appId: string; revision: number; record: { enabled?: unknown; lifecycle?: { operationId?: unknown; status?: unknown } }}>(
    'SELECT app_id AS "appId",revision,record FROM platform_app_installations WHERE id=$1 FOR UPDATE', [input.installationId]))[0];
   if (!registry || registry.appId !== input.appId || registry.revision !== input.registeredRevision
    || registry.record.enabled !== false || registry.record.lifecycle?.operationId !== input.operationId
    || !['running', 'failed'].includes(String(registry.record.lifecycle.status))) fail('REGISTRY_BINDING_MISMATCH');
   const latest = await this.current(input.installationId, true);
   if (latest && !['confirmed', 'rejected'].includes(latest.status)) fail('DISPATCH_BLOCKED');
   if ((latest?.sequence ?? 0) !== input.expectedSequence) fail('STALE_SEQUENCE');
   if (input.action === 'create') {
    if (latest && latest.status !== 'rejected' && (latest.action !== 'remove' || latest.observation?.state !== 'absent')) fail('LIVE_CONTAINER_EXISTS');
   } else {
    if (!latest?.observation || latest.observation.containerId !== input.containerId || latest.observation.state === 'absent'
     || !isDeepStrictEqual(latest.policy, input.policy) || !isDeepStrictEqual(latest.approval, input.approval)
     || (input.action === 'start' && latest.observation.state !== 'created')
     || (input.action === 'remove' && !['created', 'stopped'].includes(latest.observation.state))) fail('CONTAINER_CHAIN_MISMATCH');
   }
   const at = this.instant();
   if (latest && Date.parse(at) < Date.parse(latest.updatedAt)) fail('CLOCK_REGRESSION');
   return (await this.attempts(`INSERT INTO platform_app_docker_dispatches
    (id,installation_id,sequence,operation_id,registered_revision,app_id,manifest_digest,action,container_id,policy,approval,status,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'dispatched',$12,$12) RETURNING ${columns}`,
    [randomUUID(), input.installationId, input.expectedSequence + 1, input.operationId, input.registeredRevision,
     input.appId, input.manifestDigest, input.action, input.containerId, JSON.stringify(input.policy), JSON.stringify(input.approval), at]))[0];
  });
 }
 async latest(installationId: string): Promise<AppDockerDispatchAttempt | null> {
  identifier(installationId);
  return runDatabaseTransaction(this.client, () => this.current(installationId));
 }
 async finish(installationId: string, attemptId: string, expectedSequence: number, value: AppDockerDispatchOutcome): Promise<AppDockerDispatchAttempt> {
  identifier(installationId); identifier(attemptId); sequence(expectedSequence, 1);
  const outcome = snapshot(value);
  if (!outcome || !['uncertain', 'confirmed', 'rejected'].includes(outcome.status)) fail('INVALID_OUTCOME');
  if (outcome.status === 'confirmed' && (!outcome.observation || typeof outcome.observation.containerId !== 'string'
   || !hex.test(outcome.observation.containerId)
   || !Object.values(target).includes(outcome.observation.state)
   || Object.keys(outcome.observation).some(key => !['containerId', 'state'].includes(key)))) fail('INVALID_OBSERVATION');
  return runDatabaseTransaction(this.client, async () => {
   await this.lock(installationId);
   const current = await this.current(installationId, true);
   if (!current || current.id !== attemptId || current.sequence !== expectedSequence) fail('STALE_ATTEMPT');
   const observation = outcome.status === 'confirmed' ? outcome.observation : null;
   if (observation && (observation.state !== target[current.action]
    || (current.containerId !== null && observation.containerId !== current.containerId))) fail('INVALID_OBSERVATION');
   if (current.status === 'rejected') {
    if (outcome.status === 'rejected') return current;
    fail('TERMINAL_CONFLICT');
   }
   // Only the original dispatch can attest a completed create rejection. Never reinterpret unknown history.
   if (outcome.status === 'rejected' && (current.action !== 'create' || current.status !== 'dispatched')) fail('INVALID_OUTCOME');
   if (current.status === 'confirmed') {
    if (outcome.status === 'confirmed' && isDeepStrictEqual(current.observation, observation)) return current;
    fail('TERMINAL_CONFLICT');
   }
   if (current.status === 'uncertain' && outcome.status === 'uncertain') return current;
   const at = this.instant();
   if (Date.parse(at) < Date.parse(current.updatedAt)) fail('CLOCK_REGRESSION');
   return (await this.attempts(`UPDATE platform_app_docker_dispatches SET status=$4,observation=$5,updated_at=$6
    WHERE installation_id=$1 AND id=$2 AND sequence=$3 AND status IN ('dispatched','uncertain') RETURNING ${columns}`,
    [installationId, attemptId, expectedSequence, outcome.status, observation === null ? null : JSON.stringify(observation), at]))[0];
  });
 }
 private async lock(id: string): Promise<void> {
  await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`app-docker:${id}`]);
 }
 private async current(id: string, locked = false): Promise<AppDockerDispatchAttempt | null> {
  return (await this.attempts(`SELECT ${columns} FROM platform_app_docker_dispatches WHERE installation_id=$1 ORDER BY sequence DESC LIMIT 1${locked ? ' FOR UPDATE' : ''}`, [id]))[0] ?? null;
 }
 private async attempts(sql: string, values: readonly unknown[]): Promise<AppDockerDispatchAttempt[]> {
  const rows = await this.rows<AppDockerDispatchAttempt & { startedAt: string | Date; updatedAt: string | Date }>(sql, values);
  return rows.map(row => ({ ...row, startedAt: new Date(row.startedAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() }));
 }
 private async rows<T>(sql: string, values: readonly unknown[]): Promise<T[]> {
  return (await this.client.query(sql, values) as { rows: T[] }).rows;
 }
 private instant(): string {
  const value = this.clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_CLOCK');
  return value.toISOString();
 }
}
