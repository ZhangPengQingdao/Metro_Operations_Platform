import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const APP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, SHA = /^[a-f0-9]{64}$/;
const COMPLETE = '.complete';

/** Extracted v2 packages: `<root>/<appId>/<sha256>/`. A directory is immutable once its marker exists. */
export class AppPackageStoreV2 {
  constructor(private readonly root: string) {}

  directory(appId: string, sha256: string): string {
    if (!APP_ID.test(appId) || appId.length > 64 || !SHA.test(sha256)) throw new Error('INVALID_PACKAGE_REFERENCE');
    return join(this.root, appId, sha256);
  }

  /** Writes all files to a temporary directory and renames it into place, so readers never see a partial package. */
  async write(appId: string, sha256: string, files: ReadonlyMap<string, Uint8Array>): Promise<string> {
    const target = this.directory(appId, sha256);
    if (await this.complete(target)) return target;
    const staging = join(this.root, appId, `.staging-${randomUUID()}`);
    try {
      for (const [path, data] of files) {
        await mkdir(join(staging, path, '..'), { recursive: true });
        await writeFile(join(staging, path), data, { flag: 'wx', mode: 0o640 });
      }
      await writeFile(join(staging, COMPLETE), new Date().toISOString(), { flag: 'wx' });
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return target;
  }

  async read(appId: string, sha256: string, path: 'ui.js' | 'ui.css' | 'icon.svg' | 'icon.png'): Promise<Buffer | null> {
    const directory = this.directory(appId, sha256);
    if (!(await this.complete(directory))) return null;
    return readFile(join(directory, path)).catch(() => null);
  }

  private complete(directory: string) { return stat(join(directory, COMPLETE)).then(() => true, () => false); }
}
