import crypto from 'node:crypto';
import { env } from '../../../config/env.js';
import {
  AiProviderTransportError,
  assertSafeAiProviderEndpoint,
  deriveAiProviderModelsEndpoint,
  validateAiProviderEndpoint,
  type ExternalEndpointSafetyDependencies
} from './index.js';
import { getDatabasePool,type QueryableClient } from '../../database/index.js';

const AI_RUNTIME_CONFIG_KEY = 'ai_runtime_global';
const DEFAULT_TIMEOUT_MS = 120000;

interface EncryptedSecret {
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

interface StoredAiRuntimeConfig {
  version: 1;
  external: {
    endpoint: string;
    model: string;
    apiKey?: EncryptedSecret;
    apiKeyMask: string;
    toolsEnabled: boolean;
    timeoutMs: number;
    reasoningEffort: 'auto' | 'low' | 'medium' | 'high';
  };
}

export interface PublicAiRuntimeConfig {
  external: {
    endpoint: string;
    model: string;
    api_key_mask: string;
    has_api_key: boolean;
    timeout_ms: number;
    reasoning_effort: 'auto' | 'low' | 'medium' | 'high';
    configured: boolean;
  };
}

export interface AiRuntimeUpdateInput {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high';
}

export interface ExternalProviderRuntimeConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  toolsEnabled: boolean;
  timeoutMs: number;
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high';
}

export class AiRuntimeConfigError extends Error {
  code: string;

  constructor(message: string, code = 'AI_RUNTIME_CONFIG_INVALID') {
    super(message);
    this.name = 'AiRuntimeConfigError';
    this.code = code;
  }
}

const defaultStoredConfig = (): StoredAiRuntimeConfig => ({
  version: 1,
  external: {
    endpoint: '',
    model: '',
    apiKeyMask: '',
    toolsEnabled: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    reasoningEffort: 'auto'
  }
});

function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EncryptedSecret>;
  return candidate.algorithm === 'aes-256-gcm'
    && typeof candidate.iv === 'string'
    && typeof candidate.tag === 'string'
    && typeof candidate.ciphertext === 'string';
}

function normalizeStoredConfig(value: unknown): StoredAiRuntimeConfig {
  if (!value || typeof value !== 'object') return defaultStoredConfig();
  const candidate = value as Record<string, unknown>;
  const external = candidate.external && typeof candidate.external === 'object'
    ? candidate.external as Record<string, unknown>
    : {};
  const timeoutMs = Number(external.timeoutMs);

  return {
    version: 1,
    external: {
      endpoint: typeof external.endpoint === 'string' ? external.endpoint : '',
      model: typeof external.model === 'string' ? external.model : '',
      ...(isEncryptedSecret(external.apiKey) ? { apiKey: external.apiKey } : {}),
      apiKeyMask: typeof external.apiKeyMask === 'string' ? external.apiKeyMask : '',
      toolsEnabled: external.toolsEnabled === true,
      timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 5000 && timeoutMs <= 180000
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS,
      reasoningEffort: ['low', 'medium', 'high'].includes(String(external.reasoningEffort))
        ? external.reasoningEffort as 'low' | 'medium' | 'high'
        : 'auto'
    }
  };
}

async function withConfigClient<T>(work:(db:QueryableClient)=>Promise<T>):Promise<T> {
 const pool=getDatabasePool();
 if(!pool)throw new AiRuntimeConfigError('数据库尚未配置','DATABASE_NOT_CONFIGURED');
 const db=await pool.connect();try{return await work(db);}finally{db.release();}
}
async function readStoredConfig(db?:QueryableClient):Promise<StoredAiRuntimeConfig> {
 if(!db)return withConfigClient(client=>readStoredConfig(client));
 const result=await db.query('SELECT value FROM system_configs WHERE key=$1 LIMIT 1',[AI_RUNTIME_CONFIG_KEY]) as {rows:{value:unknown}[]};
 return normalizeStoredConfig(result.rows[0]?.value);
}

function parseEncryptionKey(value = env.AI_PROVIDER_ENCRYPTION_KEY): Buffer {
  const normalized = value?.trim() || '';
  const key = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64');

  if (key.length !== 32) {
    throw new AiRuntimeConfigError(
      '外部模型密钥加密主密钥未配置或格式不正确',
      'AI_PROVIDER_ENCRYPTION_KEY_INVALID'
    );
  }
  return key;
}

export function encryptApiKey(apiKey: string, encryptionKey?: string): EncryptedSecret {
  const key = parseEncryptionKey(encryptionKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);

  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

export function decryptApiKey(secret: EncryptedSecret, encryptionKey?: string): string {
  try {
    const key = parseEncryptionKey(encryptionKey);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(secret.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof AiRuntimeConfigError) throw error;
    throw new AiRuntimeConfigError('已保存的外部模型 API Key 无法解密', 'AI_PROVIDER_KEY_DECRYPT_FAILED');
  }
}

export function maskApiKey(apiKey: string): string {
  const suffix = apiKey.slice(-4);
  return suffix ? `••••••••${suffix}` : '';
}

function toAiRuntimeConfigError(error: unknown): unknown {
  return error instanceof AiProviderTransportError
    ? new AiRuntimeConfigError(error.message, error.code)
    : error;
}

export function validateExternalEndpoint(value: string): URL {
  try {
    return validateAiProviderEndpoint(value);
  } catch (error) {
    throw toAiRuntimeConfigError(error);
  }
}

export async function assertSafeExternalEndpoint(
  value: string,
  dependencies: ExternalEndpointSafetyDependencies = {}
): Promise<URL> {
  try {
    return await assertSafeAiProviderEndpoint(value, dependencies);
  } catch (error) {
    throw toAiRuntimeConfigError(error);
  }
}

export function deriveModelsEndpoint(value: string): URL {
  try {
    return deriveAiProviderModelsEndpoint(value);
  } catch (error) {
    throw toAiRuntimeConfigError(error);
  }
}

function assertExternalFields(endpoint: string, model: string, hasApiKey: boolean) {
  if (!endpoint) throw new AiRuntimeConfigError('请填写在线 API 请求地址');
  if (!model) throw new AiRuntimeConfigError('请填写默认模型 ID');
  if (!hasApiKey) throw new AiRuntimeConfigError('请填写在线 API Key');
}

function publicConfig(stored:StoredAiRuntimeConfig):PublicAiRuntimeConfig {
  const hasApiKey = Boolean(stored.external.apiKey);
  return {
    external: {
      endpoint: stored.external.endpoint,
      model: stored.external.model,
      api_key_mask: stored.external.apiKeyMask,
      has_api_key: hasApiKey,
      timeout_ms: stored.external.timeoutMs,
      reasoning_effort: stored.external.reasoningEffort,
      configured: Boolean(stored.external.endpoint && stored.external.model && hasApiKey)
    }
  };
}

export async function getPublicAiRuntimeConfig():Promise<PublicAiRuntimeConfig>{return publicConfig(await readStoredConfig());}

export async function saveAiRuntimeConfig(input: AiRuntimeUpdateInput, audit?:(db:QueryableClient)=>Promise<void>): Promise<PublicAiRuntimeConfig> {
 return withConfigClient(async db=>{
 await db.query('BEGIN');
 try {
 await db.query('SELECT pg_advisory_xact_lock(6013015)');
 const existing = await readStoredConfig(db);
  const endpoint = input.endpoint.trim();
  const model = input.model.trim();
  if(existing.external.endpoint && endpoint!==existing.external.endpoint && !input.apiKey?.trim())throw new AiRuntimeConfigError('更换地址后请重新填写 API Key','AI_PROVIDER_NEW_ENDPOINT_KEY_REQUIRED');
  const nextSecret = input.apiKey?.trim()
    ? encryptApiKey(input.apiKey.trim())
    : existing.external.apiKey;

  if (endpoint) validateExternalEndpoint(endpoint);
  assertExternalFields(endpoint, model, Boolean(nextSecret));
  parseEncryptionKey();
  await assertSafeExternalEndpoint(endpoint);

  const next: StoredAiRuntimeConfig = {
    version: 1,
    external: {
      endpoint,
      model,
      ...(nextSecret ? { apiKey: nextSecret } : {}),
      apiKeyMask: input.apiKey?.trim()
        ? maskApiKey(input.apiKey.trim())
        : existing.external.apiKeyMask,
      toolsEnabled: true,
      timeoutMs: input.timeoutMs,
      reasoningEffort: input.reasoningEffort
    }
  };
  const result=await db.query('SELECT id FROM system_configs WHERE key=$1 LIMIT 1',[AI_RUNTIME_CONFIG_KEY]) as {rows:{id:string}[]};
  if(result.rows.length)await db.query('UPDATE system_configs SET value=$1,description=$2,updated_at=NOW() WHERE key=$3',[JSON.stringify(next),'在线模型配置',AI_RUNTIME_CONFIG_KEY]);
  else await db.query('INSERT INTO system_configs (key,value,description,created_at,updated_at) VALUES ($1,$2,$3,NOW(),NOW())',[AI_RUNTIME_CONFIG_KEY,JSON.stringify(next),'在线模型配置']);
  await audit?.(db);
  await db.query('COMMIT');
  return publicConfig(next);
 } catch(error){await db.query('ROLLBACK');throw error;}
 });
}

export async function resolveExternalProviderConfig(
  overrides: Partial<Pick<AiRuntimeUpdateInput, 'endpoint' | 'model' | 'apiKey' | 'timeoutMs' | 'reasoningEffort'>> = {}
): Promise<ExternalProviderRuntimeConfig> {
  const stored = await readStoredConfig();
  const connection = await resolveExternalConnectionConfig(overrides);
  const model = overrides.model?.trim() || stored.external.model;
  assertExternalFields(connection.endpoint, model, Boolean(connection.apiKey));

  return {
    endpoint: connection.endpoint,
    model,
    apiKey: connection.apiKey,
    toolsEnabled: true,
    timeoutMs: connection.timeoutMs,
    reasoningEffort: overrides.reasoningEffort ?? stored.external.reasoningEffort
  };
}

export async function resolveExternalConnectionConfig(
  overrides: Partial<Pick<AiRuntimeUpdateInput, 'endpoint' | 'apiKey' | 'timeoutMs'>> = {}
): Promise<{ endpoint: string; apiKey: string; timeoutMs: number }> {
  const stored = await readStoredConfig();
  const endpoint = overrides.endpoint?.trim() || stored.external.endpoint;
  if(overrides.endpoint?.trim() && overrides.endpoint.trim()!==stored.external.endpoint && !overrides.apiKey?.trim())throw new AiRuntimeConfigError('更换地址后请重新填写 API Key','AI_PROVIDER_NEW_ENDPOINT_KEY_REQUIRED');
  const apiKey = overrides.apiKey?.trim()
    || (stored.external.apiKey ? decryptApiKey(stored.external.apiKey) : '');
  assertExternalFields(endpoint, 'models', Boolean(apiKey));
  await assertSafeExternalEndpoint(endpoint);
  return {
    endpoint,
    apiKey,
    timeoutMs: overrides.timeoutMs ?? stored.external.timeoutMs
  };
}

export async function getActiveAiRuntimeConfig(): Promise<{
  external: ExternalProviderRuntimeConfig;
}> {
  return {
    external: await resolveExternalProviderConfig()
  };
}
