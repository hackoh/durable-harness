import {
  EntityConflictError,
  HookConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  StreamError,
  StreamExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';

/**
 * JSON with the values World payloads actually carry preserved: `Uint8Array`
 * (step I/O, stream chunks), `Date` (every entity timestamp) and `undefined`
 * (optional positional arguments, which plain JSON turns into `null`).
 */
export const wire = {
  stringify(value: unknown): string {
    return JSON.stringify(value, function (key, v) {
      // `this[key]` is the value before `toJSON` ran: a Date is still a
      // Date, and a Node Buffer has not become `{ type: 'Buffer', data }`.
      const raw = (this as Record<string, unknown>)[key];
      if (raw instanceof Uint8Array) return { __wr: 'u8', v: toBase64(raw) };
      if (raw instanceof Date) return { __wr: 'date', v: raw.toISOString() };
      if (raw === undefined) return { __wr: 'undef' };
      return v;
    });
  },
  parse(text: string): unknown {
    return JSON.parse(text, (_key, v) => {
      if (v && typeof v === 'object' && typeof v.__wr === 'string') {
        if (v.__wr === 'u8') return fromBase64(v.v);
        if (v.__wr === 'date') return new Date(v.v);
        // Deletes the property from its holder: an absent key, or an array hole.
        if (v.__wr === 'undef') return undefined;
      }
      return v;
    });
  },
};

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** An error as it crosses the wire: its name, message and primitive fields. */
export interface WireError {
  name: string;
  message: string;
  [field: string]: unknown;
}

export function serializeError(err: unknown): WireError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err) };
  const out: WireError = { name: err.name, message: err.message };
  for (const [key, value] of Object.entries(err)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
    if (value === null || value instanceof Date || typeof value !== 'object') {
      if (typeof value !== 'function') out[key] = value;
    } else if (key === 'details') {
      out[key] = value; // PreconditionFailedError's missing events: plain data.
    }
  }
  return out;
}

/** HTTP status for an error thrown by the fronted World. */
export function statusForError(err: WireError): number {
  if (typeof err.status === 'number' && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  switch (err.name) {
    case 'WorkflowRunNotFoundError':
    case 'HookNotFoundError':
      return 404;
    case 'EntityConflictError':
    case 'HookConflictError':
      return 409;
    case 'RunExpiredError':
    case 'StreamExpiredError':
      return 410;
    case 'PreconditionFailedError':
      return 412;
    case 'TooEarlyError':
      return 425;
    case 'ThrottleError':
      return 429;
    default:
      return 500;
  }
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const date = (v: unknown) => (v instanceof Date ? v : undefined);

/**
 * Rebuild a World error on the client. Known names get their real
 * `@workflow/errors` class (so `instanceof` and `X.is()` both hold); any
 * other name becomes a `WorkflowWorldError` that keeps the original `name`,
 * which is what name-based checks look at.
 */
export function rehydrateError(e: WireError, httpStatus?: number): Error {
  const { name, message } = e;
  let err: Error;
  switch (name) {
    case 'EntityConflictError':
      err = new EntityConflictError(message);
      break;
    case 'RunExpiredError':
      err = new RunExpiredError(message, str(e.runId), str(e.runStatus), date(e.expiredAt));
      break;
    case 'StreamExpiredError':
      err = new StreamExpiredError(message, str(e.runId), str(e.streamId), date(e.expiredAt));
      break;
    case 'StreamError':
      err = new StreamError(message, { status: num(e.status), url: str(e.url) });
      break;
    case 'HookNotFoundError':
      err = new HookNotFoundError(str(e.token) ?? '');
      break;
    case 'HookConflictError':
      err = new HookConflictError(str(e.token) ?? '', str(e.conflictingRunId));
      break;
    case 'WorkflowRunNotFoundError':
      err = new WorkflowRunNotFoundError(str(e.runId) ?? '');
      break;
    case 'TooEarlyError':
      err = new TooEarlyError(message, { retryAfter: num(e.retryAfter) });
      break;
    case 'ThrottleError':
      err = new ThrottleError(message, { retryAfter: num(e.retryAfter) });
      break;
    case 'PreconditionFailedError':
      err = new PreconditionFailedError(message, {
        retryAfter: num(e.retryAfter),
        details: e.details,
      });
      break;
    default:
      err = new WorkflowWorldError(message, {
        status: num(e.status) ?? httpStatus,
        code: str(e.code),
        url: str(e.url),
        retryAfter: num(e.retryAfter),
        field: str(e.field),
      });
      err.name = name;
  }
  for (const [key, value] of Object.entries(e)) {
    if (key !== 'name' && key !== 'message' && value !== undefined) {
      (err as unknown as Record<string, unknown>)[key] = value;
    }
  }
  // Several constructors synthesize their own message; keep the server's.
  err.message = message;
  return err;
}

/**
 * Frames of a `streams.get` response body. Each frame is a 1-byte type and a
 * 4-byte big-endian payload length, then the payload.
 *
 * - `data`: bytes of the stream, in order.
 * - `end`: the stream is closed; nothing follows.
 * - `reconnect`: the server ended this response on purpose (its time budget
 *   ran out). Reconnect and skip the bytes already received.
 * - `error`: the fronted World failed the read; payload is a wire error.
 */
export const FRAME = { data: 0, end: 1, reconnect: 2, error: 3 } as const;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];

export function encodeFrame(type: FrameType, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

/** Pulls whole frames out of a byte stream with arbitrary chunk boundaries. */
export class FrameReader {
  private buffer = new Uint8Array(0);

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** The next frame, or `undefined` if the body ended (cleanly or not) first. */
  async next(): Promise<{ type: FrameType; payload: Uint8Array } | undefined> {
    if (!(await this.fill(5))) return undefined;
    const length = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength
    ).getUint32(1, false);
    if (!(await this.fill(5 + length))) return undefined;
    const type = this.buffer[0] as FrameType;
    const payload = this.buffer.slice(5, 5 + length);
    this.buffer = this.buffer.subarray(5 + length);
    return { type, payload };
  }

  cancel(): Promise<void> {
    return this.reader.cancel().catch(() => {});
  }

  private async fill(needed: number): Promise<boolean> {
    while (this.buffer.length < needed) {
      const { value, done } = await this.reader.read();
      if (done) return false;
      if (!value?.length) continue;
      const next = new Uint8Array(this.buffer.length + value.length);
      next.set(this.buffer, 0);
      next.set(value, this.buffer.length);
      this.buffer = next;
    }
    return true;
  }
}
