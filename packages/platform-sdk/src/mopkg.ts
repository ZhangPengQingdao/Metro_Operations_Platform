/** Node-only `.mopkg` single-file application package: a plain zip with a fixed layout. */
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { validateAppManifestV2, validateAppMigration, type AppManifestIssueV2, type AppManifestV2 } from './manifest.js';

export const MOPKG_EXTENSION = '.mopkg' as const;
export const MOPKG_LIMITS = Object.freeze({
  packageBytes: 50 * 1024 * 1024,
  files: 200,
  uiBytes: 5 * 1024 * 1024,
  serverBytes: 20 * 1024 * 1024,
  svgIconBytes: 64 * 1024,
  pngIconBytes: 512 * 1024,
  textBytes: 64 * 1024,
  migrationBytes: 1024 * 1024,
});
export const MOPKG_MIGRATION_PATH = /^migrations\/(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const FIXED_FILES = ['app.json', 'icon.svg', 'icon.png', 'ui.js', 'ui.css', 'server.js', 'README.md', 'CHANGELOG.md'];

export class MopkgError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MopkgError'; }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function checkPath(path: string): void {
  if (!path || path.length > 128 || path.includes('\\') || path.startsWith('/') || path.endsWith('/')
    || path.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(path)) throw new MopkgError('MOPKG_INVALID_PATH');
}

/** Deterministic zip: entries sorted by path, fixed timestamps, deflate unless that grows the entry. */
export function createMopkg(entries: readonly { path: string; data: Uint8Array }[]): Buffer {
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (sorted.length > MOPKG_LIMITS.files) throw new MopkgError('MOPKG_TOO_MANY_FILES');
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const { path, data } of sorted) {
    checkPath(path);
    if (seen.has(path.toLowerCase())) throw new MopkgError('MOPKG_DUPLICATE_PATH');
    seen.add(path.toLowerCase());
    const name = Buffer.from(path, 'utf8'), crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? Buffer.from(data) : deflated;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(store ? 0 : 8, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(store ? 0 : 8, 10); entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    local.push(header, name, body); central.push(entry, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...local, directory, end]);
  if (result.length > MOPKG_LIMITS.packageBytes) throw new MopkgError('MOPKG_TOO_LARGE');
  return result;
}

/** Strict reader: single disk, no zip64, no encryption, stored/deflate only, regular files only, sizes and CRC verified. */
export function readMopkg(input: Uint8Array): Map<string, Buffer> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 22 || bytes.length > MOPKG_LIMITS.packageBytes) throw new MopkgError(bytes.length < 22 ? 'MOPKG_INVALID' : 'MOPKG_TOO_LARGE');
  if (bytes.readUInt32LE(0) !== 0x04034b50) throw new MopkgError('MOPKG_INVALID');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new MopkgError('MOPKG_INVALID');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count) throw new MopkgError('MOPKG_UNSUPPORTED');
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new MopkgError('MOPKG_UNSUPPORTED');
  if (count > MOPKG_LIMITS.files) throw new MopkgError('MOPKG_TOO_MANY_FILES');
  if (start + size > end) throw new MopkgError('MOPKG_INVALID');
  const files = new Map<string, Buffer>(), lower = new Set<string>();
  let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new MopkgError('MOPKG_INVALID');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const madeBy = bytes.readUInt16LE(cursor + 4) >> 8, external = bytes.readUInt32LE(cursor + 38), localOffset = bytes.readUInt32LE(cursor + 42);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > end) throw new MopkgError('MOPKG_INVALID');
    if (flags & 0x41) throw new MopkgError('MOPKG_UNSUPPORTED');
    if (method !== 0 && method !== 8) throw new MopkgError('MOPKG_UNSUPPORTED');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new MopkgError('MOPKG_UNSUPPORTED');
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawName); } catch { throw new MopkgError('MOPKG_INVALID_PATH'); }
    if (name.endsWith('/') && uncompressed === 0) continue; // directory entries carry no content
    checkPath(name);
    const mode = external >>> 16;
    if (madeBy === 3 && mode && (mode & 0o170000) !== 0o100000) throw new MopkgError('MOPKG_UNSUPPORTED_FILE_TYPE');
    if (lower.has(name.toLowerCase())) throw new MopkgError('MOPKG_DUPLICATE_PATH');
    lower.add(name.toLowerCase());
    total += uncompressed;
    if (total > MOPKG_LIMITS.packageBytes) throw new MopkgError('MOPKG_TOO_LARGE');
    if (localOffset + 30 > start || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new MopkgError('MOPKG_INVALID');
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    if (dataStart + compressed > start) throw new MopkgError('MOPKG_INVALID');
    const body = bytes.subarray(dataStart, dataStart + compressed);
    let data: Buffer;
    try { data = method === 0 ? Buffer.from(body) : inflateRawSync(body, { maxOutputLength: Math.max(uncompressed, 1) }); }
    catch { throw new MopkgError('MOPKG_INVALID'); }
    if (data.length !== uncompressed || crc32(data) !== crc) throw new MopkgError('MOPKG_INVALID');
    files.set(name, data);
  }
  return files;
}

export interface MopkgMigration { id: string; file: string; bytes: number; sha256: string; text: string }
export interface MopkgInspection {
  sha256: string;
  bytes: number;
  manifest: AppManifestV2 | null;
  files: { path: string; bytes: number }[];
  icon: { contentType: 'image/svg+xml' | 'image/png'; data: Buffer } | null;
  migrations: MopkgMigration[];
  readme: string | null;
  changelog: string | null;
  /** Empty when the package layout and manifest are valid. Platform-specific checks (migration SQL, versions) are separate. */
  issues: AppManifestIssueV2[];
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function utf8(data: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; }
}

/** Checks the layout rules shared by `mop build` and the platform installer. Throws MopkgError only for a broken container. */
export function inspectMopkg(input: Uint8Array): MopkgInspection {
  const files = readMopkg(input);
  const issues: AppManifestIssueV2[] = [];
  const fail = (path: string, message: string) => { issues.push({ path, message }); };
  for (const path of files.keys()) if (!FIXED_FILES.includes(path) && !MOPKG_MIGRATION_PATH.test(path)) fail(path, '包内不允许此文件');

  let manifest: AppManifestV2 | null = null;
  const manifestBytes = files.get('app.json');
  if (!manifestBytes) fail('app.json', '缺少 app.json');
  else {
    const source = manifestBytes.length <= MOPKG_LIMITS.textBytes ? utf8(manifestBytes) : null;
    let value: unknown;
    try { value = source === null ? undefined : JSON.parse(source); } catch { value = undefined; }
    if (value === undefined) fail('app.json', 'app.json 不是有效的 UTF-8 JSON 或超过 64KB');
    else {
      const result = validateAppManifestV2(value);
      if (result.ok) manifest = result.manifest;
      else for (const issue of result.issues) fail(`app.json${issue.path ? `#${issue.path}` : ''}`, issue.message);
    }
  }

  let icon: MopkgInspection['icon'] = null;
  const svg = files.get('icon.svg'), png = files.get('icon.png');
  if (svg && png) fail('icon', 'icon.svg 与 icon.png 只能保留一个');
  else if (svg) {
    const source = svg.length <= MOPKG_LIMITS.svgIconBytes ? utf8(svg) : null;
    if (source === null || !/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(source) || /<script|\bon[a-z]+\s*=|javascript:|<foreignObject/i.test(source)) fail('icon.svg', '图标应为不超过 64KB、不含脚本的 SVG');
    else icon = { contentType: 'image/svg+xml', data: svg };
  } else if (png) {
    if (png.length > MOPKG_LIMITS.pngIconBytes || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('icon.png', '图标应为不超过 512KB 的 PNG');
    else icon = { contentType: 'image/png', data: png };
  } else fail('icon', '缺少 icon.svg 或 icon.png');

  const ui = files.get('ui.js'), server = files.get('server.js');
  if (ui && ui.length > MOPKG_LIMITS.uiBytes) fail('ui.js', 'ui.js 超过 5MB');
  if (files.get('ui.css') && !ui) fail('ui.css', '有 ui.css 时必须同时提供 ui.js');
  if (server && server.length > MOPKG_LIMITS.serverBytes) fail('server.js', 'server.js 超过 20MB');
  if (manifest) {
    if (manifest.pages.length && !ui) fail('ui.js', '声明了页面但缺少 ui.js');
    if (!manifest.pages.length && ui) fail('ui.js', '包含 ui.js 但未声明任何页面');
    if (manifest.api.length && !server) fail('server.js', '声明了接口但缺少 server.js');
  }

  const migrations: MopkgMigration[] = [];
  const numbers = new Set<string>();
  for (const [path, data] of [...files].filter(([path]) => MOPKG_MIGRATION_PATH.test(path)).sort(([a], [b]) => a < b ? -1 : 1)) {
    const match = MOPKG_MIGRATION_PATH.exec(path)!;
    if (numbers.has(match[1]!)) fail(path, '迁移序号重复');
    numbers.add(match[1]!);
    const source = data.length <= MOPKG_LIMITS.migrationBytes ? utf8(data) : null;
    if (source === null) { fail(path, '迁移文件应为不超过 1MB 的 UTF-8 JSON'); continue; }
    let declaration: unknown;
    try { declaration = JSON.parse(source); } catch { fail(path, '迁移文件不是有效 JSON'); continue; }
    for (const problem of validateAppMigration(declaration)) fail(path, problem);
    migrations.push({ id: `${match[1]}-${match[2]}`, file: path, bytes: data.length, sha256: sha256(data), text: source });
  }
  // Numbering is checked on file names so an unreadable migration does not shift the sequence.
  [...numbers].sort().forEach((number, index) => {
    if (Number(number) !== index + 1) fail([...files.keys()].find(path => path.startsWith(`migrations/${number}-`))!, '迁移序号应从 001 开始连续编号');
  });
  if (migrations.length && !server) fail('migrations', '有数据迁移时必须提供 server.js');

  const readText = (path: string) => {
    const data = files.get(path);
    if (!data) return null;
    const source = data.length <= MOPKG_LIMITS.textBytes ? utf8(data) : null;
    if (source === null) fail(path, `${path} 应为不超过 64KB 的 UTF-8 文本`);
    return source;
  };
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return {
    sha256: sha256(bytes), bytes: bytes.length, manifest,
    files: [...files].map(([path, data]) => ({ path, bytes: data.length })).sort((a, b) => a.path < b.path ? -1 : 1),
    icon, migrations, readme: readText('README.md'), changelog: readText('CHANGELOG.md'), issues,
  };
}
