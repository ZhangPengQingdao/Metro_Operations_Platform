import { createHash } from 'node:crypto';
import { CallToolResultSchema, ResourceSchema, ToolSchema, type CoreMcpToolRegistration, type JsonSchemaType } from '../../core/integrations/mcp/index.js';
import { MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS } from '../../core/identity/index.js';
import { redactSecrets } from '../../core/security/index.js';
import {
  PLATFORM_MCP_UI_MIME_TYPE, PlatformMcpToolError,
  type PlatformMcpSchema, type PlatformMcpToolDescriptor, type PlatformMcpToolResult, type PlatformMcpUiResource
} from './model.js';

export const PLATFORM_MCP_LIMITS = {
  descriptorBytes: 32_768, resultBytes: 262_144, htmlBytes: 262_144,
  totalHtmlBytes: 1_048_576, resources: 32, contentBlocks: 100, depth: 16, nodes: 20_000
} as const;

const secretKey = /(?:^|[_-])(?:token|secret|password|passwd|cookie|credential|authorization|api[_-]?key|private[_-]?key|signing[_-]?key|signed[_-]?url)(?:$|[_-])/i;
const forbiddenIdentityKeys = new Set([...MODEL_VISIBLE_TRUSTED_IDENTITY_FIELDS.filter((key) => key.startsWith('actor_')), 'trustedIdentity', 'serviceIdentity', 'serviceIdentityId'].map((key) => key.toLowerCase()));
const secretText = /(?:bearer\s+\S+|["']?(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|sig|signature)["']?\s*[:=]\s*["']?[^\s"'<>]+|\/api\/files\/(?:public|preview)\/)/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function fail(path: string, message: string, code: 'INVALID_CONTRIBUTION' | 'INVALID_RESULT' = 'INVALID_CONTRIBUTION'): never {
  throw new PlatformMcpToolError(code, `${path}: ${message}`, path);
}

/** Bounds run before codecs/stringification; reject cycles, custom prototypes and credentials. */
export function assertMcpSafeJson(value: unknown, maxBytes: number, code: 'INVALID_CONTRIBUTION' | 'INVALID_RESULT' = 'INVALID_CONTRIBUTION') {
  let nodes = 0;
  let minimumBytes = 0;
  const active = new Set<object>();
  function account(bytes: number, path: string) {
    minimumBytes += bytes;
    if (minimumBytes > maxBytes) fail(path, 'JSON byte limit exceeded', code);
  }
  function visit(item: unknown, path: string, depth: number) {
    if (++nodes > PLATFORM_MCP_LIMITS.nodes || depth > PLATFORM_MCP_LIMITS.depth) fail(path, 'JSON nesting/entry limit exceeded', code);
    if (typeof item === 'string') {
      account(Buffer.byteLength(item) + 2, path);
      if (Buffer.byteLength(item) > maxBytes || redactSecrets(item) !== item || secretText.test(item)) fail(path, 'Oversized or sensitive text', code);
      for (const match of item.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        let url: URL;
        try { url = new URL(match[0]); } catch { continue; }
        if (url.username || url.password || [...url.searchParams.keys()].some((key) => secretKey.test(key) || /^(?:sig|signature)$/i.test(key))) fail(path, 'Credential-bearing URL', code);
      }
      return;
    }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      account(String(item).length, path);
      return;
    }
    if (!Array.isArray(item) && !record(item)) fail(path, 'Expected plain JSON', code);
    if (Array.isArray(item) && (item.length > PLATFORM_MCP_LIMITS.nodes || Object.keys(item).length !== item.length
      || Object.keys(item).some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) fail(path, 'Expected a bounded dense JSON array', code);
    if (active.has(item)) fail(path, 'Cyclic JSON', code);
    active.add(item);
    account(2, path);
    for (const [key, child] of Object.entries(item)) {
      if (!Array.isArray(item)) account(Buffer.byteLength(key) + 3, path);
      if (['__proto__', 'prototype', 'constructor'].includes(key) || forbiddenIdentityKeys.has(key.toLowerCase()) || secretKey.test(key.replace(/([a-z])([A-Z])/g, '$1_$2'))) fail(path, 'Forbidden JSON field', code);
      visit(child, `${path}.${key}`, depth + 1);
    }
    active.delete(item);
  }
  visit(value, '$', 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) fail('$', 'JSON byte limit exceeded', code);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(path, 'Unsupported field');
}

function origin(value: unknown, path: string) {
  if (typeof value !== 'string' || value.length > 300) fail(path, 'Expected exact HTTPS origin');
  let parsed: URL;
  try { parsed = new URL(value); } catch { fail(path, 'Invalid origin'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== value || value.includes('*')) fail(path, 'Expected canonical exact HTTPS origin without credentials, path or wildcard');
}

export function assertMcpUiResources(value: unknown, tools: readonly PlatformMcpToolDescriptor[]): asserts value is readonly PlatformMcpUiResource[] {
  if (!Array.isArray(value) || value.length > PLATFORM_MCP_LIMITS.resources) fail('$.resources', 'Resource count exceeds limit');
  let totalBytes = 0;
  const uris = new Set<string>();
  value.forEach((resource, index) => {
    const path = `$.resources[${index}]`;
    if (!record(resource)) fail(path, 'Expected resource declaration');
    onlyKeys(resource, ['owner', 'uri', 'name', 'title', 'mimeType', 'html', 'sha256', '_meta'], path);
    assertMcpSafeJson(resource, PLATFORM_MCP_LIMITS.htmlBytes + PLATFORM_MCP_LIMITS.descriptorBytes);
    const { html: _html, ...descriptor } = resource;
    assertMcpSafeJson(descriptor, PLATFORM_MCP_LIMITS.descriptorBytes);
    if (!record(resource.owner) || !['application', 'platform_capability'].includes(String(resource.owner.type)) || typeof resource.owner.id !== 'string') fail(path, 'Invalid resource owner');
    const owner = resource.owner;
    // Owner is in the path, never the hostname: app IDs containing dots remain unambiguous.
    const namespace = `ui://${owner.type === 'application' ? 'app' : 'platform'}/${owner.id}/`;
    if (typeof resource.uri !== 'string' || !resource.uri.startsWith(namespace) || !/^ui:\/\/(?:app|platform)\/[a-z][a-z0-9._-]*\/[a-z][a-z0-9_-]*\/[1-9][0-9]*\.html$/.test(resource.uri) || new URL(resource.uri).href !== resource.uri) fail(`${path}.uri`, 'Expected owned canonical versioned UI URI');
    if (uris.has(resource.uri)) fail(`${path}.uri`, 'Duplicate resource URI');
    uris.add(resource.uri);
    if (resource.mimeType !== PLATFORM_MCP_UI_MIME_TYPE || typeof resource.html !== 'string' || !resource.html.trim()) fail(path, 'Expected static MCP App HTML');
    // Packaging check only, not HTML sanitization or proof that scripts are safe.
    if (!/^\s*<!doctype html>\s*<html(?:\s[^>]*)?>[\s\S]*<\/html>\s*$/i.test(resource.html)) fail(path, 'Expected an HTML5 document with an html root');
    const bytes = Buffer.byteLength(resource.html, 'utf8');
    if (bytes > PLATFORM_MCP_LIMITS.htmlBytes) fail(path, 'HTML byte limit exceeded');
    totalBytes += bytes;
    if (totalBytes > PLATFORM_MCP_LIMITS.totalHtmlBytes) fail(path, 'Contribution HTML byte limit exceeded');
    if (resource.sha256 !== createHash('sha256').update(resource.html, 'utf8').digest('hex')) fail(`${path}.sha256`, 'HTML SHA-256 mismatch');
    if (!ResourceSchema.safeParse({ uri: resource.uri, name: resource.name, title: resource.title, mimeType: resource.mimeType }).success || typeof resource.name !== 'string' || !resource.name.trim() || resource.name.length > 100 || (resource.title !== undefined && (typeof resource.title !== 'string' || !resource.title.trim() || resource.title.length > 200))) fail(path, 'Invalid resource descriptor');
    if (resource._meta !== undefined) {
      if (!record(resource._meta)) fail(`${path}._meta`, 'Invalid metadata');
      onlyKeys(resource._meta, ['ui'], `${path}._meta`);
      const ui = resource._meta.ui;
      if (!record(ui)) fail(`${path}._meta.ui`, 'Invalid UI metadata');
      onlyKeys(ui, ['csp', 'permissions', 'domain', 'prefersBorder'], path);
      if (ui.domain !== undefined) origin(ui.domain, `${path}.domain`);
      if (ui.prefersBorder !== undefined && typeof ui.prefersBorder !== 'boolean') fail(path, 'Invalid border preference');
      if (ui.csp !== undefined) {
        if (!record(ui.csp)) fail(path, 'Invalid CSP declaration');
        onlyKeys(ui.csp, ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'], path);
        for (const [key, domains] of Object.entries(ui.csp)) {
          if (!Array.isArray(domains) || domains.length > 20 || new Set(domains).size !== domains.length) fail(path, 'Invalid CSP origin list');
          domains.forEach((domain) => origin(domain, `${path}.csp.${key}`));
        }
      }
      if (ui.permissions !== undefined) {
        if (!record(ui.permissions)) fail(path, 'Invalid permission requests');
        onlyKeys(ui.permissions, ['camera', 'microphone', 'geolocation', 'clipboardWrite'], path);
        if (Object.values(ui.permissions).some((entry) => !record(entry) || Object.keys(entry).length !== 0)) fail(path, 'Permission requests must be empty objects, not grants');
      }
    }
    if (!tools.some((tool) => tool._meta?.ui.resourceUri === resource.uri && tool.owner.type === owner.type && tool.owner.id === owner.id)) fail(path, 'Resource must be linked by a same-owner tool in this contribution');
  });
  for (const tool of tools) {
    if (!tool._meta?.ui.resourceUri) continue;
    const linked = value.find((resource) => resource.uri === tool._meta!.ui.resourceUri);
    if (!linked || linked.owner.type !== tool.owner.type || linked.owner.id !== tool.owner.id) fail('$.tools._meta.ui.resourceUri', 'Linked resource must exist in this contribution and belong to the tool owner');
  }
}

/** Explicit projection prevents platform policy fields leaking into protocol Tool metadata. */
export function toPlatformMcpProtocolTool(tool: PlatformMcpToolDescriptor): CoreMcpToolRegistration['definition'] {
  const definition = {
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.icons === undefined ? {} : { icons: tool.icons }),
    ...(tool.execution === undefined ? {} : { execution: tool.execution }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool._meta === undefined ? {} : { _meta: tool._meta })
  };
  const parsed = ToolSchema.safeParse(definition);
  if (!parsed.success) fail('$.tools', 'Invalid standard Tool descriptor');
  return structuredClone({ ...parsed.data, inputSchema: toJsonSchema(tool.inputSchema), ...(tool.outputSchema ? { outputSchema: toJsonSchema(tool.outputSchema) } : {}) });
}

function toJsonSchema(schema: PlatformMcpSchema): JsonSchemaType {
  if (schema.type === 'object') return { ...schema, required: schema.required ? [...schema.required] : undefined, properties: Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, toJsonSchema(child)])) };
  if (schema.type === 'array') return { ...schema, items: toJsonSchema(schema.items) };
  if (schema.type === 'boolean') return { ...schema };
  return { ...schema, enum: schema.enum ? [...schema.enum] : undefined };
}

export function assertMcpToolMetadata(tool: PlatformMcpToolDescriptor) {
  onlyKeys(tool as unknown as Record<string, unknown>, ['name', 'contractVersion', 'owner', 'description', 'title', 'icons', 'execution', '_meta', 'annotations', 'retryPolicy', 'resultPolicy', 'permissionPolicy', 'inputSchema', 'outputSchema'], '$.tools');
  const { permissionPolicy: _permissionPolicy, ...metadata } = tool;
  assertMcpSafeJson(metadata, PLATFORM_MCP_LIMITS.descriptorBytes);
  toPlatformMcpProtocolTool(tool);
  if (tool.title !== undefined && (!tool.title.trim() || tool.title.length > 200)) fail('$.title', 'Invalid title');
  if (tool.execution !== undefined && (Object.keys(tool.execution).some((key) => key !== 'taskSupport') || tool.execution.taskSupport !== 'forbidden')) fail('$.execution', 'Tasks are not implemented; only taskSupport forbidden is supported');
  if (tool.icons) {
    if (tool.icons.length > 8) fail('$.icons', 'Too many icons');
    for (const icon of tool.icons) {
      let url: URL;
      try { url = new URL(icon.src); } catch { fail('$.icons', 'Invalid icon URL'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('$.icons', 'Icons require credential-free HTTPS URLs without query/fragment');
    }
  }
  if (tool._meta !== undefined) {
    if (!record(tool._meta)) fail('$._meta', 'Invalid metadata');
    onlyKeys(tool._meta, ['ui'], '$._meta');
    const ui = tool._meta.ui;
    if (!record(ui)) fail('$._meta.ui', 'Invalid UI metadata');
    onlyKeys(ui, ['resourceUri', 'visibility'], '$._meta.ui');
    if (ui.resourceUri !== undefined && (typeof ui.resourceUri !== 'string' || !ui.resourceUri.trim())) fail('$._meta.ui.resourceUri', 'Invalid UI resource URI');
    if (ui.resourceUri === undefined && ui.visibility === undefined) fail('$._meta.ui', 'UI metadata must declare resourceUri or visibility');
    if (ui.visibility !== undefined && (!Array.isArray(ui.visibility) || ui.visibility.length === 0 || ui.visibility.length > 2 || new Set(ui.visibility).size !== ui.visibility.length || ui.visibility.some((item) => !['model', 'app'].includes(item)))) fail('$._meta.ui.visibility', 'Invalid model/app visibility');
  }
}

export function assertPlatformMcpToolResult(value: unknown): asserts value is PlatformMcpToolResult {
  assertMcpSafeJson(value, PLATFORM_MCP_LIMITS.resultBytes, 'INVALID_RESULT');
  if (!record(value)) fail('$', 'Expected result object', 'INVALID_RESULT');
  if (Object.keys(value).some((key) => !['resultType', 'content', 'structuredContent', 'isError', '_meta'].includes(key))) fail('$', 'Unsupported result field', 'INVALID_RESULT');
  if (!CallToolResultSchema.safeParse(value).success || value.resultType !== 'complete') fail('$', 'Expected standard complete CallToolResult', 'INVALID_RESULT');
  if (!Array.isArray(value.content) || value.content.length > PLATFORM_MCP_LIMITS.contentBlocks || !value.content.some((block) => record(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)) fail('$.content', 'Meaningful text fallback required', 'INVALID_RESULT');
  if (record(value._meta) && ('ui' in value._meta || Object.keys(value._meta).some((key) => key.startsWith('io.modelcontextprotocol/')))) fail('$._meta', 'Result cannot override UI or wire-owned metadata', 'INVALID_RESULT');
  for (const block of value.content) {
    if (!record(block)) continue;
    if (record(block._meta) && 'ui' in block._meta) fail('$.content._meta', 'UI linkage belongs to the descriptor', 'INVALID_RESULT');
    const resource = block.type === 'resource' && record(block.resource) ? block.resource : block.type === 'resource_link' ? block : undefined;
    if (resource && (String(resource.uri).toLowerCase().startsWith('ui:') || String(resource.mimeType).toLowerCase().includes('text/html') || (record(resource._meta) && 'ui' in resource._meta))) fail('$.content', 'App HTML and UI links must use registered static resources', 'INVALID_RESULT');
  }
}
