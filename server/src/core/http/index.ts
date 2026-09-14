import { randomUUID } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import type { CoreConfig } from '../config/index.js';

export type HttpErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'REQUEST_ERROR'
  | 'INTERNAL_ERROR';

export interface ErrorResponseEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface NormalizedHttpError {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: HttpErrorCode | string;

  constructor(statusCode: number, code: HttpErrorCode | string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createRequestId(prefix = 'req'): string {
  return `${prefix}_${randomUUID()}`;
}

export function createHttpError(statusCode: number, code: HttpErrorCode | string, message: string): HttpError {
  return new HttpError(statusCode, code, message);
}

export function createFastifyRuntimeOptions(
  config: Pick<CoreConfig, 'runtime' | 'http'>
): Pick<FastifyServerOptions, 'logger' | 'trustProxy' | 'genReqId'> {
  const trustedProxyCidrs = config.http.trustedProxyCidrs.value;

  return {
    logger: config.runtime.nodeEnv.value !== 'test',
    trustProxy: trustedProxyCidrs.length ? [...trustedProxyCidrs] : false,
    genReqId: () => createRequestId()
  };
}

export function normalizeHttpError(error: FastifyError | Error | unknown): NormalizedHttpError {
  const candidate = isObject(error) ? error : {};
  const rawStatusCode = 'statusCode' in candidate ? candidate.statusCode : undefined;
  const statusCode = typeof rawStatusCode === 'number' && rawStatusCode >= 400 ? rawStatusCode : 500;
  const rawCode = 'code' in candidate ? candidate.code : undefined;
  const rawMessage = error instanceof Error ? error.message : undefined;

  return {
    statusCode,
    code: statusCode >= 500 ? 'INTERNAL_ERROR' : typeof rawCode === 'string' ? rawCode : 'REQUEST_ERROR',
    message: rawMessage || 'Unexpected server error'
  };
}

export function createErrorResponseEnvelope(error: NormalizedHttpError): ErrorResponseEnvelope {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message
    }
  };
}

export async function registerCoreErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const normalized = normalizeHttpError(error);

    reply.status(normalized.statusCode).send(createErrorResponseEnvelope(normalized));
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
