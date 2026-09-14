import {readFileSync} from 'node:fs';
import { config } from 'dotenv';
import { z } from 'zod';

if(process.env.NODE_ENV!=='test')config();

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }

    throw new Error(`Invalid boolean value: ${value}`);
  });

const optionalUrlFromEnv = z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  z.string().url().optional()
);

const optionalSecretFromEnv = (minimumLength: number) => z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  z.string().min(minimumLength).optional()
);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3101),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(8).default('replace-this-session-secret'),
  SESSION_MAX_AGE_DAYS: z.coerce.number().int().positive().default(180),
  INTERNAL_API_TOKEN: z.string().min(8).optional(),
  COOKIE_SECURE: booleanFromEnv.default(true),
  CORS_ORIGIN: z.string().min(1).default('http://127.0.0.1:3100'),
  TRUSTED_PROXY_CIDRS: z.string().default('').transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean)),
  PUBLIC_BASE_URL: z.string().url().optional(),
  UPLOAD_DIR: z.string().min(1).default('./runtime/uploads'),
  WECOM_AIBOT_GATEWAY_URL: optionalUrlFromEnv,
  MCP_ACTOR_SIGNING_SECRET: optionalSecretFromEnv(16),
  AFC_MCP_URL: optionalUrlFromEnv,
  AFC_MCP_API_KEY: optionalSecretFromEnv(8),
  AI_PROVIDER_ENCRYPTION_KEY: optionalSecretFromEnv(32),
  RELEASE_VERSION: z.string().min(1).default((JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')) as {version:string}).version)
});

const rawEnv = {
  ...process.env
};

if (rawEnv.COOKIE_SECURE === undefined) {
  rawEnv.COOKIE_SECURE = rawEnv.NODE_ENV === 'production' ? 'true' : 'false';
}

const parsedEnv = envSchema.safeParse(rawEnv);

if (!parsedEnv.success) {
  throw new Error(`Invalid server environment variables: ${parsedEnv.error.message}`);
}

export const env = parsedEnv.data;
