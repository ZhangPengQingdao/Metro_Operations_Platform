import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCoreConfig,
  maskSecret,
  parseFeatureFlags,
  secretFrom,
  sourceFromEnvironment,
  sourceFromDefault
} from '../src/core/config/index.ts';

const legacyEnv = {
  PORT: 3001,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/afc',
  SESSION_SECRET: 'session-secret-with-enough-length',
  SESSION_MAX_AGE_DAYS: 180,
  INTERNAL_API_TOKEN: 'internal-api-token',
  STATS_READ_TOKEN: 'stats-read-token-with-at-least-thirty-two-characters',
  STATS_READ_WORKGROUP_ID: '35f1282a-1b64-4608-9b2b-6e55578f063f',
  COOKIE_SECURE: false,
  CORS_ORIGIN: 'http://localhost:5173',
  TRUSTED_PROXY_CIDRS: ['127.0.0.1/32'],
  PUBLIC_BASE_URL: 'https://afc.example.com',
  UPLOAD_DIR: './runtime/uploads',
  WECOM_AIBOT_GATEWAY_URL: 'https://wecom.example.com',
  MCP_ACTOR_SIGNING_SECRET: 'actor-signing-secret',
  AFC_MCP_URL: 'https://mcp.example.com',
  AFC_MCP_API_KEY: 'mcp-api-key',
  AI_PROVIDER_ENCRYPTION_KEY: '12345678901234567890123456789012',
  HAZARD_AI_WEBHOOK_URL: 'https://hazard.example.com/webhook',
  HAZARD_AI_WEBHOOK_TOKEN: 'hazard-token',
  HAZARD_AI_WEBHOOK_TIMEOUT_MS: 30_000,
  HAZARD_EMBEDDING_URL: 'https://embedding.example.com',
  HAZARD_EMBEDDING_API_KEY: 'embedding-token',
  HAZARD_EMBEDDING_MODEL: 'text-embedding',
  HAZARD_EMBEDDING_TIMEOUT_MS: 15_000,
  HAZARD_EMBEDDING_CONCURRENCY: 3,
  HAZARD_PORTAL_TOKEN_TTL_HOURS: 12,
  HAZARD_CASE_REFERENCE_LIMIT: 4,
  HAZARD_CASE_MIN_SIMILARITY: 0.45,
  HAZARD_LOCAL_CASE_MIN_SIMILARITY: 0.2,
  RELEASE_VERSION: 'test'
} satisfies Parameters<typeof buildCoreConfig>[0];

test('Core Config groups legacy environment values with source metadata', () => {
  const config = buildCoreConfig(legacyEnv, {
    sourceMap: {
      PORT: sourceFromDefault('PORT')
    }
  });

  assert.equal(config.runtime.nodeEnv.value, 'test');
  assert.equal(config.runtime.port.value, 3001);
  assert.deepEqual(config.runtime.port.source, { kind: 'default', name: 'PORT' });
  assert.equal(config.database.url.reveal(), 'postgres://localhost/afc');
  assert.equal(String(config.database.url).includes('postgres://localhost/afc'), false);
  assert.equal(config.http.publicBaseUrl.value, 'https://afc.example.com');
  assert.equal(config.storage.uploadDir.value, './runtime/uploads');
  assert.equal(config.integrations.afcMcpUrl.value, 'https://mcp.example.com');
  assert.deepEqual(Object.keys(config).sort(), [
    'database',
    'features',
    'http',
    'integrations',
    'runtime',
    'session',
    'storage'
  ]);
});

test('Core Config secrets expose only masked values unless explicitly revealed', () => {
  const source = sourceFromEnvironment('TEST_SECRET');
  const secret = secretFrom('abcdefghijklmnopqrstuvwxyz', source);

  assert.equal(secret.isConfigured, true);
  assert.equal(secret.reveal(), 'abcdefghijklmnopqrstuvwxyz');
  assert.equal(secret.toString(), 'ab…yz (26)');
  assert.equal(JSON.stringify({ secret }), '{"secret":"ab…yz (26)"}');
  assert.equal(String(secret).includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('Core Config masks unset and short secrets without leaking raw values', () => {
  assert.equal(maskSecret(undefined), 'unset');
  assert.equal(maskSecret('short'), 'configured');
});

test('Core Config parses feature flags into a stable normalized registry', () => {
  const config = buildCoreConfig(legacyEnv, {
    featureFlags: 'New_App, mcp-tools=off, wecom.docs=enabled'
  });

  assert.equal(config.features.has('new_app'), true);
  assert.equal(config.features.isEnabled('NEW_APP'), true);
  assert.equal(config.features.isEnabled('mcp-tools'), false);
  assert.equal(config.features.get('wecom.docs').enabled, true);
  assert.equal(config.features.get('missing').enabled, false);
  assert.deepEqual(parseFeatureFlags('A=1,b=0,c'), { a: true, b: false, c: true });
});

test('Core Config rejects ambiguous feature flag boolean values', () => {
  assert.throws(() => parseFeatureFlags('new-flow=maybe'), /Invalid feature flag boolean value/);
});
