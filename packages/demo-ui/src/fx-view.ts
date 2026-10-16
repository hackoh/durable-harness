import type { ChaosSpec, EffectView, EventPage, SessionView, SubmissionView } from './view.ts';

/**
 * An "fx (libfx durable)" session in the page's view model. libfx owns the
 * session (`createFxAgent` on this server's World): the page follows the
 * session's stream (`session.stream(cursor)`, NDJSON, one event per line
 * with a `cursor`) and this module turns those lines into the same
 * `SessionView` and event rows the other harnesses fold from their logs.
 * Pure: no World, no libfx.
 */

export const FX_DURABLE = 'fx-durable';
/** The workflow name libfx gives a session's World run. */
export const LIBFX_WORKFLOW = 'libfx/session';

/** One line of a libfx session stream, stamped with when this client received it. */
export interface FxLine {
  type: string;
  cursor: number;
  epoch?: number;
  messageId?: string;
  sessionId?: string;
  input?: unknown;
  delta?: string;
  text?: string;
  id?: string;
  name?: string;
  content?: string;
  isError?: boolean;
  stopReason?: string;
  error?: { message?: string };
  /** Milliseconds since the epoch. The stream carries no times, so this is when the line arrived here. */
  at: number;
}

export type FxChaosLine =
  | { t: 'armed'; at: number; spec: ChaosSpec }
  | { t: 'fired'; at: number; spec: ChaosSpec; effectKey?: string; effectName?: string };

/** The workspace after one call that can change it, keyed by the call's `executionId`. */
export interface FxWorkspaceRecord {
  executionId: string;
  tool: string;
  output: string;
  files: Record<string, string>;
  at: number;
}

/** The session's workspace as the page needs it: its newest record, and how many there are. */
export interface FxWorkspace {
  latest?: FxWorkspaceRecord;
  count: number;
}

/** What the app records beside libfx, as `/api/fx-durable/<id>/side` returns it. */
export interface FxSide {
  /** Every line of the crash stream (the page places each fired crash). */
  chaos: FxChaosLine[];
  workspace: FxWorkspace;
}

const textOf = (input: unknown): string =>
  typeof input === 'string'
    ? input
    : Array.isArray(input)
      ? input.map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : '')).join('')
      : '';

const stopMessage: Record<string, string> = {
  cancelled: 'the turn was cancelled',
  unknown: 'the process that ran this turn stopped before recording how it ended',
};

type Effect = EffectView & { text?: string };

/**
 * The session as the page shows it, and its event rows, from the stream's
 * lines (in cursor order), the crash stream and the workspace.
 *
 * Model calls are not marked on the stream, so each run of output between
 * tool calls is one `model` effect. A `turn_resume` that does not follow a
 * `turn_yield` is a takeover after a crash: a model call that was streaming
 * starts again (its attempt counts up), and a tool call that was running is
 * interrupted until libfx runs it again, which its next `tool_start` shows.
 */
export function fxProjection(
  sessionId: string,
  lines: FxLine[],
  chaos: FxChaosLine[] = [],
  workspace: FxWorkspace = { count: 0 }
): { view: SessionView; events: EventPage['events'] } {
  const submissions: SubmissionView[] = [];
  const effects: Effect[] = [];
  const events: EventPage['events'] = [];
  const tools = new Map<string, Effect>();
  const iso = (ms: number) => new Date(ms).toISOString();
  const row = (line: FxLine, eventType: string, stepName: string, correlationId?: string) =>
    events.push({ eventId: `${sessionId}:line:${line.cursor}`, eventType, stepName, createdAt: iso(line.at), ...(correlationId ? { correlationId } : {}) });

  // Model calls a takeover cut off, in order: where a model-step crash goes.
  const cutModels: string[] = [];
  let turn: string | undefined;
  let placed = false;
  let yielded = false;
  let calls = 0;
  let model: Effect | undefined;
  // Steers sent while a step ran: the next step libfx starts took them, so their rows go before it (not at the transcript's end).
  let steers: string[] = [];
  const placeSteers = (effect: Effect) => {
    effect.placed.push(...steers);
    steers = [];
  };

  const openModel = (line: FxLine) => {
    model = { key: `model:${turn ?? 'turn'}:${++calls}`, stepId: '', name: 'model', status: 'running', attempt: 1, input: {}, output: { content: [] }, startedAt: iso(line.at), placed: [], text: '' };
    model.stepId = model.key;
    if (turn && !placed) {
      model.placed.push(turn);
      placed = true;
    }
    placeSteers(model);
    effects.push(model);
    row(line, 'step_started', 'model', model.key);
  };
  const closeModel = (line: FxLine, error?: { message: string }) => {
    if (!model) return;
    model.status = error ? 'failed' : 'completed';
    if (error) model.error = error;
    row(line, 'step_completed', 'model', model.key);
    model = undefined;
  };
  const interruptTools = (message: string) => {
    for (const t of tools.values()) {
      if (t.status !== 'running') continue;
      t.status = 'failed';
      t.output = undefined;
      t.error = { interrupted: true, message };
    }
  };

  for (const line of lines) {
    switch (line.type) {
      case 'turn_start': {
        turn = line.messageId;
        placed = false;
        yielded = false;
        submissions.push({ id: line.messageId ?? `line:${line.cursor}`, kind: 'prompt', text: textOf(line.input), placed: true, withdrawn: false });
        row(line, 'hook_received', 'turn_start');
        openModel(line);
        break;
      }
      case 'user_message': {
        submissions.push({ id: `steer:${line.cursor}`, kind: 'steer', text: line.text ?? '', placed: true, withdrawn: false });
        steers.push(`steer:${line.cursor}`);
        row(line, 'hook_received', 'steer');
        break;
      }
      case 'text_delta':
      case 'reasoning_delta': {
        if (!model) openModel(line);
        if (line.type === 'text_delta' && model) {
          model.text = (model.text ?? '') + (line.delta ?? '');
          model.output = { content: [{ type: 'text', text: model.text }] };
        }
        break;
      }
      case 'tool_start': {
        closeModel(line);
        const key = `tool:${line.id ?? line.cursor}`;
        const known = tools.get(key);
        if (known) {
          // libfx runs the call again after a takeover (an idempotent tool).
          known.attempt += 1;
          known.status = 'running';
          known.error = undefined;
          known.output = undefined;
          known.startedAt = iso(line.at);
        } else {
          const effect: Effect = { key, stepId: key, name: `tool.${line.name ?? 'tool'}`, status: 'running', attempt: 1, input: line.input ?? {}, output: undefined, startedAt: iso(line.at), placed: [] };
          placeSteers(effect);
          tools.set(key, effect);
          effects.push(effect);
        }
        row(line, 'step_started', line.name ?? 'tool', key);
        break;
      }
      case 'tool_end': {
        const key = `tool:${line.id ?? line.cursor}`;
        const effect = tools.get(key);
        if (effect) {
          effect.status = line.isError ? 'failed' : 'completed';
          effect.output = line.isError ? undefined : { content: [{ type: 'text', text: line.content ?? '' }] };
          effect.error = line.isError ? { message: line.content || 'the tool failed' } : undefined;
        }
        row(line, 'step_completed', line.name ?? 'tool', key);
        break;
      }
      case 'turn_yield': {
        yielded = true;
        row(line, 'hook_received', 'turn_yield (deadline)');
        break;
      }
      case 'turn_resume': {
        if (!yielded) {
          interruptTools('the process running this call stopped');
          if (model) {
            cutModels.push(model.key);
            model.attempt += 1;
            model.text = '';
            model.output = { content: [] };
            model.startedAt = iso(line.at);
          }
        }
        yielded = false;
        row(line, 'hook_received', 'turn_resume');
        break;
      }
      case 'turn_end': {
        const stop = line.stopReason ?? 'end_turn';
        const failure = stop === 'error' ? line.error?.message || 'the turn failed' : stopMessage[stop];
        if (failure && !model) openModel(line);
        closeModel(line, failure ? { message: failure } : undefined);
        interruptTools(failure ?? 'the turn ended during this call');
        turn = undefined;
        row(line, 'hook_received', `turn_end (${stop})`);
        break;
      }
      default:
        break;
    }
  }

  // Crashes: a fired kill is a completed `chaos` effect, placed after the
  // step it killed: a tool call by its id, a model call (which the app knows
  // by its own key) by the takeovers that restarted one.
  let armed: ChaosSpec | undefined;
  chaos.forEach((line, i) => {
    if (line.t === 'armed') {
      armed = line.spec;
      return;
    }
    armed = undefined;
    const key = `chaos:${i}`;
    const killed = effects.some((e) => e.key === line.effectKey) ? line.effectKey : line.effectName === 'model' ? cutModels.shift() : undefined;
    const effect: Effect = {
      key,
      stepId: key,
      name: 'chaos',
      status: 'completed',
      attempt: 1,
      input: line.spec,
      output: { kind: 'process', crashedDuring: killed ?? line.effectKey, effect: line.effectName ?? 'a step', afterMs: line.spec.afterMs ?? 0 },
      startedAt: iso(line.at),
      placed: [],
    };
    const after = effects.findIndex((e) => e.key === killed);
    effects.splice(after < 0 ? effects.length : after + 1, 0, effect);
    events.push({ eventId: `${sessionId}:chaos:${i}`, eventType: 'step_completed', correlationId: key, stepName: `crash: ${line.effectName ?? 'a step'} (crash stream)`, createdAt: iso(line.at) });
  });

  for (const e of effects) delete e.text;
  return {
    view: {
      id: sessionId,
      harness: FX_DURABLE,
      status: 'running',
      // The page re-reads a view when this moves: crash lines and workspace records count too.
      eventCount: lines.length + chaos.length + workspace.count,
      ...(armed ? { armedChaos: armed } : {}),
      ...(fxBusy(lines) ? { working: true } : {}),
      submissions,
      effects,
      files: workspace.latest?.files ?? {},
      supersededStepIds: [],
    },
    events,
  };
}

/** Whether the stream shows a turn still open after these lines. */
export function fxBusy(lines: FxLine[]): boolean {
  let open = false;
  for (const line of lines) {
    if (line.type === 'turn_start' || line.type === 'turn_resume') open = true;
    else if (line.type === 'turn_end') open = false;
  }
  return open;
}

/** The text the running model call has produced so far (what a live view replays on attach). */
export function fxPartial(lines: FxLine[]): string {
  let text = '';
  for (const line of lines) {
    if (line.type === 'text_delta') text += line.delta ?? '';
    else if (line.type === 'tool_start' || line.type === 'turn_end' || line.type === 'turn_start' || line.type === 'turn_resume') text = '';
  }
  return text;
}

/**
 * The page's live events for one new line (see `DemoClient.live`): text,
 * tool starts and ends, `idle` once the session has no turn left, and a
 * neutral `line` for the rest, which only makes the page read the view
 * again. No marks: the pages' turn timing (`LatencyTracker`) takes marks for
 * the durable kernel's, after which only its `idle` mark ends a turn.
 */
export function fxLiveEvents(line: FxLine, busyAfter: boolean): unknown[] {
  const t = line.at;
  if (line.type === 'text_delta') return line.delta ? [{ type: 'text', delta: line.delta, t }] : [];
  if (line.type === 'reasoning_delta') return [];
  if (line.type === 'tool_start') return [{ type: 'tool_start', name: line.name ?? 'tool', t }];
  if (line.type === 'tool_end') return [{ type: 'tool_end', name: line.name ?? 'tool', isError: !!line.isError, t }];
  if (line.type === 'turn_resume') return [{ type: 'rewind', reason: 'resume', t }];
  if (line.type === 'turn_end' && !busyAfter) return [{ type: 'idle', t }];
  return [{ type: 'line', name: line.type, t }];
}
