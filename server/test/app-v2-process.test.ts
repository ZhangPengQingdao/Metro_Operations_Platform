import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
  for (let i = 0; i < 20 && !logs.some(line => line.includes('[app:demo] started demo')); i++) await wait(25);
  assert.ok(logs.some(line => line.includes('[app:demo] started demo')), 'start() hook runs after ready');
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

test('a v1 createAppBackend entry runs in the v2 child over IPC, two at once', async () => {
  const { build } = await import('esbuild');
  const dir = await mkdtemp(join(tmpdir(), 'mop-v2-legacy-'));
  const entry = join(dir, 'entry.mjs');
  // Shape of the existing applications' entry.mjs: stdio backend, health port 8080, gateway-based data client.
  await writeFile(entry, `
import {createServer} from 'node:http';
import {createAppBackend} from '@metro/platform-sdk/app-backend';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
const handlers = new Map([['detail', {method: 'POST', path: '/detail', requireEmployeeContext: true, async execute(payload, signal, employee) {
  const data = createAppDataClient({invoke: (...args) => backend.gateway.invoke(...args)});
  try { return {ok: true, result: {row: await data.get('records', payload.id), person: employee.personId}}; }
  catch (error) { return {ok: false, error: {code: error.code, writeOutcome: error.writeOutcome}}; }
}}]]);
const backend = createAppBackend({input: process.stdin, output: process.stdout, handlers});
const health = createServer((req, res) => { res.writeHead(200); res.end(); });
health.listen(8080, '127.0.0.1');
void backend.whenClosed.then(() => health.close());
`);
  await build({ entryPoints: [entry], outfile: join(dir, 'server.js'), bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)), nodePaths: [fileURLToPath(new URL('../../node_modules', import.meta.url))] });
  const platform: { operation: string; callId?: string }[] = [];
  const make = () => new AppProcessV2({ appId: 'legacy', serverPath: join(dir, 'server.js'), cwd: dir, log: () => {},
    onPlatform: async (operation, params, callId) => {
      platform.push({ operation, ...(callId ? { callId } : {}) });
      if ((params as { id: string }).id === 'missing') throw Object.assign(new Error('x'), { code: 'STORAGE_CONFLICT', writeOutcome: 'not_started' });
      return { row: { id: (params as { id: string }).id } };
    } });
  const a = make(), b = make();
  try {
    await Promise.all([a.start(), b.start()]);
    assert.deepEqual([...a.handlerNames], ['detail']);
    assert.deepEqual(await a.call('detail', { id: 'r1' }, employee), { ok: true, result: { row: { row: { id: 'r1' } }, person: employee.personId } });
    assert.deepEqual(await b.call('detail', { id: 'missing' }, employee), { ok: false, error: { code: 'STORAGE_CONFLICT', writeOutcome: 'not_started' } });
    assert.ok(platform.every(call => call.operation === 'platform.app_data.get' && call.callId), 'platform calls stay bound to the employee call');
  } finally { await a.stop(); await b.stop(); await rm(dir, { recursive: true, force: true }); }
});
