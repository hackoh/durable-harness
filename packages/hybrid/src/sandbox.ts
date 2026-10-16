import { APIError, type Command, type NetworkPolicy, Sandbox, StreamError } from '@vercel/sandbox';
import { mintResultToken } from './callback.ts';
import { hardStopMs, parseReport } from './sandbox-job.ts';
import {
  type ExecOptions,
  type ExecResult,
  type Inspection,
  JOB_READ_LIMITS,
  type JobFiles,
  type JobParts,
  type Manifest,
  type ManifestOptions,
  type SandboxHandle,
  type SandboxJob,
  SandboxLostError,
  type SandboxOwner,
  type KeepaliveResult,
  type SandboxProvider,
  type SandboxReport,
  sandboxNameFor,
} from './sandbox-sync.ts';

/**
 * Whether an error from `@vercel/sandbox` means the VM (or its session) is
 * gone: stopped (410; `snapshot_not_found` when there is nothing to resume),
 * deleted (404), going away (422 `sandbox_stopping` / `sandbox_snapshotting`),
 * or a log stream that ended with the VM (`StreamError`). Network errors are
 * ambiguous and not counted here.
 */
export function isSandboxLost(err: unknown): boolean {
  if (err instanceof SandboxLostError || err instanceof StreamError) return true;
  if (!(err instanceof APIError)) return false;
  const status = err.response?.status;
  if (status === 410 || status === 404) return true;
  const code = (err.json as { error?: { code?: string } } | undefined)?.error?.code;
  if (status !== 422) return false;
  if (code === 'sandbox_stopping' || code === 'sandbox_snapshotting') return true;
  // Seen in production without that code: "Sandbox is stopping and no longer
  // accepts commands".
  return /\b(stopping|snapshotting)\b/i.test(`${code ?? ''} ${err.message}`);
}

function lossCode(err: unknown): string | undefined {
  if (err instanceof StreamError) return err.code;
  if (err instanceof APIError) {
    const code = (err.json as { error?: { code?: string } } | undefined)?.error?.code;
    return `${err.response?.status}${code ? ` ${code}` : ''}`;
  }
  return undefined;
}

/**
 * The `sandbox` lane's hands: one persistent, named Vercel Sandbox per
 * session (`hybrid-<runId>`). Server-only (import from
 * `harness-world-hybrid/sandbox`).
 *
 * Credentials: on Vercel, `@vercel/sandbox` picks up the function's
 * `VERCEL_OIDC_TOKEN` on its own; elsewhere pass `credentials` (or set
 * `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` / `VERCEL_TOKEN`, which the SDK
 * also reads).
 */
export interface VercelSandboxProviderOptions {
  credentials?: { teamId: string; projectId: string; token: string };
  /**
   * Sandbox name prefix. Default `hybrid`: a session's VM is
   * `hybrid-<runId>`. Never `dh` (refused): `dh-` names are the session's
   * `sandbox()` VM and Drive (harness-sandbox), and this provider's VMs run
   * the model's commands as root, so they are never that VM.
   */
  namePrefix?: string;
  /** VCR image. Default: the SDK's `vercel/sandbox/universal` (node, python, git). */
  image?: string;
  /**
   * Tags a VM created from `image` also gets (the sandbox lane's image
   * records its bundle version as `hostImage`, P6). If the image does not
   * exist (404), VMs are created from the default image without these tags,
   * and this process stops asking for it for `imageRetryMs`.
   */
  imageTags?: Record<string, string>;
  /**
   * How long a missing image (404) is not asked for again. Default 10
   * minutes: an image pushed after the deployment went live (the image is
   * built from the same bundle, on a laptop) is picked up by its warm
   * instances, not only by new ones.
   */
  imageRetryMs?: number;
  /**
   * Files a VM created from `image` reads in the background on connect, so
   * the image's lazily fetched blocks are local before they are needed (the
   * sandbox lane's daemon bundle and `node`: its first start reads them cold).
   */
  imagePrefetch?: string[];
  /** How long a session's VM stays up after it starts. Default 10 minutes. */
  timeoutMs?: number;
  /**
   * How long `open` waits for a VM that is still stopping or snapshotting
   * before it can be resumed. Default 2 minutes.
   */
  settleTimeoutMs?: number;
  vcpus?: number;
  /** Where the workspace lives in the VM. Default `/workspace`, as in just-bash. */
  root?: string;
  /**
   * Push results back to the app (see `callbackFromEnv`): the detached
   * path's. Without it, results are collected by polling the Sandbox API
   * (pull). `run_on_machine` refuses a provider built with one: build it
   * with `callback: undefined` (docs/workspaces.md §8).
   */
  callback?: SandboxCallback;
}

/** How a finished command reaches the app. All three are server-only. */
export interface SandboxCallback {
  /** Full URL of `POST /api/hybrid/sandbox-result` on a host the VM can reach. */
  url: string;
  /** `HYBRID_CALLBACK_SECRET`: signs each step's capability token. */
  secret: string;
  /**
   * The deployment's protection bypass (`VERCEL_AUTOMATION_BYPASS_SECRET`).
   * Never given to the VM: the sandbox's egress proxy injects it, for
   * exactly one method and path on the callback host (see `callbackPolicy`).
   */
  bypass: string;
}

export const SANDBOX_RESULT_PATH = '/api/hybrid/sandbox-result';

/** The daemon's port (`sb.domain(HOST_PORT)`). */
export const HOST_PORT = 3000;

/**
 * The callback from the environment, or `undefined` (pull mode): the URL is
 * `HYBRID_CALLBACK_URL`, else the production or branch URL on Vercel; the
 * secret is `HYBRID_CALLBACK_SECRET`; the bypass `VERCEL_AUTOMATION_BYPASS_SECRET`.
 */
export function callbackFromEnv(env: Record<string, string | undefined> = process.env): SandboxCallback | undefined {
  const secret = env.HYBRID_CALLBACK_SECRET;
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const base =
    env.HYBRID_CALLBACK_URL ??
    (env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : env.VERCEL_BRANCH_URL || env.VERCEL_URL
        ? `https://${env.VERCEL_BRANCH_URL || env.VERCEL_URL}`
        : undefined);
  if (!secret || !bypass || !base) return undefined;
  const url = new URL(base);
  if (url.pathname === '/' || url.pathname === '') url.pathname = SANDBOX_RESULT_PATH;
  return { url: url.toString(), secret, bypass };
}

/**
 * Any `x-vercel-*` key, in any case. Spelled as character classes: the
 * Sandbox API's regex dialect has no inline flags (`(?i)` is rejected with a
 * 400, which would fail every connect), and the deny rules must stay, or the
 * VM could send `x-vercel-set-bypass-cookie` alongside the injected bypass
 * and walk away with a cookie for the whole deployment.
 */
export const X_VERCEL_KEY = '^[xX]-[vV][eE][rR][cC][eE][lL]-';

/**
 * The VM's network policy with a callback: everything allowed as before,
 * except that on the callback host the VM may not send its own `x-vercel-*`
 * controls (so it cannot mint a bypass cookie), and exactly one route, POST
 * `/api/hybrid/sandbox-result`, gets the protection bypass header injected by
 * the egress proxy. The VM never sees the secret; that route still demands
 * the per-step token.
 */
export function callbackPolicy(callback: SandboxCallback): NetworkPolicy {
  const url = new URL(callback.url);
  return {
    allow: {
      [url.hostname]: [
        { match: { headers: [{ key: { regex: X_VERCEL_KEY } }] }, response: { statusCode: 403 } },
        { match: { queryString: [{ key: { regex: X_VERCEL_KEY } }] }, response: { statusCode: 403 } },
        {
          match: { path: { exact: url.pathname }, method: ['POST'] },
          transform: [{ headers: { 'x-vercel-protection-bypass': callback.bypass } }],
        },
      ],
      '*': [],
    },
  } as NetworkPolicy;
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly kind = 'vercel';
  /**
   * Connections reused for a minute. Not longer: a warm function outlives
   * the VM's timeout, and a persistent sandbox that stopped is resumed from
   * its snapshot by the next `getOrCreate`, not by an old handle.
   */
  private readonly handles = new Map<string, { at: number; handle: Promise<VercelSandbox> }>();

  constructor(private readonly options: VercelSandboxProviderOptions = {}) {
    if (options.namePrefix !== undefined && !isOwnPrefix(options.namePrefix)) {
      throw new TypeError(`harness-world-hybrid: namePrefix ${JSON.stringify(options.namePrefix)} is refused: dh- names are the session's sandbox() VM, never this provider's`);
    }
  }

  /** The push callback it was built with, if any (`run_on_machine` refuses one). */
  get callback(): SandboxCallback | undefined {
    return this.options.callback;
  }

  invalidate(sessionId: string): void {
    this.handles.delete(sandboxNameFor(sessionId, this.options.namePrefix));
  }

  async reportFor(job: { runId: string; stepId: string; sandbox: string; timeoutSeconds: number; startedAt: number }) {
    const cb = this.options.callback;
    if (!cb) return undefined;
    const token = await mintResultToken(cb.secret, {
      r: job.runId,
      s: job.stepId,
      n: job.sandbox,
      x: Math.floor(job.startedAt / 1000) + job.timeoutSeconds + 900,
    });
    return { url: cb.url, token };
  }

  private get(name: string) {
    return Sandbox.get({ name, ...(this.options.credentials ?? {}) } as Parameters<typeof Sandbox.get>[0]);
  }

  async inspect(owner: SandboxOwner): Promise<Inspection> {
    let sandbox: Sandbox;
    try {
      sandbox = await this.get(owner.sandbox);
    } catch (err) {
      if (err instanceof APIError && (err.response?.status === 404 || err.response?.status === 410)) {
        return { state: 'lost', why: 'deleted', code: lossCode(err) };
      }
      return { state: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }
    let session;
    try {
      session = sandbox.currentSession();
    } catch {
      return { state: 'lost', why: 'stopped' };
    }
    if (session.status !== 'running') return { state: 'lost', why: 'stopped', code: session.status };
    if (session.sessionId !== owner.sessionId) return { state: 'lost', why: 'replaced' };
    // A command the in-VM daemon spawned: not a Sandbox API
    // command, so read its job dir and process through one bounded command.
    if (/^pid:\d+$/.test(owner.cmdId)) {
      try {
        const state = await daemonJobState(sandbox, owner);
        if (state.exitCode !== undefined) return { state: 'exited', exitCode: state.exitCode };
        if (state.alive) {
          const expiresAt = sandbox.expiresAt?.getTime();
          return { state: 'running', ...(expiresAt ? { expiresAt } : {}) };
        }
        return { state: 'lost', why: 'command-missing' };
      } catch (err) {
        if (isSandboxLost(err)) return { state: 'lost', why: 'stopped', code: lossCode(err) };
        return { state: 'unknown', error: err instanceof Error ? err.message : String(err) };
      }
    }
    try {
      // The session's own getCommand: it never resumes a stopped VM.
      const cmd = await session.getCommand(owner.cmdId);
      const expiresAt = sandbox.expiresAt?.getTime();
      if (cmd.exitCode === null) return { state: 'running', ...(expiresAt ? { expiresAt } : {}) };
      return { state: 'exited', exitCode: cmd.exitCode };
    } catch (err) {
      if (err instanceof APIError && err.response?.status === 404) return { state: 'lost', why: 'command-missing' };
      if (isSandboxLost(err)) return { state: 'lost', why: 'stopped', code: lossCode(err) };
      return { state: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async attach(owner: SandboxOwner): Promise<SandboxHandle | 'lost'> {
    const cached = this.handles.get(owner.sandbox);
    if (cached && Date.now() - cached.at < 60_000) {
      const handle = await cached.handle.catch(() => undefined);
      if (handle && handle.sessionId === owner.sessionId) return handle;
    }
    try {
      const sandbox = await this.get(owner.sandbox);
      const session = sandbox.currentSession();
      if (session.status !== 'running' || session.sessionId !== owner.sessionId) return 'lost';
      return new VercelSandbox(sandbox, this.options.credentials);
    } catch (err) {
      if (err instanceof APIError && (err.response?.status === 404 || err.response?.status === 410)) return 'lost';
      if (err instanceof Error && /No active session/.test(err.message)) return 'lost';
      throw err;
    }
  }

  async stopVm(owner: SandboxOwner): Promise<void> {
    const sandbox = await this.get(owner.sandbox);
    await sandbox.stop();
    this.handles.delete(owner.sandbox);
  }

  async keepalive(name: string, minLeftMs: number): Promise<KeepaliveResult> {
    let sandbox: Sandbox;
    try {
      sandbox = await this.get(name);
    } catch (err) {
      if (err instanceof APIError && (err.response?.status === 404 || err.response?.status === 410)) return { status: 'absent' };
      throw err;
    }
    // Only a running VM is kept alive: a stopped one stays stopped (that is
    // its idle teardown); the next start resumes it.
    if (sandbox.status !== 'running') return { status: sandbox.status };
    return extendIfShort(sandbox, minLeftMs);
  }

  async countWarm(): Promise<number> {
    const page = await Sandbox.list({
      tags: { app: APP_TAG },
      limit: 100,
      sortBy: 'statusUpdatedAt',
      sortOrder: 'desc',
      ...(this.options.credentials ?? {}),
    } as Parameters<typeof Sandbox.list>[0]);
    return page.sandboxes.filter((s) => s.status === 'running' || s.status === 'pending').length;
  }

  async deleteVm(name: string, keep?: (domain: (port: number) => string) => Promise<boolean>): Promise<'deleted' | 'absent' | 'kept'> {
    this.handles.delete(name);
    try {
      const sandbox = await this.get(name);
      // A running VM can veto its deletion (a daemon with a session attached).
      if (keep && sandbox.status === 'running' && (await keep((port) => sandbox.domain(port)).catch(() => false))) return 'kept';
      await sandbox.delete({ deleteOrphanSnapshots: true });
      return 'deleted';
    } catch (err) {
      if (err instanceof APIError && (err.response?.status === 404 || err.response?.status === 410)) return 'absent';
      throw err;
    }
  }

  open(sessionId: string): Promise<SandboxHandle> {
    const name = sandboxNameFor(sessionId, this.options.namePrefix);
    // Its own names only (`hybrid-<runId>`), never the session's sandbox() VM.
    if (/^dh-/.test(name)) return Promise.reject(new Error(`harness-world-hybrid: refusing to open ${name}: a dh- name is the session's sandbox() VM`));
    const cached = this.handles.get(name);
    if (cached && Date.now() - cached.at < 60_000) return cached.handle;
    const handle = this.connect(name);
    this.handles.set(name, { at: Date.now(), handle });
    handle.catch(() => this.handles.delete(name));
    return handle;
  }

  /** The configured image was not found (404): use the default until then (ms). */
  private imageMissingUntil = 0;

  private async connect(name: string, withoutImage = false): Promise<VercelSandbox> {
    const { credentials, vcpus } = this.options;
    const image = withoutImage || Date.now() < this.imageMissingUntil ? undefined : this.options.image;
    const params = {
      name,
      persistent: true,
      timeout: this.options.timeoutMs ?? 10 * 60_000,
      keepLastSnapshots: { count: 1 },
      tags: {
        app: APP_TAG,
        lane: 'sandbox',
        ...(name.includes('-pool-') ? { pool: '1' } : {}),
        ...(image ? (this.options.imageTags ?? {}) : {}),
      },
      // The sandbox lane's daemon serves here (a VM created without it cannot host one).
      ports: [HOST_PORT],
      ...(image ? { image } : {}),
      ...(vcpus ? { resources: { vcpus } } : {}),
      ...(credentials ?? {}),
    } as Parameters<typeof Sandbox.getOrCreate>[0];
    const policy = this.options.callback ? callbackPolicy(this.options.callback) : undefined;
    const root = this.options.root ?? '/workspace';
    // A VM that was just stopped (a crash, its timeout) is `stopped`, or for
    // a few seconds still `stopping` / `snapshotting`. Ask for a resumed
    // session (`resume: true`); while it is still settling, wait and ask
    // again. Only Sandbox-level calls auto-resume a stopped session
    // (`currentSession()` calls do not), so use those below.
    const deadline = Date.now() + (this.options.settleTimeoutMs ?? 120_000);
    for (let attempt = 0; ; attempt++) {
      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.getOrCreate({
          ...params,
          resume: true,
          ...(policy ? { networkPolicy: policy } : {}),
        } as Parameters<typeof Sandbox.getOrCreate>[0]);
      } catch (err) {
        if (image && isImageNotFound(err)) {
          const retryMs = this.options.imageRetryMs ?? 10 * 60_000;
          console.warn(`[harness] sandbox image ${image} not found: VMs use the default image (and the classic install) for ${Math.round(retryMs / 1000)}s`);
          this.imageMissingUntil = Date.now() + retryMs;
          return this.connect(name, true);
        }
        throw err;
      }
      if (SETTLING.has(sandbox.status)) {
        if (Date.now() > deadline) throw new SandboxLostError({ phase: 'start', sandbox: name, code: sandbox.status });
        await sleep(Math.min(500 * 2 ** attempt, 3000));
        continue;
      }
      try {
        // Every connect: also covers a VM resumed from a snapshot taken under
        // an older policy, and a rotated secret. Idempotent. `update` stores it
        // on the sandbox (the next session starts with it) and applies it to
        // the running one: two control-plane calls (a PATCH on the sandbox,
        // then the session's), where `updateNetworkPolicy`, which 3.7.0
        // deprecates for it, made one. The PATCH can answer 422 while the VM
        // goes away; the catch below treats that as a lost VM.
        if (policy) await sandbox.update({ networkPolicy: policy });
        // The default user cannot create top-level directories; do it once per
        // process (idempotent, and it survives snapshot restores anyway).
        const prefetch = image && this.options.imagePrefetch?.length ? prefetchScript(this.options.imagePrefetch) : '';
        const prep = await sandbox.runCommand({
          cmd: 'bash',
          args: ['-c', `${prefetch}sudo mkdir -p ${q(root)} && sudo chown "$(id -u):$(id -g)" ${q(root)}`],
        });
        if (prep.exitCode !== 0) {
          throw new Error(`could not prepare ${root} in sandbox ${name}: ${await prep.stderr()}`);
        }
      } catch (err) {
        // It started going away between getOrCreate and now: same wait.
        if (isSandboxLost(err) && Date.now() <= deadline) {
          await sleep(Math.min(500 * 2 ** attempt, 3000));
          continue;
        }
        throw err;
      }
      return new VercelSandbox(sandbox, credentials);
    }
  }
}

/** A name prefix of this provider's own: not empty, not `dh` (the `sandbox()` VMs' and Drives' namespace). */
function isOwnPrefix(prefix: string): boolean {
  const slug = prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug !== '' && slug !== 'dh' && !slug.startsWith('dh-');
}

/** Read `paths` (files, or directories' files) in the background, detached from the command's output. */
export function prefetchScript(paths: string[]): string {
  return `(find ${paths.map(q).join(' ')} -type f -exec cat {} + >/dev/null 2>&1 </dev/null &) ; `;
}

/** `Sandbox.create` with an `image` VCR does not have: 404 "Image not found". */
export function isImageNotFound(err: unknown): boolean {
  return err instanceof APIError && err.response?.status === 404 && /image/i.test(String((err as Error).message));
}

/** The tag every VM of this app carries (the team cap counts them). A stable id: the project's earlier name. */
const APP_TAG = 'harness-on-world';

/** Extend `sandbox`'s timeout so at least `minLeftMs` is left (one `extendTimeout`, about 230 ms, only when short). */
async function extendIfShort(sandbox: Sandbox, minLeftMs: number): Promise<KeepaliveResult> {
  const left = (sandbox.expiresAt?.getTime() ?? Infinity) - Date.now();
  if (left >= minLeftMs) return { status: 'running', ...(Number.isFinite(left) ? { leftMs: left } : {}) };
  const extendedMs = minLeftMs - Math.max(0, left) + 60_000;
  await sandbox.extendTimeout(extendedMs);
  return { status: 'running', leftMs: Math.max(0, left) + extendedMs, extendedMs };
}

/** Session states that end on their own shortly; commands fail meanwhile. */
const SETTLING = new Set<string>(['stopping', 'snapshotting']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class VercelSandbox implements SandboxHandle {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly credentials?: VercelSandboxProviderOptions['credentials']
  ) {}

  get name() {
    return this.sandbox.name;
  }

  get sessionId(): string {
    return this.sandbox.currentSession().sessionId;
  }

  /** The SDK object (for `startHost`). */
  get raw(): Sandbox {
    return this.sandbox;
  }

  /** Commands this handle started, so a wait needs no extra lookup. */
  private readonly started = new Map<string, Command>();

  async ensureTimeout(ms: number): Promise<void> {
    const left = (this.sandbox.expiresAt?.getTime() ?? Infinity) - Date.now();
    if (left < ms) await this.sandbox.extendTimeout(ms - Math.max(0, left) + 60_000);
  }

  async start(job: SandboxJob): Promise<{ cmdId: string; sessionId: string }> {
    const dir = `/tmp/harness/${job.stepId}`;
    let cmd: Command;
    try {
      cmd = await this.sandbox.runCommand({
        cmd: 'bash',
        args: [`${dir}/run.sh`, dir, String(job.timeoutSeconds)],
        detached: true,
        // Only if the wrapper itself hangs: the command's own budget is `timeout`'s.
        timeoutMs: hardStopMs(job.timeoutSeconds),
      });
    } catch (err) {
      if (isSandboxLost(err)) throw new SandboxLostError({ phase: 'start', sandbox: this.name, cause: err, code: lossCode(err) });
      throw err;
    }
    this.started.set(cmd.cmdId, cmd);
    return { cmdId: cmd.cmdId, sessionId: this.sandbox.currentSession().sessionId };
  }

  async waitFor(cmdId: string, ms: number): Promise<{ exitCode: number } | undefined> {
    if (ms <= 0) return undefined;
    if (/^pid:\d+$/.test(cmdId)) {
      // A daemon-spawned command: its job dir is not known from the id; collectors read result.json.
      return undefined;
    }
    try {
      const cmd = this.started.get(cmdId) ?? (await this.sandbox.currentSession().getCommand(cmdId));
      const done = await cmd.wait({ signal: AbortSignal.timeout(ms) });
      return { exitCode: done.exitCode };
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return undefined;
      if (isSandboxLost(err)) throw new SandboxLostError({ phase: 'run', sandbox: this.name, cause: err, code: lossCode(err) });
      throw err;
    }
  }

  async readJob(jobDir: string, want: JobParts = { result: true, baseline: true }): Promise<JobFiles> {
    // The job dir is the command's to scribble on: any file in it may be
    // huge, a symlink to /dev/zero, or a FIFO. So never `readFile` it: one
    // bounded command reads only regular files, only what was asked for,
    // and at most `JOB_READ_LIMITS` bytes of each (`head -c` under a
    // `timeout`), base64 per line.
    const parts: [string, number, 'whole' | 'head'][] = [];
    if (want.result) parts.push(['result.json', JOB_READ_LIMITS.result, 'whole']);
    if (want.baseline) parts.push(['baseline.json', JOB_READ_LIMITS.baseline, 'whole']);
    if (want.output) parts.push(['stdout', JOB_READ_LIMITS.output, 'head'], ['stderr', JOB_READ_LIMITS.output, 'head']);
    if (parts.length === 0) return {};
    const script = [
      `cd -- ${q(jobDir)} 2>/dev/null || exit 0`,
      'emit() {',
      '  f=$1; l=$2; m=$3',
      '  { [ -f "$f" ] && [ ! -h "$f" ]; } || return 0',
      '  s=$(stat -c %s -- "$f" 2>/dev/null) || return 0',
      '  if [ "$m" = whole ] && [ "$s" -gt "$l" ]; then printf \'%s -\\n\' "$f"; return 0; fi',
      '  printf \'%s %s\\n\' "$f" "$(timeout 5 head -c "$l" -- "$f" 2>/dev/null | base64 -w0)"',
      '}',
      ...parts.map(([name, limit, mode]) => `emit ${name} ${limit} ${mode}`),
    ].join('\n');
    const out = await this.sync(async () => {
      const cmd = await this.sandbox.runCommand({ cmd: 'bash', args: ['-c', script] });
      return cmd.stdout();
    });
    const files = new Map<string, string>();
    for (const line of out.split('\n')) {
      const m = /^(\S+) (.*)$/.exec(line);
      if (!m || m[2] === '-') continue;
      files.set(m[1]!, new TextDecoder().decode(Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0))));
    }
    const result: JobFiles = {};
    const report = files.get('result.json');
    if (report !== undefined) {
      try {
        const parsed = parseReport(JSON.parse(report));
        if (parsed) result.result = parsed;
      } catch {}
    }
    if (files.has('baseline.json')) result.baselineText = files.get('baseline.json')!;
    if (files.has('stdout')) result.stdout = files.get('stdout')!;
    if (files.has('stderr')) result.stderr = files.get('stderr')!;
    return result;
  }

  async killCommand(target: { cmdId: string; jobDir?: string }): Promise<void> {
    if (target.jobDir) {
      // The command's whole process group; the wrapper lives on and reports.
      const script = `p=$(cat ${q(`${target.jobDir}/child.pid`)} 2>/dev/null) && kill -KILL -- "-$p" 2>/dev/null; true`;
      await this.sync(() => this.sandbox.runCommand({ cmd: 'bash', args: ['-c', script] }));
      return;
    }
    await this.kill(target.cmdId);
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    // A command that outlives the VM's own timeout is the commonest "lost
    // VM": give the VM room first.
    if (options.timeoutMs) {
      const left = (this.sandbox.expiresAt?.getTime() ?? Infinity) - Date.now();
      if (left < options.timeoutMs + 30_000) {
        await this.sandbox.extendTimeout(options.timeoutMs + 60_000).catch(() => {});
      }
    }
    let cmd: Command;
    try {
      cmd = await this.sandbox.runCommand({
        cmd: 'bash',
        args: ['-lc', command],
        cwd: options.cwd,
        detached: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    } catch (err) {
      if (isSandboxLost(err)) throw new SandboxLostError({ phase: 'start', sandbox: this.name, cause: err, code: lossCode(err) });
      throw err;
    }
    options.onStart?.(cmd.cmdId);
    let stdout = '';
    let stderr = '';
    const signal = options.signal ? { signal: options.signal } : {};
    let reattached = 0;
    for (;;) {
      try {
        // Re-attached logs replay from the start: count what we already have.
        let seenOut = 0;
        let seenErr = 0;
        const haveOut = stdout.length;
        const haveErr = stderr.length;
        for await (const line of cmd.logs(signal)) {
          if (line.stream === 'stdout') {
            const skip = Math.max(0, haveOut - seenOut);
            seenOut += line.data.length;
            const data = line.data.slice(skip);
            if (!data) continue;
            stdout += data;
            options.onOutput?.(line.stream, data);
          } else {
            const skip = Math.max(0, haveErr - seenErr);
            seenErr += line.data.length;
            const data = line.data.slice(skip);
            if (!data) continue;
            stderr += data;
            options.onOutput?.(line.stream, data);
          }
        }
        const done = await cmd.wait(signal);
        return { exitCode: done.exitCode, stdout, stderr };
      } catch (err) {
        if (options.signal?.aborted) throw err;
        const lost = isSandboxLost(err) || (await this.gone());
        if (lost || reattached >= 2) {
          if (!lost) throw err;
          throw new SandboxLostError({ phase: 'run', sandbox: this.name, cause: err, code: lossCode(err), stdout, stderr });
        }
        // Ambiguous (a dropped connection): the VM is up, so pick the
        // command up again where it is.
        reattached++;
        try {
          cmd = await this.sandbox.getCommand(cmd.cmdId);
        } catch (again) {
          throw new SandboxLostError({ phase: 'run', sandbox: this.name, cause: again, code: lossCode(again), stdout, stderr });
        }
      }
    }
  }

  /** Whether the VM this handle talks to is no longer the one running. */
  private async gone(): Promise<boolean> {
    try {
      const now = await Sandbox.get({ name: this.sandbox.name, ...(this.credentials ?? {}) } as Parameters<typeof Sandbox.get>[0]);
      return now.status !== 'running' || now.currentSession().sessionId !== this.sandbox.currentSession().sessionId;
    } catch (err) {
      return isSandboxLost(err);
    }
  }

  async kill(cmdId: string): Promise<void> {
    const cmd = await this.sandbox.getCommand(cmdId).catch(() => undefined);
    await cmd?.kill('SIGKILL').catch(() => {});
  }

  /** Run a sync call, reporting a lost VM as `SandboxLostError`. */
  private async sync<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isSandboxLost(err)) throw new SandboxLostError({ phase: 'sync', sandbox: this.name, cause: err, code: lossCode(err) });
      throw err;
    }
  }

  manifest(root: string, options: ManifestOptions): Promise<Manifest> {
    return this.sync(() => this.manifestUnchecked(root, options));
  }

  private async manifestUnchecked(root: string, options: ManifestOptions): Promise<Manifest> {
    const prune = options.skipDirs.map((d) => `-name ${q(d)}`).join(' -o ');
    const script = [
      `cd ${q(root)} 2>/dev/null || exit 0`,
      `find . \\( -type d \\( ${prune} \\) \\) -prune -o -type f -print0 |`,
      `while IFS= read -r -d '' f; do`,
      // Text files only: empty, or grep -I does not call it binary.
      `  if [ ! -s "$f" ] || grep -Iq -e '' "$f"; then`,
      `    printf '%s %s %s\\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "\${f#./}"`,
      '  fi',
      'done',
    ].join('\n');
    const result = await this.sandbox.runCommand({ cmd: 'bash', args: ['-c', script] });
    const stdout = await result.stdout();
    if (result.exitCode !== 0) {
      throw new Error(`manifest failed in ${this.name}: ${await result.stderr()}`);
    }
    const out: Manifest = new Map();
    for (const line of stdout.split('\n')) {
      const m = /^([0-9a-f]{64}) (\d+) (.+)$/.exec(line);
      if (m) out.set(`${root}/${m[3]}`, { hash: m[1]!, size: Number(m[2]) });
    }
    return out;
  }

  async writeFiles(files: { path: string; content: string | Uint8Array }[]): Promise<void> {
    await this.sync(() => this.sandbox.writeFiles(files.map((f) => ({ path: f.path, content: f.content }))));
  }

  async readTextFile(path: string): Promise<string | null> {
    const buf = await this.sync(() => this.sandbox.readFileToBuffer({ path }));
    if (!buf) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  }

  async remove(paths: string[]): Promise<void> {
    await this.sync(() => this.sandbox.runCommand('rm', ['-f', '--', ...paths]));
  }
}

/** Single-quote for bash. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** A daemon-spawned job's state: its exit code once `result.json` exists, else whether its wrapper still runs. */
async function daemonJobState(sandbox: Sandbox, owner: SandboxOwner): Promise<{ exitCode?: number; alive: boolean }> {
  const pid = owner.cmdId.slice('pid:'.length);
  const script = [
    `r=${q(`${owner.jobDir}/result.json`)}`,
    'if [ -f "$r" ] && [ ! -h "$r" ]; then printf "exit %s\\n" "$(timeout 5 head -c 65536 -- "$r" | base64 -w0)"; fi',
    `[ -d /proc/${pid} ] && echo alive || echo gone`,
  ].join('\n');
  const cmd = await sandbox.runCommand({ cmd: 'bash', args: ['-c', script] });
  const out = await cmd.stdout();
  const exitLine = /^exit (\S+)$/m.exec(out);
  if (exitLine) {
    try {
      const report = parseReport(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(exitLine[1]!), (c) => c.charCodeAt(0)))));
      if (report) return { exitCode: report.exitCode, alive: false };
    } catch {}
  }
  return { alive: /^alive$/m.test(out) };
}
