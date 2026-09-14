import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AiProviderTransportError,
  assertSafeAiProviderEndpoint,
  listExternalProviderModels,
  requestOpenAiMessage
} from '../src/core/integrations/ai/index.ts';
import {
  CoreMcpHttpClient,
  CoreMcpTransportError,
  LEGACY_MCP_WECOM_USER_ID_HEADER,
  sanitizeMcpToolSchema,
  toOpenAiTools,
  type CoreMcpToolPolicy,
  type McpToolDefinition
} from '../src/core/integrations/mcp/legacy.ts';

const TEST_TOOL_POLICY: CoreMcpToolPolicy = {
  allowedToolNames: new Set(['demo_report']),
  transformSchema(_tool, schema) {
    const properties = { ...(schema.properties as Record<string, unknown> | undefined) };
    delete properties.server_attachment_urls;
    return { ...schema, properties };
  }
};

test('Core MCP transport contains no application tool allowlist or field policy', async () => {
  const coreSource = await readFile(new URL('../src/core/integrations/mcp/index.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(coreSource, /afc_(?:get|list|create|report|update|complete|fix)_/);
  assert.doesNotMatch(coreSource, /hazard_photo_urls|现场照片/);
});

test('Core MCP sanitizes model-visible identity fields and applies an injected tool policy', () => {
  const tools: McpToolDefinition[] = [
    {
      name: 'demo_report',
      description: 'Create a demo report',
      inputSchema: {
        type: 'object',
        properties: {
          actor_token: { type: 'string' },
          actor_wecom_userid: { type: 'string' },
          actor_name: { type: 'string' },
          server_attachment_urls: { type: 'array' },
          description: { type: 'string' }
        },
        required: ['actor_token', 'description'],
        anyOf: [{ required: ['actor_token'] }, { required: ['actor_name'] }]
      }
    },
    {
      name: 'unsafe_admin_tool',
      inputSchema: { type: 'object', properties: {} }
    }
  ];

  assert.deepEqual(sanitizeMcpToolSchema(tools[0].inputSchema).required, ['description']);
  const openAiTools = toOpenAiTools(tools, TEST_TOOL_POLICY);
  assert.equal(openAiTools.length, 1);
  assert.equal(openAiTools[0].function.name, 'demo_report');
  assert.deepEqual(openAiTools[0].function.parameters.required, ['description']);
  assert.equal(
    (openAiTools[0].function.parameters.properties as Record<string, unknown>).server_attachment_urls,
    undefined
  );
});

test('Core MCP client initializes, injects trusted actor token, and rejects unallowed tools', async () => {
  const calls: Array<{ method?: string; headers: Headers; body?: unknown; signal?: AbortSignal }> = [];
  let step = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls.push({
      method: init?.method,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal as AbortSignal
    });
    step += 1;
    if (step === 1) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' }
      });
    }
    if (step === 2) return new Response(null, { status: 202 });
    if (step === 3) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'afc_create_todo', inputSchema: { type: 'object', properties: {} } }] }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (step === 4) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { structuredContent: { ok: true } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(null, { status: 204 });
  };
  const client = new CoreMcpHttpClient({
    endpoint: 'https://mcp.example.com/mcp',
    apiKey: 'mcp-secret',
    actorSigningSecret: 'test-mcp-signing-secret',
    actor: { name: '测试用户', wecomUserId: '5359' },
    toolPolicy: { allowedToolNames: new Set(['afc_create_todo']) },
    fetchImpl,
    timeoutMs: 3000
  });

  await client.initialize();
  assert.equal((await client.listTools()).length, 1);
  await client.callTool('afc_create_todo', { title: '测试待办', actor_name: '伪造身份' });
  await assert.rejects(
    client.callTool('unsafe_admin_tool', {}),
    (error) => {
      assert.ok(error instanceof CoreMcpTransportError);
      assert.equal(error.code, 'MCP_TOOL_NOT_ALLOWED');
      return true;
    }
  );
  await client.close();

  assert.equal(calls[0].headers.get(LEGACY_MCP_WECOM_USER_ID_HEADER), '5359');
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  const toolRequest = calls[3].body as {
    params: { arguments: Record<string, unknown> };
  };
  assert.equal(toolRequest.params.arguments.title, '测试待办');
  assert.equal(toolRequest.params.arguments.actor_name, undefined);
  const actorToken = String(toolRequest.params.arguments.actor_token);
  const actorPayload = JSON.parse(Buffer.from(actorToken.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(actorPayload.actor_wecom_userid, '5359');
  assert.equal(actorPayload.actor_name, undefined);
});

test('Core MCP client normalizes protocol timeouts', async () => {
  const client = new CoreMcpHttpClient({
    endpoint: 'https://mcp.example.com/mcp',
    apiKey: 'mcp-secret',
    actorSigningSecret: 'test-mcp-signing-secret',
    actor: { name: '测试用户', wecomUserId: '5359' },
    toolPolicy: { allowedToolNames: new Set() },
    fetchImpl: async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }
  });

  await assert.rejects(
    client.initialize(),
    (error) => {
      assert.ok(error instanceof CoreMcpTransportError);
      assert.equal(error.code, 'MCP_INITIALIZE_TIMEOUT');
      return true;
    }
  );
});

test('Core AI provider transport blocks private endpoints and supports verified Fake-IP DNS', async () => {
  assert.equal(
    (await assertSafeAiProviderEndpoint('https://api.example.com/v1/chat/completions', {
      lookupAddresses: async () => [{ address: '104.21.53.240', family: 4 }]
    })).hostname,
    'api.example.com'
  );
  await assert.rejects(
    assertSafeAiProviderEndpoint('https://private.example.com/v1/chat/completions', {
      lookupAddresses: async () => [{ address: '192.168.137.1', family: 4 }]
    }),
    /内网或保留地址/
  );
  assert.equal(
    (await assertSafeAiProviderEndpoint('https://fake.example.com/v1/chat/completions', {
      lookupAddresses: async () => [{ address: '198.18.0.29', family: 4 }],
      lookupPublicAddresses: async () => [{ address: '172.67.220.76', family: 4 }]
    })).hostname,
    'fake.example.com'
  );
});

test('Core AI provider request normalizes OpenAI-compatible messages without exposing internal attachments', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const message = await requestOpenAiMessage(
    {
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      apiKey: 'provider-secret',
      toolsEnabled: true,
      timeoutMs: 3000,
      reasoningEffort: 'auto'
    },
    [{
      role: 'user',
      content: '提报隐患',
      internal_attachments: [{ kind: 'hazard_photo', url: 'https://files.example.com/photo.jpg?sig=secret' }]
    }],
    [{
      type: 'function',
      function: {
        name: 'afc_report_hazard',
        description: '提报隐患',
        parameters: { type: 'object', properties: { description: { type: 'string' } } }
      }
    }],
    async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            reasoning_content: '需要调用工具。',
            tool_calls: [{
              id: 'tool-1',
              type: 'function',
              function: { name: 'afc_report_hazard', arguments: { description: '地面积水' } }
            }]
          }
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    {
      toolChoice: { type: 'function', function: { name: 'afc_report_hazard' } },
      endpointSafetyCheck: async () => undefined
    }
  );

  assert.deepEqual(requestBody?.thinking, { type: 'disabled' });
  assert.equal(JSON.stringify(requestBody).includes('sig=secret'), false);
  assert.equal(message.reasoning_content, '需要调用工具。');
  assert.equal(message.tool_calls?.[0]?.function.arguments, '{"description":"地面积水"}');
});

test('Core AI model listing derives models endpoint and normalizes provider errors', async () => {
  const listed = await listExternalProviderModels(
    {
      endpoint: 'https://api.example.com/v1/chat/completions',
      apiKey: 'provider-secret',
      timeoutMs: 3000
    },
    async (url) => {
      assert.equal(String(url), 'https://api.example.com/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    async () => undefined
  );
  assert.deepEqual(listed.models, ['model-a', 'model-b']);

  await assert.rejects(
    requestOpenAiMessage(
      {
        endpoint: 'https://api.example.com/v1/chat/completions',
        model: 'model-a',
        apiKey: 'provider-secret',
        toolsEnabled: false,
        timeoutMs: 3000,
        reasoningEffort: 'auto'
      },
      [{ role: 'user', content: '你好' }],
      [],
      async () => {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      },
      { endpointSafetyCheck: async () => undefined }
    ),
    (error) => {
      assert.ok(error instanceof AiProviderTransportError);
      assert.equal(error.code, 'AI_PROVIDER_TIMEOUT');
      return true;
    }
  );

  await assert.rejects(
    listExternalProviderModels(
      {
        endpoint: 'https://api.example.com/v1/chat/completions',
        apiKey: 'provider-secret',
        timeoutMs: 3000
      },
      async () => {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      },
      async () => undefined
    ),
    (error) => {
      assert.ok(error instanceof AiProviderTransportError);
      assert.equal(error.code, 'AI_PROVIDER_MODELS_TIMEOUT');
      return true;
    }
  );
});
