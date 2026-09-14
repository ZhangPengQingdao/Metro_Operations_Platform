import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPlatformCapabilityReader, type PlatformActorSnapshot } from '../../src/platform/context/index.tsx';
import { createMemoryPeopleDirectoryRepository, type ExternalIdentity, type OrganizationUnit, type Person, type Position } from '../src/platform/people/index.ts';
import {
  AUTHORIZATION_ROLE_SEEDS,
  buildAuthorizationSeed,
  createAuthorizationService,
  createMemoryAuthorizationRepository,
  type AppPermissionGrant
} from '../src/platform/authorization/index.ts';
import {
  PlatformActorContextError,
  createPlatformActorContextResolver,
  serializePlatformActorContext,
  applicationGrantAllows,
  type AppGrantResolver
} from '../src/platform/context/index.ts';

const I = {
  org: '42000000-0000-4000-8000-000000000001',
  orgOther: '42000000-0000-4000-8000-000000000002',
  position: '42000000-0000-4000-8000-000000000003',
  person: '42000000-0000-4000-8000-000000000011',
  personOther: '42000000-0000-4000-8000-000000000012',
  external: '42000000-0000-4000-8000-000000000021',
  externalOther: '42000000-0000-4000-8000-000000000022',
  permission: '42000000-0000-4000-8000-000000000031',
  location: '42000000-0000-4000-8000-000000000041',
  locationOther: '42000000-0000-4000-8000-000000000042'
} as const;

const now = '2026-08-31T04:00:00.000Z';
const organization: OrganizationUnit = { id:I.org,parentId:null,code:'org',name:'AFC工班',shortName:null,unitType:'workgroup',status:'active',sortOrder:0,createdAt:now,updatedAt:now };
const otherOrganization: OrganizationUnit = { ...organization,id:I.orgOther,code:'org-other',name:'其他工班' };
const position: Position = { id:I.position,code:'afc_maintainer',name:'AFC检修工',description:null,status:'active',createdAt:now,updatedAt:now };
const person: Person = { id:I.person,employeeNo:'001',name:'张三',phone:'13800000000',organizationUnitId:I.org,positionId:I.position,employmentStatus:'active',avatarUrl:null,createdAt:now,updatedAt:now };
const personOther: Person = { ...person,id:I.personOther,employeeNo:'002',name:'李四',organizationUnitId:I.orgOther };
const external: ExternalIdentity = { id:I.external,personId:I.person,provider:'wecom',tenantKey:'default',externalUserId:'zhangsan',status:'active',verifiedAt:now,createdAt:now,updatedAt:now };
const externalOther: ExternalIdentity = { ...external,id:I.externalOther,personId:I.personOther,externalUserId:'lisi' };

async function setup(overrides: {
  organizations?: OrganizationUnit[];
  positions?: Position[];
  people?: Person[];
  externalIdentities?: ExternalIdentity[];
  resolveAppGrant?: AppGrantResolver;
} = {}) {
  const peopleRepository = createMemoryPeopleDirectoryRepository({
    organizationUnits: overrides.organizations ?? [organization,otherOrganization],
    positions: overrides.positions ?? [position],
    people: overrides.people ?? [person,personOther],
    externalIdentities: overrides.externalIdentities ?? [external,externalOther]
  });
  const authorizationRepository = createMemoryAuthorizationRepository(buildAuthorizationSeed(now));
  let sequence = 100;
  const authorization = createAuthorizationService(authorizationRepository, {
    clock: () => new Date(now),
    createId: () => `42000000-0000-4000-8000-${String(sequence++).padStart(12,'0')}`,
    findPerson: async (id) => {
      const record = await peopleRepository.findPersonById(id);
      return record ? { organizationUnitId: record.organizationUnitId, employmentStatus: record.employmentStatus } : null;
    }
  });
  const permission = await authorization.registerPermission({ id:I.permission,code:'records.read',name:'查看记录' });
  const maintainer = AUTHORIZATION_ROLE_SEEDS.find((role) => role.code === 'maintainer')!;
  if ((await peopleRepository.findPersonById(I.person))?.employmentStatus === 'active') {
    await authorization.assignRole({ personId:I.person,roleId:maintainer.id });
  }
  await authorization.grantRolePermission({ roleId:maintainer.id,permissionId:permission.id,scope:{ kind:'all',targets:[] } });
  const resolver = createPlatformActorContextResolver({
    people: peopleRepository,
    authorization,
    resolveAppGrant: overrides.resolveAppGrant,
    clock: () => new Date(now)
  });
  return { resolver,authorization,peopleRepository };
}

function request() { return { requestId:'req-1',traceId:'trace-1',startedAt:new Date(now) }; }
function grant(overrides: Partial<AppPermissionGrant> = {}): AppPermissionGrant {
  return { grantId:'grant-1',appId:'demo.app',mode:'delegated_user',permissionCode:'records.read',scope:{ kind:'all',targets:[] },status:'active',effectiveFrom:'2026-01-01T00:00:00.000Z',effectiveTo:null,...overrides };
}

test('session person context resolves directory identity and delegates platform authorization', async () => {
  const { resolver } = await setup();
  const context = await resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.person,employeeId:'001',name:'张三' },execution:{ type:'platform' },...request() });
  assert.equal(context.actorType,'person');
  assert.equal(context.person.position.name,'AFC检修工');
  assert.equal(context.person.organization.name,'AFC工班');
  assert.equal(context.request.startedAt,now);
  assert.equal((await context.authorize('records.read')).allowed,true);
});

test('session, WeCom, name-after-legacy-resolution, and MCP token sources produce one person contract', async () => {
  const { resolver } = await setup();
  const identities = [
    { source:'session' as const,userId:I.person },
    { source:'wecom' as const,wecomUserId:'zhangsan' },
    { source:'name' as const,userId:I.person,name:'张三' },
    { source:'mcp_actor_token' as const,userId:I.person }
  ];
  for (const trustedIdentity of identities) {
    const context = await resolver.resolve({ actorType:'person',trustedIdentity,execution:{ type:'platform' },...request() });
    assert.equal(context.actorType,'person');
    assert.equal(context.person.id,I.person);
  }
  await assert.rejects(
    resolver.resolve({ actorType:'person',trustedIdentity:{ source:'name',name:'张三' },execution:{ type:'platform' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'STABLE_IDENTITY_REQUIRED'
  );
});

test('conflicting stable identities and inactive directory records fail closed', async () => {
  const { resolver } = await setup();
  await assert.rejects(
    resolver.resolve({ actorType:'person',trustedIdentity:{ source:'wecom',userId:I.person,wecomUserId:'lisi' },execution:{ type:'platform' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'IDENTITY_CONFLICT'
  );
  const inactive = await setup({ people:[{ ...person,employmentStatus:'inactive' }] });
  await assert.rejects(
    inactive.resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.person },execution:{ type:'platform' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'PERSON_INACTIVE'
  );
  const inactiveOrg = await setup({ organizations:[{ ...organization,status:'inactive' }] ,people:[person]});
  await assert.rejects(
    inactiveOrg.resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.person },execution:{ type:'platform' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'ORGANIZATION_INACTIVE'
  );
  const inactivePosition = await setup({ positions:[{ ...position,status:'inactive' }],people:[person] });
  await assert.rejects(
    inactivePosition.resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.person },execution:{ type:'platform' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'POSITION_INACTIVE'
  );
  const unverifiedWecom = await setup({ externalIdentities:[{ ...external,verifiedAt:null }] });
  await assert.rejects(
    unverifiedWecom.resolver.resolve({ actorType:'person',trustedIdentity:{ source:'wecom',wecomUserId:'zhangsan' },execution:{ type:'platform' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'WECOM_IDENTITY_NOT_FOUND'
  );
});

test('application context resolves grants internally and intersects data scope', async () => {
  const calls: unknown[] = [];
  const resolveAppGrant: AppGrantResolver = async (input) => {
    calls.push(input);
    return grant({ scope:{ kind:'explicit',targets:[{ type:'location',id:I.location }] } });
  };
  const { resolver } = await setup({ resolveAppGrant });
  const context = await resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.person },execution:{ type:'application',appId:'demo.app' },...request() });
  assert.equal((await context.authorize('records.read',{ targets:[{ type:'location',id:I.location }] })).allowed,true);
  assert.equal((await context.authorize('records.read',{ targets:[{ type:'location',id:I.locationOther }] })).reasonCode,'data_scope_mismatch');
  assert.deepEqual(calls[0],{ appId:'demo.app',mode:'delegated_user',permissionCode:'records.read',personId:I.person });
  const withoutResolver = await setup();
  await assert.rejects(
    withoutResolver.resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.person },execution:{ type:'application',appId:'demo.app' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'GRANT_RESOLVER_REQUIRED'
  );
});

test('service context requires L1 service identity and a separately resolved service grant', async () => {
  const resolveAppGrant: AppGrantResolver = async (input) => grant({ mode:'service',scope:{ kind:'explicit',targets:[{ type:'location',id:I.location }] },appId:input.appId,permissionCode:input.permissionCode });
  const { resolver } = await setup({ resolveAppGrant });
  const context = await resolver.resolve({ actorType:'service',trustedIdentity:{ source:'service',name:'scheduler' },execution:{ type:'service',appId:'demo.app',serviceIdentityId:'job-runner' },...request() });
  assert.equal((await context.authorize('records.read',{ targets:[{ type:'location',id:I.location }] })).allowed,true);
  assert.equal((await context.authorize('records.read',{ targets:[{ type:'location',id:I.locationOther }] })).allowed,false);
  await assert.rejects(
    resolver.resolve({ actorType:'service',trustedIdentity:{ source:'session',userId:I.person },execution:{ type:'service',appId:'demo.app',serviceIdentityId:'job-runner' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'TRUSTED_SERVICE_IDENTITY_REQUIRED'
  );
  await assert.rejects(
    resolver.resolve({ actorType:'service',trustedIdentity:{ source:'service',name:'scheduler' },execution:{ type:'service',appId:'demo.app',serviceIdentityId:' ' },...request() }),
    (error: unknown) => error instanceof PlatformActorContextError && error.code === 'INVALID_ID'
  );
});

test('public and frontend snapshots expose capabilities without role, grant, scope, or trusted identifiers', async () => {
  const { resolver } = await setup();
  const context = await resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.person,wecomUserId:'zhangsan' },execution:{ type:'platform' },...request() });
  const snapshot = await serializePlatformActorContext(context,['records.read','records.missing','records.read']);
  assert.deepEqual(snapshot.capabilities,['records.read']);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized,/(role|grant|scope|wecomUserId|traceId|requestId|serviceIdentityId)/i);
  const reader = createPlatformCapabilityReader(snapshot as PlatformActorSnapshot);
  assert.equal(reader('records.read'),true);
  assert.equal(reader('records.missing'),false);
});

test('actor context contracts remain independent of employee application implementations', async () => {
  const [serverContext,frontendContext] = await Promise.all([
    readFile(new URL('../src/platform/context/index.ts',import.meta.url),'utf8'),
    readFile(new URL('../../src/platform/context/index.tsx',import.meta.url),'utf8')
  ]);
  assert.doesNotMatch(serverContext,/modules\/auth|RequestAccessContext/);
  assert.doesNotMatch(frontendContext,/\brole\b|workgroupId|grant|dataScope/);
});

test('intrinsic-right application ceiling refreshes grants without requiring a person role', async () => {
  let current: AppPermissionGrant | null = grant();
  let lookups = 0;
  const { resolver } = await setup({ resolveAppGrant: async () => { lookups++; return current; } });
  // personOther intentionally has no role assignment.
  const context = await resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.personOther },execution:{ type:'application',appId:'demo.app' },...request() });
  const resource = { ownerPersonId:I.personOther, organizationUnitId:I.orgOther };
  assert.equal((await context.authorize('records.read',resource)).reasonCode,'role_not_assigned');
  assert.equal(await applicationGrantAllows(context,'records.read',resource),true);
  for (const invalid of [
    null,
    grant({ status:'inactive' }),
    grant({ effectiveTo:now }),
    grant({ appId:'other.app' }),
    grant({ permissionCode:'other.read' }),
    grant({ mode:'service' }),
    grant({ scope:{ kind:'explicit',targets:[{ type:'organization',id:I.org }] } })
  ]) {
    current = invalid;
    assert.equal(await applicationGrantAllows(context,'records.read',resource),false);
  }
  current = grant({ scope:{ kind:'self',targets:[] } });
  assert.equal(await applicationGrantAllows(context,'records.read',resource),true);
  assert.equal(await applicationGrantAllows(context,'records.read',{ ...resource,ownerPersonId:I.person }),false);
  assert.equal(lookups,11); // combined authorization plus ten independent ceiling checks
  const { authorizeApplication: ignored, ...oldContext } = context;
  assert.equal(await applicationGrantAllows(oldContext,'records.read',resource),false);
  const platform = await resolver.resolve({ actorType:'person',trustedIdentity:{ source:'session',userId:I.personOther },execution:{ type:'platform' },...request() });
  assert.equal(await applicationGrantAllows(platform,'records.read',resource),true);
  assert.equal(lookups,11);
});

test('service application ceiling denies stale, wrong-mode and out-of-scope grants', async () => {
  let current: AppPermissionGrant | null = grant({ mode:'service' });
  const { resolver } = await setup({ resolveAppGrant:async () => current });
  const context = await resolver.resolve({ actorType:'service',trustedIdentity:{ source:'service' },execution:{ type:'service',appId:'demo.app',serviceIdentityId:'runner' },...request() });
  assert.equal(await applicationGrantAllows(context,'records.read',{ organizationUnitId:I.org }),true);
  for (const invalid of [null,grant(),grant({ mode:'service',status:'inactive' }),grant({ mode:'service',effectiveTo:now }),grant({ mode:'service',appId:'other.app' }),grant({ mode:'service',scope:{ kind:'explicit',targets:[{ type:'organization',id:I.orgOther }] } })]) {
    current = invalid;
    assert.equal(await applicationGrantAllows(context,'records.read',{ organizationUnitId:I.org }),false);
  }
});
