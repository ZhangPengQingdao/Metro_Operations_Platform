import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

const idPattern = /^[0-9a-f]{64}$/;
const namePattern = /^afc-app-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const imagePattern = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const blockedMountSources = new Set(['/', '/etc', '/sys', '/proc', '/bin', '/sbin', '/usr', '/lib', '/lib64', '/var', '/var/run', '/var/run/docker.sock']);

export interface AppDockerBrokerOptions {
  upstreamSocketPath: string;
}

export interface BrokerValidationResult {
  allowed: boolean;
  reason?: string;
}

/** Pure request filter validating Docker Engine API calls against minimal sandbox policy. */
export function validateDockerBrokerRequest(method: string, urlPath: string, body?: unknown): BrokerValidationResult {
  const [pathname, search] = urlPath.split('?');
  const path = pathname.replace(/^\/v1\.[0-9]+/, '');

  // 1. Inspect image
  const imageMatch = /^\/images\/([^/]+)\/json$/.exec(path);
  if (imageMatch) {
    if (method !== 'GET') return { allowed: false, reason: 'IMAGE_METHOD_NOT_ALLOWED' };
    const ref = decodeURIComponent(imageMatch[1]);
    if (!imagePattern.test(ref)) return { allowed: false, reason: 'UNAPPROVED_IMAGE_REFERENCE' };
    return { allowed: true };
  }

  // 2. Container create
  if (path === '/containers/create') {
    if (method !== 'POST') return { allowed: false, reason: 'CONTAINER_CREATE_METHOD_NOT_ALLOWED' };
    const params = new URLSearchParams(search ?? '');
    const name = params.get('name');
    if (!name || !namePattern.test(name)) return { allowed: false, reason: 'INVALID_CONTAINER_NAME' };

    if (!body || typeof body !== 'object' || Array.isArray(body)) return { allowed: false, reason: 'INVALID_CREATE_BODY' };
    const b = body as Record<string, unknown>;
    const host = b.HostConfig as Record<string, unknown> | undefined;
    if (!host || typeof host !== 'object' || Array.isArray(host)) return { allowed: false, reason: 'MISSING_HOST_CONFIG' };

    if (host.Privileged === true) return { allowed: false, reason: 'PRIVILEGED_MODE_FORBIDDEN' };
    if (host.ReadonlyRootfs !== true) return { allowed: false, reason: 'READONLY_ROOTFS_REQUIRED' };
    if (host.NetworkMode !== 'none') return { allowed: false, reason: 'NETWORK_MODE_RESTRICTED' };

    const capDrop = host.CapDrop;
    if (!Array.isArray(capDrop) || !capDrop.includes('ALL')) return { allowed: false, reason: 'CAP_DROP_ALL_REQUIRED' };

    const mounts = host.Mounts;
    if (Array.isArray(mounts)) {
      for (const m of mounts as Record<string, unknown>[]) {
        const src = String(m?.Source ?? '');
        if (blockedMountSources.has(src) || src.includes('docker.sock')) {
          return { allowed: false, reason: 'UNSAFE_MOUNT_SOURCE' };
        }
      }
    }
    return { allowed: true };
  }

  // 3. Container operations: inspect, start, stop, remove, attach
  const containerMatch = /^\/containers\/([^/]+)(?:\/([^/?]+))?$/.exec(path);
  if (containerMatch) {
    const target = decodeURIComponent(containerMatch[1]);
    const subpath = containerMatch[2];
    if (target === 'prune') return { allowed: false, reason: 'DOCKER_ENDPOINT_NOT_PERMITTED' };
    if (subpath && !['json', 'start', 'stop', 'attach'].includes(subpath)) {
      return { allowed: false, reason: 'DOCKER_ENDPOINT_NOT_PERMITTED' };
    }
    if (!idPattern.test(target) && !namePattern.test(target)) return { allowed: false, reason: 'UNAUTHORIZED_CONTAINER_TARGET' };

    if (subpath === 'json') {
      if (method !== 'GET') return { allowed: false, reason: 'INSPECT_METHOD_NOT_ALLOWED' };
      return { allowed: true };
    }
    if (subpath === 'start') {
      if (method !== 'POST') return { allowed: false, reason: 'START_METHOD_NOT_ALLOWED' };
      return { allowed: true };
    }
    if (subpath === 'stop') {
      if (method !== 'POST') return { allowed: false, reason: 'STOP_METHOD_NOT_ALLOWED' };
      return { allowed: true };
    }
    if (subpath === 'attach') {
      if (method !== 'POST') return { allowed: false, reason: 'ATTACH_METHOD_NOT_ALLOWED' };
      return { allowed: true };
    }
    if (!subpath) {
      if (method !== 'DELETE') return { allowed: false, reason: 'REMOVE_METHOD_NOT_ALLOWED' };
      return { allowed: true };
    }
  }

  // All other endpoints (exec, volumes, build, networks, swarm, system info) are explicitly forbidden.
  return { allowed: false, reason: 'DOCKER_ENDPOINT_NOT_PERMITTED' };
}

/** Handles incoming HTTP request and proxies to upstream socket if valid. */
export function handleDockerBrokerRequest(req: IncomingMessage, res: ServerResponse, options: AppDockerBrokerOptions): void {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    let parsedBody: unknown;
    if (rawBody.length > 0 && req.headers['content-type']?.includes('application/json')) {
      try { parsedBody = JSON.parse(rawBody.toString('utf8')); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_JSON' }));
        return;
      }
    }

    const check = validateDockerBrokerRequest(req.method ?? '', req.url ?? '', parsedBody);
    if (!check.allowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'BROKER_OPERATION_FORBIDDEN', reason: check.reason }));
      return;
    }

    // Forward approved request to upstream socket
    const clientReq = httpRequest({
      socketPath: options.upstreamSocketPath,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: 'docker' },
    }, clientRes => {
      res.writeHead(clientRes.statusCode ?? 502, clientRes.headers);
      clientRes.pipe(res);
    });

    clientReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UPSTREAM_DOCKER_UNAVAILABLE' }));
      }
    });

    if (rawBody.length > 0) clientReq.write(rawBody);
    clientReq.end();
  });
}

/** Creates a restricted local Docker broker server filtering requests against platform sandbox policies. */
export function createRestrictedDockerBroker(options: AppDockerBrokerOptions): Server {
  const server = createServer((req, res) => handleDockerBrokerRequest(req, res, options));

  // Handle Upgrade (attach stdio stream)
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const check = validateDockerBrokerRequest(req.method ?? '', req.url ?? '');
    if (!check.allowed || req.headers.upgrade?.toLowerCase() !== 'tcp') {
      socket.destroy();
      return;
    }

    const clientReq = httpRequest({
      socketPath: options.upstreamSocketPath,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: 'docker' },
    });

    clientReq.on('error', () => socket.destroy());
    clientReq.on('upgrade', (clientRes, clientSocket, clientHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`);
      if (clientHead.length > 0) socket.write(clientHead);
      if (head.length > 0) clientSocket.write(head);
      clientSocket.pipe(socket);
      socket.pipe(clientSocket);
    });

    clientReq.end();
  });

  return server;
}
