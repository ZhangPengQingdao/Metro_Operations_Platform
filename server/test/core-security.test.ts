import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertInternalServiceToken,
  assertFreshReplayNonce,
  assertSafeExternalHttpEndpoint,
  assertUploadSecurity,
  CoreSecurityError,
  createFixedWindowRateLimiter,
  MemoryReplayNonceStore,
  sanitizeUntrustedIdentityArgs,
  verifySecretToken
} from '../src/core/security/index.ts';
import { INTERNAL_API_TOKEN_HEADER } from '../src/core/identity/index.ts';
import { sanitizeMcpToolSchema, toOpenAiTools, type McpToolDefinition } from '../src/core/integrations/mcp/index.ts';
import {
  assertNoTrustedIdentityLeak,
  assertSecretRedaction,
  assertSecurityError,
  coreSecurityAttackFixtures
} from './helpers/core-security-kit.ts';

test('Core Security strips forged identity fields before MCP/OpenAI tool exposure', () => {
  const sanitizedArgs = sanitizeUntrustedIdentityArgs(coreSecurityAttackFixtures.forgedIdentityArgs);
  assert.deepEqual(sanitizedArgs, { title: '测试待办' });
  assertNoTrustedIdentityLeak(sanitizedArgs);

  const tools: McpToolDefinition[] = [{
    name: 'afc_create_todo',
    description: '创建待办',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        actor_token: { type: 'string' },
        actor_wecom_userid: { type: 'string' },
        actor_name: { type: 'string' }
      },
      required: ['title', 'actor_token', 'actor_wecom_userid', 'actor_name']
    }
  }];

  const sanitizedSchema = sanitizeMcpToolSchema(tools[0].inputSchema);
  assert.deepEqual(sanitizedSchema.required, ['title']);
  const exposedTools = toOpenAiTools(tools, {
    allowedToolNames: new Set(['afc_create_todo'])
  });
  assert.deepEqual(exposedTools[0].function.parameters.required, ['title']);
  assertNoTrustedIdentityLeak(exposedTools);
});

test('Core Security rejects SSRF-prone external endpoints and permits verified public endpoints', async () => {
  await assert.rejects(
    assertSafeExternalHttpEndpoint('https://private.example.com/v1/chat/completions', {
      lookupAddresses: async () => [{ address: '10.2.3.4', family: 4 }]
    }),
    /内网或保留地址/
  );

  assert.equal(
    (await assertSafeExternalHttpEndpoint('https://api.example.com/v1/chat/completions', {
      lookupAddresses: async () => [{ address: '104.21.53.240', family: 4 }]
    })).hostname,
    'api.example.com'
  );
});

test('Core Security validates uploads by safe file name, size, and content type', async () => {
  const policy = {
    maxSizeBytes: 10 * 1024 * 1024,
    allowedContentTypes: ['image/jpeg', 'image/png', 'audio/*']
  };

  assert.deepEqual(
    assertUploadSecurity({ fileName: 'photo.jpg', sizeBytes: 1024, contentType: 'image/jpeg; charset=binary' }, policy),
    { fileName: 'photo.jpg', sizeBytes: 1024, contentType: 'image/jpeg' }
  );
  assert.deepEqual(
    assertUploadSecurity({ fileName: 'voice.webm', sizeBytes: 4096, contentType: 'audio/webm' }, policy),
    { fileName: 'voice.webm', sizeBytes: 4096, contentType: 'audio/webm' }
  );

  await assertSecurityError(
    () => assertUploadSecurity(coreSecurityAttackFixtures.unsafeUploads[0], policy),
    'UNSAFE_UPLOAD_FILE_NAME'
  );
  await assertSecurityError(
    () => assertUploadSecurity(coreSecurityAttackFixtures.unsafeUploads[1], policy),
    'UNSAFE_UPLOAD_FILE_NAME'
  );
  await assertSecurityError(
    () => assertUploadSecurity(coreSecurityAttackFixtures.unsafeUploads[2], policy),
    'UNSAFE_UPLOAD_CONTENT_TYPE'
  );
  await assertSecurityError(
    () => assertUploadSecurity(coreSecurityAttackFixtures.unsafeUploads[3], policy),
    'UNSAFE_UPLOAD_SIZE'
  );
});

test('Core Security blocks replayed nonces while allowing reuse after expiry', async () => {
  const store = new MemoryReplayNonceStore();
  const nonce = 'nonce-20260830-001';
  const firstSeen = new Date('2026-08-30T03:00:00.000Z');

  assert.equal(await assertFreshReplayNonce({ nonce, now: firstSeen, ttlMs: 60_000, store }), nonce);
  await assertSecurityError(
    () => assertFreshReplayNonce({ nonce, now: firstSeen, ttlMs: 60_000, store }),
    'REPLAY_NONCE_REUSED'
  );

  const afterExpiry = new Date(firstSeen.getTime() + 60_001);
  assert.equal(await assertFreshReplayNonce({ nonce, now: afterExpiry, ttlMs: 60_000, store }), nonce);
  assert.equal(store.size(afterExpiry.getTime()), 1);
});

test('Core Security rate limiter returns deterministic decisions and normalized errors', () => {
  let current = new Date('2026-08-30T04:00:00.000Z');
  const limiter = createFixedWindowRateLimiter({
    limit: 2,
    windowMs: 1000,
    now: () => current
  });

  assert.deepEqual(
    pickRateDecision(limiter.assert('actor:5359')),
    { allowed: true, remaining: 1, retryAfterMs: 1000 }
  );
  assert.deepEqual(
    pickRateDecision(limiter.assert('actor:5359')),
    { allowed: true, remaining: 0, retryAfterMs: 1000 }
  );
  assert.throws(
    () => limiter.assert('actor:5359'),
    (error) => {
      assert.ok(error instanceof CoreSecurityError);
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.statusCode, 429);
      return true;
    }
  );

  current = new Date('2026-08-30T04:00:01.001Z');
  assert.deepEqual(
    pickRateDecision(limiter.assert('actor:5359')),
    { allowed: true, remaining: 1, retryAfterMs: 1000 }
  );
});

test('Core Security redacts secret-bearing keys and signed URL query values', () => {
  assertSecretRedaction(coreSecurityAttackFixtures.secretPayload);
});

test('Core Security verifies service-to-service tokens without accepting missing or forged values', () => {
  const { expected, valid, invalid } = coreSecurityAttackFixtures.serviceAuth;

  assert.equal(verifySecretToken(valid, expected), true);
  assert.equal(verifySecretToken(invalid, expected), false);
  assert.equal(
    assertInternalServiceToken({ [INTERNAL_API_TOKEN_HEADER]: valid }, expected),
    valid
  );
  assert.equal(
    assertInternalServiceToken({ 'X-Internal-Api-Token': valid }, expected),
    valid
  );

  assert.throws(
    () => assertInternalServiceToken({}, expected),
    (error) => {
      assert.ok(error instanceof CoreSecurityError);
      assert.equal(error.code, 'SERVICE_TOKEN_MISSING');
      return true;
    }
  );
  assert.throws(
    () => assertInternalServiceToken(invalid, expected),
    (error) => {
      assert.ok(error instanceof CoreSecurityError);
      assert.equal(error.code, 'SERVICE_TOKEN_INVALID');
      return true;
    }
  );
});

function pickRateDecision(decision: { allowed: boolean; remaining: number; retryAfterMs: number }) {
  return {
    allowed: decision.allowed,
    remaining: decision.remaining,
    retryAfterMs: decision.retryAfterMs
  };
}
