export type BrowserRuntimeState = 'created' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface BrowserRuntimeHealth {
  name: string;
  version: string;
  state: BrowserRuntimeState;
  checkedAt: string;
}

export interface BrowserRuntime {
  start(): void;
  ready(): BrowserRuntimeHealth;
  shutdown(reason?: string): void;
  getState(): BrowserRuntimeState;
}

export interface BrowserRuntimeOptions {
  name: string;
  version: string;
  mount(): () => void;
  onShutdown?: (reason: string) => void;
}

export function createBrowserRuntime(options: BrowserRuntimeOptions): BrowserRuntime {
  let state: BrowserRuntimeState = 'created';
  let unmount: (() => void) | null = null;

  return {
    start() {
      if (state === 'ready') return;
      if (state === 'starting' || state === 'stopping') {
        throw new Error(`Browser runtime ${options.name} cannot start while ${state}`);
      }

      state = 'starting';
      try {
        unmount = options.mount();
        state = 'ready';
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },

    ready() {
      return {
        name: options.name,
        version: options.version,
        state,
        checkedAt: new Date().toISOString()
      };
    },

    shutdown(reason = 'shutdown') {
      if (state === 'stopped') return;

      state = 'stopping';
      try {
        unmount?.();
        options.onShutdown?.(reason);
      } finally {
        unmount = null;
        state = 'stopped';
      }
    },

    getState() {
      return state;
    }
  };
}
