import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppBackendEmployeeContext } from '@metro/platform-sdk/app-backend';
import type { ChildMessage, ParentMessage } from './protocol.js';

export class AppProcessError extends Error {
  constructor(readonly code: string, readonly writeOutcome: 'not_started' | 'unknown' = 'not_started') { super(code); this.name = 'AppProcessError'; }
}
export type AppProcessState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';
export interface AppProcessStatus { state: AppProcessState; pid: number | null; startedAt: string | null; restarts: number; lastExit: { at: string; code: number | null; signal: string | null } | null; logs: string[] }
export interface AppProcessOptions {
  appId: string;
  serverPath: string;
  cwd: string;
  memoryMiB?: number;
  timeoutMs?: number;
  /** Executes a platform operation for the child. `callId` identifies the employee call it belongs to, if any. */
  onPlatform(operation: string, params: unknown, callId: string | undefined): Promise<unknown>;
  log?(line: string): void;
}

const READY_TIMEOUT_MS = 15_000, STOP_GRACE_MS = 5_000, MAX_CALLS = 32, CRASH_WINDOW_MS = 5 * 60_000, CRASH_LIMIT = 5, LOG_LINES = 200;
const here = fileURLToPath(import.meta.url);
/** Under tsx (dev/tests) the entry is TypeScript; the compiled server forks the built .js file. */
const CHILD = here.endsWith('.ts') ? { path: here.replace(/process\.ts$/, 'child.ts'), execArgv: ['--import', import.meta.resolve('tsx')] } : { path: here.replace(/process\.js$/, 'child.js'), execArgv: [] };

/** One application back end in its own Node process; restarted with backoff when it exits unexpectedly. */
export class AppProcessV2 {
  private child: ChildProcess | null = null;
  private state: AppProcessState = 'stopped';
  private readonly calls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly crashes: number[] = [];
  private readonly logs: string[] = [];
  private restarts = 0;
  private startedAt: string | null = null;
  private lastExit: AppProcessStatus['lastExit'] = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private handlers: string[] = [];

  constructor(private readonly options: AppProcessOptions) {
    if (!existsSync(CHILD.path)) throw new AppProcessError('CHILD_ENTRY_MISSING');
  }

  status(): AppProcessStatus {
    return { state: this.state, pid: this.child?.pid ?? null, startedAt: this.startedAt, restarts: this.restarts, lastExit: this.lastExit, logs: [...this.logs] };
  }
  get handlerNames(): readonly string[] { return this.handlers; }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return;
    this.stopping = false;
    this.crashes.length = 0;
    await this.spawn();
  }

  call(api: string, input: unknown, employee: AppBackendEmployeeContext, signal?: AbortSignal, id: string = randomUUID()): Promise<unknown> {
    const child = this.child;
    if (this.state !== 'running' || !child?.connected) return Promise.reject(new AppProcessError('APP_NOT_RUNNING'));
    if (this.calls.size >= MAX_CALLS) return Promise.reject(new AppProcessError('APP_BUSY'));
    if (signal?.aborted) return Promise.reject(new AppProcessError('ABORTED'));
    if (this.calls.has(id)) return Promise.reject(new AppProcessError('DUPLICATE_CALL'));
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.calls.delete(id); };
      const onAbort = () => { this.send({ t: 'abort', id }); finish(); reject(new AppProcessError('ABORTED', 'unknown')); };
      const timer = setTimeout(() => { this.send({ t: 'abort', id }); finish(); reject(new AppProcessError('TIMEOUT', 'unknown')); }, this.options.timeoutMs ?? 30_000);
      this.calls.set(id, { resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); }, timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.send({ t: 'call', id, api, input, employee })) { finish(); reject(new AppProcessError('APP_NOT_RUNNING')); }
    });
  }

  /** Graceful stop: the app's stop() hook runs, then SIGKILL after a grace period. Pending calls fail as unknown. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const child = this.child;
    if (!child || child.exitCode !== null) { this.state = 'stopped'; return; }
    await new Promise<void>(resolve => {
      const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
      if (!this.send({ t: 'stop' })) child.kill('SIGTERM');
    });
    this.state = 'stopped';
  }

  private send(message: ParentMessage): boolean {
    const child = this.child;
    if (!child?.connected) return false;
    try { child.send(message); return true; } catch { return false; }
  }

  private record(line: string) {
    const entry = `[app:${this.options.appId}] ${line}`;
    this.logs.push(`${new Date().toISOString()} ${line}`);
    if (this.logs.length > LOG_LINES) this.logs.shift();
    (this.options.log ?? console.log)(entry);
  }

  private spawn(): Promise<void> {
    this.state = this.restarts && !this.stopping ? 'restarting' : 'starting';
    const memory = Math.min(Math.max(this.options.memoryMiB ?? 256, 64), 2048);
    const child = fork(CHILD.path, [this.options.serverPath, this.options.appId], {
      cwd: this.options.cwd,
      execArgv: [...CHILD.execArgv, `--max-old-space-size=${memory}`],
      // No platform secrets: only what a plain Node program needs.
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production', TZ: process.env.TZ ?? 'Asia/Shanghai', PATH: process.env.PATH ?? '', MOP_APP_ID: this.options.appId },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        buffer += chunk;
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) { this.record(buffer.slice(0, index).slice(0, 2000)); buffer = buffer.slice(index + 1); }
        if (buffer.length > 8000) { this.record(buffer.slice(0, 2000)); buffer = ''; }
      });
    }
    return new Promise<void>((resolve, reject) => {
      // Only a child that reached `ready` is restarted after exiting; start failures are reported once.
      let settled = false, readied = false;
      const ready = setTimeout(() => { if (!settled) { settled = true; this.state = 'failed'; child.kill('SIGKILL'); reject(new AppProcessError('APP_START_TIMEOUT')); } }, READY_TIMEOUT_MS);
      child.on('error', error => {
        this.record(`process error: ${error.message}`);
        if (!settled) { settled = true; clearTimeout(ready); this.state = 'failed'; reject(new AppProcessError('APP_START_FAILED')); }
      });
      child.on('message', (message: ChildMessage) => {
        if (message.t === 'ready') {
          readied = true; this.handlers = message.handlers; this.state = 'running'; this.startedAt = new Date().toISOString();
          if (!settled) { settled = true; clearTimeout(ready); resolve(); }
        } else if (message.t === 'fatal') {
          this.record(`fatal: ${message.code}`);
          if (!settled) { settled = true; clearTimeout(ready); this.state = 'failed'; reject(new AppProcessError(message.code)); }
        } else if (message.t === 'result') {
          const call = this.calls.get(message.id);
          if (!call) return;
          if (message.ok) call.resolve(message.result);
          else call.reject(new AppProcessError(message.code, 'unknown'));
        } else if (message.t === 'platform') {
          this.options.onPlatform(message.operation, message.params, message.callId).then(
            result => this.send({ t: 'platform-result', id: message.id, ok: true, result }),
            (error: { code?: string; writeOutcome?: 'not_started' | 'unknown' }) => this.send({ t: 'platform-result', id: message.id, ok: false, code: typeof error?.code === 'string' ? error.code : 'GATEWAY_FAILED', writeOutcome: error?.writeOutcome === 'unknown' ? 'unknown' : 'not_started' }),
          );
        }
      });
      child.on('exit', (code, signal) => {
        this.lastExit = { at: new Date().toISOString(), code, signal };
        if (this.child === child) this.child = null;
        for (const call of this.calls.values()) call.reject(new AppProcessError('APP_PROCESS_EXITED', 'unknown'));
        this.calls.clear();
        if (!settled) { settled = true; clearTimeout(ready); this.state = 'failed'; reject(new AppProcessError('APP_START_FAILED')); return; }
        if (this.stopping) { this.state = 'stopped'; return; }
        if (!readied) { this.state = 'failed'; return; }
        this.record(`exited unexpectedly (code ${code ?? '-'}, signal ${signal ?? '-'})`);
        const now = Date.now();
        this.crashes.push(now);
        while (this.crashes.length && this.crashes[0]! < now - CRASH_WINDOW_MS) this.crashes.shift();
        if (this.crashes.length >= CRASH_LIMIT) { this.state = 'failed'; this.record('too many crashes; restart stopped until the app is started again'); return; }
        this.state = 'restarting';
        const delay = Math.min(1000 * 2 ** (this.crashes.length - 1), 60_000);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.restarts++;
          this.spawn().catch(error => { this.record(`restart failed: ${(error as Error).message}`); this.state = 'failed'; });
        }, delay);
      });
    });
  }
}
