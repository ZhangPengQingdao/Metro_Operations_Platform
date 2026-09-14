import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { assertSafeAiProviderEndpoint, type ExternalEndpointSafetyDependencies } from '../integrations/ai/index.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  readHeaderValue,
  stripModelVisibleTrustedIdentityFields
} from '../identity/index.js';
import { isSafeStorageFileName } from '../storage/index.js';

export type CoreSecurityErrorCode =
  | 'SERVICE_TOKEN_MISSING'
  | 'SERVICE_TOKEN_INVALID'
  | 'UNSAFE_UPLOAD_FILE_NAME'
  | 'UNSAFE_UPLOAD_SIZE'
  | 'UNSAFE_UPLOAD_CONTENT_TYPE'
  | 'REPLAY_NONCE_INVALID'
  | 'REPLAY_NONCE_REUSED'
  | 'RATE_LIMITED';

export class CoreSecurityError extends Error {
  readonly code: CoreSecurityErrorCode;
  readonly statusCode: number;

  constructor(code: CoreSecurityErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'CoreSecurityError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ServiceTokenAuthOptions {
  readonly headerName?: string;
}

export interface UploadSecurityInput {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly contentType?: string | null;
}

export interface UploadSecurityPolicy {
  readonly maxSizeBytes: number;
  readonly allowedContentTypes: readonly string[];
}

export interface ReplayNonceStore {
  remember(nonce: string, expiresAt: number, now: number): boolean | Promise<boolean>;
  prune?(now: number): void | Promise<void>;
}

export interface ReplayNonceInput {
  readonly nonce: string;
  readonly now?: Date;
  readonly ttlMs: number;
  readonly store: ReplayNonceStore;
}

export interface RateLimitStore {
  get(key: string, now: number): RateLimitRecord | null;
  set(key: string, record: RateLimitRecord): void;
}

export interface RateLimitRecord {
  readonly count: number;
  readonly resetAt: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly key: string;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
  readonly retryAfterMs: number;
}

export interface FixedWindowRateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly store?: RateLimitStore;
  readonly now?: () => Date;
}

export interface FixedWindowRateLimiter {
  check(key: string): RateLimitDecision;
  assert(key: string): RateLimitDecision;
}

export interface RedactSecretsOptions {
  readonly replacement?: string;
  readonly sensitiveKeyPattern?: RegExp;
}

const DEFAULT_SECRET_REPLACEMENT = '[REDACTED]';
const DEFAULT_SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|token|secret|password|passwd|credential|apikey|api_key|accesskey|access_key|privatekey|private_key|signature|signing|sig)$/i;

export function verifySecretToken(candidate: unknown, expected: string): boolean {
  const receivedText = typeof candidate === 'string' ? candidate.trim() : '';
  const expectedText = expected.trim();
  if (!receivedText || !expectedText) return false;

  const received = Buffer.from(receivedText);
  const expectedBuffer = Buffer.from(expectedText);
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

export function assertInternalServiceToken(
  headersOrToken: IncomingHttpHeaders | string | null | undefined,
  expectedToken: string,
  options: ServiceTokenAuthOptions = {}
): string {
  const headerName = options.headerName ?? INTERNAL_API_TOKEN_HEADER;
  const token = typeof headersOrToken === 'string'
    ? headersOrToken
    : headersOrToken
      ? readHeaderValueCaseInsensitive(headersOrToken, headerName)
      : undefined;

  if (!token?.trim()) {
    throw new CoreSecurityError('SERVICE_TOKEN_MISSING', 'Internal service token is required.', 401);
  }
  if (!verifySecretToken(token, expectedToken)) {
    throw new CoreSecurityError('SERVICE_TOKEN_INVALID', 'Internal service token is invalid.', 401);
  }
  return token.trim();
}

export function sanitizeUntrustedIdentityArgs(args: Record<string, unknown>): Record<string, unknown> {
  return stripModelVisibleTrustedIdentityFields(args);
}

export async function assertSafeExternalHttpEndpoint(
  value: string,
  dependencies: ExternalEndpointSafetyDependencies = {}
): Promise<URL> {
  return assertSafeAiProviderEndpoint(value, dependencies);
}

export function assertUploadSecurity(
  input: UploadSecurityInput,
  policy: UploadSecurityPolicy
): UploadSecurityInput {
  const fileName = input.fileName.trim();
  if (!fileName || !isSafeStorageFileName(fileName) || fileName === '.' || fileName === '..' || /[\\/]/.test(fileName) || /[\0\r\n]/.test(fileName)) {
    throw new CoreSecurityError('UNSAFE_UPLOAD_FILE_NAME', 'Upload file name is unsafe.', 400);
  }

  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > policy.maxSizeBytes) {
    throw new CoreSecurityError('UNSAFE_UPLOAD_SIZE', 'Upload file size is outside the allowed range.', 413);
  }

  const contentType = normalizeContentType(input.contentType);
  if (!contentType || !isAllowedContentType(contentType, policy.allowedContentTypes)) {
    throw new CoreSecurityError('UNSAFE_UPLOAD_CONTENT_TYPE', 'Upload content type is not allowed.', 415);
  }

  return { fileName, sizeBytes: input.sizeBytes, contentType };
}

export class MemoryReplayNonceStore implements ReplayNonceStore {
  private readonly entries = new Map<string, number>();

  remember(nonce: string, expiresAt: number, now: number): boolean {
    this.prune(now);
    const existing = this.entries.get(nonce);
    if (existing !== undefined && existing > now) return false;
    this.entries.set(nonce, expiresAt);
    return true;
  }

  prune(now: number): void {
    for (const [nonce, expiresAt] of this.entries.entries()) {
      if (expiresAt <= now) this.entries.delete(nonce);
    }
  }

  size(now = Date.now()): number {
    this.prune(now);
    return this.entries.size;
  }
}

export async function assertFreshReplayNonce(input: ReplayNonceInput): Promise<string> {
  const now = input.now instanceof Date ? input.now.getTime() : Date.now();
  const ttlMs = Math.floor(input.ttlMs);
  const nonce = input.nonce.trim();

  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !/^[A-Za-z0-9._:-]{8,128}$/.test(nonce)) {
    throw new CoreSecurityError('REPLAY_NONCE_INVALID', 'Replay nonce is invalid.', 400);
  }

  await input.store.prune?.(now);
  const accepted = await input.store.remember(nonce, now + ttlMs, now);
  if (!accepted) {
    throw new CoreSecurityError('REPLAY_NONCE_REUSED', 'Replay nonce has already been used.', 409);
  }
  return nonce;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly records = new Map<string, RateLimitRecord>();

  get(key: string, now: number): RateLimitRecord | null {
    const record = this.records.get(key);
    if (!record || record.resetAt <= now) {
      this.records.delete(key);
      return null;
    }
    return record;
  }

  set(key: string, record: RateLimitRecord): void {
    this.records.set(key, record);
  }
}

export function createFixedWindowRateLimiter(options: FixedWindowRateLimiterOptions): FixedWindowRateLimiter {
  const limit = Math.max(1, Math.floor(options.limit));
  const windowMs = Math.max(1, Math.floor(options.windowMs));
  const store = options.store ?? new MemoryRateLimitStore();
  const now = options.now ?? (() => new Date());

  function check(key: string): RateLimitDecision {
    const normalizedKey = key.trim();
    const current = now().getTime();
    const existing = store.get(normalizedKey, current);
    const next = existing
      ? { count: existing.count + 1, resetAt: existing.resetAt }
      : { count: 1, resetAt: current + windowMs };
    store.set(normalizedKey, next);

    const retryAfterMs = Math.max(0, next.resetAt - current);
    return {
      allowed: next.count <= limit,
      key: normalizedKey,
      limit,
      remaining: Math.max(0, limit - next.count),
      resetAt: new Date(next.resetAt),
      retryAfterMs
    };
  }

  function assertAllowed(key: string): RateLimitDecision {
    const decision = check(key);
    if (!decision.allowed) {
      throw new CoreSecurityError('RATE_LIMITED', 'Rate limit exceeded.', 429);
    }
    return decision;
  }

  return { check, assert: assertAllowed };
}

export function redactSecrets<T>(value: T, options: RedactSecretsOptions = {}): T {
  const replacement = options.replacement ?? DEFAULT_SECRET_REPLACEMENT;
  const sensitiveKeyPattern = options.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY_PATTERN;
  const seen = new WeakSet<object>();

  function visit(entry: unknown, keyHint?: string): unknown {
    if (keyHint && sensitiveKeyPattern.test(keyHint)) {
      return replacement;
    }

    if (typeof entry === 'string') {
      return redactUrlSecretQuery(entry, sensitiveKeyPattern, replacement);
    }

    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    if (seen.has(entry)) {
      return '[Circular]';
    }
    seen.add(entry);

    if (Array.isArray(entry)) {
      return entry.map((item) => visit(item));
    }

    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).map(([key, item]) => [key, visit(item, key)])
    );
  }

  return visit(value) as T;
}

function readHeaderValueCaseInsensitive(headers: IncomingHttpHeaders, headerName: string): string | undefined {
  return readHeaderValue(headers, headerName)
    ?? readHeaderValue(headers, headerName.toLowerCase())
    ?? Object.entries(headers).find(([key]) => key.toLowerCase() === headerName.toLowerCase())?.[1]?.toString();
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  const raw = value?.split(';')[0]?.trim().toLowerCase();
  return raw || undefined;
}

function isAllowedContentType(contentType: string, allowedContentTypes: readonly string[]): boolean {
  return allowedContentTypes.some((allowed) => {
    const normalized = normalizeContentType(allowed);
    if (!normalized) return false;
    if (normalized.endsWith('/*')) {
      return contentType.startsWith(`${normalized.slice(0, -1)}`);
    }
    return contentType === normalized;
  });
}

function redactUrlSecretQuery(value: string, sensitiveKeyPattern: RegExp, replacement: string): string {
  let url: URL;
  try {
    url = new URL(value, value.startsWith('/') ? 'https://afc.local' : undefined);
  } catch {
    return value;
  }

  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (sensitiveKeyPattern.test(key)) {
      url.searchParams.set(key, replacement);
      changed = true;
    }
  }

  if (!changed) return value;
  if (value.startsWith('/')) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return url.toString();
}
