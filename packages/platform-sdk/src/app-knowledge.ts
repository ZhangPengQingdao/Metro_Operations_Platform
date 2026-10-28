import type { AppGatewayJson, createAppGatewayClient } from './app-gateway.js';

export interface KnowledgeTarget { libraryId: string; organizationId: string }
export type KnowledgeEntry = {
  id: string;
  title: string;
  content: string;
  metadata: Record<string, string>;
  version: number;
  indexStatus?: 'not_required' | 'unconfigured' | 'pending' | 'processing' | 'ready' | 'failed';
  indexError?: string;
}
export type KnowledgeWrite = KnowledgeTarget & { id: string; requestId: string } & (
  { action: 'save'; title: string; content: string; metadata: Record<string,string>; expectedVersion?: number }
  | { action: 'delete'; expectedVersion: number }
  | { action: 'reindex'; expectedVersion: number }
);

export interface KnowledgeSearchResult {entries:(KnowledgeEntry & {score:number;reference:KnowledgeTarget & {id:string;version:number}})[]; retrieval:{mode:'exact'|'text'|'semantic';reason?:'unconfigured'|'indexing'|'failed'}}

/** Employee-bound backend client. Libraries and permissions come from the installed app.json. */
export function createPlatformKnowledgeClient(gateway: Pick<ReturnType<typeof createAppGatewayClient>, 'invoke'>) {
  return {
    list(input: KnowledgeTarget & { afterId?: string }, signal?: AbortSignal) {
      return gateway.invoke('platform.knowledge.list', input as unknown as AppGatewayJson, signal) as Promise<{entries: KnowledgeEntry[]; nextCursor: string | null}>;
    },
    search(input: KnowledgeTarget & { query: string; limit?: number }, signal?: AbortSignal) {
      return gateway.invoke('platform.knowledge.search', input as unknown as AppGatewayJson, signal) as unknown as Promise<KnowledgeSearchResult>;
    },
    write(input: KnowledgeWrite, signal?: AbortSignal) {
      return gateway.invoke('platform.knowledge.write', input as unknown as AppGatewayJson, signal) as Promise<{id: string; version: number}>;
    },
  };
}
