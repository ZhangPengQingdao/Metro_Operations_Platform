import type { PlatformActorContext } from '../context/index.js';
import type { CallToolResult, Tool } from '../../core/integrations/mcp/index.js';

export const PLATFORM_MCP_CONTRACT_VERSION = '2.0' as const;
export const PLATFORM_MCP_UI_MIME_TYPE = 'text/html;profile=mcp-app' as const;
export const PLATFORM_MCP_UI_EXTENSION = 'io.modelcontextprotocol/ui' as const;

export interface PlatformMcpUiMetadata {
  csp?: { connectDomains?: readonly string[]; resourceDomains?: readonly string[]; frameDomains?: readonly string[]; baseUriDomains?: readonly string[] };
  permissions?: { camera?: Record<string, never>; microphone?: Record<string, never>; geolocation?: Record<string, never>; clipboardWrite?: Record<string, never> };
  domain?: string;
  prefersBorder?: boolean;
}

/** Static declaration only. L4 must enforce isolation before rendering any HTML. */
export interface PlatformMcpUiResource {
  owner: PlatformMcpToolOwner;
  uri: string;
  name: string;
  title?: string;
  mimeType: typeof PLATFORM_MCP_UI_MIME_TYPE;
  html: string;
  sha256: string;
  _meta?: { ui: PlatformMcpUiMetadata };
}

export const PLATFORM_MCP_PERMISSION_CODES = {
  use: 'platform.mcp.use'
} as const;

export const PLATFORM_MCP_PERMISSION_SEEDS = [
  {
    id: '4b000000-0000-4000-8000-000000000001',
    code: PLATFORM_MCP_PERMISSION_CODES.use,
    name: '调用平台 MCP 工具'
  }
] as const;

export const PLATFORM_MCP_TOOL_NAMES = [
  'platform_get_current_actor',
  'platform_search_people',
  'platform_search_organizations',
  'platform_search_locations',
  'platform_search_assets',
  'platform_list_my_responsibilities',
  'platform_list_work_items',
  'platform_get_work_item',
  'platform_create_work_item',
  'platform_update_work_item_progress',
  'platform_complete_work_item',
  'platform_list_notifications',
  'platform_get_notification',
  'platform_mark_notification_read',
  'platform_list_signature_requests',
  'platform_get_signature_status'
] as const;

export type PlatformMcpToolName = typeof PLATFORM_MCP_TOOL_NAMES[number];
export type PlatformMcpOwnerCapability =
  | 'context'
  | 'entity-resolution'
  | 'responsibility'
  | 'work-items'
  | 'notifications'
  | 'signatures';

export type PlatformMcpSchema =
  | PlatformMcpObjectSchema
  | PlatformMcpArraySchema
  | PlatformMcpStringSchema
  | PlatformMcpNumberSchema
  | PlatformMcpBooleanSchema;

export interface PlatformMcpObjectSchema {
  type: 'object';
  properties: Readonly<Record<string, PlatformMcpSchema>>;
  required?: readonly string[];
  additionalProperties: false;
  minProperties?: number;
  maxProperties?: number;
}

export interface PlatformMcpArraySchema {
  type: 'array';
  items: PlatformMcpSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface PlatformMcpStringSchema {
  type: 'string';
  description?: string;
  enum?: readonly string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface PlatformMcpNumberSchema {
  type: 'number' | 'integer';
  description?: string;
  enum?: readonly number[];
  minimum?: number;
  maximum?: number;
}

export interface PlatformMcpBooleanSchema {
  type: 'boolean';
  description?: string;
}

export type PlatformMcpToolOwner =
  | { type: 'platform_capability'; id: PlatformMcpOwnerCapability }
  | { type: 'application'; id: string };

export interface PlatformMcpToolDescriptor<TName extends string = string> {
  name: TName;
  contractVersion: typeof PLATFORM_MCP_CONTRACT_VERSION;
  owner: PlatformMcpToolOwner;
  description: string;
  title?: string;
  icons?: Tool['icons'];
  execution?: Tool['execution'];
  _meta?: { ui: { resourceUri?: string; visibility?: readonly ('model' | 'app')[] } };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: false;
    idempotentHint: boolean;
    openWorldHint: false;
  };
  retryPolicy: 'inherent' | 'required' | 'not_retryable';
  resultPolicy: { bounded: true };
  permissionPolicy: {
    gatewayPermission: typeof PLATFORM_MCP_PERMISSION_CODES.use;
    businessAuthorization: 'gateway_only' | 'self_bound' | 'delegated_to_owner';
  };
  inputSchema: PlatformMcpObjectSchema;
  outputSchema?: PlatformMcpObjectSchema;
}

export type PlatformMcpToolResult = CallToolResult & { resultType: 'complete' };

export interface PlatformMcpActorData {
  actorType: PlatformActorContext['actorType'];
  source: PlatformActorContext['trustedIdentity']['source'];
  execution: { type: PlatformActorContext['execution']['type']; appId?: string };
  person?: {
    id: string;
    employeeNo: string;
    name: string;
    organization: { id: string; code: string; name: string; unitType: string };
    position: { id: string; code: string; name: string };
  };
}

export interface PlatformMcpToolContribution<TName extends string = string> {
  id: string;
  contractVersion: typeof PLATFORM_MCP_CONTRACT_VERSION;
  tools: readonly PlatformMcpToolDescriptor<TName>[];
  resources?: readonly PlatformMcpUiResource[];
  callTool(context: PlatformActorContext, name: string, args: unknown): Promise<PlatformMcpToolResult>;
}

export type PlatformMcpToolErrorCode =
  | 'INVALID_CONTRIBUTION'
  | 'INVALID_RESULT'
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS'
  | 'MCP_USE_DENIED'
  | 'PERSON_ACTOR_REQUIRED';

export class PlatformMcpToolError extends Error {
  readonly code: PlatformMcpToolErrorCode;
  readonly path?: string;

  constructor(code: PlatformMcpToolErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'PlatformMcpToolError';
    this.code = code;
    this.path = path;
  }
}
