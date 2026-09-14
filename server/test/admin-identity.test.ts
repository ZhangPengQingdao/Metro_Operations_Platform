import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PGlite } from '@electric-sql/pglite';
import { ADMIN_IDENTITY_MIGRATION, AdminIdentityService, registerAdminIdentityRoutes } from '../src/core/admin-identity/index.ts';

async function fixture() {
 const db = new PGlite();
 await db.exec(ADMIN_IDENTITY_MIGRATION);
 const client = { query: (sql: string, values?: readonly unknown[]) => sql.includes('pg_advisory_xact_lock') ? Promise.resolve({ rows: [] }) : db.query(sql, values ? [...values] : []), release() {} };
 const service = new AdminIdentityService({ connect: async () => client });
 return { db, service };
}
const initial = { username: 'platform.admin', displayName: '管理员', password: 'Independent-admin-123' };

test('independent identities persist hashed credentials; disabling and password change revoke sessions', async () => {
 const { db, service } = await fixture();
 try {
  const account = await service.bootstrap(initial);
  await assert.rejects(service.bootstrap(initial), /ADMIN_ALREADY_INITIALIZED/);
  assert.equal((await service.authenticate('employee-session')), null);
  const first = await service.login({ username: initial.username, password: initial.password });
  assert.equal(first.account.id, account.id);
  const secretRows = await db.query<{password_hash:string}>('SELECT password_hash FROM platform_admin_accounts');
  assert.notEqual(secretRows.rows[0].password_hash, initial.password);
  const sessions = await db.query<{token_hash:string}>('SELECT token_hash FROM platform_admin_sessions');
  assert.notEqual(sessions.rows[0].token_hash, first.token);
  await assert.rejects(service.update(first.token, account.id, { status: 'disabled' }), /ADMIN_CANNOT_DISABLE_SELF/);
  await assert.rejects(service.create('bad', { ...initial, username: 'other' }), /ADMIN_AUTH_REQUIRED/);
  const secondAccount = await service.create(first.token, { ...initial, username: 'second' });
  const second = await service.login({ username: 'second', password: initial.password });
  await service.update(first.token, secondAccount.id, { status: 'disabled' });
  assert.equal(await service.authenticate(second.token), null);
  await assert.rejects(service.login({ username: 'second', password: initial.password }), /ADMIN_LOGIN_FAILED/);
  const another = await service.login({ username: initial.username, password: initial.password });
  await service.changePassword(first.token, { currentPassword: initial.password, newPassword: 'Replacement-admin-456' });
  assert.equal(await service.authenticate(first.token), null);
  assert.equal(await service.authenticate(another.token), null);
  await assert.rejects(service.login({ username: initial.username, password: initial.password }), /ADMIN_LOGIN_FAILED/);
  const fresh = await service.login({ username: initial.username, password: 'Replacement-admin-456' });
  assert.equal((await service.authenticate(fresh.token))?.id, account.id);
  await db.query("UPDATE platform_admin_sessions SET expires_at=now()-interval '1 second'");
  assert.equal(await service.authenticate(fresh.token), null);
  const audit = await db.query<{action:string}>('SELECT action FROM platform_admin_audit');
  assert.ok(audit.rows.some(row => row.action === 'admin.password-change'));
 } finally { await db.close(); }
});

test('HTTP rejects CSRF and employee cookies, uses secure strict cookie, bounds login attempts', async () => {
 const { db, service } = await fixture();
 const app = Fastify();
 await app.register(cookie);
 registerAdminIdentityRoutes(app, { origin: 'https://admin.example', service });
 try {
  await service.bootstrap(initial);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: initial })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/auth/me', headers: {cookie:'session=employee'} })).statusCode, 401);
  const login = await app.inject({ method:'POST', url:'/api/admin/auth/login', headers:{origin:'https://admin.example'}, payload:{username:initial.username,password:initial.password} });
  assert.equal(login.statusCode, 200);
  const setCookie = String(login.headers['set-cookie']);
  assert.match(setCookie,/HttpOnly/); assert.match(setCookie,/Secure/); assert.match(setCookie,/SameSite=Strict/); assert.match(setCookie,/Path=\/api\/admin/);
  assert.equal(login.json().password_hash, undefined);
  const headers = { cookie: setCookie.split(';')[0], origin:'https://admin.example' };
  assert.equal((await app.inject({ url:'/api/admin/auth/me',headers })).statusCode,200);
  assert.equal((await app.inject({ method:'POST',url:'/api/admin/auth/logout',headers:{...headers,origin:'https://evil.example'} })).statusCode,403);
  assert.equal((await app.inject({ method:'POST',url:'/api/admin/auth/logout',headers })).statusCode,200);
  assert.equal((await app.inject({ url:'/api/admin/auth/me',headers })).statusCode,401);
  for(let i=0;i<4;i++) await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin:'https://admin.example'},payload:{username:initial.username,password:'wrong'}});
  assert.equal((await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin:'https://admin.example'},payload:{username:initial.username,password:initial.password}})).statusCode,429);
 } finally { await app.close(); await db.close(); }
});
