import { createHash } from 'node:crypto';
import { ASSET_LIFECYCLE_STATES } from '../assets/index.js';
import { MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS } from '../../core/identity/index.js';
import { redactSecrets } from '../../core/security/index.js';
import type { AuthInfo, CoreMcpResourceRegistration, CoreMcpToolRegistration, ServerContext } from '../../core/integrations/mcp/index.js';
import { assertMcpSafeJson, assertMcpToolMetadata, assertMcpUiResources, assertPlatformMcpToolResult, PLATFORM_MCP_LIMITS, toPlatformMcpProtocolTool } from './apps.js';
import type { PlatformActorContext } from '../context/index.js';
import {
  type EntityReference,
  type EntityResolutionCandidate,
  type EntityResolutionRequest,
  type EntityResolutionResult,
  type EntityResolutionService
} from '../entity-resolution/index.js';
import { LOCATION_TYPES } from '../locations/index.js';
import {
  type Notification,
  type NotificationDetail,
  NOTIFICATION_STATUSES,
  type NotificationService
} from '../notifications/index.js';
import { ORGANIZATION_UNIT_TYPES } from '../people/index.js';
import {
  isEffective,
  type ResponsibilityAssignment,
  type ResponsibilityResolution,
  type ResponsibilityService
} from '../responsibility/index.js';
import {
  SIGNATURE_REQUEST_STATUSES,
  type SignatureDetail,
  type SignatureRequest,
  type SignatureService
} from '../signatures/index.js';
import {
  WORK_ITEM_CANDIDATE_TYPES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TARGET_TYPES,
  type WorkItem,
  type WorkItemDetail,
  type WorkItemService
} from '../work-items/index.js';
import {
  PLATFORM_MCP_CONTRACT_VERSION,
  PLATFORM_MCP_PERMISSION_CODES,
  PlatformMcpToolError,
  type PlatformMcpActorData,
  type PlatformMcpObjectSchema,
  type PlatformMcpOwnerCapability,
  type PlatformMcpToolOwner,
  type PlatformMcpSchema,
  type PlatformMcpToolContribution,
  type PlatformMcpToolDescriptor,
  type PlatformMcpToolName,
  type PlatformMcpToolResult
} from './model.js';

export * from './migration.js';
export * from './model.js';
export * from './apps.js';

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const ISO_INSTANT_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$';
const uuidSchema = (): PlatformMcpSchema => ({ type: 'string', pattern: UUID_PATTERN });
const textSchema = (maxLength: number, minLength = 1): PlatformMcpSchema => ({ type: 'string', minLength, maxLength });
const integerSchema = (minimum: number, maximum: number): PlatformMcpSchema => ({ type: 'integer', minimum, maximum });
const objectSchema = (
  properties: Readonly<Record<string, PlatformMcpSchema>>,
  required: readonly string[] = []
): PlatformMcpObjectSchema => ({ type: 'object', properties, required, additionalProperties: false });
const arraySchema = (items: PlatformMcpSchema, maxItems: number, minItems = 0, uniqueItems = false): PlatformMcpSchema => ({
  type: 'array', items, minItems, maxItems, uniqueItems
});

function descriptor(
  name: PlatformMcpToolName,
  ownerCapability: PlatformMcpOwnerCapability,
  description: string,
  readOnly: boolean,
  retryPolicy: PlatformMcpToolDescriptor['retryPolicy'],
  businessAuthorization: PlatformMcpToolDescriptor['permissionPolicy']['businessAuthorization'],
  inputSchema: PlatformMcpObjectSchema
): PlatformMcpToolDescriptor<PlatformMcpToolName> {
  return {
    name,
    contractVersion: PLATFORM_MCP_CONTRACT_VERSION,
    owner: { type: 'platform_capability', id: ownerCapability },
    description,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: retryPolicy !== 'not_retryable',
      openWorldHint: false
    },
    retryPolicy,
    resultPolicy: { bounded: true },
    permissionPolicy: {
      gatewayPermission: PLATFORM_MCP_PERMISSION_CODES.use,
      businessAuthorization
    },
    inputSchema
  };
}

const directoryBase = {
  id: uuidSchema(),
  query: textSchema(200),
  max_candidates: integerSchema(1, 20)
};

export const PLATFORM_MCP_TOOL_CATALOG: readonly PlatformMcpToolDescriptor<PlatformMcpToolName>[] = [
  descriptor('platform_get_current_actor', 'context', '返回当前可信执行上下文的安全身份快照。', true, 'inherent', 'gateway_only', objectSchema({})),
  descriptor('platform_search_people', 'entity-resolution', '按稳定 ID 或文本查询在岗人员。', true, 'inherent', 'gateway_only', objectSchema({
    ...directoryBase,
    organization_unit_id: uuidSchema(),
    position_id: uuidSchema()
  })),
  descriptor('platform_search_organizations', 'entity-resolution', '按稳定 ID 或文本查询启用组织。', true, 'inherent', 'gateway_only', objectSchema({
    ...directoryBase,
    unit_types: arraySchema({ type: 'string', enum: ORGANIZATION_UNIT_TYPES }, ORGANIZATION_UNIT_TYPES.length, 1, true),
    parent_organization_unit_id: uuidSchema()
  })),
  descriptor('platform_search_locations', 'entity-resolution', '按稳定 ID 或文本查询启用位置。', true, 'inherent', 'gateway_only', objectSchema({
    ...directoryBase,
    location_type: { type: 'string', enum: LOCATION_TYPES },
    line_id: uuidSchema()
  })),
  descriptor('platform_search_assets', 'entity-resolution', '按稳定 ID 或文本查询未退役资产。', true, 'inherent', 'gateway_only', objectSchema({
    ...directoryBase,
    system_id: uuidSchema(),
    type_id: uuidSchema(),
    location_id: uuidSchema(),
    lifecycle_states: arraySchema({ type: 'string', enum: ASSET_LIFECYCLE_STATES }, ASSET_LIFECYCLE_STATES.length, 1, true)
  })),
  descriptor('platform_list_my_responsibilities', 'responsibility', '返回当前人员在请求时点生效的责任范围。', true, 'inherent', 'self_bound', objectSchema({})),
  descriptor('platform_list_work_items', 'work-items', '列出当前上下文可见的工作项。', true, 'inherent', 'delegated_to_owner', objectSchema({
    status: arraySchema({ type: 'string', enum: WORK_ITEM_STATUSES }, WORK_ITEM_STATUSES.length, 1, true),
    source_app_id: textSchema(100),
    target_type: { type: 'string', enum: WORK_ITEM_TARGET_TYPES },
    target_id: uuidSchema(),
    limit: integerSchema(1, 50)
  })),
  descriptor('platform_get_work_item', 'work-items', '读取一个当前上下文可见工作项的安全详情。', true, 'inherent', 'delegated_to_owner', objectSchema({
    work_item_id: uuidSchema()
  }, ['work_item_id'])),
  descriptor('platform_create_work_item', 'work-items', '创建一个普通工作项；来源由可信执行上下文派生。', false, 'required', 'delegated_to_owner', objectSchema({
    idempotency_key: textSchema(200),
    title: textSchema(200),
    summary: textSchema(2000, 0),
    source_label: textSchema(100, 0),
    priority: { type: 'string', enum: WORK_ITEM_PRIORITIES },
    responsibility_area_id: uuidSchema(),
    target: objectSchema({
      type: { type: 'string', enum: WORK_ITEM_TARGET_TYPES },
      id: uuidSchema(),
      display_name: textSchema(200, 0)
    }, ['type', 'id']),
    candidates: arraySchema(objectSchema({
      candidate_type: { type: 'string', enum: WORK_ITEM_CANDIDATE_TYPES },
      candidate_id: uuidSchema()
    }, ['candidate_type', 'candidate_id']), 50),
    current_assignee_person_id: uuidSchema(),
    due_at: { type: 'string', pattern: ISO_INSTANT_PATTERN, maxLength: 40 }
  }, ['idempotency_key', 'title'])),
  descriptor('platform_update_work_item_progress', 'work-items', '更新一个可办理工作项的进度；调用方不得自动重试。', false, 'not_retryable', 'delegated_to_owner', objectSchema({
    work_item_id: uuidSchema(),
    progress_percent: integerSchema(0, 100),
    note: textSchema(2000, 0)
  }, ['work_item_id', 'progress_percent'])),
  descriptor('platform_complete_work_item', 'work-items', '由当前人员直接完成其可办理的工作项；调用方不得自动重试。', false, 'not_retryable', 'delegated_to_owner', objectSchema({
    work_item_id: uuidSchema(),
    note: textSchema(2000, 0)
  }, ['work_item_id'])),
  descriptor('platform_list_notifications', 'notifications', '列出当前上下文可见的通知及当前人员已读状态。', true, 'inherent', 'delegated_to_owner', objectSchema({
    status: arraySchema({ type: 'string', enum: NOTIFICATION_STATUSES }, NOTIFICATION_STATUSES.length, 1, true),
    category: textSchema(100),
    unread_only: { type: 'boolean' },
    limit: integerSchema(1, 50)
  })),
  descriptor('platform_get_notification', 'notifications', '读取一个当前上下文可见通知的安全详情。', true, 'inherent', 'delegated_to_owner', objectSchema({
    notification_id: uuidSchema()
  }, ['notification_id'])),
  descriptor('platform_mark_notification_read', 'notifications', '由当前人员收件人标记通知已读；调用方不得自动重试。', false, 'not_retryable', 'delegated_to_owner', objectSchema({
    notification_id: uuidSchema(),
    note: textSchema(2000, 0)
  }, ['notification_id'])),
  descriptor('platform_list_signature_requests', 'signatures', '列出当前上下文可见的签字请求状态，不返回令牌或证据。', true, 'inherent', 'delegated_to_owner', objectSchema({
    status: arraySchema({ type: 'string', enum: SIGNATURE_REQUEST_STATUSES }, SIGNATURE_REQUEST_STATUSES.length, 1, true),
    limit: integerSchema(1, 20)
  })),
  descriptor('platform_get_signature_status', 'signatures', '读取一个当前上下文可见签字请求的安全状态。', true, 'inherent', 'delegated_to_owner', objectSchema({
    signature_request_id: uuidSchema()
  }, ['signature_request_id']))
];

export interface PlatformMcpServices {
  entityResolution: Pick<EntityResolutionService, 'resolve'>;
  responsibility: Pick<ResponsibilityService, 'listAssignmentsByPerson' | 'resolve'>;
  workItems: Pick<WorkItemService, 'listWorkItems' | 'getWorkItem' | 'createWorkItem' | 'updateProgress' | 'completeWorkItem'>;
  notifications: Pick<NotificationService, 'listNotifications' | 'getNotification' | 'markRead'>;
  signatures: Pick<SignatureService, 'listSignatureRequests' | 'getSignatureRequest'>;
}

export function createPlatformMcpContribution(services: PlatformMcpServices): PlatformMcpToolContribution<PlatformMcpToolName> {
  const contribution: PlatformMcpToolContribution<PlatformMcpToolName> = {
    id: 'platform-core',
    contractVersion: PLATFORM_MCP_CONTRACT_VERSION,
    tools: PLATFORM_MCP_TOOL_CATALOG,
    async callTool(context, name, rawArgs) {
      await requireMcpUse(context);
      const tool = PLATFORM_MCP_TOOL_CATALOG.find((item) => item.name === name);
      if (!tool) throw new PlatformMcpToolError('UNKNOWN_TOOL', '未知的平台 MCP 工具');
      validateAgainstSchema(rawArgs, tool.inputSchema);
      const args = rawArgs as Record<string, unknown>;

      switch (tool.name) {
        case 'platform_get_current_actor':
          return result(tool.name, actorData(context));
        case 'platform_search_people':
          return result(tool.name, await resolveDirectory(services, 'person', args));
        case 'platform_search_organizations':
          return result(tool.name, await resolveDirectory(services, 'organization', args));
        case 'platform_search_locations':
          return result(tool.name, await resolveDirectory(services, 'location', args));
        case 'platform_search_assets':
          return result(tool.name, await resolveDirectory(services, 'asset', args));
        case 'platform_list_my_responsibilities':
          return result(tool.name, await listResponsibilities(services, context));
        case 'platform_list_work_items':
          return result(tool.name, await listWorkItems(services, context, args));
        case 'platform_get_work_item':
          return result(tool.name, workItemDetailData(await services.workItems.getWorkItem(context, stringArg(args, 'work_item_id'))));
        case 'platform_create_work_item':
          return result(tool.name, workItemData(await createWorkItem(services, context, args)));
        case 'platform_update_work_item_progress':
          return result(tool.name, workItemData(await services.workItems.updateProgress(context, {
            workItemId: stringArg(args, 'work_item_id'),
            progressPercent: numberArg(args, 'progress_percent'),
            note: optionalStringArg(args, 'note')
          })));
        case 'platform_complete_work_item':
          requirePerson(context, '完成工作项');
          return result(tool.name, workItemData(await services.workItems.completeWorkItem(context, {
            workItemId: stringArg(args, 'work_item_id'),
            note: optionalStringArg(args, 'note')
          })));
        case 'platform_list_notifications':
          return result(tool.name, await listNotifications(services, context, args));
        case 'platform_get_notification':
          return result(tool.name, notificationData(await services.notifications.getNotification(context, stringArg(args, 'notification_id')), context));
        case 'platform_mark_notification_read': {
          requirePerson(context, '标记通知已读');
          const read = await services.notifications.markRead(context, {
            notificationId: stringArg(args, 'notification_id'),
            note: optionalStringArg(args, 'note')
          });
          return result(tool.name, { notificationId: read.notificationId, readAt: read.readAt });
        }
        case 'platform_list_signature_requests':
          return result(tool.name, await listSignatureRequests(services, context, args));
        case 'platform_get_signature_status':
          return result(tool.name, signatureData(await services.signatures.getSignatureRequest(context, stringArg(args, 'signature_request_id'))));
      }
    }
  };
  assertPlatformMcpToolContribution(contribution);
  return contribution;
}

export function assertPlatformMcpToolContribution(value: unknown): asserts value is PlatformMcpToolContribution {
  if (!isRecord(value)) invalidContribution('$', '贡献必须是普通对象');
  if (!stableContributionId(value.id)) invalidContribution('$.id', '贡献 ID 必须是稳定编码');
  if (value.contractVersion !== PLATFORM_MCP_CONTRACT_VERSION) invalidContribution('$.contractVersion', '仅支持合同版本 2.0');
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > 100) invalidContribution('$.tools', '工具数量必须为 1 到 100');
  if (typeof value.callTool !== 'function') invalidContribution('$.callTool', '贡献必须提供调用 Handler');
  const names = new Set<string>();
  value.tools.forEach((tool, index) => {
    const path = `$.tools[${index}]`;
    if (!isRecord(tool)) invalidContribution(path, '工具定义必须是普通对象');
    if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{2,99}$/.test(tool.name)) invalidContribution(`${path}.name`, '工具名必须是稳定小写编码');
    if (names.has(tool.name)) invalidContribution(`${path}.name`, '同一贡献内工具名不能重复');
    names.add(tool.name);
    if (tool.contractVersion !== PLATFORM_MCP_CONTRACT_VERSION) invalidContribution(`${path}.contractVersion`, '工具合同版本必须为 2.0');
    const { permissionPolicy: _permissionPolicy, ...metadata } = tool;
    assertMcpSafeJson(metadata, PLATFORM_MCP_LIMITS.descriptorBytes);
    validateToolOwner(tool.owner, `${path}.owner`);
    if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 500 || safeModelText(tool.description) !== tool.description) invalidContribution(`${path}.description`, '工具描述无效或包含敏感内容');
    validateToolAnnotations(tool.annotations, tool.retryPolicy, `${path}.annotations`);
    if (!isRecord(tool.resultPolicy) || tool.resultPolicy.bounded !== true || Object.keys(tool.resultPolicy).some((key) => key !== 'bounded')) invalidContribution(`${path}.resultPolicy`, '工具结果必须声明有界');
    if (!isRecord(tool.permissionPolicy) || Object.keys(tool.permissionPolicy).some((key) => !['gatewayPermission', 'businessAuthorization'].includes(key)) || tool.permissionPolicy.gatewayPermission !== PLATFORM_MCP_PERMISSION_CODES.use || !['gateway_only','self_bound','delegated_to_owner'].includes(String(tool.permissionPolicy.businessAuthorization))) {
      invalidContribution(`${path}.permissionPolicy`, '工具权限策略无效');
    }
    if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') invalidContribution(`${path}.inputSchema`, '根 Schema 必须是对象');
    validateSchemaContract(tool.inputSchema, `${path}.inputSchema`, tool.owner.type === 'platform_capability');
    if (tool.outputSchema !== undefined) {
      if (!isRecord(tool.outputSchema) || tool.outputSchema.type !== 'object') invalidContribution(`${path}.outputSchema`, '根 Schema 必须是对象');
      validateSchemaContract(tool.outputSchema, `${path}.outputSchema`, tool.owner.type === 'platform_capability');
    }
    assertMcpToolMetadata(tool as unknown as PlatformMcpToolDescriptor);
  });
  assertMcpUiResources(value.resources ?? [], value.tools as PlatformMcpToolDescriptor[]);
}

/** Pure composition: the resolver is trusted server code, never a model-supplied actor. */
export function createPlatformMcpRegistrations(
  contribution: PlatformMcpToolContribution,
  resolveActor: (proof: AuthInfo, request: ServerContext) => Promise<PlatformActorContext>
): { tools: CoreMcpToolRegistration[]; resources: CoreMcpResourceRegistration[] } {
  assertPlatformMcpToolContribution(contribution);
  const tools = structuredClone(contribution.tools);
  const resources = structuredClone(contribution.resources ?? []);
  const callTool = contribution.callTool.bind(contribution);
  async function actor(request: ServerContext) {
    const proof = request.http?.authInfo;
    if (!proof) throw new PlatformMcpToolError('MCP_USE_DENIED', '缺少可信协议身份');
    const context = await resolveActor(proof, request);
    await requireMcpUse(context);
    return context;
  }
  return {
    tools: tools.map((tool) => ({
      definition: toPlatformMcpProtocolTool(tool),
      async call(args, request) {
        const context = await actor(request);
        validatePlatformMcpArguments(args, tool.inputSchema);
        const output = await callTool(context, tool.name, args);
        assertPlatformMcpToolResult(output);
        if (tool.outputSchema && !output.isError) {
          try { validateAgainstSchema(output.structuredContent, tool.outputSchema); }
          catch { throw new PlatformMcpToolError('INVALID_RESULT', '工具结构化输出不符合 outputSchema'); }
        }
        return structuredClone(output);
      }
    })),
    resources: resources.map((resource) => ({
      definition: { uri: resource.uri, name: resource.name, mimeType: resource.mimeType, ...(resource.title === undefined ? {} : { title: resource.title }), ...(resource._meta === undefined ? {} : { _meta: structuredClone(resource._meta) }) },
      async read(uri, request) {
        await actor(request);
        if (uri.href !== resource.uri) throw new PlatformMcpToolError('INVALID_ARGUMENTS', '未知 UI Resource');
        return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.html, ...(resource._meta === undefined ? {} : { _meta: structuredClone(resource._meta) }) }] };
      }
    }))
  };
}

async function requireMcpUse(context: PlatformActorContext) {
  if (!(await context.authorize(PLATFORM_MCP_PERMISSION_CODES.use)).allowed) {
    throw new PlatformMcpToolError('MCP_USE_DENIED', '当前上下文无权调用平台 MCP 工具');
  }
}

function requirePerson(context: PlatformActorContext, operation: string): asserts context is Extract<PlatformActorContext, { actorType: 'person' }> {
  if (context.actorType !== 'person') throw new PlatformMcpToolError('PERSON_ACTOR_REQUIRED', `${operation}需要人员上下文`);
}

function actorData(context: PlatformActorContext): PlatformMcpActorData {
  return {
    actorType: context.actorType,
    source: context.trustedIdentity.source,
    execution: {
      type: context.execution.type,
      ...(context.execution.type === 'platform' ? {} : { appId: context.execution.appId })
    },
    ...(context.actorType === 'person' ? {
      person: {
        id: context.person.id,
        employeeNo: context.person.employeeNo,
        name: context.person.name,
        organization: {
          id: context.person.organization.id,
          code: context.person.organization.code,
          name: context.person.organization.name,
          unitType: context.person.organization.unitType
        },
        position: {
          id: context.person.position.id,
          code: context.person.position.code,
          name: context.person.position.name
        }
      }
    } : {})
  };
}

async function resolveDirectory(services: PlatformMcpServices, entityType: EntityResolutionRequest['entityType'], args: Record<string, unknown>) {
  const id = optionalStringArg(args, 'id');
  const query = optionalStringArg(args, 'query');
  if (Boolean(id) === Boolean(query)) throw new PlatformMcpToolError('INVALID_ARGUMENTS', 'id 与 query 必须且只能提供一个', '$');
  const lookup = id ? { type: 'id' as const, id } : { type: 'text' as const, text: query! };
  const maxCandidates = optionalNumberArg(args, 'max_candidates') ?? 10;
  let request: EntityResolutionRequest;
  if (entityType === 'person') {
    request = {
      entityType,
      source: 'mcp',
      lookup,
      maxCandidates,
      filters: {
        organizationUnitId: optionalStringArg(args, 'organization_unit_id'),
        positionId: optionalStringArg(args, 'position_id')
      }
    };
  } else if (entityType === 'organization') {
    request = {
      entityType,
      source: 'mcp',
      lookup,
      maxCandidates,
      filters: {
        unitTypes: optionalStringArrayArg(args, 'unit_types') as typeof ORGANIZATION_UNIT_TYPES[number][] | undefined,
        parentOrganizationUnitId: optionalStringArg(args, 'parent_organization_unit_id')
      }
    };
  } else if (entityType === 'location') {
    request = {
      entityType,
      source: 'mcp',
      lookup,
      maxCandidates,
      filters: {
        locationType: optionalStringArg(args, 'location_type') as typeof LOCATION_TYPES[number] | undefined,
        lineId: optionalStringArg(args, 'line_id')
      }
    };
  } else {
    request = {
      entityType,
      source: 'mcp',
      lookup,
      maxCandidates,
      filters: {
        systemId: optionalStringArg(args, 'system_id'),
        typeId: optionalStringArg(args, 'type_id'),
        locationId: optionalStringArg(args, 'location_id'),
        lifecycleStates: optionalStringArrayArg(args, 'lifecycle_states') as typeof ASSET_LIFECYCLE_STATES[number][] | undefined
      }
    };
  }
  return resolutionData(await services.entityResolution.resolve(request));
}

function resolutionData(value: EntityResolutionResult) {
  return {
    status: value.status,
    entityType: value.entityType,
    input: value.input,
    normalizedInput: value.normalizedInput,
    candidateCount: value.candidateCount,
    candidates: value.candidates.map(candidateData),
    resolved: value.resolved ? candidateData(value.resolved) : null
  };
}

function candidateData(value: EntityResolutionCandidate) {
  return {
    reference: referenceData(value.reference),
    match: {
      type: value.match.type,
      score: value.match.score,
      matchedField: value.match.matchedField,
      matchedValue: value.match.matchedValue
    }
  };
}

function referenceData(value: EntityReference): Record<string, unknown> {
  if (value.entityType === 'person') return {
    entityType: value.entityType,
    id: value.id,
    displayName: value.displayName,
    employeeNo: value.employeeNo,
    organization: { id: value.organization.id, code: value.organization.code, name: value.organization.name },
    position: { id: value.position.id, code: value.position.code, name: value.position.name }
  };
  if (value.entityType === 'organization') return {
    entityType: value.entityType,
    id: value.id,
    displayName: value.displayName,
    code: value.code,
    shortName: value.shortName,
    unitType: value.unitType,
    parentId: value.parentId
  };
  if (value.entityType === 'location') return {
    entityType: value.entityType,
    id: value.id,
    displayName: value.displayName,
    code: value.code,
    shortName: value.shortName,
    locationType: value.locationType,
    lineCodes: [...value.lineCodes],
    stationCodes: [...value.stationCodes]
  };
  return {
    entityType: value.entityType,
    id: value.id,
    displayName: value.displayName,
    assetCode: value.assetCode,
    system: { id: value.system.id, code: value.system.code, name: value.system.name },
    type: { id: value.type.id, code: value.type.code, name: value.type.name },
    locationId: value.locationId,
    lifecycleState: value.lifecycleState
  };
}

async function listResponsibilities(services: PlatformMcpServices, context: PlatformActorContext) {
  requirePerson(context, '查询本人责任');
  const at = new Date(context.request.startedAt);
  const assignments = (await services.responsibility.listAssignmentsByPerson(context.person.id))
    .filter((assignment) => isEffective(assignment, at.toISOString()));
  const visible = assignments.slice(0, 50);
  const resolutions = new Map<string, ResponsibilityResolution>();
  for (const assignment of visible) {
    if (!resolutions.has(assignment.scopeId)) resolutions.set(assignment.scopeId, await services.responsibility.resolve(assignment.scopeId, at));
  }
  return {
    items: visible.map((assignment) => responsibilityData(assignment, resolutions.get(assignment.scopeId)!)),
    count: visible.length,
    truncated: assignments.length > visible.length,
    resolvedAt: at.toISOString()
  };
}

function responsibilityData(assignment: ResponsibilityAssignment, resolution: ResponsibilityResolution) {
  return {
    assignment: {
      id: assignment.id,
      role: assignment.assignmentRole,
      effectiveFrom: assignment.effectiveFrom,
      effectiveTo: assignment.effectiveTo
    },
    scope: {
      id: resolution.scope.id,
      organizationUnitId: resolution.scope.organizationUnitId,
      target: responsibilityTarget(resolution),
      includeDescendants: resolution.scope.includeDescendants
    },
    effective: {
      primaryOwnerPersonId: resolution.primaryOwner?.personId ?? null,
      temporaryAgentPersonId: resolution.temporaryAgent?.personId ?? null,
      effectiveHandlerPersonId: resolution.effectiveHandler?.personId ?? null,
      backupOwnerPersonIds: resolution.backupOwners.map((owner) => owner.personId)
    }
  };
}

function responsibilityTarget(resolution: ResponsibilityResolution) {
  const scope = resolution.scope;
  if (scope.responsibilityAreaId) return { type: 'responsibility_area', id: scope.responsibilityAreaId };
  if (scope.locationId) return { type: 'location', id: scope.locationId };
  if (scope.assetTypeId) return { type: 'asset_type', id: scope.assetTypeId };
  return { type: 'asset', id: scope.assetId };
}

async function listWorkItems(services: PlatformMcpServices, context: PlatformActorContext, args: Record<string, unknown>) {
  const targetType = optionalStringArg(args, 'target_type');
  const targetId = optionalStringArg(args, 'target_id');
  if (Boolean(targetType) !== Boolean(targetId)) throw new PlatformMcpToolError('INVALID_ARGUMENTS', 'target_type 与 target_id 必须同时提供', '$');
  const limit = optionalNumberArg(args, 'limit') ?? 20;
  const items = await services.workItems.listWorkItems(context, {
    status: optionalStringArrayArg(args, 'status') as typeof WORK_ITEM_STATUSES[number][] | undefined,
    sourceAppId: optionalStringArg(args, 'source_app_id'),
    target: targetType && targetId ? { type: targetType as typeof WORK_ITEM_TARGET_TYPES[number], id: targetId } : undefined
  });
  const visible = items.slice(0, limit);
  return { items: visible.map(workItemData), count: visible.length, truncated: items.length > visible.length };
}

async function createWorkItem(services: PlatformMcpServices, context: PlatformActorContext, args: Record<string, unknown>) {
  const idempotencyKey = scopedMcpIdempotencyKey(context, stringArg(args, 'idempotency_key'));
  const target = optionalObjectArg(args, 'target');
  const candidates = optionalObjectArrayArg(args, 'candidates');
  return services.workItems.createWorkItem(context, {
    source: {
      appId: context.execution.type === 'platform' ? 'platform_mcp' : context.execution.appId,
      entityType: 'mcp_work_item',
      entityId: idempotencyKey
    },
    idempotencyKey,
    display: {
      title: stringArg(args, 'title'),
      summary: optionalStringArg(args, 'summary') ?? null,
      sourceLabel: optionalStringArg(args, 'source_label') ?? null
    },
    priority: optionalStringArg(args, 'priority') as typeof WORK_ITEM_PRIORITIES[number] | undefined,
    responsibilityAreaId: optionalStringArg(args, 'responsibility_area_id'),
    target: target ? {
      type: stringArg(target, 'type') as typeof WORK_ITEM_TARGET_TYPES[number],
      id: stringArg(target, 'id'),
      displayName: optionalStringArg(target, 'display_name') ?? null
    } : undefined,
    candidates: candidates?.map((candidate) => ({
      candidateType: stringArg(candidate, 'candidate_type') as typeof WORK_ITEM_CANDIDATE_TYPES[number],
      candidateId: stringArg(candidate, 'candidate_id')
    })),
    currentAssigneePersonId: optionalStringArg(args, 'current_assignee_person_id'),
    dueAt: optionalStringArg(args, 'due_at') ? parseInstant(stringArg(args, 'due_at'), '$.due_at') : undefined
  });
}

function scopedMcpIdempotencyKey(context: PlatformActorContext, callerKey: string) {
  const subjectId = context.actorType === 'person' ? context.person.id : context.execution.serviceIdentityId;
  const digest = createHash('sha256').update(`${context.actorType}:${subjectId}:${callerKey}`, 'utf8').digest('hex');
  return `mcp:${digest}`;
}

function workItemData(item: WorkItem) {
  return {
    id: item.id,
    status: item.status,
    priority: item.priority,
    display: {
      title: safeModelText(item.display.title),
      summary: safeModelText(item.display.summary),
      sourceLabel: safeModelText(item.display.sourceLabel)
    },
    responsibilityAreaId: item.responsibilityAreaId,
    target: item.target ? {
      type: item.target.type,
      id: item.target.id,
      displayName: item.target.displayName
    } : null,
    currentAssigneePersonId: item.currentAssigneePersonId,
    dueAt: item.dueAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
    cancelledAt: item.cancelledAt
  };
}

function workItemDetailData(detail: WorkItemDetail) {
  return {
    ...workItemData(detail.item),
    candidates: detail.candidates.slice(0, 50).map((candidate) => ({
      candidateType: candidate.candidateType,
      candidateId: candidate.candidateId
    })),
    progress: detail.progressHistory.slice(-20).map((entry) => ({
      progressPercent: entry.progressPercent,
      note: safeModelText(entry.note),
      occurredAt: entry.occurredAt
    })),
    completion: detail.completion ? {
      completedByPersonId: detail.completion.actualCompleterPersonId,
      onBehalf: detail.completion.onBehalf,
      note: safeModelText(detail.completion.note),
      completedAt: detail.completion.completedAt
    } : null
  };
}

async function listNotifications(services: PlatformMcpServices, context: PlatformActorContext, args: Record<string, unknown>) {
  const limit = optionalNumberArg(args, 'limit') ?? 20;
  const listed = await services.notifications.listNotifications(context, {
    status: optionalStringArrayArg(args, 'status') as typeof NOTIFICATION_STATUSES[number][] | undefined,
    category: optionalStringArg(args, 'category'),
    unreadOnly: optionalBooleanArg(args, 'unread_only'),
    limit: limit + 1
  });
  const visible = listed.slice(0, limit);
  // ponytail: bounded to 50 details; add an owner-level batch projection only if measured query cost requires it.
  const details = await Promise.all(visible.map((notification) => services.notifications.getNotification(context, notification.id)));
  return {
    items: details.map((detail) => notificationData(detail, context)),
    count: details.length,
    truncated: listed.length > visible.length
  };
}

function notificationData(detail: NotificationDetail, context: PlatformActorContext) {
  const notification = detail.notification;
  const read = context.actorType === 'person' ? detail.reads.find((entry) => entry.personId === context.person.id) : undefined;
  return {
    id: notification.id,
    status: notification.status,
    category: notification.category,
    readBehavior: notification.readBehavior,
    display: {
      title: safeModelText(notification.display.title),
      body: safeModelText(notification.display.body),
      severity: notification.display.severity,
      sourceLabel: safeModelText(notification.display.sourceLabel)
    },
    navigation: navigationData(notification),
    read: context.actorType === 'person' ? { isRead: Boolean(read), readAt: read?.readAt ?? null } : null,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
    cancelledAt: notification.cancelledAt
  };
}

function navigationData(notification: Notification) {
  return notification.navigation ? {
    href: safePlatformHref(notification.navigation.href),
    routeName: notification.navigation.routeName
  } : null;
}

function safePlatformHref(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /\\|%5c/i.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, 'https://platform.invalid');
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://platform.invalid') return null;
  if (/^\/api\/files\/(?:public|preview)\//i.test(parsed.pathname)) return null;
  for (const key of parsed.searchParams.keys()) {
    if (/(?:^|_)(?:token|sig|signature|secret|key|authorization|credential)(?:$|_)/i.test(key)) return null;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function listSignatureRequests(services: PlatformMcpServices, context: PlatformActorContext, args: Record<string, unknown>) {
  const limit = optionalNumberArg(args, 'limit') ?? 10;
  const listed = await services.signatures.listSignatureRequests(context, {
    status: optionalStringArrayArg(args, 'status') as typeof SIGNATURE_REQUEST_STATUSES[number][] | undefined,
    limit: limit + 1
  });
  const visible = listed.slice(0, limit);
  // ponytail: bounded to 20 details; add an owner-level batch projection only if measured query cost requires it.
  const details = await Promise.all(visible.map((request) => services.signatures.getSignatureRequest(context, request.id)));
  return {
    items: details.map(signatureData),
    count: details.length,
    truncated: listed.length > visible.length
  };
}

function signatureData(detail: SignatureDetail) {
  return {
    request: signatureRequestData(detail.request),
    session: {
      id: detail.session.id,
      status: detail.session.status,
      expiresAt: detail.session.expiresAt,
      dispatchedAt: detail.session.dispatchedAt,
      completedAt: detail.session.completedAt,
      cancelledAt: detail.session.cancelledAt,
      createdAt: detail.session.createdAt,
      updatedAt: detail.session.updatedAt
    },
    signers: detail.signers.slice(0, 50).map((signer) => ({
      id: signer.id,
      personId: signer.personId,
      displayName: signer.displayName,
      expectedOrganizationUnitId: signer.expectedOrganizationUnitId,
      status: signer.status,
      signedAt: signer.signedAt,
      revokedAt: signer.revokedAt
    })),
    positions: detail.positions.slice(0, 200).map((position) => ({
      signerId: position.signerId,
      page: position.page,
      x0: position.x0,
      y0: position.y0,
      x1: position.x1,
      y1: position.y1,
      strategy: position.strategy,
      label: position.label,
      required: position.required
    }))
  };
}

function signatureRequestData(request: SignatureRequest) {
  return {
    id: request.id,
    status: request.status,
    document: {
      title: safeModelText(request.document.title),
      description: safeModelText(request.document.description),
      originalFileName: safeModelText(request.document.originalFileName),
      originalExtension: request.document.originalExtension
    },
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    completedAt: request.completedAt,
    cancelledAt: request.cancelledAt
  };
}

function safeModelText(value: string | null) {
  if (value === null) return null;
  const redacted = redactSecrets(value);
  if (redacted !== value || /(?:bearer\s+\S+|(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|sig|signature)\s*[:=]\s*\S+|\/api\/files\/(?:public|preview)\/)/i.test(value)) {
    return '[REDACTED]';
  }
  return value;
}

function result(tool: PlatformMcpToolName, data: unknown): PlatformMcpToolResult {
  // Normalize domain Date/optional fields exactly once at the JSON protocol boundary.
  const structuredContent = JSON.parse(JSON.stringify(data));
  const output: PlatformMcpToolResult = {
    resultType: 'complete',
    content: [{ type: 'text', text: `${PLATFORM_MCP_TOOL_CATALOG.find((item) => item.name === tool)!.description}\n${JSON.stringify(structuredContent)}` }],
    structuredContent
  };
  assertPlatformMcpToolResult(output);
  return output;
}

export function validatePlatformMcpArguments(value: unknown, schema: PlatformMcpObjectSchema) {
  validateAgainstSchema(value, schema);
}

const platformOwnerCapabilities = new Set(['context','entity-resolution','responsibility','work-items','notifications','signatures']);
const forbiddenSchemaFields = new Set(MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS.map((field) => field.toLowerCase()));

function stableContributionId(value: unknown) {
  return typeof value === 'string' && value.length <= 100 && /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(value);
}

function validateToolOwner(value: unknown, path: string): asserts value is PlatformMcpToolOwner {
  if (!isRecord(value) || Object.keys(value).some((key) => !['type', 'id'].includes(key)) || !['platform_capability','application'].includes(String(value.type)) || typeof value.id !== 'string') {
    invalidContribution(path, '工具所有者无效');
  }
  if (value.type === 'platform_capability') {
    if (!platformOwnerCapabilities.has(value.id)) invalidContribution(`${path}.id`, '平台能力所有者不存在');
    return;
  }
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value.id) || value.id.length > 100) invalidContribution(`${path}.id`, '应用所有者 ID 无效');
}

function validateToolAnnotations(value: unknown, retryPolicy: unknown, path: string) {
  if (!isRecord(value)) invalidContribution(path, 'MCP Tool Annotations 无效');
  const allowedKeys = new Set(['readOnlyHint','destructiveHint','idempotentHint','openWorldHint']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) invalidContribution(path, 'Annotations 只能包含 MCP 标准字段');
  if (typeof value.readOnlyHint !== 'boolean' || value.destructiveHint !== false || typeof value.idempotentHint !== 'boolean' || value.openWorldHint !== false) {
    invalidContribution(path, 'Annotations 必须显式声明只读、非破坏、幂等和闭域 Hint');
  }
  if (!['inherent','required','not_retryable'].includes(String(retryPolicy))) invalidContribution(`${path.replace(/\.annotations$/, '')}.retryPolicy`, '重试策略无效');
  if (value.idempotentHint !== (retryPolicy !== 'not_retryable')) invalidContribution(path, 'idempotentHint 与重试策略不一致');
  if (value.readOnlyHint && retryPolicy !== 'inherent') invalidContribution(path, '只读工具必须使用 inherent 重试策略');
}

function validateSchemaContract(value: unknown, path: string, allowPattern: boolean): void {
  if (!isRecord(value) || !['object','array','string','number','integer','boolean'].includes(String(value.type))) invalidContribution(path, 'Schema 类型无效');
  const allowed: Record<string, readonly string[]> = {
    object: ['type', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'],
    array: ['type', 'items', 'minItems', 'maxItems', 'uniqueItems'],
    string: ['type', 'description', 'enum', 'pattern', 'minLength', 'maxLength'],
    number: ['type', 'description', 'enum', 'minimum', 'maximum'],
    integer: ['type', 'description', 'enum', 'minimum', 'maximum'],
    boolean: ['type', 'description']
  };
  if (Object.keys(value).some((key) => !allowed[String(value.type)].includes(key))) invalidContribution(path, 'Schema 含不支持的关键字');
  for (const [minKey, maxKey] of [['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minProperties', 'maxProperties']]) {
    for (const key of [minKey, maxKey]) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) invalidContribution(`${path}.${key}`, '数量边界必须是非负整数');
    if (value[minKey] !== undefined && value[maxKey] !== undefined && Number(value[minKey]) > Number(value[maxKey])) invalidContribution(path, '数量边界顺序无效');
  }
  if (value.description !== undefined && (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 300 || safeModelText(value.description) !== value.description)) invalidContribution(`${path}.description`, '字段描述无效或包含敏感内容');
  if (value.type === 'object') {
    if (value.additionalProperties !== false || !isRecord(value.properties)) invalidContribution(path, '对象 Schema 必须拒绝未知字段');
    const required = value.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string') || new Set(required).size !== required.length) invalidContribution(`${path}.required`, 'required 字段无效');
    for (const key of required) if (!Object.hasOwn(value.properties, key)) invalidContribution(`${path}.required`, `必填字段 ${key} 未定义`);
    for (const [key, child] of Object.entries(value.properties)) {
      const normalized = key.toLowerCase();
      if (forbiddenSchemaFields.has(normalized) || /(?:^|_)(?:token|secret|password|passwd|cookie|credential|authorization|access[_-]?key|api[_-]?key|private[_-]?key|signing[_-]?key|signed[_-]?url|trusted[_-]?identity|service[_-]?identity)(?:$|_)/i.test(key)) {
        invalidContribution(`${path}.properties.${key}`, 'Schema 不得暴露可信身份或凭证字段');
      }
      validateSchemaContract(child, `${path}.properties.${key}`, allowPattern);
    }
    return;
  }
  if (value.type === 'array') {
    if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean') invalidContribution(`${path}.uniqueItems`, 'uniqueItems 必须为布尔值');
    if (!Number.isSafeInteger(value.maxItems) || Number(value.maxItems) < 1 || Number(value.maxItems) > 100) invalidContribution(`${path}.maxItems`, '数组必须有 1 到 100 的上限');
    validateSchemaContract(value.items, `${path}.items`, allowPattern);
    return;
  }
  if (value.type === 'string') {
    if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some((item) => typeof item !== 'string' || item.length > 200 || safeModelText(item) !== item))) invalidContribution(`${path}.enum`, '字符串枚举无效');
    if (value.pattern !== undefined) {
      if (!allowPattern) invalidContribution(`${path}.pattern`, '应用贡献不能提供运行时正则表达式');
      if (value.pattern !== UUID_PATTERN && value.pattern !== ISO_INSTANT_PATTERN) invalidContribution(`${path}.pattern`, '仅支持平台已审计的 UUID 和时间格式');
    }
    if (value.enum === undefined && value.pattern === undefined && (!Number.isSafeInteger(value.maxLength) || Number(value.maxLength) < 1 || Number(value.maxLength) > 4_000)) invalidContribution(`${path}.maxLength`, '字符串必须有上限');
    return;
  }
  if (value.type === 'number' || value.type === 'integer') {
    if (typeof value.minimum !== 'number' || typeof value.maximum !== 'number' || !Number.isFinite(value.minimum) || !Number.isFinite(value.maximum) || value.minimum > value.maximum) invalidContribution(path, '数字 Schema 必须有有效范围');
    if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some((item) => typeof item !== 'number' || !Number.isFinite(item) || (value.type === 'integer' && !Number.isSafeInteger(item))))) invalidContribution(`${path}.enum`, '数字枚举无效');
  }
}

function validateAgainstSchema(value: unknown, schema: PlatformMcpSchema, path = '$'): void {
  if (schema.type === 'object') {
    if (!isRecord(value)) invalid(path, '必须是对象');
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) invalid(path, `至少需要 ${schema.minProperties} 个字段`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) invalid(path, `最多允许 ${schema.maxProperties} 个字段`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, '缺少必填字段');
    for (const key of keys) {
      const child = schema.properties[key];
      if (!child) invalid(`${path}.${key}`, '不允许未知字段');
      validateAgainstSchema(value[key], child, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) invalid(path, '必须是数组');
    if (schema.minItems !== undefined && value.length < schema.minItems) invalid(path, `至少需要 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) invalid(path, `最多允许 ${schema.maxItems} 项`);
    value.forEach((item, index) => validateAgainstSchema(item, schema.items, `${path}[${index}]`));
    if (schema.uniqueItems) {
      // JSON Schema equality ignores object property order, including nested objects.
      const canonicalItems = value.map((item) => JSON.stringify(item, (_key, child) => isRecord(child)
        ? Object.fromEntries(Object.entries(child).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : child));
      if (new Set(canonicalItems).size !== value.length) invalid(path, '数组项必须唯一');
    }
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') invalid(path, '必须是字符串');
    const length = [...value].length; // JSON Schema counts Unicode codepoints, not UTF-16 units.
    if (schema.minLength !== undefined && length < schema.minLength) invalid(path, `长度不能小于 ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) invalid(path, `长度不能大于 ${schema.maxLength}`);
    if (schema.enum && !schema.enum.includes(value)) invalid(path, '值不在允许范围内');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid(path, '格式无效');
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') invalid(path, '必须是布尔值');
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, '必须是有限数字');
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) invalid(path, '必须是安全整数');
  if (schema.minimum !== undefined && value < schema.minimum) invalid(path, `不能小于 ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) invalid(path, `不能大于 ${schema.maximum}`);
  if (schema.enum && !schema.enum.includes(value)) invalid(path, '值不在允许范围内');
}

function invalid(path: string, message: string): never {
  throw new PlatformMcpToolError('INVALID_ARGUMENTS', `工具参数 ${path} ${message}`, path);
}

function invalidContribution(path: string, message: string): never {
  throw new PlatformMcpToolError('INVALID_CONTRIBUTION', `MCP 贡献 ${path} ${message}`, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringArg(args: Record<string, unknown>, key: string) {
  return args[key] as string;
}

function optionalStringArg(args: Record<string, unknown>, key: string) {
  return args[key] as string | undefined;
}

function numberArg(args: Record<string, unknown>, key: string) {
  return args[key] as number;
}

function optionalNumberArg(args: Record<string, unknown>, key: string) {
  return args[key] as number | undefined;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string) {
  return args[key] as boolean | undefined;
}

function optionalStringArrayArg(args: Record<string, unknown>, key: string) {
  return args[key] as string[] | undefined;
}

function optionalObjectArg(args: Record<string, unknown>, key: string) {
  return args[key] as Record<string, unknown> | undefined;
}

function optionalObjectArrayArg(args: Record<string, unknown>, key: string) {
  return args[key] as Record<string, unknown>[] | undefined;
}

function parseInstant(value: string, path: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) invalid(path, '不是有效时间');
  return date;
}
