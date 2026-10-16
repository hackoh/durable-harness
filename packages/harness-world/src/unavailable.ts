import type { Anchor } from './anchor.ts';
import { commitFact } from './facts.ts';
import { pendingSubmissions } from './fold.ts';
import type { SessionLog } from './session-log.ts';
import type { JsonLinesWriter } from './streams.ts';
import type { SessionState } from './types.ts';

/**
 * A harness that cannot run on this machine, in a way a redelivery will not
 * change: its native binary is missing (or is not one this machine can
 * run), a module it loads is not installed, its runtime does not start.
 * Whoever drives the session next from the same bundle meets the same
 * failure, so the queue's redeliveries would only repeat it (with backoff,
 * while a client waits on a stream of keepalives).
 *
 * A direct drive with a queue message behind it (the drive route's,
 * `DeliverMeta.backstopped`) runs in another Function than the queue's
 * deliveries, and that one's bundle may have what this one lacks: it does
 * not fail the turn, it hands it to the queue at once (a continuation).
 * Only a queue delivery (or a direct drive with nothing behind it) fails it.
 *
 * The driver fails the **turn**, not the session: one `unavailable` fact
 * takes the turn's waiting messages (it places them, with the error), a
 * live `{ type: 'error', code, message, hint }` and an `idle` end the
 * turn's stream, and the delivery acks. The session stays running: the next
 * message drives the harness again (a fixed deployment, a package installed
 * since), and a process harness starts it as a new turn, with no recovery
 * note for the failed one. A turn misjudged as failed costs a resend; a
 * session failed for a deploy mistake would lose its conversation.
 *
 * Thrown by a harness (or the process host) that knows it cannot start;
 * the driver also recognizes the common cases by their errors (see
 * `unavailableOf`). Everything else still ends the delivery with its error,
 * and the queue redelivers.
 */
export class Unavailable extends Error {
  readonly code: UnavailableCode;
  readonly hint?: string;
  constructor(message: string, options: { code?: UnavailableCode; hint?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'Unavailable';
    this.code = options.code ?? 'unavailable';
    if (options.hint) this.hint = options.hint;
  }
}

/**
 * - `binary_missing`: a native binary the harness runs is not on this machine;
 * - `binary_unusable`: it is there but cannot run here (not executable, another platform's, a native addon that does not load);
 * - `module_missing`: a module or package file it loads is not installed;
 * - `sandbox_required`: a harness that runs only in a Vercel Sandbox was given no sandbox machine (Claude Code, Codex without `workspace: sandbox()`); docs/workspaces.md §6 rule 1. A1's A0 note names this and `cli_version` as A5's additions; the sandbox tier (A2+) needs `sandbox_required` for its harness backstop, so it lands here;
 * - `cli_version`: a session's recorded CLI version is newer than the image's, so a resume would downgrade it (docs/workspaces.md §5.2); added with `sandbox_required` for the same reason. Both fail the turn on purpose (no redelivery changes them); a sandbox that is only busy or lost for now is never an `Unavailable`: a busy VM or Drive is `Yield('contended')`, and a lost link is a transport error the driver re-attaches from (docs/workspaces.md §5.3, §5.4);
 * - `unavailable`: anything else a harness says it cannot start with;
 * - `failing`: an error the driver does not recognize failed this many deliveries of one message in a row (`maxFailedDeliveries`).
 */
export type UnavailableCode = 'binary_missing' | 'binary_unusable' | 'module_missing' | 'sandbox_required' | 'cli_version' | 'unavailable' | 'failing';

/** What the `unavailable` fact records, and what its live `error` event says. */
export interface UnavailableInfo {
  code: UnavailableCode;
  /** The error, on one line, without its stack. */
  message: string;
  /** What to do about it. */
  hint?: string;
}

/** The fact step's name: a turn the harness could not run. */
export const UNAVAILABLE_STEP = 'unavailable';

/** The `unavailable` fact's input (also its outcome). */
export interface UnavailableInput extends UnavailableInfo {
  /** The harness that could not run (its kernel name). */
  harness: string;
  /** Which delivery of its message met it (1: the first). */
  attempt?: number;
}

const MODULE = /\bCannot find (?:module|package) '([^']+)'/;
const CLAUDE_MISSING = /\bClaude Code (?:native binary|executable) not found at\b|\bNative CLI binary for \S+ not found\b/;
const CLAUDE_UNUSABLE = /\bClaude Code (?:native binary|executable) at .+ exists but failed to launch\b/;
const NATIVE_UNUSABLE = /\b(?:invalid ELF header|wrong ELF class|cannot open shared object file|ERR_DLOPEN_FAILED|Exec format error)\b/;
/**
 * A child that a signal ended (`codex app-server exited (signal SIGKILL)`,
 * `the Cursor host exited (SIGKILL)`): it started and ran, so its stderr
 * tail in the message is not why (an out-of-memory kill after a warning
 * that names a missing library is a redelivery's to retry).
 */
const KILLED = /\bexited \((?:signal )?SIG[A-Z0-9]+\)/;

/**
 * Whether `error` says the harness cannot run here, and how: an
 * `Unavailable` anywhere in its cause chain (thrown by a harness or the
 * process host, which checks a binary that failed to spawn is really
 * missing, not a missing working directory), a module that is not installed
 * (`ERR_MODULE_NOT_FOUND`, `MODULE_NOT_FOUND`, or "Cannot find module '…'"
 * in the message of an error a child process reported), a native addon that
 * does not load, the Claude Agent SDK's own "binary not found". Conservative
 * on purpose: a spawn `ENOENT` on its own is not enough (it is also what a
 * missing working directory gives), and network, World and timeout errors
 * are never this.
 */
export function unavailableOf(error: unknown): UnavailableInfo | undefined {
  const chain = causes(error);
  for (const e of chain) {
    if (isUnavailable(e)) return { code: e.code, message: oneLine(e.message), ...(e.hint ? { hint: e.hint } : {}) };
  }
  for (const e of chain) {
    const { code, errorClass } = (e ?? {}) as { code?: unknown; errorClass?: unknown };
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return { code: 'module_missing', message: oneLine(messageOf(e)) };
    if (code === 'ERR_DLOPEN_FAILED') return { code: 'binary_unusable', message: oneLine(messageOf(e)) };
    // The Claude Agent SDK's own classes for its binary.
    if (errorClass === 'executable_not_found') return { code: 'binary_missing', message: oneLine(messageOf(e)) };
    if (errorClass === 'executable_launch_failed') return { code: 'binary_unusable', message: oneLine(messageOf(e)) };
  }
  for (const e of chain) {
    const text = messageOf(e);
    if (KILLED.test(text)) continue;
    const found =
      ([[MODULE, 'module_missing'], [CLAUDE_MISSING, 'binary_missing'], [CLAUDE_UNUSABLE, 'binary_unusable'], [NATIVE_UNUSABLE, 'binary_unusable']] as const)
        .map(([pattern, code]) => ({ code, at: pattern.exec(text)?.index }))
        .find((f) => f.at !== undefined);
    // From the line that says it (a child's stderr tail can put it after other output).
    if (found) return { code: found.code, message: oneLine(text.slice(text.lastIndexOf('\n', found.at!) + 1)) };
  }
  return undefined;
}

/**
 * An error the driver does not recognize, on a delivery that is already the
 * `max`-th of its message: every earlier one failed (or died), so the turn
 * is failed with `failing` rather than redelivered forever. Errors that
 * carry an HTTP status or a retry-after (the World's, the network's) and
 * network error codes never count: those are the World's to retry.
 */
export function failingOf(error: unknown, attempt: number | undefined, max: number): UnavailableInfo | undefined {
  if (!Number.isFinite(max) || max <= 0 || (attempt ?? 1) < max) return undefined;
  if (causes(error).some(isTransport)) return undefined;
  return { code: 'failing', message: oneLine(`failed on ${attempt} deliveries in a row: ${messageOf(error)}`) };
}

/** Default `DriverOptions.maxFailedDeliveries`. */
export const MAX_FAILED_DELIVERIES = 8;

const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);
function isTransport(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const x = e as { status?: unknown; retryAfter?: unknown; code?: unknown; name?: unknown };
  if (typeof x.status === 'number' || typeof x.retryAfter === 'number') return true;
  if (typeof x.code === 'string' && TRANSPORT_CODES.has(x.code)) return true;
  return x.name === 'AbortError' || x.name === 'TimeoutError' || (typeof x.name === 'string' && /World|Throttle|TooEarly/.test(x.name));
}

/** `error`, its `cause`s, an AggregateError's errors, and an `EffectFailure`'s committed error. */
function causes(error: unknown): unknown[] {
  const out: unknown[] = [];
  const queue = [error];
  while (queue.length > 0 && out.length < 16) {
    const e = queue.shift();
    if (e === undefined || e === null || out.includes(e)) continue;
    out.push(e);
    if (typeof e !== 'object') continue;
    const x = e as { cause?: unknown; errors?: unknown; error?: unknown; name?: unknown };
    if (x.cause !== undefined) queue.push(x.cause);
    if (Array.isArray(x.errors)) queue.push(...x.errors);
    if (x.name === 'EffectFailure' && x.error && typeof x.error === 'object') queue.push(x.error);
  }
  return out;
}

/** By shape, not `instanceof`: a harness may carry its own copy of this module. */
function isUnavailable(e: unknown): e is Unavailable {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'Unavailable' && typeof (e as { code?: unknown }).code === 'string';
}

function messageOf(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}

/** The first lines of a message, without a stack, at most 1000 characters. */
function oneLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const kept = lines.filter((l) => l && !/^at\s/.test(l) && !/^Require stack:?$/.test(l) && !/^- \//.test(l));
  const joined = kept.slice(0, 3).join(' ');
  return joined.length > 1000 ? `${joined.slice(0, 1000)}…` : joined;
}

/** A generic hint per code (an app's `unavailableHint` can say more). */
export function defaultHint(info: UnavailableInfo, harness: string): string {
  switch (info.code) {
    case 'binary_missing':
      return `${harness}'s native binary is not on this machine. Install its package; on a serverless Function, include the binary in every Function that drives sessions.`;
    case 'binary_unusable':
      return `${harness}'s native binary is on this machine but cannot run here (another platform's build, or not executable).`;
    case 'module_missing':
      return `A module ${harness} loads is not installed here. Install it; on a serverless Function, include the file in every Function that drives sessions.`;
    case 'failing':
      return `${harness} keeps failing on this machine. The error is in the log; the next message tries again.`;
    case 'sandbox_required':
      return `${harness} runs only in a Vercel Sandbox. Pass workspace: sandbox().`;
    case 'cli_version':
      return `${harness}'s recorded version is newer than this deployment's. Deploy a build whose pinned CLI is at least as new to resume this session.`;
    default:
      return `${harness} cannot run on this machine.`;
  }
}

/**
 * Fail the turn: one `unavailable` fact at the drive's epoch that places
 * every message waiting (first writer wins, as for any fact; a withdraw that
 * landed first makes it lose, and it is written again without that
 * message), then the live `error` and `idle`. Returns false when the epoch
 * moved (another drive owns the session now, and decides for itself).
 */
export async function commitUnavailable(
  log: SessionLog,
  live: JsonLinesWriter,
  input: UnavailableInput,
  by: { epoch: number; drv: string; anchor?: Anchor }
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const placed = pendingSubmissions(log.state).map((s) => s.id);
    const { won, fenced } = await commitFact(log, UNAVAILABLE_STEP, `${UNAVAILABLE_STEP}:${by.drv}:${attempt}`, input, {
      epoch: by.epoch,
      drv: by.drv,
      ...(by.anchor ? { anchor: by.anchor } : {}),
      placed,
    });
    if (fenced) return false;
    if (won) {
      const { harness: _h, attempt: _a, ...event } = input;
      live.write({ type: 'error', ...event });
      live.write({ type: 'idle' });
      await live.flush();
      return true;
    }
    await log.refresh();
  }
  return false;
}

/** The `effectOrder` index of the session's last `unavailable` fact (-1: none). A turn it failed is over. */
export function lastUnavailable(state: SessionState): number {
  for (let i = state.effectOrder.length - 1; i >= 0; i--) if (state.effectOrder[i]!.name === UNAVAILABLE_STEP) return i;
  return -1;
}
