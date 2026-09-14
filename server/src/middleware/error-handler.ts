import type { FastifyInstance } from 'fastify';
import { registerCoreErrorHandler } from '../core/http/index.js';

export async function registerErrorHandler(app: FastifyInstance) {
  await registerCoreErrorHandler(app);
}
