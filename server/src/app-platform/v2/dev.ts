import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { PlatformAdministratorContext } from '../../platform/context/index.js';

/** Fixed identity recorded in installation history for development-mode installs. */
export const DEV_ADMINISTRATOR_ID = '00000000-0000-4000-8000-00000000de70';

/** Synthetic administrator for local development installs; never available in production. */
export function devAdministratorContext(): PlatformAdministratorContext {
  const now = new Date().toISOString();
  return {
    actorType: 'administrator', execution: { type: 'platform' },
    administrator: { id: DEV_ADMINISTRATOR_ID, username: 'dev-mode', displayName: '本地开发模式' },
    request: { requestId: DEV_ADMINISTRATOR_ID, traceId: DEV_ADMINISTRATOR_ID, startedAt: now },
    authorize: async (permissionCode: string) => ({ id: DEV_ADMINISTRATOR_ID, allowed: true, reasonCode: 'allowed', permissionCode, subjectType: 'administrator', effectiveScopes: [{ source: 'role', scope: { kind: 'all', targets: [] } }], decidedAt: new Date().toISOString() }),
  } as unknown as PlatformAdministratorContext;
}

/**
 * Development mode (`MOP_DEV_APPS_DIR`): installs every `*.mopkg` written to the folder, including
 * rebuilds of the same version, so `mop-app dev` changes show up after a page refresh.
 */
export async function startDevAppsWatcher(options: { directory: string; install(bytes: Uint8Array, file: string): Promise<string>; log(line: string): void }) {
  if (process.env.NODE_ENV === 'production') throw new Error('MOP_DEV_APPS_DIR_NOT_ALLOWED_IN_PRODUCTION');
  if (!isAbsolute(options.directory)) throw new Error('MOP_DEV_APPS_DIR_MUST_BE_ABSOLUTE');
  const timers = new Map<string, NodeJS.Timeout>();
  let queue: Promise<void> = Promise.resolve();
  const schedule = (file: string) => {
    if (!file.endsWith('.mopkg')) return;
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
      timers.delete(file);
      queue = queue.then(async () => {
        const bytes = await readFile(join(options.directory, file)).catch(() => null);
        if (!bytes) return;
        try { options.log(`[dev] ${file}: ${await options.install(bytes, file)}`); }
        catch (error) {
          const issues = (error as { issues?: { path: string; message: string }[] }).issues ?? [];
          options.log(`[dev] ${file}: 安装失败 ${(error as { code?: string }).code ?? (error as Error).message}${issues.map(issue => `\n  ${issue.path}：${issue.message}`).join('')}`);
        }
      });
    }, 300));
  };
  for (const file of await readdir(options.directory).catch(() => [] as string[])) schedule(file);
  const watcher = watch(options.directory, (_event, file) => { if (file) schedule(String(file)); });
  options.log(`[dev] 开发模式：监听 ${options.directory} 中的 .mopkg`);
  return () => { watcher.close(); for (const timer of timers.values()) clearTimeout(timer); };
}
