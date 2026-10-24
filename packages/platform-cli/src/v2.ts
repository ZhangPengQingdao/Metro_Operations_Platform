/** Application model v2 commands: init, check and build a single `.mopkg` file. */
import { build as esbuild, transform, type Metafile, type Plugin } from 'esbuild';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAppManifestV2, type AppManifestIssueV2, type AppManifestV2 } from '@metro/platform-sdk/manifest';
import { createMopkg, inspectMopkg, MOPKG_MIGRATION_PATH } from '@metro/platform-sdk/mopkg';
import { isAppServerDefinition } from '@metro/platform-sdk/server';

/** Provided by the platform shell at runtime; never bundled into ui.js. */
export const SHARED_UI_MODULES = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@metro/platform-sdk/app', '@metro/platform-sdk/ui'];
/**
 * Shared imports become lookups in the shell's registry (`globalThis.__MOP_SHARED__`), wrapped as CommonJS so
 * esbuild's interop serves any named import. The page then runs on the shell's single React and UI kit instance.
 */
const sharedModules: Plugin = {
  name: 'mop-shared-modules',
  setup(build) {
    const filter = new RegExp(`^(${SHARED_UI_MODULES.map(name => name.replace(/[/.-]/g, '\\$&')).join('|')})$`);
    build.onResolve({ filter }, args => ({ path: args.path, namespace: 'mop-shared' }));
    build.onLoad({ filter: /.*/, namespace: 'mop-shared' }, args => ({
      loader: 'js',
      contents: `var m=globalThis.__MOP_SHARED__&&globalThis.__MOP_SHARED__[${JSON.stringify(args.path === 'react/jsx-dev-runtime' ? 'react/jsx-runtime' : args.path)}];if(!m)throw new Error('运行环境缺少共享模块 ${args.path}，请在运管平台中打开此应用');module.exports=m;`,
    }));
  },
};
const LEGACY_MODULES = /@metro\/platform-sdk\/(?:dist\/)?(?:app-sandbox|ui-styles)(?:\.js)?$/;
const UI_SOURCES = ['src/ui.tsx', 'src/ui.jsx', 'src/ui.ts', 'src/ui.js'];
const SERVER_SOURCES = ['src/server.ts', 'src/server.js', 'src/server.mjs'];
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class CliError extends Error {
  constructor(message: string, readonly issues: AppManifestIssueV2[] = []) { super(message); this.name = 'CliError'; }
}
export interface CheckResult { manifest: AppManifestV2; ui: string | null; server: string | null; warnings: string[] }
export interface BuildResult extends CheckResult { output: string; sha256: string; bytes: number; files: { path: string; bytes: number }[] }

async function exists(path: string) { return stat(path).then(() => true, () => false); }
async function first(root: string, candidates: string[]) {
  for (const candidate of candidates) if (await exists(join(root, candidate))) return candidate;
  return null;
}

export async function initProject(target: string, options: { id?: string; name?: string; templates: URL; platformVersion: string }) {
  const root = resolve(target);
  if (await exists(root) && (await readdir(root)).length) throw new CliError(`目录不为空：${root}`);
  const id = options.id ?? basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '');
  if (!id || id.length > 64 || !ID.test(id)) throw new CliError('应用 ID 应为小写字母开头、以连字符分隔的英文标识，请用 --id 指定');
  const name = options.name ?? id;
  if (!name.trim() || name.length > 32 || name.trim() !== name || /[\x00-\x1f\x7f]/.test(name)) throw new CliError('应用名称为 1–32 个字符，请用 --name 指定');
  const replace = (text: string) => text.replaceAll('__APP_ID__', id).replaceAll('__APP_NAME__', name).replaceAll('__PLATFORM_VERSION__', options.platformVersion);
  const source = new URL('./v2/', options.templates);
  const files: [string, string][] = [
    ['app.json', 'app.json'], ['icon.svg', 'icon.svg'], ['package.json', 'package.json'], ['README.md', 'README.md'], ['AGENTS.md', 'AGENTS.md'],
    ['gitignore', '.gitignore'], ['src/ui.jsx', 'src/ui.jsx'], ['src/ui.css', 'src/ui.css'], ['src/server.js', 'src/server.js'],
    ['migrations/001-initial.json', 'migrations/001-initial.json'], ['test/server.test.js', 'test/server.test.js'],
    ['skill/SKILL.md', '.claude/skills/metro-app/SKILL.md'],
  ];
  for (const [from, to] of files) {
    let text = await readFile(new URL(from, source), 'utf8');
    if (from === 'app.json') {
      // Structured edit so names containing quotes stay valid JSON.
      const manifest = JSON.parse(text.replaceAll('__PLATFORM_VERSION__', options.platformVersion));
      Object.assign(manifest, { id, name, description: `${name}：记录列表与新增示例` });
      text = JSON.stringify(manifest, null, 2) + '\n';
    } else text = replace(text);
    await mkdir(join(root, to, '..'), { recursive: true });
    await writeFile(join(root, to), text, { flag: 'wx' });
  }
  return { root, id, name };
}

async function readManifest(root: string): Promise<AppManifestV2> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')); }
  catch { throw new CliError('找不到 app.json 或不是有效 JSON', [{ path: 'app.json', message: '找不到或不是有效 JSON' }]); }
  const result = validateAppManifestV2(value);
  if (!result.ok) throw new CliError('app.json 校验未通过', result.issues.map(issue => ({ ...issue, path: `app.json${issue.path ? `#${issue.path}` : ''}` })));
  return result.manifest;
}

/** Static files copied into the package as-is. */
async function staticEntries(root: string) {
  const entries: { path: string; data: Uint8Array }[] = [];
  for (const path of ['app.json', 'icon.svg', 'icon.png', 'README.md', 'CHANGELOG.md']) if (await exists(join(root, path))) entries.push({ path, data: await readFile(join(root, path)) });
  if (await exists(join(root, 'migrations'))) {
    for (const name of (await readdir(join(root, 'migrations'))).sort()) {
      const path = `migrations/${name}`;
      if (name.startsWith('.')) continue;
      if (!MOPKG_MIGRATION_PATH.test(path)) throw new CliError('迁移文件名不规范', [{ path, message: '应为 001-名称.json，名称用小写字母、数字和连字符' }]);
      entries.push({ path, data: await readFile(join(root, path)) });
    }
  }
  return entries;
}

/** Same package rules as the platform installer, without compiling sources. */
export async function checkProject(target: string): Promise<CheckResult> {
  const root = resolve(target);
  const manifest = await readManifest(root);
  const ui = await first(root, UI_SOURCES), server = await first(root, SERVER_SOURCES);
  const placeholder = new TextEncoder().encode('export default {};\n');
  const entries = [...await staticEntries(root), ...(ui ? [{ path: 'ui.js', data: placeholder }] : []), ...(server ? [{ path: 'server.js', data: placeholder }] : [])];
  const issues = inspectMopkg(createMopkg(entries)).issues
    .map(issue => issue.path === 'ui.js' ? { ...issue, message: issue.message.replace('ui.js', ui ?? 'src/ui.jsx') } : issue.path === 'server.js' ? { ...issue, message: issue.message.replace('server.js', server ?? 'src/server.js') } : issue);
  if (issues.length) throw new CliError('检查未通过', issues);
  const warnings: string[] = [];
  if (!manifest.color) warnings.push('app.json 未设置 color，平台将使用默认图标底色');
  if (manifest.pages.length && !manifest.pages.some(page => page.nav)) warnings.push('没有页面设置 nav: true，侧栏中不会出现入口');
  return { manifest, ui, server, warnings };
}

function exportsDefault(metafile: Metafile, output: string) {
  const entry = Object.entries(metafile.outputs).find(([path]) => path.endsWith(output));
  return !!entry?.[1].exports.includes('default');
}

/** CSS is scoped to `[data-app="<id>"]` via nesting, then lowered for current browsers. */
async function scopeCss(css: string, appId: string) {
  if (/@(?:font-face|keyframes|import|layer|property)\b/.test(css)) throw new CliError('ui.css 暂不支持 @font-face、@keyframes、@import、@layer、@property', [{ path: 'src/ui.css', message: '请改用平台组件或内联样式' }]);
  const result = await transform(`[data-app="${appId}"]{\n${css}\n}`, { loader: 'css', minify: true, target: ['chrome100', 'safari15', 'firefox100'] });
  return result.code;
}

export async function buildProject(target: string): Promise<BuildResult> {
  const root = resolve(target);
  const checked = await checkProject(root);
  const { manifest } = checked;
  const work = await mkdtemp(join(tmpdir(), 'mop-build-'));
  try {
    const entries = await staticEntries(root);
    if (checked.ui) {
      const result = await esbuild({
        absWorkingDir: root, entryPoints: { ui: join(root, checked.ui) }, outdir: work, bundle: true, format: 'esm', platform: 'browser',
        target: 'es2022', jsx: 'automatic', minify: true, metafile: true, logLevel: 'silent', plugins: [sharedModules],
        loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
      }).catch((error: { errors?: { text: string; location?: { file: string; line: number } | null }[] }) => {
        throw new CliError('页面构建失败', (error.errors ?? []).map(item => ({ path: item.location ? `${item.location.file}:${item.location.line}` : checked.ui!, message: item.text })));
      });
      if (Object.keys(result.metafile.inputs).some(path => LEGACY_MODULES.test(path))) throw new CliError('v2 页面不使用 app-sandbox 或 ui-styles', [{ path: checked.ui, message: '改用 @metro/platform-sdk/app 的 defineApp/useApp' }]);
      if (!exportsDefault(result.metafile, 'ui.js')) throw new CliError('页面缺少默认导出', [{ path: checked.ui, message: '应 export default defineApp({...})' }]);
      entries.push({ path: 'ui.js', data: await readFile(join(work, 'ui.js')) });
      if (await exists(join(work, 'ui.css'))) entries.push({ path: 'ui.css', data: new TextEncoder().encode(await scopeCss(await readFile(join(work, 'ui.css'), 'utf8'), manifest.id)) });
    }
    if (checked.server) {
      await esbuild({
        absWorkingDir: root, entryPoints: { server: join(root, checked.server) }, outdir: work, outExtension: { '.js': '.js' }, bundle: true, format: 'esm',
        platform: 'node', target: 'node22', metafile: true, logLevel: 'silent', minify: false,
        banner: { js: "import {createRequire as __mopCreateRequire} from 'node:module';const require=__mopCreateRequire(import.meta.url);" },
      }).catch((error: { errors?: { text: string; location?: { file: string; line: number } | null }[] }) => {
        throw new CliError('接口构建失败', (error.errors ?? []).map(item => ({ path: item.location ? `${item.location.file}:${item.location.line}` : checked.server!, message: item.text })));
      });
      const handlers = await serverHandlerNames(join(work, 'server.js'));
      if (!handlers) throw new CliError('接口默认导出不是 defineServer(...) 的结果', [{ path: checked.server, message: '应 export default defineServer({...})，或调用 createAppBackend({handlers})' }]);
      const missing = manifest.api.filter(api => !handlers.includes(api.id)).map(api => api.id);
      if (missing.length) throw new CliError('接口与 app.json 不一致', missing.map(id => ({ path: checked.server!, message: `缺少接口函数 ${id}` })));
      for (const name of handlers) if (!manifest.api.some(api => api.id === name)) checked.warnings.push(`接口函数 ${name} 未在 app.json 的 api 中声明，平台不会开放`);
      entries.push({ path: 'server.js', data: await readFile(join(work, 'server.js')) });
    }
    const bytes = createMopkg(entries);
    const inspection = inspectMopkg(bytes);
    if (inspection.issues.length) throw new CliError('安装包校验未通过', inspection.issues);
    const output = join(root, 'dist', `${manifest.id}-${manifest.version}.mopkg`);
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(output, bytes);
    return { ...checked, output: relative(process.cwd(), output) || output, sha256: inspection.sha256, bytes: inspection.bytes, files: inspection.files };
  } finally { await rm(work, { recursive: true, force: true }); }
}

export type DevEvent = { type: 'built'; result: BuildResult; target: string } | { type: 'failed'; error: unknown };
/**
 * Rebuilds on every change and writes `<out>/<id>.mopkg` atomically. A platform started with
 * `MOP_DEV_APPS_DIR=<out>` installs each new package automatically. Returns a stop function.
 */
export async function devProject(target: string, options: { out: string; onEvent(event: DevEvent): void }): Promise<() => void> {
  const root = resolve(target), out = resolve(options.out);
  await mkdir(out, { recursive: true });
  let timer: NodeJS.Timeout | null = null, running = false, again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      const result = await buildProject(root);
      const destination = join(out, `${result.manifest.id}.mopkg`), staging = `${destination}.${process.pid}.tmp`;
      await writeFile(staging, await readFile(resolve(process.cwd(), result.output)));
      await rename(staging, destination);
      options.onEvent({ type: 'built', result, target: destination });
    } catch (error) { options.onEvent({ type: 'failed', error }); }
    finally { running = false; if (again) { again = false; void run(); } }
  };
  await run();
  const ignored = /(^|[\\/])(node_modules|dist|\.mop|\.git)([\\/]|$)/;
  const watcher = watch(root, { recursive: true }, (_event, file) => {
    if (!file || ignored.test(String(file))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(); }, 200);
  });
  return () => { if (timer) clearTimeout(timer); watcher.close(); };
}

/**
 * Loads a built server.js the way the platform child does (handlers are not invoked) and returns its API names.
 * Accepts `export default defineServer(...)` and existing `createAppBackend({handlers})` entries.
 */
async function serverHandlerNames(file: string): Promise<string[] | null> {
  let registered: string[] | null = null;
  const lifetime = new AbortController();
  const target = globalThis as { __MOP_V2_CHILD__?: unknown };
  target.__MOP_V2_CHILD__ = {
    register(handlers: ReadonlyMap<string, unknown>) { registered = [...handlers.keys()]; },
    platform: async () => { throw Object.assign(new Error('BUILD_TIME'), { code: 'BUILD_TIME', writeOutcome: 'not_started' }); },
    signal: lifetime.signal,
  };
  // Existing entries open a health port at load; it is not needed (or bound) while building.
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
    const callback = args.find(arg => typeof arg === 'function') as (() => void) | undefined;
    queueMicrotask(() => callback?.());
    return this;
  } as typeof net.Server.prototype.listen;
  try {
    const loaded: unknown = (await import(`${pathToFileURL(file).href}?build=${Date.now()}`)).default;
    if (isAppServerDefinition(loaded)) return Object.keys(loaded.handlers);
    return registered;
  } finally {
    lifetime.abort();
    net.Server.prototype.listen = listen;
    delete target.__MOP_V2_CHILD__;
  }
}
