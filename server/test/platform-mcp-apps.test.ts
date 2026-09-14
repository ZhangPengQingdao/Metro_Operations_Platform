import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { createCoreMcpHandler, createCoreModernMcpClient, type ServerContext } from '../src/core/integrations/mcp/index.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';
import {
  PLATFORM_MCP_CONTRACT_VERSION, PLATFORM_MCP_LIMITS, PLATFORM_MCP_UI_MIME_TYPE,
  PLATFORM_MCP_TOOL_CATALOG, PlatformMcpToolError, assertPlatformMcpToolContribution,
  assertPlatformMcpToolResult, createPlatformMcpRegistrations, toPlatformMcpProtocolTool,
  validatePlatformMcpArguments, type PlatformMcpObjectSchema, type PlatformMcpToolContribution, type PlatformMcpToolResult
} from '../src/platform/mcp/index.ts';

const uri = 'ui://app/conformance.demo/view/1.html';
const html = '<!doctype html><html><body><p>Conformance fixture</p></body></html>';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const complete = (message = 'Fixture result'): PlatformMcpToolResult => ({ resultType: 'complete', content: [{ type: 'text', text: message }], structuredContent: { message } });
function fixture(): PlatformMcpToolContribution {
  return {
    id: 'app:conformance.demo', contractVersion: PLATFORM_MCP_CONTRACT_VERSION,
    tools: [{
      ...structuredClone(PLATFORM_MCP_TOOL_CATALOG[0]), name: 'fixture_echo',
      owner: { type: 'application', id: 'conformance.demo' }, description: 'Conformance echo', title: 'Echo',
      inputSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 100 } }, required: ['message'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 100 } }, required: ['message'], additionalProperties: false },
      execution: { taskSupport: 'forbidden' },
      icons: [{ src: 'https://static.example/icon.png', mimeType: 'image/png' }],
      _meta: { ui: { resourceUri: uri, visibility: ['model', 'app'] } }
    }],
    resources: [{ owner: { type: 'application', id: 'conformance.demo' }, uri, name: 'view', mimeType: PLATFORM_MCP_UI_MIME_TYPE, html, sha256: hash(html), _meta: { ui: { csp: { connectDomains: ['https://api.example'], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, permissions: { clipboardWrite: {} }, domain: 'https://sandbox.example', prefersBorder: true } } }],
    async callTool(_context, _name, args) { return complete((args as { message: string }).message); }
  };
}
const invalidContribution = (error: unknown) => error instanceof PlatformMcpToolError && error.code === 'INVALID_CONTRIBUTION';
const invalidResult = (error: unknown) => error instanceof PlatformMcpToolError && error.code === 'INVALID_RESULT';
function actor(allowed = true): PlatformActorContext {
  return {
    actorType: 'service', trustedIdentity: { source: 'service' },
    execution: { type: 'service', appId: 'conformance.demo', serviceIdentityId: 'service-fixture' },
    request: { requestId: 'fixture', traceId: 'fixture', startedAt: '2026-09-04T00:00:00.000Z' },
    authorize: async (permissionCode) => ({ id: 'decision', allowed, reasonCode: allowed ? 'allowed' : 'permission_not_granted', permissionCode, subjectType: 'service', effectiveScopes: [], decidedAt: '2026-09-04T00:00:00.000Z' })
  };
}

test('standard descriptor/result contracts preserve optional UI and isolate platform policies', () => {
  const contribution = fixture();
  assert.doesNotThrow(() => assertPlatformMcpToolContribution(contribution));
  const tool = toPlatformMcpProtocolTool(contribution.tools[0]);
  assert.equal(tool.title, 'Echo');
  assert.deepEqual(tool._meta, { ui: { resourceUri: uri, visibility: ['model', 'app'] } });
  assert.ok(tool.outputSchema);
  assert.doesNotMatch(JSON.stringify(tool), /contractVersion|permissionPolicy|resultPolicy|retryPolicy|"owner"/);
  const plain = fixture();
  plain.tools = [{ ...plain.tools[0], _meta: undefined }];
  delete plain.tools[0]._meta;
  plain.resources = [];
  assert.doesNotThrow(() => assertPlatformMcpToolContribution(plain));
  plain.tools[0]._meta = { ui: { visibility: ['app'] } };
  assert.doesNotThrow(() => assertPlatformMcpToolContribution(plain));
  assert.doesNotThrow(() => assertPlatformMcpToolResult(complete()));
  assert.equal(PLATFORM_MCP_TOOL_CATALOG.every((entry) => !entry._meta), true);
});

test('UI resource ownership, canonical versions, linkage, MIME, HTML and hash fail closed', () => {
  const mutations: Array<(value: PlatformMcpToolContribution) => void> = [
    (v) => { v.contractVersion = '1.0' as never; },
    (v) => { v.resources = []; },
    (v) => { v.tools[0]._meta!.ui.resourceUri = ''; },
    (v) => { v.resources = [v.resources![0], v.resources![0]]; },
    (v) => { v.resources![0].owner.id = 'another-app'; },
    (v) => { v.resources![0].uri = 'ui://app/conformance.demo/view.html'; },
    (v) => { v.resources![0].uri = 'ui://app/conformance.demo/view/0.html'; },
    (v) => { v.resources![0].uri += '?token=secret'; },
    (v) => { v.resources![0].mimeType = 'text/html' as never; },
    (v) => { v.resources![0].sha256 = '0'.repeat(64); },
    (v) => { v.resources![0].html = '<p>fragment</p>'; v.resources![0].sha256 = hash(v.resources![0].html); },
    (v) => { v.resources![0].html = 'x'.repeat(PLATFORM_MCP_LIMITS.htmlBytes + 1); },
    (v) => { v.tools[0]._meta!.ui.visibility = [] as never; },
    (v) => { v.tools[0]._meta!.ui.visibility = ['all'] as never; },
    (v) => { v.tools[0]._meta!.ui.visibility = ['app', 'app']; },
    (v) => { v.resources![0]._meta!.ui.permissions = { camera: { granted: true } } as never; },
    (v) => { v.resources![0]._meta!.ui.permissions = { fullscreen: {} } as never; },
    (v) => { v.resources![0]._meta!.ui.prefersBorder = 'yes' as never; }
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => assertPlatformMcpToolContribution(value), invalidContribution); }
  for (const domain of ['http://example.com', 'https://*.example.com', 'https://user:pass@example.com', 'https://example.com/', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com#f', 'data:', 'https://EXAMPLE.com']) {
    const value = fixture(); value.resources![0]._meta!.ui.csp!.connectDomains = [domain];
    assert.throws(() => assertPlatformMcpToolContribution(value), invalidContribution, domain);
  }
});

test('schema and metadata declarations reject unsafe keywords, secrets, cycles and unsupported Tasks', () => {
  const mutations: Array<(v: PlatformMcpToolContribution) => void> = [
    (v) => { v.tools[0].inputSchema = { ...v.tools[0].inputSchema, $ref: 'https://external.invalid/schema' } as never; },
    (v) => { v.tools[0].inputSchema.properties = { value: { type: 'string', pattern: '^(a+)+$' } }; },
    (v) => { v.tools[0].inputSchema.properties = { actor_name: { type: 'string', maxLength: 100 } }; },
    (v) => { v.tools[0].inputSchema.properties = { query: { type: 'string', maxLength: 10, minLength: 11 } }; },
    (v) => { v.tools[0].inputSchema.properties = { cycle: v.tools[0].inputSchema }; },
    (v) => { v.tools[0].description = 'Authorization: Bearer secret-value'; },
    (v) => { v.tools[0].execution = { taskSupport: 'required' }; },
    (v) => { v.tools[0].icons = [{ src: 'not-a-url' }]; },
    (v) => { v.tools[0].icons = [{ src: 'https://user:password@example.com/icon.png' }]; }
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => assertPlatformMcpToolContribution(value), invalidContribution); }
});

test('every linked tool must own its resource even when another tool owns the same contribution resource', () => {
  const value = fixture();
  value.tools = [...value.tools, { ...structuredClone(value.tools[0]), name: 'another_echo', owner: { type: 'application', id: 'another.app' } }];
  assert.throws(() => assertPlatformMcpToolContribution(value), invalidContribution);
});

test('schema validation counts Unicode codepoints, own required fields and order-independent unique objects', async () => {
  const stringSchema: PlatformMcpObjectSchema = { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 1 } }, required: ['message'], additionalProperties: false };
  assert.doesNotThrow(() => validatePlatformMcpArguments({ message: '😀' }, stringSchema));
  assert.throws(() => validatePlatformMcpArguments({ message: '😀' }, { ...stringSchema, properties: { message: { type: 'string', minLength: 2, maxLength: 3 } } }));
  assert.throws(() => validatePlatformMcpArguments({}, { ...stringSchema, properties: { toString: { type: 'string' as const, maxLength: 10 } }, required: ['toString'] }));
  const itemSchema: PlatformMcpObjectSchema = { type: 'object', properties: { a: { type: 'boolean' }, b: { type: 'boolean' } }, additionalProperties: false };
  const arraySchema: PlatformMcpObjectSchema = { type: 'object', properties: { entries: { type: 'array', items: itemSchema, uniqueItems: true, maxItems: 3 } }, additionalProperties: false };
  assert.throws(() => validatePlatformMcpArguments({ entries: [{ a: true, b: false }, { b: false, a: true }] }, arraySchema));
  assert.doesNotThrow(() => validatePlatformMcpArguments({ entries: [{ a: true, b: false }, { b: true, a: true }] }, arraySchema));
  const cases: Array<[PlatformMcpObjectSchema, unknown, boolean]> = [
    [stringSchema, { message: '😀' }, true],
    [{ ...stringSchema, properties: { message: { type: 'string', minLength: 2, maxLength: 3 } } }, { message: '😀' }, false],
    [arraySchema, { entries: [{ a: true, b: false }, { b: false, a: true }] }, false],
    [arraySchema, { entries: [{ a: true, b: false }, { b: true, a: true }] }, true]
  ];
  for (const [schema, data, valid] of cases) {
    const protocolSchema = toPlatformMcpProtocolTool({ ...fixture().tools[0], inputSchema: schema }).inputSchema;
    const checked = await fromJsonSchema(protocolSchema)['~standard'].validate(data);
    assert.equal(!checked.issues, valid, 'Local subset and official SDK must agree');
  }
});

test('complete results require bounded text fallback and reject private envelopes or dynamic UI', () => {
  const bad: unknown[] = [
    { contractVersion: '1.0', tool: 'fixture_echo', data: {} },
    { ...complete(), resultType: 'input_required' },
    { ...complete(), content: [] },
    { ...complete(), content: [{ type: 'text', text: '   ' }] },
    { ...complete(), structuredContent: { password: 'secret' } },
    { ...complete(), structuredContent: { actor_name: 'forged' } },
    { ...complete(), structuredContent: { trustedIdentity: { name: 'forged' } } },
    { ...complete(), structuredContent: { link: 'https://user:pw@example.com/private' } },
    { ...complete(), structuredContent: { link: 'HTTPS://user:pw@example.com/private' } },
    { ...complete(), structuredContent: { link: 'https://example.com/file?%74oken=hidden' } },
    { ...complete(), _meta: { ui: { resourceUri: 'ui://unregistered' } } },
    { ...complete(), content: [...complete().content, { type: 'resource', resource: { uri: 'ui://unregistered', mimeType: PLATFORM_MCP_UI_MIME_TYPE, text: html } }] },
    { ...complete(), content: [...complete().content, { type: 'resource_link', uri: 'UI://unregistered', name: 'card' }] },
    { ...complete(), content: [...complete().content, { type: 'resource_link', uri: 'https://example.com/card', name: 'card', mimeType: 'text/html' }] },
    { ...complete(), structuredContent: { message: 'x'.repeat(PLATFORM_MCP_LIMITS.resultBytes) } },
    { ...complete(), content: [{ type: 'text', text: 'Bearer supersecret' }] }
  ];
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; bad.push({ ...complete(), structuredContent: cyclic });
  for (const value of bad) assert.throws(() => assertPlatformMcpToolResult(value), invalidResult);
  assert.doesNotThrow(() => assertPlatformMcpToolResult({ ...complete('Operation failed safely'), isError: true, _meta: { 'example.com/revision': '1' } }));
});

test('aggregate result bytes are rejected during traversal before serializing the whole result', () => {
  const text = 'x'.repeat(PLATFORM_MCP_LIMITS.resultBytes / 2);
  assert.throws(() => assertPlatformMcpToolResult({ ...complete(), structuredContent: { one: text, two: text } }),
    (error: unknown) => invalidResult(error) && (error as PlatformMcpToolError).path === '$.structuredContent.two');
  assert.throws(() => assertPlatformMcpToolResult({ ...complete(), structuredContent: { sparse: new Array(PLATFORM_MCP_LIMITS.nodes + 1) } }), invalidResult);
  const maskedHole: unknown[] = new Array(1);
  Object.assign(maskedHole, { 4294967295: 'Not an array index' });
  assert.throws(() => assertPlatformMcpToolResult({ ...complete(), structuredContent: { maskedHole } }), invalidResult);
});

test('trusted composition enforces proof and gateway per request, schema, snapshots and output', async () => {
  const value = fixture(); let calls = 0; let resolutions = 0;
  value.callTool = async () => { calls++; return complete(); };
  const request = { http: { authInfo: { token: 'proof', clientId: 'fixture', scopes: [] } } } as ServerContext;
  const registrations = createPlatformMcpRegistrations(value, async (proof) => { assert.equal(proof.token, 'proof'); resolutions++; return actor(); });
  value.tools[0].name = 'mutated'; value.resources![0].html = 'mutated';
  assert.equal(registrations.tools[0].definition.name, 'fixture_echo');
  const firstResource = (await registrations.resources[0].read(new URL(uri), request)).contents[0];
  assert.ok('text' in firstResource);
  assert.equal(firstResource.text, html);
  firstResource._meta!.ui = { csp: { connectDomains: ['https://mutated.example'] } };
  registrations.resources[0].definition._meta!.ui = { prefersBorder: false };
  const secondResource = (await registrations.resources[0].read(new URL(uri), request)).contents[0];
  assert.deepEqual(secondResource._meta, fixture().resources![0]._meta);
  await registrations.tools[0].call({ message: 'one' }, request);
  await registrations.tools[0].call({ message: 'two' }, request);
  assert.equal(calls, 2); assert.equal(resolutions, 4);
  await assert.rejects(registrations.tools[0].call({ message: 'one' }, {} as ServerContext), (e: unknown) => e instanceof PlatformMcpToolError && e.code === 'MCP_USE_DENIED');
  await assert.rejects(registrations.tools[0].call({ message: 'one', actor_name: 'forged' }, request));
  assert.equal(calls, 2);
  const denied = createPlatformMcpRegistrations(fixture(), async () => actor(false));
  await assert.rejects(denied.tools[0].call({ message: 'one' }, request), (e: unknown) => e instanceof PlatformMcpToolError && e.code === 'MCP_USE_DENIED');
  await assert.rejects(denied.resources[0].read(new URL(uri), request));
  const wrong = fixture(); wrong.callTool = async () => ({ ...complete(), structuredContent: { unexpected: true } });
  await assert.rejects(createPlatformMcpRegistrations(wrong, async () => actor()).tools[0].call({ message: 'one' }, request), invalidResult);
});

test('official modern client round trips L3 descriptors, resource security declarations and results', async () => {
  const registrations = createPlatformMcpRegistrations(fixture(), async (proof) => { assert.equal(proof.clientId, 'trusted'); return actor(); });
  const handler = createCoreMcpHandler({ ...registrations, serverInfo: { name: 'l3-fixture', version: '1' }, allowedHosts: ['mcp.test'], allowedOrigins: ['mcp.test'], authenticate: async (request) => request.headers.get('authorization') === 'Bearer fixture-proof' ? { token: 'fixture-proof', clientId: 'trusted', scopes: [] } : null });
  const client = createCoreModernMcpClient({ endpoint: 'https://mcp.test/mcp', clientInfo: { name: 'fixture', version: '1' }, allowedToolNames: new Set(['fixture_echo']), token: async () => 'fixture-proof', fetchImpl: async (url, init) => { const request = new Request(url, init); request.headers.set('host', 'mcp.test'); return handler.fetch(request); } });
  try {
    await client.connect();
    const listed = await client.listTools();
    assert.deepEqual(listed.tools[0]._meta, { ui: { resourceUri: uri, visibility: ['model', 'app'] } });
    const result = await client.callTool('fixture_echo', { message: 'Standard text fallback' });
    assert.deepEqual(result.structuredContent, { message: 'Standard text fallback' });
    const resource = await client.readResource(uri);
    assert.ok('text' in resource.contents[0]);
    assert.equal(resource.contents[0].text, html);
    assert.deepEqual(resource.contents[0]._meta, fixture().resources![0]._meta);
  } finally { await client.close(); await handler.close(); }
});
