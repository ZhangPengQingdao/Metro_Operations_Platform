import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateAppManifest } from '../manifest/index.js';

export class AppArtifactError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppArtifactError'; }
}
/** Platform-owned readers only; never interpret app archives, symlinks or URLs. */
export async function stageAppArtifacts(options: {
  root: string;
  manifest: unknown;
  read(artifactId: string, maxBytes: number): Promise<Uint8Array>;
}): Promise<{ path: string; manifestDigest: string }> {
  const parsed = validateAppManifest(options.manifest);
  if (!parsed.ok) throw new AppArtifactError('INVALID_MANIFEST');
  const manifest = parsed.manifest;
  const root = options.root, read = options.read;
  if (resolve(root) !== root || /[\x00-\x1f,]/.test(root)) throw new AppArtifactError('INVALID_ARTIFACT_ROOT');
  // Bounds apply before invoking a trusted reader. Reader must enforce its own stream limit.
  if (manifest.artifacts.length > 128 || manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0) > 64 * 1024 * 1024) throw new AppArtifactError('ARTIFACT_BUDGET');
  const paths = manifest.artifacts.map(item => item.path);
  if (paths.some((path, i) => paths.some((other, j) => i !== j && (path === other || path.startsWith(`${other}/`))))) throw new AppArtifactError('ARTIFACT_PATH_CONFLICT');
  const manifestDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  // Root is trusted infrastructure, never a path obtained from an app or remote caller.
  await mkdir(root, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const staging = join(root, `.staging-${token}`), destination = join(root, `bundle-${token}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const artifact of manifest.artifacts) {
      const bytes = await read(artifact.id, artifact.bytes);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== artifact.bytes) throw new AppArtifactError('ARTIFACT_SIZE_MISMATCH');
      // Copy before hash/write; retained buffers cannot mutate between verification and persistence.
      const snapshot = Buffer.from(bytes);
      if (createHash('sha256').update(snapshot).digest('hex') !== artifact.sha256) throw new AppArtifactError('ARTIFACT_HASH_MISMATCH');
      const parts = artifact.path.split('/');
      let parent = staging;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        await mkdir(parent, { recursive: true, mode: 0o755 });
        // Creation modes are masked by the host umask; published paths must be
        // traversable by the fixed nonroot container user.
        await chmod(parent, 0o755);
      }
      const file = await open(join(staging, artifact.path), 'wx', 0o444);
      try { await file.writeFile(snapshot); await file.chmod(0o444); await file.sync(); } finally { await file.close(); }
    }
    await chmod(staging, 0o755);
    await rename(staging, destination);
    return Object.freeze({ path: destination, manifestDigest });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error instanceof AppArtifactError ? error : new AppArtifactError('ARTIFACT_STAGE_FAILED');
  }
}
