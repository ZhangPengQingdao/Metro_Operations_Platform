import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedOrigin, resolvePlatformSites } from '../src/core/http/sites.ts';

test('admin site is optional and must be a clean HTTPS origin (HTTP only on loopback)', () => {
  assert.deepEqual(resolvePlatformSites('https://ops.example', undefined), { employee: 'https://ops.example', admin: 'https://ops.example' });
  assert.deepEqual(resolvePlatformSites('https://ops.example', 'https://admin.ops.example'), { employee: 'https://ops.example', admin: 'https://admin.ops.example' });
  assert.deepEqual(resolvePlatformSites('http://127.0.0.1:3100', 'http://localhost:3100/'), { employee: 'http://127.0.0.1:3100', admin: 'http://localhost:3100' });
  for (const bad of ['http://admin.ops.example', 'https://admin.ops.example/console', 'https://user:pw@admin.ops.example']) assert.throws(() => resolvePlatformSites('https://ops.example', bad), /ADMIN_PUBLIC_BASE_URL_INVALID/);
});

test('writes to /api/admin must come from the admin site, everything else from the employee site', () => {
  const sites = { origin: 'https://ops.example', adminOrigin: 'https://admin.ops.example' };
  assert.equal(expectedOrigin('/api/admin/app-submissions/1/review', sites), 'https://admin.ops.example');
  assert.equal(expectedOrigin('/api/admin', sites), 'https://admin.ops.example');
  assert.equal(expectedOrigin('/api/employee/app-submissions', sites), 'https://ops.example');
  assert.equal(expectedOrigin('/api/administrators', sites), 'https://ops.example');
  assert.equal(expectedOrigin('/api/admin/x', { origin: 'https://ops.example' }), 'https://ops.example');
});
