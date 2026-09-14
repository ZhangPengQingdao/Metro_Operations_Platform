import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { MAX_APP_MANIFEST_BYTES, parseAppManifestJson, type AppManifest } from '../manifest/index.js';

export const MAX_DEVELOPER_PACKAGE_BYTES = 64 * 1024 * 1024;
export class AppPackageError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppPackageError'; }
}
async function readRegular(root: string, path: string, limit: number): Promise<Buffer> {
  const parts = path.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new AppPackageError('NON_REGULAR_ARTIFACT');
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new AppPackageError('NON_REGULAR_ARTIFACT');
    if (stat.size > limit) throw new AppPackageError('PACKAGE_TOO_LARGE');
    // One extra byte detects growth without an unbounded readFile allocation.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) throw new AppPackageError('ARTIFACT_CHANGED');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export async function snapshotPackage(directory: string) {
  const input = resolve(directory);
  if ((await lstat(input)).isSymbolicLink()) throw new AppPackageError('SYMLINK_PACKAGE_ROOT');
  const root = await realpath(input);
  const parsed = parseAppManifestJson((await readRegular(root, 'manifest.json', MAX_APP_MANIFEST_BYTES)).toString('utf8'));
  if (!parsed.ok) throw new AppPackageError('INVALID_MANIFEST');
  const paths = new Set<string>(['manifest.json']);
  for (const artifact of parsed.manifest.artifacts) {
    const path = artifact.path.toLowerCase();
    if (paths.has(path)) throw new AppPackageError('PACKAGE_PATH_COLLISION');
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join('/'))) throw new AppPackageError('PACKAGE_PATH_COLLISION');
    }
  }
  let total = 0;
  for (const artifact of parsed.manifest.artifacts) {
    total += artifact.bytes;
    if (total > MAX_DEVELOPER_PACKAGE_BYTES) throw new AppPackageError('PACKAGE_TOO_LARGE');
  }
  const files = new Map<string, Buffer>();
  for (const artifact of parsed.manifest.artifacts) {
    const bytes = await readRegular(root, artifact.path, artifact.bytes);
    if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new AppPackageError('ARTIFACT_INTEGRITY_MISMATCH');
    files.set(artifact.path, bytes);
  }
  return { root, manifest: parsed.manifest, files, total };
}
export async function validateAppDirectory(directory: string): Promise<{ manifest: AppManifest; artifactBytes: number }> {
  const snapshot = await snapshotPackage(directory);
  return { manifest: snapshot.manifest, artifactBytes: snapshot.total };
}
export async function packAppDirectory(directory: string, destination: string) {
  const snapshot = await snapshotPackage(directory);
  const output = resolve(destination);
  const parent = await realpath(dirname(output));
  const actualOutput = join(parent, basename(output));
  const child = relative(snapshot.root, actualOutput);
  if (!child || (!child.startsWith(`..${sep}`) && child !== '..' && !child.startsWith(sep))) throw new AppPackageError('OUTPUT_INSIDE_INPUT');
  // Exclusive reservation; existing directories and files are never overwritten.
  await mkdir(actualOutput);
  try {
    await writeFile(join(actualOutput, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2) + '\n', { flag: 'wx' });
    for (const [path, bytes] of snapshot.files) {
      await mkdir(dirname(join(actualOutput, path)), { recursive: true });
      await writeFile(join(actualOutput, path), bytes, { flag: 'wx' });
    }
  } catch (error) { await rm(actualOutput, { recursive: true, force: true }); throw error; }
  return { appId: snapshot.manifest.id, version: snapshot.manifest.version, artifacts: snapshot.files.size, artifactBytes: snapshot.total };
}

/** Bounded local CLI sidecar/key read; same regular-file policy as package input. */
export async function readDeveloperFile(file: string, maxBytes: number) {
  const path = resolve(file);
  return readRegular(dirname(path), basename(path), maxBytes);
}
