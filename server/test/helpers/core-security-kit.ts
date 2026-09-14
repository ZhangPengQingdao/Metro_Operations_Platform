import assert from 'node:assert/strict';

import { CoreSecurityError, redactSecrets } from '../../src/core/security/index.ts';

export const coreSecurityAttackFixtures = {
  forgedIdentityArgs: {
    title: '测试待办',
    actor_token: 'forged-token',
    actor_wecom_userid: 'forged-wecom-user',
    actor_name: '伪造身份',
    userId: 'admin',
    role: 'admin',
    isAdmin: true
  },
  privateEndpoints: [
    {
      endpoint: 'https://private.example.com/v1/chat/completions',
      resolvedAddresses: [{ address: '192.168.1.20', family: 4 }]
    },
    {
      endpoint: 'https://localhost/v1/chat/completions',
      resolvedAddresses: [{ address: '127.0.0.1', family: 4 }]
    }
  ],
  unsafeUploads: [
    { fileName: '../secret.env', sizeBytes: 100, contentType: 'image/jpeg' },
    { fileName: '..\\secret.env', sizeBytes: 100, contentType: 'image/jpeg' },
    { fileName: 'payload.php', sizeBytes: 100, contentType: 'application/x-php' },
    { fileName: 'too-large.jpg', sizeBytes: 20 * 1024 * 1024, contentType: 'image/jpeg' }
  ],
  secretPayload: {
    Authorization: 'Bearer live-token',
    api_key: 'sk-live-secret',
    nested: {
      password: 'database-password',
      callbackUrl: 'https://ops.example.com/api/files/public/photos/a.jpg?sig=secret-signature'
    }
  },
  serviceAuth: {
    expected: 'internal-service-token',
    valid: 'internal-service-token',
    invalid: 'wrong-service-token'
  }
} as const;

export async function assertSecurityError(
  action: () => unknown | Promise<unknown>,
  code: string
): Promise<void> {
  await assert.rejects(
    async () => action(),
    (error) => {
      assert.ok(error instanceof CoreSecurityError);
      assert.equal(error.code, code);
      return true;
    }
  );
}

export function assertNoTrustedIdentityLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('forged-token'), false);
  assert.equal(serialized.includes('forged-wecom-user'), false);
  assert.equal(serialized.includes('伪造身份'), false);
  assert.equal(serialized.includes('"role"'), false);
  assert.equal(serialized.includes('"isAdmin"'), false);
}

export function assertSecretRedaction(value: unknown): void {
  const redacted = redactSecrets(value);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('live-token'), false);
  assert.equal(serialized.includes('sk-live-secret'), false);
  assert.equal(serialized.includes('database-password'), false);
  assert.equal(serialized.includes('secret-signature'), false);
  assert.equal(serialized.includes('[REDACTED]'), true);
}
