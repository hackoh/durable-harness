/**
 * A Sandbox API over the stand-in (§5.8): every "VM" is a local relay child
 * (`startRelay`) over fresh temp dirs (its rootfs, state and cache dirs: gone
 * when it goes), and every "Drive" a temp dir that outlives the VMs mounted on
 * it, so the session factory's lifecycle (`src/session.ts`) runs end to end
 * with no credentials. It keeps the platform's measured behaviour (P0.4, P0.5):
 * a taken name is a conflict, a Drive is held by one VM session at a time and
 * for `detachMs` after it goes (409 `drive_attached`), a stopped sandbox stays
 * until deleted, and a crashed VM stays `running` and answers no command.
 * With `proxy`, the driver reaches each VM's relay through a local TCP proxy
 * that can drop one socket kind (`/ctl` or `/model`) alone; `adoptDrive`
 * takes over a Drive another process's fake made (its directory and id), so
 * a test can SIGKILL a driver process and recover the session from another.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiConflict, type CreateSandbox, type DriveInfo, FENCE_TAG, fenceMarkOf, type RunResult, type SandboxApi, type VmHandle, type VmStatus } from '../src/api.ts';
import { requestArm } from '../src/relay/arm.ts';
import type { RelayConfig } from '../src/relay/relay.ts';
import { type RelayChild, startRelay } from './local-machine.ts';

interface FakeDrive {
  info: { name: string; driveId: string; region: string; maxSize: number };
  dir: string;
  /** The VM session holding it, and until when a gone holder still does (detach lag). */
  holder?: { sessionId: string; until?: number };
}

interface FakeVm {
  name: string;
  sessionId: string;
  status: VmStatus;
  region: string;
  startedAt: number;
  timeout: number;
  drive: string;
  relay?: RelayChild;
  /** Crashed inside: `running`, the Drive held, no command answered (P0.5). */
  crashed?: boolean;
  /** The proxy in front of the relay (`FakeApiOptions.proxy`), and its open connections by request path. */
  proxy?: { server: Server; port: number; open: Set<{ path: string; sockets: Socket[] }> };
  network?: unknown;
  tags: Record<string, string>;
  create: CreateSandbox;
}

export interface FakeApiOptions {
  /** How long a Drive stays attached after its VM goes (P0.5 measured 5-8 s). Default 0. */
  detachMs?: number;
  /** The relay config for every VM (the stand-in's defaults otherwise). */
  relay?: Partial<RelayConfig>;
  /** CLI versions the image reports at arm. */
  cliVersions?: Record<string, string>;
  /** VMs boot with no relay (an image without one): every arm gets no reply. */
  relayless?: boolean;
  /** The plan's Drive quota in bytes (Hobby's: 1 GiB): a larger `maxSize` is refused as the platform refuses it. Default none. */
  driveQuota?: number;
  /** The size a Drive gets without `maxSize` (the plan's default). Default 1 GiB. */
  defaultDriveSize?: number;
  /** The plan's cap on one VM session (a create past it is refused naming it; an extension past it with `sandbox_timeout_invalid`). Default none. */
  planCapMs?: number;
  /** The message a create past `planCapMs` is refused with (a 400). Default the platform's ("`timeout` should be <= 45m"). */
  createRefusal?: string;
  /** Put a TCP proxy between the driver and each relay, so a test can drop one socket kind (`dropSockets`). */
  proxy?: boolean;
  /** The relay can't check a model caller's pid, as on a host without `/proc` (macOS): every arm reply says `modelAuth: false`, whatever this host can do. */
  noPeerCheck?: boolean;
}

export class FakeSandboxApi implements SandboxApi {
  readonly drives = new Map<string, FakeDrive>();
  readonly vms = new Map<string, FakeVm>();
  /** Every call, in order: `<op>:<name>[:detail]`. */
  readonly calls: string[] = [];
  /** Called before a Drive create, to simulate another invocation's create winning the race. */
  beforeCreateDrive?: (name: string) => void;
  /** Called before a sandbox create (a Drive deleted and made again in between). */
  beforeCreateSandbox?: (name: string) => void;
  /** Make the next control-plane commands fail before they reach the VM (a 429 or 5xx, the Function's network): how many, and with what. */
  failRuns?: { count: number; error: () => Error };
  /** Make `setNetwork` fail (after `delayMs`), and `extendTimeout` take `extendMs`. */
  failNetwork?: { delayMs?: number; error: () => Error };
  extendMs?: number;
  /** Route the Function's dial to a VM's exposed port elsewhere (a test's proxy between the Function and the relay): the URL `domain` returns. */
  route?: (vm: string, url: string) => string;

  constructor(readonly options: FakeApiOptions = {}) {}

  async projectId(): Promise<string> {
    return 'prj_stand_in';
  }

  async getDrive(name: string): Promise<DriveInfo | undefined> {
    this.calls.push(`getDrive:${name}`);
    const d = this.drives.get(name);
    if (!d) return undefined;
    const holder = this.holderOf(d);
    return { ...d.info, ...(holder ? { currentSessionId: holder } : {}) };
  }

  async createDrive(o: { name: string; region: string; maxSize?: number }): Promise<DriveInfo> {
    this.calls.push(`createDrive:${o.name}:${o.region}${o.maxSize === undefined ? ':default' : ''}`);
    this.beforeCreateDrive?.(o.name);
    if (this.drives.has(o.name)) throw new ApiConflict('exists', 'drive exists');
    const quota = this.options.driveQuota;
    if (quota !== undefined && o.maxSize !== undefined && o.maxSize > quota) {
      throw Object.assign(new Error(`Status code 400 is not ok: \`maxSizeBytes\` must not exceed the Drive quota of ${quota} bytes. Request a higher quota`), { response: { status: 400 } });
    }
    this.addDrive(o.name, o.region, o.maxSize ?? this.options.defaultDriveSize ?? 1024 ** 3);
    return { ...this.drives.get(o.name)!.info };
  }

  /** Create a Drive directly (another invocation, or a test's setup). */
  addDrive(name: string, region = 'iad1', maxSize = 10 * 1024 ** 3): FakeDrive {
    const d: FakeDrive = { info: { name, driveId: `drv_${randomUUID().slice(0, 8)}`, region, maxSize }, dir: mkdtempSync(join(tmpdir(), 'dh-fake-drive-')) };
    this.drives.set(name, d);
    return d;
  }

  /** Take over a Drive another fake made (another process's): the same directory and id, held by no VM here. */
  adoptDrive(info: { name: string; driveId: string; region: string; maxSize: number }, dir: string): void {
    this.drives.set(info.name, { info: { ...info }, dir });
  }

  /** Where a Drive is, for another process's fake to adopt it. */
  driveInfo(name: string): { name: string; driveId: string; region: string; maxSize: number; dir: string } | undefined {
    const d = this.drives.get(name);
    return d ? { ...d.info, dir: d.dir } : undefined;
  }

  /** Drop every connection of one kind to a VM's relay (`proxy` only): a socket lost alone, the other kept. */
  dropSockets(name: string, path: '/ctl' | '/model'): number {
    const proxy = this.vms.get(name)?.proxy;
    if (!proxy) throw new Error('dropSockets needs FakeApiOptions.proxy');
    let n = 0;
    for (const c of [...proxy.open]) {
      if (c.path !== path) continue;
      for (const sock of c.sockets) sock.destroy();
      proxy.open.delete(c);
      n++;
    }
    return n;
  }

  /** Delete a Drive (the files are gone; a new one under the name gets a new id). */
  dropDrive(name: string): void {
    const d = this.drives.get(name);
    if (!d) return;
    rmSync(d.dir, { recursive: true, force: true });
    this.drives.delete(name);
  }

  driveDir(name: string): string {
    return this.drives.get(name)!.dir;
  }

  async getSandbox(name: string): Promise<VmHandle | undefined> {
    this.calls.push(`getSandbox:${name}`);
    const vm = this.vms.get(name);
    return vm ? this.handle(vm) : undefined;
  }

  async createSandbox(o: CreateSandbox): Promise<VmHandle> {
    this.calls.push(`createSandbox:${o.name}:${o.region}`);
    this.beforeCreateSandbox?.(o.name);
    if (this.vms.has(o.name)) throw new ApiConflict('name', 'already exists');
    const cap = this.options.planCapMs;
    if (cap !== undefined && o.timeout > cap) throw Object.assign(new Error(this.options.createRefusal ?? `Status code 400 is not ok: \`timeout\` should be <= ${cap % 3_600_000 === 0 ? `${cap / 3_600_000}h` : `${Math.round(cap / 60_000)}m`}`), { response: { status: 400 } });
    const d = this.drives.get(o.drive);
    if (!d) throw new Error(`no drive ${o.drive}`);
    if (d.info.region !== o.region) throw new Error('drive_region_mismatch');
    if (d.info.driveId !== o.driveId) throw new ApiConflict('drive_changed', 'the Drive under this name is not the one checked');
    if (this.holderOf(d)) throw new ApiConflict('drive_attached', 'drive_attached');
    const sessionId = `sbs_${randomUUID().slice(0, 8)}`;
    const tags = { ...(o.tags ?? {}), ...(o.fenceMark !== undefined ? { [FENCE_TAG]: String(o.fenceMark) } : {}) };
    const vm: FakeVm = { name: o.name, sessionId, status: 'running', region: o.region, startedAt: Date.now(), timeout: o.timeout, drive: o.drive, network: o.network, tags, create: o };
    if (!this.options.relayless) vm.relay = await startRelay({ workspace: d.dir, ...(this.options.cliVersions ? { cliVersions: this.options.cliVersions } : {}), ...this.options.relay });
    if (this.options.proxy && vm.relay) vm.proxy = await proxyTo(vm.relay.config.port);
    d.holder = { sessionId };
    this.vms.set(o.name, vm);
    return this.handle(vm);
  }

  /** Set a VM's `dh-fence` watermark directly (another owner's update), or drop it (`undefined`: a VM no owner tagged). */
  mark(name: string, count: number | undefined): void {
    const tags = this.vms.get(name)!.tags;
    if (count === undefined) delete tags[FENCE_TAG];
    else tags[FENCE_TAG] = String(count);
  }

  /** Make a VM look older (the plan-cap rotation). */
  age(name: string, ms: number): void {
    this.vms.get(name)!.startedAt -= ms;
  }

  /** Crash a VM inside: the relay dies, the platform still says running and the Drive stays held (P0.5). */
  async crash(name: string): Promise<void> {
    const vm = this.vms.get(name)!;
    vm.crashed = true;
    await vm.relay?.kill();
  }

  /** Stop a VM (its timeout, or a graceful stop): the relay and its rootfs go, the sandbox stays `stopped`, the Drive is released. */
  async stopVm(name: string): Promise<void> {
    const vm = this.vms.get(name)!;
    await this.teardown(vm);
    vm.status = 'stopped';
  }

  /** The relay child of a VM (tests reach its control socket). */
  relayOf(name: string): RelayChild | undefined {
    return this.vms.get(name)?.relay;
  }

  private holderOf(d: FakeDrive): string | undefined {
    if (!d.holder) return undefined;
    if (d.holder.until !== undefined && Date.now() >= d.holder.until) {
      d.holder = undefined;
      return undefined;
    }
    return d.holder.sessionId;
  }

  private async teardown(vm: FakeVm): Promise<void> {
    if (vm.proxy) {
      for (const c of vm.proxy.open) for (const sock of c.sockets) sock.destroy();
      vm.proxy.server.close();
      vm.proxy = undefined;
    }
    await vm.relay?.stop();
    vm.relay = undefined;
    const d = this.drives.get(vm.drive);
    if (d?.holder?.sessionId === vm.sessionId) d.holder = { sessionId: vm.sessionId, until: Date.now() + (this.options.detachMs ?? 0) };
  }

  private handle(vm: FakeVm): VmHandle {
    const api = this;
    const config = vm.relay?.config;
    const fenceMark = fenceMarkOf(vm.tags);
    return {
      name: vm.name,
      sessionId: vm.sessionId,
      status: vm.status,
      region: vm.region,
      startedAt: vm.startedAt,
      timeout: vm.timeout,
      ...(fenceMark !== undefined ? { fenceMark } : {}),
      ...(config ? { layout: { port: config.port, modelPort: config.modelPort, workspace: config.workspace, cacheRoot: config.cacheRoot, config: vm.relay!.configPath } } : {}),
      domain: (port) => {
        if (!config || port !== config.port) throw new Error(`port ${port} is not exposed`);
        const url = `http://127.0.0.1:${vm.proxy?.port ?? port}`;
        return api.route ? api.route(vm.name, url) : url;
      },
      async run(command, args, options = {}): Promise<RunResult> {
        api.calls.push(`run:${vm.name}:${args[0] ?? command}`);
        if (api.failRuns && api.failRuns.count > 0) {
          api.failRuns.count--;
          throw api.failRuns.error();
        }
        if (vm.status !== 'running') throw Object.assign(new Error('snapshot_not_found'), { response: { status: 400 } });
        if (vm.crashed) {
          await new Promise((r) => setTimeout(r, Math.min(options.timeoutMs ?? 1000, 300)));
          throw new Error('command timed out');
        }
        if (command === '/bin/true') return { exitCode: 0, stdout: '', stderr: '' };
        if (!vm.relay) return { exitCode: 127, stdout: '', stderr: 'no relay in this image' };
        if (args[0] !== 'arm') throw new Error(`the stand-in runs only the relay's arm and /bin/true (${command})`);
        const { values } = parseArgs({ args: args.slice(2), options: { sha256: { type: 'string' }, fence: { type: 'string' }, fenced: { type: 'string' }, session: { type: 'string' }, model: { type: 'string' } } });
        const reply = await requestArm(vm.relay!.config.stateDir, {
          sha256: values.sha256!,
          session: values.session!,
          ...(values.fence !== undefined ? { fence: Number(values.fence), fenced: values.fenced === 'true' } : {}),
          ...(values.model !== undefined ? { model: values.model } : {}),
        });
        if (!reply) return { exitCode: 1, stdout: '', stderr: 'relay did not come up' };
        const shown = reply.ok && api.options.noPeerCheck ? { ...reply, modelAuth: false } : reply;
        return { exitCode: reply.ok ? 0 : 1, stdout: `${JSON.stringify(shown)}\n`, stderr: '' };
      },
      async extendTimeout(ms) {
        api.calls.push(`extendTimeout:${vm.name}:${Math.round(ms)}`);
        if (api.extendMs) await new Promise((r) => setTimeout(r, api.extendMs));
        const cap = api.options.planCapMs;
        if (cap !== undefined && vm.timeout + ms > cap) {
          throw Object.assign(new Error('Status code 400 is not ok: Failed to extend timeout: extension would exceed maximum execution timeout'), { response: { status: 400 }, json: { error: { code: 'sandbox_timeout_invalid' } } });
        }
        vm.timeout += ms;
      },
      async setNetwork(policy, mark) {
        api.calls.push(`setNetwork:${vm.name}`);
        if (api.failNetwork) {
          await new Promise((r) => setTimeout(r, api.failNetwork!.delayMs ?? 0));
          throw api.failNetwork.error();
        }
        vm.network = policy;
        if (mark !== undefined && mark > (fenceMarkOf(vm.tags) ?? -1)) vm.tags[FENCE_TAG] = String(mark);
      },
      async stop() {
        api.calls.push(`stop:${vm.name}`);
        await api.stopVm(vm.name);
      },
      async delete() {
        api.calls.push(`delete:${vm.name}:${vm.sessionId}`);
        await api.teardown(vm);
        api.vms.delete(vm.name);
      },
    };
  }

  /** Stop every relay and delete every temp dir. */
  async dispose(): Promise<void> {
    for (const vm of this.vms.values()) await this.teardown(vm).catch(() => {});
    this.vms.clear();
    for (const d of this.drives.values()) rmSync(d.dir, { recursive: true, force: true });
    this.drives.clear();
  }
}

/** A TCP proxy to a relay's port that knows each connection's request path (`GET /ctl …`), so one kind can be dropped alone. */
async function proxyTo(port: number): Promise<NonNullable<FakeVm['proxy']>> {
  const open: NonNullable<FakeVm['proxy']>['open'] = new Set();
  const server = createServer((client) => {
    client.once('data', (first) => {
      const path = /^[A-Z]+ (\S+) HTTP/.exec(first.toString('latin1'))?.[1]?.split('?')[0] ?? '';
      const upstream = connect(port, '127.0.0.1');
      const entry = { path, sockets: [client, upstream] };
      open.add(entry);
      upstream.write(first);
      client.pipe(upstream);
      upstream.pipe(client);
      const done = () => {
        open.delete(entry);
        client.destroy();
        upstream.destroy();
      };
      client.on('close', done);
      upstream.on('close', done);
      client.on('error', done);
      upstream.on('error', done);
    });
    client.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { server, port: (server.address() as { port: number }).port, open };
}
