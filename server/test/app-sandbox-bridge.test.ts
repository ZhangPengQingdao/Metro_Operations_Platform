import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandboxSession, SandboxBridgeBroker, type SandboxBridgeOperation, type SandboxBridgeResponse, type SandboxJson } from '../../src/app-platform/host/sandbox/bridge.ts';

const session = 'a'.repeat(32);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(operation: Partial<SandboxBridgeOperation> = {}) {
  const source = {};
  const responses: SandboxBridgeResponse[] = [];
  let executions = 0;
  const broker = new SandboxBridgeBroker({ appId: 'sample-app', session, source, send: (r) => { responses.push(r); }, operations: new Map([
    ['demo.read', { validate: () => true, authorize: async () => true, execute: async (params) => { executions++; return params; }, ...operation }],
  ]) });
  const request = (id = 1, params: unknown = null) => ({ version: '1.0', type: 'request', appId: 'sample-app', session, id, method: 'demo.read', params });
  const receive = (data: unknown) => broker.receive({ source, origin: 'null', data });
  return { broker, source, responses, request, receive, executions: () => executions };
}

test('sandbox bridge snapshots JSON and authorizes each request before and after execution', async () => {
  let authorizations = 0;
  const f = fixture({ authorize: async () => { authorizations++; return true; }, execute: async (params) => {
    assert.ok(Object.isFrozen(params)); assert.ok(Object.isFrozen((params as { nested: SandboxJson }).nested)); return params;
  } });
  await f.receive(f.request(1, { nested: ['one', 1, true, null] }));
  await f.receive(f.request(2, { nested: [] }));
  assert.equal(authorizations, 4); assert.equal(f.responses.length, 2);
  assert.equal(f.responses[0].ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.responses[0])), { version: '1.0', type: 'response', appId: 'sample-app', session, id: 1, ok: true, result: { nested: ['one', 1, true, null] } });
});

test('sandbox bridge rejects foreign sources origins apps sessions protocols and replay without handlers', async () => {
  const f = fixture();
  for (const event of [
    { source: {}, origin: 'null', data: f.request() }, { source: f.source, origin: 'https://platform.example', data: f.request() },
    ...[{ appId: 'other' }, { session: 'b'.repeat(32) }, { version: '2.0' }, { type: 'response' }, { id: 0 }, { id: 1.5 }, { id: 2147483648 }]
      .map((override) => ({ source: f.source, origin: 'null', data: { ...f.request(), ...override } })),
  ]) await f.broker.receive(event);
  assert.equal(f.executions(), 0); assert.equal(f.responses.length, 0);
  await f.receive(f.request(3)); await f.receive(f.request(3)); await f.receive(f.request(2));
  assert.equal(f.executions(), 1); assert.equal(f.responses.length, 1);
});

test('sandbox bridge allows only registered methods and fresh scope authorization', async () => {
  let allowed = false;
  const f = fixture({ authorize: async (params) => allowed && (params as { scope?: string }).scope === 'allowed' });
  await f.receive({ ...f.request(), method: 'fetch' });
  await f.receive(f.request(2, { scope: 'allowed', capabilities: ['admin'] }));
  allowed = true;
  await f.receive(f.request(3, { scope: 'other' }));
  await f.receive(f.request(4, { scope: 'allowed' }));
  assert.deepEqual(f.responses.map((r) => r.ok === false ? r.error : 'OK'), ['UNKNOWN_METHOD', 'DENIED', 'DENIED', 'OK']);
  assert.equal(f.executions(), 1);
});

test('sandbox operation validation rejects app-supplied actor or scope and uses platform-owned grants', async () => {
  let platformGrant = false;
  const f = fixture({
    validate: (params) => typeof params === 'object' && params !== null && !Array.isArray(params)
      && Object.keys(params).length === 1 && typeof (params as { query?: SandboxJson }).query === 'string',
    authorize: async () => platformGrant,
  });
  await f.receive(f.request(1, { query: 'station', actor: 'admin', scope: '*', capabilities: ['*'] }));
  await f.receive(f.request(2, { query: 'station' }));
  platformGrant = true;
  await f.receive(f.request(3, { query: 'station' }));
  assert.deepEqual(f.responses.map((r) => r.ok === false ? r.error : 'OK'), ['INVALID_REQUEST', 'DENIED', 'OK']);
  assert.equal(f.executions(), 1);
});

test('sandbox bridge rejects malformed JSON, cycles, accessors, exotic prototypes and bounded payloads', async () => {
  const f = fixture(); let getterCalls = 0;
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterCalls++; return 'secret'; } });
  let deep: unknown = null; for (let i = 0; i < 18; i++) deep = [deep];
  const sparse = new Array(3);
  const hidden = Object.defineProperty({}, 'hidden', { value: true });
  const symbol = { [Symbol('key')]: true };
  for (const [index, params] of [cycle, accessor, new Date(), new Map(), NaN, Infinity, BigInt(1), undefined, () => {}, deep, sparse, hidden, symbol, 'x'.repeat(65536), '中'.repeat(24000)].entries()) {
    await f.receive({ ...f.request(index + 1), params });
  }
  await f.receive({ ...f.request(100), unexpected: true });
  assert.equal(getterCalls, 0); assert.equal(f.executions(), 0);
  assert.ok(f.responses.every((response) => response.ok === false && response.error === 'INVALID_REQUEST'));
  assert.equal(f.responses.length, 16);
});

test('sandbox bridge freezes input before awaits and suppresses stale privilege results', async () => {
  const gate = deferred<boolean>(); let allowed = true; let seen: SandboxJson | undefined;
  const f = fixture({ authorize: async () => allowed, execute: async (params) => { seen = params; await gate.promise; return { secret: 'must not leak' }; } });
  const input = { scope: 'one' }; const pending = f.receive(f.request(1, input));
  input.scope = 'changed'; await Promise.resolve(); allowed = false; gate.resolve(true); await pending;
  assert.equal((seen as { scope: string }).scope, 'one');
  assert.deepEqual(f.responses.map((r) => r.ok === false ? r.error : 'leaked'), ['DENIED']);
});

test('sandbox bridge caps concurrency and lifetime request count', async () => {
  const gate = deferred<boolean>();
  const f = fixture({ authorize: async () => gate.promise });
  const pending = Array.from({ length: 8 }, (_, i) => f.receive(f.request(i + 1)));
  await f.receive(f.request(9)); assert.equal(f.responses[0].ok, false);
  if (f.responses[0].ok === false) assert.equal(f.responses[0].error, 'LIMIT_EXCEEDED');
  gate.resolve(true); await Promise.all(pending);
  for (let id = 10; id <= 130; id++) await f.receive(f.request(id));
  assert.equal(f.responses.length, 128); assert.equal(f.executions(), 127);
});

test('sandbox bridge close aborts in-flight handlers and suppresses late results and reentrant calls', async () => {
  const gate = deferred<boolean>(); let aborted = false;
  const f = fixture({ execute: async (_params, signal) => {
    signal.addEventListener('abort', () => { aborted = true; void f.receive(f.request(2)); f.broker.close(); });
    await gate.promise; return 'late';
  } });
  const pending = f.receive(f.request()); await Promise.resolve(); f.broker.close(); gate.resolve(true); await pending;
  assert.equal(aborted, true); assert.deepEqual(f.responses, []);
});

test('sandbox bridge handles close inside validation/authorization and safe handler failures', async () => {
  const f = fixture({ validate: () => { f.broker.close(); return true; } });
  await f.receive(f.request()); assert.equal(f.executions(), 0); assert.deepEqual(f.responses, []);
  const g = fixture({ authorize: async () => { g.broker.close(); return true; } });
  await g.receive(g.request()); assert.equal(g.executions(), 0); assert.deepEqual(g.responses, []);
  for (const operation of [
    { validate: () => { throw new Error('private credential'); } },
    { authorize: async () => { throw new Error('private credential'); } },
    { execute: async () => { throw new Error('private credential'); } },
    { execute: async () => 'x'.repeat(65536) },
  ]) {
    const h = fixture(operation); await h.receive(h.request());
    assert.equal(h.responses.length, 1); assert.equal(h.responses[0].ok, false);
    assert.equal(JSON.stringify(h.responses).includes('private'), false);
  }
});

test('sandbox bridge captures registry and binding and fails closed on transport errors', async () => {
  const source = {}; const responses: SandboxBridgeResponse[] = [];
  const operation: SandboxBridgeOperation = { validate: () => true, authorize: async () => true, execute: async () => 'original' };
  const operations = new Map([['read', operation]]);
  const options = { appId: 'sample-app', session, source, operations, send: (r: SandboxBridgeResponse) => { responses.push(r); throw new Error('transport'); } };
  const broker = new SandboxBridgeBroker(options);
  operation.execute = async () => 'mutated'; operations.clear(); options.session = 'b'.repeat(32);
  const data = { version: '1.0', type: 'request', appId: 'sample-app', session, id: 1, method: 'read', params: null };
  await broker.receive({ source, origin: 'null', data });
  await broker.receive({ source, origin: 'null', data: { ...data, id: 2 } });
  assert.equal(responses.length, 1); assert.ok(responses[0].ok); if (responses[0].ok) assert.equal(responses[0].result, 'original');
});

test('sandbox session identifiers use cryptographic 128-bit nonces and invalid bindings fail', () => {
  const a = createSandboxSession(); const b = createSandboxSession(); assert.match(a, /^[a-f0-9]{32}$/); assert.notEqual(a, b);
  assert.throws(() => new SandboxBridgeBroker({ appId: 'bad/app', session, source: {}, send: () => {}, operations: new Map() }));
});
