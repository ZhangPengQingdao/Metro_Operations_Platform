import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('L1 Core config, migration engine, and storage contain no application-owned catalogs', async () => {
  const [configSource, migrationSource, storageSource] = await Promise.all([
    readFile(new URL('../src/core/config/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/migrations/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/storage/index.ts', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(configSource, /HazardAiConfig|hazardAi|HAZARD_|STATS_READ/);
  assert.doesNotMatch(migrationSource, /LEGACY_DATABASE_SCRIPT_MIGRATIONS|legacy-init-|legacy-migrate-/);
  assert.doesNotMatch(migrationSource, /fault_records|todo_tasks|workgroups|morning_meeting|digital_signature/);
  assert.doesNotMatch(storageSource, /PUBLIC_STORAGE_KINDS|\['photos', 'recordings', 'signatures'\]/);
  assert.doesNotMatch(storageSource, /StorageObjectOwner|workgroupId|purpose\?:|entityKey\?:/);
});
