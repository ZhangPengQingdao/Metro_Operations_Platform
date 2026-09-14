import type {CallToolResult} from '@modelcontextprotocol/client';
import {createMcpProxyTransport} from './transport';
import {createMcpViewSession} from './session';

/** Internal mount: HTML must come from readInstalledMcpView, URL from trusted deployment config. */
export function mountMcpView(container: HTMLElement, options: {
  proxyUrl: string;
  html: string;
  arguments: Record<string, unknown>;
  result: CallToolResult;
  signal: AbortSignal;
  /** Derived by the trusted policy decision that also selects the proxy response. */
  allow?: string;
  callTool?(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
}) {
  if (options.signal.aborted) throw new Error('MCP view has been revoked');
  if (new TextEncoder().encode(options.html).length > 262144) throw new Error('MCP view is too large');
  const host = container.ownerDocument.defaultView;
  if (!host) throw new Error('MCP host window unavailable');
  const url = new URL(options.proxyUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid MCP proxy URL');
  // Validate before appending any iframe or starting a navigation.
  if (url.protocol !== 'https:' || url.hostname === new URL(host.location.origin).hostname) throw new Error('MCP proxy must use a separate HTTPS host');
  const frame = container.ownerDocument.createElement('iframe');
  frame.title = 'MCP App';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('allow', options.allow ?? "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'");
  frame.referrerPolicy = 'no-referrer';
  frame.src = url.href;
  let loads = 0;
  let session: ReturnType<typeof createMcpViewSession> | undefined;
  const cleanup = () => {
    options.signal.removeEventListener('abort', revoke);
    frame.removeEventListener('load', onload);
    frame.removeEventListener('error', revoke);
    frame.remove();
  };
  const revoke = () => { cleanup(); void session?.close(); };
  const onload = () => { if (++loads > 1) revoke(); };
  frame.addEventListener('load', onload);
  frame.addEventListener('error', revoke);
  options.signal.addEventListener('abort', revoke, {once: true});
  try {
    container.append(frame);
    if (!frame.contentWindow || options.signal.aborted) throw new Error('MCP proxy unavailable');
    const transport = createMcpProxyTransport(host, frame.contentWindow, url.origin);
    session = createMcpViewSession({...options, transport});
    const onclose = transport.onclose;
    transport.onclose = () => { cleanup(); onclose?.(); };
    return {ready: session.ready, whenClosed: session.whenClosed, fallback: session.fallback, close: () => {cleanup(); return session!.close();}};
  } catch (error) { revoke(); throw error; }
}
