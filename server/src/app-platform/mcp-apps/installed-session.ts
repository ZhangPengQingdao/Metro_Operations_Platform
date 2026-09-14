import type {Client} from '@modelcontextprotocol/client';
import {CallToolResultSchema} from '../../core/integrations/mcp/index.js';
import {assertPlatformMcpToolContribution, assertPlatformMcpToolResult, validatePlatformMcpArguments, type PlatformMcpToolResult} from '../../platform/mcp/index.js';
import type {PlatformActorContext} from '../../platform/context/index.js';
import type {AppExtensionHandle} from '../extensions/index.js';
import type {McpViewAdmissionOptions} from './admission.js';
import {readInstalledMcpView, type McpViewResourceCache} from './resource-reader.js';
import {decideMcpViewPolicy, emptyMcpViewPolicy, type McpViewPolicy} from './policy.js';

/** Trusted composition only. All app actions use the existing L4 Gateway boundary. */
export async function openInstalledMcpView(options: McpViewAdmissionOptions & {
  client: Pick<Client, 'readResource'>;
  cache?: McpViewResourceCache;
  extension: Pick<AppExtensionHandle, 'appId' | 'installationId' | 'version' | 'revision' | 'signal' | 'invoke'>;
  resolveActor(): Promise<PlatformActorContext>;
  policy?: {approval: {installationId: string; revision: number; policy: McpViewPolicy}; host: McpViewPolicy};
  /** Metadata-only audit sink owned by platform composition. */
  audit?(event: {appId: string; revision?: number; resourceHash?: string; policyId?: string; outcome: 'ready' | 'denied' | 'closed'}): void;
}, toolName: string, result: PlatformMcpToolResult) {
  assertPlatformMcpToolResult(result);
  try {
    assertPlatformMcpToolContribution(options.contribution);
    const {callTool, ...metadata} = options.contribution;
    options = {...options, contribution:{...structuredClone(metadata),callTool}, policy:options.policy ? structuredClone(options.policy) : undefined};
  } catch {return {kind:'text' as const,result:structuredClone(result),reason:'CARD_UNAVAILABLE' as const};}
  const view = await readInstalledMcpView(options, toolName, result);
  if (view.kind === 'text') {options.audit?.({appId: options.appId, outcome:'denied'}); return view;}
  const extension = options.extension;
  if (!extension.signal || extension.signal.aborted || extension.appId !== options.appId ||
      extension.installationId !== view.installationId || extension.revision !== view.revision || extension.version !== view.version) {
    return {kind: 'text' as const, result: view.result, reason: 'CARD_UNAVAILABLE' as const};
  }
  const controller = new AbortController();
  const installation = await options.getInstallation();
  if (!installation || installation.id !== view.installationId || installation.revision !== view.revision || extension.signal.aborted) {
    return {kind:'text' as const, result:view.result, reason:'CARD_UNAVAILABLE' as const};
  }
  let decision: ReturnType<typeof decideMcpViewPolicy>;
  try {
    decision = decideMcpViewPolicy(installation, view.resource._meta?.ui,
      options.policy?.approval ?? {installationId: installation.id, revision: installation.revision, policy: emptyMcpViewPolicy()},
      options.policy?.host ?? emptyMcpViewPolicy());
  } catch {return {kind:'text' as const,result:view.result,reason:'CARD_UNAVAILABLE' as const};}
  const audit = (outcome:'ready'|'closed') => options.audit?.({appId: options.appId, revision:view.revision, resourceHash:view.resource.sha256, policyId:decision.id, outcome});
  const close = () => {
    if (controller.signal.aborted) return;
    controller.abort(); extension.signal!.removeEventListener('abort', close); audit('closed');
  };
  extension.signal.addEventListener('abort', close, {once: true});
  const tools = structuredClone(options.contribution.tools);
  const check = () => {if (controller.signal.aborted) throw new Error('CARD_UNAVAILABLE');};
  try {audit('ready');} catch {extension.signal.removeEventListener('abort',close);controller.abort();throw new Error('CARD_UNAVAILABLE');}
  return {...view, policy:decision, signal: controller.signal, close,
    async callTool(name: string, args: Record<string, unknown>) {
      try {
        check();
        const tool = tools.find(item => item.name === name && item.owner.type === 'application' && item.owner.id === options.appId);
        if (!tool || (tool._meta?.ui.visibility && !tool._meta.ui.visibility.includes('app'))) throw new Error('CARD_UNAVAILABLE');
        validatePlatformMcpArguments(args, tool.inputSchema);
        const snapshot = structuredClone(args);
        const actor = await options.resolveActor(); check();
        if (!(await actor.authorize('platform.mcp.use')).allowed) throw new Error('CARD_UNAVAILABLE');
        check();
        // Extension invoke checks current installation + identity + per-tool permission,
        // then executes Gateway exactly once. It also rejects undeclared/cross-app tools.
        const output = await extension.invoke(actor, 'tool', name, snapshot, controller.signal); check();
        const parsed = CallToolResultSchema.parse(output);
        const complete = {...parsed, resultType: 'complete' as const};
        assertPlatformMcpToolResult(complete);
        if (tool.outputSchema && !complete.isError) validatePlatformMcpArguments(complete.structuredContent, tool.outputSchema);
        return complete;
      } catch { throw new Error('CARD_UNAVAILABLE'); }
    },
  };
}
