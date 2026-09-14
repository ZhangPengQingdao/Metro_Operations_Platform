import {JSONRPCMessageSchema} from '@modelcontextprotocol/core';
import type {Transport} from '@modelcontextprotocol/client';

/** One transport per fresh proxy iframe. Its owner must close it on navigation/unmount. */
export function createMcpProxyTransport(host: Window, proxy: Window, proxyOrigin: string): Transport {
  const origin = new URL(proxyOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== proxyOrigin ||
      origin.hostname === new URL(host.location.origin).hostname) {
    throw new Error('MCP proxy requires a distinct HTTPS origin');
  }
  let started = false;
  let closed = false;
  let messages = 0;
  let bytes = 0;
  const requestIds = new Set<string>();
  const encoder = new TextEncoder();
  const checkBudget = (message: unknown) => {
    const serialized = JSON.stringify(message);
    if (serialized === undefined || serialized.length > 1024 * 1024) throw new Error('Invalid MCP message');
    const size = encoder.encode(serialized).byteLength;
    if (size > 1024 * 1024 || ++messages > 512 || (bytes += size) > 8 * 1024 * 1024) {
      throw new Error('MCP message budget exceeded');
    }
  };
  const revoke = () => {
    if (closed) return;
    closed = true;
    host.removeEventListener('message', receive);
    transport.onclose?.();
  };
  const fail = (error: unknown) => {
    revoke();
    transport.onerror?.(error instanceof Error ? error : new Error('MCP transport failed'));
  };
  const receive = (event: MessageEvent) => {
    if (closed || event.source !== proxy || event.origin !== proxyOrigin) return;
    try {
      checkBudget(event.data);
      // Wire validation belongs to the official SDK; no separate JSON-RPC dialect.
      const message = JSONRPCMessageSchema.parse(event.data);
      if ('method' in message && 'id' in message) {
        const id = JSON.stringify(message.id);
        if (requestIds.has(id)) throw new Error('Duplicate MCP request');
        requestIds.add(id);
      }
      transport.onmessage?.(message);
    } catch (error) { fail(error); }
  };
  const transport: Transport = {
    async start() {
      if (closed || started) throw new Error('MCP transport is not reusable');
      started = true;
      host.addEventListener('message', receive);
    },
    async send(message) {
      if (closed || !started) throw new Error('MCP transport is not open');
      try {
        checkBudget(message);
        proxy.postMessage(JSONRPCMessageSchema.parse(message), proxyOrigin);
      } catch (error) { fail(error); throw error; }
    },
    async close() { revoke(); },
  };
  return transport;
}
