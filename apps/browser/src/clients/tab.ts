import { createWorld } from '@harness-world/world-browser';
import { armedChaos, browserAnchors, type DurableSessions, durableSessions, type Harness, harnessOf } from 'harness-world';
import type { DemoClient } from 'harness-world-demo-ui';
import { sessionView, withLedger } from 'harness-world-demo-ui/view';
import { hasJspi, tabHandsOf, tabHarnesses as harnesses } from './tab-harnesses.ts';
import { worldReads } from './world-common.ts';

export { hasJspi };

// The IndexedDB World's name: a stable id (the project's earlier name), so a
// tab keeps the sessions it already has.
const WORLD_NAME = 'harness-on-world';

/**
 * The whole World in this tab: storage in IndexedDB, the queue consumed by
 * whichever tab holds a Web Lock, streams over BroadcastChannel. Only model
 * calls leave, straight to AI Gateway (or through the demo app's proxy; see direct.ts).
 */

/**
 * Runs this tab is driving right now. A second delivery for one of them (a
 * message sent mid-tool wakes the queue) waits for the first instead of
 * judging its step abandoned: the log only shows driver activity at writes,
 * and a long tool writes nothing until it ends.
 */
function trackDriving(list: Harness[]) {
  const driving = new Map<string, number>();
  const harness = list.map(
    (h): Harness => ({
      name: h.name,
      ...(h.lanes ? { lanes: h.lanes } : {}),
      async drive(ctx) {
        driving.set(ctx.runId, (driving.get(ctx.runId) ?? 0) + 1);
        try {
          await h.drive(ctx);
        } finally {
          const n = (driving.get(ctx.runId) ?? 1) - 1;
          if (n) driving.set(ctx.runId, n);
          else driving.delete(ctx.runId);
        }
      },
    })
  );
  return { harness, driving };
}

export async function createClient(): Promise<DemoClient> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable');
  const world = await createWorld({ name: WORLD_NAME });
  const { harness, driving } = trackDriving(harnesses());
  const sessions: DurableSessions = durableSessions({
    world,
    harness,
    admit: async (state) =>
      driving.has(state.runId) ? { admit: false, reason: 'driven in this tab', timeoutSeconds: 1 } : { admit: true },
    // world-browser's leader tab holds the queue (a Web Lock): a message
    // anchor this leader is not driving is gone (its page closed or
    // reloaded), so it recovers at once. Nothing beats.
    anchors: browserAnchors(),
    // Crash = reload this tab mid-step. The page comes back to the same
    // session (it is in the URL) and says what happened.
    chaos: true,
    crash: () => {
      try {
        sessionStorage.setItem('how:crash', JSON.stringify({ mode: 'tab', at: Date.now() }));
      } catch {}
      location.reload();
      // Like the kernel's default crash: nothing after this line runs.
      throw new Error('durable-harness chaos: crashed');
    },
    log: (m, f) => console.log(`[harness] ${m}`, f ?? ''),
  });
  await world.start?.();

  return {
    mode: 'tab',
    worldName: 'browser',
    chaosEnabled: true,
    fxAvailable: hasJspi(),
    async list() {
      const runs = await world.runs.list({ pagination: { limit: 100, sortOrder: 'desc' }, resolveData: 'none' });
      return runs.data
        .filter((r) => {
          const h = harnessOf(r.workflowName);
          return h === 'pi' || h === 'fx';
        })
        .map((r) => ({ id: r.runId, harness: harnessOf(r.workflowName)!, status: r.status, createdAt: r.createdAt }));
    },
    // A tab's brain takes None, Virtual and Virtual (not saved): the page offers nothing else here.
    start: async (harness, prompt, startOptions) =>
      (
        await sessions.start({
          harness,
          ...(prompt ? { prompt } : {}),
          ...(startOptions?.hands ? { config: { hands: tabHandsOf({ hands: startOptions.hands }) } } : {}),
        })
      ).sessionId,
    send: async (id, text, kind) => {
      await sessions.send(id, text, kind);
    },
    inspect: async (id) => withLedger(world, sessionView(id, await sessions.inspect(id))),
    chaos: async (id, spec) => {
      await sessions.chaos(id, spec);
    },
    disarm: async (id) => {
      const armed = armedChaos(await sessions.inspect(id));
      if (armed) await sessions.withdraw(id, armed.id);
    },
    ...worldReads(world, sessions),
    async blocked() {
      // Our lock request is still pending: another tab of this World holds the queue.
      const state = await navigator.locks?.query?.();
      const name = `world-browser:${WORLD_NAME}:queue`;
      const pending = state?.pending?.some((l) => l.name === name);
      return pending ? 'Another tab is driving sessions in this World. Close it to drive them here.' : undefined;
    },
  };
}
