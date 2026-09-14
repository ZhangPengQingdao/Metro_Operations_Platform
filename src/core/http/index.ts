export interface CoreApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

export interface ResolveApiBaseUrlOptions {
  configuredBaseUrl?: string;
  development?: boolean;
  location?: Pick<Location, 'protocol' | 'hostname'>;
}

export interface CoreApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}

export interface CoreApiClient {
  request<T>(path: string, options?: CoreApiRequestOptions): Promise<T>;
}

export interface CreateCoreApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class CoreApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'CoreApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function resolveApiBaseUrl(options: ResolveApiBaseUrlOptions = {}) {
  const configuredBaseUrl = options.configuredBaseUrl?.trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, '');
  }

  if (options.development && options.location && ['localhost', '127.0.0.1'].includes(options.location.hostname)) {
    return `${options.location.protocol}//${options.location.hostname}:3001`;
  }

  return '';
}

const moduleEnv = import.meta.env as Partial<ImportMetaEnv> | undefined;
const browserLocation = typeof window === 'undefined' ? undefined : window.location;

export const API_BASE_URL = resolveApiBaseUrl({
  configuredBaseUrl: moduleEnv?.VITE_API_BASE_URL,
  development: moduleEnv?.DEV,
  location: browserLocation
});

export function createCoreApiClient(options: CreateCoreApiClientOptions = {}): CoreApiClient {
  const baseUrl = (options.baseUrl ?? API_BASE_URL).replace(/\/$/, '');
  const fetchRequest = options.fetch ?? globalThis.fetch;

  return {
    async request<T>(path: string, request: CoreApiRequestOptions = {}) {
      const { timeoutMs, ...requestOptions } = request;
      const headers = new Headers(requestOptions.headers);
      const hasBody = requestOptions.body != null;
      const isFormData = typeof FormData !== 'undefined' && requestOptions.body instanceof FormData;

      if (hasBody && !isFormData && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const abort = createAbortContext(requestOptions.signal, timeoutMs);
      try {
        const response = await fetchRequest(`${baseUrl}${path}`, {
          ...requestOptions,
          credentials: requestOptions.credentials ?? 'include',
          headers,
          signal: abort.signal
        });
        const payload = await readJsonPayload<T & CoreApiErrorPayload>(response);

        if (!response.ok) {
          throw new CoreApiError(
            response.status,
            payload.error?.code || 'REQUEST_ERROR',
            payload.error?.message || '请求失败'
          );
        }

        return payload;
      } finally {
        abort.dispose();
      }
    }
  };
}

const coreApiClient = createCoreApiClient();

export function apiRequest<T>(path: string, options?: CoreApiRequestOptions): Promise<T> {
  return coreApiClient.request<T>(path, options);
}

export function getErrorMessage(error: unknown, fallback = '请求失败'): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}

async function readJsonPayload<T>(response: Response): Promise<T> {
  return response.json().catch(() => ({})) as Promise<T>;
}

function createAbortContext(signal: AbortSignal | null | undefined, timeoutMs: number | undefined) {
  if (timeoutMs === undefined) {
    return {
      signal: signal ?? undefined,
      dispose() {}
    };
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('API request timeout must be a positive integer.');
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  };
}
