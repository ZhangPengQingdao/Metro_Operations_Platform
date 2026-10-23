import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { AppProcessV2 } from '../src/app-platform/v2/process.ts';

// A built server.js is self-contained; this fixture mirrors defineServer()'s output without imports.
const SERVER = `
let started = 0;
export default { kind: 'mop-server', version: 1, hooks: { start(ctx) { started++; ctx.log('started ' + ctx.appId); } }, handlers: {
  async echo(input, ctx) { return { input, person: ctx.employee.personId, can: ctx.can('read') }; },
  async lookup(input, ctx) { return ctx.platform.invoke('platform.people.members', { q: input.q }); },
  async save(input, ctx) { return ctx.data.get('records', input.id); },
  async fail() { throw new Error('INVALID_INPUT'); },
  async secret() { return { env: Object.keys(process.env).sort() }; },
  async crash() { setTimeout(() => process.exit(3), 10); return new Promise(() => {}); },
  async slow() { return new Promise(() => {}); },
} };`;
const employee = { version: '1.0' as const, personId: '11111111-1111-4111-8111-111111111111', organizationUnitId: '22222222-2222-4222-8222-222222222222', requestId: 'r', traceId: 't',
  businessAuthorization: { revision: '33333333-3333-4333-8333-333333333333', organizations: [], grants: [{ permission: 'app.demo.read', all: true, self: false, organizationIds: [] }] } };

async function withProcess(run: (process: AppProcessV2, platform: { operation: string; params: unknown; callId?: string }[], logs: string[]) => Promise<void>, timeoutMs = 2000) {
  const dir = await mkdtemp(join(tmpdir(), 'mop-v2-process-'));
  await writeFile(join(dir, 'server.js'), SERVER);
  const platform: { operation: string; params: unknown; callId?: string }[] = [], logs: string[] = [];
  const app = new AppProcessV2({ appId: 'demo', serverPath: join(dir, 'server.js'), cwd: dir, timeoutMs, log: line => logs.push(line),
    onPlatform: async (operation, params, callId) => {
      platform.push({ operation, params, ...(callId ? { callId } : {}) });
      if (operation === 'platform.app_data.get') throw Object.assign(new Error('x'), { code: 'STORAGE_CONFLICT', writeOutcome: 'not_started' });
      return { rows: [{ name: '张三' }] };
    } });
  try { await run(app, platform, logs); } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
}

test('child process serves calls with the employee context and proxies platform calls', async () => withProcess(async (app, platform, logs) => {
  await app.start();
  assert.equal(app.status().state, 'running');
  assert.deepEqual([...app.handlerNames].sort(), ['crash', 'echo', 'fail', 'lookup', 'save', 'secret', 'slow']);
  assert.ok(logs.some(line => line.includes('[app:demo] started demo')));
  assert.deepEqual(await app.call('echo', { a: 1 }, employee), { input: { a: 1 }, person: employee.personId, can: true });
  assert.deepEqual(await app.call('lookup', { q: '张' }, employee), { rows: [{ name: '张三' }] });
  assert.equal(platform[0]!.operation, 'platform.people.members');
  assert.ok(platform[0]!.callId, 'platform calls are bound to the employee call');
  await assert.rejects(app.call('save', { id: 'x' }, employee), { code: 'STORAGE_CONFLICT' });
  await assert.rejects(app.call('fail', {}, employee), { code: 'INVALID_INPUT', writeOutcome: 'unknown' });
  await assert.rejects(app.call('missing', {}, employee), { code: 'UNKNOWN_API' });
  const { env } = await app.call('secret', {}, employee) as { env: string[] };
  assert.ok(!env.some(name => /DATABASE|SECRET|KEY|PASSWORD/.test(name)), `child env leaks ${env.join(',')}`);
}));

test('a crashed child fails its pending call as unknown and is restarted', async () => withProcess(async app => {
  await app.start();
  const firstPid = app.status().pid;
  await assert.rejects(app.call('crash', {}, employee), { code: 'APP_PROCESS_EXITED', writeOutcome: 'unknown' });
  for (let i = 0; i < 50 && app.status().state !== 'running'; i++) await wait(100);
  assert.equal(app.status().state, 'running');
  assert.notEqual(app.status().pid, firstPid);
  assert.equal(app.status().restarts, 1);
  assert.deepEqual(await app.call('echo', 1, employee), { input: 1, person: employee.personId, can: true });
}));

test('calls time out, aborts propagate and stop ends the process', async () => withProcess(async app => {
  await app.start();
  await assert.rejects(app.call('slow', {}, employee), { code: 'TIMEOUT', writeOutcome: 'unknown' });
  const controller = new AbortController();
  const pending = app.call('slow', {}, employee, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  await app.stop();
  assert.equal(app.status().state, 'stopped');
  await assert.rejects(app.call('echo', {}, employee), { code: 'APP_NOT_RUNNING' });
}, 300));

test('an invalid server export fails to start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mop-v2-process-'));
  try {
    await writeFile(join(dir, 'server.js'), 'export default { handlers: {} };');
    const app = new AppProcessV2({ appId: 'demo', serverPath: join(dir, 'server.js'), cwd: dir, onPlatform: async () => null, log: () => {} });
    await assert.rejects(app.start(), { code: 'INVALID_SERVER_EXPORT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
