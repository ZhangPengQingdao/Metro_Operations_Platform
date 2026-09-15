import type { PlatformActorContext } from '../../platform/context/index.js';
import type { AuthorizationResource } from '../../platform/authorization/index.js';
export type GatewayJson = null | boolean | number | string | readonly GatewayJson[] | { readonly [key: string]: GatewayJson };
export interface AppGatewayRequest { version: '1.0'; operation: string; params: GatewayJson }
export interface AppGatewayResponse { version: '1.0'; requestId: string; traceId: string; result: GatewayJson }
/** Platform composition only. Adapters must constrain all returned data to these targets. */
export interface AppGatewayOperation {
  name: string;
  permissionCode: string;
  mode: 'read' | 'write';
  validateParams(value: GatewayJson): boolean;
  resolveResources(context: PlatformActorContext, params: GatewayJson): Promise<readonly AuthorizationResource[]>;
  execute(context: PlatformActorContext, params: GatewayJson, signal: AbortSignal): Promise<unknown>;
  validateResult(value: GatewayJson): boolean;
  /** Recheck the actual returned snapshot, even if its current database location has changed. */
  resolveResultResources?(context: PlatformActorContext, result: GatewayJson): Promise<readonly AuthorizationResource[]>;
}
const PUBLIC_CODES = new Set(['STORAGE_TABLE_UNSUPPORTED','STORAGE_BUSY','STORAGE_REQUEST_ALREADY_RECORDED','STORAGE_WRITE_RECONCILIATION_REQUIRED','STORAGE_WRITE_UNCERTAIN','STORAGE_OPERATION_FAILED','STORAGE_CLEANUP_REQUIRED','STORAGE_RESULT_LIMIT','INVALID_PAYLOAD','PAYLOAD_TOO_LARGE','INVALID_REQUEST','RATE_LIMITED','BUSY','INVALID_CREDENTIAL','INVALID_IDENTITY','ABORTED','TIMEOUT','OPERATION_DENIED','INVALID_PARAMS','ACCESS_DENIED','INVALID_RESULT','GATEWAY_FAILED','AUDIT_FAILED','METHOD_NOT_ALLOWED','HEADERS_TOO_LARGE','INVALID_HEADERS','UNSUPPORTED_MEDIA_TYPE','INVALID_JSON']);
export class GatewayError extends Error {
  readonly code: string;
  constructor(code: string, readonly statusCode = 400, readonly writeOutcome: 'not_started' | 'unknown' = 'not_started') {
    const safeCode=PUBLIC_CODES.has(code)?code:'GATEWAY_FAILED';
    super(safeCode); this.code=safeCode; this.name = 'GatewayError';
  }
}
export function jsonSnapshot(input: unknown, maxBytes: number): GatewayJson {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): GatewayJson {
    if (++nodes > 10000 || depth > 24) throw new GatewayError('INVALID_PAYLOAD');
    if (value === null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > maxBytes) throw new GatewayError('PAYLOAD_TOO_LARGE', 413); return value; }
    if (!value || typeof value !== 'object' || seen.has(value)) throw new GatewayError('INVALID_PAYLOAD');
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10000) throw new GatewayError('INVALID_PAYLOAD');
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new GatewayError('INVALID_PAYLOAD');
      return Object.freeze(Array.from({length:value.length},(_,i)=>{
        const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
        if(!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new GatewayError('INVALID_PAYLOAD');
        return visit(descriptor.value,depth+1);
      }));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new GatewayError('INVALID_PAYLOAD');
    const output: Record<string, GatewayJson> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key)) throw new GatewayError('INVALID_PAYLOAD');
      const descriptor = Object.getOwnPropertyDescriptor(value,key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new GatewayError('INVALID_PAYLOAD');
      bytes += Buffer.byteLength(key); if (bytes > maxBytes) throw new GatewayError('PAYLOAD_TOO_LARGE',413);
      output[key] = visit(descriptor.value,depth+1);
    }
    return Object.freeze(output);
  }
  const result = visit(input,0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new GatewayError('PAYLOAD_TOO_LARGE',413);
  return result;
}
export function parseGatewayRequest(input: unknown, maxBytes: number): AppGatewayRequest {
  const value = jsonSnapshot(input,maxBytes) as Record<string,GatewayJson>;
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'operation,params,version' || value.version !== '1.0' || typeof value.operation !== 'string' || !/^[a-z][a-z0-9._-]{0,99}$/.test(value.operation)) throw new GatewayError('INVALID_REQUEST');
  return value as unknown as AppGatewayRequest;
}
