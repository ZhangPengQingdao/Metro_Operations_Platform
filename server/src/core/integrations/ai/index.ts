import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { OpenAiToolDefinition } from '../mcp/index.js';

export interface AiProviderRuntimeConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  toolsEnabled: boolean;
  timeoutMs: number;
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high';
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AiProviderChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface RequestOpenAiOptions {
  toolChoice?: 'auto' | 'required' | {
    type: 'function';
    function: { name: string };
  };
  thinking?: 'enabled' | 'disabled';
  endpointSafetyCheck?: (value: string) => Promise<unknown>;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
  }>;
  error?: { message?: string };
}

type ResolvedAddress = { address: string; family: number };

export type ExternalEndpointSafetyDependencies = {
  lookupAddresses?: (hostname: string) => Promise<ResolvedAddress[]>;
  lookupPublicAddresses?: (hostname: string) => Promise<ResolvedAddress[]>;
};

export class AiProviderTransportError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, options: { code?: string; statusCode?: number } = {}) {
    super(message);
    this.name = 'AiProviderTransportError';
    this.code = options.code ?? 'AI_PROVIDER_TRANSPORT_ERROR';
    this.statusCode = options.statusCode ?? 502;
  }
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? isBlockedIpv4(mapped) : true;
  }
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('2001:db8:');
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function isProxyFakeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [first, second] = address.split('.').map(Number);
    return first === 198 && (second === 18 || second === 19);
  }
  if (family === 6) return address.toLowerCase().startsWith('fdfe:dcba:9876:');
  return false;
}

async function lookupPublicAddressesOverHttps(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = new Map<string, ResolvedAddress>();
  for (const [recordType, family] of [['A', 4], ['AAAA', 6]] as const) {
    const endpoint = new URL('https://cloudflare-dns.com/dns-query');
    endpoint.searchParams.set('name', hostname);
    endpoint.searchParams.set('type', recordType);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      continue;
    }
    if (!response.ok) continue;

    const payload = await response.json().catch(() => null) as {
      Answer?: Array<{ type?: number; data?: string }>;
    } | null;
    const expectedType = family === 4 ? 1 : 28;
    for (const answer of payload?.Answer ?? []) {
      const address = typeof answer.data === 'string' ? answer.data.trim() : '';
      if (answer.type === expectedType && isIP(address) === family) {
        addresses.set(address, { address, family });
      }
    }
  }
  return [...addresses.values()];
}

export function validateAiProviderEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiProviderTransportError('在线 API 请求地址无效', { code: 'AI_PROVIDER_ENDPOINT_INVALID', statusCode: 400 });
  }

  if (url.protocol !== 'https:') {
    throw new AiProviderTransportError('在线 API 请求地址必须使用 HTTPS', { code: 'AI_PROVIDER_ENDPOINT_NOT_HTTPS', statusCode: 400 });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AiProviderTransportError('在线 API 请求地址不能包含账号、密码、查询参数或片段', {
      code: 'AI_PROVIDER_ENDPOINT_HAS_EMBEDDED_DATA',
      statusCode: 400
    });
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new AiProviderTransportError('在线 API 请求地址不能指向本机或内网主机', {
      code: 'AI_PROVIDER_ENDPOINT_PRIVATE_HOST',
      statusCode: 400
    });
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) {
    throw new AiProviderTransportError('在线 API 请求地址不能指向内网或保留地址', {
      code: 'AI_PROVIDER_ENDPOINT_PRIVATE_ADDRESS',
      statusCode: 400
    });
  }
  return url;
}

export async function assertSafeAiProviderEndpoint(
  value: string,
  dependencies: ExternalEndpointSafetyDependencies = {}
): Promise<URL> {
  const url = validateAiProviderEndpoint(value);
  if (!isIP(url.hostname)) {
    let addresses: ResolvedAddress[];
    try {
      addresses = dependencies.lookupAddresses
        ? await dependencies.lookupAddresses(url.hostname)
        : await lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new AiProviderTransportError('在线 API 域名无法解析', { code: 'AI_PROVIDER_ENDPOINT_DNS_FAILED', statusCode: 400 });
    }
    if (!addresses.length) {
      throw new AiProviderTransportError('在线 API 域名无法解析', { code: 'AI_PROVIDER_ENDPOINT_DNS_EMPTY', statusCode: 400 });
    }

    const blockedAddresses = addresses.filter((item) => isBlockedAddress(item.address));
    if (blockedAddresses.length) {
      const isFakeIpProxyResult = blockedAddresses.length === addresses.length
        && addresses.every((item) => isProxyFakeAddress(item.address));
      if (isFakeIpProxyResult) {
        const publicAddresses = dependencies.lookupPublicAddresses
          ? await dependencies.lookupPublicAddresses(url.hostname)
          : await lookupPublicAddressesOverHttps(url.hostname);
        if (publicAddresses.length && publicAddresses.every((item) => !isBlockedAddress(item.address))) {
          return url;
        }
        throw new AiProviderTransportError('在线 API 域名命中了代理 Fake-IP，但公网 DNS 二次校验未通过', {
          code: 'AI_PROVIDER_ENDPOINT_FAKE_IP_UNVERIFIED',
          statusCode: 400
        });
      }
      throw new AiProviderTransportError('在线 API 域名解析到了内网或保留地址', {
        code: 'AI_PROVIDER_ENDPOINT_PRIVATE_DNS',
        statusCode: 400
      });
    }
  }
  return url;
}

export function deriveAiProviderModelsEndpoint(value: string): URL {
  const url = validateAiProviderEndpoint(value);
  if (/\/chat\/completions\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/i, '/models');
  } else if (/\/v1\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  } else {
    throw new AiProviderTransportError('无法从请求地址推导模型列表地址，请手动填写模型 ID', {
      code: 'AI_MODELS_ENDPOINT_UNSUPPORTED',
      statusCode: 400
    });
  }
  return url;
}

export function normalizeAiProviderContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const text = value
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const candidate = item as { text?: unknown };
      return typeof candidate.text === 'string' ? candidate.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

export function normalizeAiProviderReasoningContent(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function normalizeOpenAiToolCalls(value: unknown): OpenAiToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = typeof candidate.function?.name === 'string' ? candidate.function.name.trim() : '';
    if (!name) return [];
    const rawArguments = candidate.function?.arguments;
    const argumentsText = typeof rawArguments === 'string'
      ? rawArguments
      : JSON.stringify(rawArguments ?? {});
    return [{
      id: typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id.trim()
        : `call_${index + 1}`,
      type: 'function' as const,
      function: { name, arguments: argumentsText }
    }];
  });
}

function isOfficialDeepSeekEndpoint(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function requiresForcedToolChoice(toolChoice: RequestOpenAiOptions['toolChoice']): boolean {
  return toolChoice === 'required' || (typeof toolChoice === 'object' && toolChoice !== null);
}

export async function requestOpenAiMessage(
  config: AiProviderRuntimeConfig,
  messages: Array<AiProviderChatMessage & { internal_attachments?: unknown }>,
  tools: OpenAiToolDefinition[],
  fetchImpl: typeof fetch = fetch,
  options: RequestOpenAiOptions = {}
): Promise<AiProviderChatMessage> {
  await (options.endpointSafetyCheck ?? assertSafeAiProviderEndpoint)(config.endpoint);
  const thinking = isOfficialDeepSeekEndpoint(config.endpoint) && requiresForcedToolChoice(options.toolChoice)
    ? 'disabled'
    : options.thinking;
  const providerMessages = messages.map(({ internal_attachments: _internalAttachments, ...message }) => message);
  const body = {
    model: config.model,
    messages: providerMessages,
    stream: false,
    ...(thinking ? { thinking: { type: thinking } } : {}),
    ...(config.reasoningEffort !== 'auto' ? { reasoning_effort: config.reasoningEffort } : {}),
    ...(tools.length > 0 ? {
      tools,
      tool_choice: options.toolChoice ?? 'auto'
    } : {})
  };

  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    throw new AiProviderTransportError(
      error instanceof Error && error.name === 'TimeoutError' ? '在线模型请求超时' : '在线模型网络请求失败',
      { code: error instanceof Error && error.name === 'TimeoutError' ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_NETWORK_ERROR' }
    );
  }

  const payload = await response.json().catch(() => ({})) as OpenAiChatResponse;
  if (!response.ok) {
    throw new AiProviderTransportError(payload.error?.message || `在线模型返回 HTTP ${response.status}`, {
      code: 'AI_PROVIDER_HTTP_ERROR',
      statusCode: response.status
    });
  }
  const rawMessage = payload.choices?.[0]?.message;
  if (!rawMessage) {
    throw new AiProviderTransportError('在线模型没有返回有效消息', { code: 'AI_PROVIDER_EMPTY_MESSAGE' });
  }
  const message: AiProviderChatMessage = {
    role: 'assistant',
    content: normalizeAiProviderContent(rawMessage.content)
  };
  const reasoningContent = normalizeAiProviderReasoningContent(rawMessage.reasoning_content);
  if (reasoningContent !== undefined) message.reasoning_content = reasoningContent;
  const toolCalls = normalizeOpenAiToolCalls(rawMessage.tool_calls);
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

export async function listExternalProviderModels(
  config: Pick<AiProviderRuntimeConfig, 'endpoint' | 'apiKey' | 'timeoutMs'>,
  fetchImpl: typeof fetch = fetch,
  endpointSafetyCheck: (value: string) => Promise<unknown> = assertSafeAiProviderEndpoint
): Promise<{ models: string[]; endpoint: string }> {
  const modelsUrl = deriveAiProviderModelsEndpoint(config.endpoint);
  await endpointSafetyCheck(modelsUrl.toString());
  let response: Response;
  try {
    response = await fetchImpl(modelsUrl.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    throw new AiProviderTransportError(
      error instanceof Error && error.name === 'TimeoutError' ? '在线模型列表请求超时' : '在线模型列表网络请求失败',
      { code: error instanceof Error && error.name === 'TimeoutError' ? 'AI_PROVIDER_MODELS_TIMEOUT' : 'AI_PROVIDER_MODELS_NETWORK_ERROR' }
    );
  }
  const payload = await response.json().catch(() => ({})) as {
    data?: unknown;
    models?: unknown;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new AiProviderTransportError(payload.error?.message || `在线模型列表返回 HTTP ${response.status}`, {
      code: 'AI_PROVIDER_MODELS_HTTP_ERROR',
      statusCode: response.status
    });
  }
  const rawModels = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = rawModels
    .map((item) => typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : '')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
    .sort((left, right) => left.localeCompare(right));
  if (!models.length) throw new AiProviderTransportError('在线 API 未返回可用模型', { code: 'AI_PROVIDER_MODELS_EMPTY' });
  return { models, endpoint: modelsUrl.toString() };
}

export async function testExternalProviderConnection(
  config: AiProviderRuntimeConfig,
  fetchImpl: typeof fetch = fetch,
  endpointSafetyCheck: (value: string) => Promise<unknown> = assertSafeAiProviderEndpoint
): Promise<{ model: string; latency_ms: number; tool_calling: true }> {
  const startedAt = Date.now();
  const testTool: OpenAiToolDefinition = {
    type: 'function',
    function: {
      name: 'connection_check',
      description: '用于验证模型是否支持工具调用，不执行任何业务操作。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  };
  const message = await requestOpenAiMessage(
    config,
    [
      { role: 'system', content: '你正在执行连接测试。必须调用 connection_check，不要输出其他内容。' },
      { role: 'user', content: '请调用连接测试工具。' }
    ],
    [testTool],
    fetchImpl,
    {
      toolChoice: { type: 'function', function: { name: 'connection_check' } },
      endpointSafetyCheck
    }
  );
  if (!message.tool_calls?.some((call) => call.function.name === 'connection_check')) {
    throw new AiProviderTransportError('模型连接成功，但没有按 OpenAI 兼容协议返回工具调用', {
      code: 'AI_PROVIDER_TOOL_CALLING_UNSUPPORTED'
    });
  }
  return {
    model: config.model,
    latency_ms: Date.now() - startedAt,
    tool_calling: true
  };
}

export {getPublicAiRuntimeConfig,saveAiRuntimeConfig,resolveExternalProviderConfig,resolveExternalConnectionConfig,AiRuntimeConfigError} from './config.js';
