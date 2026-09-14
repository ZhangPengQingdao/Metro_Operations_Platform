import type { QueryableClient } from '../database/index.js';

export type MigrationPhase = 'expand' | 'backfill' | 'dual-read' | 'switch' | 'contract';
export type MigrationLayer = 'L1' | 'L2' | 'L3' | 'L4';
export type MigrationRunStatus = 'skipped' | 'succeeded' | 'failed';

export interface MigrationExecutionContext {
  client: QueryableClient;
  logger?: {
    info?(message: string, metadata?: Record<string, unknown>): void;
    warn?(message: string, metadata?: Record<string, unknown>): void;
    error?(message: string, metadata?: Record<string, unknown>): void;
  };
  signal?: AbortSignal;
}

export interface MigrationResult {
  applied?: boolean;
  notes?: readonly string[];
  reconciliation?: Record<string, unknown>;
}

export interface MigrationDefinition {
  id: string;
  title: string;
  ownerTaskId: string;
  phase: MigrationPhase;
  layer: MigrationLayer;
  dataRows: readonly string[];
  migrationRows: readonly string[];
  sourceTables: readonly string[];
  targetTables: readonly string[];
  dependsOn?: readonly string[];
  minimumAppVersion?: string;
  removalGate?: string;
  recoveryNotes: string;
  run(context: MigrationExecutionContext): Promise<MigrationResult | void>;
}

export interface MigrationPlanOptions {
  appliedMigrationIds?: Iterable<string>;
  activeAppVersion?: string;
}

export interface MigrationRunOptions extends MigrationPlanOptions {
  context: MigrationExecutionContext;
  clock?: () => Date;
}

export interface MigrationRunRecord {
  id: string;
  phase: MigrationPhase;
  status: MigrationRunStatus;
  startedAt: string;
  finishedAt: string;
  skippedReason?: string;
  errorMessage?: string;
  result?: MigrationResult;
}

export interface MigrationRunSummary {
  plannedMigrationIds: string[];
  records: MigrationRunRecord[];
  succeeded: number;
  skipped: number;
  failed: number;
}

export class MigrationRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MigrationRegistryError';
    this.code = code;
  }
}

export class MigrationRegistry {
  private readonly migrations = new Map<string, MigrationDefinition>();

  constructor(migrations: readonly MigrationDefinition[] = []) {
    this.register(...migrations);
  }

  register(...migrations: readonly MigrationDefinition[]) {
    for (const migration of migrations) {
      validateMigrationDefinition(migration);

      if (this.migrations.has(migration.id)) {
        throw new MigrationRegistryError('DUPLICATE_MIGRATION_ID', `重复的迁移 ID: ${migration.id}`);
      }

      this.migrations.set(migration.id, migration);
    }

    return this;
  }

  get(id: string) {
    return this.migrations.get(id) ?? null;
  }

  list() {
    return [...this.migrations.values()];
  }

  ordered() {
    return orderMigrations(this.list());
  }

  plan(options: MigrationPlanOptions = {}) {
    return planMigrations(this, options);
  }

  run(options: MigrationRunOptions) {
    return runMigrations(this, options);
  }
}

export function createMigrationRegistry(migrations: readonly MigrationDefinition[] = []) {
  return new MigrationRegistry(migrations);
}

export function validateMigrationDefinition(migration: MigrationDefinition) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(migration.id)) {
    throw new MigrationRegistryError('INVALID_MIGRATION_ID', `迁移 ID 必须是稳定 kebab-case: ${migration.id}`);
  }

  if (!/^PLATFORM-[A-Z0-9]+-\d{3}$/.test(migration.ownerTaskId)) {
    throw new MigrationRegistryError('INVALID_OWNER_TASK', `迁移必须绑定 任务 ID: ${migration.id}`);
  }

  if (!migration.title.trim()) {
    throw new MigrationRegistryError('MISSING_TITLE', `迁移缺少标题: ${migration.id}`);
  }

  if (migration.migrationRows.length === 0) {
    throw new MigrationRegistryError('MISSING_MIGRATION_ROW', `迁移必须关联 migration-ledger 行: ${migration.id}`);
  }

  if (!migration.recoveryNotes.trim()) {
    throw new MigrationRegistryError('MISSING_RECOVERY_NOTES', `迁移必须记录恢复说明: ${migration.id}`);
  }

  if (migration.dependsOn?.includes(migration.id)) {
    throw new MigrationRegistryError('SELF_DEPENDENCY', `迁移不能依赖自己: ${migration.id}`);
  }

  if (migration.phase === 'contract' && (!migration.minimumAppVersion || !migration.removalGate)) {
    throw new MigrationRegistryError(
      'UNSAFE_CONTRACT_MIGRATION',
      `contract 阶段迁移必须声明 minimumAppVersion 和 removalGate: ${migration.id}`
    );
  }
}

export function planMigrations(registry: MigrationRegistry, options: MigrationPlanOptions = {}) {
  const appliedIds = new Set(options.appliedMigrationIds ?? []);

  return registry.ordered().filter((migration) => {
    if (appliedIds.has(migration.id)) {
      return false;
    }

    assertMigrationCanRunForAppVersion(migration, options.activeAppVersion);
    return true;
  });
}

export async function runMigrations(
  registry: MigrationRegistry,
  options: MigrationRunOptions
): Promise<MigrationRunSummary> {
  const appliedIds = new Set(options.appliedMigrationIds ?? []);
  const clock = options.clock ?? (() => new Date());
  const orderedMigrations = registry.ordered();
  const plannedMigrationIds = planMigrations(registry, options).map((migration) => migration.id);
  const records: MigrationRunRecord[] = [];

  for (const migration of orderedMigrations) {
    if (appliedIds.has(migration.id)) {
      const now = clock().toISOString();
      records.push({
        id: migration.id,
        phase: migration.phase,
        status: 'skipped',
        startedAt: now,
        finishedAt: now,
        skippedReason: 'already-applied'
      });
      continue;
    }

    assertMigrationCanRunForAppVersion(migration, options.activeAppVersion);
    const startedAt = clock().toISOString();

    try {
      options.context.signal?.throwIfAborted();
      const result = await migration.run(options.context);
      records.push({
        id: migration.id,
        phase: migration.phase,
        status: 'succeeded',
        startedAt,
        finishedAt: clock().toISOString(),
        result: result ?? { applied: true }
      });
    } catch (error) {
      records.push({
        id: migration.id,
        phase: migration.phase,
        status: 'failed',
        startedAt,
        finishedAt: clock().toISOString(),
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      break;
    }
  }

  return {
    plannedMigrationIds,
    records,
    succeeded: records.filter((record) => record.status === 'succeeded').length,
    skipped: records.filter((record) => record.status === 'skipped').length,
    failed: records.filter((record) => record.status === 'failed').length
  };
}

function orderMigrations(migrations: MigrationDefinition[]) {
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: MigrationDefinition[] = [];

  function visit(migration: MigrationDefinition) {
    if (visited.has(migration.id)) return;

    if (visiting.has(migration.id)) {
      throw new MigrationRegistryError('CIRCULAR_DEPENDENCY', `迁移依赖存在环: ${migration.id}`);
    }

    visiting.add(migration.id);

    for (const dependencyId of migration.dependsOn ?? []) {
      const dependency = byId.get(dependencyId);

      if (!dependency) {
        throw new MigrationRegistryError(
          'UNKNOWN_DEPENDENCY',
          `迁移 ${migration.id} 依赖未注册的迁移: ${dependencyId}`
        );
      }

      visit(dependency);
    }

    visiting.delete(migration.id);
    visited.add(migration.id);
    ordered.push(migration);
  }

  for (const migration of migrations) {
    visit(migration);
  }

  return ordered;
}

function assertMigrationCanRunForAppVersion(migration: MigrationDefinition, activeAppVersion?: string) {
  if (migration.phase !== 'contract' || !migration.minimumAppVersion) {
    return;
  }

  if (!activeAppVersion || compareVersion(activeAppVersion, migration.minimumAppVersion) < 0) {
    throw new MigrationRegistryError(
      'APP_VERSION_TOO_OLD_FOR_CONTRACT',
      `迁移 ${migration.id} 需要应用版本至少 ${migration.minimumAppVersion}，当前版本 ${activeAppVersion ?? 'unknown'}`
    );
  }
}

function compareVersion(left: string, right: string) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  const length = Math.max(leftVersion.parts.length, rightVersion.parts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.parts[index] ?? 0;
    const rightPart = rightVersion.parts[index] ?? 0;

    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  if (leftVersion.prerelease && !rightVersion.prerelease) {
    return -1;
  }

  if (!leftVersion.prerelease && rightVersion.prerelease) {
    return 1;
  }

  if (!leftVersion.prerelease && !rightVersion.prerelease) {
    return 0;
  }

  return comparePrerelease(leftVersion.prerelease ?? '', rightVersion.prerelease ?? '');
}

function parseVersion(version: string) {
  const [core, prerelease] = version.split('-', 2);

  return {
    parts: core
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part)),
    prerelease
  };
}

function comparePrerelease(left: string, right: string) {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];

    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber > rightNumber ? 1 : -1;
    }

    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}
