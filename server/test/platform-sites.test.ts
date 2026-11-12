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

test('concurrent navigations share the site lookup and recover after a transient failure',async t=>{
  const {loadPlatformSites}=await import('../../src/app-platform/identity/sites.ts');
  const origin='https://employee.example',sites={employee:origin,admin:'https://admin.example'};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{origin}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    if(++calls===1)throw new DOMException('Request timed out','TimeoutError');
    return Response.json(sites);
  });
  const first=loadPlatformSites();
  assert.equal(loadPlatformSites(),first);
  assert.deepEqual(await first,{employee:origin,admin:origin});
  assert.deepEqual(await loadPlatformSites(),sites);
  assert.deepEqual(await loadPlatformSites(),sites);
  assert.equal(calls,2);
});
