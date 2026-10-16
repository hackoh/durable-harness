/**
 * The sandbox stand-in for fx's sandbox tests (docs/workspaces.md §5.8,
 * §11.4 B7): harness-sandbox's private fake Sandbox API (each "VM" a local
 * relay child over temp dirs, `localMachine()`'s relay; each "Drive" a temp
 * dir that outlives the VMs mounted on it), behind the real session factory
 * (`sandboxSession`: the Drive and VM lifecycle, the arm with the runtime's
 * fencing token, the branded machine and its `RemoteMachine` over the
 * relay's helper), and fx's tools on it as durable-harness builds them:
 * `fxTools(sandbox())` for libfx's own agent (`fxAgentTools`, armed with the
 * epoch of the call's libfx lease), and the kernel's fx harness's
 * (`fxHostTools` on harness-world-hands' sandbox runtime, the kernel's
 * `attachInDrive` with the drive's own fence).
 *
 * One thing differs from a VM, and `AtWorkspace` covers it: a VM's Drive is
 * mounted at `/workspace`, the stand-in's is a temp dir, so each machine's
 * workspace is seen at `/workspace` here (paths in, and paths in what comes
 * back). Commands still run in the stand-in's temp dir, so a test's shell
 * commands use paths relative to the workspace.
 *
 * The packages are imported by path (test code only), as harness-pi's
 * stand-in does. Guarded like the stand-in (`DH_TEST_LOCAL_SANDBOX=1`, a
 * test runner, not on Vercel, not in production).
 */
import { realpathSync, rmSync } from 'node:fs';
import type { LocalWorld } from '@workflow/world-local';
import { fxAgentTools, fxHostTools } from '../../harness-hands/src/fx-exports.ts';
import type { DirEntry, ExecOptions, ExecResult, PathStat, WalkEntry, WorkspaceMachine } from '../../harness-hands/src/runtime-exports.ts';
import { kernelSandbox, sandboxRuntime } from '../../harness-hands/src/runtime-exports.ts';
import type { AcquireMachine, SessionMachine } from '../../harness-process/src/index.ts';
import { type SandboxSessionOptions, sandboxSession, type SandboxSpec } from '../../harness-sandbox/src/index.ts';
import { FakeSandboxApi, type FakeApiOptions } from '../../harness-sandbox/test/fake-api.ts';

export { FakeSandboxApi };
export { relayBundle } from '../../harness-sandbox/test/local-machine.ts';

/** What `sandbox()` resolves to, as the stand-in's tests need it (the factory reads these fields). */
export const SPEC: SandboxSpec = { vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: Infinity }, image: 'stand-in' };

/** The project the fake Sandbox API reports: a session's sandbox and Drive are named from it. */
export const STAND_IN_PROJECT = 'prj_stand_in';

const WS = '/workspace';

/** A machine's workspace seen at `/workspace` (see the module comment). */
export class AtWorkspace implements WorkspaceMachine {
  readonly root = WS;
  private readonly roots: string[];

  constructor(private readonly machine: WorkspaceMachine) {
    let real = machine.root;
    try {
      real = realpathSync(machine.root);
    } catch {}
    // The longer form first: macOS's temp dirs are under /private.
    this.roots = [...new Set([real, machine.root])].sort((a, b) => b.length - a.length);
  }

  get isolation() {
    return this.machine.isolation;
  }
  get lost() {
    return this.machine.lost;
  }

  /** A path as the stand-in has it. */
  private in(p: string): string {
    if (p === WS) return this.machine.root;
    if (p.startsWith(`${WS}/`)) return this.machine.root + p.slice(WS.length);
    return p;
  }
  /** A path as a VM would report it. */
  private out(p: string): string {
    for (const r of this.roots) {
      if (p === r) return WS;
      if (p.startsWith(`${r}/`)) return WS + p.slice(r.length);
    }
    return p;
  }
  private text(t: string): string {
    for (const r of this.roots) t = t.split(r).join(WS);
    return t;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const r = await this.machine.exec(command, { ...options, ...(options.cwd ? { cwd: this.in(options.cwd) } : {}), ...(options.args ? { args: options.args.map((a) => this.in(a)) } : {}) });
    return { ...r, stdout: this.text(r.stdout), stderr: this.text(r.stderr) };
  }
  readFile(path: string): Promise<Uint8Array> {
    return this.machine.readFile(this.in(path));
  }
  writeFile(path: string, content: string | Uint8Array, options?: { mode?: number; append?: boolean }): Promise<void> {
    return this.machine.writeFile(this.in(path), content, options);
  }
  stat(path: string): Promise<PathStat | undefined> {
    return this.machine.stat(this.in(path));
  }
  lstat(path: string): Promise<PathStat | undefined> {
    return this.machine.lstat(this.in(path));
  }
  list(dir: string): Promise<DirEntry[]> {
    return this.machine.list(this.in(dir));
  }
  async walk(dir?: string): Promise<WalkEntry[]> {
    return (await this.machine.walk(dir === undefined ? undefined : this.in(dir))).map((e) => ({ ...e, path: this.out(e.path) }));
  }
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.machine.mkdir(this.in(path), options);
  }
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return this.machine.remove(this.in(path), options);
  }
  rename(from: string, to: string): Promise<void> {
    return this.machine.rename(this.in(from), this.in(to));
  }
  symlink(target: string, path: string): Promise<void> {
    return this.machine.symlink(this.in(target), this.in(path));
  }
  async readlink(path: string): Promise<string> {
    return this.out(await this.machine.readlink(this.in(path)));
  }
  async realpath(path: string): Promise<string> {
    return this.out(await this.machine.realpath(this.in(path)));
  }
  chmod(path: string, mode: number): Promise<void> {
    return this.machine.chmod(this.in(path), mode);
  }
  dispose(): void {
    this.machine.dispose();
  }
}

/** The session factory's machines, each with its workspace at `/workspace` (`AtWorkspace`). */
export function atWorkspace(acquire: AcquireMachine): AcquireMachine {
  return async (request) => {
    const m = await acquire(request);
    return Object.freeze({ ...m, workspace: new AtWorkspace(m.workspace) }) as SessionMachine;
  };
}

/** fx's tools for libfx's own agent on `acquire`'s sandbox, as `fxTools(sandbox(), { world })` builds them. */
export function agentTools(acquire: AcquireMachine, world: LocalWorld) {
  return fxAgentTools({ kind: 'sandbox' }, { world: () => world, acquire });
}

/** The kernel fx harness's tools on `acquire`'s sandbox (the sandbox tier loaded on the first attach). */
export function kernelTools(acquire: AcquireMachine) {
  return fxHostTools(sandboxRuntime(kernelSandbox(acquire, () => import('../../harness-sandbox/src/cli.ts'))));
}

/**
 * A fake Sandbox API and the session factory over it: the `AcquireMachine`
 * `sandbox()` resolves to, on the stand-in. A second call with the same
 * `api` is another process's factory (another Function instance): the same
 * platform, none of the first one's attaches.
 */
export function standIn(options: { api?: FakeSandboxApi; apiOptions?: FakeApiOptions; spec?: Partial<SandboxSpec>; factory?: Omit<SandboxSessionOptions, 'spec' | 'test'>; name?: (projectId: string, sessionId: string) => string } = {}) {
  const api = options.api ?? new FakeSandboxApi(options.apiOptions);
  const acquire = atWorkspace(sandboxSession({ spec: { ...SPEC, ...options.spec }, ...options.factory, test: { api, allowDegraded: true, ...(options.name ? { name: options.name } : {}) } }));
  return { api, acquire };
}

/**
 * A stand-in whose session sandbox has a fixed name and an existing Drive
 * (`dir`, `driveId`): for a test whose session runs in another process
 * (each process has its own fake Sandbox API, over the same Drive dir).
 */
export function seededStandIn(drive: { name: string; dir: string; driveId: string }) {
  const api = new FakeSandboxApi();
  const d = api.addDrive(drive.name);
  rmSync(d.dir, { recursive: true, force: true });
  d.dir = drive.dir;
  d.info.driveId = drive.driveId;
  return standIn({ api, name: () => drive.name });
}
