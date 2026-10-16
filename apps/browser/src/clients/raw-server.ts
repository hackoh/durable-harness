import { type RawSnapshot, stateFromSnapshot } from 'harness-world';
import { rawFunctionClient } from 'harness-world-bench';
import type { DemoClient, EventPage, SessionView } from 'harness-world-demo-ui';
import { sessionView } from 'harness-world-demo-ui/view';

/**
 * Durability off, in a Function: the same Pi and fx harnesses as Server
 * mode, with no World (`/api/bench/raw`). A Function holds nothing between
 * requests, so this page carries the session: each turn posts the in-memory
 * state the previous turn returned. A steer cannot reach a turn in flight,
 * so it runs as the next turn.
 */

let shared: ReturnType<typeof rawFunctionClient> | undefined;
export function functionRaw() {
  shared ??= rawFunctionClient({ origin: location.origin });
  return shared;
}

export async function createClient(): Promise<DemoClient> {
  const raw = functionRaw();
  const created = new Map<string, Date>();
  const harnesses = new Map<string, string>();
  const pending = new Map<string, { kind: string; text: string }[]>();
  const blank = (id: string): SessionView => ({
    id,
    harness: harnesses.get(id),
    status: 'running',
    eventCount: (pending.get(id) ?? []).length,
    submissions: (pending.get(id) ?? []).map((s, i) => ({ id: `${id}:${i}`, kind: s.kind, text: s.text, placed: false, withdrawn: false })),
    effects: [],
    files: {},
    supersededStepIds: [],
  });
  const view = (id: string): SessionView => {
    const snap = raw.snapshot(id) as RawSnapshot | undefined;
    if (!snap) return blank(id);
    return sessionView(id, stateFromSnapshot(snap));
  };
  return {
    mode: 'server',
    durability: 'off',
    worldName: 'vercel',
    chaosEnabled: false,
    fxAvailable: true,
    signalsReady: true,
    async list() {
      return raw
        .sessions()
        .map((s) => ({ id: s.id, harness: s.harness, status: s.status, createdAt: created.get(s.id) ?? new Date() }))
        .reverse();
    },
    async start(harness, prompt) {
      const id = await raw.start(harness);
      created.set(id, new Date());
      harnesses.set(id, harness);
      if (prompt) {
        pending.set(id, [{ kind: 'prompt', text: prompt }]);
        await raw.send(id, prompt, 'prompt');
      }
      return id;
    },
    async send(id, text, kind) {
      if (!raw.snapshot(id)) pending.set(id, [...(pending.get(id) ?? []), { kind, text }]);
      await raw.send(id, text, kind);
    },
    inspect: async (id) => view(id),
    async events(id, cursor): Promise<EventPage> {
      const all = raw.snapshot(id)?.events ?? [];
      const from = cursor ? all.findIndex((e) => e.eventId === cursor) + 1 : 0;
      return { events: all.slice(from), ...(all.length ? { cursor: all.at(-1)!.eventId } : {}) };
    },
    event: async () => ({ note: 'Durability is off: nothing was written, so there is no payload to read.' }),
    live: (id, onEvent, onReady) => raw.live(id, onEvent, onReady),
    chaos: async () => {
      throw new Error('Durability is off: there is nothing to recover a crash from.');
    },
  };
}
