import type { DurableSessions, SessionState } from 'harness-world';

/**
 * libfx's agent shape, backed by a durable harness-world session. Kept for
 * the kernel's tests: an app that wants a durable fx agent uses libfx's own
 * `createFxAgent` (vercel-labs/fx#1180; apps/durable-fx), not this.
 *
 * libfx's `createFxEngine()` gives you a kernel in this process: a crash loses the
 * turn. `createDurableFxAgent()` gives you a handle on a session that lives
 * in a Workflow World. `prompt()` appends to the session's log; the turn
 * runs wherever the World's queue delivers it (a Vercel Function, or this
 * process under world-local), and survives that process dying. This handle
 * only watches: iterating a turn tails the session's live stream, and
 * `result` resolves from the log, so it is right even if the stream dropped
 * events or the turn finished before anyone looked.
 */
export interface DurableFxAgent {
  /** The session (a workflow run id). Keep it to reattach later. */
  readonly sessionId: string;
  prompt(input: string): DurableFxTurn;
  /**
   * Reattach to a turn started earlier, maybe by another process, by its
   * submission id. Streams from now on; `result` comes from the log.
   */
  turn(submissionId: string): DurableFxTurn;
  /** The oldest prompt whose turn has not finished, if any: pass it to `turn()`. */
  unfinished(): Promise<string | undefined>;
  /** Detach this handle. The session keeps running and can be reopened. */
  close(): Promise<void>;
  /** End the session for good (`run_completed`). */
  end(): Promise<void>;
}

export interface DurableFxTurn extends AsyncIterable<DurableFxEvent> {
  /** The submission id of this turn's prompt. */
  readonly submissionId: Promise<string>;
  /** Resolves when the turn's checkpoint commits; rejects if the session fails. */
  readonly result: Promise<DurableFxTurnResult>;
  /** Steer the turn: lands at the next model boundary, durably. */
  steer(text: string): Promise<void>;
  /**
   * Withdraw the prompt if the session has not started it yet. Once a turn
   * is running it runs to completion somewhere; cancel only stops watching.
   */
  cancel(): Promise<'withdrawn' | 'already_placed'>;
}

/** libfx's events, minus what a durable session cannot see from outside. */
export type DurableFxEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; name: string; input?: unknown }
  | { type: 'tool_end'; name: string; isError?: boolean }
  | { type: 'handoff'; from: string; to: string; reason: string }
  | { type: 'crash'; effect: string };

export interface DurableFxTurnResult {
  stopReason: string;
  usage?: unknown;
  /** Set when the turn ended in an error. */
  error?: string;
}

export interface DurableFxAgentOptions {
  sessions: DurableSessions;
  /** Reattach to an existing session. Omit to start a new one. */
  sessionId?: string;
  /** Which of `sessions`' harnesses to start a new session with. */
  harness?: string;
  /** How often `result` re-reads the log when the live stream is quiet. Default 1500ms. */
  pollMs?: number;
}

export async function createDurableFxAgent(options: DurableFxAgentOptions): Promise<DurableFxAgent> {
  const { sessions } = options;
  const pollMs = options.pollMs ?? 1500;
  const sessionId =
    options.sessionId ?? (await sessions.start(options.harness ? { harness: options.harness } : {})).sessionId;
  const detach = new AbortController();

  function makeTurn(sent: Promise<{ from: number; id: string }>): DurableFxTurn {
    const submissionId = sent.then((s) => s.id);
    const done = new AbortController();
    const result = (async () => {
      const { id } = await sent;
      for (;;) {
        const outcome = turnOutcome(await sessions.inspect(sessionId), id);
        if (outcome) {
          done.abort();
          return outcome;
        }
        await sleep(pollMs, AbortSignal.any([detach.signal, done.signal]));
        if (detach.signal.aborted) throw new Error('durable fx agent: closed');
      }
    })();
    result.catch(() => done.abort());

    return {
      submissionId,
      result,
      async steer(text) {
        // After this turn's prompt: `prompt()` sends it asynchronously, and a
        // steer committed first would run as a turn of its own, before it.
        await sent;
        await sessions.send(sessionId, text, 'steer');
      },
      async cancel() {
        const outcome = await sessions.withdraw(sessionId, await submissionId);
        if (outcome === 'withdrawn') done.abort();
        return outcome;
      },
      async *[Symbol.asyncIterator]() {
        const { from } = await sent;
        const signal = AbortSignal.any([detach.signal, done.signal]);
        if (signal.aborted) return; // The turn finished before anyone looked.
        try {
          // Output of this turn seen yet. The previous turn's last lines
          // (its `idle`, timing marks) can still be landing when this tail
          // starts, so an `idle` before any output of ours is not our end.
          let ours = false;
          for await (const raw of sessions.live(sessionId, { startIndex: from, signal })) {
            const event = toFxEvent(raw as LiveEvent);
            if (event) {
              ours = true;
              yield event;
            }
            // `idle` ends the turn in the UI's view; `result` decides for real.
            if ((raw as LiveEvent).type === 'idle' && ours) break;
          }
        } catch (err) {
          if (!signal.aborted) throw err;
        }
      },
    };
  }

  return {
    sessionId,

    prompt(input) {
      // Where the live stream ends before the prompt lands, so a tail starts
      // at this turn and not at the start of the session.
      return makeTurn(
        (async () => {
          const from = await sessions.liveEnd(sessionId);
          return { from, id: await sessions.send(sessionId, input) };
        })()
      );
    },

    async unfinished() {
      const state = await sessions.inspect(sessionId);
      return state.submissions.find(
        (s) => (s.kind === 'prompt' || s.kind === 'followUp') && !turnOutcome(state, s.id)
      )?.id;
    },

    turn(submissionId) {
      return makeTurn(sessions.liveEnd(sessionId).then((from) => ({ from, id: submissionId })));
    },

    async close() {
      detach.abort();
    },

    async end() {
      detach.abort();
      await sessions.close(sessionId);
    },
  };
}

type LiveEvent = { type: string; [key: string]: any };

function toFxEvent(e: LiveEvent): DurableFxEvent | undefined {
  switch (e.type) {
    case 'text':
      return { type: 'text_delta', delta: e.delta };
    case 'tool_start':
      return { type: 'tool_start', name: e.name, input: e.args };
    case 'tool_end':
      return { type: 'tool_end', name: e.name, isError: e.isError };
    case 'lane':
      return { type: 'handoff', from: e.from, to: e.to, reason: e.reason };
    case 'chaos':
      return { type: 'crash', effect: e.effect };
    default:
      return undefined;
  }
}

/**
 * The turn's outcome, read from the log: the first checkpoint committed
 * after the effect that placed this prompt. Undefined while it is running.
 */
export function turnOutcome(state: SessionState, submissionId: string): DurableFxTurnResult | undefined {
  if (state.status === 'failed') throw new Error(state.failure?.message ?? 'durable fx agent: session failed');
  if (state.withdrawn.has(submissionId)) return { stopReason: 'withdrawn' };
  const placedAt = state.effectOrder.findIndex((e) => e.placed.includes(submissionId));
  if (placedAt === -1) {
    if (state.status !== 'running') throw new Error(`durable fx agent: session is ${state.status}`);
    return undefined;
  }
  const checkpoint = state.effectOrder
    .slice(placedAt)
    .find((e) => e.name === 'checkpoint' && e.status === 'completed');
  if (!checkpoint) return undefined;
  const out = checkpoint.output as { stopReason: string; usage?: unknown; error?: string };
  return { stopReason: out.stopReason, ...(out.usage ? { usage: out.usage } : {}), ...(out.error ? { error: out.error } : {}) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
