import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { initializePlatformDatabase } from '../src/setup/schema.ts';

test('legacy cleanup removes signed-package installations and their tables, keeps .mopkg apps and app data permissions', async () => {
  const pg = new PGlite();
  const db = { query: async (sql: string, args?: readonly unknown[]) => args ? pg.query(sql, [...args]) : (await pg.exec(sql)).at(-1)! };
  try {
    await initializePlatformDatabase(db);
    const now = new Date().toISOString();
    const record = (id: string, appId: string, runtime?: unknown) => JSON.stringify({ id, appId, revision: 1, enabled: true, manifest: {}, grants: [], serviceIdentityId: null, credentialDigest: null, createdAt: now, updatedAt: now, ...(runtime ? { runtime } : {}) });
    const legacy = randomUUID(), current = randomUUID();
    await pg.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3),($4,$5,1,$6)',
      [legacy, 'old-app', record(legacy, 'old-app'), current, 'new-app', record(current, 'new-app', { model: 'v2', sha256: 'a'.repeat(64), manifest: {} })]);
    await pg.query('INSERT INTO platform_app_authorization(installation_id,revision) VALUES($1,$3),($2,$4)', [legacy, current, randomUUID(), randomUUID()]);
    await pg.query("INSERT INTO platform_app_installation_history(installation_id,revision,record) VALUES($1,1,$2)", [legacy, JSON.stringify({ installationId: legacy, revision: 1 })]);
    // State of a database written by 0.30.0: a signed-package bookkeeping table and the cleanup not yet applied.
    await pg.exec('CREATE TABLE platform_app_install_requests(id uuid PRIMARY KEY)');
    await pg.query("DELETE FROM platform_schema_migrations WHERE id='app-legacy-runtime-cleanup'");

    assert.deepEqual(await initializePlatformDatabase(db), ['app-legacy-runtime-cleanup']);
    assert.deepEqual((await pg.query<{ app_id: string }>('SELECT app_id FROM platform_app_installations ORDER BY app_id')).rows.map(row => row.app_id), ['new-app']);
    assert.deepEqual((await pg.query<{ installation_id: string }>('SELECT installation_id FROM platform_app_authorization')).rows.map(row => row.installation_id), [current]);
    assert.equal((await pg.query('SELECT 1 FROM platform_app_installation_history WHERE installation_id=$1', [legacy])).rows.length, 0);
    assert.equal((await pg.query<{ t: string | null }>("SELECT to_regclass('platform_app_install_requests')::text AS t")).rows[0]!.t, null);
    assert.deepEqual((await pg.query<{ code: string }>("SELECT code FROM platform_permissions WHERE code LIKE 'platform.app_data.%' ORDER BY code")).rows.map(row => row.code), ['platform.app_data.read', 'platform.app_data.write']);
  } finally { await pg.close(); }
});
