import { MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS } from '../../identity/index.js';

export const MCP_REQUEST_TIMEOUT_MS = 60_000;

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface OpenAiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CoreMcpToolPolicy {
  readonly allowedToolNames: ReadonlySet<string>;
  readonly transformSchema?: (
    tool: McpToolDefinition,
    schema: Record<string, unknown>
  ) => Record<string, unknown>;
  readonly describeTool?: (tool: McpToolDefinition) => string;
  readonly validateCall?: (name: string, args: Record<string, unknown>) => void;
}

export class CoreMcpTransportError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, options: { code?: string; statusCode?: number } = {}) {
    super(message);
    this.name = 'CoreMcpTransportError';
    this.code = options.code ?? 'MCP_TRANSPORT_ERROR';
    this.statusCode = options.statusCode ?? 502;
  }
}

export function sanitizeMcpToolSchema(schema: Record<string, unknown> = {}): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const identityFields = new Set<string>(MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS);
  if (cloned.properties && typeof cloned.properties === 'object') {
    const properties = cloned.properties as Record<string, unknown>;
    for (const field of identityFields) delete properties[field];
  }
  if (Array.isArray(cloned.required)) {
    cloned.required = cloned.required.filter((field) => typeof field !== 'string' || !identityFields.has(field));
  }
  delete cloned.anyOf;
  return cloned;
}

export function toOpenAiTools(
  tools: McpToolDefinition[],
  policy: CoreMcpToolPolicy
): OpenAiToolDefinition[] {
  return tools
    .filter((tool) => policy.allowedToolNames.has(tool.name))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: policy.describeTool?.(tool) ?? tool.description ?? tool.name,
        parameters: policy.transformSchema?.(tool, sanitizeMcpToolSchema(tool.inputSchema))
          ?? sanitizeMcpToolSchema(tool.inputSchema)
      }
    }));
}
