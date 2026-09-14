import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MigrationRegistryError,
  createMigrationRegistry,
  type MigrationDefinition,
  type MigrationExecutionContext
} from '../src/core/migrations/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPath = path.resolve(__dirname, '../..');

class FakeClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    return { rows: [] };
  }
}

function migration(
  id: string,
  run: MigrationDefinition['run'],
  options: Partial<MigrationDefinition> = {}
): MigrationDefinition {
  return {
    id,
    title: `Migration ${id}`,
    ownerTaskId: 'PLATFORM-L1-006',
    phase: 'expand',
    layer: 'L1',
    dataRows: [],
    migrationRows: ['MIG-038'],
    sourceTables: [],
    targetTables: [],
    recoveryNotes: 'Use isolated database restore or forward repair before retrying.',
    run,
    ...options
  };
}

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++));
}

test('Core Migrations rejects duplicate or unsafe migration definitions', () => {
  const noop = async () => ({ applied: true });

  assert.throws(
    () => createMigrationRegistry([migration('duplicate-id', noop), migration('duplicate-id', noop)]),
    /重复的迁移 ID/
  );

  assert.throws(
    () => createMigrationRegistry([migration('bad_id', noop)]),
    /稳定 kebab-case/
  );

  assert.throws(
    () => createMigrationRegistry([
      migration('contract-drop-old-column', noop, {
        phase: 'contract',
        dataRows: ['DATA-001']
      })
    ]),
    /contract 阶段迁移必须声明/
  );

  assert.throws(
    () => createMigrationRegistry([migration('self-loop', noop, { dependsOn: ['self-loop'] })]),
    /不能依赖自己/
  );
});

test('Core Migrations orders dependencies and skips already applied migrations', async () => {
  const client = new FakeClient();
  const executed: string[] = [];
  const context: MigrationExecutionContext = { client };
  const registry = createMigrationRegistry([
    migration('create-target-view', async () => {
      executed.push('create-target-view');
      await client.query('CREATE VIEW');
      return { notes: ['view ready'] };
    }, { dependsOn: ['create-target-table'] }),
    migration('create-target-table', async () => {
      executed.push('create-target-table');
      await client.query('CREATE TABLE');
    })
  ]);

  assert.deepEqual(
    registry.plan({ appliedMigrationIds: ['create-target-table'] }).map((item) => item.id),
    ['create-target-view']
  );

  const summary = await registry.run({
    context,
    appliedMigrationIds: ['create-target-table'],
    clock: fixedClock()
  });

  assert.deepEqual(executed, ['create-target-view']);
  assert.deepEqual(client.queries.map((query) => query.text), ['CREATE VIEW']);
  assert.deepEqual(summary.plannedMigrationIds, ['create-target-view']);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.records.map((record) => [record.id, record.status]), [
    ['create-target-table', 'skipped'],
    ['create-target-view', 'succeeded']
  ]);
});

test('Core Migrations stops on failed migration without running later migrations', async () => {
  const executed: string[] = [];
  const registry = createMigrationRegistry([
    migration('first-migration', async () => {
      executed.push('first-migration');
    }),
    migration('broken-migration', async () => {
      executed.push('broken-migration');
      throw new Error('boom');
    }),
    migration('later-migration', async () => {
      executed.push('later-migration');
    })
  ]);

  const summary = await registry.run({
    context: { client: new FakeClient() },
    clock: fixedClock()
  });

  assert.deepEqual(executed, ['first-migration', 'broken-migration']);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.records.at(-1)?.id, 'broken-migration');
  assert.match(summary.records.at(-1)?.errorMessage ?? '', /boom/);
});

test('Core Migrations gates contract migrations by mixed-version compatibility', () => {
  const registry = createMigrationRegistry([
    migration('drop-legacy-column', async () => undefined, {
      phase: 'contract',
      dataRows: ['DATA-001'],
      minimumAppVersion: '1.0.0',
      removalGate: 'All readers use the people directory contract.'
    })
  ]);

  assert.throws(
    () => registry.plan({ activeAppVersion: '0.9.9' }),
    /需要应用版本至少 1.0.0/
  );

  assert.throws(
    () => registry.plan({ activeAppVersion: '0.0.1-alpha.2' }),
    /需要应用版本至少 1.0.0/
  );

  assert.deepEqual(
    registry.plan({ activeAppVersion: '1.0.0' }).map((item) => item.id),
    ['drop-legacy-column']
  );
});
