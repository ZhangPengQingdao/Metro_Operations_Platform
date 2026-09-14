import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export async function registerSecurity(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'", 'blob:']
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    frameguard: { action: 'sameorigin' },
    hsts: { maxAge: 31_536_000, includeSubDomains: false, preload: false },
    referrerPolicy: { policy: 'no-referrer' }
  });

  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => Object.assign(
      new Error(`请求过于频繁，请在 ${Math.ceil(context.ttl / 1000)} 秒后重试`),
      { statusCode: context.statusCode, code: 'RATE_LIMITED' }
    )
  });
}
