import { eveClient } from 'harness-world-bench/eve';
import { type DemoClient, NativeFold } from 'harness-world-demo-ui';

/**
 * eve (`/eve/v1`, mounted by `withEve` in apps/demo): eve's own harness on
 * Vercel Workflow, as a `/compare` column. The session lives in eve; this
 * client sends messages and translates eve's stream into the page's events
 * and marks (`harness-world-bench/eve`). The transcript the page keeps for
 * the inspector is a fold of what it saw, as for Native.
 */
export async function createClient(): Promise<DemoClient> {
  const eve = eveClient();
  const folds = new Map<string, NativeFold>();
  const created = new Map<string, Date>();
  const fold = (id: string) => {
    let f = folds.get(id);
    if (!f) folds.set(id, (f = new NativeFold(id, 'eve')));
    return f;
  };

  return {
    mode: 'server',
    durability: 'on',
    worldName: 'vercel',
    chaosEnabled: false,
    fxAvailable: true,
    signalsReady: true,
    async list() {
      return [...folds.entries()].map(([id, f]) => ({ id, harness: 'eve', status: f.busy ? 'running' : 'idle', createdAt: created.get(id) ?? new Date() })).reverse();
    },
    async start(_harness, prompt) {
      const id = await eve.start('eve');
      created.set(id, new Date());
      const f = fold(id);
      if (prompt) f.begin([f.submit(prompt)]);
      if (prompt) await eve.send(id, prompt, 'prompt');
      return id;
    },
    async send(id, text, kind) {
      const f = fold(id);
      if (kind === 'steer' && f.busy) f.steered(text);
      else f.begin([f.submit(text)]);
      // The receipt says how long eve refused it as not ready (a prewarmed session starting): /compare starts the turn's clock after that.
      return eve.send(id, text, kind);
    },
    inspect: async (id) => fold(id).view(),
    events: async (id, cursor) => fold(id).events(cursor),
    event: async () => ({ note: 'eve: the session is in eve (its own Workflow runs). This row is what the page saw.' }),
    live(id, onEvent, onReady) {
      const f = fold(id);
      return eve.live(
        id,
        (e) => {
          // The fold calls a failure `error` (a failed model row); the page's own
          // events keep `failed`, as from the durable lanes.
          f.event(e?.type === 'failed' ? { ...e, type: 'error' } : e);
          onEvent(e);
        },
        onReady
      );
    },
    chaos: async () => {
      throw new Error('eve: crash drills are durable-harness’s; eve recovers through Workflow on its own.');
    },
  };
}
