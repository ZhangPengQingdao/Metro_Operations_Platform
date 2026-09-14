import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS, createPostgresPeopleDirectoryRepository } from '../src/platform/people/index.ts';
import { PLATFORM_LOCATION_DIRECTORY_MIGRATIONS } from '../src/platform/locations/index.ts';
import { PLATFORM_ASSET_DIRECTORY_MIGRATIONS } from '../src/platform/assets/index.ts';
import { PLATFORM_RESPONSIBILITY_MIGRATIONS } from '../src/platform/responsibility/index.ts';
import {
  AUTHORIZATION_PERMISSION_SEEDS,
  AUTHORIZATION_ROLE_SEEDS,
  AuthorizationError,
  PLATFORM_AUTHORIZATION_MIGRATIONS,
  PLATFORM_AUTHORIZATION_SQL,
  buildAuthorizationSeed,
  createAuthorizationService,
  createMemoryAuthorizationRepository,
  createPostgresAuthorizationRepository,
  reconcileLegacyRoles,
  scopeAllowsResource,
  type AppPermissionGrant,
  type DataScope
} from '../src/platform/authorization/index.ts';

const I = {
  org: '41000000-0000-4000-8000-000000000001',
  orgChild: '41000000-0000-4000-8000-000000000002',
  orgOther: '41000000-0000-4000-8000-000000000003',
  admin: '41000000-0000-4000-8000-000000000011',
  leader: '41000000-0000-4000-8000-000000000012',
  maintainer: '41000000-0000-4000-8000-000000000013',
  other: '41000000-0000-4000-8000-000000000014',
  position: '41000000-0000-4000-8000-000000000021',
  permissionRead: '41000000-0000-4000-8000-000000000031',
  permissionManage: '41000000-0000-4000-8000-000000000032',
  permissionModify: '41000000-0000-4000-8000-000000000033',
  location: '41000000-0000-4000-8000-000000000041',
  locationOther: '41000000-0000-4000-8000-000000000042',
  responsibilityScope: '41000000-0000-4000-8000-000000000043'
} as const;

const now = '2026-08-31T03:00:00.000Z';
const people = new Map<string, { organizationUnitId: string; employmentStatus: string }>([
  [I.admin, { organizationUnitId: I.org, employmentStatus: 'active' }],
  [I.leader, { organizationUnitId: I.org, employmentStatus: 'active' }],
  [I.maintainer, { organizationUnitId: I.org, employmentStatus: 'active' }],
  [I.other, { organizationUnitId: I.orgOther, employmentStatus: 'active' }]
]);

function memory() {
  const repository = createMemoryAuthorizationRepository(buildAuthorizationSeed(now));
  let sequence = 100;
  const service = createAuthorizationService(repository, {
    clock: () => new Date(now),
    createId: () => `41000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    findPerson: async (id) => people.get(id) ?? null,
    scopeResolvers: {
      isOrganizationDescendant: async (candidate, ancestor) => candidate === I.orgChild && ancestor === I.org,
      hasResponsibility: async (personId, target) => personId === I.maintainer && target.type === 'responsibility_scope' && target.id === I.responsibilityScope
    }
  });
  return { repository, service };
}

function role(code: string) {
  const found = AUTHORIZATION_ROLE_SEEDS.find((seed) => seed.code === code);
  assert.ok(found);
  return found;
}

function appGrant(overrides: Partial<AppPermissionGrant> = {}): AppPermissionGrant {
  return {
    grantId: 'grant-1',
    appId: 'demo.app',
    mode: 'delegated_user',
    permissionCode: 'records.read',
    scope: { kind: 'all', targets: [] },
    status: 'active',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    ...overrides
  };
}

async function registerCompatibilityPermissions(service: ReturnType<typeof createAuthorizationService>) {
  const read = await service.registerPermission({ id: I.permissionRead, code: 'compat.workgroup.read', name: '读取工班内容' });
  const manage = await service.registerPermission({ id: I.permissionManage, code: 'compat.workgroup.manage', name: '管理工班内容' });
  const modify = await service.registerPermission({ id: I.permissionModify, code: 'compat.record.modify', name: '修改工班记录' });
  return { read, manage, modify };
}

test('three approved roles and sensitive authorization permissions are stable seeds', () => {
  assert.deepEqual(AUTHORIZATION_ROLE_SEEDS.map((seed) => seed.code), ['administrator', 'team_leader', 'maintainer']);
  assert.deepEqual(AUTHORIZATION_PERMISSION_SEEDS.map((seed) => seed.code), ['platform.authorization.read', 'platform.authorization.manage']);
  const seed = buildAuthorizationSeed(now);
  assert.equal(seed.rolePermissions.length, 2);
  assert.equal(seed.rolePermissions.every((grant) => grant.roleId === role('administrator').id && grant.scopeKind === 'all'), true);
});

test('a person has one current role while role changes retain history', async () => {
  const { repository, service } = memory();
  const initial = await service.assignRole({ personId: I.maintainer, roleId: role('maintainer').id, reason: 'initial' });
  await assert.rejects(
    service.assignRole({ personId: I.maintainer, roleId: role('team_leader').id }),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'PERSON_ROLE_ALREADY_ASSIGNED'
  );
  await assert.rejects(
    service.changeRole({ id: initial.id, personId: I.maintainer, roleId: role('team_leader').id }),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'DUPLICATE_ASSIGNMENT_ID'
  );
  assert.equal((await repository.findCurrentPersonRole(I.maintainer))?.roleId, role('maintainer').id);
  await service.changeRole({ personId: I.maintainer, roleId: role('team_leader').id, reason: 'promotion' });
  const current = await repository.findCurrentPersonRole(I.maintainer);
  const history = await service.listPersonRoleAssignments(I.maintainer);
  assert.equal(current?.roleId, role('team_leader').id);
  assert.equal(history.length, 2);
  assert.equal(history[0].effectiveTo, now);
  assert.equal(history[1].effectiveTo, null);
});

test('allow-list authorization denies missing permissions and enforces self scope', async () => {
  const { service } = memory();
  const permission = await service.registerPermission({ id: I.permissionRead, code: 'records.read', name: '查看记录' });
  await service.assignRole({ personId: I.maintainer, roleId: role('maintainer').id });
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'platform' }, permissionCode: permission.code })).reasonCode, 'permission_not_granted');
  await service.grantRolePermission({ roleId: role('maintainer').id, permissionId: permission.id, scope: { kind: 'self', targets: [] } });
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'platform' }, permissionCode: permission.code, resource: { ownerPersonId: I.maintainer } })).allowed, true);
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'platform' }, permissionCode: permission.code, resource: { ownerPersonId: I.other } })).reasonCode, 'data_scope_mismatch');
});

test('organization tree, responsibility, explicit, and all scopes are executable', async () => {
  const subject = { type: 'person' as const, personId: I.maintainer };
  const resolvers = {
    isOrganizationDescendant: async (candidate: string, ancestor: string) => candidate === I.orgChild && ancestor === I.org,
    hasResponsibility: async (personId: string, target: { type: string; id: string }) => personId === I.maintainer && target.type === 'responsibility_scope' && target.id === I.responsibilityScope
  };
  assert.equal(await scopeAllowsResource({ kind: 'organization_tree', targets: [] }, subject, I.org, { organizationUnitId: I.orgChild }, resolvers), true);
  assert.equal(await scopeAllowsResource({ kind: 'responsibility', targets: [] }, subject, I.org, { targets: [{ type: 'responsibility_scope', id: I.responsibilityScope }] }, resolvers), true);
  assert.equal(await scopeAllowsResource({ kind: 'explicit', targets: [{ type: 'location', id: I.location }] }, subject, I.org, { targets: [{ type: 'location', id: I.locationOther }] }, resolvers), false);
  assert.equal(await scopeAllowsResource({ kind: 'all', targets: [] }, subject, I.org, {}, resolvers), true);
});

test('application grants can only narrow a person role permission', async () => {
  const { service } = memory();
  const permission = await service.registerPermission({ id: I.permissionRead, code: 'records.read', name: '查看记录' });
  await service.assignRole({ personId: I.maintainer, roleId: role('maintainer').id });
  await service.grantRolePermission({ roleId: role('maintainer').id, permissionId: permission.id, scope: { kind: 'all', targets: [] } });
  const explicitScope: DataScope = { kind: 'explicit', targets: [{ type: 'location', id: I.location }] };
  const granted = appGrant({ scope: explicitScope });
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'application', appId: 'demo.app', grant: granted }, permissionCode: permission.code, resource: { targets: [{ type: 'location', id: I.location }] } })).allowed, true);
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'application', appId: 'demo.app', grant: granted }, permissionCode: permission.code, resource: { targets: [{ type: 'location', id: I.locationOther }] } })).reasonCode, 'data_scope_mismatch');
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'application', appId: 'demo.app' }, permissionCode: permission.code })).reasonCode, 'app_grant_required');
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'application', appId: 'bad app', grant: granted }, permissionCode: permission.code })).reasonCode, 'app_grant_invalid');
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'unexpected' } as any, permissionCode: permission.code })).reasonCode, 'app_grant_invalid');
  assert.equal((await service.decide({ subject: { type: 'person', personId: I.maintainer }, execution: { type: 'application', appId: 'demo.app', grant: appGrant({ effectiveTo: '2026-06-01T00:00:00.000Z' }) }, permissionCode: permission.code })).reasonCode, 'app_grant_expired');
});

test('service identities require separate service grants and cannot borrow person-relative scope', async () => {
  const { service } = memory();
  await service.registerPermission({ id: I.permissionRead, code: 'records.read', name: '查看记录' });
  const subject = { type: 'service' as const, appId: 'demo.app', serviceIdentityId: 'service-1' };
  assert.equal((await service.decide({ subject, execution: { type: 'platform' }, permissionCode: 'records.read' })).reasonCode, 'app_grant_invalid');
  assert.equal((await service.decide({ subject, execution: { type: 'service' }, permissionCode: 'records.read' })).reasonCode, 'app_grant_required');
  const grant = appGrant({ mode: 'service', scope: { kind: 'explicit', targets: [{ type: 'location', id: I.location }] } });
  assert.equal((await service.decide({ subject, execution: { type: 'service', grant }, permissionCode: 'records.read', resource: { targets: [{ type: 'location', id: I.location }] } })).allowed, true);
  assert.equal((await service.decide({ subject, execution: { type: 'service', grant }, permissionCode: 'records.read', resource: { targets: [{ type: 'location', id: I.locationOther }] } })).reasonCode, 'data_scope_mismatch');
  assert.equal((await service.decide({ subject, execution: { type: 'service', grant: appGrant({ mode: 'service', scope: { kind: 'organization', targets: [] } }) }, permissionCode: 'records.read' })).reasonCode, 'app_grant_invalid');
});

test('legacy role reconciliation maps only the approved three roles and reports unsafe rows', () => {
  const report = reconcileLegacyRoles({
    peopleIds: [I.admin, I.leader, I.maintainer],
    rows: [
      { sourceId: 'u1', personId: I.admin, roleName: '管理员' },
      { sourceId: 'u2', personId: I.leader, roleName: '工班长' },
      { sourceId: 'u3', personId: I.maintainer, roleName: '检修工' },
      { sourceId: 'u4', personId: I.maintainer, roleName: '未知角色' },
      { sourceId: 'u5', personId: I.other, roleName: '检修工' }
    ]
  });
  assert.deepEqual(report.mappedRoleCodes, { [I.admin]: 'administrator', [I.leader]: 'team_leader', [I.maintainer]: 'maintainer' });
  assert.deepEqual(report.issues.map((issue) => issue.code), ['UNKNOWN_ROLE', 'DUPLICATE_PERSON_ROLE', 'MISSING_PERSON']);
});

test('authorization migration is additive, depends on people and responsibility, and creates no L4 app registry', () => {
  const migration = PLATFORM_AUTHORIZATION_MIGRATIONS[0];
  assert.deepEqual(migration.dependsOn, ['platform-people-directory-expand','platform-responsibility-expand']);
  assert.match(PLATFORM_AUTHORIZATION_SQL, /platform_person_current_role_idx/);
  assert.match(PLATFORM_AUTHORIZATION_SQL, /scope_kind IN \('self','organization','organization_tree','responsibility','explicit','all'\)/);
  assert.doesNotMatch(PLATFORM_AUTHORIZATION_SQL, /(platform_apps|app_installations|service_identities|app_manifests)/i);
});

test('authorization migration and PostgreSQL repository run twice in isolated PGlite', async () => {
  const db = new PGlite();
  const client = { query(text: string, values?: readonly unknown[]) { if (!values && text.includes(';')) return db.exec(text); return db.query(text, values ? [...values] : undefined); } };
  try {
    await PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_LOCATION_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_ASSET_DIRECTORY_MIGRATIONS[0].run({ client });
    await PLATFORM_RESPONSIBILITY_MIGRATIONS[0].run({ client });
    await PLATFORM_AUTHORIZATION_MIGRATIONS[0].run({ client });
    await PLATFORM_AUTHORIZATION_MIGRATIONS[0].run({ client });
    await db.query(`INSERT INTO platform_organization_units(id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at) VALUES($1,NULL,'org','工班',NULL,'workgroup','active',0,NOW(),NOW())`, [I.org]);
    await db.query(`INSERT INTO platform_positions(id,code,name,description,status,created_at,updated_at) VALUES($1,'MAINTAINER','AFC检修工',NULL,'active',NOW(),NOW())`, [I.position]);
    await db.query(`INSERT INTO platform_people(id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at) VALUES($1,'001','张三',NULL,$2,$3,'active',NULL,NOW(),NOW())`, [I.maintainer,I.org,I.position]);
    const repository = createPostgresAuthorizationRepository(client);
    const peopleRepository = createPostgresPeopleDirectoryRepository(client);
    let sequence = 800;
    const service = createAuthorizationService(repository, { createId: () => `41000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`, findPerson: (id) => peopleRepository.findPersonById(id) });
    assert.equal((await service.listRoles()).length, 3);
    assert.equal((await service.listPermissions()).length, 2);
    const initial = await service.assignRole({ personId: I.maintainer, roleId: role('maintainer').id });
    await assert.rejects(db.query(
      `INSERT INTO platform_person_role_assignments(id,person_id,role_id,effective_from,effective_to,assigned_by_person_id,reason,created_at,updated_at) VALUES($1,$2,$3,NOW(),NULL,NULL,NULL,NOW(),NOW())`,
      ['41000000-0000-4000-8000-000000000099',I.maintainer,role('team_leader').id]
    ));
    await assert.rejects(service.changeRole({ id: initial.id, personId: I.maintainer, roleId: role('team_leader').id }));
    assert.equal((await repository.findCurrentPersonRole(I.maintainer))?.roleId, role('maintainer').id);
    await service.changeRole({ personId: I.maintainer, roleId: role('team_leader').id });
    assert.equal((await repository.findCurrentPersonRole(I.maintainer))?.roleId, role('team_leader').id);
    assert.equal((await repository.listPersonRoleAssignments(I.maintainer)).length, 2);
  } finally {
    await db.close();
  }
});
