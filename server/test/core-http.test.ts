import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import {
  createErrorResponseEnvelope,
  createFastifyRuntimeOptions,
  createHttpError,
  createRequestId,
  normalizeHttpError,
  registerCoreErrorHandler
} from '../src/core/http/index.ts';
import { buildCoreConfig } from '../src/core/config/index.ts';

const legacyEnv = {
  PORT: 3001,
  NODE_ENV: 'test',
  DATABASE_URL: undefined,
  SESSION_SECRET: 'session-secret-with-enough-length',
  SESSION_MAX_AGE_DAYS: 180,
  INTERNAL_API_TOKEN: undefined,
  STATS_READ_TOKEN: undefined,
  STATS_READ_WORKGROUP_ID: undefined,
  COOKIE_SECURE: false,
  CORS_ORIGIN: 'http://localhost:5173',
  TRUSTED_PROXY_CIDRS: ['127.0.0.1/32'],
  PUBLIC_BASE_URL: undefined,
  UPLOAD_DIR: './runtime/uploads',
  WECOM_AIBOT_GATEWAY_URL: undefined,
  MCP_ACTOR_SIGNING_SECRET: undefined,
  AFC_MCP_URL: undefined,
  AFC_MCP_API_KEY: undefined,
  AI_PROVIDER_ENCRYPTION_KEY: undefined,
  HAZARD_AI_WEBHOOK_URL: undefined,
  HAZARD_AI_WEBHOOK_TOKEN: undefined,
  HAZARD_AI_WEBHOOK_TIMEOUT_MS: 30_000,
  HAZARD_EMBEDDING_URL: undefined,
  HAZARD_EMBEDDING_API_KEY: undefined,
  HAZARD_EMBEDDING_MODEL: undefined,
  HAZARD_EMBEDDING_TIMEOUT_MS: 15_000,
  HAZARD_EMBEDDING_CONCURRENCY: 3,
  HAZARD_PORTAL_TOKEN_TTL_HOURS: 12,
  HAZARD_CASE_REFERENCE_LIMIT: 4,
  HAZARD_CASE_MIN_SIMILARITY: 0.45,
  HAZARD_LOCAL_CASE_MIN_SIMILARITY: 0.2,
  RELEASE_VERSION: 'test'
} satisfies Parameters<typeof buildCoreConfig>[0];

test('Core HTTP creates Fastify runtime options from Core Config', () => {
  const options = createFastifyRuntimeOptions(buildCoreConfig(legacyEnv));

  assert.equal(options.logger, false);
  assert.deepEqual(options.trustProxy, ['127.0.0.1/32']);
  assert.match(options.genReqId?.({} as Parameters<NonNullable<typeof options.genReqId>>[0]) ?? '', /^req_[0-9a-f-]{36}$/);
});

test('Core HTTP request ids are prefixed UUIDs', () => {
  assert.match(createRequestId('test'), /^test_[0-9a-f-]{36}$/);
});

test('Core HTTP normalizes errors into the existing response envelope', () => {
  const normalized = normalizeHttpError(createHttpError(403, 'FORBIDDEN', '拒绝访问'));

  assert.deepEqual(normalized, {
    statusCode: 403,
    code: 'FORBIDDEN',
    message: '拒绝访问'
  });
  assert.deepEqual(createErrorResponseEnvelope(normalized), {
    success: false,
    error: {
      code: 'FORBIDDEN',
      message: '拒绝访问'
    }
  });
});

test('Core HTTP hides 5xx implementation codes behind INTERNAL_ERROR', () => {
  const error = Object.assign(new Error('database down'), {
    statusCode: 503,
    code: 'PG_CONNECTION_FAILED'
  });

  assert.deepEqual(normalizeHttpError(error), {
    statusCode: 503,
    code: 'INTERNAL_ERROR',
    message: 'database down'
  });
});

test('Core HTTP error handler preserves current API error contract', async () => {
  const app = Fastify({ logger: false });
  await registerCoreErrorHandler(app);
  app.get('/forbidden', async () => {
    throw createHttpError(403, 'FORBIDDEN', '拒绝访问');
  });

  try {
    const response = await app.inject('/forbidden');

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), {
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: '拒绝访问'
      }
    });
  } finally {
    await app.close();
  }
});
