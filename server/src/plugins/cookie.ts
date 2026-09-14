import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { getCoreConfig } from '../core/config/index.js';

export async function registerCookie(app: FastifyInstance) {
  const sessionSecret = getCoreConfig().session.secret.reveal();

  if (!sessionSecret) {
    throw new Error('SESSION_SECRET must be configured');
  }

  await app.register(cookie, {
    secret: sessionSecret
  });
}
