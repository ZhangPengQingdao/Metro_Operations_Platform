import { z } from 'zod';
import { isIP } from 'node:net';
import type { AppManifest, AppManifestHost, AppManifestIssue, AppManifestValidationResult } from '@metro/platform-sdk/app-manifest';

export type { AppManifest, AppManifestHost, AppManifestIssue, AppManifestValidationResult };
export const MAX_APP_MANIFEST_BYTES = 262_144;
const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const label = z.string().min(1).max(128).refine((s) => s.trim() === s && !/[\x00-\x1f\x7f]/.test(s));
const description = z.string().min(1).max(1024).refine((s) => s.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s));
const version = z.string().max(96).regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/)
  .refine((s) => !(s.split('-').slice(1).join('-').split('.').some((p) => /^0\d+$/.test(p))), 'Numeric prerelease identifiers cannot have leading zeros');
const contractVersion = z.string().max(20).regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const code = z.string().max(192).regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/);
const event = z.string().max(192).regex(/^(?:platform|app)\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d{0,5}$/);
const relativePath = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*(?:\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)*$/);
const routePath = z.string().max(256).refine((s) => s === '/' || /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(s), 'Expected canonical app-relative route');
const origin = z.string().max(256).refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.origin === s && !u.username && !u.password
      && !isIP(u.hostname) && u.hostname.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
      && u.hostname.includes('.') && !/\.(?:localhost|local|internal)$/.test(u.hostname);
  } catch { return false; }
}, 'Expected canonical HTTPS origin without credentials, path, query or fragment');
const list = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).max(128);
const range = z.object({ minInclusive: version, maxExclusive: version }).strict()
  .refine((r) => compareVersions(r.minInclusive, r.maxExclusive) < 0, 'Version range must be nonempty');
const none = z.object({ mode: z.literal('none') }).strict();
const hosted = (mode: 'trusted' | 'isolated') => z.object({
  mode: z.literal(mode), runtime: z.literal('node'), entryArtifactId: id,
  limits: z.object({ memoryMiB: z.number().int().min(16).max(65536), cpuMillis: z.number().int().min(100).max(64000), timeoutSeconds: z.number().int().min(1).max(3600) }).strict()
}).strict();
const schema = z.object({
  manifestVersion: z.literal('1.0'), id, version, name: label, description, publisherId: id,
  icon: z.object({paths:z.array(z.string().min(1).max(2048).regex(/^[MmZzLlHhVvCcSsQqTtAa0-9.,+eE\s-]+$/)).min(1).max(16)}).strict().optional(),
  compatibility: z.object({ platform: range,
    capabilities: list(z.object({ id, contractVersion }).strict()),
    applications: list(z.object({ id, version: range }).strict())
  }).strict(),
  permissions: z.object({ requested: list(code), defined: list(z.object({ code, description, scopeKinds:z.array(z.enum(['self','workgroup','department','organizations','all'])).min(1).max(5).optional() }).strict()) }).strict(),
  ui: z.discriminatedUnion('mode', [none,
    z.object({ mode: z.literal('sandbox'), entryArtifactId: id, clientRouting:z.literal(true).optional() }).strict(),
    z.object({ mode: z.literal('trusted'), entryArtifactId: id }).strict()]),
  backend: z.discriminatedUnion('mode', [none, hosted('trusted'), hosted('isolated'), z.object({ mode: z.literal('external'), origin }).strict()]),
  storage: z.discriminatedUnion('mode', [none,
    z.object({ mode: z.literal('managed'), migrations: list(z.object({ id, artifactId: id }).strict()) }).strict(),
    z.object({ mode: z.literal('external'), configurationRef: id }).strict()]),
  routes: list(z.object({ id, path: routePath, permission: code.optional() }).strict()),
  api: list(z.object({ id, method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: routePath, handler: id, permission: code.optional(), businessPermission:code.optional(), businessEntry:z.literal(true).optional() }).strict()),
  navigation: list(z.object({ id, label, routeId: id, order: z.number().int().min(0).max(10000) }).strict()),
  events: z.object({ publish: list(event), subscribe: list(z.object({ event, handler: id }).strict()) }).strict(),
  tools: list(z.object({ name: id, contributionArtifactId: id, uiResourceId: id.optional() }).strict()),
  jobs: list(z.object({ id, handler: id, intervalSeconds: z.number().int().min(60).max(31_536_000) }).strict()),
  network: z.object({ frontendOrigins: list(origin), backendOrigins: list(origin) }).strict(),
  health: z.object({ path: routePath, timeoutSeconds: z.number().int().min(1).max(60) }).strict().optional(),
  resources: list(z.object({ id, artifactId: id, kind: z.enum(['asset', 'mcp-ui']) }).strict()),
  artifacts: list(z.object({ id, kind: z.enum(['frontend', 'backend', 'migration', 'mcp-contribution', 'resource']), path: relativePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(1_073_741_824) }).strict())
}).strict();

/** Input versions are schema-validated first. No numeric conversion of prerelease identifiers. */
function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const i = v.indexOf('-'); return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)]; };
  const [ac, ap] = split(a); const [bc, bp] = split(b);
  const av = ac.split('.').map(Number); const bv = bc.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] < bv[i] ? -1 : 1;
  if (ap === bp) return 0;
  if (!ap || !bp) return !ap ? 1 : -1;
  const aa = ap.split('.'); const ba = bp.split('.');
  for (let i = 0; i < Math.max(aa.length, ba.length); i++) {
    if (aa[i] === undefined || ba[i] === undefined) return aa[i] === undefined ? -1 : 1;
    if (aa[i] === ba[i]) continue;
    const an = /^\d+$/.test(aa[i]); const bn = /^\d+$/.test(ba[i]);
    if (an !== bn) return an ? -1 : 1;
    if (an && aa[i].length !== ba[i].length) return aa[i].length < ba[i].length ? -1 : 1;
    return aa[i] < ba[i] ? -1 : 1;
  }
  return 0;
}

function crossChecks(m: AppManifest): AppManifestIssue[] {
  const issues: AppManifestIssue[] = [];
  const fail = (path: string, message: string) => issues.push({ path, code: 'INVALID_REFERENCE', message });
  const unique = (values: string[], path: string) => { if (new Set(values).size !== values.length) fail(path, 'Duplicate declaration'); };
  for (const [path, values] of Object.entries({
    'compatibility.capabilities': m.compatibility.capabilities.map((x) => x.id),
    'compatibility.applications': m.compatibility.applications.map((x) => x.id),
    'permissions.requested': m.permissions.requested, 'permissions.defined': m.permissions.defined.map((x) => x.code),
    routes: m.routes.map((x) => x.id), 'routes.path': m.routes.map((x) => x.path),
    api: m.api.map((x) => x.id), 'api.endpoint': m.api.map((x) => x.method + ' ' + x.path),
    navigation: m.navigation.map((x) => x.id), 'events.publish': m.events.publish,
    'events.subscribe': m.events.subscribe.map((x) => x.event), tools: m.tools.map((x) => x.name),
    jobs: m.jobs.map((x) => x.id), resources: m.resources.map((x) => x.id), artifacts: m.artifacts.map((x) => x.id),
    'artifacts.path': m.artifacts.map((x) => x.path.toLowerCase()),
    'network.frontendOrigins': m.network.frontendOrigins, 'network.backendOrigins': m.network.backendOrigins
  })) unique(values, path);
  if (m.compatibility.applications.some((x) => x.id === m.id)) fail('compatibility.applications', 'Application cannot depend on itself');
  const prefix = `app.${m.id}.`;
  if (m.permissions.defined.some((x) => !x.code.startsWith(prefix))) fail('permissions.defined', 'Defined permissions must belong to this application');
  if (m.events.publish.some((x) => !x.startsWith(prefix))) fail('events.publish', 'Published events must belong to this application');
  const permissions = new Set([...m.permissions.requested, ...m.permissions.defined.map((x) => x.code)]);
  if (m.routes.some((x) => x.permission && !permissions.has(x.permission))) fail('routes', 'Route permission must be declared');
  if (m.api.some(x=>x.businessPermission&&(!m.permissions.defined.some(p=>p.code===x.businessPermission)||x.businessEntry))) fail('api','Business permission must be application-defined and not an entry');
  if (m.api.some((x) => x.permission && !permissions.has(x.permission))) fail('api', 'API permission must be declared');
  if (m.backend.mode === 'none' && m.api.length) fail('api', 'API declarations require a backend runtime');
  if (m.navigation.some((x) => !m.routes.some((r) => r.id === x.routeId))) fail('navigation', 'Navigation must reference a declared route');
  const usedArtifacts = new Set<string>();
  const artifact = (artifactId: string, kind: AppManifest['artifacts'][number]['kind'], path: string) => {
    usedArtifacts.add(artifactId);
    if (!m.artifacts.some((x) => x.id === artifactId && x.kind === kind)) fail(path, 'Missing artifact or wrong artifact kind');
  };
  if (m.ui.mode !== 'none') artifact(m.ui.entryArtifactId, 'frontend', 'ui.entryArtifactId');
  else if (m.routes.length || m.navigation.length || m.network.frontendOrigins.length) fail('ui', 'UI declarations require a UI runtime');
  if (m.backend.mode === 'trusted' || m.backend.mode === 'isolated') artifact(m.backend.entryArtifactId, 'backend', 'backend.entryArtifactId');
  if (m.backend.mode === 'none' && (m.storage.mode !== 'none' || m.jobs.length || m.events.publish.length || m.events.subscribe.length || m.tools.length || m.health || m.network.backendOrigins.length)) fail('backend', 'Backend declarations require a backend runtime');
  if (m.storage.mode === 'managed') {
    unique(m.storage.migrations.map((x) => x.id), 'storage.migrations');
    unique(m.storage.migrations.map((x) => x.artifactId), 'storage.migrations.artifactId');
    for (const migration of m.storage.migrations) {
      artifact(migration.artifactId, 'migration', 'storage.migrations');
      if (!m.artifacts.find(x => x.id === migration.artifactId)?.path.endsWith('.json')) fail('storage.migrations', 'Migration artifacts must be declarative JSON');
    }
  } else if (m.artifacts.some((x) => x.kind === 'migration')) fail('artifacts', 'Migration artifacts require managed storage');
  for (const resource of m.resources) artifact(resource.artifactId, 'resource', 'resources');
  for (const tool of m.tools) {
    artifact(tool.contributionArtifactId, 'mcp-contribution', 'tools');
    if (tool.uiResourceId && !m.resources.some((x) => x.id === tool.uiResourceId && x.kind === 'mcp-ui')) fail('tools', 'Tool UI must reference a declared MCP UI resource');
  }
  if (m.artifacts.some((x) => !usedArtifacts.has(x.id))) fail('artifacts', 'Every artifact must be referenced by a declaration');
  if (m.tools.length && !m.compatibility.capabilities.some((x) => x.id === 'platform-mcp' && x.contractVersion === '2.0')) fail('compatibility.capabilities', 'MCP tools require platform-mcp contract 2.0');
  return issues;
}

/** Bound object callers as well as JSON callers before Zod traverses arrays or copies strings. */
function isBoundedJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0; let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > 12000 || current.depth > 12) return false;
    const v = current.value;
    if (typeof v === 'string') bytes += Buffer.byteLength(v, 'utf8');
    else if (v !== null && typeof v === 'object') {
      if (seen.has(v) || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) return false;
      seen.add(v);
      if (Array.isArray(v) && (Object.getPrototypeOf(v) !== Array.prototype || v.length > 128)) return false;
      const keys = Object.getOwnPropertyNames(v).filter((key) => !(Array.isArray(v) && key === 'length'));
      if (Object.getOwnPropertySymbols(v).length) return false;
      if (Array.isArray(v) && (keys.length !== v.length || keys.some((key, i) => key !== String(i)))) return false;
      if (keys.length > 128) return false;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
        bytes += Buffer.byteLength(key, 'utf8');
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } else if (v !== null && typeof v !== 'number' && typeof v !== 'boolean') return false;
    if (bytes > MAX_APP_MANIFEST_BYTES) return false;
  }
  return true;
}

/** Pure declaration validation. Does not verify bytes, credentials, trust, DNS, grants or executable code. */
export function validateAppManifest(value: unknown): AppManifestValidationResult {
  if (!isBoundedJson(value)) return { ok: false, issues: [{ path: '', code: 'INVALID_MANIFEST', message: 'Expected bounded JSON-compatible manifest' }] };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, 128).map((issue) => ({ path: issue.path.join('.'), code: 'INVALID_MANIFEST', message: 'Invalid or unsupported declaration' })) };
  // Only after successful strict schema parsing. Zod 3 marks required properties optional
  // under the legacy frontend's strictNullChecks:false; the server build uses strict mode.
  const manifest = parsed.data as AppManifest;
  const issues = crossChecks(manifest);
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_APP_MANIFEST_BYTES) issues.push({ path: '', code: 'MANIFEST_TOO_LARGE', message: 'Manifest exceeds byte limit' });
  return issues.length ? { ok: false, issues } : { ok: true, manifest };
}

export function parseAppManifestJson(json: string): AppManifestValidationResult {
  if (Buffer.byteLength(json, 'utf8') > MAX_APP_MANIFEST_BYTES) return { ok: false, issues: [{ path: '', code: 'MANIFEST_TOO_LARGE', message: 'Manifest exceeds byte limit' }] };
  try { return validateAppManifest(JSON.parse(json)); }
  catch { return { ok: false, issues: [{ path: '', code: 'INVALID_JSON', message: 'Expected JSON manifest' }] }; }
}

/** Compatibility is separate from declaration validity and from permission/runtime admission. */
export function checkAppManifestCompatibility(value: unknown, host: AppManifestHost): AppManifestValidationResult {
  const parsed = validateAppManifest(value);
  if (!parsed.ok) return parsed;
  const hostSchema = z.object({ platformVersion: version, capabilities: list(z.object({ id, contractVersion }).strict()), applications: list(z.object({ id, version }).strict()) }).strict();
  const inventory = hostSchema.safeParse(host);
  if (!inventory.success || new Set(host.capabilities.map((x) => x.id)).size !== host.capabilities.length || new Set(host.applications.map((x) => x.id)).size !== host.applications.length) return { ok: false, issues: [{ path: 'host', code: 'INVALID_HOST_INVENTORY', message: 'Invalid or duplicate trusted host inventory' }] };
  const issues: AppManifestIssue[] = [];
  const m = parsed.manifest;
  const inRange = (v: string, r: { minInclusive: string; maxExclusive: string }) => compareVersions(v, r.minInclusive) >= 0 && compareVersions(v, r.maxExclusive) < 0;
  if (!inRange(host.platformVersion, m.compatibility.platform)) issues.push({ path: 'compatibility.platform', code: 'INCOMPATIBLE_PLATFORM', message: 'Platform version is outside declared bounds' });
  for (const c of m.compatibility.capabilities) if (!host.capabilities.some((x) => x.id === c.id && x.contractVersion === c.contractVersion)) issues.push({ path: 'compatibility.capabilities', code: 'INCOMPATIBLE_CAPABILITY', message: 'Required capability contract is unavailable' });
  for (const app of m.compatibility.applications) if (!host.applications.some((x) => x.id === app.id && inRange(x.version, app.version))) issues.push({ path: 'compatibility.applications', code: 'INCOMPATIBLE_APPLICATION', message: 'Required application version is unavailable' });
  return issues.length ? { ok: false, issues } : parsed;
}
