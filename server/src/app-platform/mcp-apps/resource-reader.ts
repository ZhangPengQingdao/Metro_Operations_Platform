import {isDeepStrictEqual} from 'node:util';
import type {Client} from '@modelcontextprotocol/client';
import type {PlatformMcpToolResult} from '../../platform/mcp/index.js';
import {admitMcpView, type McpViewAdmissionOptions} from './admission.js';

/** One bounded cache per owned extension generation. Contains static bytes only. */
export class McpViewResourceCache {
  private entries = new Map<string, unknown>();
  constructor(private readonly signal: AbortSignal) {signal.addEventListener('abort', () => this.entries.clear(), {once:true});}
  get(key:string) {return this.signal.aborted ? undefined : structuredClone(this.entries.get(key));}
  set(key:string,value:unknown) {
    if (this.signal.aborted) return;
    if (this.entries.size >= 8 && !this.entries.has(key)) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key,structuredClone(value));
  }
}

/** The client is connected by trusted host composition, never by a model-provided URL. */
export async function readInstalledMcpView(
  options: McpViewAdmissionOptions & {client: Pick<Client, 'readResource'>; cache?: McpViewResourceCache},
  toolName: string,
  result: PlatformMcpToolResult,
) {
  const admitted = await admitMcpView(options, toolName, result);
  if (admitted.kind === 'text') return admitted;
  const fallback = {kind: 'text' as const, result: admitted.result, reason: 'CARD_UNAVAILABLE' as const};
  try {
    const resource = admitted.resource;
    const key = JSON.stringify([admitted.installationId,admitted.revision,admitted.version,admitted.contributionId,resource.uri,resource.sha256]);
    const response = options.cache?.get(key) ?? await options.client.readResource({uri: resource.uri}, {timeout: 10_000});
    // Static resources have exactly one canonical representation. Reject changes to
    // bytes, URI, MIME and security metadata, including additional content entries.
    const expected = {contents: [{uri: resource.uri, mimeType: resource.mimeType, text: resource.html,
      ...(resource._meta === undefined ? {} : {_meta: resource._meta})}]};
    if (!isDeepStrictEqual(response, expected)) return fallback;
    const current = await admitMcpView(options, toolName, admitted.result);
    if (!isDeepStrictEqual(current, admitted)) return fallback;
    options.cache?.set(key,expected);
    return current;
  } catch {
    return fallback;
  }
}
