/**
 * The in-VM relay (docs/workspaces.md §5.4): one WebSocket server the Function
 * dials on two paths, a loopback model port the CLI calls, and a unix control
 * socket the `arm` command uses.
 *
 * Two tiers. The **privileged tier** (root, with `runAs` set; a real VM) keeps
 * root for what needs it (cgroups, `WIPE`, kill, `FSYNC`, the fence) and runs
 * every model-reachable operation as the unprivileged user: each `SPAWN` goes
 * through a root shim that puts itself in the session cgroup and then
 * `setpriv`s down, applying the child's env only after the drop; `FILES` runs
 * `tar` as that user into a dir it owns; `TAIL` opens with `O_NOFOLLOW`, checks
 * the opened file is under the cache dir and owned by that user, and tracks its
 * inode. Root without `runAs` refuses to start. The **degraded tier** (not
 * root: macOS, an unprivileged container; the stand-in VM, §5.8) is one uid,
 * process-group kill, no cgroups: enough to prove the protocol, auth, fence,
 * heartbeats and resume.
 *
 * Every attach (one arm, its `/ctl` and `/model`) is a generation. Frames are
 * acted on only from the current generation's sockets; a child, a tail and a
 * `FILES` belong to the `/ctl` socket that started them and send only on it; a
 * retired socket (superseded, dead, replaced by a same-fence admit) has its
 * listeners removed, so its late frames and its late close change nothing. The
 * loss of either current socket is the loss of both: the relay kills the
 * session tree and idles.
 *
 * The highest fence and the session are persisted (`<stateDir>/fence.json`,
 * 0600, written before an arm is answered), so a restarted relay still refuses
 * a stale driver; at start, a session cgroup left by the previous relay is
 * killed (its sockets died with it). The armed capability itself stays in
 * memory: a restart drops it and the driver re-arms (§5.4 step 4).
 *
 * Bundled with `ws` into one `.mjs` (see `bundle.ts`); it imports only the pure
 * protocol, `/proc` parsers and world-remote's `/model` adapter.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, join, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { requestOverWs, type WsLike, type WsRequest } from 'harness-world-remote/ws';
import {
  CLOSE,
  CTL,
  ENV_ERROR_CODE,
  ENV_ERROR_MESSAGE,
  HELPER,
  HELPER_RESULT_BYTES,
  HelperReader,
  LIMITS,
  MUTATING_ENV_OPS,
  ProtocolError,
  constantTimeEqualHex,
  envResultBytes,
  decodeCtl,
  frame,
  helloProof,
  helperFrame,
  isCount,
  keyHash,
  isEnvOp,
  isObject,
  json,
  mintNonce,
  pack,
  parse,
  tokenHash,
  type EnvOp,
} from './protocol.ts';
import { canCheckPeers, kernelBootId, listenerCheck, notDumpable, peerPid, procMasks } from './procfs.ts';
import type { ArmReply, ArmRequest } from './protocol.ts';

export type { ArmReply, ArmRequest } from './protocol.ts';

/** What the launcher writes (`<stateDir>/relay.json` or `/opt/dh/relay.json`) and both `serve` and `arm` read. */
export interface RelayConfig {
  /** The control WS port the Function dials (the ingress exposes it). */
  port: number;
  /** The loopback HTTP port the CLI sends model requests to. */
  modelPort: number;
  /** Where the control socket and the fence record live (`/run/dh` in a VM). Made 0700. */
  stateDir: string;
  /** The workspace root (`/workspace`, the Drive). */
  workspace: string;
  /** Where the cache dirs live (`/var/lib/dh/s` in a VM). */
  cacheRoot: string;
  /** The unprivileged user model commands run as (the privileged tier); empty for the degraded one-uid tier. Required when the relay runs as root. */
  runAs?: string;
  /** Set up a cgroup2 session leaf for `cgroup.kill` (reaches setsid'd children and pid namespaces). Off: process-group kill. */
  cgroup?: boolean;
  /** This relay's version (a recipe hash), echoed to the driver at arm. */
  relayVersion: string;
  /** The CLI versions installed, echoed at arm (§5.2). */
  cliVersions?: Record<string, string>;
  /** How long an arm admits its sockets (default 30 s; tests shorten it). */
  armTtlMs?: number;
  /**
   * Tests only: run this script (with `node`) as the helper instead of the
   * bundle's own `helper` entry, to play a helper that breaks the pipe's
   * rules. Honored only under the stand-in's guard (`DH_TEST_LOCAL_SANDBOX=1`
   * and a test runner, `VERCEL` unset, not production); set anywhere else, the
   * relay refuses to start.
   */
  testHelperEntry?: string;
}

/** The cache directories (`CacheDir`), as absolute paths under `cacheRoot`. */
const CACHE_DIRS = ['home', 'config', 'codex-home', 'tmp', 'cache'] as const;
type CacheDir = (typeof CACHE_DIRS)[number];
const isCacheDir = (v: unknown): v is CacheDir => typeof v === 'string' && (CACHE_DIRS as readonly string[]).includes(v);
const cacheDirPath = (c: RelayConfig, dir: CacheDir) => join(c.cacheRoot, dir);

const CGROUP_FS = '/sys/fs/cgroup';
/** The fixed PATH a root shim and a privileged child start from; never the relay's own or the driver's. */
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Names the relay refuses in a `SPAWN` env (the driver refuses them too, `env-check.ts`): they change how a loader or shell starts. */
const LOADER_NAMES = /^(?:LD_[A-Z0-9_]*|BASH_ENV|ENV|BASHOPTS|SHELLOPTS|PS4|PROMPT_COMMAND|BASH_FUNC_.*)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KILL_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT']);
/** The cache dirs the helper (and every command it runs) can't see: the CLIs' state, which their own sandboxes keep from model commands (§6 "Codex rollout tampering", "Planted config"). */
const HIDDEN_FROM_HELPER: readonly CacheDir[] = ['codex-home', 'config'];
/** How long the helper has to answer a `CANCEL` before the relay ends it (and its commands). */
const HELPER_CANCEL_MS = 2_000;
/** Helpers in a row that may fail to start before the attach stops starting them. */
const HELPER_START_TRIES = 3;
/** Exit codes that mean the helper never ran: the shim's own failure (125: the cgroup or the mount), and bash's 126/127 (not executable, not found). */
const NOT_STARTED = new Set([125, 126, 127]);

const PING_MS = 5_000;
const SILENCE_MS = 15_000;
/** Pause a child's stdout (and a tail's reads) while `/ctl` holds more than this many unsent bytes; resume below the low mark. */
const HIGH_WATER = 4 << 20;
const LOW_WATER = 1 << 20;
/**
 * The HTTP status the CLI gets for each fixed `/model` error code (§5.4
 * adapter 5). A spend cap is 403, which Claude Code and Codex don't retry (a
 * turn out of money ends at once); only the concurrency cap (`busy`) is 429,
 * which they retry with backoff.
 */
const MODEL_STATUS: Record<string, number> = { bad_request: 400, forbidden: 403, budget: 403, busy: 429, upstream: 502, internal: 500 };
/** Model requests in flight at once (§5.5: concurrency 8 per session). */
const MODEL_INFLIGHT = 8;

/** Whether this process runs the privileged tier (root, with a `runAs` user). */
export function privileged(c: RelayConfig): boolean {
  return process.getuid?.() === 0 && !!c.runAs;
}

/** One armed capability (§5.4): single-use admission of exactly one `/ctl` and one `/model`. */
interface Armed {
  /** `sha256(T)`. */
  h: string;
  /** The nonce the relay minted for the hello proof. */
  r: string;
  expires: number;
  gen: number;
  admits: Set<'ctl' | 'model'>;
  /** Armed with a fenced token: only then may this attach change the VM (§5.4). */
  mutable: boolean;
  /** `sha256(P)` of the CLI's model key, if the arm named one (§5.5). */
  model?: string;
}

/** One accepted socket and its liveness. */
interface Live {
  ws: WebSocket;
  kind: 'ctl' | 'model';
  gen: number;
  /** Last time any frame, ping or pong arrived. */
  lastSeen: number;
  pinger?: ReturnType<typeof setInterval>;
  /** Its arm's `mutable`: without it, no `SPAWN`, `FILES`, `WIPE` or mutating `ENV_CALL` is served (the driver refuses them first; this is the second gate). */
  mutable: boolean;
}

/** A child the session started: its group, and the `/ctl` socket it reports to. */
interface Child {
  id: number;
  proc: ChildProcess;
  pgid: number;
  owner: Live;
  stderrTail: Buffer[];
  stderrLen: number;
  /** The driver's word that the child's commands run in a pid namespace of their own, or that it runs none (`MachineSpawn.isolatedCommands`). */
  isolated: boolean;
}

/** A followed file. */
interface Tail {
  id: number;
  owner: Live;
  dir: CacheDir;
  full: string;
  fd?: number;
  ino?: number;
  dev?: number;
  offset: number;
  /** Bytes sent since the last newline (a line's length so far). */
  sinceNewline: number;
  timer: ReturnType<typeof setInterval>;
}

/** A `FILES` in progress: the tar it streams into. */
interface FilesOp {
  id: number;
  owner: Live;
  expected: number;
  received: number;
  tar?: ChildProcess;
  /** Chunks that arrived before `tar` started. */
  queue: Uint8Array[];
  ended: boolean;
  /** The outcome was sent. */
  answered: boolean;
  /** `tar`'s exit code, once it closed. */
  exit?: number | null;
}

/** One `ENV_CALL` from the driver: its input as it arrives, then the helper call it became. */
interface EnvCall {
  id: number;
  owner: Live;
  op: EnvOp;
  args: unknown[];
  /** The input's announced length, and what has arrived. */
  input: number;
  received: number;
  chunks: Uint8Array[];
  /** The helper and its call id, once sent to it. */
  helper?: HelperProc;
  hid?: number;
  /** Result bytes the helper sent so far. */
  streamed: number;
  /** A mutating op on an unfenced attach: its input is read and dropped, and it is answered `EPERM`. */
  refused?: boolean;
  /** The driver sent `CANCEL`: the helper's `RESULT` is still forwarded (it is the driver's proof the call stopped), its bytes are not. */
  cancelled?: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

/** The per-attach helper process (§5.4 "Privilege split", `helper.ts`). */
interface HelperProc {
  proc: ChildProcess;
  reader: HelperReader;
  calls: Map<number, EnvCall>;
  /** The relay's call ids it was given are below this. */
  nextId: number;
  paused: boolean;
  /** Ended as far as the relay is concerned: its frames are ignored, its calls answered. */
  dead: boolean;
  /** Its process exited. */
  exited: boolean;
  /** It sent at least one frame (so it started). */
  sent: boolean;
  /** The cgroup leaf it and its commands run in (privileged tier with cgroups), killed when it ends. */
  leaf?: string;
}

/** What a call answers when the helper went while it ran (a `KILL`, a crash, an OOM kill, a broken pipe rule): it may have half-run. */
const helperEnded = (killed: boolean) =>
  json({ ok: false, error: { code: 'EINTR', message: `the session helper ended while this call ran${killed ? ' (the commands it started were killed)' : ''}: it may have half-run` } });
const didNotRun = (code: string, why: string) => json({ ok: false, error: { code, message: `did not run: ${why}` } });

/** The persisted half of the fence (§5.2 `/run/dh/fence`). */
interface FenceRecord {
  highest: number;
  session?: string;
}

/** The running relay: its servers and the one session's live state. */
export class Relay {
  private armed: Armed | undefined;
  private record: FenceRecord = { highest: -1 };
  private gen = 0;
  private ctl: Live | undefined;
  private model: Live | undefined;
  /** The relay-side client over the current `/model` socket. */
  private modelClient: ReturnType<typeof requestOverWs> | undefined;
  private modelInflight = 0;
  /** The current attach's model key (`sha256(P)`), set when its `/model` socket is admitted: the model port's key check (§5.5). */
  private modelKey: string | undefined;
  /** Model-port connections already checked (the peer is looked up once per TCP connection): whether each is the CLI's. */
  private peers = new WeakMap<Socket, boolean>();
  private readonly children = new Map<number, Child>();
  private readonly tails = new Map<number, Tail>();
  private readonly filesOps = new Map<number, FilesOp>();
  private readonly paused = new Set<Child>();
  private drainTimer: ReturnType<typeof setInterval> | undefined;
  private readonly bootId = kernelBootId() ?? randomUUID();
  private readonly relayId = randomUUID();
  /** The session's cgroup2 leaf (privileged tier), or undefined (process groups). */
  private cgroup: string | undefined;
  /** The unprivileged user (privileged tier). */
  private agent: { uid: number; gid: number } | undefined;
  /** Whether the owner-match rule that refuses non-root uids on the platform's 127.0.0.1:23456 is in place (P0.20's fallback). */
  private platformGuard = false;
  private httpServer: Server | undefined;
  private modelServer: Server | undefined;
  private controlServer: NetServer | undefined;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frameBytes, perMessageDeflate: false });
  /** The current attach's helper, started on its first `ENV_CALL`. */
  private helper: HelperProc | undefined;
  /** In-flight `ENV_CALL`s, by the driver's id. */
  private readonly envCalls = new Map<number, EnvCall>();
  /** Helpers ended but not yet exited: no new helper starts (and no call is sent) until they have, so two never run at once. */
  private readonly retiring = new Set<HelperProc>();
  /** Calls held while a helper retires. */
  private heldEnv: EnvCall[] = [];
  /** Helpers in a row that never started, this attach. */
  private helperFailures = 0;
  /** The helper's cgroup leaf under the session's (privileged tier with cgroups). */
  private envCgroup: string | undefined;

  constructor(
    private readonly config: RelayConfig,
    /** `entryPath`: the bundle (or entry) the helper starts from; without one, `ENV_CALL` is refused. */
    private readonly options: { entryPath?: string } = {}
  ) {}

  /**
   * Start every server. The two TCP ports are bound first: they are the lock
   * that keeps a second relay out (a second `serve` fails to bind and exits
   * without touching the first one's control socket). Rejects on any failure.
   */
  async start(): Promise<void> {
    const root = process.getuid?.() === 0;
    if (root && !this.config.runAs) throw new Error('harness-sandbox: the relay refuses to run as root without runAs (model commands would run as root)');
    if (this.config.testHelperEntry !== undefined && !underTest()) throw new Error('harness-sandbox: testHelperEntry is for the stand-in only; refusing to start');
    mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.config.stateDir, 0o700);
    this.loadRecord();
    if (root && process.platform === 'linux') {
      try {
        writeFileSync('/proc/self/oom_score_adj', '-1000');
      } catch {}
    }
    if (privileged(this.config)) this.agent = resolveUser(this.config.runAs!);
    mkdirSync(this.config.cacheRoot, { recursive: true, mode: 0o755 });
    chmodSync(this.config.cacheRoot, 0o755);
    for (const dir of CACHE_DIRS) this.makeCacheDir(cacheDirPath(this.config, dir));
    mkdirSync(this.config.workspace, { recursive: true });
    // A Drive arrives `root:root 755` at its first mount (§5.2): give it to the agent then, never later (a later mount keeps the agent's).
    if (this.agent && lstatSync(this.config.workspace).uid === 0) lchownSync(this.config.workspace, this.agent.uid, this.agent.gid);
    if (this.config.cgroup && root) this.bootstrapCgroup();
    if (this.agent && process.platform === 'linux') this.unmaskProc();
    if (this.agent && process.platform === 'linux') this.restrictPtrace();
    if (this.agent && process.platform === 'linux') this.platformGuard = guardPlatformListener();
    await this.listenHttp();
    await this.listenModel();
    await this.listenControl();
  }

  /**
   * Lift the platform's `/dev/null` masks on `/proc/kcore` and `/proc/keys`
   * (P0.10, `procMasks`): with them in place no unprivileged user namespace
   * may mount a fresh `/proc`, so bwrap's `--proc` fails and Claude Code's own
   * sandbox can't start. Both files stay out of the agent's reach without the
   * masks (kcore is root's, keys are per user). Best effort: what is left
   * masked shows as a failed bwrap self-test, and the harness runs without
   * that sandbox, saying so.
   */
  private unmaskProc(): void {
    try {
      for (const mount of procMasks(readFileSync('/proc/self/mountinfo', 'utf8'))) spawnSync(systemBin('umount'), [mount], { cwd: '/', env: childProcessEnv({ PATH: SYSTEM_PATH }), stdio: 'ignore' });
    } catch {}
  }

  /**
   * Where the kernel has Yama, keep a process from tracing one it didn't
   * start (`ptrace_scope` at least 1): a command beside the CLI could
   * otherwise trace it, or take its model socket with `pidfd_getfd`, and
   * pass the model port's peer check. The VM's kernel measured none (P0.16):
   * there Claude Code's sandbox (a pid namespace of the commands' own) is
   * what keeps them from the CLI, and the harness refuses to run its
   * commands without it.
   */
  private restrictPtrace(): void {
    try {
      const path = '/proc/sys/kernel/yama/ptrace_scope';
      if (existsSync(path) && readFileSync(path, 'utf8').trim() === '0') writeFileSync(path, '1');
    } catch {}
  }

  /** Stop everything (tests, a clean shutdown). */
  async stop(): Promise<void> {
    this.relayLoss();
    clearInterval(this.drainTimer);
    for (const s of [this.httpServer, this.modelServer, this.controlServer]) s?.close();
  }

  /** The tier this relay runs, reported at arm. */
  private tier(): 'privileged' | 'degraded' {
    return this.agent ? 'privileged' : 'degraded';
  }

  // -- the fence record -------------------------------------------------------

  private recordPath(): string {
    return join(this.config.stateDir, 'fence.json');
  }

  private loadRecord(): void {
    const path = this.recordPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isObject(raw) || typeof raw.highest !== 'number' || !Number.isSafeInteger(raw.highest) || raw.highest < -1 || (raw.session !== undefined && typeof raw.session !== 'string')) {
      throw new Error(`harness-sandbox: the fence record ${path} is corrupt; refusing to start`);
    }
    this.record = { highest: raw.highest, ...(raw.session !== undefined ? { session: raw.session } : {}) };
  }

  /** Write the record atomically (temp file, fsync, rename), 0600. */
  private saveRecord(): void {
    const path = this.recordPath();
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(this.record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  // -- the control (arm) socket -----------------------------------------------

  private async listenControl(): Promise<void> {
    const sockPath = join(this.config.stateDir, 'control.sock');
    if (existsSync(sockPath)) {
      // Another relay answering on it keeps it; only a dead socket file is replaced.
      if (await answers(sockPath)) throw new Error('harness-sandbox: another relay answers on the control socket');
      rmSync(sockPath, { force: true });
    }
    await new Promise<void>((resolveListen, reject) => {
      this.controlServer = createNetServer((sock: Socket) => {
        sock.on('error', () => {});
        const rl = createInterface({ input: sock });
        rl.on('error', () => {});
        rl.once('line', (line) => {
          let reply: ArmReply;
          try {
            reply = this.arm(JSON.parse(line) as unknown);
          } catch (err) {
            reply = { ok: false, code: 'internal', error: String((err as Error)?.message ?? err) };
          }
          sock.end(`${JSON.stringify(reply)}\n`);
        });
      });
      this.controlServer.once('error', reject);
      this.controlServer.listen(sockPath, () => {
        this.controlServer!.off('error', reject);
        this.controlServer!.on('error', () => {});
        resolveListen();
      });
    });
    chmodSync(sockPath, 0o600);
  }

  /**
   * Apply an arm request (§5.4 fence table): check it, check the ports are
   * still this relay's, apply the fence, persist it, mint the nonce, and
   * record the armed capability.
   *
   * | Arm with | Does |
   * |---|---|
   * | `fence` lower than the recorded one | `stale` |
   * | `fence` higher, `fenced: true` | supersede: kill the session tree, close the old sockets with 4409, record, admit |
   * | anything else (same fence, `fenced: false`, no token) while the old sockets answer, or another unexpired arm is pending | `contended` (never preempts) |
   * | the same, with the old sockets dead | admit; kill the old session tree; record a higher fence |
   *
   * A re-arm with the same `sha256` (the driver retrying a failed upgrade with
   * the same `T`) replaces its own pending arm rather than contending with it.
   */
  arm(input: unknown): ArmReply {
    const req = checkArmRequest(input);
    if (typeof req === 'string') return { ok: false, code: 'bad_request', error: req };
    if (this.record.session !== undefined && req.session !== this.record.session) return { ok: false, code: 'session', error: 'this VM is armed for another session' };
    const listener = listenerCheck([this.config.port, this.config.modelPort]);
    if (listener) return { ok: false, code: 'listener', error: listener };
    const now = Date.now();
    const fence = req.fence;
    if (fence !== undefined && fence < this.record.highest) return { ok: false, code: 'stale', error: `fence ${fence} < ${this.record.highest}` };
    const pendingOther = !!this.armed && now < this.armed.expires && this.armed.admits.size > 0 && this.armed.h !== req.sha256;
    if (fence !== undefined && req.fenced && fence > this.record.highest) {
      // A newer owner: kill the old CLI, close its sockets with 4409, take over.
      this.supersede();
    } else {
      // Never preempt: admit only once the old attach is gone.
      if (this.alive(this.ctl) || this.alive(this.model) || pendingOther) return { ok: false, code: 'contended', error: 'the current attach is still answering' };
      this.relayLoss();
    }
    if (fence !== undefined && fence > this.record.highest) this.record.highest = fence;
    this.record.session = req.session;
    this.saveRecord();
    const r = mintNonce();
    this.armed = { h: req.sha256, r, expires: now + (this.config.armTtlMs ?? 30_000), gen: ++this.gen, admits: new Set(['ctl', 'model']), mutable: fence !== undefined && req.fenced === true, ...(req.model ? { model: req.model } : {}) };
    return {
      ok: true,
      R: r,
      bootId: this.bootId,
      relayId: this.relayId,
      sessionId: this.record.session,
      relayVersion: this.config.relayVersion,
      cliVersions: this.config.cliVersions ?? {},
      tier: this.tier(),
      cgroup: !!this.cgroup,
      platformGuard: this.platformGuard,
      // The model port admits only this attach's key, from a process it spawned: both checks need the key in the arm and /proc to tell processes apart.
      modelAuth: !!req.model && canCheckPeers(),
    };
  }

  private alive(live: Live | undefined): boolean {
    return !!live && live.ws.readyState === live.ws.OPEN && Date.now() - live.lastSeen < SILENCE_MS;
  }

  private isCurrent(live: Live): boolean {
    return live === this.ctl || live === this.model;
  }

  /** A higher fence arrived: kill the session tree and close the old sockets with 4409. */
  private supersede(): void {
    this.endAttach(CLOSE.superseded);
  }

  /** A current socket was lost (closed, silent, a violation), or an arm replaces a dead attach: kill the session tree, retire both sockets, idle. */
  private relayLoss(): void {
    this.endAttach();
  }

  private endAttach(closeCode?: number): void {
    for (const live of [this.ctl, this.model]) if (live) retire(live, closeCode);
    this.ctl = this.model = undefined;
    this.modelClient?.close();
    this.modelClient = undefined;
    this.modelKey = undefined;
    this.peers = new WeakMap();
    this.armed = undefined;
    for (const tail of [...this.tails.values()]) this.stopTail(tail);
    for (const op of this.filesOps.values()) op.tar?.kill('SIGKILL');
    this.filesOps.clear();
    this.paused.clear();
    for (const call of this.envCalls.values()) clearTimeout(call.cancelTimer);
    this.envCalls.clear();
    this.heldEnv = [];
    this.helperFailures = 0;
    this.killSession('SIGKILL');
    // The helper is per attach: the next attach starts its own.
    this.stopHelper();
  }

  // -- the control-plane WS (/ctl, /model) ------------------------------------

  private listenHttp(): Promise<void> {
    this.httpServer = createHttpServer((_req, res) => {
      // No unauthenticated route, no /health (§5.4): everything is 404.
      res.writeHead(404).end();
    });
    this.httpServer.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket as Socket, head));
    return listen(this.httpServer, this.config.port);
  }

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => {});
    const reject = (code: number) => {
      socket.write(`HTTP/1.1 ${code} ${code === 404 ? 'Not Found' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = req.url ?? '';
    const kind: 'ctl' | 'model' | undefined = url === '/ctl' ? 'ctl' : url === '/model' ? 'model' : undefined;
    if (!kind) return reject(404);
    if (req.headers.origin !== undefined) return reject(404); // no browser: no Origin header
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const armed = this.armed;
    if (!bearer || !armed || Date.now() > armed.expires || !armed.admits.has(kind)) return reject(401);
    if (!constantTimeEqualHex(tokenHash(bearer), armed.h)) return reject(401);
    armed.admits.delete(kind);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // An arm in between replaced this one: the socket belongs to no attach.
      if (this.armed !== armed) return ws.terminate();
      this.onSocket(ws, kind, bearer, armed);
    });
  }

  private onSocket(ws: WebSocket, kind: 'ctl' | 'model', token: string, armed: Armed): void {
    const live: Live = { ws, kind, gen: armed.gen, lastSeen: Date.now(), mutable: armed.mutable };
    if (kind === 'ctl') this.ctl = live;
    else {
      this.model = live;
      this.modelKey = armed.model;
      this.peers = new WeakMap();
      this.modelClient = requestOverWs(ws as unknown as WsLike, { headTimeoutMs: 120_000 });
    }
    // `/ctl` stays `nodebuffer` (a Buffer per message, as `onCtl` reads);
    // `/model`'s `requestOverWs` sets its own `arraybuffer`.
    ws.on('error', () => {});
    // The hello proof, the relay's first frame on each socket.
    ws.send(frame(CTL.HELLO, 0, json({ hmac: helloProof(token, armed.r) })));
    const seen = () => {
      if (this.isCurrent(live)) live.lastSeen = Date.now();
    };
    ws.on('pong', seen);
    ws.on('ping', seen);
    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (!this.isCurrent(live)) return;
      live.lastSeen = Date.now();
      if (kind === 'ctl') this.onCtl(live, data, isBinary);
      // /model frames are read by this.modelClient's own listener.
    });
    ws.on('close', () => this.onSocketLost(live));
    live.pinger = setInterval(() => {
      if (!this.isCurrent(live)) return clearInterval(live.pinger);
      if (Date.now() - live.lastSeen > SILENCE_MS) return this.onSocketLost(live);
      try {
        ws.ping();
      } catch {
        this.onSocketLost(live);
      }
    }, PING_MS);
  }

  /** A socket closed, went silent or broke the protocol. Only a current one is relay loss (§5.4): kill the session tree, retire both. */
  private onSocketLost(live: Live): void {
    clearInterval(live.pinger);
    if (!this.isCurrent(live)) {
      retire(live);
      return;
    }
    this.relayLoss();
  }

  /** Send on `owner`, only while it is the current `/ctl`. */
  private send(owner: Live, bytes: Uint8Array): boolean {
    if (owner !== this.ctl || owner.ws.readyState !== owner.ws.OPEN) return false;
    owner.ws.send(bytes);
    return true;
  }

  private pressure(owner: Live): boolean {
    return owner === this.ctl && owner.ws.bufferedAmount > HIGH_WATER;
  }

  // -- /ctl frames ------------------------------------------------------------

  private onCtl(live: Live, data: unknown, isBinary: boolean): void {
    try {
      if (!isBinary) throw new ProtocolError('a text frame on /ctl');
      const f = decodeCtl(data);
      if (!f) throw new ProtocolError('a short or oversized /ctl frame');
      this.onCtlFrame(live, f.type, f.id, f.payload);
    } catch {
      // A violation (or a bug): the socket is done, and with it the session.
      this.onSocketLost(live);
    }
  }

  private onCtlFrame(live: Live, type: number, id: number, payload: Uint8Array): void {
    switch (type) {
      case CTL.SPAWN: {
        if (this.children.has(id)) throw new ProtocolError(`a second spawn for id ${id}`);
        const spec = checkSpawnSpec(parse(payload));
        if (!live.mutable) return void this.send(live, frame(CTL.SPAWN_ACK, id, json({ error: UNFENCED })));
        return this.onSpawn(live, id, spec);
      }
      case CTL.STDIN: {
        const child = this.children.get(id);
        if (child?.owner === live) child.proc.stdin?.write(Buffer.from(payload));
        return;
      }
      case CTL.STDIN_END: {
        const child = this.children.get(id);
        if (child?.owner === live) child.proc.stdin?.end();
        return;
      }
      case CTL.KILL: {
        const p = parse(payload);
        const signal = isObject(p) && p.signal !== undefined ? p.signal : 'SIGTERM';
        if (typeof signal !== 'string' || !KILL_SIGNALS.has(signal)) throw new ProtocolError('a KILL with an unknown signal');
        return this.killSession(signal as NodeJS.Signals);
      }
      case CTL.FILES:
        return this.onFiles(live, id, parse(payload));
      case CTL.FILES_CHUNK:
        return this.onFilesChunk(live, id, payload);
      case CTL.FILES_END:
        return this.onFilesEnd(live, id);
      case CTL.WIPE:
        if (!live.mutable) return this.result(live, id, false, UNFENCED);
        return void this.onWipe(live, id);
      case CTL.FSYNC:
        return this.onFsync(live, id);
      case CTL.TAIL:
        return this.onTail(live, id, parse(payload));
      case CTL.SYNC:
        return this.onSync(live, id, parse(payload));
      case CTL.CANCEL: {
        const tail = this.tails.get(id);
        if (tail?.owner === live) this.stopTail(tail);
        const call = this.envCalls.get(id);
        if (call?.owner === live) this.cancelEnv(call);
        return;
      }
      case CTL.ENV_CALL:
        return this.onEnvCall(live, id, parse(payload));
      case CTL.ENV_DATA:
        return this.onEnvData(live, id, payload);
      default:
        throw new ProtocolError(`an unknown /ctl frame type ${type}`);
    }
  }

  private onSpawn(owner: Live, id: number, spec: SpawnSpec): void {
    const env = this.childEnv(spec.env);
    const cwd = spec.cwd ?? this.config.workspace;
    let proc: ChildProcess;
    try {
      proc = this.agent
        ? spawn(systemBin('bash'), this.shimArgs(spec.command, spec.args, env, cwd), { cwd: '/', env: childProcessEnv({ PATH: SYSTEM_PATH }), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(spec.command, spec.args, { cwd, env: childProcessEnv(env), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.send(owner, frame(CTL.SPAWN_ACK, id, json({ error: String((err as Error)?.message ?? err) })));
      return;
    }
    const child: Child = { id, proc, pgid: proc.pid ?? -1, owner, stderrTail: [], stderrLen: 0, isolated: spec.isolatedCommands === true };
    this.children.set(id, child);
    let acked = false;
    let failed = false;
    proc.on('spawn', () => {
      child.pgid = proc.pid ?? -1;
      acked = true;
      this.send(owner, frame(CTL.SPAWN_ACK, id, json({ pid: proc.pid })));
    });
    proc.stdin?.on('error', () => {});
    proc.stdout?.on('data', (d: Buffer) => {
      for (let at = 0; at < d.length; at += LIMITS.chunkBytes) this.send(owner, frame(CTL.STDOUT, id, d.subarray(at, Math.min(d.length, at + LIMITS.chunkBytes))));
      if (this.pressure(owner)) this.pause(child);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      child.stderrTail.push(d);
      child.stderrLen += d.length;
      while (child.stderrLen > 8192 && child.stderrTail.length > 1) child.stderrLen -= child.stderrTail.shift()!.length;
      for (let at = 0; at < d.length; at += LIMITS.chunkBytes) this.send(owner, frame(CTL.STDERR, id, d.subarray(at, Math.min(d.length, at + LIMITS.chunkBytes))));
      if (this.pressure(owner)) this.pause(child);
    });
    proc.on('error', (err) => {
      if (acked) return;
      failed = true;
      this.children.delete(id);
      this.send(owner, frame(CTL.SPAWN_ACK, id, json({ error: String(err?.message ?? err) })));
    });
    // EXIT on 'close', not 'exit': every stdout byte is sent before it.
    proc.on('close', (code, signal) => {
      this.children.delete(id);
      this.paused.delete(child);
      if (failed || !acked) return;
      this.send(owner, frame(CTL.EXIT, id, json({ code, signal, stderrTail: Buffer.concat(child.stderrTail).toString('utf8').slice(-8192) })));
    });
  }

  /** Stop reading a child's output until `/ctl` drains (`bufferedAmount` watermarks, §5.4). */
  private pause(child: Child): void {
    if (this.paused.has(child)) return;
    child.proc.stdout?.pause();
    child.proc.stderr?.pause();
    this.paused.add(child);
    this.watchDrain();
  }

  /** Poll `/ctl`'s send buffer until every paused reader can read again. */
  private watchDrain(): void {
    this.drainTimer ??= setInterval(() => {
      for (const c of this.paused) {
        if (c.owner === this.ctl && c.owner.ws.bufferedAmount > LOW_WATER) continue;
        c.proc.stdout?.resume();
        c.proc.stderr?.resume();
        this.paused.delete(c);
      }
      for (const t of this.tails.values()) if (!this.pressure(t.owner)) this.pollTail(t);
      const h = this.helper;
      if (h?.paused && !(this.ctl && this.ctl.ws.bufferedAmount > LOW_WATER)) {
        h.paused = false;
        h.proc.stdout?.resume();
      }
      if (this.paused.size === 0 && !this.helper?.paused) {
        clearInterval(this.drainTimer);
        this.drainTimer = undefined;
      }
    }, 50);
  }

  /**
   * The privileged spawn (§5.4): a root bash shim with a fixed PATH and no
   * other env, at `/`, that writes its own pid into the session cgroup before
   * anything runs (so a setsid'd grandchild inherits the leaf, and
   * `cgroup.kill` reaches it), fails closed if it can't, then execs `setpriv`
   * down to the agent and `env -i` with the child's env, in its cwd. Nothing
   * the driver sent is seen by a root process except as argv.
   */
  private shimArgs(command: string, args: readonly string[], env: Record<string, string>, cwd: string, options: { cgroup?: string; hide?: readonly string[] } = {}): string[] {
    const script = 'CG="$1"; shift; if [ -n "$CG" ]; then echo $$ > "$CG/cgroup.procs" || exit 125; fi; exec "$@"';
    // The helper's own mount namespace: each dir in `hide` under an empty read-only tmpfs, still as root, before the drop.
    const hide = 'MOUNT="$1"; N="$2"; shift 2; while [ "$N" -gt 0 ]; do "$MOUNT" -t tmpfs -o ro,nosuid,nodev,noexec,size=4k,mode=0555 dh-hidden "$1" || exit 125; shift; N=$((N-1)); done; exec "$@"';
    const { uid, gid } = this.agent!;
    return [
      '-c',
      script,
      'dh-spawn',
      options.cgroup ?? this.cgroup ?? '',
      ...(options.hide?.length
        ? [systemBin('unshare'), '--mount', '--propagation', 'private', '--', systemBin('bash'), '-c', hide, 'dh-hide', systemBin('mount'), String(options.hide.length), ...options.hide]
        : []),
      systemBin('setpriv'),
      '--reuid',
      String(uid),
      '--regid',
      String(gid),
      '--clear-groups',
      '--inh-caps=-all',
      '--no-new-privs',
      systemBin('env'),
      '-i',
      '-C',
      cwd,
      '--',
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      command,
      ...args,
    ];
  }

  /**
   * Set up a cgroup2 session leaf (P0.19): move every process out of the root
   * cgroup into `/init`, enable the controllers at the root, then make the
   * session leaf. Idempotent (a re-arm on a warm VM finds it done). A leaf a
   * previous relay left processes in is killed: their sockets died with it.
   * Best effort: a failure leaves `this.cgroup` undefined (process-group kill),
   * and the arm reply says so (`cgroup: false`).
   */
  private bootstrapCgroup(): void {
    try {
      const init = join(CGROUP_FS, 'init');
      mkdirSync(init, { recursive: true });
      for (let i = 0; i < 100; i++) {
        const pids = readFileSync(join(CGROUP_FS, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean);
        if (pids.length === 0) break;
        for (const pid of pids) {
          try {
            writeFileSync(join(init, 'cgroup.procs'), pid);
          } catch {}
        }
      }
      try {
        writeFileSync(join(CGROUP_FS, 'cgroup.subtree_control'), '+memory +pids +cpu +io');
      } catch {}
      const leaf = join(CGROUP_FS, 'dh-session');
      mkdirSync(leaf, { recursive: true });
      // Whatever a previous relay left in it (or in its helper's leaf) goes: their sockets died with it.
      writeFileSync(join(leaf, 'cgroup.kill'), '1');
      this.cgroup = leaf;
    } catch {
      this.cgroup = undefined;
      return;
    }
    // The helper's leaf, under the session's (no controller is enabled in the session's subtree, so both may hold processes):
    // the session's `cgroup.kill` reaches it, and the helper's end kills it alone.
    try {
      const env = join(this.cgroup, 'env');
      mkdirSync(env, { recursive: true });
      this.envCgroup = env;
    } catch {
      this.envCgroup = undefined;
    }
  }

  /** The child's environment: a fixed base plus the `env` the driver sent (checked there, and by name here). Nothing of the relay's own environment leaks, except PATH in the degraded tier. */
  private childEnv(extra: Record<string, string>): Record<string, string> {
    return {
      PATH: this.agent ? SYSTEM_PATH : (process.env.PATH ?? SYSTEM_PATH),
      HOME: cacheDirPath(this.config, 'home'),
      TMPDIR: cacheDirPath(this.config, 'tmp'),
      ...extra,
    };
  }

  /**
   * Kill the session's processes (`KILL`, a loss, a supersede). With a cgroup:
   * `SIGKILL` is `cgroup.kill`; another signal goes to every pid in the leaf.
   * Then every child's process group. A child leaves `children` only when it
   * has closed, so one that ignores `SIGTERM` is still killed by a later kill.
   */
  killSession(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.cgroup) {
      try {
        if (signal === 'SIGKILL') writeFileSync(join(this.cgroup, 'cgroup.kill'), '1');
        else
          for (const cg of [this.cgroup, this.envCgroup]) {
            if (!cg) continue;
            for (const pid of readFileSync(join(cg, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean)) {
              try {
                process.kill(Number(pid), signal);
              } catch {}
            }
          }
      } catch {}
    }
    for (const child of this.children.values()) {
      try {
        if (child.pgid > 0) process.kill(-child.pgid, signal);
      } catch {
        try {
          child.proc.kill(signal);
        } catch {}
      }
    }
    // The helper's commands are process groups of its own: it kills them as it exits (with a cgroup, they are in the leaf too).
    const h = this.helper;
    if (h && !h.dead && !this.cgroup) {
      try {
        h.proc.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        if (!h.dead) h.proc.kill('SIGKILL');
      }, 1_000).unref();
    }
  }

  // -- files, wipe, fsync, tails ----------------------------------------------

  private result(owner: Live, id: number, ok: boolean, error?: string): void {
    this.send(owner, frame(CTL.RESULT, id, json({ ok, ...(error ? { error: error.slice(0, 500) } : {}) })));
  }

  /** A cache dir: root 0755 parent, the dir itself 0700 and the agent's (privileged) or this uid's. */
  private makeCacheDir(p: string): void {
    mkdirSync(p, { recursive: true, mode: 0o700 });
    if (this.agent) chownSync(p, this.agent.uid, this.agent.gid);
    chmodSync(p, 0o700);
  }

  /** Delete a cache dir and make it again, empty. On Linux with GNU `rm -rf --one-file-system` (race-safe against a symlink swap, and never across a mount). */
  private async wipeDir(p: string): Promise<void> {
    if (process.platform === 'linux') {
      const code = await new Promise<number | null>((res) => {
        const rm = spawn(systemBin('rm'), ['-rf', '--one-file-system', '--', p], { cwd: '/', env: childProcessEnv({ PATH: SYSTEM_PATH }), stdio: 'ignore' });
        rm.on('error', () => res(-1));
        rm.on('close', (c) => res(c));
      });
      if (code !== 0) throw new Error(`rm exited ${code}`);
    } else rmSync(p, { recursive: true, force: true });
    this.makeCacheDir(p);
  }

  private onFiles(owner: Live, id: number, header: unknown): void {
    if (this.filesOps.has(id)) throw new ProtocolError(`a second FILES for id ${id}`);
    if (!isObject(header) || !isCacheDir(header.dir) || !isCount(header.bytes) || header.bytes > LIMITS.filesBytes) throw new ProtocolError('a malformed FILES');
    const op: FilesOp = { id, owner, expected: header.bytes, received: 0, queue: [], ended: false, answered: false };
    this.filesOps.set(id, op);
    if (!owner.mutable) {
      // Refused: its chunks are read and dropped, and its end forgets it.
      op.answered = true;
      op.exit = -1;
      return this.result(owner, id, false, UNFENCED);
    }
    // A helper sees a cache dir as it was when the helper started (its mount namespace hides two of them): one that is replaced ends it.
    if (HIDDEN_FROM_HELPER.includes(header.dir) && this.helper) this.endHelper(this.helper, 'kill');
    const dir = cacheDirPath(this.config, header.dir);
    // Read no more of /ctl until the dir is wiped and tar is up (chunks already parsed wait in `queue`).
    owner.ws.pause();
    const fail = (error: string) => {
      if (op.answered) return;
      op.answered = true;
      op.tar?.kill('SIGKILL');
      this.result(owner, id, false, error);
    };
    void this.wipeDir(dir).then(
      () => {
        if (this.filesOps.get(id) !== op || op.answered) return void owner.ws.resume();
        const tar = this.agent
          ? spawn(systemBin('setpriv'), ['--reuid', String(this.agent.uid), '--regid', String(this.agent.gid), '--clear-groups', '--inh-caps=-all', '--no-new-privs', systemBin('tar'), ...tarArgs(dir)], { cwd: '/', env: childProcessEnv({ PATH: SYSTEM_PATH }), stdio: ['pipe', 'ignore', 'pipe'] })
          : spawn('tar', tarArgs(dir), { cwd: dir, env: childProcessEnv({ PATH: process.env.PATH ?? SYSTEM_PATH }), stdio: ['pipe', 'ignore', 'pipe'] });
        op.tar = tar;
        let err = '';
        tar.stderr?.on('data', (d) => (err = (err + d).slice(-400)));
        tar.stdin?.on('error', () => {});
        tar.on('error', (e) => {
          op.exit ??= -1;
          fail(`tar: ${e.message}`);
        });
        tar.on('close', (code) => {
          // A last write that filled the pipe gets no 'drain' once tar is gone: read /ctl again.
          owner.ws.resume();
          op.exit = code;
          if (op.ended) this.finishFiles(op, err);
          else if (code !== 0) fail(`tar exited ${code}: ${err}`);
        });
        for (const c of op.queue.splice(0)) tar.stdin?.write(c);
        if (op.ended) tar.stdin?.end();
        owner.ws.resume();
      },
      (e: Error) => {
        op.exit = -1;
        fail(`wipe: ${e.message}`);
        if (op.ended) this.finishFiles(op, '');
        owner.ws.resume();
      }
    );
  }

  private onFilesChunk(owner: Live, id: number, payload: Uint8Array): void {
    const op = this.filesOps.get(id);
    if (!op || op.owner !== owner || op.ended) throw new ProtocolError(`a FILES chunk for no open FILES (${id})`);
    op.received += payload.length;
    if (op.received > op.expected) throw new ProtocolError('a FILES tar longer than it announced');
    if (op.answered) return;
    const bytes = Buffer.from(payload);
    if (!op.tar) op.queue.push(bytes);
    else if (op.tar.stdin && !op.tar.stdin.write(bytes)) {
      // Backpressure: stop reading /ctl until tar takes it.
      owner.ws.pause();
      op.tar.stdin.once('drain', () => owner.ws.resume());
    }
  }

  private onFilesEnd(owner: Live, id: number): void {
    const op = this.filesOps.get(id);
    if (!op || op.owner !== owner || op.ended) throw new ProtocolError(`a FILES end for no open FILES (${id})`);
    op.ended = true;
    if (op.received !== op.expected) throw new ProtocolError('a FILES tar shorter than it announced');
    if (op.exit !== undefined || op.answered) this.finishFiles(op, '');
    else op.tar?.stdin?.end();
  }

  /** The tar is complete and `tar` has exited (or the op already failed): answer once, and forget it. */
  private finishFiles(op: FilesOp, err: string): void {
    this.filesOps.delete(op.id);
    if (op.answered) return;
    op.answered = true;
    if (op.exit === 0) this.result(op.owner, op.id, true);
    else this.result(op.owner, op.id, false, `tar exited ${op.exit}: ${err}`);
  }

  private async onWipe(owner: Live, id: number): Promise<void> {
    // As for `FILES`: the dirs a running helper hides are about to be replaced.
    if (this.helper) this.endHelper(this.helper, 'kill');
    try {
      for (const dir of CACHE_DIRS) await this.wipeDir(cacheDirPath(this.config, dir));
      this.result(owner, id, true);
    } catch (err) {
      this.result(owner, id, false, String((err as Error)?.message ?? err));
    }
  }

  private onFsync(owner: Live, id: number): void {
    // `sync -f <workspace>` on Linux; plain `sync` elsewhere (degraded).
    const args = process.platform === 'linux' ? ['-f', this.config.workspace] : [];
    const p = spawn(process.platform === 'linux' ? systemBin('sync') : 'sync', args, { stdio: 'ignore' });
    p.on('error', (e) => this.result(owner, id, false, `sync: ${e.message}`));
    p.on('close', (code, signal) => (code === 0 ? this.result(owner, id, true) : this.result(owner, id, false, `sync exited ${code ?? signal}`)));
  }

  private onTail(owner: Live, id: number, spec: unknown): void {
    if (this.tails.has(id)) throw new ProtocolError(`a second TAIL for id ${id}`);
    if (!isObject(spec) || !isCacheDir(spec.dir) || typeof spec.path !== 'string' || !isCount(spec.offset)) throw new ProtocolError('a malformed TAIL');
    const path = spec.path;
    if (path.length === 0 || path.length > 1024 || isAbsolute(path) || path.includes('\0') || path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      this.send(owner, frame(CTL.TAIL_ERROR, id, json({ error: 'a tail path must be relative and within its dir' })));
      return;
    }
    const tail: Tail = { id, owner, dir: spec.dir, full: join(cacheDirPath(this.config, spec.dir), path), offset: spec.offset, sinceNewline: 0, timer: undefined! };
    tail.timer = setInterval(() => {
      if (!this.pressure(owner)) this.pollTail(tail);
    }, 100);
    this.tails.set(id, tail);
  }

  /** Read what the file holds past the offset, in chunks, until EOF (or `/ctl` backs up, unless `toEof`). False once the tail failed. */
  private pollTail(tail: Tail, toEof = false): boolean {
    if (this.tails.get(tail.id) !== tail) return false;
    try {
      if (tail.fd === undefined) {
        let fd: number;
        try {
          fd = openSync(tail.full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return true; // not there yet
          throw new Error(code === 'ELOOP' ? 'the tailed path is a symlink' : `open: ${code}`);
        }
        tail.fd = fd;
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error('the tailed path is not a regular file');
        if (this.agent && st.uid !== this.agent.uid) throw new Error("the tailed file is not the session user's");
        const opened = process.platform === 'linux' ? readlinkSync(`/proc/self/fd/${fd}`) : realpathSync(tail.full);
        const dir = realpathSync(cacheDirPath(this.config, tail.dir));
        if (!opened.startsWith(dir + sep)) throw new Error('the tailed file is outside its dir');
        tail.ino = st.ino;
        tail.dev = st.dev;
      }
      let now: ReturnType<typeof lstatSync>;
      try {
        now = lstatSync(tail.full);
      } catch {
        throw new Error('the tailed file was removed or replaced');
      }
      if (now.ino !== tail.ino || now.dev !== tail.dev) throw new Error('the tailed file was replaced');
      const size = fstatSync(tail.fd).size;
      if (size < tail.offset) throw new Error('the tailed file shrank');
      while (tail.offset < size && (toEof || !this.pressure(tail.owner))) {
        const buf = Buffer.alloc(Math.min(LIMITS.chunkBytes, size - tail.offset));
        const got = readSync(tail.fd, buf, 0, buf.length, tail.offset);
        if (got <= 0) break;
        const bytes = buf.subarray(0, got);
        const nl = bytes.lastIndexOf(0x0a);
        tail.sinceNewline = nl < 0 ? tail.sinceNewline + got : got - nl - 1;
        if (tail.sinceNewline > LIMITS.lineBytes) throw new Error('a line over 16 MiB');
        tail.offset += got;
        this.send(tail.owner, frame(CTL.TAIL_DATA, tail.id, pack({ offset: tail.offset }, bytes)));
      }
      return true;
    } catch (err) {
      this.send(tail.owner, frame(CTL.TAIL_ERROR, tail.id, json({ error: String((err as Error)?.message ?? err) })));
      this.stopTail(tail);
      return false;
    }
  }

  private stopTail(tail: Tail): void {
    clearInterval(tail.timer);
    if (tail.fd !== undefined) {
      try {
        closeSync(tail.fd);
      } catch {}
      tail.fd = undefined;
    }
    if (this.tails.get(tail.id) === tail) this.tails.delete(tail.id);
  }

  private onSync(owner: Live, id: number, spec: unknown): void {
    if (!isObject(spec) || !isCount(spec.tail)) throw new ProtocolError('a malformed SYNC');
    const tail = this.tails.get(spec.tail);
    if (!tail || tail.owner !== owner) return this.result(owner, id, false, 'no such tail');
    // Drain to EOF now: every byte the file holds is sent before the RESULT.
    if (this.pollTail(tail, true)) this.result(owner, id, true);
    else this.result(owner, id, false, 'the tail failed');
  }

  // -- ENV_CALL: the workspace, through the helper ----------------------------

  private onEnvCall(owner: Live, id: number, raw: unknown): void {
    if (this.envCalls.has(id)) throw new ProtocolError(`a second ENV_CALL for id ${id}`);
    if (!isObject(raw) || !isEnvOp(raw.op) || !Array.isArray(raw.args) || !isCount(raw.input) || raw.input > LIMITS.envBytes) throw new ProtocolError('a malformed ENV_CALL');
    const call: EnvCall = { id, owner, op: raw.op, args: raw.args, input: raw.input, received: 0, chunks: [], streamed: 0, ...(MUTATING_ENV_OPS.has(raw.op) && !owner.mutable ? { refused: true } : {}) };
    this.envCalls.set(id, call);
    if (call.input === 0) this.dispatchEnv(call);
  }

  private onEnvData(owner: Live, id: number, payload: Uint8Array): void {
    const call = this.envCalls.get(id);
    if (!call || call.owner !== owner || call.received >= call.input) throw new ProtocolError(`ENV_DATA for no ENV_CALL awaiting input (${id})`);
    call.received += payload.length;
    if (call.received > call.input) throw new ProtocolError('ENV_DATA longer than the call announced');
    if (!call.refused) call.chunks.push(payload.slice());
    if (call.received === call.input) this.dispatchEnv(call);
  }

  /** Answer a call the helper never got, and forget it. */
  private answerEnv(call: EnvCall, payload: Uint8Array): void {
    if (this.envCalls.get(call.id) !== call) return;
    this.envCalls.delete(call.id);
    clearTimeout(call.cancelTimer);
    this.send(call.owner, frame(CTL.ENV_RESULT, call.id, payload));
  }

  /** Hand a complete call to the helper (started if it isn't running), unless it is refused, or held while an old helper retires. */
  private dispatchEnv(call: EnvCall): void {
    if (call.refused) return this.answerEnv(call, didNotRun('EPERM', `${call.op} refused: this attach holds no fenced token (docs/workspaces.md §5.4)`));
    if (this.retiring.size) return void this.heldEnv.push(call);
    if (this.helperFailures >= HELPER_START_TRIES) return this.answerEnv(call, didNotRun('EIO', 'the session helper failed to start, again and again (this attach starts no more)'));
    const helper = this.ensureHelper();
    if (!helper) return this.answerEnv(call, didNotRun('EIO', 'the session helper could not start'));
    const hid = helper.nextId++;
    call.helper = helper;
    call.hid = hid;
    helper.calls.set(hid, call);
    const input = call.chunks.length === 1 ? call.chunks[0]! : Buffer.concat(call.chunks);
    call.chunks = [];
    helper.proc.stdin?.write(helperFrame(HELPER.CALL, hid, pack({ op: call.op, args: call.args }, input)));
  }

  /**
   * The driver gave up on a call (its signal, a timeout). A call the helper
   * hasn't got is answered at once ("did not run"). Otherwise the helper stops
   * it (a command's group is killed, and its `RESULT` comes only once the group
   * is gone), and that `RESULT` is forwarded: the driver waits for it before
   * it records the call as stopped. A helper that doesn't answer within
   * `HELPER_CANCEL_MS` (stopped, wedged) is ended with its commands.
   */
  private cancelEnv(call: EnvCall): void {
    if (call.cancelled) return;
    call.cancelled = true;
    const h = call.helper;
    if (!h || call.hid === undefined || h.calls.get(call.hid) !== call) {
      this.heldEnv = this.heldEnv.filter((c) => c !== call);
      return this.answerEnv(call, didNotRun('EINTR', 'its call was cancelled before it started'));
    }
    h.proc.stdin?.write(helperFrame(HELPER.CANCEL, call.hid));
    call.cancelTimer = setTimeout(() => {
      if (h.calls.get(call.hid!) === call) this.endHelper(h, 'kill');
    }, HELPER_CANCEL_MS);
    call.cancelTimer.unref?.();
  }

  /**
   * The helper, started if this attach has none (or it ended): in the
   * privileged tier through the root shim (into the helper's cgroup leaf, into
   * a mount namespace that hides `HIDDEN_FROM_HELPER`, then down to the
   * unprivileged user with `env -i` and the allowlist), in the degraded tier as
   * this uid with the same env. Its stdout is read as untrusted: bounded
   * frames, known ids, results checked and rebuilt; anything else ends it.
   */
  private ensureHelper(): HelperProc | undefined {
    if (this.helper && !this.helper.dead) return this.helper;
    const test = this.config.testHelperEntry;
    const entry = test ?? this.options.entryPath;
    if (!entry) return undefined;
    const env = this.childEnv({});
    const args = test ? [entry] : [entry, 'helper'];
    const leaf = this.agent ? (this.envCgroup ?? this.cgroup) : undefined;
    let proc: ChildProcess;
    try {
      proc = this.agent
        ? spawn(systemBin('bash'), this.shimArgs(process.execPath, args, env, this.config.workspace, { cgroup: leaf, hide: HIDDEN_FROM_HELPER.map((d) => cacheDirPath(this.config, d)) }), { cwd: '/', env: childProcessEnv({ PATH: SYSTEM_PATH }), detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
        : spawn(process.execPath, args, { cwd: this.config.workspace, env: childProcessEnv(env), detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      this.helperFailures++;
      return undefined;
    }
    // Only the helper's own leaf is killed with it; the session leaf (no `env` leaf) is the CLI's too.
    const h: HelperProc = { proc, reader: new HelperReader(LIMITS.frameBytes), calls: new Map(), nextId: 1, paused: false, dead: false, exited: false, sent: false, ...(leaf && leaf === this.envCgroup ? { leaf } : {}) };
    this.helper = h;
    proc.stdin?.on('error', () => {});
    proc.on('error', () => {
      h.exited = true;
      this.helperExited(h);
      this.endHelper(h, h.sent ? 'gone' : 'not-started');
    });
    proc.on('exit', (code) => {
      h.exited = true;
      this.helperExited(h);
      if (!h.sent && code !== null && NOT_STARTED.has(code)) return this.endHelper(h, 'not-started');
      // 'close' waits for its stdout to end, which a paused reader can hold back: a short grace for its last frames, then it is gone.
      setTimeout(() => this.endHelper(h, 'gone'), 200).unref();
    });
    proc.on('close', () => this.endHelper(h, 'gone'));
    proc.stdout?.on('data', (d: Buffer) => {
      if (h.dead) return;
      try {
        for (const f of h.reader.push(d)) this.onHelperFrame(h, f.type, f.id, f.payload);
      } catch {
        // A helper that breaks its pipe's rules is the unprivileged user's: end it and its commands, fail its calls.
        this.endHelper(h, 'kill');
      }
    });
    return h;
  }

  private onHelperFrame(h: HelperProc, type: number, hid: number, payload: Uint8Array): void {
    if (!h.sent) {
      h.sent = true;
      this.helperFailures = 0;
    }
    const call = hid === 0 || hid >= h.nextId ? undefined : h.calls.get(hid);
    if (!call) throw new ProtocolError(`a helper frame for no call in flight (${hid})`);
    if (type === HELPER.DATA) {
      if (payload.length > LIMITS.chunkBytes) throw new ProtocolError('a helper data frame over the chunk size');
      call.streamed += payload.length;
      if (call.streamed > envResultBytes(call.op)) throw new ProtocolError('a helper result over its op\'s limit');
      if (call.cancelled) return;
      this.send(call.owner, frame(CTL.ENV_STREAM, call.id, payload));
      if (this.pressure(call.owner) && !h.paused) {
        h.paused = true;
        h.proc.stdout?.pause();
        this.watchDrain();
      }
      return;
    }
    if (type === HELPER.RESULT) {
      if (payload.length > HELPER_RESULT_BYTES) throw new ProtocolError('a helper result over its size');
      const result = checkHelperResult(parse(payload), call.streamed > 0);
      h.calls.delete(hid);
      this.answerEnv(call, result);
      return;
    }
    throw new ProtocolError(`an unknown helper frame type ${type}`);
  }

  /** A helper's process exited: once no ended helper is left running, the calls held for it go out. */
  private helperExited(h: HelperProc): void {
    if (!this.retiring.delete(h) || this.retiring.size) return;
    for (const call of this.heldEnv.splice(0)) if (this.envCalls.get(call.id) === call) this.dispatchEnv(call);
  }

  /**
   * End a helper, once: `gone` (it exited or crashed), `kill` (it broke the
   * pipe's rules, ignored a `CANCEL`, or a cache dir it hides is replaced), or
   * `not-started` (it never ran: its calls did not run either). Its commands
   * are killed with its cgroup leaf where it has one; its in-flight calls are
   * answered once it (and the leaf) are gone, saying they may have half-run;
   * new calls wait until then.
   */
  private endHelper(h: HelperProc, how: 'gone' | 'kill' | 'not-started'): void {
    if (h.dead) return;
    h.dead = true;
    if (this.helper === h) this.helper = undefined;
    const calls = [...h.calls.values()];
    h.calls.clear();
    if (how === 'not-started') {
      this.helperFailures++;
      for (const call of calls) this.answerEnv(call, didNotRun('EIO', 'the session helper could not start'));
      return;
    }
    if (!h.exited) this.retiring.add(h);
    if (how === 'kill') {
      try {
        // The degraded tier has no leaf: SIGTERM lets an honest helper kill its commands' groups as it exits.
        h.proc.kill(h.leaf ? 'SIGKILL' : 'SIGTERM');
      } catch {}
      if (!h.leaf)
        setTimeout(() => {
          if (!h.exited) h.proc.kill('SIGKILL');
        }, 500).unref();
    }
    if (h.leaf) killCgroup(h.leaf);
    void this.helperGone(h).then(() => {
      for (const call of calls) this.answerEnv(call, helperEnded(!!h.leaf));
    });
  }

  /** Wait (at most 1.5 s) until the helper has exited and its leaf holds no process. */
  private async helperGone(h: HelperProc): Promise<void> {
    for (let i = 0; i < 150; i++) {
      if (h.exited && (!h.leaf || !cgroupPopulated(h.leaf))) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** End the helper with the attach (its commands are killed with the session; the helper itself goes here). Its calls were the attach's: nobody is answered. */
  private stopHelper(): void {
    const h = this.helper;
    if (!h) return;
    this.helper = undefined;
    h.dead = true;
    for (const call of h.calls.values()) clearTimeout(call.cancelTimer);
    h.calls.clear();
    if (!h.exited) this.retiring.add(h);
    if (h.leaf) killCgroup(h.leaf);
    try {
      h.proc.stdin?.end();
      h.proc.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        if (!h.exited) h.proc.kill('SIGKILL');
      } catch {}
    }, 1_000).unref();
  }

  // -- the model port ---------------------------------------------------------

  private listenModel(): Promise<void> {
    this.modelServer = createHttpServer((req, res) => void this.onModel(req, res));
    return listen(this.modelServer, this.config.modelPort, '127.0.0.1');
  }

  /**
   * Who may call the model port (§5.5): when the arm named the attach's key
   * (`modelKey`), only a request that carries it (its bearer or `x-api-key`;
   * else 401), and where `/proc` can tell processes apart, only one from a
   * process this attach spawned (the CLI itself: a command it runs is a
   * descendant, with its own sockets, and gets 403). That holds while a
   * command can't reach into the CLI (read its environ, trace it, take its
   * socket with `pidfd_getfd`): in the privileged tier the peer must be a
   * process the agent can't trace (not dumpable: Codex, whose binary is
   * execute-only, so its `/proc/<pid>/environ` is root's), or a child whose spawn
   * said its commands run in a pid namespace of their own (Claude Code's
   * sandbox) or that it runs none (`isolatedCommands`); else 403.
   * `ptrace_scope` restricts tracing too where the kernel has Yama
   * (`restrictPtrace`; the VM's has none, P0.16). The peer is looked up once
   * per TCP connection. Returns the status to refuse with, or undefined.
   */
  private modelRefusal(req: IncomingMessage): number | undefined {
    // The live attach's key, or, before its /model is dialed, the armed one's: the port never answers an unchecked caller.
    const want = this.modelKey ?? this.armed?.model;
    // An arm that named no key authenticates nobody (its reply said so: `modelAuth: false`). Nothing armed: no key is anyone's.
    if (!want) return this.armed ? undefined : 401;
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const apiKey = req.headers['x-api-key'];
    const key = bearer ?? (typeof apiKey === 'string' ? apiKey : undefined);
    if (!key || !constantTimeEqualHex(keyHash(key), want)) return 401;
    if (!canCheckPeers()) return undefined;
    const socket = req.socket;
    let ok = this.peers.get(socket);
    if (ok === undefined) {
      const mine = [...this.children.values()].filter((c) => c.owner === this.ctl && c.proc.pid !== undefined);
      const pid = socket.remoteAddress?.replace(/^::ffff:/, '') === '127.0.0.1' && socket.remotePort !== undefined ? peerPid(socket.remotePort, this.config.modelPort, mine.map((c) => c.proc.pid!)) : undefined;
      const child = pid === undefined ? undefined : mine.find((c) => c.proc.pid === pid);
      // The degraded tier (one uid, tests) has no boundary between the CLI and its commands to keep.
      ok = !!child && (!this.agent || child.isolated || notDumpable(child.proc.pid!));
      this.peers.set(socket, ok);
    }
    return ok ? undefined : 403;
  }

  /** One CLI model call, relayed over `/model`, from the CLI alone (`modelRefusal`). Concurrency is capped at 8 (503 past it). */
  private async onModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The caller first: whether an attach is live is nothing to tell a process that isn't its CLI.
    const refused = this.modelRefusal(req);
    if (refused) {
      req.resume();
      res.writeHead(refused).end();
      return;
    }
    const client = this.modelClient;
    if (!client) {
      req.resume();
      res.writeHead(502).end();
      return;
    }
    if (this.modelInflight >= MODEL_INFLIGHT) {
      res.writeHead(503).end();
      return;
    }
    this.modelInflight++;
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const c of req) {
        total += (c as Buffer).length;
        if (total > LIMITS.modelBodyBytes) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(c as Buffer);
      }
      const request: WsRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        // The CLI's key stays here: the handler adds the credential itself.
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'authorization' && k !== 'x-api-key').map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
        body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined,
      };
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      try {
        const response = await client.request(request, abort.signal);
        res.writeHead(response.status, response.headers);
        for await (const chunk of response.body) res.write(Buffer.from(chunk));
        res.end();
      } catch (err) {
        // The driver's answer is a fixed code (world-remote's adapter 5); give the CLI a status it understands, and nothing more.
        const code = /relay error: ([a-z_]+)$/.exec(String((err as Error)?.message ?? ''))?.[1];
        const status = code ? MODEL_STATUS[code] : undefined;
        if (!res.headersSent) {
          if (status) res.writeHead(status, { 'content-type': 'application/json' }).write(JSON.stringify({ type: 'error', error: { type: code, message: code } }));
          else res.writeHead(502);
        }
        res.end();
      }
    } finally {
      this.modelInflight--;
    }
  }
}

/** A child's whole environment, typed as Node's (whose declaration an app's types can widen with required names, as Next's `NODE_ENV`). */
function childProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return env as NodeJS.ProcessEnv;
}

/** Retire a socket that is no longer current: drop its listeners (its late frames and close change nothing), then close it (with `code`, then terminate shortly after) or terminate it now. */
function retire(live: Live, code?: number): void {
  clearInterval(live.pinger);
  const ws = live.ws;
  ws.removeAllListeners('message');
  ws.removeAllListeners('close');
  ws.removeAllListeners('ping');
  ws.removeAllListeners('pong');
  try {
    if (code !== undefined && ws.readyState === ws.OPEN) {
      ws.close(code, 'superseded');
      setTimeout(() => ws.terminate(), 1_000).unref();
    } else ws.terminate();
  } catch {}
}

/** Listen on `port` (and `host`), rejecting on a bind error (`EADDRINUSE`: another relay, or a model-run listener, holds it). */
function listen(server: Server, port: number, host?: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    const done = () => {
      server.off('error', reject);
      server.on('error', () => {});
      resolveListen();
    };
    if (host) server.listen(port, host, done);
    else server.listen(port, done);
  });
}

/** Whether something answers on a unix socket. */
function answers(path: string): Promise<boolean> {
  return new Promise((res) => {
    const s = netConnect(path);
    s.setTimeout(500, () => (s.destroy(), res(false)));
    s.on('connect', () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
  });
}

/**
 * P0.20's fallback, on by default wherever it can be: refuse every uid but
 * root on the platform's own in-VM listener (`127.0.0.1:23456`, reachable by
 * `agent`; no exec or file route was found on it, but its routes can't be
 * enumerated blind). An owner-match rule on locally made packets, so the
 * platform's own traffic is untouched. Needs `nft` or `iptables` and the
 * kernel support behind them; the platform's VM kernel has neither nf_tables
 * nor iptables' owner match (A3, `probes/platform-guard.ts`), so on Vercel
 * Sandbox today this finds nothing to install and the arm reply says
 * `platformGuard: false`. Kept for a kernel or image that has them. Idempotent.
 */
function guardPlatformListener(): boolean {
  const run = (cmd: string, args: string[]) => spawnSync(systemBin(cmd), args, { cwd: '/', env: childProcessEnv({ PATH: SYSTEM_PATH }), stdio: 'ignore' }).status === 0;
  if (systemBin('nft').startsWith('/')) {
    run('nft', ['delete', 'table', 'inet', 'dh']);
    return (
      run('nft', ['add', 'table', 'inet', 'dh']) &&
      run('nft', ['add', 'chain', 'inet', 'dh', 'out', '{ type filter hook output priority 0 ; }']) &&
      run('nft', ['add', 'rule', 'inet', 'dh', 'out', 'oifname', 'lo', 'tcp', 'dport', '23456', 'meta', 'skuid', '!=', '0', 'reject', 'with', 'tcp', 'reset'])
    );
  }
  if (systemBin('iptables').startsWith('/')) {
    const rule = ['OUTPUT', '-o', 'lo', '-p', 'tcp', '--dport', '23456', '-m', 'owner', '!', '--uid-owner', '0', '-j', 'REJECT', '--reject-with', 'tcp-reset'];
    return run('iptables', ['-C', ...rule]) || run('iptables', ['-I', ...rule]);
  }
  return false;
}

/** An absolute path for a system binary (the privileged tier never resolves one through a PATH). */
function systemBin(name: string): string {
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) if (existsSync(`${dir}/${name}`)) return `${dir}/${name}`;
  return name;
}

/** `tar` arguments for an extract into `dir`: never root's ownership, and (GNU tar, Linux) never an existing dir's metadata. */
function tarArgs(dir: string): string[] {
  return ['-x', '--no-same-owner', ...(process.platform === 'linux' ? ['--no-overwrite-dir'] : []), '-C', dir];
}

/** A user's uid and gid, from `/etc/passwd` (read once at start); root is refused. */
function resolveUser(name: string): { uid: number; gid: number } {
  const passwd = readFileSync('/etc/passwd', 'utf8');
  for (const line of passwd.split('\n')) {
    const f = line.split(':');
    if (f[0] === name && f.length >= 4) {
      const uid = Number(f[2]);
      const gid = Number(f[3]);
      if (Number.isInteger(uid) && Number.isInteger(gid) && uid > 0) return { uid, gid };
    }
  }
  throw new Error(`harness-sandbox: runAs user ${name} is not a non-root user in /etc/passwd`);
}

/** A `SPAWN` frame's payload, checked. */
interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  isolatedCommands?: boolean;
}

function checkSpawnSpec(raw: unknown): SpawnSpec {
  if (!isObject(raw)) throw new ProtocolError('a malformed SPAWN');
  const { command, args = [], cwd, env = {}, isolatedCommands } = raw;
  if (typeof command !== 'string' || command.length === 0 || command.length > 4096 || command.includes('=') || command.includes('\0')) throw new ProtocolError('a SPAWN command must be a non-empty string without = or NUL');
  if (!Array.isArray(args) || args.length > 4096 || !args.every((a) => typeof a === 'string' && !a.includes('\0'))) throw new ProtocolError('SPAWN args must be strings');
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0'))) throw new ProtocolError('a SPAWN cwd must be absolute');
  if (!isObject(env)) throw new ProtocolError('a SPAWN env must be an object');
  if (isolatedCommands !== undefined && typeof isolatedCommands !== 'boolean') throw new ProtocolError('a SPAWN isolatedCommands must be a boolean');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k) || LOADER_NAMES.test(k) || typeof v !== 'string' || v.includes('\0')) throw new ProtocolError(`a SPAWN env name the relay refuses: ${k.slice(0, 64)}`);
    out[k] = v;
  }
  return { command, args: args as string[], ...(cwd !== undefined ? { cwd: cwd as string } : {}), env: out, ...(isolatedCommands === true ? { isolatedCommands: true } : {}) };
}

function checkArmRequest(raw: unknown): ArmRequest | string {
  if (!isObject(raw)) return 'an arm request must be an object';
  const { sha256, fence, fenced, session, model } = raw;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return 'sha256 must be 64 hex digits';
  if (model !== undefined && (typeof model !== 'string' || !/^[0-9a-f]{64}$/.test(model))) return 'model must be 64 hex digits';
  if (typeof session !== 'string' || session.length === 0 || session.length > 256) return 'session must be a non-empty string';
  if (fence !== undefined && !isCount(fence)) return 'fence must be a non-negative safe integer';
  if (fenced !== undefined && typeof fenced !== 'boolean') return 'fenced must be a boolean';
  return { sha256, session, ...(fence !== undefined ? { fence: fence as number, fenced: fenced === true } : {}), ...(model !== undefined ? { model: model as string } : {}) };
}

/** The answer an unfenced attach gets for `SPAWN`, `FILES` and `WIPE`. */
const UNFENCED = 'refused: this attach holds no fenced token (docs/workspaces.md §5.4: no SPAWN, FILES, WIPE or mutating ENV_CALL without one)';

/** The stand-in's guard (`localMachine`, `brandForTests`): the stand-in flag, a test runner, not on Vercel, not in production. */
function underTest(): boolean {
  return process.env.DH_TEST_LOCAL_SANDBOX === '1' && (!!process.env.VITEST || process.env.NODE_ENV === 'test') && !process.env.VERCEL && process.env.NODE_ENV !== 'production';
}

/** `cgroup.kill` a leaf (best effort). */
function killCgroup(cg: string): void {
  try {
    writeFileSync(join(cg, 'cgroup.kill'), '1');
  } catch {}
}

/** Whether a cgroup (or a descendant) still holds a process. Unreadable: false. */
function cgroupPopulated(cg: string): boolean {
  try {
    return /^populated 1$/m.test(readFileSync(join(cg, 'cgroup.events'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * A helper's `RESULT`, checked and rebuilt before the relay sends it on: the
 * helper runs as the unprivileged user, so a malformed one is the helper's
 * fault (it is ended, its calls `EINTR`), not a protocol violation of the
 * link. `{ ok: false, error: { code, message } }` with a POSIX-like code and a
 * short message, or `{ ok: true, value?, data? }` with `data` `bytes` or
 * `json`, and no streamed bytes without it.
 */
function checkHelperResult(raw: unknown, streamed: boolean): Uint8Array {
  if (!isObject(raw) || typeof raw.ok !== 'boolean') throw new ProtocolError('a malformed helper result');
  if (!raw.ok) {
    const e = raw.error;
    if (!isObject(e) || typeof e.code !== 'string' || !ENV_ERROR_CODE.test(e.code) || typeof e.message !== 'string' || e.message.length > ENV_ERROR_MESSAGE) throw new ProtocolError('a malformed helper error');
    return json({ ok: false, error: { code: e.code, message: e.message } });
  }
  if (raw.data !== undefined && raw.data !== 'bytes' && raw.data !== 'json') throw new ProtocolError('a helper result with an unknown data kind');
  if (raw.data === undefined && streamed) throw new ProtocolError('helper data for a result that has none');
  return json({ ok: true, ...(raw.value !== undefined ? { value: raw.value } : {}), ...(raw.data !== undefined ? { data: raw.data } : {}) });
}

/** Read a `RelayConfig` written by the launcher. */
export function readConfig(path: string): RelayConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as RelayConfig;
}
