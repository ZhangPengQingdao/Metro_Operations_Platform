import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MCP_PROTOCOL_VERSION, createCoreMcpHandler, createCoreMcpFastifyHost,
  createCoreModernMcpClient, type CoreMcpHandlerOptions, type ServerContext
} from '../src/core/integrations/mcp/index.ts';

const prefix = 'io.modelcontextprotocol/';
const ui = { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } };
function fixture() {
  const contexts: ServerContext[] = [];
  const options: CoreMcpHandlerOptions = {
    serverInfo: { name: 'conformance', version: '1.0.0' },
    allowedHosts: ['mcp.test', 'localhost', '127.0.0.1'],
    allowedOrigins: ['mcp.test', 'localhost', '127.0.0.1'],
    authenticate: async (request) => request.headers.get('authorization') === 'Bearer fixture-token'
      ? { token: 'fixture-token', clientId: 'trusted-client', scopes: ['fixture'] } : null,
    extensions: ui,
    tools: [{
      definition: {
        name: 'z_echo', description: 'Conformance echo',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
      },
      async call(args, context) {
        contexts.push(context);
        return { content: [{ type: 'text', text: 'echo' }], structuredContent: args };
      }
    }, {
      definition: { name: 'a_content', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      async call() { return { content: [
        { type: 'image', mimeType: 'image/png', data: 'AA==' },
        { type: 'audio', mimeType: 'audio/wav', data: 'AA==' },
        { type: 'resource_link', uri: 'ui://conformance/view', name: 'view' },
        { type: 'resource', resource: { uri: 'text://conformance/message', text: 'fixture' } }
      ] }; }
    }],
    resources: [{
      definition: { uri: 'ui://conformance/view', name: 'view', mimeType: 'text/html;profile=mcp-app' },
      async read(uri, context) {
        contexts.push(context);
        return { contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><title>Fixture</title>' }] };
      }
    }]
  };
  return { options, contexts };
}

function request(method: string, params: Record<string, unknown> = {}, version = MCP_PROTOCOL_VERSION) {
  const body = { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
    [`${prefix}protocolVersion`]: version,
    [`${prefix}clientInfo`]: { name: 'fixture', version: '1.0.0' },
    [`${prefix}clientCapabilities`]: { extensions: ui }
  } } };
  const headers = new Headers({ host: 'mcp.test', authorization: 'Bearer fixture-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version, 'Mcp-Method': method });
  const name = method === 'resources/read' ? params.uri : params.name;
  if (typeof name === 'string') headers.set('Mcp-Name', name);
  return new Request('https://mcp.test/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

test('modern discovery is stateless, version-pinned, private-cacheable and extension-aware', async () => {
  const handler = createCoreMcpHandler(fixture().options);
  try {
    const response = await handler.fetch(request('server/discover'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.has('Mcp-Session-Id'), false);
    const payload = await response.json();
    assert.deepEqual(payload.result.supportedVersions, ['2026-07-28']);
    assert.equal(payload.result.resultType, 'complete');
    assert.equal(payload.result._meta[`${prefix}serverInfo`].name, 'conformance');
    assert.deepEqual(payload.result.capabilities.extensions, ui);
    assert.equal(payload.result.ttlMs, 0);
    assert.equal(payload.result.cacheScope, 'private');
    assert.equal(payload.result.capabilities.tasks, undefined);
    assert.equal(payload.result.capabilities.tools.listChanged, false);
    assert.equal(payload.result.capabilities.resources.subscribe, false);
  } finally { await handler.close(); }
});

test('modern handler rejects legacy, unsupported versions, inconsistent headers and unauthorized origins', async () => {
  const handler = createCoreMcpHandler(fixture().options);
  try {
    const unsupported = await handler.fetch(request('server/discover', {}, '1900-01-01'));
    assert.equal((await unsupported.json()).error.code, -32022);
    const legacy = new Request('https://mcp.test/mcp', { method: 'POST', headers: { host: 'mcp.test', authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'old', version: '1' } } }) });
    assert.equal((await (await handler.fetch(legacy)).json()).error.code, -32022);
    const mismatch = request('tools/list'); mismatch.headers.set('Mcp-Method', 'tools/call');
    assert.equal((await (await handler.fetch(mismatch)).json()).error.code, -32020);
    const missingVersion = new Request('https://mcp.test/mcp', { method: 'POST', headers: { host: 'mcp.test', authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    assert.notEqual((await handler.fetch(missingVersion)).status, 200);
    const unauthorized = request('server/discover'); unauthorized.headers.delete('authorization');
    assert.equal((await handler.fetch(unauthorized)).status, 401);
    const hostileOrigin = request('server/discover'); hostileOrigin.headers.set('origin', 'https://evil.test');
    assert.equal((await handler.fetch(hostileOrigin)).status, 403);
    const hostileHost = request('server/discover'); hostileHost.headers.set('host', 'evil.test');
    assert.equal((await handler.fetch(hostileHost)).status, 403);
  } finally { await handler.close(); }
});

test('an empty modern composition advertises no unimplemented tool or resource methods', async () => {
  const handler = createCoreMcpHandler({ ...fixture().options, tools: [], resources: [], extensions: {} });
  try {
    const payload = await (await handler.fetch(request('server/discover'))).json();
    assert.equal(payload.result.capabilities.tools, undefined);
    assert.equal(payload.result.capabilities.resources, undefined);
  } finally { await handler.close(); }
});

test('official pinned client exchanges typed tools and resources without a legacy handshake', async () => {
  const { options, contexts } = fixture();
  const handler = createCoreMcpHandler(options);
  const messages: Array<{ method: string; params: Record<string, unknown>; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const req = new Request(url, init);
    req.headers.set('host', new URL(req.url).host);
    const body = await req.clone().json();
    messages.push({ ...body, headers: req.headers });
    return handler.fetch(req);
  };
  const client = createCoreModernMcpClient({ endpoint: 'https://mcp.test/mcp', clientInfo: { name: 'client-fixture', version: '1.0.0' }, capabilities: { extensions: ui }, allowedToolNames: new Set(['z_echo','a_content']), token: async () => 'fixture-token', fetchImpl });
  try {
    await client.connect();
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getServerInfo()?.name, 'conformance');
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['a_content','z_echo']);
    const echo = await client.callTool('z_echo', { message: 'hello', actor_name: 'forged' });
    assert.deepEqual(echo.structuredContent, { message: 'hello' });
    assert.deepEqual((await client.callTool('a_content', {})).content.map((item) => item.type), ['image','audio','resource_link','resource']);
    assert.equal((await client.listResources()).resources[0].uri, 'ui://conformance/view');
    assert.equal((await client.readResource('ui://conformance/view')).contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.throws(() => client.callTool('denied', {}), /not allowed/);
    assert.equal(contexts.every((ctx) => ctx.http?.authInfo?.clientId === 'trusted-client'), true);
    assert.deepEqual(Reflect.get(contexts[0].mcpReq.envelope ?? {}, `${prefix}clientCapabilities`), { extensions: ui });
    assert.equal(messages[0].method, 'server/discover');
    assert.equal(messages.some((message) => ['initialize','notifications/initialized','ping'].includes(message.method)), false);
    assert.equal(messages.every((message) => !message.headers.has('Mcp-Session-Id')), true);
    assert.equal(messages.every((message) => message.headers.get('Mcp-Method') === message.method), true);
  } finally { await client.close(); await handler.close(); }
});

test('pinned modern client never falls back when a legacy-only peer rejects discovery', async () => {
  const methods: string[] = [];
  const client = createCoreModernMcpClient({ endpoint: 'https://mcp.test/mcp', clientInfo: { name: 'pinned', version: '1' }, allowedToolNames: new Set(), token: async () => 'fixture-token', fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); methods.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown method' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(client.connect());
  assert.deepEqual(methods, ['server/discover']);
});

test('each request proves its own identity and invalid arguments never execute', async () => {
  const { options, contexts } = fixture();
  let authentications = 0;
  const handler = createCoreMcpHandler({ ...options, authenticate: async (req) => {
    authentications++;
    const token = req.headers.get('authorization');
    return token ? { token, clientId: token, scopes: [] } : null;
  } });
  try {
    for (const principal of ['one', 'two']) {
      const req = request('tools/call', { name: 'z_echo', arguments: { message: principal } });
      req.headers.set('authorization', principal);
      assert.equal((await (await handler.fetch(req)).json()).result.isError, undefined);
    }
    assert.deepEqual(contexts.map((ctx) => ctx.http?.authInfo?.clientId), ['one', 'two']);
    const revoked = request('tools/list'); revoked.headers.delete('authorization');
    assert.equal((await handler.fetch(revoked)).status, 401);
    const invalid = await handler.fetch(request('tools/call', { name: 'z_echo', arguments: { message: 12 } }));
    assert.equal((await invalid.json()).result.isError, true);
    assert.equal(contexts.length, 2);
    assert.equal(authentications, 4);
    const missing = await handler.fetch(request('resources/read', { uri: 'file:///etc/passwd' }));
    assert.ok((await missing.json()).error);
    assert.equal(contexts.length, 2);
  } finally { await handler.close(); }
});

test('provider failures are safe on the wire, observable internally, and invalid output is rejected', async () => {
  const { options } = fixture();
  const errors: Error[] = [];
  const failure = new Error('private-provider-detail');
  const handler = createCoreMcpHandler({ ...options, onerror: (error) => errors.push(error), tools: [
    { ...options.tools![0], call: async () => { throw failure; } },
    { definition: { ...options.tools![0].definition, name: 'invalid_output' }, call: async () => ({ content: [], structuredContent: { message: 1 } }) }
  ], resources: [{ ...options.resources![0], read: async () => { throw failure; } }] });
  try {
    const tool = await (await handler.fetch(request('tools/call', { name: 'z_echo', arguments: { message: 'hello' } }))).json();
    assert.equal(tool.result.isError, true);
    assert.doesNotMatch(JSON.stringify(tool), /private-provider-detail/);
    const resource = await (await handler.fetch(request('resources/read', { uri: 'ui://conformance/view' }))).json();
    assert.equal(resource.error.code, -32603);
    assert.doesNotMatch(JSON.stringify(resource), /private-provider-detail/);
    assert.deepEqual(errors, [failure, failure]);
    const invalid = await (await handler.fetch(request('tools/call', { name: 'invalid_output', arguments: { message: 'ok' } }))).json();
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.result.structuredContent, undefined);
  } finally { await handler.close(); }
  const authHandler = createCoreMcpHandler({ ...options, onerror: (error) => errors.push(error), authenticate: async () => { throw failure; } });
  try {
    const response = await authHandler.fetch(request('tools/list'));
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private-provider-detail/);
    assert.equal(errors.at(-1), failure);
  } finally { await authHandler.close(); }
  const observerFailureHandler = createCoreMcpHandler({ ...options, tools: [{ ...options.tools![0], call: async () => { throw failure; } }], onerror: () => { throw new Error('private-observer-detail'); } });
  try {
    const response = await (await observerFailureHandler.fetch(request('tools/call', { name: 'z_echo', arguments: { message: 'ok' } }))).json();
    assert.equal(response.result.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /private-(?:provider|observer)-detail/);
  } finally { await observerFailureHandler.close(); }
});

test('Fastify adapter serves the unmounted modern endpoint and closes cleanly', async () => {
  const app = createCoreMcpFastifyHost(fixture().options);
  try {
    const req = request('server/discover');
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: Object.fromEntries(req.headers), payload: await req.text() });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().result.supportedVersions, ['2026-07-28']);
  } finally { await app.close(); }
});

test('modern client bounds tool timeouts and never replays failed writes', async () => {
  for (const failure of ['timeout', 'network', 'unauthorized', 'forbidden', 'insufficient_scope']) {
    const handler = createCoreMcpHandler(fixture().options);
    let calls = 0;
    const client = createCoreModernMcpClient({ endpoint: 'https://mcp.test/mcp', clientInfo: { name: 'failure-fixture', version: '1' }, allowedToolNames: new Set(['z_echo']), token: async () => 'fixture-token', timeoutMs: 1000, fetchImpl: async (url, init) => {
      const req = new Request(url, init); req.headers.set('host', new URL(req.url).host);
      const body = await req.clone().json();
      if (body.method !== 'tools/call') return handler.fetch(req);
      calls++;
      if (failure === 'network') throw new TypeError('Network unavailable');
      if (failure === 'unauthorized') return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      if (failure === 'forbidden') return new Response('Forbidden', { status: 403 });
      if (failure === 'insufficient_scope') return new Response('Forbidden', { status: 403, headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write"' } });
      return new Promise<Response>((_resolve, reject) => {
        if (req.signal.aborted) reject(req.signal.reason);
        else req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
      });
    } });
    try {
      await client.connect();
      await assert.rejects(client.callTool('z_echo', { message: 'write' }));
      assert.equal(calls, 1, `${failure} must not replay a tool call`);
    } finally { await client.close(); await handler.close(); }
  }
});

test('modern public entrypoint does not import or expose the isolated legacy transport', async () => {
  const source = await readFile(new URL('../src/core/integrations/mcp/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"].*legacy|CoreMcpHttpClient|sessionId|method: ['"]initialize/);
  assert.match(source, /legacy: 'reject'/);
  assert.match(source, /mode: \{ pin: MCP_PROTOCOL_VERSION \}/);
  assert.doesNotMatch(source, /from ['"].*(?:platform\/|modules\/|apps\/)/);
  assert.throws(() => createCoreMcpHandler({ ...fixture().options, allowedHosts: [] }), /allowlists/);
  assert.throws(() => createCoreMcpHandler({ ...fixture().options, tools: [fixture().options.tools![0], fixture().options.tools![0]] }), /unique/);
});
