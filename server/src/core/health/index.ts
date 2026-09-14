import type { FastifyInstance, FastifyReply } from 'fastify';
import { getCoreConfig } from '../config/index.js';
import type { RuntimeHealth, RuntimeState } from '../runtime/index.js';
import { getDatabasePool, checkDatabaseStatus } from '../database/index.js';

export interface HealthRouteDependencies {
  getRuntimeHealth?: () => Promise<RuntimeHealth>;
  getRuntimeState?: () => RuntimeState;
}

export async function registerHealthRoutes(app: FastifyInstance, dependencies: HealthRouteDependencies = {}) {
  const getRuntimeHealth = dependencies.getRuntimeHealth ?? getCompatibilityRuntimeHealth;
  const getRuntimeState = dependencies.getRuntimeState ?? (() => 'ready');

  const compatibilityHandler = async () => {
    const runtime = await getRuntimeHealth();

    return {
      success: true,
      data: {
        ok: true,
        service: 'metro-operations-platform-api',
        time: new Date().toISOString(),
        database: getDatabaseDependencyState(runtime),
        runtime
      }
    };
  };

  const livenessHandler = async (_request: unknown, reply: FastifyReply) => {
    const state = getRuntimeState();
    const ok = isRuntimeLive(state);
    if (!ok) reply.status(503);

    return {
      success: true,
      data: {
        ok,
        service: 'metro-operations-platform-api',
        version: getCoreConfig().runtime.releaseVersion.value,
        state,
        time: new Date().toISOString()
      }
    };
  };

  const readinessHandler = async (_request: unknown, reply: FastifyReply) => {
    const runtime = await getRuntimeHealth();
    const ok = runtime.state === 'ready';
    if (!ok) reply.status(503);

    return createRuntimeHealthResponse(runtime, ok);
  };

  app.get('/health', compatibilityHandler);
  app.get('/api/health', compatibilityHandler);
  app.get('/health/live', livenessHandler);
  app.get('/api/health/live', livenessHandler);
  app.get('/health/ready', readinessHandler);
  app.get('/api/health/ready', readinessHandler);
}

async function getCompatibilityRuntimeHealth(): Promise<RuntimeHealth> {
  const config = getCoreConfig();
  const database = await checkDatabaseStatus(getDatabasePool());
  const databaseRequired = config.database.url.isConfigured;

  return {
    name: 'metro-operations-platform-api',
    version: config.runtime.releaseVersion.value,
    state: databaseRequired && database !== 'up' ? 'degraded' : 'ready',
    dependencies: [
      {
        name: 'database',
        state: database,
        required: databaseRequired,
        checkedAt: new Date().toISOString()
      }
    ],
    checkedAt: new Date().toISOString()
  };
}

function getDatabaseDependencyState(runtime: RuntimeHealth) {
  return runtime.dependencies.find((dependency) => dependency.name === 'database')?.state ?? 'unconfigured';
}

function isRuntimeLive(state: RuntimeState) {
  return state !== 'failed' && state !== 'stopping' && state !== 'stopped';
}

function createRuntimeHealthResponse(runtime: RuntimeHealth, ok: boolean) {
  return {
    success: true,
    data: {
      ok,
      service: 'metro-operations-platform-api',
      version: runtime.version,
      time: new Date().toISOString(),
      database: getDatabaseDependencyState(runtime),
      runtime
    }
  };
}
