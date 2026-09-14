export type RuntimeDependencyState = 'up' | 'down' | 'degraded' | 'unconfigured';
export type RuntimeState = 'created' | 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped' | 'failed';

export interface RuntimeDependencyHealth {
  name: string;
  state: RuntimeDependencyState;
  required: boolean;
  message?: string;
  checkedAt: string;
}

export interface RuntimeHealth {
  name: string;
  version: string;
  state: RuntimeState;
  dependencies: RuntimeDependencyHealth[];
  checkedAt: string;
}

export interface RuntimeDependency {
  name: string;
  required?: boolean;
  check(): Promise<RuntimeDependencyState | Omit<RuntimeDependencyHealth, 'name' | 'required' | 'checkedAt'>>;
}

export interface RuntimeLifecycle<TApp> {
  start(): Promise<TApp>;
  ready(): Promise<RuntimeHealth>;
  shutdown(reason?: string): Promise<void>;
  getApp(): TApp | null;
  getState(): RuntimeState;
}

export interface RuntimeLifecycleOptions<TApp> {
  name: string;
  version: string;
  createApp(): Promise<TApp>;
  startApp(app: TApp): Promise<void>;
  stopApp?: (app: TApp, reason: string) => Promise<void>;
  dependencies?: RuntimeDependency[];
}

function normalizeDependencyHealth(
  dependency: RuntimeDependency,
  result: RuntimeDependencyState | Omit<RuntimeDependencyHealth, 'name' | 'required' | 'checkedAt'>,
  checkedAt: string
): RuntimeDependencyHealth {
  const required = dependency.required ?? true;
  if (typeof result === 'string') {
    return {
      name: dependency.name,
      state: result,
      required,
      checkedAt
    };
  }

  return {
    ...result,
    name: dependency.name,
    required,
    checkedAt
  };
}

export function createRuntimeLifecycle<TApp>(options: RuntimeLifecycleOptions<TApp>): RuntimeLifecycle<TApp> {
  let app: TApp | null = null;
  let state: RuntimeState = 'created';

  async function checkDependencies(): Promise<RuntimeDependencyHealth[]> {
    return Promise.all((options.dependencies ?? []).map(async (dependency) => {
      const checkedAt = new Date().toISOString();
      try {
        return normalizeDependencyHealth(dependency, await dependency.check(), checkedAt);
      } catch (error) {
        return {
          name: dependency.name,
          state: 'down',
          required: dependency.required ?? true,
          message: error instanceof Error ? error.message : 'Dependency check failed',
          checkedAt
        };
      }
    }));
  }

  return {
    async start() {
      if (app && (state === 'ready' || state === 'degraded')) {
        return app;
      }
      if (state === 'starting' || state === 'stopping') {
        throw new Error(`Runtime ${options.name} cannot start while ${state}`);
      }

      state = 'starting';
      try {
        app = await options.createApp();
        await options.startApp(app);
        const dependencies = await checkDependencies();
        state = dependencies.some((dependency) => dependency.required && dependency.state !== 'up')
          ? 'degraded'
          : 'ready';
        return app;
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },

    async ready() {
      const dependencies = await checkDependencies();
      if (state !== 'stopping' && state !== 'stopped' && state !== 'failed') {
        state = dependencies.some((dependency) => dependency.required && dependency.state !== 'up')
          ? 'degraded'
          : 'ready';
      }

      return {
        name: options.name,
        version: options.version,
        state,
        dependencies,
        checkedAt: new Date().toISOString()
      };
    },

    async shutdown(reason = 'shutdown') {
      if (!app || state === 'stopped') {
        state = 'stopped';
        return;
      }
      if (state === 'stopping') {
        return;
      }

      state = 'stopping';
      try {
        await options.stopApp?.(app, reason);
      } finally {
        state = 'stopped';
      }
    },

    getApp() {
      return app;
    },

    getState() {
      return state;
    }
  };
}
