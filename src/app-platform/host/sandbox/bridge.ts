/** Platform Bridge, not the MCP Apps protocol. No operations are granted by default. */
export type SandboxJson = null | boolean | number | string | readonly SandboxJson[] | { readonly [key: string]: SandboxJson };
export interface SandboxBridgeOperation {
  validate(params: SandboxJson): boolean;
  authorize(params: SandboxJson, signal: AbortSignal): Promise<boolean>;
  execute(params: SandboxJson, signal: AbortSignal): Promise<SandboxJson>;
}
export type SandboxBridgeError = 'INVALID_REQUEST' | 'UNKNOWN_METHOD' | 'LIMIT_EXCEEDED' | 'DENIED' | 'FAILED';
export type SandboxBridgeResponse = {
  version: '1.0'; type: 'response'; appId: string; session: string; id: number;
} & ({ ok: true; result: SandboxJson } | { ok: false; error: SandboxBridgeError });
export interface SandboxBridgeOptions {
  appId: string;
  session: string;
  source: object;
  send(response: SandboxBridgeResponse): void;
  operations: ReadonlyMap<string, SandboxBridgeOperation>;
}

const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 16;
const encoder = new TextEncoder();

/** Copies data properties only; rejects accessors, exotic prototypes, cycles and non-JSON values. */
function snapshot(value: unknown): SandboxJson {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  function charge(text: string) {
    if (text.length > MAX_BYTES) throw new Error('budget');
    bytes += encoder.encode(text).byteLength;
    if (bytes > MAX_BYTES) throw new Error('budget');
  }
  function visit(input: unknown, depth: number): SandboxJson {
    if (depth > MAX_DEPTH || ++nodes > 8192) throw new Error('budget');
    if (input === null) { charge('null'); return null; }
    if (typeof input === 'boolean') { charge(String(input)); return input; }
    if (typeof input === 'number' && Number.isFinite(input)) { charge(String(input)); return input; }
    if (typeof input === 'string') {
      if (input.length > MAX_BYTES) throw new Error('budget');
      charge(JSON.stringify(input)); return input;
    }
    if (typeof input !== 'object' || input === null || ancestors.has(input)) throw new Error('json');
    const array = Array.isArray(input);
    const proto = Object.getPrototypeOf(input);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('prototype');
    const keys = Reflect.ownKeys(input);
    if (keys.length > 8192 || keys.some((key) => typeof key !== 'string')) throw new Error('keys');
    ancestors.add(input);
    charge(array ? '[]' : '{}');
    if (array) {
      const length = Object.getOwnPropertyDescriptor(input, 'length')?.value as unknown;
      if (typeof length !== 'number' || length > 8192 || keys.length !== length + 1) throw new Error('array');
      const result: SandboxJson[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('property');
        if (index) charge(',');
        result.push(visit(descriptor.value, depth + 1));
      }
      ancestors.delete(input); return Object.freeze(result);
    }
    const result: Record<string, SandboxJson> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('property');
      if (key.length > MAX_BYTES) throw new Error('budget');
      charge(JSON.stringify(key)); charge(':,');
      result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(input); return Object.freeze(result);
  }
  return visit(value, 0);
}

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export function createSandboxSession(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class SandboxBridgeBroker {
  private readonly options: SandboxBridgeOptions;
  private readonly operations: ReadonlyMap<string, SandboxBridgeOperation>;
  private readonly active = new Set<AbortController>();
  private closed = false;
  private lastId = 0;
  private accepted = 0;

  constructor(options: SandboxBridgeOptions) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.appId) || !/^[a-f0-9]{32}$/.test(options.session)
      || !options.source || typeof options.source !== 'object') throw new Error('Invalid sandbox binding');
    this.options = { ...options };
    this.operations = new Map(Array.from(options.operations, ([method, operation]) => [method, Object.freeze({ ...operation })]));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; // Abort listeners are synchronous and may reenter receive/close.
    const pending = Array.from(this.active);
    this.active.clear();
    for (const controller of pending) controller.abort();
  }

  private respond(response: SandboxBridgeResponse): void {
    if (this.closed) return;
    try { this.options.send(Object.freeze(response)); } catch { this.close(); }
  }

  async receive(event: { source: unknown; origin: string; data: unknown }): Promise<void> {
    if (this.closed || event.source !== this.options.source || event.origin !== 'null') return;
    const data = event.data;
    let id: number;
    try {
      if (!data || typeof data !== 'object' || own(data, 'version') !== '1.0' || own(data, 'type') !== 'request'
        || own(data, 'appId') !== this.options.appId || own(data, 'session') !== this.options.session) return;
      const candidate = own(data, 'id');
      if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 1 || candidate > 2147483647
        || candidate <= this.lastId || this.accepted >= 128) return;
      id = candidate;
    } catch { return; }
    this.lastId = id; this.accepted++;
    const base = { version: '1.0', type: 'response', appId: this.options.appId, session: this.options.session, id } as const;
    const reject = (error: SandboxBridgeError) => this.respond({ ...base, ok: false, error });
    let params: SandboxJson;
    let operation: SandboxBridgeOperation | undefined;
    try {
      const request = snapshot(data) as { readonly [key: string]: SandboxJson };
      if (Object.keys(request).length !== 7 || typeof request.method !== 'string' || request.method.length > 128
        || !Object.prototype.hasOwnProperty.call(request, 'params')) { reject('INVALID_REQUEST'); return; }
      operation = this.operations.get(request.method);
      if (!operation) { reject('UNKNOWN_METHOD'); return; }
      params = request.params;
    } catch { reject('INVALID_REQUEST'); return; }
    if (this.active.size >= 8) { reject('LIMIT_EXCEEDED'); return; }
    const controller = new AbortController();
    this.active.add(controller);
    const live = () => !this.closed && !controller.signal.aborted;
    try {
      const valid = operation.validate(params);
      if (!live()) return;
      if (valid !== true) { reject('INVALID_REQUEST'); return; }
      const allowed = await operation.authorize(params, controller.signal);
      if (!live()) return;
      if (allowed !== true) { reject('DENIED'); return; }
      const result = snapshot(await operation.execute(params, controller.signal));
      if (!live()) return;
      // Authorizers must resolve current platform/server grants, never trust caller scope.
      const stillAllowed = await operation.authorize(params, controller.signal);
      if (!live()) return;
      if (stillAllowed !== true) { reject('DENIED'); return; }
      const response = { ...base, ok: true, result } as const;
      snapshot(response); // Include envelope overhead in outbound budget.
      this.respond(response);
    } catch { if (live()) reject('FAILED'); }
    finally { this.active.delete(controller); }
  }
}
