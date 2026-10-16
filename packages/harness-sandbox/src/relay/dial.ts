/**
 * The driver's side of the relay (docs/workspaces.md §5.4): dial `/ctl` and
 * `/model`, check the hello proof on both, run the heartbeats, and turn the
 * `/ctl` frames into `spawn`, `files`, `wipe`, `fsync` and `tail`. The machine
 * builder (`../machine.ts`) puts a `SessionMachine` on top of this for the
 * session factory (A3) and the stand-in (`localMachine`); the relay tests also
 * use it directly.
 *
 * The VM is untrusted, and this runs in a shared Function process, so nothing
 * the relay sends may throw out of a socket listener:
 *
 * - every frame is length-checked (`decodeCtl`), every payload parsed strictly
 *   and checked field by field; a violation drops the link (`markLost` with
 *   `protocol: true`, which A3 counts as a failed delivery, §5.4);
 * - both sockets open with `maxPayload` at the frame limit and no
 *   per-message deflate, so a frame never grows past 1 MiB in memory;
 * - `/model` is served (world-remote's `serveModelOverWs`, which answers with
 *   fixed error codes only) only after both hello proofs checked, so a listener
 *   that can't prove `R` gets no model call answered;
 * - a relay-reported path is never used on the driver's own filesystem.
 *
 * A lost link (a socket closed or went silent for 15 s, a superseded close, a
 * violation, the driver's own close) terminates both sockets, so the relay
 * sees the loss at once and kills the session, and fails everything pending:
 * a spawn, a request, a process's `exited` (as a kill), a tail.
 */
import { WebSocket } from 'ws';
import { serveModelOverWs, type WsLike, type WsRequestHandler } from 'harness-world-remote/ws';
import type { KillSignal } from 'harness-world-process';
import { CLOSE, CTL, ENV_ERROR_CODE, LIMITS, MAX_TIMER_MS, MUTATING_ENV_OPS, ProtocolError, constantTimeEqualHex, decodeCtl, frame, envResultBytes, helloProof, isCount, isObject, isSignal, json, parse, unpack, type EnvOp } from './protocol.ts';
import { RemoteProcess, type RemoteProcessHost } from '../process.ts';

/** A tail the driver reads line by line (what `MachineTail` wraps, §5.4). */
export interface RelayTail {
  /** Byte offset of the lines `read()` has returned so far. */
  readonly offset: number;
  /** The complete lines since the last call. Throws once the tail failed (the file shrank or was replaced, a symlink, a line over 16 MiB, the link lost). */
  read(): string[];
  /** Resolves once every byte the file holds now has arrived (`SYNC`); rejects if the tail failed. */
  sync(): Promise<void>;
  close(): void;
}

/** An `ENV_CALL`'s answer, before the machine checks it against its op (`../env.ts`): the inline value, and the streamed bytes when the relay said there are some. */
export interface EnvReply {
  value: unknown;
  /** The `ENV_STREAM` bytes and how to read them (`bytes`, or `json` already parsed into `value`). */
  data?: Uint8Array;
}

/** An `ENV_CALL` the helper answered with an error: its POSIX code and message (VM text, at most 500 characters). */
export class EnvCallError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'EnvCallError';
  }
}

/** A socket the link can also ping and terminate: `ws`'s `WebSocket` (a test double may leave the extras out). */
export interface RelaySocket extends WsLike {
  ping?(): void;
  terminate?(): void;
  /** `ws`'s own events: a pong answering the driver's ping, a ping from the relay. */
  on?(event: 'ping' | 'pong', listener: () => void): unknown;
}

export interface DialOptions {
  ctlUrl: string;
  modelUrl: string;
  /** The attach token `T` (the bearer). */
  token: string;
  /** The nonce `R` from the arm reply, for the hello proof. */
  nonce: string;
  /** The driver's gateway handler for the VM's model calls (§5.5). Omitted: the model socket still opens, but a model call gets `internal`. */
  model?: WsRequestHandler;
  /** Called once, when the link is lost (a socket dropped, a superseded close, silence, a protocol violation, the driver's close). */
  onLost?: (reason: string, protocol: boolean) => void;
  /** Open a socket; defaults to `ws` with the bearer header and the frame limit. Tests pass their own. */
  openSocket?: (url: string, token: string) => RelaySocket;
  /** How long `ready()` waits for both hello proofs. Default 10 s. */
  readyTimeoutMs?: number;
  /** How long a `FILES`/`WIPE`/`FSYNC`/`SYNC` waits for its `RESULT`. Default 60 s. */
  requestTimeoutMs?: number;
}

const PING_MS = 5_000;
const SILENCE_MS = 15_000;
/**
 * How long a cancelled mutating `ENV_CALL` waits for the relay's answer (the
 * helper's `RESULT` once the command is dead, or the relay's own once it ended
 * a helper that didn't stop within 2 s) before the link is dropped instead.
 */
const CANCEL_ACK_MS = 5_000;

function defaultOpen(url: string, token: string): RelaySocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: LIMITS.frameBytes, perMessageDeflate: false }) as unknown as RelaySocket;
}

/** One pending request/reply (`FILES`/`WIPE`/`FSYNC`/`SYNC`), keyed by id. */
interface Waiter {
  resolve(): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A spawn sent but not yet acked. */
interface PendingSpawn {
  proc: RemoteProcess;
  resolve(proc: RemoteProcess): void;
  reject(err: Error): void;
}

/** An `ENV_CALL` waiting for its result. */
interface EnvWaiter {
  parts: Uint8Array[];
  received: number;
  maxBytes: number;
  resolve(reply: EnvReply): void;
  reject(err: Error): void;
  done(): void;
  /** Given up on (`CANCEL` sent), waiting for the relay to confirm it stopped: whatever the answer, the call rejects with this. */
  cancelled?: unknown;
}

/** One tail's state on the driver. */
interface TailState {
  /** Bytes after the last newline, not yet a line. */
  partial: Uint8Array[];
  partialLen: number;
  lines: string[];
  /** File offset of the end of the last complete line. */
  offset: number;
  /** File offset of the last byte received. */
  received: number;
  error?: Error;
  closed: boolean;
}

/** Wait for `promise`, or reject after `ms`; the timer never holds the process open. */
function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`harness-sandbox: ${what} timed out after ${ms} ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The driver's live link to one armed relay. */
export class RelayLink implements RemoteProcessHost {
  private readonly ctl: RelaySocket;
  private readonly model: RelaySocket;
  private readonly procs = new Map<number, RemoteProcess>();
  private readonly spawns = new Map<number, PendingSpawn>();
  private readonly waiters = new Map<number, Waiter>();
  private readonly tails = new Map<number, TailState>();
  private readonly envs = new Map<number, EnvWaiter>();
  private nextId = 1;
  private lost: { reason: string; protocol: boolean } | undefined;
  private ctlSeen = Date.now();
  private modelSeen = Date.now();
  private ctlHello = false;
  private modelHello = false;
  /** `/model` is served (both hellos checked). */
  private serving = false;
  private readonly hellos: Promise<void>;
  private failHello!: (err: Error) => void;
  private pinger?: ReturnType<typeof setInterval>;
  private readonly lostController = new AbortController();
  private readyPromise: Promise<void> | undefined;

  /** Aborted (with the loss reason) once the link is lost. */
  readonly signal: AbortSignal = this.lostController.signal;

  constructor(private readonly options: DialOptions) {
    const open = options.openSocket ?? defaultOpen;
    this.ctl = open(options.ctlUrl, options.token);
    this.model = open(options.modelUrl, options.token);
    this.ctl.binaryType = 'arraybuffer';
    this.model.binaryType = 'arraybuffer';
    let ctlDone!: () => void;
    let modelDone!: () => void;
    const both = Promise.all([new Promise<void>((r) => (ctlDone = r)), new Promise<void>((r) => (modelDone = r))]).then(() => {});
    this.hellos = new Promise<void>((resolve, reject) => {
      this.failHello = reject;
      both.then(resolve);
    });
    this.hellos.catch(() => {});
    this.wire(this.ctl, 'ctl', ctlDone);
    this.wire(this.model, 'model', modelDone);
  }

  /** Resolves once both sockets are open and both hello proofs check, then serves `/model` and starts the heartbeats. Rejects (and closes the link) on a bad or missing hello. */
  ready(): Promise<void> {
    return (this.readyPromise ??= (async () => {
      try {
        await deadline(this.hellos, this.options.readyTimeoutMs ?? 10_000, 'the relay hello');
      } catch (err) {
        this.markLost(String((err as Error)?.message ?? err), err instanceof ProtocolError);
        throw err;
      }
      if (this.lost) throw new Error(`harness-sandbox: relay link lost (${this.lost.reason})`);
      // Only now, with both proofs checked, does the driver answer model calls.
      this.serving = true;
      void serveModelOverWs(this.model, this.options.model ?? (() => Promise.reject(Object.assign(new Error('no model handler'), { code: 'internal' }))), {
        maxBodyBytes: LIMITS.modelBodyBytes,
        onViolation: (reason) => this.markLost(`/model: ${reason}`, true),
      });
      this.pinger = setInterval(() => this.heartbeat(), PING_MS);
      this.pinger.unref?.();
    })());
  }

  private heartbeat(): void {
    if (this.lost) return;
    const now = Date.now();
    if (now - this.ctlSeen > SILENCE_MS || now - this.modelSeen > SILENCE_MS) return this.markLost('silence');
    for (const sock of [this.ctl, this.model]) {
      try {
        sock.ping?.();
      } catch {
        return this.markLost('ping failed');
      }
    }
  }

  /** Listen on one socket: liveness on every frame, ping and pong; the hello first; then `/ctl` frames (a `/model` frame after its hello belongs to `serveModelOverWs`). */
  private wire(sock: RelaySocket, kind: 'ctl' | 'model', helloDone: () => void): void {
    const seen = () => {
      if (kind === 'ctl') this.ctlSeen = Date.now();
      else this.modelSeen = Date.now();
    };
    sock.on?.('pong', seen);
    sock.on?.('ping', seen);
    sock.addEventListener('error', () => {
      if (!this.helloDone(kind)) this.failHello(new Error(`harness-sandbox: /${kind} failed to open`));
    });
    sock.addEventListener('close', (e: { code?: number }) => {
      const code = e?.code ?? 0;
      if (!this.helloDone(kind)) this.failHello(new Error(`harness-sandbox: /${kind} closed before its hello (code ${code})`));
      this.markLost(code === CLOSE.superseded ? `/${kind} superseded by a newer owner` : `/${kind} closed (code ${code})`);
    });
    sock.addEventListener('message', (e: { data: unknown }) => {
      seen();
      if (this.lost) return;
      try {
        const f = decodeCtl(e.data);
        if (!f) throw new ProtocolError(`a short, oversized or text frame on /${kind}`);
        if (!this.helloDone(kind)) {
          this.checkHello(f.type, f.payload, kind);
          if (kind === 'ctl') this.ctlHello = true;
          else this.modelHello = true;
          return helloDone();
        }
        if (kind === 'ctl') this.onCtlFrame(f.type, f.id, f.payload);
        else if (!this.serving) throw new ProtocolError('a /model frame before both hellos');
      } catch (err) {
        const protocol = err instanceof ProtocolError;
        const reason = String((err as Error)?.message ?? err);
        if (!this.helloDone(kind)) this.failHello(protocol ? (err as Error) : new ProtocolError(reason));
        this.markLost(reason, true);
      }
    });
  }

  private helloDone(kind: 'ctl' | 'model'): boolean {
    return kind === 'ctl' ? this.ctlHello : this.modelHello;
  }

  private checkHello(type: number, payload: Uint8Array, kind: 'ctl' | 'model'): void {
    if (type !== CTL.HELLO) throw new ProtocolError(`the first /${kind} frame was not a hello`);
    const hello = parse(payload);
    const hmac = isObject(hello) ? hello.hmac : undefined;
    if (typeof hmac !== 'string' || !/^[0-9a-f]{64}$/.test(hmac)) throw new ProtocolError(`a malformed /${kind} hello`);
    if (!constantTimeEqualHex(hmac, helloProof(this.options.token, this.options.nonce))) throw new ProtocolError(`the relay /${kind} hello proof did not match`);
  }

  private onCtlFrame(type: number, id: number, payload: Uint8Array): void {
    switch (type) {
      case CTL.SPAWN_ACK: {
        const pending = this.spawns.get(id);
        if (!pending) throw new ProtocolError(`a spawn ack for no pending spawn (${id})`);
        const ack = parse(payload);
        if (!isObject(ack)) throw new ProtocolError('a malformed spawn ack');
        this.spawns.delete(id);
        if (typeof ack.error === 'string') {
          this.procs.delete(id);
          pending.reject(new Error(`harness-sandbox: spawn failed: ${ack.error.slice(0, 500)}`));
          return;
        }
        if (!isCount(ack.pid)) throw new ProtocolError('a spawn ack without a pid');
        pending.proc.started(ack.pid);
        pending.resolve(pending.proc);
        return;
      }
      case CTL.STDOUT:
        this.procOf(id)?.onStdout(payload.slice());
        return;
      case CTL.STDERR:
        this.procOf(id)?.onStderr(payload.slice());
        return;
      case CTL.EXIT: {
        const exit = parse(payload);
        if (!isObject(exit) || !(exit.code === null || (typeof exit.code === 'number' && Number.isInteger(exit.code))) || !isSignal(exit.signal)) throw new ProtocolError('a malformed exit');
        const tail = typeof exit.stderrTail === 'string' ? exit.stderrTail.slice(-8192) : undefined;
        const proc = this.procOf(id);
        // An exit before the ack (the child failed at once): the spawn still resolves, with the process already exited.
        const pending = this.spawns.get(id);
        if (pending) {
          this.spawns.delete(id);
          pending.resolve(pending.proc);
        }
        proc?.onExit({ code: exit.code as number | null, signal: exit.signal }, tail);
        this.procs.delete(id);
        return;
      }
      case CTL.RESULT: {
        const result = parse(payload);
        if (!isObject(result) || typeof result.ok !== 'boolean') throw new ProtocolError('a malformed result');
        const waiter = this.waiters.get(id);
        if (!waiter) return; // timed out already
        this.waiters.delete(id);
        clearTimeout(waiter.timer);
        if (result.ok) waiter.resolve();
        else waiter.reject(new Error(`harness-sandbox: relay op failed: ${typeof result.error === 'string' ? result.error.slice(0, 500) : 'unknown'}`));
        return;
      }
      case CTL.TAIL_DATA: {
        const tail = this.tails.get(id);
        const { header, bin } = unpack(payload);
        if (!isObject(header) || !isCount(header.offset)) throw new ProtocolError('a malformed tail frame');
        if (!tail || tail.closed || tail.error) return;
        if (header.offset !== tail.received + bin.length) throw new ProtocolError('a tail frame out of order');
        tail.received = header.offset;
        this.feedTail(tail, bin);
        return;
      }
      case CTL.ENV_STREAM: {
        const waiter = this.envs.get(id);
        if (!waiter) {
          if (id === 0 || id >= this.nextId) throw new ProtocolError(`an ENV_STREAM for a call never made (${id})`);
          return; // given up on already
        }
        waiter.received += payload.length;
        if (waiter.received > waiter.maxBytes) throw new ProtocolError('an ENV_CALL result over its limit');
        if (waiter.cancelled === undefined) waiter.parts.push(payload.slice());
        return;
      }
      case CTL.ENV_RESULT: {
        const result = parse(payload);
        if (!isObject(result) || typeof result.ok !== 'boolean') throw new ProtocolError('a malformed ENV_RESULT');
        const waiter = this.envs.get(id);
        if (!waiter) {
          if (id === 0 || id >= this.nextId) throw new ProtocolError(`an ENV_RESULT for a call never made (${id})`);
          return;
        }
        // Check it all before settling: a violation must leave the call to the loss, which rejects it.
        let settle: () => void;
        if (waiter.cancelled !== undefined) {
          // The confirmation a cancelled call waited for: it is over, as the caller was told when it gave up.
          if (!result.ok && !(isObject(result.error) && typeof result.error.code === 'string' && ENV_ERROR_CODE.test(result.error.code) && typeof result.error.message === 'string')) throw new ProtocolError('a malformed ENV_RESULT error');
          const err = waiter.cancelled;
          settle = () => waiter.reject(err as Error);
        } else if (!result.ok) {
          const e = result.error;
          if (!isObject(e) || typeof e.code !== 'string' || !ENV_ERROR_CODE.test(e.code) || typeof e.message !== 'string') throw new ProtocolError('a malformed ENV_RESULT error');
          const err = new EnvCallError(e.code, e.message.slice(0, 500));
          settle = () => waiter.reject(err);
        } else {
          const data = waiter.parts.length ? concat(waiter.parts) : undefined;
          let reply: EnvReply;
          if (result.data === undefined) {
            if (data) throw new ProtocolError('ENV_STREAM bytes for a result that has none');
            reply = { value: result.value };
          } else if (result.data === 'bytes') reply = { value: result.value, data: data ?? new Uint8Array() };
          else if (result.data === 'json') reply = { value: parse(data ?? new Uint8Array()) };
          else throw new ProtocolError('an ENV_RESULT with an unknown data kind');
          settle = () => waiter.resolve(reply);
        }
        this.envs.delete(id);
        waiter.done();
        settle();
        return;
      }
      case CTL.TAIL_ERROR: {
        const err = parse(payload);
        const tail = this.tails.get(id);
        if (tail && !tail.closed) tail.error ??= new Error(`harness-sandbox: tail failed: ${isObject(err) && typeof err.error === 'string' ? err.error.slice(0, 500) : 'unknown'}`);
        return;
      }
      default:
        throw new ProtocolError(`an unknown /ctl frame type ${type}`);
    }
  }

  /** The process a frame names: a registered one, or a protocol violation for an id the driver never spawned. */
  private procOf(id: number): RemoteProcess | undefined {
    const proc = this.procs.get(id);
    if (!proc && (id === 0 || id >= this.nextId)) throw new ProtocolError(`a frame for a process never spawned (${id})`);
    return proc;
  }

  /** Split tail bytes into complete lines, refusing a line over the limit. */
  private feedTail(tail: TailState, bytes: Uint8Array): void {
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0x0a) continue;
      const piece = bytes.subarray(start, i);
      const line = tail.partialLen ? concat([...tail.partial, piece]) : piece;
      tail.partial = [];
      tail.partialLen = 0;
      tail.lines.push(new TextDecoder().decode(line));
      tail.offset += line.length + 1;
      start = i + 1;
    }
    if (start < bytes.length) {
      const rest = bytes.slice(start);
      tail.partial.push(rest);
      tail.partialLen += rest.length;
    }
    if (tail.partialLen > LIMITS.lineBytes) tail.error ??= new Error('harness-sandbox: tail failed: a line over 16 MiB');
  }

  // -- RemoteProcessHost --------------------------------------------------------

  sendStdin(id: number, bytes: Uint8Array): boolean {
    if (bytes.length > LIMITS.lineBytes) throw new RangeError(`harness-sandbox: a stdin line over ${LIMITS.lineBytes} bytes`);
    if (!this.open()) return false;
    for (let at = 0; at < bytes.length; at += LIMITS.chunkBytes) this.sendCtl(CTL.STDIN, id, bytes.subarray(at, Math.min(bytes.length, at + LIMITS.chunkBytes)));
    return true;
  }

  endStdin(id: number): void {
    if (this.open()) this.sendCtl(CTL.STDIN_END, id);
  }

  /** `KILL`: the whole session (§5.4). */
  killSession(signal: KillSignal = 'SIGKILL'): void {
    if (this.open()) this.sendCtl(CTL.KILL, 0, json({ signal }));
  }

  // -- operations ---------------------------------------------------------------

  /** Spawn a child in the VM, resolving once the relay acks with its pid. Rejects at once if the link is lost. */
  spawn(spec: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; isolatedCommands?: boolean }): Promise<RemoteProcess> {
    if (!this.open()) return Promise.reject(this.lostError());
    const id = this.nextId++;
    const proc = new RemoteProcess(id, this);
    // Registered before the SPAWN goes out: an ack and the first output can arrive in one read.
    this.procs.set(id, proc);
    return new Promise<RemoteProcess>((resolve, reject) => {
      this.spawns.set(id, { proc, resolve, reject });
      try {
        this.sendCtl(CTL.SPAWN, id, json({ command: spec.command, args: spec.args ?? [], cwd: spec.cwd, env: spec.env ?? {}, ...(spec.isolatedCommands ? { isolatedCommands: true } : {}) }));
      } catch (err) {
        this.spawns.delete(id);
        this.procs.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Unpack a tar into a freshly wiped cache dir: a `FILES` header, the tar in chunks, a `FILES_END`. */
  files(dir: string, tar: Uint8Array): Promise<void> {
    if (tar.length > LIMITS.filesBytes) return Promise.reject(new RangeError(`harness-sandbox: a FILES tar over ${LIMITS.filesBytes} bytes`));
    return this.request((id) => {
      this.sendCtl(CTL.FILES, id, json({ dir, bytes: tar.length }));
      for (let at = 0; at < tar.length; at += LIMITS.chunkBytes) this.sendCtl(CTL.FILES_CHUNK, id, tar.subarray(at, Math.min(tar.length, at + LIMITS.chunkBytes)));
      this.sendCtl(CTL.FILES_END, id);
    });
  }

  /** Delete and recreate every cache dir. */
  wipe(): Promise<void> {
    return this.request((id) => this.sendCtl(CTL.WIPE, id, json({})));
  }

  /** `sync -f /workspace`. */
  fsync(): Promise<void> {
    return this.request((id) => this.sendCtl(CTL.FSYNC, id, json({})));
  }

  /** Follow a file under a cache dir from `offset`. */
  tail(dir: string, path: string, options: { offset?: number } = {}): RelayTail {
    const offset = options.offset ?? 0;
    if (!isCount(offset)) throw new RangeError('harness-sandbox: a tail offset must be a non-negative integer');
    const id = this.nextId++;
    const state: TailState = { partial: [], partialLen: 0, lines: [], offset, received: offset, closed: false };
    if (!this.open()) state.error = this.lostError();
    else {
      this.tails.set(id, state);
      this.sendCtl(CTL.TAIL, id, json({ dir, path, offset }));
    }
    const link = this;
    return {
      get offset() {
        return state.offset;
      },
      read() {
        if (state.error) throw state.error;
        return state.lines.splice(0);
      },
      async sync() {
        if (state.error) throw state.error;
        try {
          await link.request((rid) => link.sendCtl(CTL.SYNC, rid, json({ tail: id })));
        } catch (err) {
          throw state.error ?? err;
        }
        if (state.error) throw state.error;
      },
      close() {
        if (state.closed) return;
        state.closed = true;
        link.tails.delete(id);
        if (link.open()) link.sendCtl(CTL.CANCEL, id);
      },
    };
  }

  /**
   * One `WorkspaceMachine` operation in the VM (`ENV_CALL`), served by the
   * relay's helper as the unprivileged user. `input` (a file's content, a
   * command's stdin) follows in `ENV_DATA` frames. Resolves with the result as
   * the relay sent it (the machine checks it against its op); rejects with an
   * `EnvCallError` for the helper's own error, or the link's loss. On
   * `signal` or after `timeoutMs` it sends `CANCEL` and rejects (with the
   * signal's reason, or `ETIMEDOUT`): a read at once; a mutating op only once
   * the relay answered (the command is dead, its writes done), or after
   * `CANCEL_ACK_MS` without an answer by dropping the link (the relay then
   * kills the session). A result over `maxBytes` (default `envResultBytes(op)`,
   * the bound the helper and the relay keep too) is a protocol violation.
   */
  envCall(op: EnvOp, args: unknown[], options: { input?: Uint8Array; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<EnvReply> {
    const input = options.input ?? new Uint8Array();
    if (input.length > LIMITS.envBytes) return Promise.reject(new RangeError(`harness-sandbox: an ENV_CALL input over ${LIMITS.envBytes} bytes`));
    if (!this.open()) return Promise.reject(this.lostError());
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const id = this.nextId++;
    return new Promise<EnvReply>((resolve, reject) => {
      const signal = options.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const giveUp = (err: unknown) => {
        if (this.envs.get(id) !== waiter || waiter.cancelled !== undefined) return;
        waiter.done();
        if (!this.open()) {
          this.envs.delete(id);
          return reject(err);
        }
        this.sendCtl(CTL.CANCEL, id);
        if (!MUTATING_ENV_OPS.has(op)) {
          this.envs.delete(id);
          return reject(err);
        }
        // A mutating op settles only once it is known to have stopped.
        waiter.cancelled = err ?? new Error(`harness-sandbox: ${op} was cancelled`);
        waiter.parts = [];
        timer = setTimeout(() => {
          if (this.envs.get(id) === waiter) this.markLost(`a cancelled ${op} was not confirmed stopped within ${CANCEL_ACK_MS} ms`);
        }, CANCEL_ACK_MS);
        timer.unref?.();
      };
      const onAbort = () => giveUp(signal!.reason);
      const waiter: EnvWaiter = {
        parts: [],
        received: 0,
        maxBytes: options.maxBytes ?? envResultBytes(op),
        resolve,
        reject,
        done: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      this.envs.set(id, waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        const ms = Math.max(1, Math.min(MAX_TIMER_MS, Math.floor(options.timeoutMs)));
        timer = setTimeout(() => giveUp(Object.assign(new Error(`harness-sandbox: ${op} got no answer from the sandbox within ${ms} ms`), { code: 'ETIMEDOUT' })), ms);
        timer.unref?.();
      }
      try {
        this.sendCtl(CTL.ENV_CALL, id, json({ op, args, input: input.length }));
        for (let at = 0; at < input.length; at += LIMITS.chunkBytes) this.sendCtl(CTL.ENV_DATA, id, input.subarray(at, Math.min(input.length, at + LIMITS.chunkBytes)));
      } catch (err) {
        this.envs.delete(id);
        waiter.done();
        reject(err as Error);
      }
    });
  }

  /** A reply that broke the protocol above the frames (a result that doesn't fit its operation, `../env.ts`): drop the link as a violation. */
  violation(reason: string): void {
    this.markLost(reason, true);
  }

  /**
   * Drop one of the two sockets abruptly, as a network loss would (the Drop
   * the Relay drill, docs/workspaces.md §8 D4): no close frame, so the relay
   * sees its connection go, and this side marks the link lost when the socket
   * closes (a loss like any other, which the session factory re-attaches).
   */
  drop(socket: 'ctl' | 'model'): void {
    if (this.lost) return;
    const sock = socket === 'ctl' ? this.ctl : this.model;
    try {
      if (sock.terminate) sock.terminate();
      else sock.close(4000, 'dropped');
    } catch {}
  }

  /** Close the link (a clean close frame). The relay sees it and kills the session; everything pending fails. */
  close(): void {
    this.markLost('closed by driver', false, true);
  }

  /** Whether the link has been lost. */
  isLost(): boolean {
    return this.lost !== undefined;
  }

  /** Why the link was lost, and whether it was a protocol violation (which A3 counts as a failed delivery, §5.4). */
  lossReason(): { reason: string; protocol: boolean } | undefined {
    return this.lost;
  }

  private open(): boolean {
    return !this.lost && this.ctl.readyState === 1;
  }

  private lostError(): Error {
    return new Error(`harness-sandbox: relay link lost (${this.lost?.reason ?? 'not open'})`);
  }

  private request(send: (id: number) => void): Promise<void> {
    if (!this.open()) return Promise.reject(this.lostError());
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const ms = this.options.requestTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        if (this.waiters.delete(id)) reject(new Error(`harness-sandbox: relay op timed out after ${ms} ms`));
      }, ms);
      timer.unref?.();
      this.waiters.set(id, { resolve, reject, timer });
      try {
        send(id);
      } catch (err) {
        this.waiters.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /** Send one frame. Throws if the link is not open or the frame would pass the limit (the caller splits data parts). */
  private sendCtl(type: number, id: number, payload: Uint8Array = new Uint8Array()): void {
    if (!this.open()) throw this.lostError();
    if (payload.length + 5 > LIMITS.frameBytes) throw new RangeError(`harness-sandbox: a /ctl frame over ${LIMITS.frameBytes} bytes`);
    this.ctl.send(frame(type, id, payload));
  }

  private markLost(reason: string, protocol = false, graceful = false): void {
    if (this.lost) return;
    this.lost = { reason, protocol };
    clearInterval(this.pinger);
    for (const sock of [this.ctl, this.model]) {
      try {
        if (graceful || !sock.terminate) sock.close(graceful ? 1000 : 4000, graceful ? 'client closed' : 'lost');
        else sock.terminate();
      } catch {}
    }
    const err = this.lostError();
    for (const pending of this.spawns.values()) pending.reject(err);
    this.spawns.clear();
    for (const proc of this.procs.values()) proc.onLost();
    this.procs.clear();
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.waiters.clear();
    for (const tail of this.tails.values()) tail.error ??= err;
    this.tails.clear();
    for (const waiter of this.envs.values()) {
      waiter.done();
      // A cancelled call keeps the reason it was given up for; the loss (the relay kills the session) is what ends it.
      waiter.reject((waiter.cancelled as Error | undefined) ?? err);
    }
    this.envs.clear();
    this.failHello(err);
    this.lostController.abort(err);
    this.options.onLost?.(reason, protocol);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Dial and wait for both sockets to be ready. On any failure the link is closed (both sockets terminated) before the error is thrown. */
export async function dialRelay(options: DialOptions): Promise<RelayLink> {
  const link = new RelayLink(options);
  await link.ready();
  return link;
}
