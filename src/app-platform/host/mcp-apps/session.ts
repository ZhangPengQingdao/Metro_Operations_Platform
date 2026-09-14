import {AppBridge} from '@modelcontextprotocol/ext-apps/app-bridge';
import type {CallToolResult, Transport} from '@modelcontextprotocol/client';

/** Protocol session only. The caller must supply an admitted resource and an isolated transport. */
export function createMcpViewSession(options: {
  transport: Transport;
  arguments: Record<string, unknown>;
  result: CallToolResult;
  /** Already admitted HTML; sent only in response to the official proxy-ready notification. */
  html?: string;
  callTool?(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
}) {
  // Snapshot completed data; this layer deliberately has no tool execution capability.
  const input = structuredClone(options.arguments);
  const result = structuredClone(options.result);
  const html = options.html;
  const invoke = options.callTool;
  const bridge = new AppBridge(null, {name: 'AFC MCP Apps Host', version: '1.0.0'}, invoke ? {serverTools: {}} : {});
  const controller = new AbortController();
  let calls = 0, pending = 0;
  let closed = false;
  let initialized = false;
  let resourceSent = false;
  let settled = false;
  let resolveReady!: (status: 'delivered' | 'text') => void;
  let resolveClosed!: () => void;
  const whenClosed = new Promise<void>(resolve => {resolveClosed = resolve;});
  const ready = new Promise<'delivered' | 'text'>(resolve => { resolveReady = resolve; });
  const settle = (status: 'delivered' | 'text') => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveReady(status);
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    resolveClosed();
    controller.abort();
    settle('text');
    // Revoke immediately: a permission change must not wait for untrusted teardown.
    closing = bridge.close();
    return closing;
  };
  const fail = () => { void close().catch(() => { /* Transport is already revoked. */ }); };
  const timer = setTimeout(fail, 10_000);
  bridge.onerror = fail;
  bridge.onclose = () => { closed = true; resolveClosed(); controller.abort(); settle('text'); };
  if (invoke) bridge.oncalltool = async params => {
    if (closed || !initialized || pending >= 8 || ++calls > 128) throw new Error('CARD_UNAVAILABLE');
    const args = structuredClone(params.arguments ?? {});
    if (new TextEncoder().encode(JSON.stringify(args)).length > 65536) throw new Error('CARD_UNAVAILABLE');
    pending++;
    try {
      const value = await invoke(params.name, args, controller.signal);
      if (closed) throw new Error('CARD_UNAVAILABLE');
      return value;
    } catch { throw new Error('CARD_UNAVAILABLE'); }
    finally { pending--; }
  };
  bridge.onrequestteardown = fail;
  bridge.onsandboxready = () => {
    if (closed || html === undefined) return;
    if (resourceSent) { fail(); return; }
    resourceSent = true;
    void bridge.sendSandboxResourceReady({html, sandbox: 'allow-scripts'}).catch(fail);
  };
  bridge.oninitialized = () => {
    if (closed || initialized) return;
    initialized = true;
    void (async () => {
      await bridge.sendToolInput({arguments: input});
      if (closed) return;
      await bridge.sendToolResult(result);
      if (!closed) settle('delivered');
    })().catch(fail);
  };
  void bridge.connect(options.transport).then(() => {
    if (closed) return options.transport.close();
  }).catch(fail);
  return {ready, whenClosed, close, get closed() { return closed; }, get fallback() { return structuredClone(result); }};
}
