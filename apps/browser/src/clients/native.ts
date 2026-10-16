import { type DemoClient, type Mode, NativeFold } from 'harness-world-demo-ui';

/**
 * The native baseline (`/api/native`): plain Pi or fx in a Fluid Function,
 * with none of the durability code. Like any stateless chat route, the page
 * carries the conversation: each turn posts the state the previous response
 * ended with. A steer goes to `/api/native/steer`, which lands only if it
 * reaches the instance running the turn; otherwise it runs as the next turn.
 */

interface Session {
  harness: 'pi' | 'fx';
  state?: unknown;
  listeners: Set<(e: any) => void>;
  history: any[];
  busy?: { turnId: string; done: Promise<void> };
  queued: { text: string; subId: string }[];
  fold: NativeFold;
  createdAt: Date;
}

let counter = 0;

/** Where a native turn runs: it streams events (`emit`) and ends with a `state` event. */
export interface NativeRunner {
  turn(req: { harness: 'pi' | 'fx'; text: string; turnId: string; state?: unknown }, emit: (e: any) => void): Promise<void>;
  /** Hand a steer to the running turn; false: it did not reach it. */
  steer(turnId: string, text: string): Promise<boolean>;
}

/** The Function: `/api/native`, NDJSON streamed back as each event happens. */
export const functionRunner: NativeRunner = {
  async turn(req, emit) {
    const r = await fetch('/api/native', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!r.ok || !r.body) throw new Error(`/api/native ${r.status} ${await r.text().catch(() => '')}`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          emit(JSON.parse(line));
        } catch {}
      }
    }
  },
  async steer(turnId, text) {
    const r = await fetch('/api/native/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnId, text }),
    }).then((res) => res.json() as Promise<{ landed: boolean }>, () => ({ landed: false }));
    return r.landed;
  },
};

export function createClient(): Promise<DemoClient> {
  return createNativeClient(functionRunner, 'server');
}

export async function createNativeClient(runner: NativeRunner, mode: Mode, extra: Partial<DemoClient> = {}): Promise<DemoClient> {
  const sessions = new Map<string, Session>();
  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error(`no native session ${id}`);
    return s;
  };
  const emit = (s: Session, e: any) => {
    s.fold.event(e);
    s.history.push(e);
    for (const fn of s.listeners) fn(e);
  };

  async function turn(s: Session, text: string, turnId: string) {
    await runner.turn({ harness: s.harness, text, turnId, ...(s.state ? { state: s.state } : {}) }, (e) => {
      if (e?.type === 'state') s.state = e.state;
      else emit(s, e);
    });
  }

  function run(s: Session, text: string, subId: string) {
    const turnId = `nt_${Date.now().toString(36)}_${counter++}`;
    s.fold.begin([subId]);
    const done = (async () => {
      try {
        await turn(s, text, turnId);
      } catch (err) {
        emit(s, { type: 'error', message: err instanceof Error ? err.message : String(err) });
        emit(s, { type: 'idle' });
      }
      s.busy = undefined;
      const next = s.queued.shift();
      if (next !== undefined) run(s, next.text, next.subId);
    })();
    s.busy = { turnId, done };
  }

  return {
    mode,
    durability: 'native',
    worldName: mode === 'tab' ? 'browser' : 'vercel',
    chaosEnabled: false,
    fxAvailable: true,
    signalsReady: true,
    async list() {
      return [...sessions.entries()]
        .map(([id, s]) => ({ id, harness: s.harness, status: s.busy ? 'running' : 'idle', createdAt: s.createdAt }))
        .reverse();
    },
    async start(harness, prompt) {
      const id = `native_${Date.now().toString(36)}_${counter++}`;
      const h = harness === 'fx' || harness === 'hybrid-fx' ? 'fx' : 'pi';
      const s: Session = { harness: h, listeners: new Set(), history: [], queued: [], fold: new NativeFold(id, h), createdAt: new Date() };
      sessions.set(id, s);
      if (prompt) run(s, prompt, s.fold.submit(prompt));
      return id;
    },
    async send(id, text, kind) {
      const s = get(id);
      if (!s.busy) return run(s, text, s.fold.submit(text));
      if (kind === 'steer' && (await runner.steer(s.busy.turnId, text))) {
        s.fold.steered(text);
        return;
      }
      s.queued.push({ text, subId: s.fold.submit(text, kind) });
    },
    // A native session lives only in the page that ran it: after a reload it is gone.
    inspect: async (id) =>
      sessions.get(id)?.fold.view() ?? {
        id,
        status: 'failed',
        failure: 'Native sessions are not recorded: this one lived in the page before a reload and is gone. Start a new one.',
        eventCount: 0,
        submissions: [],
        effects: [],
        files: {},
        supersededStepIds: [],
      },
    events: async (id, cursor) => sessions.get(id)?.fold.events(cursor) ?? { events: [] },
    event: async () => ({ note: 'Native: nothing is recorded. This row is what this page saw.' }),
    live(id, onEvent, onReady) {
      const s = sessions.get(id);
      if (!s) {
        onReady?.();
        return () => {};
      }
      for (const e of s.history) onEvent(e);
      s.listeners.add(onEvent);
      onReady?.();
      return () => s.listeners.delete(onEvent);
    },
    chaos: async () => {
      throw new Error('Native: there is nothing to recover a crash from.');
    },
    ...extra,
  };
}
