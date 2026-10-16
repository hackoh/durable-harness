/**
 * The messages between the drive (the kernel `Harness`, in the app's
 * process) and the OpenCode host (OpenCode's embedded server plus our
 * plugin, in the same process).
 *
 * The drive owns everything durable: the journal, the tools, the inbox. The
 * host owns OpenCode. So the host sends what OpenCode committed (`events`),
 * asks before every model request (`barrier`) and runs every tool call
 * through the drive (`tool`); the drive answers each request with a `reply`
 * and tells the host what to do (`prompt`, `recover`, `close`).
 *
 * The host runs in the drive's process (OpenCode's embedded server), and
 * the two talk over an in-process pipe (`pipePair`) that copies every
 * message as JSON would: neither side shares objects with the other. The
 * one thing that crosses by reference is the session's workspace, which the
 * host gets as an argument of `runHost` (environment.ts), not as a message.
 * No Node or OpenCode imports here.
 */

/** One committed OpenCode event, as OpenCode's `event` table stores it and `Bus.replay` takes it. */
export interface OpenCodeEvent {
  /** OpenCode's event id (`evt_…`). */
  id: string;
  /** The event's position in its session (0-based, contiguous). */
  seq: number;
  /** Milliseconds since the epoch. */
  created: number;
  /** The versioned type, e.g. `session.tool.called.1`. */
  type: string;
  /** The event's data, encoded. */
  data: Record<string, any>;
}

/**
 * An instruction blob: state OpenCode writes in a commit hook of
 * `session.instructions.updated` (whose event holds only the hash). It
 * carries the date and the working directory, so it cannot be recomputed on
 * another machine; the drive journals it next to the events.
 */
export interface InstructionBlob {
  hash: string;
  value: unknown;
}

/** A tool as the host registers it with OpenCode. */
export interface HostToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Everything the host needs to rebuild the session and run it. */
export interface HostInit {
  /** OpenCode's session id (`ses_<runId>`). */
  sessionId: string;
  /**
   * OpenCode's working directory for a new session: `/workspace`, a path of
   * the session's workspace (never a directory of this machine; a rebuilt
   * session keeps the one it was created with).
   */
  directory: string;
  /** The SQLite file. Absolute. Rebuilt by every drive. */
  dbPath: string;
  /** OpenCode's global config directory (empty: no user config, plugins or credentials). */
  configDir: string;
  /**
   * The session's own directory on this machine for OpenCode's global paths
   * (its home, data, cache, config, state, tmp): this drive's, empty, and
   * removed with it. Nothing OpenCode reads on this machine is outside it,
   * the database and the config directory.
   */
  global: string;
  /** `vercel/<gateway model id>`. */
  model: string;
  /** The AI Gateway base URL for OpenCode's `vercel` provider: the drive's loopback proxy. */
  gatewayBaseURL: string;
  /** A placeholder for the provider's key: the proxy replaces it with the real credential. */
  gatewayKey: string;
  /** The drive's tools (next to OpenCode's own `builtins`, else the session's only tools). */
  tools: HostToolSpec[];
  /**
   * OpenCode's own tools that are on, on the session's workspace (empty: the
   * drive's tools are the only ones). Each call asks the drive before it
   * runs and reports after (`builtin`), and runs on the workspace the drive
   * opened for it.
   */
  builtins: string[];
  /**
   * What each built-in's description gets after OpenCode's own, saying where
   * it runs (`shell`) and how long its files last (both). Empty strings: nothing.
   */
  notes?: { shell: string; file: string };
  /** Added to every model request's system prompt. */
  system: string;
  /** The session's title (OpenCode's own title request is skipped). */
  title: string;
  /** The session's committed events, in order: the log's copy, replayed into an empty database. */
  events: OpenCodeEvent[];
  /** The instruction blobs those events reference. */
  blobs: InstructionBlob[];
  /** The events leave OpenCode's execution claim held (see `OpenCodeStatus.claimHeld`). */
  claim: boolean;
  /** Restart notices since the turn began (OpenCode's resume budget counts them). */
  restarts: number;
}

/** Host → drive. */
export type FromHost =
  /** The session is rebuilt up to `seq` (-1: a new session) and the plugin is active. */
  | { type: 'ready'; seq: number }
  /** Events OpenCode committed, in order, with the blobs they reference that were not sent yet. */
  | { type: 'events'; events: OpenCodeEvent[]; blobs: InstructionBlob[] }
  /** OpenCode is about to make a model request: reply once everything sent so far is durable. */
  | { type: 'barrier'; id: number; kind: string }
  /** OpenCode called a tool: reply with its result. */
  | { type: 'tool'; id: number; callId: string; name: string; input: unknown }
  /**
   * OpenCode is about to run one of its own tools (`begin`: reply `ok` once
   * its intent is in the log, or refuse it), or ran it (`end`: its outcome).
   */
  | { type: 'builtin'; id: number; phase: 'begin'; callId: string; name: string; input: unknown }
  | { type: 'builtin'; id: number; phase: 'end'; callId: string; name: string; text: string; isError: boolean }
  /** A live text delta (ephemeral: never in the log). */
  | { type: 'text'; delta: string }
  /** The answer to a `prompt` or `recover`. */
  | { type: 'reply'; id: number; ok: boolean; error?: string }
  /** The host failed and is exiting. */
  | { type: 'error'; message: string };

/** Drive → host. */
export type ToHost =
  /**
   * The answer to a `barrier`, `tool` or `builtin`. To a built-in's `end`:
   * `note`, a line the model sees before the call's result (its workspace
   * was reset), and `failed`, the failure the log recorded for a call
   * OpenCode reported as done (what it changed could not be kept): the
   * model sees that instead.
   */
  | { type: 'reply'; id: number; ok: true; text?: string; isError?: boolean; note?: string; failed?: string }
  | { type: 'reply'; id: number; ok: false; error: string }
  /** Admit a user message (idempotent by `id`, OpenCode's `msg_…` id). */
  | { type: 'prompt'; id: number; messageId: string; text: string; delivery: 'queue' | 'steer' }
  /**
   * Resume a turn a crash cut off: add `note` as a synthetic message without
   * starting a drain, hold the execution claim, and run OpenCode's own
   * restart sweep (which continues the turn).
   */
  | { type: 'recover'; id: number; note: string }
  /** Dispose OpenCode and exit. */
  | { type: 'close' };

/** A two-way message channel (an in-process pipe). */
export interface Channel<In, Out> {
  send(message: Out): void;
  /** Messages in order; ends when the other side closes or exits. */
  messages: AsyncIterable<In>;
}

/**
 * An in-process channel pair (the embedded host): what one side sends, the
 * other receives, asynchronously, in order.
 */
export function pipePair<A, B>(): { left: Channel<A, B> & { close(): void }; right: Channel<B, A> & { close(): void } } {
  const a = queue<A>();
  const b = queue<B>();
  return {
    // left sends B (to right), receives A
    left: { send: (m) => b.push(m), messages: a.iterable, close: () => b.end() },
    right: { send: (m) => a.push(m), messages: b.iterable, close: () => a.end() },
  };
}

function queue<T>() {
  const items: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const iterable: AsyncIterable<T> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    },
  };
  return {
    iterable,
    push(item: T) {
      if (ended) return;
      // Copy, as a pipe would: neither side shares objects with the other.
      items.push(JSON.parse(JSON.stringify(item)) as T);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}
