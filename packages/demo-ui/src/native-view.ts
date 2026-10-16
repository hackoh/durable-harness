import type { EffectView, EventPage, SessionView, SubmissionView } from './view.ts';

/**
 * A native session's transcript (plain Pi / fx, nothing recorded): a fold of
 * the events the turn streams (`text`, `tool_start`, `tool_end`, `error`,
 * `idle`) into the same `SessionView` the durable lanes project from their
 * log, so the main page renders it with the same rows. The model effect that
 * is open while text streams is `running`, which is what makes the transcript
 * show the live tokens (the page's live buffer) instead of a finished row.
 */
export class NativeFold {
  private submissions: SubmissionView[] = [];
  private effects: EffectView[] = [];
  private n = 0;
  private open?: EffectView;
  private pendingPlace: string[] = [];
  /** What the page saw (nothing is recorded): one row per structural change, so a refresh knows to re-read. */
  private log: EventPage['events'] = [];
  busy = false;

  constructor(
    readonly id: string,
    readonly harness: string
  ) {}

  /** A prompt (or a steer that did not land) waiting for the next turn. */
  submit(text: string, kind: 'prompt' | 'steer' = 'prompt'): string {
    const id = `${this.id}:s${this.submissions.length}`;
    this.submissions.push({ id, kind, text, placed: false, withdrawn: false });
    this.note(kind, undefined, id);
    return id;
  }

  /** A turn starts on these submissions: they are placed, and the first model call opens. */
  begin(subIds: string[]) {
    this.busy = true;
    for (const s of this.submissions) if (subIds.includes(s.id)) s.placed = true;
    this.pendingPlace = subIds;
    this.note('turn');
    this.openModel();
  }

  /** A steer reached the running turn. */
  steered(text: string) {
    const id = this.submit(text, 'steer');
    this.submissions.at(-1)!.placed = true;
    this.pendingPlace.push(id);
    if (this.open?.name === 'model' && !this.open.output?.text) this.open.placed.push(...this.pendingPlace.splice(0));
  }

  event(e: { type: string; [k: string]: any }) {
    if (e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'error' || e.type === 'idle') this.note(e.type, e.name);
    if (e.type === 'text' && typeof e.delta === 'string') {
      const m = this.open?.name === 'model' ? this.open : this.openModel();
      m.output = { ...m.output, text: (m.output?.text ?? '') + e.delta };
    } else if (e.type === 'tool_start') {
      if (this.open?.name === 'model') this.open.output = { ...this.open.output, toolCalls: [...(this.open.output?.toolCalls ?? []), { name: e.name }] };
      this.close();
      this.open = this.push(`tool.${e.name}`, e.args ?? {});
    } else if (e.type === 'tool_end') {
      if (this.open?.name.startsWith('tool.')) {
        this.open.status = e.isError ? 'failed' : 'completed';
        this.open.output = e.output ?? (e.isError ? undefined : '');
        if (e.isError) this.open.error = { message: typeof e.output === 'string' ? e.output : 'the tool failed' };
        this.open = undefined;
      }
      this.openModel();
    } else if (e.type === 'error') {
      const m = this.open?.name === 'model' ? this.open : this.openModel();
      m.status = 'failed';
      m.error = { message: String(e.message ?? 'failed') };
      this.open = undefined;
    } else if (e.type === 'idle') {
      this.close();
      this.busy = false;
    }
  }

  view(): SessionView {
    return {
      id: this.id,
      harness: this.harness,
      status: this.busy ? 'running' : 'idle',
      eventCount: this.log.length,
      submissions: this.submissions.map((s) => ({ ...s })),
      effects: this.effects.map((e) => ({ ...e, placed: [...e.placed] })),
      files: {},
      supersededStepIds: [],
    };
  }

  /** The page's rows after `cursor` (an eventId). */
  events(cursor?: string): EventPage {
    const from = cursor ? this.log.findIndex((e) => e.eventId === cursor) + 1 : 0;
    return { events: this.log.slice(from), ...(this.log.length ? { cursor: this.log.at(-1)!.eventId } : {}) };
  }

  private note(eventType: string, stepName?: string, eventId = `${this.id}:v${this.log.length}`) {
    this.log.push({ eventId, eventType, ...(stepName ? { stepName } : {}), createdAt: new Date().toISOString() });
  }

  private push(name: string, input: unknown): EffectView {
    const key = `${this.id}:e${this.n++}`;
    const e: EffectView = { key, stepId: key, name, status: 'running', attempt: 1, input, output: undefined, startedAt: new Date().toISOString(), placed: [] };
    this.effects.push(e);
    return e;
  }

  private openModel(): EffectView {
    this.close();
    const m = this.push('model', {});
    m.placed.push(...this.pendingPlace.splice(0));
    this.open = m;
    return m;
  }

  /** Close the open effect; a model call that produced nothing (the turn's end) is dropped. */
  private close() {
    const e = this.open;
    if (!e) return;
    this.open = undefined;
    if (e.name === 'model' && !e.output && !e.placed.length && this.effects.at(-1) === e) {
      this.effects.pop();
      return;
    }
    e.status = 'completed';
  }
}
