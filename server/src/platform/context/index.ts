import type { TrustedActorIdentity, TrustedActorSource } from '../../core/identity/index.js';
import type { PersonDirectoryProfile, PeopleDirectoryRepository } from '../people/index.js';
import type {
  AppPermissionGrant,
  AuthorizationDecision,
  AuthorizationResource,
  AuthorizationService
} from '../authorization/index.js';

export type PlatformExecution =
  | { type: 'platform' }
  | { type: 'application'; appId: string }
  | { type: 'service'; appId: string; serviceIdentityId: string };

export interface PlatformRequestMetadata {
  requestId: string;
  traceId: string;
  startedAt: string;
}

export interface PlatformPersonSnapshot {
  id: string;
  employeeNo: string;
  name: string;
  avatarUrl: string | null;
  organization: {
    id: string;
    code: string;
    name: string;
    unitType: PersonDirectoryProfile['organizationUnit']['unitType'];
  };
  position: {
    id: string;
    code: string;
    name: string;
  };
}

export type PlatformActorContext = PlatformPersonActorContext | PlatformServiceActorContext;

export interface PlatformPersonActorContext {
  actorType: 'person';
  trustedIdentity: TrustedActorIdentity;
  person: PlatformPersonSnapshot;
  execution: Exclude<PlatformExecution, { type: 'service' }>;
  request: PlatformRequestMetadata;
  authorize(permissionCode: string, resource?: AuthorizationResource): Promise<AuthorizationDecision>;
  authorizeApplication?(permissionCode: string, resource?: AuthorizationResource): Promise<AuthorizationDecision>;
}

export interface PlatformServiceActorContext {
  actorType: 'service';
  trustedIdentity: TrustedActorIdentity;
  execution: Extract<PlatformExecution, { type: 'service' }>;
  request: PlatformRequestMetadata;
  authorize(permissionCode: string, resource?: AuthorizationResource): Promise<AuthorizationDecision>;
  authorizeApplication?(permissionCode: string, resource?: AuthorizationResource): Promise<AuthorizationDecision>;
}

export interface ResolveAppGrantInput {
  appId: string;
  mode: 'delegated_user' | 'service';
  permissionCode: string;
  personId?: string;
  serviceIdentityId?: string;
}

export type AppGrantResolver = (input: ResolveAppGrantInput) => Promise<AppPermissionGrant | null>;

export type ResolvePlatformActorInput =
  | {
      actorType: 'person';
      trustedIdentity: TrustedActorIdentity;
      execution: { type: 'platform' } | { type: 'application'; appId: string };
      requestId: string;
      traceId: string;
      startedAt?: Date;
      wecomTenantKey?: string;
    }
  | {
      actorType: 'service';
      trustedIdentity: TrustedActorIdentity;
      execution: { type: 'service'; appId: string; serviceIdentityId: string };
      requestId: string;
      traceId: string;
      startedAt?: Date;
    };

export interface PlatformActorContextResolverOptions {
  people: Pick<PeopleDirectoryRepository, 'getPersonProfile' | 'findPersonByExternalIdentity'>;
  authorization: Pick<AuthorizationService, 'decide'> & Partial<Pick<AuthorizationService, 'decideApplication'>>;
  resolveAppGrant?: AppGrantResolver;
  clock?: () => Date;
}

export interface PublicPlatformActorSnapshot {
  actorType: PlatformActorContext['actorType'];
  source: TrustedActorSource;
  execution: { type: PlatformExecution['type']; appId?: string };
  person?: PlatformPersonSnapshot;
  capabilities: string[];
}

export class PlatformActorContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformActorContextError';
    this.code = code;
  }
}

export class PlatformActorContextResolver {
  private readonly clock: () => Date;

  constructor(private readonly options: PlatformActorContextResolverOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async resolve(input: ResolvePlatformActorInput): Promise<PlatformActorContext> {
    const request = requestMetadata(input.requestId, input.traceId, input.startedAt ?? this.clock());
    if (input.actorType === 'service') return this.resolveService(input, request);
    return this.resolvePerson(input, request);
  }

  private async resolvePerson(
    input: Extract<ResolvePlatformActorInput, { actorType: 'person' }>,
    request: PlatformRequestMetadata
  ): Promise<PlatformPersonActorContext> {
    if (input.trustedIdentity.source === 'service') {
      throw new PlatformActorContextError('PERSON_IDENTITY_REQUIRED', '服务身份不能建立人员上下文');
    }
    const profile = await this.resolvePersonProfile(input.trustedIdentity, input.wecomTenantKey ?? 'default');
    validateActiveProfile(profile);
    const execution = input.execution.type === 'application'
      ? { type: 'application' as const, appId: appId(input.execution.appId) }
      : { type: 'platform' as const };
    if (execution.type === 'application' && !this.options.resolveAppGrant) {
      throw new PlatformActorContextError('GRANT_RESOLVER_REQUIRED', '应用上下文缺少受信任授权解析器');
    }
    const person = personSnapshot(profile);
    return {
      actorType: 'person',
      trustedIdentity: structuredClone(input.trustedIdentity),
      person,
      execution,
      request,
      authorizeApplication: async (permissionCode, resource) => {
        if (execution.type !== 'application' || !this.options.authorization.decideApplication) {
          throw new PlatformActorContextError('APPLICATION_GATE_UNAVAILABLE', '应用授权检查不可用');
        }
        const grant = await this.options.resolveAppGrant!({ appId: execution.appId, mode: 'delegated_user', permissionCode, personId: person.id });
        return this.options.authorization.decideApplication({
          subject: { type: 'person', personId: person.id },
          execution: { type: 'application', appId: execution.appId, grant }, permissionCode, resource
        });
      },
      authorize: async (permissionCode, resource) => {
        if (execution.type === 'platform') {
          return this.options.authorization.decide({
            subject: { type: 'person', personId: person.id },
            execution,
            permissionCode,
            resource
          });
        }
        const grant = await this.options.resolveAppGrant!({
          appId: execution.appId,
          mode: 'delegated_user',
          permissionCode,
          personId: person.id
        });
        return this.options.authorization.decide({
          subject: { type: 'person', personId: person.id },
          execution: { type: 'application', appId: execution.appId, grant },
          permissionCode,
          resource
        });
      }
    };
  }

  private resolveService(
    input: Extract<ResolvePlatformActorInput, { actorType: 'service' }>,
    request: PlatformRequestMetadata
  ): PlatformServiceActorContext {
    if (input.trustedIdentity.source !== 'service') {
      throw new PlatformActorContextError('TRUSTED_SERVICE_IDENTITY_REQUIRED', '后台任务必须使用 L1 可信服务身份');
    }
    if (!this.options.resolveAppGrant) {
      throw new PlatformActorContextError('GRANT_RESOLVER_REQUIRED', '服务上下文缺少受信任授权解析器');
    }
    const execution = {
      type: 'service' as const,
      appId: appId(input.execution.appId),
      serviceIdentityId: requiredId(input.execution.serviceIdentityId, 'service identity id')
    };
    return {
      actorType: 'service',
      trustedIdentity: structuredClone(input.trustedIdentity),
      execution,
      request,
      authorizeApplication: async (permissionCode, resource) => {
        if (!this.options.authorization.decideApplication) {
          throw new PlatformActorContextError('APPLICATION_GATE_UNAVAILABLE', '应用授权检查不可用');
        }
        const grant = await this.options.resolveAppGrant!({
          appId: execution.appId, mode: 'service', permissionCode, serviceIdentityId: execution.serviceIdentityId
        });
        return this.options.authorization.decideApplication({
          subject: { type: 'service', appId: execution.appId, serviceIdentityId: execution.serviceIdentityId },
          execution: { type: 'service', grant }, permissionCode, resource
        });
      },
      authorize: async (permissionCode, resource) => {
        const grant = await this.options.resolveAppGrant!({
          appId: execution.appId,
          mode: 'service',
          permissionCode,
          serviceIdentityId: execution.serviceIdentityId
        });
        return this.options.authorization.decide({
          subject: { type: 'service', appId: execution.appId, serviceIdentityId: execution.serviceIdentityId },
          execution: { type: 'service', grant },
          permissionCode,
          resource
        });
      }
    };
  }

  private async resolvePersonProfile(identity: TrustedActorIdentity, tenantKey: string) {
    if (!identity.userId && !identity.wecomUserId) {
      throw new PlatformActorContextError('STABLE_IDENTITY_REQUIRED', '人员上下文必须提供人员 ID 或已验证企业微信身份');
    }
    const byId = identity.userId ? await this.options.people.getPersonProfile(uuid(identity.userId, 'person id')) : null;
    if (identity.userId && !byId) throw new PlatformActorContextError('PERSON_NOT_FOUND', '可信人员 ID 未关联平台人员');
    const byWecom = identity.wecomUserId
      ? await this.options.people.findPersonByExternalIdentity('wecom', stableCode(tenantKey, 'tenant key'), identity.wecomUserId.trim())
      : null;
    if (identity.wecomUserId && !byWecom) throw new PlatformActorContextError('WECOM_IDENTITY_NOT_FOUND', '企业微信身份未验证或未关联平台人员');
    if (byId && byWecom && byId.person.id !== byWecom.person.id) {
      throw new PlatformActorContextError('IDENTITY_CONFLICT', '人员 ID 与企业微信身份指向不同人员');
    }
    const profile = byId ?? byWecom;
    if (!profile) throw new PlatformActorContextError('PERSON_NOT_FOUND', '平台人员不存在');
    if (identity.employeeId && identity.employeeId.trim() !== profile.person.employeeNo) {
      throw new PlatformActorContextError('IDENTITY_CONFLICT', '可信工号与平台人员不一致');
    }
    return profile;
  }
}

export function createPlatformActorContextResolver(options: PlatformActorContextResolverOptions) {
  return new PlatformActorContextResolver(options);
}

/** No role requirement: a ceiling for intrinsic rights, never an authorization replacement. */
export async function applicationGrantAllows(context: PlatformActorContext, permissionCode: string, resource?: AuthorizationResource): Promise<boolean> {
  if (context.execution.type === 'platform') return true;
  if (!context.authorizeApplication) return false;
  return (await context.authorizeApplication(permissionCode, resource)).allowed;
}

export async function serializePlatformActorContext(
  context: PlatformActorContext,
  capabilityCodes: readonly string[]
): Promise<PublicPlatformActorSnapshot> {
  const capabilities: string[] = [];
  for (const permissionCode of [...new Set(capabilityCodes.map((code) => code.trim()).filter(Boolean))]) {
    if ((await context.authorize(permissionCode)).allowed) capabilities.push(permissionCode);
  }
  return {
    actorType: context.actorType,
    source: context.trustedIdentity.source,
    execution: {
      type: context.execution.type,
      ...(context.execution.type === 'platform' ? {} : { appId: context.execution.appId })
    },
    ...(context.actorType === 'person' ? { person: structuredClone(context.person) } : {}),
    capabilities
  };
}

function validateActiveProfile(profile: PersonDirectoryProfile) {
  if (profile.person.employmentStatus !== 'active') throw new PlatformActorContextError('PERSON_INACTIVE', '人员不在岗');
  if (profile.organizationUnit.status !== 'active') throw new PlatformActorContextError('ORGANIZATION_INACTIVE', '人员组织未启用');
  if (profile.position.status !== 'active') throw new PlatformActorContextError('POSITION_INACTIVE', '人员岗位未启用');
}

function personSnapshot(profile: PersonDirectoryProfile): PlatformPersonSnapshot {
  return {
    id: profile.person.id,
    employeeNo: profile.person.employeeNo,
    name: profile.person.name,
    avatarUrl: profile.person.avatarUrl,
    organization: {
      id: profile.organizationUnit.id,
      code: profile.organizationUnit.code,
      name: profile.organizationUnit.name,
      unitType: profile.organizationUnit.unitType
    },
    position: { id: profile.position.id, code: profile.position.code, name: profile.position.name }
  };
}

function requestMetadata(requestIdInput: string, traceIdInput: string, startedAt: Date): PlatformRequestMetadata {
  const requestId = requiredId(requestIdInput, 'request id');
  const traceId = requiredId(traceIdInput, 'trace id');
  if (Number.isNaN(startedAt.getTime())) throw new PlatformActorContextError('INVALID_REQUEST_METADATA', '请求开始时间无效');
  return { requestId, traceId, startedAt: startedAt.toISOString() };
}

function requiredId(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new PlatformActorContextError('INVALID_ID', `${label} 无效`);
  return normalized;
}

function appId(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized) || normalized.length > 100) {
    throw new PlatformActorContextError('INVALID_APP_ID', '应用 ID 必须是稳定编码');
  }
  return normalized;
}

function stableCode(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized) || normalized.length > 100) {
    throw new PlatformActorContextError('INVALID_CODE', `${label} 必须是稳定编码`);
  }
  return normalized;
}

function uuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new PlatformActorContextError('INVALID_ID', `${label} 必须是 UUID`);
  }
  return normalized;
}

export { isNativeManagementActor, managementActorId, type PlatformManagementContext, type PlatformAdministratorContext } from './management.js';
