import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';

export async function registerMultipart(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024
    }
  });
}
