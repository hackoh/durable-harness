/**
 * The wire the Function and the in-VM relay share on `/ctl` (docs/workspaces.md
 * §5.4), and the auth primitives of the arm (§5.4 "Auth"). Pure: no sockets, no
 * process, so both halves (the driver's client and the relay) import it and the
 * tests check it on its own.
 *
 * The frame codec is world-remote's `[type u8][id u32 BE][payload]`
 * (`encodeFrame`/`decodeFrame`), reused so one encoding serves both sockets.
 * `/ctl` carries its own frame types (below), a different set from the World
 * socket's `WS_FRAME`; `/model` reuses `WS_FRAME` through world-remote's
 * `requestOverWs`/`serveModelOverWs` adapters. The `id` is a stream id: a
 * process id for `SPAWN`/`STDOUT`/…, a request id for `FILES`/`WIPE`/`SYNC`/…
 * that its `RESULT` echoes, a tail id for `TAIL`/`TAIL_DATA`/`TAIL_ERROR`.
 *
 * Neither side trusts the other's bytes: every frame goes through `decodeCtl`
 * (a length check), every JSON payload through `parse` (strict UTF-8 JSON,
 * returned as `unknown`) and then a field-by-field check; a frame that fails is
 * a `ProtocolError`, and the receiver drops the link. No data part is ever
 * larger than `LIMITS.chunkBytes`: a big tar, stdin line or tail is split.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * `/ctl` frame types. Numbered from 10 so a frame is never confused with a
 * World-socket `WS_FRAME` (1–6) if the two codecs are ever read side by side.
 */
export const CTL = {
  /** R→F, id 0: the relay's first frame, `{ hmac }` = HMAC keyed by `T` over `R`; the driver refuses a relay that can't produce it. */
  HELLO: 10,
  /** F→R: start a child, `{ command, args, cwd, env }`; the relay builds the child's env from its own base plus these, applied after the uid drop. */
  SPAWN: 11,
  /** R→F: `{ pid }` once the child started (or `{ error }` if it could not). */
  SPAWN_ACK: 12,
  /** F→R / R→F: a child's stdin / stdout / stderr, raw bytes, id = the child. A long stdin line is split over several frames. */
  STDIN: 13,
  STDIN_END: 14,
  STDOUT: 15,
  STDERR: 16,
  /** R→F: `{ code, signal, stderrTail }` once the child exited and its stdio closed (every `STDOUT` frame is before it). */
  EXIT: 17,
  /** F→R: `{ signal? }`: kill the whole session, always (§5.4: the cgroup in the privileged tier, every child's process group in the degraded one); the id is ignored. */
  KILL: 18,
  /** F→R: begin unpacking a tar into a freshly wiped cache dir, `{ dir, bytes }`; the tar follows in `FILES_CHUNK` frames and a `FILES_END`. Answered by `RESULT`. */
  FILES: 19,
  /** F→R: delete and recreate every cache dir, `{}`. Answered by `RESULT`. */
  WIPE: 20,
  /** F→R: `sync -f /workspace`, `{}`. Answered by `RESULT` (`ok` only if `sync` exited 0). */
  FSYNC: 21,
  /** F→R: follow a file under a cache dir from an offset, `{ dir, path, offset }`, id = the tail. */
  TAIL: 22,
  /** R→F: `pack({ offset }, bytes)`: the file's next bytes, `offset` the file position after them. The driver splits lines. */
  TAIL_DATA: 23,
  /** F→R: drain a tail to EOF, `{ tail }`, id = the request; answered by `RESULT` once every byte the file holds now has been sent. */
  SYNC: 24,
  /** R→F: the generic reply to `FILES`/`WIPE`/`FSYNC`/`SYNC`, `{ ok, error? }`, id = the request. */
  RESULT: 25,
  /**
   * F→R: one `WorkspaceMachine` operation on `/workspace`, served by the
   * per-attach helper as the unprivileged user (`helper.ts`): `{ op, args,
   * input }`, `op` one of `ENV_OPS`, `input` the byte count of the
   * `ENV_DATA` frames that follow (a file's content, a command's stdin).
   */
  ENV_CALL: 26,
  /** R→F: the call's outcome, `{ ok: true, value?, data? }` or `{ ok: false, error: { code, message } }`; `data` (`'bytes'` or `'json'`) says how to read the `ENV_STREAM` bytes before it. */
  ENV_RESULT: 27,
  /** R→F: the next bytes of a call's result (a file's content, a command's stdout then stderr, a listing as JSON), id = the call. Every one is before its `ENV_RESULT`. */
  ENV_STREAM: 28,
  /** F→R: cancel an in-flight `ENV_CALL` (the helper kills a command's process group) or a `TAIL`. */
  CANCEL: 29,
  /** F→R: the next bytes of a `FILES` tar, id = the `FILES` request. */
  FILES_CHUNK: 30,
  /** F→R: the tar is complete, id = the `FILES` request. */
  FILES_END: 31,
  /** R→F: a tail failed for good, `{ error }` (the file shrank or was replaced, a symlink, a line over the limit), id = the tail. */
  TAIL_ERROR: 32,
  /** F→R: the next bytes of an `ENV_CALL`'s input, id = the call. */
  ENV_DATA: 33,
} as const;

export type CtlType = (typeof CTL)[keyof typeof CTL];

/** Limits (docs/workspaces.md §5.4): anything past them closes the socket. */
export const LIMITS = {
  /** One frame, on `/ctl` and `/model` (both sides' `maxPayload`). */
  frameBytes: 1 << 20,
  /** The largest data part a sender puts in one frame (`STDIN`, `FILES_CHUNK`, `TAIL_DATA`), well under `frameBytes`. */
  chunkBytes: 512 << 10,
  /** One line (a tail's, a child's stdin). */
  lineBytes: 16 << 20,
  /** A model request body. */
  modelBodyBytes: 4 << 20,
  /** One `FILES` tar. */
  filesBytes: 256 << 20,
  /** One `ENV_CALL`'s input, and one result's bytes (a file read or written whole). */
  envBytes: 64 << 20,
  /** A command's stdout, and its stderr, each (`WorkspaceMachine.exec` returns them whole). */
  execOutputBytes: 10 << 20,
} as const;

/** The `WorkspaceMachine` operations an `ENV_CALL` can name. */
export const ENV_OPS = ['exec', 'readFile', 'writeFile', 'stat', 'lstat', 'list', 'walk', 'mkdir', 'remove', 'rename', 'symlink', 'readlink', 'realpath', 'chmod'] as const;
export type EnvOp = (typeof ENV_OPS)[number];
export const isEnvOp = (v: unknown): v is EnvOp => typeof v === 'string' && (ENV_OPS as readonly string[]).includes(v);

/** The operations that can change the VM (§5.4: none without a fenced token). A command can do anything, so `exec` is one. */
export const MUTATING_ENV_OPS: ReadonlySet<EnvOp> = new Set<EnvOp>(['exec', 'writeFile', 'mkdir', 'remove', 'rename', 'symlink', 'chmod']);

/** An error code a helper may report: POSIX-like, short, upper case. */
export const ENV_ERROR_CODE = /^E[A-Z0-9]{1,15}$/;

/** The longest message a helper's error may carry. */
export const ENV_ERROR_MESSAGE = 500;

/**
 * The most result bytes (`ENV_STREAM`) one call of `op` may carry: a
 * command's stdout and stderr (`2 × execOutputBytes`), or a file or a
 * listing's JSON (`envBytes`). The helper stays under it (an oversize listing
 * is `E2BIG`), the relay ends a helper that passes it, and the driver drops a
 * link that does: the three sides use this one bound.
 */
export function envResultBytes(op: EnvOp): number {
  return op === 'exec' ? 2 * LIMITS.execOutputBytes : LIMITS.envBytes;
}

/** The longest timer Node keeps (2^31 - 1 ms): a longer one fires at once, so every deadline is clamped to it. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The 5-byte `[type u8][id u32 BE]` header plus the payload, or undefined for anything that is not a binary frame of at least 5 bytes: what each side calls on every frame from the other before it reads a byte. */
export function decodeCtl(data: unknown): { type: number; id: number; payload: Uint8Array } | undefined {
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (Array.isArray(data) && data.every((d) => d instanceof Uint8Array)) bytes = Buffer.concat(data as Uint8Array[]);
  else return undefined;
  if (bytes.length < 5 || bytes.length > LIMITS.frameBytes) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { type: bytes[0]!, id: view.getUint32(1), payload: bytes.subarray(5) };
}

/** Build a `/ctl` frame: `[type u8][id u32 BE][payload]`. */
export function frame(type: number, id: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, id);
  out.set(payload, 5);
  return out;
}

/** A protocol violation: the receiver closes the socket (and the driver counts it as a failed delivery, §5.4). */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(`harness-sandbox: relay protocol violation: ${message}`);
    this.name = 'ProtocolError';
  }
}

/** The signals a child can be reported killed by: `SIG` and a short upper-case name. */
const SIGNAL_NAME = /^SIG[A-Z0-9]{1,12}$/;
/** Whether `v` is a non-negative safe integer. */
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** Whether `v` is a signal name or null. */
export const isSignal = (v: unknown): v is string | null => v === null || (typeof v === 'string' && SIGNAL_NAME.test(v));
/** Whether `v` is a plain JSON object (not null, not an array). */
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const te = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true });

/** Pack a JSON header and an optional binary tail into one payload: `[u32 jsonLen][json][bin]`. For `FILES` (a tar) and any frame that carries both. */
export function pack(header: unknown, bin: Uint8Array = new Uint8Array()): Uint8Array {
  const json = te.encode(JSON.stringify(header ?? {}));
  const out = new Uint8Array(4 + json.length + bin.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(bin, 4 + json.length);
  return out;
}

/** The inverse of `pack`. Throws a `ProtocolError` on a payload too short for its header, or a header that is not JSON. */
export function unpack(payload: Uint8Array): { header: unknown; bin: Uint8Array } {
  if (payload.length < 4) throw new ProtocolError('a packed payload shorter than its length field');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const jsonLen = view.getUint32(0);
  if (4 + jsonLen > payload.length) throw new ProtocolError('a packed header longer than its payload');
  return { header: parse(payload.subarray(4, 4 + jsonLen)), bin: payload.subarray(4 + jsonLen) };
}

/** A payload that is JSON only (no binary tail). */
export function json(value: unknown): Uint8Array {
  return te.encode(JSON.stringify(value ?? {}));
}

/** Parse a JSON-only payload: `unknown`, for the caller to check field by field. Throws a `ProtocolError` on anything but strict UTF-8 JSON. */
export function parse(payload: Uint8Array): unknown {
  try {
    return JSON.parse(strict.decode(payload));
  } catch {
    throw new ProtocolError('a payload that is not UTF-8 JSON');
  }
}

// ---------------------------------------------------------------------------
// Auth (docs/workspaces.md §5.4 "Auth")

/** A fresh 32-byte attach token `T`, as a base64url string for the `Authorization: Bearer` header. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A fresh nonce `R` (the relay mints one per arm), base64url. */
export function mintNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** `sha256(T)` as hex, over the token's raw bytes: what the driver arms the relay with, and what the relay checks the bearer against. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex');
}

/**
 * `sha256(P)` of a model key (§5.5), hex, over its UTF-8 text: what the
 * driver arms the relay with (`ArmRequest.model`), and what the model port
 * checks a request's bearer or `x-api-key` against.
 */
export function keyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** A fresh model key `P` for one attach (§5.5): what the CLI sends the model port as its API key. Prefixed, so it can never take a credential's shape. */
export function mintModelKey(): string {
  return `dhm-${randomBytes(24).toString('base64url')}`;
}

/**
 * The hello proof: HMAC-SHA256 keyed by the token `T` over the nonce `R`, as
 * hex. Both sides compute it; the relay sends it, the driver checks it. (§5.4
 * writes it `HMAC(R, T)`; this is the same pair, key `T`.)
 */
export function helloProof(token: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'base64url')).update(nonce).digest('hex');
}

/** Constant-time equality of two hex strings of equal length (a hash, an HMAC). Length mismatch is false, not a throw. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** The close codes the relay uses on `/ctl` and `/model`. */
export const CLOSE = {
  /** A newer owner armed with a higher fence (§5.4): the old sockets close with this. */
  superseded: 4409,
} as const;

// ---------------------------------------------------------------------------
// The arm (docs/workspaces.md §5.4 step 2)

/** The `arm` request over the control socket. */
export interface ArmRequest {
  sha256: string;
  /** The fence count; undefined: no in-band token (a World without the fence). */
  fence?: number;
  /** Whether the token is still behind the World's fence (`FenceToken.fenced`). Only `true` preempts. */
  fenced?: boolean;
  session: string;
  /**
   * `sha256(P)` of the CLI's model key, hex (§5.5): the model port admits a
   * request only with that key (as its bearer or `x-api-key`), and only from
   * a process the attach spawned. Undefined: an arm that names no key (the
   * port then authenticates nobody, and the reply says `modelAuth: false`).
   */
  model?: string;
}

export type ArmReply =
  | {
      ok: true;
      R: string;
      /** The kernel's boot id (a reboot changes it; a relay restart doesn't). */
      bootId: string;
      /** This relay process (a restart changes it). */
      relayId: string;
      /** The session this VM is armed for (recorded at its first arm). */
      sessionId: string;
      relayVersion: string;
      cliVersions: Record<string, string>;
      /** `privileged`: the uid drop is in force; `degraded`: one uid (the stand-in only). */
      tier: 'privileged' | 'degraded';
      /** Whether kills go through the session cgroup. */
      cgroup: boolean;
      /** Whether non-root uids are refused on the platform's in-VM listener (needs a firewall tool in the image; P0.20). */
      platformGuard: boolean;
      /**
       * Whether the model port admits only the CLI (§5.5): the arm named its
       * key (`model`), and the relay can tell which process a connection is
       * from (Linux's `/proc`): a request without the key, or from any process
       * but one the attach spawned (the CLI itself, never its descendants), is
       * refused. The session factory serves no model handler outside tests
       * without it.
       */
      modelAuth: boolean;
    }
  | { ok: false; code: 'stale' | 'contended' | 'session' | 'listener' | 'bad_request' | 'internal'; error: string };

/** The arm request for a fence token: `fenced` is carried, so the relay never lets an unfenced token preempt (§5.4). */
export function armRequest(sha256: string, session: string, fence: { count: number; fenced: boolean } | undefined, model?: string): ArmRequest {
  return { sha256, session, ...(fence ? { fence: fence.count, fenced: fence.fenced } : {}), ...(model ? { model } : {}) };
}

/** The `arm` CLI arguments for a request (what A3's `runCommand` passes). */
export function armArgs(req: ArmRequest): string[] {
  return ['--sha256', req.sha256, '--session', req.session, ...(req.fence !== undefined ? ['--fence', String(req.fence), '--fenced', String(req.fenced === true)] : []), ...(req.model ? ['--model', req.model] : [])];
}

// ---------------------------------------------------------------------------
// The helper's pipe (docs/workspaces.md §5.4 "Privilege split")

/**
 * Frames between the relay and its per-attach helper (`helper.ts`), on the
 * helper's stdin and stdout: `[u32 BE length][type u8][id u32 BE][payload]`,
 * the length counting the type, the id and the payload. The id is the
 * relay's own call id, never the driver's. The helper runs as the
 * unprivileged user, so the relay reads its frames as it reads the driver's:
 * bounded and checked, and a bad one ends the helper.
 */
export const HELPER = {
  /** relay→helper: `pack({ op, args }, input)`. */
  CALL: 1,
  /** relay→helper: stop a call (a command's process group is killed). */
  CANCEL: 2,
  /** helper→relay: the next bytes of a call's result. */
  DATA: 3,
  /** helper→relay: the call's outcome, the JSON the relay sends on as `ENV_RESULT`. */
  RESULT: 4,
} as const;

/** The largest `RESULT` a helper may send (a value is small; bulk travels as `DATA`). */
export const HELPER_RESULT_BYTES = 64 << 10;

/** One helper pipe frame. */
export function helperFrame(type: number, id: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 5 + payload.length);
  out[4] = type;
  view.setUint32(5, id);
  out.set(payload, 9);
  return out;
}

/** Splits a helper pipe's bytes into frames; a frame longer than `maxFrame` (or shorter than its header) is a `ProtocolError`. */
export class HelperReader {
  private buffered: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly maxFrame: number) {}

  /** Add bytes; returns every frame they complete. */
  push(chunk: Uint8Array): Array<{ type: number; id: number; payload: Uint8Array }> {
    this.buffered.push(chunk);
    this.length += chunk.length;
    const out: Array<{ type: number; id: number; payload: Uint8Array }> = [];
    for (;;) {
      if (this.length < 4) return out;
      const head = this.peek(4);
      const len = new DataView(head.buffer, head.byteOffset, 4).getUint32(0);
      if (len < 5 || len > this.maxFrame) throw new ProtocolError(`a helper frame of ${len} bytes`);
      if (this.length < 4 + len) return out;
      const bytes = this.take(4 + len);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      out.push({ type: bytes[4]!, id: view.getUint32(5), payload: bytes.subarray(9) });
    }
  }

  private peek(n: number): Uint8Array {
    if (this.buffered[0]!.length >= n) return this.buffered[0]!;
    this.buffered = [concatBytes(this.buffered)];
    return this.buffered[0]!;
  }

  private take(n: number): Uint8Array {
    const all = this.buffered.length === 1 ? this.buffered[0]! : concatBytes(this.buffered);
    const out = all.slice(0, n);
    const rest = all.subarray(n);
    this.buffered = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
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
