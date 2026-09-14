import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PostgresAppMigrationDriver, compileAppMigration, type AppMigrationExecutionRequest,
  type AppMigrationPgClient, type AppMigrationClientConfig, type AppMigrationCredentials } from '../src/app-platform/storage/index.ts';

function request(): AppMigrationExecutionRequest {
  const installationId = '00000000-0000-4000-8000-000000000001';
  const schema = `app_${installationId.replaceAll('-', '')}`;
  const declarationJson = JSON.stringify({ migrationVersion: '1.0', operations: [{ kind: 'createTable', table: 'loans', columns: [{ name: 'id', type: 'integer', nullable: false }] }] });
  return { binding: { mode: 'managed', installationId, schema, ownerRole: `${schema}_owner`, runtimeRole: `${schema}_runtime`, appId: 'tool-lending', manifestDigest: 'a'.repeat(64) },
    revision: 1, attemptId: '00000000-0000-4000-8000-000000000002', ordinal: 0,
    step: { id: 'initial', artifactId: 'initial', path: 'migrations/initial.json', bytes: Buffer.byteLength(declarationJson), sha256: createHash('sha256').update(declarationJson).digest('hex'), declarationJson, sql: compileAppMigration(declarationJson, schema).join('\n') } };
}
function fixture() {
  const input = request(); const statements: string[] = []; const configs: AppMigrationClientConfig[] = [];
  let providerCalls = 0; let connects = 0; let ends = 0;
  const credentials: AppMigrationCredentials = { host: '127.0.0.1', port: 5432, database: 'isolated', user: input.binding.ownerRole, password: 'test-only', ssl: false };
  const identity: Record<string, unknown> = { session_user: input.binding.ownerRole, current_user: input.binding.ownerRole, owns_schema: true,
    rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false, memberships: false };
  let errorListener: ((error: Error) => void) | undefined;
  const faults = { connect: false, end: false, throwAt: new Set<string>(), command: new Map<string, string>(), emitAt: '' };
  const client: AppMigrationPgClient = {
    async connect() { connects++; if (faults.connect) throw new Error('private connection'); },
    async query(sql) {
      statements.push(sql);
      if (faults.emitAt === sql) errorListener?.(new Error('private socket'));
      if (faults.throwAt.has(sql)) throw new Error('password=private');
      return { command: faults.command.get(sql) ?? sql.split(' ')[0], rows: sql.startsWith('SELECT session_user') ? [identity] : [] };
    },
    async end() { ends++; if (faults.end) throw new Error('private cleanup'); },
    on(_event, listener) { errorListener = listener; },
  };
  const driver = new PostgresAppMigrationDriver(async binding => { providerCalls++; assert.ok(Object.isFrozen(binding)); return credentials; }, {}, config => { configs.push(config); return client; });
  return { input, driver, credentials, identity, faults, statements, configs, client,
    counts: () => ({ providerCalls, connects, ends }) };
}

test('dedicated driver uses explicit bounded configuration and executes compiler output in transaction', async () => {
  const f = fixture();
  assert.equal(await f.driver.execute(f.input), 'applied');
  assert.deepEqual(f.counts(), { providerCalls: 1, connects: 1, ends: 1 });
  const c = f.configs[0];
  assert.equal(c.user, f.input.binding.ownerRole); assert.equal(c.password, 'test-only');
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.database, 'isolated'); assert.equal(c.port, 5432);
  assert.equal(c.ssl, false); assert.equal(c.replication, 'false'); assert.equal(c.client_encoding, 'UTF8');
  assert.equal(c.options, '-c search_path=pg_catalog'); assert.equal(c.application_name, 'app-migration');
  assert.equal(c.connectionTimeoutMillis, 5000); assert.equal(c.statement_timeout, 30000); assert.equal(c.lock_timeout, 5000);
  assert.equal(c.connectionString, undefined);
  assert.deepEqual(f.statements.slice(1), ['BEGIN', 'SET LOCAL search_path = pg_catalog', 'SET LOCAL statement_timeout = 30000', 'SET LOCAL lock_timeout = 5000', f.input.step.sql, 'COMMIT']);
  assert.ok(!f.statements.some(sql => sql.includes('SET ROLE')));
});

test('tampered source, generated SQL, binding and bounded metadata fail before credential acquisition', async () => {
  const base = request();
  const bad: AppMigrationExecutionRequest[] = [
    { ...base, step: { ...base.step, sql: 'COMMIT; DROP SCHEMA public CASCADE' } },
    { ...base, step: { ...base.step, declarationJson: base.step.declarationJson + ' ' } },
    { ...base, step: { ...base.step, sha256: 'b'.repeat(64) } },
    { ...base, step: { ...base.step, bytes: 1048577 } },
    { ...base, step: { ...base.step, declarationJson: ' '.repeat(1048577), bytes: 1 } },
    { ...base, binding: { ...base.binding, ownerRole: 'postgres' } },
    { ...base, binding: { ...base.binding, schema: 'public' } },
    { ...base, binding: { ...base.binding, runtimeRole: 'postgres' } },
    { ...base, attemptId: 'untrusted' }, { ...base, revision: 0 }, { ...base, ordinal: 128 },
  ];
  for (const input of bad) { const f = fixture(); assert.equal(await f.driver.execute(input), 'rolled_back'); assert.equal(f.counts().providerCalls, 0); }
});

test('unsafe credentials and plaintext nonloopback hosts fail before client creation', async () => {
  for (const patch of [{ host: '' }, { host: '/tmp/socket' }, { host: 'db.example.com' }, { database: '' }, { password: '' }, { user: 'postgres' }, { port: 0 }, { port: 65536 }]) {
    const f = fixture(); Object.assign(f.credentials, patch);
    assert.equal(await f.driver.execute(f.input), 'rolled_back'); assert.equal(f.configs.length, 0);
  }
  const f = fixture(); f.credentials.host = 'db.example.com'; f.credentials.ssl = { rejectUnauthorized: true, ca: 'test-ca' };
  assert.equal(await f.driver.execute(f.input), 'applied');
  assert.deepEqual(f.configs[0].ssl, { rejectUnauthorized: true, ca: 'test-ca' });
  const failed = new PostgresAppMigrationDriver(async () => { throw new Error('password=private'); });
  assert.equal(await failed.execute(request()), 'rolled_back');
});

test('wrong identity, elevated role, membership and schema ownership reject before BEGIN', async () => {
  for (const patch of [{ session_user: 'postgres' }, { current_user: 'postgres' }, { owns_schema: false },
    ...['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls', 'memberships'].map(key => ({ [key]: true }))]) {
    const f = fixture(); Object.assign(f.identity, patch);
    assert.equal(await f.driver.execute(f.input), 'rolled_back'); assert.equal(f.statements.length, 1); assert.equal(f.counts().ends, 1);
  }
});

test('statement failure reports rollback only when server acknowledges ROLLBACK', async () => {
  const f = fixture(); f.faults.throwAt.add(f.input.step.sql);
  assert.equal(await f.driver.execute(f.input), 'rolled_back'); assert.equal(f.statements.at(-1), 'ROLLBACK'); assert.equal(f.counts().ends, 1);
  for (const mode of ['throw', 'malformed']) {
    const failed = fixture(); failed.faults.throwAt.add(failed.input.step.sql);
    if (mode === 'throw') failed.faults.throwAt.add('ROLLBACK'); else failed.faults.command.set('ROLLBACK', 'UNKNOWN');
    assert.equal(await failed.driver.execute(failed.input), 'uncertain'); assert.equal(failed.counts().ends, 1);
  }
});

test('COMMIT failure or malformed response is uncertain and never converted by a rollback or retried', async () => {
  for (const mode of ['throw', 'malformed']) {
    const f = fixture();
    if (mode === 'throw') f.faults.throwAt.add('COMMIT'); else f.faults.command.set('COMMIT', 'ROLLBACK');
    assert.equal(await f.driver.execute(f.input), 'uncertain');
    assert.equal(f.statements.filter(sql => sql === f.input.step.sql).length, 1);
    assert.equal(f.statements.at(-1), 'COMMIT'); assert.equal(f.counts().ends, 1);
  }
});

test('transport events and cleanup failures fail conservatively while always closing dedicated client', async () => {
  const connect = fixture(); connect.faults.connect = true;
  assert.equal(await connect.driver.execute(connect.input), 'rolled_back'); assert.equal(connect.counts().ends, 1); assert.equal(connect.statements.length, 0);
  const cleanup = fixture(); cleanup.faults.end = true;
  assert.equal(await cleanup.driver.execute(cleanup.input), 'uncertain'); assert.equal(cleanup.counts().ends, 1);
  for (const sql of ['COMMIT', request().step.sql]) {
    const socket = fixture(); socket.faults.emitAt = sql;
    assert.equal(await socket.driver.execute(socket.input), 'uncertain'); assert.equal(socket.counts().ends, 1);
  }
});

test('invalid timeout configuration fails before credentials; no client-side race timeout', async () => {
  for (const options of [{ statementTimeoutMs: 0 }, { statementTimeoutMs: 300001 }, { lockTimeoutMs: 60001 }, { lockTimeoutMs: NaN }]) {
    let called = false;
    const driver = new PostgresAppMigrationDriver(async () => { called = true; throw new Error('unused'); }, options);
    assert.equal(await driver.execute(request()), 'rolled_back'); assert.equal(called, false);
  }
});

test('durable transaction hook precedes DDL and failed registration or final admission rolls back',async()=>{
 for(const failure of ['none','receipt','admission']) {
  const f=fixture(); let registered=false; let admitted=false;
  const client:AppMigrationPgClient={...f.client,async query(sql,values){
   if(sql==='SELECT pg_current_xact_id()::text AS xid, current_database() AS database') return {command:'SELECT',rows:[{xid:'10',database:'isolated'}]};
   if(sql===f.input.step.sql) assert.equal(registered,true);
   if(sql==='COMMIT') assert.equal(admitted,true);
   return f.client.query(sql,values);
  }};
  const driver=new PostgresAppMigrationDriver(async()=>f.credentials,{},()=>client,{
   async onTransaction(r,e){assert.equal(r.attemptId,f.input.attemptId);assert.deepEqual(e,{xid:'10',database:'isolated'});
    if(failure==='receipt') throw new Error('private receipt failure'); registered=true;},
   async beforeCommit(){if(failure==='admission') throw new Error('private revoked access'); admitted=true;}
  });
  assert.equal(await driver.execute(f.input),failure==='none'?'applied':'rolled_back');
  if(failure==='receipt') assert.ok(!f.statements.includes(f.input.step.sql));
  if(failure!=='none') {assert.ok(!f.statements.includes('COMMIT'));assert.equal(f.statements.at(-1),'ROLLBACK');}
 }
});
