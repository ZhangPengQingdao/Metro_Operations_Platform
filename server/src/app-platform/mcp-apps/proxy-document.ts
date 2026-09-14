import {emptyMcpViewPolicy, mcpViewPolicyHeaders, type McpViewPolicy} from './policy.js';
/** Serve only on a dedicated cookieless HTTPS host, never the platform origin. */
export function createMcpProxyDocument(hostOrigin: string, policy: McpViewPolicy = emptyMcpViewPolicy()) {
  const host = new URL(hostOrigin);
  if (host.protocol !== 'https:' || host.origin !== hostOrigin) throw new Error('Invalid host origin');
  const security = mcpViewPolicyHeaders(policy, hostOrigin);
  const script = `(() => {
    const hostOrigin = ${JSON.stringify(hostOrigin)};
    if (window.parent === window) return;
    let view = null, closed = false, loads = 0, messages = 0, bytes = 0;
    const deny = ${JSON.stringify(security.allow)};
    const innerCsp = ${JSON.stringify(security.inner)};
    function close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('message', receive);
      if (view) view.remove();
      window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/request-teardown'}, hostOrigin);
    }
    function receive(event) {
      if (closed) return;
      const fromHost = event.source === window.parent && event.origin === hostOrigin;
      const fromView = view && event.source === view.contentWindow && event.origin === 'null';
      if (!fromHost && !fromView) return;
      try {
        const wire = JSON.stringify(event.data);
        if (!wire || wire.length > 1048576) return close();
        const size = new TextEncoder().encode(wire).length;
        if (size > 1048576 || ++messages > 512 || (bytes += size) > 8388608) return close();
        const message = event.data;
        if (!message || message.jsonrpc !== '2.0') return close();
        if (fromHost && message.method === 'ui/notifications/sandbox-resource-ready') {
          if (view || typeof message.params?.html !== 'string' || new TextEncoder().encode(message.params.html).length > 262144) return close();
          view = document.createElement('iframe');
          view.setAttribute('sandbox', 'allow-scripts');
          view.setAttribute('allow', deny);
          view.setAttribute('referrerpolicy', 'no-referrer');
          view.setAttribute('title', 'MCP App');
          view.addEventListener('load', () => { if (++loads > 1) close(); });
          const meta = document.createElement('meta');
          meta.setAttribute('http-equiv', 'Content-Security-Policy');
          meta.setAttribute('content', innerCsp);
          // Policy precedes every byte supplied by the View. A second meta policy
          // can only intersect this policy, never widen its allowed sources.
          view.srcdoc = '<!doctype html>' + meta.outerHTML + message.params.html;
          document.body.append(view);
        } else if (fromHost && view) {
          view.contentWindow.postMessage(message, '*');
        } else if (fromView) {
          // A View cannot impersonate the proxy handshake or request new HTML.
          if (message.method === 'ui/notifications/sandbox-proxy-ready' || message.method === 'ui/notifications/sandbox-resource-ready') return close();
          window.parent.postMessage(message, hostOrigin);
        }
      } catch { close(); }
    }
    window.addEventListener('message', receive);
    window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'}, hostOrigin);
  })();`;
  return {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      // This initial profile is deliberately offline. Child srcdoc inherits the
      // response CSP and cannot loosen it with a meta policy or its own requests.
      'content-security-policy': security.outer,
      'permissions-policy': security.permissions,
    },
    html: `<!doctype html><html><head><meta charset="utf-8"><title>MCP App proxy</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><script>${script}</script></body></html>`,
  };
}

/** Opt-in static responder for the isolated host; it is not mounted on the main API. */
export function createMcpProxyHandler(options: {hostOrigin: string; proxyOrigin: string; policy?: McpViewPolicy}) {
  const page = createMcpProxyDocument(options.hostOrigin, options.policy);
  const proxy = new URL(options.proxyOrigin);
  if (proxy.protocol !== 'https:' || proxy.origin !== options.proxyOrigin ||
      proxy.hostname === new URL(options.hostOrigin).hostname) throw new Error('Invalid proxy origin');
  const origin = proxy.origin;
  return (request: Request): Response => {
    const url = new URL(request.url);
    if (url.origin !== origin || url.pathname !== '/mcp-apps/proxy' || url.search || url.hash) {
      return new Response(null, {status: 404, headers: {'cache-control': 'no-store'}});
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, {status: 405, headers: {allow: 'GET, HEAD', 'cache-control': 'no-store'}});
    }
    return new Response(request.method === 'HEAD' ? null : page.html, {headers: page.headers});
  };
}
