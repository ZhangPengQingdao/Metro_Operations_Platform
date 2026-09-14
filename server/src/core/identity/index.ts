import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const INTERNAL_API_TOKEN_HEADER = 'x-internal-api-token';
export const ACTOR_WECOM_USER_ID_HEADER = 'x-actor-wecom-userid';
export const ACTOR_NAME_HEADER = 'x-actor-name';
export const ACTOR_NAME_B64_HEADER = 'x-actor-name-b64';

export type TrustedActorSource = 'session' | 'wecom' | 'name' | 'service' | 'mcp_actor_token';

export interface TrustedActorIdentityInput {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly employeeId?: string | null;
  readonly wecomUserId?: string | null;
}

export interface TrustedActorIdentity {
  readonly source: TrustedActorSource;
  readonly userId?: string;
  readonly name?: string;
  readonly employeeId?: string;
  readonly wecomUserId?: string;
}

export interface SignedActorIdentity {
  readonly actor_wecom_userid?: string;
  readonly actor_name?: string;
}

export interface SignedActorTokenOptions {
  readonly now?: Date;
  readonly expiresInSeconds?: number;
}

export const MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS = [
  'actor_token',
  'actor_wecom_userid',
  'actor_name',
  'actor_name_b64',
  'userId',
  'user_id',
  'role',
  'workgroupId',
  'workgroup_id',
  'isAdmin'
] as const;

type TrustedIdentityField = typeof MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS[number];

export function createTrustedActorIdentity(
  input: TrustedActorIdentityInput,
  source: TrustedActorSource
): TrustedActorIdentity {
  return removeUndefinedValues({
    source,
    userId: normalizeOptional(input.id),
    name: normalizeOptional(input.name),
    employeeId: normalizeOptional(input.employeeId),
    wecomUserId: normalizeOptional(input.wecomUserId)
  });
}

export function readHeaderValue(headers: IncomingHttpHeaders, headerName: string): string | undefined {
  const header = headers[headerName];

  if (Array.isArray(header)) {
    return header[0];
  }

  return typeof header === 'string' ? header : undefined;
}

export function readActorNameFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  const plain = readHeaderValue(headers, ACTOR_NAME_HEADER)?.trim();
  if (plain) {
    return plain;
  }

  const encoded = readHeaderValue(headers, ACTOR_NAME_B64_HEADER)?.trim();
  if (!encoded) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
    return decoded || undefined;
  } catch {
    return undefined;
  }
}

export function readActorWecomUserIdFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  return readHeaderValue(headers, ACTOR_WECOM_USER_ID_HEADER)?.trim() || undefined;
}

export function stripModelVisibleTrustedIdentityFields(
  args: Record<string, unknown>
): Record<string, unknown> {
  const trustedFields = new Set<TrustedIdentityField>(MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS);
  return Object.fromEntries(Object.entries(args).filter(([key]) => !trustedFields.has(key as TrustedIdentityField)));
}

export function createSignedActorToken(
  identity: SignedActorIdentity,
  secret: string,
  options: SignedActorTokenOptions = {}
): string {
  const now = options.now instanceof Date ? options.now : new Date();
  const expiresInSeconds = Number.isFinite(Number(options.expiresInSeconds))
    ? Math.max(1, Math.floor(Number(options.expiresInSeconds)))
    : 300;
  const payload = {
    v: 1,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(now.getTime() / 1000) + expiresInSeconds,
    ...(identity.actor_wecom_userid?.trim() ? { actor_wecom_userid: identity.actor_wecom_userid.trim() } : {}),
    ...(identity.actor_name?.trim() ? { actor_name: identity.actor_name.trim() } : {})
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
