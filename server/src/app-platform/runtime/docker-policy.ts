import { posix } from 'node:path';
import { validateAppManifest } from '../manifest/index.js';
import type { AppInstallation } from '../registry/model.js';

export class AppDockerPolicyError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppDockerPolicyError'; }
}

export interface AppDockerPolicyInput {
  installation: AppInstallation;
  operationId: string;
  /** Platform-owned image; provenance and local availability are executor responsibilities. */
  runtimeImage: string;
  /** Platform-owned immutable directory, after verifying all artifact bytes. Not a verification receipt. */
  verifiedBundlePath: string;
  /** No egress until the controlled network transport is integrated. */
  network: 'none';
  gateway?: 'none' | 'stdio';
}

type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
function freeze<T>(value: T): Frozen<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}
function fail(code: string): never { throw new AppDockerPolicyError(code); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const image = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

/** Fixed loopback probe: no shell, redirects, ambient proxy, response output or unbounded reads.
 * Docker gets one extra second to terminate a probe whose Node process cannot respond to its timer.
 */
function healthProbe(path: string, timeoutSeconds: number): string {
  return `const http=require('node:http');
let request;
const finish=(code)=>{clearTimeout(timer);if(request)request.destroy();process.exit(code)};
const timer=setTimeout(()=>finish(1),${timeoutSeconds * 1000});
try {
request=http.get({hostname:'127.0.0.1',port:8080,path:${JSON.stringify(path)},method:'GET',agent:false,maxHeaderSize:8192},response=>{
if(response.statusCode!==200){response.destroy();finish(1);return}
let bytes=0;
response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){response.destroy();finish(1)}});
response.on('error',()=>finish(1));
response.on('aborted',()=>finish(1));
response.on('end',()=>finish(response.complete?0:1));
});
request.on('error',()=>finish(1));
} catch {finish(1)}`;
}

/** Pure Docker Engine create-body compiler. Does not authorize, verify files, or execute a lifecycle operation. */
export function compileAppDockerPolicy(input: AppDockerPolicyInput) {
  const installation = input.installation;
  if (!installation || !uuid.test(installation.id) || !uuid.test(input.operationId)
    || !Number.isSafeInteger(installation.revision) || installation.revision < 1) fail('INVALID_INSTALLATION');
  const parsed = validateAppManifest(installation.manifest);
  if (!parsed.ok || parsed.manifest.id !== installation.appId) fail('INVALID_MANIFEST');
  const manifest = parsed.manifest;
  const backend = manifest.backend;
  if (backend.mode !== 'isolated' && backend.mode !== 'trusted') fail('HOSTED_BACKEND_REQUIRED');
  if (backend.limits.memoryMiB > 1024 || backend.limits.cpuMillis > 2000) fail('RESOURCE_LIMIT_EXCEEDED');
  if (typeof input.runtimeImage !== 'string' || input.runtimeImage.length > 256 || !image.test(input.runtimeImage)) fail('PINNED_IMAGE_REQUIRED');
  const bundle = input.verifiedBundlePath;
  if (typeof bundle !== 'string' || bundle.length > 4096 || !posix.isAbsolute(bundle) || bundle === '/'
    || posix.normalize(bundle) !== bundle || /[\x00-\x1f\x7f,\\]/.test(bundle) || bundle.endsWith('/')) fail('INVALID_BUNDLE_PATH');
  if (input.network !== 'none') fail('NETWORK_UNAVAILABLE');
  if (input.gateway !== undefined && !['none','stdio'].includes(input.gateway)) fail('GATEWAY_TRANSPORT_INVALID');
  const stdio = input.gateway === 'stdio';
  const entry = manifest.artifacts.find(artifact => artifact.id === backend.entryArtifactId)!;
  const memory = backend.limits.memoryMiB * 1024 * 1024;
  return freeze({
    name: `afc-app-${installation.id}-${input.operationId}`,
    body: {
      Image: input.runtimeImage,
      User: '1000:1000',
      WorkingDir: '/app',
      Entrypoint: ['node'],
      Cmd: [`/app/${entry.path}`],
      Env: ['NODE_ENV=production', 'HOME=/tmp', 'PORT=8080', ...(stdio ? ['AFC_GATEWAY_TRANSPORT=stdio-v1'] : [])],
      AttachStdin: stdio, AttachStdout: stdio, AttachStderr: false, OpenStdin: stdio, Tty: false,
      NetworkDisabled: true,
      StopSignal: 'SIGTERM',
      Healthcheck: manifest.health ? {
        Test: ['CMD', 'node', '-e', healthProbe(manifest.health.path, manifest.health.timeoutSeconds)],
        Interval: 5_000_000_000, Timeout: (manifest.health.timeoutSeconds + 1) * 1_000_000_000,
        Retries: 1, StartPeriod: 0, StartInterval: 5_000_000_000,
      } : { Test: ['NONE'] },
      Labels: {
        'afc.app.id': manifest.id,
        'afc.app.installation': installation.id,
        'afc.app.version': manifest.version,
        'afc.app.operation': input.operationId,
      },
      HostConfig: {
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        NetworkMode: 'none', IpcMode: 'private', PidMode: '', CgroupnsMode: 'private',
        Mounts: [{ Type: 'bind', Source: bundle, Target: '/app', ReadOnly: true,
          BindOptions: { Propagation: 'rprivate', ReadOnlyNonRecursive: false, ReadOnlyForceRecursive: true } }],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16777216,mode=1777' },
        Memory: memory, MemorySwap: memory, NanoCpus: backend.limits.cpuMillis * 1_000_000,
        PidsLimit: 64,
        Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }, { Name: 'core', Soft: 0, Hard: 0 }],
        LogConfig: stdio ? { Type: 'none', Config: {} } : { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '2' } },
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        AutoRemove: false, PublishAllPorts: false,
      },
    },
  });
}

export type AppDockerPolicy = ReturnType<typeof compileAppDockerPolicy>;
