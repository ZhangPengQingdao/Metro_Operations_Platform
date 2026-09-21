export type TrustedWebhookProvider = 'wecom' | 'dingtalk';
export type WeComChatType = 'single' | 'group';
export type WeComWebhookMessageType = 'auto' | 'text';
export type SmartSheetWebhookOperation = 'create' | 'update' | 'delete';

export interface WeComAibotChatTarget {
  chatId: string;
  chatName: string;
  chatType: WeComChatType;
  lastMessageTime: string;
  nativeReady?: boolean;
  nativeChatId?: string;
}

export interface WeComWebhookPayloadOptions {
  messageType?: WeComWebhookMessageType;
  mentionedUserIds?: readonly string[];
  mentionedMobiles?: readonly string[];
}

export interface SmartSheetWebhookRecordInput {
  webhookUrl: string;
  operation: SmartSheetWebhookOperation;
  remoteRecordId?: string | null;
  values?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface WeComAibotGatewayClientOptions {
  gatewayUrl: string;
  internalApiToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class WeComTransportError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly provider?: TrustedWebhookProvider;

  constructor(message: string, options: { code?: string; statusCode?: number; provider?: TrustedWebhookProvider } = {}) {
    super(message);
    this.name = 'WeComTransportError';
    this.code = options.code ?? 'WECOM_TRANSPORT_ERROR';
    this.statusCode = options.statusCode ?? 502;
    this.provider = options.provider;
  }
}

export class WeComAibotGatewayError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = 'AibotGatewayError';
    this.statusCode = options.statusCode ?? 503;
    this.code = options.code ?? 'AIBOT_GATEWAY_ERROR';
  }
}

const TRUSTED_WEBHOOK_HOSTS = new Map<string, TrustedWebhookProvider>([
  ['qyapi.weixin.qq.com', 'wecom'],
  ['oapi.dingtalk.com', 'dingtalk']
]);
const WECOM_MARKDOWN_BYTE_LIMIT = 3900;
const WECOM_TEXT_BYTE_LIMIT = 1900;
const AIBOT_MARKDOWN_BYTE_LIMIT = 20_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export function parseTrustedWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new WeComTransportError('Webhook 地址格式无效', { code: 'WEBHOOK_URL_NOT_ALLOWED', statusCode: 400 });
  }

  if (url.protocol !== 'https:') {
    throw new WeComTransportError('Webhook 地址必须使用 HTTPS', { code: 'WEBHOOK_URL_NOT_ALLOWED', statusCode: 400 });
  }
  if (url.username || url.password || url.hash) {
    throw new WeComTransportError('Webhook 地址不能包含账号、密码或片段', {
      code: 'WEBHOOK_URL_NOT_ALLOWED',
      statusCode: 400
    });
  }
  const hostname = url.hostname.toLowerCase();
  if (!TRUSTED_WEBHOOK_HOSTS.has(hostname)) {
    throw new WeComTransportError('Webhook 仅允许企业微信或钉钉官方域名', {
      code: 'WEBHOOK_URL_NOT_ALLOWED',
      statusCode: 400
    });
  }
  if (!url.pathname || url.pathname === '/') {
    throw new WeComTransportError('Webhook 地址缺少接口路径', { code: 'WEBHOOK_URL_NOT_ALLOWED', statusCode: 400 });
  }
  if (value.length > 2048) {
    throw new WeComTransportError('Webhook 地址长度不能超过 2048 个字符', {
      code: 'WEBHOOK_URL_NOT_ALLOWED',
      statusCode: 400
    });
  }

  return url;
}

export function getTrustedWebhookProvider(value: string): TrustedWebhookProvider {
  const hostname = parseTrustedWebhookUrl(value).hostname.toLowerCase();
  return TRUSTED_WEBHOOK_HOSTS.get(hostname) ?? 'wecom';
}

export function normalizeWeComTextMessage(content: unknown, chatType: WeComChatType = 'single') {
  const normalized = typeof content === 'string' ? content.trim() : '';
  if (chatType !== 'group' || !normalized) return normalized;

  return normalized
    .replace(/^@\S+\s+/u, '')
    .replace(/\s*@[^@\r\n]+$/u, '')
    .trim();
}

export function normalizeWeComChatTarget(value: unknown): WeComAibotChatTarget | null {
  if (!isObject(value)) return null;
  const chatId = stringValue(value.chatId);
  const chatName = stringValue(value.chatName);
  const chatType: WeComChatType | null = value.chatType === 'single' || value.chatType === 'group' ? value.chatType : null;
  const lastMessageTime = stringValue(value.lastMessageTime);
  const nativeChatId = stringValue(value.nativeChatId);

  if (!chatId || !chatName || !chatType || !lastMessageTime) return null;

  return removeUndefinedValues({
    chatId,
    chatName,
    chatType,
    lastMessageTime,
    nativeReady: typeof value.nativeReady === 'boolean' ? value.nativeReady : undefined,
    nativeChatId: nativeChatId || undefined
  });
}

export function splitMarkdownForWeCom(message: string, limit = WECOM_MARKDOWN_BYTE_LIMIT) {
  const lines = message.split(/\r?\n/);
  const chunks: string[] = [];
  let plainLines: string[] = [];

  const flushPlainLines = () => {
    if (plainLines.length === 0) {
      return;
    }
    splitLinesByWeComLimit(plainLines, limit).forEach((chunk) => appendWeComMarkdownChunk(chunks, chunk, limit));
    plainLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (!isMarkdownTableStart(lines, index)) {
      plainLines.push(lines[index]);
      continue;
    }

    flushPlainLines();

    const tableLines = [lines[index], lines[index + 1]];
    index += 2;
    while (index < lines.length && isMarkdownTableRow(lines[index])) {
      tableLines.push(lines[index]);
      index += 1;
    }
    index -= 1;

    splitMarkdownTableByWeComLimit(tableLines, limit).forEach((chunk) => appendWeComMarkdownChunk(chunks, chunk, limit));
  }

  flushPlainLines();

  return chunks.length > 0 ? chunks : [''];
}

export function buildWeComWebhookPayloads(
  message: string,
  options: WeComWebhookPayloadOptions = {}
) {
  if (options.messageType === 'text') {
    const mentionedList = Array.from(new Set(
      (options.mentionedUserIds ?? []).map((item) => item.trim()).filter(Boolean)
    ));
    const mentionedMobileList = Array.from(new Set(
      (options.mentionedMobiles ?? []).map((item) => item.trim()).filter((item) => /^1[3-9]\d{9}$/.test(item))
    ));

    return splitMarkdownForWeCom(message, WECOM_TEXT_BYTE_LIMIT).map((content, index) => ({
      msgtype: 'text',
      text: {
        content,
        ...(index === 0 && mentionedList.length > 0 ? { mentioned_list: mentionedList } : {}),
        ...(index === 0 && mentionedMobileList.length > 0 ? { mentioned_mobile_list: mentionedMobileList } : {})
      }
    }));
  }

  const useMarkdownV2 = shouldUseWeComMarkdownV2(message);
  const msgtype = useMarkdownV2 ? 'markdown_v2' : 'markdown';
  const chunks = splitMarkdownForWeCom(message);

  return chunks.map((content) => ({
    msgtype,
    [msgtype]: {
      content
    }
  }));
}

export async function postTrustedWebhookPayload(
  url: string,
  payload: Record<string, unknown>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {}
) {
  const provider = getTrustedWebhookProvider(url);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)]) : AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? '请求超时' : '网络请求失败';
    throw new WeComTransportError(`Webhook 推送失败：${reason}`, {
      code: error instanceof Error && error.name === 'TimeoutError' ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_NETWORK_ERROR',
      provider
    });
  }

  const responseText = await response.text().catch(() => '');
  if (!response.ok) {
    throw new WeComTransportError(`Webhook 推送失败：HTTP ${response.status}`, {
      code: 'WEBHOOK_HTTP_ERROR',
      statusCode: response.status,
      provider
    });
  }

  let responseBody: { errcode?: unknown; errmsg?: unknown };
  try {
    responseBody = JSON.parse(responseText) as { errcode?: unknown; errmsg?: unknown };
  } catch {
    throw new WeComTransportError('Webhook 推送失败：平台返回了无效响应', {
      code: 'WEBHOOK_INVALID_RESPONSE',
      provider
    });
  }
  const errorCode = Number(responseBody.errcode);
  if (!Number.isFinite(errorCode) || errorCode !== 0) {
    const message = typeof responseBody.errmsg === 'string' && responseBody.errmsg.trim()
      ? responseBody.errmsg.trim().slice(0, 200)
      : '平台拒绝了本次请求';
    throw new WeComTransportError(`${provider === 'wecom' ? '企业微信' : '钉钉'} Webhook 推送失败：${Number.isFinite(errorCode) ? errorCode : 'UNKNOWN'} ${message}`, {
      code: 'WEBHOOK_PROVIDER_REJECTED',
      provider
    });
  }
}

export async function sendTrustedWebhookMessage(
  url: string,
  message: string,
  options: {
    weComMessageType?: WeComWebhookMessageType;
    mentionedUserIds?: readonly string[];
    mentionedMobiles?: readonly string[];
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
) {
  const normalizedUrl = url.trim();

  if (!normalizedUrl) {
    throw new WeComTransportError('Webhook 地址不能为空', { code: 'WEBHOOK_URL_EMPTY', statusCode: 400 });
  }

  const provider = getTrustedWebhookProvider(normalizedUrl);
  if (provider === 'wecom') {
    const payloads = buildWeComWebhookPayloads(message, {
      messageType: options.weComMessageType,
      mentionedUserIds: options.mentionedUserIds,
      mentionedMobiles: options.mentionedMobiles
    });
    for (const payload of payloads) {
      await postTrustedWebhookPayload(normalizedUrl, payload, options);
    }
    return;
  }

  await postTrustedWebhookPayload(normalizedUrl, {
    msgtype: 'text',
    text: {
      content: message
    }
  }, options);
}

export async function sendSmartSheetWebhookRecord(input: SmartSheetWebhookRecordInput) {
  if ((input.operation === 'update' || input.operation === 'delete') && !input.remoteRecordId) {
    throw new WeComTransportError(input.operation === 'delete' ? '删除云文档记录时缺少 remoteRecordId' : '更新云文档记录时缺少 remoteRecordId', {
      code: 'SMARTSHEET_REMOTE_ID_MISSING',
      statusCode: 400
    });
  }
  if (input.operation === 'delete') {
    throw new WeComTransportError('企业微信智能表格“接收外部数据”Webhook 不支持删除记录；需要配置正式 API 或在云端手工删除', {
      code: 'SMARTSHEET_WEBHOOK_DELETE_UNSUPPORTED',
      statusCode: 400
    });
  }
  if (!input.values) {
    throw new WeComTransportError('云文档记录内容不能为空', {
      code: 'SMARTSHEET_VALUES_EMPTY',
      statusCode: 400
    });
  }
  const normalizedUrl = input.webhookUrl.trim();
  parseTrustedWebhookUrl(normalizedUrl);

  const payload = input.operation === 'create'
    ? { add_records: [{ values: input.values }] }
    : {
      update_records: [{
        record_id: input.remoteRecordId,
        values: input.values
      }]
    };

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(normalizedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    throw new WeComTransportError(
      `云文档同步失败: ${error instanceof Error && error.name === 'TimeoutError' ? '请求超时' : '网络请求失败'}`,
      {
        code: error instanceof Error && error.name === 'TimeoutError' ? 'SMARTSHEET_WEBHOOK_TIMEOUT' : 'SMARTSHEET_WEBHOOK_NETWORK_ERROR',
        provider: 'wecom'
      }
    );
  }
  const body = await response.json().catch(() => ({})) as {
    errcode?: number;
    errmsg?: string;
    add_records?: Array<{ record_id?: string }>;
    update_records?: Array<{ record_id?: string }>;
  };

  if (!response.ok || body.errcode !== 0) {
    throw new WeComTransportError(`云文档同步失败: ${body.errcode ?? response.status} ${body.errmsg ?? response.statusText}`, {
      code: 'SMARTSHEET_WEBHOOK_FAILED',
      statusCode: response.status >= 400 ? response.status : 502,
      provider: 'wecom'
    });
  }

  const remoteRecordId = input.operation === 'create'
    ? body.add_records?.[0]?.record_id
    : body.update_records?.[0]?.record_id ?? input.remoteRecordId;

  if (!remoteRecordId) {
    throw new WeComTransportError('云文档同步成功但未返回 record_id', {
      code: 'SMARTSHEET_RECORD_ID_MISSING',
      statusCode: 502,
      provider: 'wecom'
    });
  }

  return {
    remoteRecordId
  };
}

export function createWeComAibotGatewayClient(options: WeComAibotGatewayClientOptions) {
  const gatewayUrl = options.gatewayUrl.replace(/\/$/, '');

  async function requestGateway(path: string, init: RequestInit) {
    let response: Response;

    try {
      response = await (options.fetchImpl ?? fetch)(`${gatewayUrl}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          'x-internal-api-token': options.internalApiToken
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
    } catch (error) {
      throw new WeComAibotGatewayError('企业微信智能体网关暂时不可用', {
        code: error instanceof Error && error.name === 'TimeoutError' ? 'AIBOT_GATEWAY_TIMEOUT' : 'AIBOT_GATEWAY_UNAVAILABLE'
      });
    }

    const body = await response.json().catch(() => ({})) as {
      success?: boolean;
      data?: unknown;
      error?: { code?: string; message?: string };
    };

    if (!response.ok || body.success !== true) {
      throw new WeComAibotGatewayError(
        body.error?.message || `企业微信智能体网关返回 HTTP ${response.status}`,
        {
          statusCode: response.status >= 400 ? response.status : 503,
          code: body.error?.code || 'AIBOT_GATEWAY_ERROR'
        }
      );
    }

    return body;
  }

  return {
    async listSessions() {
      const body = await requestGateway('/internal/aibot/sessions', {
        method: 'GET'
      });
      const rawSessions = Array.isArray(body.data)
        ? body.data
        : (body.data && typeof body.data === 'object' && Array.isArray((body.data as { sessions?: unknown }).sessions)
          ? (body.data as { sessions: unknown[] }).sessions
          : []);
      const sessions = rawSessions.map(normalizeWeComChatTarget);

      if (sessions.some((session) => !session)) {
        throw new WeComAibotGatewayError('企业微信智能体网关返回的会话数据无效', {
          code: 'AIBOT_GATEWAY_INVALID_SESSIONS'
        });
      }

      return sessions as WeComAibotChatTarget[];
    },
    async sendMarkdown(target: WeComAibotChatTarget, message: string) {
      const chunks = splitMarkdownForWeCom(message, AIBOT_MARKDOWN_BYTE_LIMIT);
      for (const content of chunks) {
        await requestGateway('/internal/aibot/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            target,
            content
          })
        });
      }
    },
    async sendTemplateCard(target: WeComAibotChatTarget, templateCard: Record<string, unknown>) {
      await requestGateway('/internal/aibot/cards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          target,
          templateCard
        })
      });
    }
  };
}

function getUtf8ByteLength(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function isMarkdownTableDelimiter(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }

  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableStart(lines: string[], index: number) {
  const current = lines[index]?.trim() ?? '';
  return current.includes('|') && isMarkdownTableDelimiter(lines[index + 1] ?? '');
}

function isMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.split('|').length >= 3;
}

function shouldUseWeComMarkdownV2(message: string) {
  const lines = message.split(/\r?\n/);
  return lines.some((line, index) => isMarkdownTableStart(lines, index))
    || lines.some((line) => /^```/.test(line.trim()))
    || lines.some((line) => /^-{3,}$/.test(line.trim()))
    || /!\[[^\]]*]\([^)]+\)/.test(message);
}

function splitLongLine(line: string, limit = WECOM_MARKDOWN_BYTE_LIMIT) {
  const chunks: string[] = [];
  let current = '';

  for (const char of Array.from(line)) {
    const next = `${current}${char}`;
    if (current && getUtf8ByteLength(next) > limit) {
      chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLinesByWeComLimit(lines: string[], limit = WECOM_MARKDOWN_BYTE_LIMIT) {
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (getUtf8ByteLength(candidate) <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (getUtf8ByteLength(line) <= limit) {
      current = line;
    } else {
      chunks.push(...splitLongLine(line, limit));
    }
  }

  if (current || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

function splitMarkdownTableByWeComLimit(lines: string[], limit = WECOM_MARKDOWN_BYTE_LIMIT) {
  if (lines.length < 2) {
    return splitLinesByWeComLimit(lines, limit);
  }

  const header = lines[0];
  const delimiter = lines[1];
  const rows = lines.slice(2);
  const tablePrefix = [header, delimiter];

  if (getUtf8ByteLength(tablePrefix.join('\n')) > limit) {
    return splitLinesByWeComLimit(lines, limit);
  }

  const chunks: string[] = [];
  let currentRows: string[] = [];

  for (const row of rows) {
    const candidate = [...tablePrefix, ...currentRows, row].join('\n');
    if (getUtf8ByteLength(candidate) <= limit) {
      currentRows.push(row);
      continue;
    }

    if (currentRows.length > 0) {
      chunks.push([...tablePrefix, ...currentRows].join('\n'));
      currentRows = [];
    }

    const singleRowTable = [...tablePrefix, row].join('\n');
    if (getUtf8ByteLength(singleRowTable) <= limit) {
      currentRows = [row];
    } else {
      chunks.push(...splitLinesByWeComLimit([row], limit));
    }
  }

  if (currentRows.length > 0 || chunks.length === 0) {
    chunks.push([...tablePrefix, ...currentRows].join('\n'));
  }

  return chunks;
}

function appendWeComMarkdownChunk(chunks: string[], part: string, limit = WECOM_MARKDOWN_BYTE_LIMIT) {
  if (!part) {
    return;
  }

  const current = chunks[chunks.length - 1] ?? '';
  const candidate = current ? `${current}\n\n${part}` : part;

  if (current && getUtf8ByteLength(candidate) <= limit) {
    chunks[chunks.length - 1] = candidate;
    return;
  }

  if (getUtf8ByteLength(part) <= limit) {
    chunks.push(part);
    return;
  }

  splitLinesByWeComLimit(part.split('\n'), limit).forEach((chunk) => appendWeComMarkdownChunk(chunks, chunk, limit));
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
