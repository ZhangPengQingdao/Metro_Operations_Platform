import { Client, StreamableHTTPClientTransport, type ClientCapabilities } from '@modelcontextprotocol/client';
import {
  McpServer, createMcpHandler, fromJsonSchema, ProtocolError, ProtocolErrorCode,
  hostHeaderValidationResponse, originValidationResponse,
  type AuthInfo, type CallToolResult, type Implementation, type Resource,
  type ReadResourceResult, type ServerCapabilities, type ServerContext, type Tool, type JsonSchemaType
} from '@modelcontextprotocol/server';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { stripModelVisibleTrustedIdentityFields } from '../../identity/index.js';
import { CoreMcpTransportError, MCP_REQUEST_TIMEOUT_MS } from './contracts.js';

export * from './contracts.js';
export type { AuthInfo, CallToolResult, Implementation, ReadResourceResult, Resource, ServerContext, Tool } from '@modelcontextprotocol/server';
export type { ContentBlock, JSONValue, JsonSchemaType } from '@modelcontextprotocol/server';
export { CallToolResultSchema, ResourceSchema, ToolSchema } from '@modelcontextprotocol/core';

export const MCP_PROTOCOL_VERSION = '2026-07-28';

export interface CoreMcpToolRegistration {
  definition: Omit<Tool, 'inputSchema' | 'outputSchema'> & { inputSchema: JsonSchemaType; outputSchema?: JsonSchemaType };
  call(args: unknown, context: ServerContext): Promise<CallToolResult>;
}

export interface CoreMcpResourceRegistration {
  definition: Resource;
  read(uri: URL, context: ServerContext): Promise<ReadResourceResult>;
}

export interface CoreMcpHandlerOptions {
  serverInfo: Implementation;
  tools?: readonly CoreMcpToolRegistration[];
  resources?: readonly CoreMcpResourceRegistration[];
  extensions?: ServerCapabilities['extensions'];
  /** Trusted composition proves identity here; request metadata is never authentication. */
  authenticate(request: Request): Promise<AuthInfo | null>;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  onerror?(error: Error): void;
}

export interface CoreMcpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** One modern-only endpoint. Business registrations are immutable for its lifetime. */
export function createCoreMcpHandler(options: CoreMcpHandlerOptions): CoreMcpHandler {
  if (!options.allowedHosts.length || !options.allowedOrigins.length) {
    throw new TypeError('MCP Host and Origin allowlists must be explicit and non-empty.');
  }
  const tools = (options.tools ?? []).map((entry) => ({ ...entry, definition: structuredClone(entry.definition) }))
    .sort((a, b) => a.definition.name.localeCompare(b.definition.name, 'en'));
  const resources = (options.resources ?? []).map((entry) => ({ ...entry, definition: structuredClone(entry.definition) }))
    .sort((a, b) => a.definition.uri.localeCompare(b.definition.uri, 'en'));
  assertUnique(tools.map((entry) => entry.definition.name), 'tool name');
  assertUnique(resources.map((entry) => entry.definition.uri), 'resource URI');
  const serverInfo = structuredClone(options.serverInfo);
  const extensions = structuredClone(options.extensions ?? {});
  const allowedHosts = [...options.allowedHosts];
  const allowedOrigins = [...options.allowedOrigins];
  const handler = createMcpHandler(() => {
    const cache = { ttlMs: 0, cacheScope: 'private' as const };
    const server = new McpServer(serverInfo, {
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      capabilities: {
        ...(tools.length ? { tools: { listChanged: false } } : {}),
        ...(resources.length ? { resources: { listChanged: false, subscribe: false } } : {}),
        extensions
      },
      cacheHints: {
        'server/discover': cache, 'tools/list': cache,
        'resources/list': cache, 'resources/read': cache, 'resources/templates/list': cache
      }
    });
    for (const entry of tools) {
      const { name, inputSchema, outputSchema, ...metadata } = entry.definition;
      server.registerTool(name, {
        ...metadata,
        inputSchema: fromJsonSchema(inputSchema),
        ...(outputSchema === undefined ? {} : { outputSchema: fromJsonSchema(outputSchema) })
      }, (args, context) => runProvider(() => entry.call(args, context)));
    }
    for (const entry of resources) {
      const { name, uri, ...metadata } = entry.definition;
      server.registerResource(name, uri, metadata, (resourceUri, context) => runProvider(() => entry.read(resourceUri, context)));
    }
    return server;
  }, { legacy: 'reject', responseMode: 'auto', onerror: options.onerror });

  async function runProvider<T>(invoke: () => Promise<T>): Promise<T> {
    try { return await invoke(); }
    catch (error) {
      try {
        options.onerror?.(error instanceof Error ? error : new Error('MCP provider threw a non-Error value.'));
      } finally {
        // An observer failure must not replace the safe wire error with internal details.
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'MCP provider failed.');
      }
    }
  }

  return {
    async fetch(request) {
      const rejected = hostHeaderValidationResponse(request, allowedHosts)
        ?? originValidationResponse(request, allowedOrigins);
      if (rejected) return rejected;
      let authInfo: AuthInfo | null;
      try { authInfo = await runProvider(() => options.authenticate(request)); }
      catch { return new Response('MCP authentication failed.', { status: 500 }); }
      if (!authInfo) return new Response('Unauthorized', { status: 401 });
      return handler.fetch(request, { authInfo });
    },
    close: () => handler.close()
  };
}

/** Unmounted factory for the future Host composition, not a current application route. */
export function createCoreMcpFastifyHost(options: CoreMcpHandlerOptions) {
  const handler = createCoreMcpHandler(options);
  const app = createMcpFastifyApp({ allowedHosts: [...options.allowedHosts], allowedOrigins: [...options.allowedOrigins] });
  const nodeHandler = toNodeHandler(handler, { onerror: options.onerror });
  app.all('/mcp', async (request, reply) => {
    reply.hijack();
    await nodeHandler(request.raw, reply.raw, request.body);
  });
  app.addHook('onClose', () => handler.close());
  return app;
}

export interface CoreModernMcpClientOptions {
  /** Server-owned configuration, never model input. */
  endpoint: string;
  clientInfo: Implementation;
  capabilities?: ClientCapabilities;
  allowedToolNames: ReadonlySet<string>;
  token(): Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** No access to SDK negotiation mutators is exposed: this client cannot fall back. */
export function createCoreModernMcpClient(options: CoreModernMcpClientOptions) {
  const timeout = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new TypeError('MCP timeout must be a positive integer.');
  const endpoint = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('MCP endpoint must be a credential-free HTTP(S) URL without query or fragment.');
  }
  const allowed = new Set(options.allowedToolNames);
  const client = new Client(structuredClone(options.clientInfo), {
    supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION }, probe: { timeoutMs: timeout, maxRetries: 0 } },
    capabilities: structuredClone(options.capabilities ?? {}),
    enforceStrictCapabilities: true,
    inputRequired: { autoFulfill: false }
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: options.token },
    fetch: options.fetchImpl,
    requestInit: { redirect: 'error' },
    onInsufficientScope: 'throw',
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
  });
  return {
    async connect() {
      try { await client.connect(transport, { timeout }); }
      catch (error) { await client.close(); throw error; }
    },
    getProtocolEra: () => client.getProtocolEra(),
    getServerInfo: () => client.getServerVersion(),
    discover: () => client.discover({ timeout }),
    async listTools() {
      const result = await client.listTools(undefined, { timeout });
      return { ...result, tools: result.tools.filter((tool) => allowed.has(tool.name)) };
    },
    listResources: () => client.listResources(undefined, { timeout }),
    readResource: (uri: string) => client.readResource({ uri }, { timeout }),
    callTool(name: string, args: Record<string, unknown>) {
      if (!allowed.has(name)) throw new CoreMcpTransportError('MCP tool is not allowed.', { code: 'MCP_TOOL_NOT_ALLOWED', statusCode: 403 });
      return client.callTool({ name, arguments: stripModelVisibleTrustedIdentityFields(args) }, { timeout });
    },
    close: () => client.close()
  };
}

function assertUnique(values: readonly string[], label: string) {
  if (values.some((value) => !value.trim()) || new Set(values).size !== values.length) throw new TypeError(`MCP ${label} must be non-empty and unique.`);
}
