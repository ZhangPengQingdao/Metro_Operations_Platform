import { isDeepStrictEqual } from 'node:util';
import type { AppDockerPolicy } from './docker-policy.js';
import { AppDockerTransport, AppDockerTransportError, type AppDockerContainerInspection } from './docker-transport.js';

export interface AppDockerImageApproval {
  /** Platform-reviewed immutable image identity and full Config snapshot, never application input. */
  imageId: string;
  config: Record<string, unknown>;
}
export class AppDockerExecutorError extends Error {
  constructor(readonly code: string, readonly uncertain: boolean, readonly containerId?: string) {
    super(code); this.name = 'AppDockerExecutorError';
  }
}
type Transport = Pick<AppDockerTransport, 'inspectImage' | 'inspectContainer' | 'createContainer' | 'startContainer' | 'stopContainer' | 'removeContainer'>;
type Input = { policy: AppDockerPolicy; approval: AppDockerImageApproval };
function fail(code: string): never { throw new AppDockerExecutorError(code, false); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function empty(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) ? value.length === 0 : record(value) && Object.keys(value).length === 0);
}
function equal(actual: unknown, expected: unknown): void { if (!isDeepStrictEqual(actual, expected)) fail('CONTAINER_POLICY_MISMATCH'); }
function env(value: unknown): Map<string, string> {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*=[^\x00]*$/.test(x))) fail('IMAGE_CONFIG_REJECTED');
  const result = new Map<string, string>();
  for (const item of value as string[]) {
    const key = item.slice(0, item.indexOf('='));
    if (result.has(key)) fail('IMAGE_CONFIG_REJECTED');
    result.set(key, item);
  }
  return result;
}
function snapshot(policy: AppDockerPolicy, approval: AppDockerImageApproval): Input {
  try {
    const serialized = JSON.stringify({ policy, approval });
    if (Buffer.byteLength(serialized) > 128 * 1024) fail('INVALID_INPUT');
    const result = JSON.parse(serialized) as Input;
    if (!result.policy?.body || !record(result.approval?.config)
      || !/^sha256:[0-9a-f]{64}$/.test(result.approval.imageId)) fail('INVALID_INPUT');
    return result;
  } catch { fail('INVALID_INPUT'); }
}
function containerId(id: string): void { if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) fail('IMMUTABLE_CONTAINER_ID_REQUIRED'); }

/** Single-dispatch trusted host primitives, not a durable supervisor.
 * Caller MUST serialize installation operations, persist dispatch intent before mutation,
 * and never replay uncertain work.
 * observe() supplies evidence only, never retry authorization; no automatic cleanup/replacement.
 * The policy and artifact directory must already be platform-verified and owned.
 */
export class AppDockerExecutor {
  constructor(private readonly transport: Transport) {}

  private async preflight(input: Input): Promise<void> {
    const image = await this.transport.inspectImage(input.policy.body.Image);
    if (!image || image.Id !== input.approval.imageId || !isDeepStrictEqual(image.Config, input.approval.config)
      || !image.RepoDigests.includes(input.policy.body.Image)) fail('IMAGE_APPROVAL_MISMATCH');
    const config = image.Config;
    for (const key of ['Volumes', 'ExposedPorts', 'OnBuild', 'Labels']) if (!empty(config[key])) fail('IMAGE_CONFIG_REJECTED');
    if (config.Healthcheck !== undefined && config.Healthcheck !== null
      && !isDeepStrictEqual(config.Healthcheck, { Test: ['NONE'] })) fail('IMAGE_CONFIG_REJECTED');
    for (const key of env(config.Env ?? []).keys()) {
      if (['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key)) fail('IMAGE_CONFIG_REJECTED');
    }
  }
  private verify(found: AppDockerContainerInspection, input: Input, expectedId?: string): void {
    const { policy, approval } = input, config = found.Config, host = found.HostConfig;
    if (expectedId !== undefined) equal(found.Id, expectedId);
    equal(found.Name, `/${policy.name}`); equal(found.Image, approval.imageId);
    const expectedEnv = env(approval.config.Env ?? []);
    for (const [key, value] of env(policy.body.Env)) expectedEnv.set(key, value);
    equal([...env(config.Env).values()].sort(), [...expectedEnv.values()].sort());
    for (const [key, value] of Object.entries(policy.body)) {
      // Engine omits a zero startup grace period; no other health settings are defaulted.
      if (key === 'Healthcheck' && policy.body.Healthcheck.StartPeriod === 0 && record(config.Healthcheck)) {
        equal({ StartPeriod: 0, ...config.Healthcheck }, value);
      } else if (key !== 'HostConfig' && key !== 'Env') equal(config[key], value);
    }
    for (const key of ['Volumes', 'ExposedPorts', 'OnBuild']) if (!empty(config[key])) fail('CONTAINER_POLICY_MISMATCH');
    for (const [key, value] of Object.entries(policy.body.HostConfig)) {
      if (key !== 'Mounts') equal(host[key], value);
    }
    // Engine omits false BindOptions fields. Compare defaults explicitly, rejecting extra mounts/options.
    if (!Array.isArray(host.Mounts) || host.Mounts.length !== 1) fail('CONTAINER_POLICY_MISMATCH');
    const mount = host.Mounts[0];
    if (!record(mount) || !record(mount.BindOptions)) fail('CONTAINER_POLICY_MISMATCH');
    const expectedMount = policy.body.HostConfig.Mounts[0];
    equal({ ...mount, BindOptions: { ReadOnlyNonRecursive: false, ...mount.BindOptions } }, expectedMount);
    const defaults: Record<string, unknown> = {
      Binds: null, ContainerIDFile: '', VolumeDriver: '', VolumesFrom: null, ConsoleSize: [0, 0],
      CapAdd: null, Dns: null, DnsOptions: null, DnsSearch: null, ExtraHosts: null, GroupAdd: null,
      Links: null, PortBindings: {}, OomScoreAdj: 0, UTSMode: '', UsernsMode: '', ShmSize: 67108864,
      Runtime: 'runc', Isolation: '', CpuShares: 0, CgroupParent: '', Cgroup: '', BlkioWeight: 0,
      BlkioWeightDevice: null, BlkioDeviceReadBps: null, BlkioDeviceWriteBps: null,
      BlkioDeviceReadIOps: null, BlkioDeviceWriteIOps: null, CpuPeriod: 0, CpuQuota: 0,
      CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: '', CpusetMems: '',
      Devices: null, DeviceCgroupRules: null, DeviceRequests: null, MemoryReservation: 0,
      MemorySwappiness: null, OomKillDisable: false, CpuCount: 0, CpuPercent: 0,
      IOMaximumIOps: 0, IOMaximumBandwidth: 0, Init: false, Sysctls: {}, StorageOpt: {},
      MaskedPaths: ['/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys',
        '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list', '/proc/timer_stats',
        '/sys/devices/virtual/powercap', '/sys/firmware'],
      ReadonlyPaths: ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'],
    };
    // Fail closed when Engine introduces an unreviewed host setting; only known defaults are allowed.
    for (const [key, value] of Object.entries(host)) {
      if (Object.hasOwn(policy.body.HostConfig, key)) continue;
      if (!Object.hasOwn(defaults, key)) fail('CONTAINER_POLICY_MISMATCH');
      // Engine changes unset OomKillDisable from false to null after start; both retain OOM killing.
      if (key === 'OomKillDisable' && value === null) continue;
      if (!(empty(value) && empty(defaults[key]))) equal(value, defaults[key]);
    }
    equal(host.MaskedPaths, defaults.MaskedPaths); equal(host.ReadonlyPaths, defaults.ReadonlyPaths);
    equal(found.Path, 'node'); equal(found.Args, policy.body.Cmd);
    if (config.StdinOnce !== undefined) equal(config.StdinOnce, false);
    if (!Array.isArray(found.Mounts) || found.Mounts.length !== 1) fail('CONTAINER_POLICY_MISMATCH');
    const actualMount = found.Mounts[0];
    if (!record(actualMount)) fail('CONTAINER_POLICY_MISMATCH');
    equal(actualMount.Type, 'bind'); equal(actualMount.Source, expectedMount.Source);
    equal(actualMount.Destination, '/app'); equal(actualMount.RW, false); equal(actualMount.Propagation, 'rprivate');
    if (!record(found.NetworkSettings) || !empty(found.NetworkSettings.Ports)) fail('CONTAINER_POLICY_MISMATCH');
    const networks = found.NetworkSettings.Networks;
    if (!record(networks) || Object.keys(networks).some(name => name !== 'none')) fail('CONTAINER_POLICY_MISMATCH');
    if (found.State.Paused !== false || found.State.Restarting !== false || found.State.Dead !== false) fail('CONTAINER_STATE_UNSAFE');
    if (!['created', 'running', 'exited'].includes(found.State.Status)
      || found.State.Running !== (found.State.Status === 'running')) fail('CONTAINER_STATE_UNSAFE');
  }
  private async observeInput(input: Input, id?: string): Promise<AppDockerContainerInspection | null> {
    const found = await this.transport.inspectContainer(id ?? input.policy.name);
    if (found) this.verify(found, input, id);
    return found;
  }
  async observe(policy: AppDockerPolicy, approval: AppDockerImageApproval, id?: string): Promise<AppDockerContainerInspection | null> {
    if (id !== undefined) containerId(id);
    const input = snapshot(policy, approval);
    return this.observeInput(input, id);
  }
  async create(policy: AppDockerPolicy, approval: AppDockerImageApproval): Promise<AppDockerContainerInspection> {
    const input = snapshot(policy, approval);
    await this.preflight(input);
    if (await this.observeInput(input)) fail('CONTAINER_ALREADY_EXISTS');
    let id: string | undefined;
    try {
      id = (await this.transport.createContainer(input.policy)).Id;
      containerId(id);
      const found = await this.observeInput(input, id);
      if (!found || found.State.Status !== 'created') fail('CREATE_NOT_CONFIRMED');
      return found;
    } catch (error) {
      if (id === undefined && error instanceof AppDockerTransportError
        && error.code === 'CREATE_REQUEST_REJECTED' && error.status === 400 && !error.uncertain) {
        // The request has ended. Confirm no owned container remains; failed inspection stays uncertain.
        let remaining: AppDockerContainerInspection | null;
        try { remaining = await this.observeInput(input); }
        catch (inspectionError) { throw this.uncertain(inspectionError); }
        if (remaining === null) throw new AppDockerExecutorError('CREATE_REQUEST_REJECTED', false);
      }
      throw this.uncertain(error, id);
    }
  }
  async start(policy: AppDockerPolicy, approval: AppDockerImageApproval, id: string): Promise<AppDockerContainerInspection> {
    containerId(id);
    const input = snapshot(policy, approval);
    await this.preflight(input);
    const before = await this.observeInput(input, id);
    if (!before || before.State.Status !== 'created') fail('CREATED_CONTAINER_REQUIRED');
    try {
      await this.transport.startContainer(id);
      const found = await this.observeInput(input, id);
      if (!found || found.State.Status !== 'running') fail('START_NOT_CONFIRMED');
      return found;
    } catch (error) { throw this.uncertain(error, id); }
  }
  async stop(policy: AppDockerPolicy, approval: AppDockerImageApproval, id: string): Promise<AppDockerContainerInspection> {
    containerId(id);
    const input = snapshot(policy, approval);
    const before = await this.observeInput(input, id);
    if (!before) fail('CONTAINER_NOT_FOUND');
    if (!before.State.Running) return before;
    try {
      await this.transport.stopContainer(id);
      const found = await this.observeInput(input, id);
      if (!found || found.State.Running) fail('STOP_NOT_CONFIRMED');
      return found;
    } catch (error) { throw this.uncertain(error, id); }
  }
  async remove(policy: AppDockerPolicy, approval: AppDockerImageApproval, id: string): Promise<void> {
    containerId(id);
    const input = snapshot(policy, approval);
    const before = await this.observeInput(input, id);
    if (!before || before.State.Running) fail('STOPPED_CONTAINER_REQUIRED');
    try {
      await this.transport.removeContainer(id);
      if (await this.transport.inspectContainer(id)) fail('REMOVE_NOT_CONFIRMED');
    } catch (error) { throw this.uncertain(error, id); }
  }
  private uncertain(error: unknown, id?: string): AppDockerExecutorError {
    return new AppDockerExecutorError(error instanceof AppDockerTransportError || error instanceof AppDockerExecutorError
      ? error.code : 'DOCKER_OPERATION_UNCERTAIN', true, id);
  }
}
