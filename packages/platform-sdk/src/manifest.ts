import {isAppToolInputSchema,type AppToolDefinition} from './app-tools.js';
/** Application model v2 manifest (app.json). Shared by the CLI and the platform; validation grants nothing. */
export const APP_MANIFEST_V2_FILE = 'app.json' as const;

/** Platform capabilities an application may request; each maps to `platform.<code>`. Application data access is implied by migrations. */
export const APP_PLATFORM_ACCESS = [
  'people.read', 'locations.read', 'assets.read', 'ai.complete', 'knowledge.read', 'knowledge.write', 'tools.read',
  'attachments.create', 'attachments.read', 'notifications.create', 'notifications.manage',
  'signatures.create', 'signatures.read', 'signatures.sign', 'webhook.send',
] as const;
export type AppPlatformAccess = typeof APP_PLATFORM_ACCESS[number];
export const APP_DATA_SCOPES = ['self', 'workgroup', 'department', 'organizations', 'all'] as const;
export type AppDataScope = typeof APP_DATA_SCOPES[number];

export interface AppPermissionV2 { code: string; name: string; scopes?: AppDataScope[] }
export interface AppPageV2 { path: string; title: string; permission?: string; nav?: boolean }
export interface AppApiV2 { id: string; permission?: string; dashboard?: boolean }
export interface AppLimitsV2 { memoryMiB?: number; timeoutSeconds?: number }
export interface AppKnowledgeBaseV2 {
  id: string;
  name: string;
  retrieval: 'exact' | 'similar';
  readPermission: string;
  writePermission: string;
  /** Allow a self-scoped reader to retrieve shared knowledge in their own organization ancestry. */
  selfRead?: boolean;
}
export interface AppAgentV2 {
  id: string;
  name: string;
  description: string;
  examples: string[];
  apiId: string;
  permission: string;
  page: string;
}
export interface AppManifestV2 {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Tile colour for the application icon, `#RRGGBB`. */
  color?: string;
  /** Supported platform versions, e.g. `>=0.26.0` or `>=0.26.0 <1.0.0`. */
  platform: string;
  permissions: AppPermissionV2[];
  platformAccess: AppPlatformAccess[];
  pages: AppPageV2[];
  api: AppApiV2[];
  knowledgeBases?: AppKnowledgeBaseV2[];
  agents?: AppAgentV2[];
  tools?: AppToolDefinition[];
  limits?: AppLimitsV2;
}
export interface AppManifestIssueV2 { path: string; message: string }
export type AppManifestV2Result = { ok: true; manifest: AppManifestV2 } | { ok: false; issues: AppManifestIssueV2[] };

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CODE = /^[a-z][a-z0-9_-]*$/;
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PAGE_SEGMENT = /^(?:[a-z0-9][a-z0-9_-]*|:[a-z][a-zA-Z0-9]*)$/;
const COMPARATOR = /^(>=|<=|>|<|=)?(.+)$/;
const KEYS = ['id', 'name', 'version', 'description', 'color', 'platform', 'permissions', 'platformAccess', 'pages', 'api', 'limits', 'knowledgeBases', 'agents', 'tools'];

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** Full permission code as stored by the platform. Accepts short (`read`) or full (`app.<id>.read`) codes. */
export function appPermissionCode(appId: string, code: string): string {
  return code.startsWith('app.') ? code : `app.${appId}.${code}`;
}

export function isAppPagePath(value: string): boolean {
  return value === '/' || (value.startsWith('/') && value.length <= 256 && value.slice(1).split('/').every(part => PAGE_SEGMENT.test(part)));
}

/** Compares SemVer core and prerelease identifiers. Inputs must already match SEMVER. */
export function compareAppVersions(a: string, b: string): number {
  const split = (v: string) => { const i = v.indexOf('-'); return i < 0 ? [v, ''] as const : [v.slice(0, i), v.slice(i + 1)] as const; };
  const [ac, ap] = split(a), [bc, bp] = split(b);
  const av = ac.split('.').map(Number), bv = bc.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i]! < bv[i]! ? -1 : 1;
  if (ap === bp) return 0;
  if (!ap || !bp) return ap ? -1 : 1;
  const aa = ap.split('.'), ba = bp.split('.');
  for (let i = 0; i < Math.max(aa.length, ba.length); i++) {
    const x = aa[i], y = ba[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn) return Number(x) < Number(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function comparators(range: string): { op: string; version: string }[] | null {
  const parts = range.trim().split(/\s+/);
  if (!range.trim() || parts.length > 4) return null;
  const result: { op: string; version: string }[] = [];
  for (const part of parts) {
    const match = COMPARATOR.exec(part);
    if (!match || !SEMVER.test(match[2]!)) return null;
    result.push({ op: match[1] ?? '=', version: match[2]! });
  }
  return result;
}

export function isPlatformRange(range: string): boolean { return typeof range === 'string' && range.length <= 64 && comparators(range) !== null; }

/** True when `version` satisfies every comparator of `range` (space-separated, AND). */
export function satisfiesPlatformRange(range: string, version: string): boolean {
  const list = comparators(range);
  if (!list || !SEMVER.test(version)) return false;
  return list.every(({ op, version: target }) => {
    const c = compareAppVersions(version, target);
    return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0;
  });
}

/** Strict validation with defaults filled in. Unknown keys are rejected so typos surface during `mop check`. */
export function validateAppManifestV2(value: unknown): AppManifestV2Result {
  const issues: AppManifestIssueV2[] = [];
  const fail = (path: string, message: string) => { issues.push({ path, message }); };
  if (!record(value)) return { ok: false, issues: [{ path: '', message: 'app.json 必须是 JSON 对象' }] };
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) fail(key, '不支持的字段');
  if (typeof value.id !== 'string' || value.id.length > 64 || !ID.test(value.id)) fail('id', '应为小写字母开头、以连字符分隔的英文标识，不超过 64 字符');
  if (!text(value.name, 32)) fail('name', '应用名称为 1–32 个字符，首尾无空格');
  if (typeof value.version !== 'string' || value.version.length > 64 || !SEMVER.test(value.version)) fail('version', '版本应为语义化版本，如 1.0.0');
  if (!text(value.description, 200)) fail('description', '说明为 1–200 个字符，首尾无空格');
  if (value.color !== undefined && (typeof value.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.color))) fail('color', '颜色应为 #RRGGBB');
  if (typeof value.platform !== 'string' || !isPlatformRange(value.platform)) fail('platform', '平台版本范围应类似 >=0.26.0 或 >=0.26.0 <1.0.0');

  const permissions = value.permissions ?? [];
  const codes = new Set<string>();
  if (!Array.isArray(permissions) || permissions.length > 64) fail('permissions', '应为不超过 64 项的数组');
  else permissions.forEach((item: unknown, index) => {
    const path = `permissions[${index}]`;
    if (!record(item) || Object.keys(item).some(key => !['code', 'name', 'scopes'].includes(key))) { fail(path, '应只包含 code、name、scopes'); return; }
    const code = typeof item.code === 'string' && typeof value.id === 'string' && item.code.startsWith(`app.${value.id}.`) ? item.code.slice(`app.${value.id}.`.length) : item.code;
    if (typeof code !== 'string' || code.length > 48 || !CODE.test(code)) fail(`${path}.code`, '权限代码应为小写字母开头的短代码，如 read');
    else if (codes.has(code)) fail(`${path}.code`, '权限代码重复');
    else codes.add(code);
    if (!text(item.name, 32)) fail(`${path}.name`, '权限名称为 1–32 个字符');
    if (item.scopes !== undefined && (!Array.isArray(item.scopes) || !item.scopes.length || new Set(item.scopes).size !== item.scopes.length
      || item.scopes.some(scope => !(APP_DATA_SCOPES as readonly unknown[]).includes(scope)))) fail(`${path}.scopes`, `数据范围应取自 ${APP_DATA_SCOPES.join('、')}，且不重复`);
  });
  const declared = (code: unknown) => typeof code === 'string' && codes.has(typeof value.id === 'string' && code.startsWith(`app.${value.id}.`) ? code.slice(`app.${value.id}.`.length) : code);

  const access = value.platformAccess ?? [];
  if (!Array.isArray(access) || new Set(access).size !== access.length || access.some(item => !(APP_PLATFORM_ACCESS as readonly unknown[]).includes(item)))
    fail('platformAccess', `平台能力应取自 ${APP_PLATFORM_ACCESS.join('、')}，且不重复`);

  const pages = value.pages ?? [];
  const pagePaths = new Set<string>();
  if (!Array.isArray(pages) || pages.length > 64) fail('pages', '应为不超过 64 项的数组');
  else pages.forEach((item: unknown, index) => {
    const path = `pages[${index}]`;
    if (!record(item) || Object.keys(item).some(key => !['path', 'title', 'permission', 'nav'].includes(key))) { fail(path, '应只包含 path、title、permission、nav'); return; }
    if (typeof item.path !== 'string' || !isAppPagePath(item.path)) fail(`${path}.path`, '页面路径应以 / 开头，由小写字母、数字、-、_ 或 :参数 组成');
    else if (pagePaths.has(item.path)) fail(`${path}.path`, '页面路径重复');
    else pagePaths.add(item.path);
    if (!text(item.title, 32)) fail(`${path}.title`, '页面标题为 1–32 个字符');
    if (item.permission !== undefined && !declared(item.permission)) fail(`${path}.permission`, '权限未在 permissions 中声明');
    if (item.nav !== undefined && typeof item.nav !== 'boolean') fail(`${path}.nav`, '应为 true 或 false');
    if (item.nav === true && typeof item.path === 'string' && item.path.includes(':')) fail(`${path}.nav`, '带参数的页面不能放入导航');
  });

  const api = value.api ?? [];
  const apiIds = new Set<string>();
  if (!Array.isArray(api) || api.length > 128) fail('api', '应为不超过 128 项的数组');
  else {
    api.forEach((item: unknown, index) => {
      const path = `api[${index}]`;
      if (!record(item) || Object.keys(item).some(key => !['id', 'permission', 'dashboard'].includes(key))) { fail(path, '应只包含 id、permission、dashboard'); return; }
      if (typeof item.id !== 'string' || item.id.length > 64 || !ID.test(item.id)) fail(`${path}.id`, '接口 ID 应为小写字母开头、以连字符分隔的英文标识');
      else if (apiIds.has(item.id)) fail(`${path}.id`, '接口 ID 重复');
      else apiIds.add(item.id);
      if (item.permission !== undefined && !declared(item.permission)) fail(`${path}.permission`, '权限未在 permissions 中声明');
      if (item.dashboard !== undefined && item.dashboard !== true) fail(`${path}.dashboard`, '只能为 true');
      if (item.dashboard === true && item.permission === undefined) fail(`${path}.permission`, '工作台摘要接口必须声明权限');
    });
    if (api.filter(item => record(item) && item.dashboard === true).length > 1) fail('api', '最多一个工作台摘要接口');
    if (api.some(item => record(item) && item.permission === undefined) && !codes.size) fail('api', '未声明权限的接口表示“有本应用任一权限即可调用”，需要至少声明一个权限');
  }

  if (value.tools !== undefined) {
    const ids=new Set<string>(),handlers=new Set<string>();
    if(!Array.isArray(value.tools)||value.tools.length>16)fail('tools','工具最多16项');
    else value.tools.forEach((tool:unknown,index)=>{
      const path=`tools[${index}]`;
      if(!record(tool)||Object.keys(tool).some(key=>!['id','name','description','apiId','permission','mode','inputSchema'].includes(key))){fail(path,'工具字段无效');return;}
      if(typeof tool.id!=='string'||tool.id.length>64||!ID.test(tool.id)||ids.has(tool.id))fail(path,'工具ID无效或重复');else ids.add(tool.id);
      if(!text(tool.name,64)||!text(tool.description,500)||tool.mode!=='read')fail(path,'工具名称、说明或只读模式无效');
      if(!declared(tool.permission))fail(path,'工具权限未声明');
      const entry=Array.isArray(api)?api.find(item=>record(item)&&item.id===tool.apiId):undefined;
      if(!entry||typeof entry.permission!=='string'||typeof tool.permission!=='string'||appPermissionCode(value.id as string,entry.permission)!==appPermissionCode(value.id as string,tool.permission)||handlers.has(String(tool.apiId)))fail(path,'需引用具有相同权限的独立API');
      handlers.add(String(tool.apiId));
      if(Array.isArray(value.agents)&&value.agents.some(agent=>record(agent)&&agent.apiId===tool.apiId))fail(path,'编排入口不能同时作为工具');
      if(!isAppToolInputSchema(tool.inputSchema))fail(path,'工具参数应为有界、封闭的标量对象');
    });
  }

  if (value.agents !== undefined) {
    const ids = new Set<string>();
    if (!Array.isArray(value.agents) || value.agents.length > 8) fail('agents', '智能能力最多8项');
    else value.agents.forEach((agent: unknown, index) => {
      const path = `agents[${index}]`;
      if (!record(agent) || Object.keys(agent).some(key=>!['id','name','description','examples','apiId','permission','page'].includes(key))) {fail(path,'智能能力字段无效');return;}
      if (typeof agent.id !== 'string' || agent.id.length > 64 || !ID.test(agent.id) || ids.has(agent.id)) fail(`${path}.id`,'能力ID无效或重复');
      else ids.add(agent.id);
      if (!text(agent.name,32) || !text(agent.description,300)) fail(path,'名称或说明无效');
      if (!Array.isArray(agent.examples) || !agent.examples.length || agent.examples.length > 4 || agent.examples.some(example=>!text(example,300))) fail(`${path}.examples`,'示例应为1–4条，每条最多300字符');
      if (!declared(agent.permission)) fail(`${path}.permission`,'权限未声明');
      const apiEntry=Array.isArray(api)?api.find(item=>record(item)&&item.id===agent.apiId):undefined;
      if (!apiEntry || typeof apiEntry.permission!=='string' || typeof agent.permission!=='string' || appPermissionCode(value.id as string,apiEntry.permission)!==appPermissionCode(value.id as string,agent.permission)) fail(`${path}.apiId`,'智能能力必须引用具有相同权限的已声明接口');
      if (!Array.isArray(pages) || !pages.some(page=>record(page)&&page.path===agent.page&&!String(page.path).includes(':'))) fail(`${path}.page`,'需引用无参数的应用页面');
    });
  }

  if (value.knowledgeBases !== undefined) {
    const bases = value.knowledgeBases, ids = new Set<string>();
    if (!Array.isArray(bases) || bases.length > 16) fail('knowledgeBases', '知识库应为不超过16项的数组');
    else bases.forEach((base: unknown, index) => {
      const path = `knowledgeBases[${index}]`;
      if (!record(base) || Object.keys(base).some(key => !['id','name','retrieval','readPermission','writePermission','selfRead'].includes(key))) { fail(path, '知识库声明字段无效'); return; }
      if (typeof base.id !== 'string' || base.id.length > 64 || !ID.test(base.id) || ids.has(base.id)) fail(`${path}.id`, '知识库ID无效或重复');
      else ids.add(base.id);
      if (!text(base.name, 64)) fail(`${path}.name`, '知识库名称为1–64个字符');
      if (!['exact','similar'].includes(base.retrieval as string)) fail(`${path}.retrieval`, '检索方式应为exact或similar');
      for (const key of ['readPermission','writePermission']) if (!declared(base[key])) fail(`${path}.${key}`, '权限未声明');
      if (base.selfRead !== undefined && typeof base.selfRead !== 'boolean') fail(`${path}.selfRead`, '应为布尔值');
    });
    if (!Array.isArray(access) || !access.includes('knowledge.read') || !access.includes('knowledge.write')) fail('knowledgeBases', '知识库需要knowledge.read和knowledge.write平台能力');
  }

  if (value.limits !== undefined) {
    const limits = value.limits;
    if (!record(limits) || Object.keys(limits).some(key => !['memoryMiB', 'timeoutSeconds'].includes(key))) fail('limits', '应只包含 memoryMiB、timeoutSeconds');
    else {
      if (limits.memoryMiB !== undefined && (!Number.isInteger(limits.memoryMiB) || (limits.memoryMiB as number) < 64 || (limits.memoryMiB as number) > 2048)) fail('limits.memoryMiB', '应为 64–2048 的整数');
      if (limits.timeoutSeconds !== undefined && (!Number.isInteger(limits.timeoutSeconds) || (limits.timeoutSeconds as number) < 1 || (limits.timeoutSeconds as number) > 120)) fail('limits.timeoutSeconds', '应为 1–120 的整数');
    }
  }
  if (issues.length) return { ok: false, issues };

  const id = value.id as string;
  const short = (code: string) => code.startsWith(`app.${id}.`) ? code.slice(`app.${id}.`.length) : code;
  const manifest: AppManifestV2 = {
    id, name: value.name as string, version: value.version as string, description: value.description as string,
    ...(value.color !== undefined ? { color: (value.color as string).toUpperCase() } : {}),
    platform: (value.platform as string).trim().split(/\s+/).join(' '),
    permissions: (permissions as AppPermissionV2[]).map(p => ({ code: short(p.code), name: p.name, ...(p.scopes ? { scopes: [...p.scopes] } : {}) })),
    platformAccess: [...access as AppPlatformAccess[]],
    pages: (pages as AppPageV2[]).map(p => ({ path: p.path, title: p.title, ...(p.permission !== undefined ? { permission: short(p.permission) } : {}), ...(p.nav !== undefined ? { nav: p.nav } : {}) })),
    api: (api as AppApiV2[]).map(a => ({ id: a.id, ...(a.permission !== undefined ? { permission: short(a.permission) } : {}), ...(a.dashboard ? { dashboard: true } : {}) })),
    ...(value.knowledgeBases !== undefined ? { knowledgeBases: (value.knowledgeBases as AppKnowledgeBaseV2[]).map(base => ({...base, readPermission: short(base.readPermission), writePermission: short(base.writePermission)})) } : {}),
    ...(value.agents !== undefined ? {agents: (value.agents as AppAgentV2[]).map(agent=>({...agent,permission:short(agent.permission),examples:[...agent.examples]}))} : {}),
    ...(value.tools !== undefined ? {tools:(value.tools as AppToolDefinition[]).map(tool=>({...tool,permission:short(tool.permission),inputSchema:structuredClone(tool.inputSchema)}))} : {}),
    ...(value.limits !== undefined ? { limits: { ...value.limits as AppLimitsV2 } } : {}),
  };
  return { ok: true, manifest };
}

const MIGRATION_TYPES = ['text', 'boolean', 'integer', 'bigint', 'uuid', 'date', 'timestamptz', 'jsonb'];
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 63 && IDENTIFIER.test(value) && !value.startsWith('pg_') && !value.startsWith('platform_');

/** Mirrors the platform's declarative migration rules (createTable / addColumn / createIndex). Returns problems, empty when valid. */
export function validateAppMigration(value: unknown): string[] {
  const problems: string[] = [];
  if (!record(value) || Object.keys(value).sort().join(',') !== 'migrationVersion,operations' || value.migrationVersion !== '1.0')
    return ['迁移应为 {"migrationVersion":"1.0","operations":[...]}'];
  const operations = value.operations;
  if (!Array.isArray(operations) || !operations.length || operations.length > 64) return ['operations 应为 1–64 项'];
  const relations = new Set<string>();
  const column = (item: unknown, where: string) => {
    if (!record(item) || Object.keys(item).sort().join(',') !== 'name,nullable,type' || !identifier(item.name)
      || !MIGRATION_TYPES.includes(item.type as string) || typeof item.nullable !== 'boolean') { problems.push(`${where}：列应为 {name,type,nullable}，类型取自 ${MIGRATION_TYPES.join('、')}`); return null; }
    return item as { name: string; type: string; nullable: boolean };
  };
  const names = (list: unknown) => Array.isArray(list) && list.length > 0 && list.length <= 64 && list.every(identifier) && new Set(list).size === list.length;
  operations.forEach((op: unknown, index) => {
    const where = `operations[${index}]`;
    if (!record(op)) { problems.push(`${where}：应为对象`); return; }
    if (op.kind === 'createTable') {
      if (Object.keys(op).some(key => !['kind', 'table', 'columns', 'primaryKey'].includes(key)) || !identifier(op.table)) { problems.push(`${where}：表名应为小写字母开头的标识`); return; }
      if (relations.has(op.table)) problems.push(`${where}：表 ${op.table} 重复`);
      relations.add(op.table);
      if (!Array.isArray(op.columns) || !op.columns.length || op.columns.length > 64) { problems.push(`${where}：columns 应为 1–64 项`); return; }
      const columns = op.columns.map((item: unknown) => column(item, where));
      if (new Set(columns.map(c => c?.name)).size !== columns.length) problems.push(`${where}：列名重复`);
      if (op.primaryKey !== undefined && (!names(op.primaryKey) || (op.primaryKey as string[]).some(name => !columns.some(c => c?.name === name && !c.nullable))))
        problems.push(`${where}：primaryKey 必须引用本表的非空列`);
    } else if (op.kind === 'addColumn') {
      if (Object.keys(op).sort().join(',') !== 'column,kind,table' || !identifier(op.table)) { problems.push(`${where}：addColumn 应为 {kind,table,column}`); return; }
      const added = column(op.column, where);
      if (added && !added.nullable) problems.push(`${where}：新增列必须可空`);
    } else if (op.kind === 'createIndex') {
      if (Object.keys(op).some(key => !['kind', 'table', 'name', 'columns', 'unique'].includes(key)) || !identifier(op.table) || !identifier(op.name)
        || !names(op.columns) || (op.unique !== undefined && typeof op.unique !== 'boolean')) { problems.push(`${where}：createIndex 应为 {kind,table,name,columns,unique?}`); return; }
      if (relations.has(op.name)) problems.push(`${where}：名称 ${op.name} 与表或索引重复`);
      relations.add(op.name);
    } else problems.push(`${where}：kind 只支持 createTable、addColumn、createIndex`);
  });
  return problems;
}
