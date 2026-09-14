// Current-system compatibility only. Not exported by the modern MCP entrypoint.
import { CoreMcpTransportError, MCP_REQUEST_TIMEOUT_MS, type CoreMcpToolPolicy, type McpToolDefinition } from './contracts.js';
export * from './contracts.js';
import {
  ACTOR_NAME_B64_HEADER,
  createSignedActorToken,
  stripModelVisibleTrustedIdentityFields
} from '../../identity/index.js';

export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const LEGACY_MCP_WECOM_USER_ID_HEADER = 'x-wecom-userid';

export interface CoreMcpClientLike {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface CoreMcpActorIdentity {
  name: string;
  wecomUserId?: string | null;
}

export interface CoreMcpHttpClientOptions {
  endpoint: string;
  apiKey: string;
  actorSigningSecret: string;
  actor: CoreMcpActorIdentity;
  toolPolicy: CoreMcpToolPolicy;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RpcEnvelope {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export function createMcpActorIdentity(actor: CoreMcpActorIdentity): { actor_wecom_userid?: string; actor_name?: string } {
  const wecomUserId = actor.wecomUserId?.trim();
  return wecomUserId
    ? { actor_wecom_userid: wecomUserId }
    : { actor_name: actor.name };
}

export class CoreMcpHttpClient implements CoreMcpClientLike {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly actorSigningSecret: string;
  private readonly actor: CoreMcpActorIdentity;
  private readonly toolPolicy: CoreMcpToolPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private sessionId = '';
  private requestId = 0;

  constructor(options: CoreMcpHttpClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.actorSigningSecret = options.actorSigningSecret;
    this.actor = options.actor;
    this.toolPolicy = options.toolPolicy;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
  }

  private headers(includeSession = true): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION
    });
    if (includeSession && this.sessionId) headers.set('Mcp-Session-Id', this.sessionId);
    if (this.actor.wecomUserId?.trim()) {
      headers.set(LEGACY_MCP_WECOM_USER_ID_HEADER, this.actor.wecomUserId.trim());
    } else {
      headers.set(ACTOR_NAME_B64_HEADER, Buffer.from(this.actor.name, 'utf8').toString('base64'));
    }
    return headers;
  }

  private async parseResponse(response: Response): Promise<RpcEnvelope | null> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as RpcEnvelope;
    } catch {
      throw new CoreMcpTransportError('MCP 返回了无法解析的响应', { code: 'MCP_INVALID_RESPONSE' });
    }
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.sessionId) {
      throw new CoreMcpTransportError('MCP 会话尚未初始化', { code: 'MCP_SESSION_NOT_INITIALIZED', statusCode: 400 });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.requestId,
          method,
          ...(params === undefined ? {} : { params })
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new CoreMcpTransportError(
        error instanceof Error && error.name === 'TimeoutError' ? 'MCP 请求超时' : 'MCP 网络请求失败',
        { code: error instanceof Error && error.name === 'TimeoutError' ? 'MCP_TIMEOUT' : 'MCP_NETWORK_ERROR' }
      );
    }

    const payload = await this.parseResponse(response);
    if (!response.ok || payload?.error) {
      throw new CoreMcpTransportError(payload?.error?.message || `MCP 请求失败（HTTP ${response.status}）`, {
        code: 'MCP_RPC_ERROR',
        statusCode: response.status >= 400 ? response.status : 502
      });
    }
    return payload?.result;
  }

  async initialize(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers(false),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.requestId,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'platform-core-mcp-client', version: '1.0.0' }
          }
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new CoreMcpTransportError(
        error instanceof Error && error.name === 'TimeoutError' ? 'MCP 初始化超时' : 'MCP 初始化网络请求失败',
        { code: error instanceof Error && error.name === 'TimeoutError' ? 'MCP_INITIALIZE_TIMEOUT' : 'MCP_INITIALIZE_NETWORK_ERROR' }
      );
    }

    const payload = await this.parseResponse(response);
    const sessionId = response.headers.get('mcp-session-id') || '';
    if (!response.ok || payload?.error || !sessionId) {
      throw new CoreMcpTransportError(payload?.error?.message || 'MCP 初始化失败', {
        code: 'MCP_INITIALIZE_FAILED',
        statusCode: response.status >= 400 ? response.status : 502
      });
    }
    this.sessionId = sessionId;

    const notification = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!notification.ok) {
      throw new CoreMcpTransportError('MCP 初始化通知失败', {
        code: 'MCP_INITIALIZED_NOTIFICATION_FAILED',
        statusCode: notification.status >= 400 ? notification.status : 502
      });
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request('tools/list') as { tools?: McpToolDefinition[] } | undefined;
    return Array.isArray(result?.tools)
      ? result.tools.filter((tool) => this.toolPolicy.allowedToolNames.has(tool.name))
      : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.toolPolicy.allowedToolNames.has(name)) {
      throw new CoreMcpTransportError(`MCP 工具不在调用策略中：${name}`, { code: 'MCP_TOOL_NOT_ALLOWED', statusCode: 403 });
    }
    this.toolPolicy.validateCall?.(name, args);
    const actorToken = createSignedActorToken(createMcpActorIdentity(this.actor), this.actorSigningSecret);
    return this.request('tools/call', {
      name,
      arguments: {
        ...stripModelVisibleTrustedIdentityFields(args),
        actor_token: actorToken
      }
    });
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.endpoint, {
        method: 'DELETE',
        headers: this.headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      });
    } catch {
      // Session cleanup is best-effort and must not replace the completed user response with an error.
    } finally {
      this.sessionId = '';
    }
  }
}
