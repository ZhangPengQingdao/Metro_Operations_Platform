import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { getCoreConfig } from '../core/config/index.js';

const SUPPORTED_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeCorsOrigin(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);

    if (!SUPPORTED_ORIGIN_PROTOCOLS.has(url.protocol)) return null;
    if (url.username || url.password) return null;

    return url.origin;
  } catch {
    return null;
  }
}

export function parseCorsOrigins(value: string): Set<string> {
  const origins = value
    .split(',')
    .map(normalizeCorsOrigin)
    .filter((origin): origin is string => origin !== null);

  return new Set(origins);
}

export function isCorsOriginAllowed(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  const normalizedOrigin = normalizeCorsOrigin(origin);
  if (!normalizedOrigin) return false;

  if (allowedOrigins.has(normalizedOrigin)) return true;

  const { hostname } = new URL(normalizedOrigin);
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export async function registerCors(app: FastifyInstance) {
  const allowedOrigins = parseCorsOrigins(getCoreConfig().http.corsOrigin.value);

  if (allowedOrigins.size === 0) {
    throw new Error('CORS_ORIGIN must contain at least one valid HTTP(S) origin');
  }

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (isCorsOriginAllowed(origin, allowedOrigins)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true
  });
}
