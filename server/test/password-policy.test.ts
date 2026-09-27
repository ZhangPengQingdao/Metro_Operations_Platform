import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PGlite } from '@electric-sql/pglite';
import { isPasswordCompliant, passwordSchema } from '../src/core/security/password-policy.ts';
import { isPasswordCompliant as frontendCompliant } from '../../src/app-platform/identity/password-policy.ts';
import { initializePlatformDatabase } from '../src/setup/schema.ts';
import { AdminIdentityService, registerAdminIdentityRoutes, ADMIN_SESSION_COOKIE } from '../src/core/admin-identity/index.ts';
import { EmployeeIdentityService, EMPLOYEE_SESSION_COOKIE } from '../src/platform/employee-identity/index.ts';
import { RegistrationService } from '../src/platform/employee-identity/registration.ts';
import { registerEmployeeRoutes } from '../src/app-platform/employee/routes.ts';
import { registerUnifiedLogin } from '../src/platform/employee-identity/unified-login.ts';
import type { PlatformAdministratorContext } from '../src/platform/context/index.ts';

test('password policy: eight characters, any three of four categories, UTF-8 byte limit; frontend agrees', () => {
 const valid = ['Abcd1234', 'Abcdefg!', 'ABCD123!', 'abcd123!', 'Abcd123!', 'Aa1!' + 'a'.repeat(68), 'Aa1！中文密码', 'Aa1😀abcd'];
 const invalid = ['', 'Aa1!abc', 'a'.repeat(12), 'ABCDEFGHIJKL', '123456789012', 'Abcdefghijkl', 'abcd1234', 'ABCD1234', 'abcdefg!', 'ABCDEF!@', '123456!@', 'abcd123 ', 'abcd123\n', 'abcd123\u0000', 'abcd123中', 'abcd123\u0301', 'Aa1!' + 'a'.repeat(69), 'Aa1!' + '中'.repeat(23), 'Aa1' + '😀😀'];
 for (const [cases, expected] of [[valid, true], [invalid, false]] as const) {
  for (const value of cases) {
   assert.equal(isPasswordCompliant(value), expected, JSON.stringify(value));
   assert.equal(frontendCompliant(value), expected, JSON.stringify(value));
   assert.equal(passwordSchema.safeParse(value).success, expected, JSON.stringify(value));
  }
 }
});

async function fixture() {
 const pg = new PGlite();
 const db = { query: async (sql: string, args?: readonly unknown[]) => sql.includes('pg_advisory_xact_lock') ? { rows: [] } : args ? pg.query(sql, [...args]) : (await pg.exec(sql)).at(-1)!, release() {} };
 const pool = { connect: async () => db };
 await initializePlatformDatabase(db);
 const org = randomUUID(), position = randomUUID(), person = randomUUID();
 await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,status,created_at,updated_at) VALUES($1,'test','Team','workgroup','active',now(),now())", [org]);
 await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'test','Worker','active',now(),now())", [position]);
 await pg.query("INSERT INTO platform_people(id,employee_no,name,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1,'test','Employee',$2,$3,'active',now(),now())", [person, org, position]);
 const actor = { actorType: 'administrator', administrator: { id: randomUUID() }, execution: { type: 'platform' }, authorize: async () => ({ allowed: true }) } as unknown as PlatformAdministratorContext;
 const admin = new AdminIdentityService(pool), employee = new EmployeeIdentityService(pool);
 return { pg, db, pool, org, person, actor, admin, employee };
}

test('bootstrap, account creation, reset and registration reject weak passwords and accept eight-character passwords', async () => {
 const f = await fixture();
 try {
  await assert.rejects(f.admin.bootstrap({ username: 'admin', displayName: 'Admin', password: 'abcdefghijkl' }));
  await f.admin.bootstrap({ username: 'admin', displayName: 'Admin', password: 'Abcd1234' });
  const session = await f.admin.login({ username: 'admin', password: 'Abcd1234' });
  await assert.rejects(f.admin.create(session.token, { username: 'other', displayName: 'Other', password: 'abcdefgh1234' }));
  await assert.rejects(f.employee.create(f.actor, { personId: f.person, username: 'employee', password: 'abcdefgh1234' }));
  const account = await f.employee.create(f.actor, { personId: f.person, username: 'employee', password: 'abcd123!' });
  const employeeSession = await f.employee.login({ username: 'employee', password: 'abcd123!' });
  await assert.rejects(f.employee.update(f.actor, account.id, { password: 'abcdefgh1234' }));
  await assert.rejects(f.employee.changePassword(employeeSession.token, { currentPassword: 'abcd123!', newPassword: 'abcdefgh1234' }));
  await assert.rejects(f.admin.changePassword(session.token, { currentPassword: 'Abcd1234', newPassword: 'abcdefgh1234' }));
  assert.ok(await f.admin.authenticate(session.token));
  assert.ok(await f.employee.authenticate(employeeSession.token));
  const registration = new RegistrationService(f.pool);
  const input = { employeeNo: 'new-employee', name: 'New employee', organizationId: f.org, password: 'abcdefgh1234' };
  await assert.rejects(registration.submit(input));
  assert.equal((await f.pg.query('SELECT * FROM platform_employee_registrations')).rows.length, 0);
  assert.deepEqual(await registration.submit({ ...input, password: 'ABCD123!' }), { status: 'pending' });
  assert.deepEqual(await initializePlatformDatabase(f.db), []);
  assert.ok(await f.admin.authenticate(session.token));
 } finally { await f.pg.close(); }
});

test('upgrading existing session tables preserves password hashes and sessions; repeated migration preserves restrictions', async () => {
 const f = await fixture();
 try {
  await f.admin.bootstrap({ username: 'admin', displayName: 'Admin', password: 'Abcd1234' });
  await f.employee.create(f.actor, { personId: f.person, username: 'employee', password: 'Abcd1234' });
  const admin = await f.admin.login({ username: 'admin', password: 'Abcd1234' });
  const employee = await f.employee.login({ username: 'employee', password: 'Abcd1234' });
  const hashes = await f.pg.query('SELECT password_hash FROM platform_admin_accounts UNION ALL SELECT password_hash FROM platform_employee_accounts');
  await f.pg.exec("ALTER TABLE platform_admin_sessions DROP COLUMN password_change_required; ALTER TABLE platform_employee_sessions DROP COLUMN password_change_required; DELETE FROM platform_schema_migrations WHERE id='platform-password-policy-sessions-expand';");
  assert.deepEqual(await initializePlatformDatabase(f.db), ['platform-password-policy-sessions-expand']);
  assert.deepEqual((await f.pg.query('SELECT password_hash FROM platform_admin_accounts UNION ALL SELECT password_hash FROM platform_employee_accounts')).rows, hashes.rows);
  assert.ok(await f.admin.authenticate(admin.token));
  assert.ok(await f.employee.authenticate(employee.token));
  await f.pg.exec('UPDATE platform_admin_sessions SET password_change_required=true; UPDATE platform_employee_sessions SET password_change_required=true;');
  assert.deepEqual(await initializePlatformDatabase(f.db), []);
  assert.equal(await f.admin.authenticate(admin.token), null);
  assert.equal(await f.employee.authenticate(employee.token), null);
  assert.equal((await f.admin.authenticate(admin.token, true))?.passwordChangeRequired, true);
  assert.equal((await f.employee.authenticate(employee.token, true))?.passwordChangeRequired, true);
 } finally { await f.pg.close(); }
});

for (const kind of ['admin', 'employee'] as const) {
 test(`${kind}: legacy password requires change through both login endpoints; restricted sessions cannot use business APIs`, async () => {
  const f = await fixture(), app = Fastify(), origin = 'https://platform.test';
  try {
   await f.admin.bootstrap({ username: 'admin', displayName: 'Admin', password: 'Abcd1234' });
   await f.employee.create(f.actor, { personId: f.person, username: 'employee', password: 'Abcd1234' });
   const service = kind === 'admin' ? f.admin : f.employee;
   const old = await service.login({ username: kind, password: 'Abcd1234' });
   // Simulate an existing credential without submitting it through the new policy.
   const legacy = 'legacy123456';
   await f.pg.query(`UPDATE platform_${kind}_accounts SET password_hash=$1`, [await bcrypt.hash(legacy, 4)]);
   await app.register(cookie);
   registerAdminIdentityRoutes(app, { origin, service: f.admin });
   registerEmployeeRoutes(app, { origin, service: f.employee, resolveAdmin: async () => f.actor });
   registerUnifiedLogin(app, { origin, pool: f.pool, admin: f.admin, employee: f.employee });
   const unified = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: kind, password: legacy } });
   assert.equal(unified.statusCode, 200, unified.body);
   assert.equal(unified.json().account.passwordChangeRequired, true);
   assert.equal(await service.authenticate(old.token), null);
   const unifiedCookies = unified.cookies.find(value => value.name === (kind === 'admin' ? ADMIN_SESSION_COOKIE : EMPLOYEE_SESSION_COOKIE))!;
   const unifiedHeaders = { origin, cookie: `${unifiedCookies.name}=${unifiedCookies.value}` };
   assert.equal((await app.inject({ method: 'POST', url: `/api/${kind}/auth/logout`, headers: unifiedHeaders })).statusCode, 200);
   assert.equal((await app.inject({ url: `/api/${kind}/auth/me`, headers: unifiedHeaders })).statusCode, 401);
   const login = await app.inject({ method: 'POST', url: `/api/${kind}/auth/login`, headers: { origin }, payload: { username: kind, password: legacy } });
   assert.equal(login.statusCode, 200, login.body);
   assert.equal(login.json().passwordChangeRequired, true);
   assert.equal(login.json().password_hash, undefined);
   const cookieName = kind === 'admin' ? ADMIN_SESSION_COOKIE : EMPLOYEE_SESSION_COOKIE;
   const sessionCookie = String(login.headers['set-cookie']).split(';')[0];
   assert.ok(sessionCookie.startsWith(cookieName + '='));
   const token = sessionCookie.slice(cookieName.length + 1), headers = { origin, cookie: sessionCookie };
   assert.equal(await service.authenticate(token), null);
   assert.equal((await service.authenticate(token, true))?.passwordChangeRequired, true);
   const me = await app.inject({ url: `/api/${kind}/auth/me`, headers });
   assert.equal(me.statusCode, 200); assert.equal(me.json().passwordChangeRequired, true);
   assert.equal((await app.inject({ url: `/api/${kind}/${kind === 'admin' ? 'accounts' : 'profile'}`, headers })).statusCode, 403);
   if (kind === 'employee') {
    await assert.rejects(f.employee.resolveIdentity(token), /EMPLOYEE_AUTH_REQUIRED/);
    await assert.rejects(f.employee.updateProfile(token, { phone: '', wecomUserId: '' }), /EMPLOYEE_PASSWORD_CHANGE_REQUIRED/);
    for (const path of ['/apps', '/apps/test/ui', '/notifications', '/managed-apps']) assert.equal((await app.inject({ url: '/api/employee' + path, headers })).statusCode, 403);
   } else {
    await assert.rejects(f.admin.list(token), /ADMIN_PASSWORD_CHANGE_REQUIRED/);
    await assert.rejects(f.admin.create(token, { username: 'blocked', displayName: 'Blocked', password: 'Abcd1234' }), /ADMIN_AUTH_REQUIRED/);
   }
   const change = (currentPassword: string, newPassword: string, requestOrigin = origin) => app.inject({ method: 'PATCH', url: `/api/${kind}/auth/password`, headers: { ...headers, origin: requestOrigin }, payload: { currentPassword, newPassword } });
   assert.equal((await change(legacy, 'Abcd1234', 'https://evil.test')).statusCode, 403);
   assert.equal((await change('wrong', 'Abcd1234')).statusCode, 403);
   assert.equal((await change(legacy, 'abcdefgh1234')).statusCode, 400);
   assert.equal((await service.authenticate(token, true))?.passwordChangeRequired, true);
   assert.equal((await change(legacy, 'ABCD123!')).statusCode, 200);
   assert.equal(await service.authenticate(token, true), null);
   assert.equal((await app.inject({ url: `/api/${kind}/auth/me`, headers })).statusCode, 401);
   await assert.rejects(service.login({ username: kind, password: legacy }));
   const fresh = await service.login({ username: kind, password: 'ABCD123!' });
   assert.equal(fresh.account.passwordChangeRequired, undefined);
   assert.ok(await service.authenticate(fresh.token));
  } finally { await app.close(); await f.pg.close(); }
 });
}
