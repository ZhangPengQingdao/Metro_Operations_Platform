/** Transport-neutral L4 caller; host supplies Bridge or trusted server transport, never platform cookies. */
export const APP_GATEWAY_VERSION = '1.0' as const;
export type AppGatewayJson = null | boolean | number | string | readonly AppGatewayJson[] | { readonly [key: string]: AppGatewayJson };
export interface AppGatewayRequest { version: typeof APP_GATEWAY_VERSION; operation: string; params: AppGatewayJson }
export type AppGatewayTransport = (request: AppGatewayRequest, signal?: AbortSignal) => Promise<unknown>;
export class AppGatewayClientError extends Error {
  constructor(readonly code: string, readonly writeOutcome: 'not_started' | 'unknown' = 'unknown') { super(code); this.name = 'AppGatewayClientError'; }
}
/** No automatic retry: a lost response may follow a committed write. */
export function createAppGatewayClient(transport: AppGatewayTransport) {
  return Object.freeze({
    async invoke(operation: string, params: AppGatewayJson, signal?: AbortSignal): Promise<AppGatewayJson> {
      if (typeof operation !== 'string' || !/^[a-z][a-z0-9._-]{0,99}$/.test(operation)) throw new AppGatewayClientError('INVALID_REQUEST', 'not_started');
      if (signal?.aborted) throw new AppGatewayClientError('ABORTED', 'not_started');
      const request = Object.freeze({ version: APP_GATEWAY_VERSION, operation, params: boundedJson(params) });
      boundedJson(request);
      let response: AppGatewayJson;
      try { response = boundedJson(await transport(request, signal), 1048576); }
      catch (error) {
        if (error instanceof AppGatewayClientError) throw error;
        throw new AppGatewayClientError('TRANSPORT_FAILED');
      }
      if (signal?.aborted) throw new AppGatewayClientError('ABORTED');
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new AppGatewayClientError('INVALID_RESPONSE');
      const envelope = response as { readonly [key: string]: AppGatewayJson };
      if (envelope.version !== APP_GATEWAY_VERSION) throw new AppGatewayClientError('INVALID_RESPONSE');
      if ('error' in envelope) {
        const error = envelope.error;
        if (Object.keys(envelope).length !== 2 || !error || typeof error !== 'object' || Array.isArray(error)) throw new AppGatewayClientError('INVALID_RESPONSE');
        const failure = error as { readonly [key: string]: AppGatewayJson };
        if (Object.keys(failure).length !== 2 || typeof failure.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)
          || !['not_started','unknown'].includes(String(failure.writeOutcome))) throw new AppGatewayClientError('INVALID_RESPONSE');
        throw new AppGatewayClientError(failure.code, failure.writeOutcome as 'not_started' | 'unknown');
      }
      if (Object.keys(envelope).length !== 4 || typeof envelope.requestId !== 'string' || !envelope.requestId || envelope.requestId.length > 200
        || typeof envelope.traceId !== 'string' || !envelope.traceId || envelope.traceId.length > 200 || !('result' in envelope)) throw new AppGatewayClientError('INVALID_RESPONSE');
      return envelope.result!;
    }
  });
}
function boundedJson(input: unknown, maxBytes = 65536): AppGatewayJson {
  let bytes = 0;
  const encoder = new TextEncoder();
  const charge = (text: string) => { bytes += encoder.encode(text).byteLength; if (bytes > maxBytes) throw new AppGatewayClientError('INVALID_JSON'); };
  let nodes = 0;
  const ancestors = new Set<object>();
  function copy(value: unknown, depth: number): AppGatewayJson {
    if (++nodes > (maxBytes > 65536 ? 10010 : 10000) || depth > (maxBytes > 65536 ? 26 : 24)) throw new AppGatewayClientError('INVALID_JSON');
    if (value === null) { charge('null'); return null; }
    if (typeof value === 'boolean') { charge(String(value)); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { charge(String(value)); return value; }
    if (typeof value === 'string' && value.length <= maxBytes) { charge(JSON.stringify(value)); return value; }
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new AppGatewayClientError('INVALID_JSON');
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new AppGatewayClientError('INVALID_JSON');
    const keys = Reflect.ownKeys(value);
    if (keys.length > 10000 || keys.some(key => typeof key !== 'string')) throw new AppGatewayClientError('INVALID_JSON');
    ancestors.add(value); charge(array ? '[]' : '{}');
    let output: AppGatewayJson;
    if (array) {
      if (keys.length !== value.length + 1) throw new AppGatewayClientError('INVALID_JSON');
      const result: AppGatewayJson[] = [];
      for (let index=0;index<value.length;index++) {
        const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AppGatewayClientError('INVALID_JSON');
        if (index) charge(',');
        result.push(copy(descriptor.value,depth+1));
      }
      output=Object.freeze(result);
    } else {
      const result: Record<string,AppGatewayJson> = Object.create(null);
      for (const key of keys as string[]) {
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || key.length>maxBytes) throw new AppGatewayClientError('INVALID_JSON');
        charge(JSON.stringify(key)); charge(':,');
        result[key]=copy(descriptor.value,depth+1);
      }
      output=Object.freeze(result);
    }
    ancestors.delete(value);return output;
  }
  const output=copy(input,0);
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength>maxBytes) throw new AppGatewayClientError('INVALID_JSON');
  return output;
}

export type AppDataMutation =
  | {action:'insert';table:string;id:string;values:Readonly<Record<string,AppGatewayJson>>}
  | {action:'update';table:string;id:string;values:Readonly<Record<string,AppGatewayJson>>;expected:Readonly<Record<string,AppGatewayJson>>}
  | {action:'delete';table:string;id:string;expected:Readonly<Record<string,AppGatewayJson>>};
export type AppDataFilter = {column:string;value:string|number|boolean|null} | {column:string;contains:readonly Readonly<Record<string,string|number|boolean|null>>[]};
export interface AppDataListOptions {
  order?:{column:string;direction:'asc'|'desc'};
  after?:{value:string;id:string};
  range?:{column:string;from?:string;to?:string};
  afterId?:string;
  pageSize?:number;
  filters?:readonly AppDataFilter[];
  anyOf?:readonly (readonly AppDataFilter[])[];
  search?:{column:string;text:string};
}
export type AppDataRead = {table:string;id:string} | ({table:string}&AppDataListOptions&{pageSize:number});
/** Service backend only. Persist one requestId per write intent; this helper never retries. */
export function createAppDataClient(gateway:Pick<ReturnType<typeof createAppGatewayClient>,'invoke'>){
  return Object.freeze({
    readBatch(operations:readonly AppDataRead[],signal?:AbortSignal){return gateway.invoke('platform.app_data.read_batch',{operations} as unknown as AppGatewayJson,signal);},
    transaction(requestId:string,operations:readonly AppDataMutation[],signal?:AbortSignal){return gateway.invoke('platform.app_data.transaction',{requestId,operations},signal);},
    list(table:string,options:AppDataListOptions={},signal?:AbortSignal){return gateway.invoke('platform.app_data.list',{table,...options},signal);},
    get(table:string,id:string,signal?:AbortSignal){return gateway.invoke('platform.app_data.get',{table,id},signal);},
    insert(table:string,id:string,requestId:string,values:Readonly<Record<string,AppGatewayJson>>,signal?:AbortSignal){
      return gateway.invoke('platform.app_data.write',{table,id,requestId,action:'insert',values},signal);
    },
    update(table:string,id:string,requestId:string,values:Readonly<Record<string,AppGatewayJson>>,signal?:AbortSignal){
      return gateway.invoke('platform.app_data.write',{table,id,requestId,action:'update',values},signal);
    },
    delete(table:string,id:string,requestId:string,signal?:AbortSignal){return gateway.invoke('platform.app_data.write',{table,id,requestId,action:'delete'},signal);},
  });
}

/** Backend clients use the host-bound employee identity; no personId is accepted for signing. */
export function createPlatformSignaturesClient(gateway:Pick<ReturnType<typeof createAppGatewayClient>,'invoke'>){
 return Object.freeze({
  associate(params:{entityId:string;title:string;organizationUnitId:string;personIds:readonly string[]},signal?:AbortSignal){return gateway.invoke('platform.signatures.associate',params,signal);},
  get(entityId:string,signal?:AbortSignal,evidencePersonId?:string){return gateway.invoke('platform.signatures.get',{entityId,...(evidencePersonId?{evidencePersonId}:{})},signal);},
  sign(entityId:string,image:string,signal?:AbortSignal){return gateway.invoke('platform.signatures.sign',{entityId,image},signal);},
 });
}
export function createPlatformWebhookClient(gateway:Pick<ReturnType<typeof createAppGatewayClient>,'invoke'>){
 return Object.freeze({send(params:{url:string;message:string;messageType?:'text'|'markdown'},signal?:AbortSignal){return gateway.invoke('platform.webhook.send',params,signal);}});
}
