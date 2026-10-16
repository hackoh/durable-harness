import { armedChaos, currentLane, type Lane, mark } from 'harness-world';
import type { DemoClient, Hands, SessionRow, WorldName } from 'harness-world-demo-ui';
import { sessionView, withLedger } from 'harness-world-demo-ui/view';
import { tabGateway } from '../direct.ts';
import { driveFlag, hintsFlag, prewarmFlag, relayFlag } from '../flags.ts';
import { createHybridClient, fetchHybridConfig, hasJspi, type HybridHands } from '../hybrid-client.ts';
import { MODEL } from '../model.ts';
import { pendingRows } from './pending.ts';
import { createSpares, fromSpareKey, releaseByBeacon, spareKey } from './spares.ts';
import { worldReads } from './world-common.ts';

/**
 * A hybrid session: Pi or fx in this tab, on the server's World. Simple turns and
 * steers never leave the tab (except the model call); the session moves to a
 * Vercel Function for a backend secret or a real machine (the Function runs
 * `run_on_machine` on the session's own Vercel Sandbox VM through the Sandbox
 * API), then comes back here. One run, one log, the whole way.
 */

interface ListResponse {
  world: WorldName;
  chaos: boolean;
  /** Why the server can't make Vercel Sandbox VMs (the machine hands), when it can't. */
  sandboxReason?: string;
  sessions: SessionRow[];
}

/** `meta`: the server's description alone, without the runs list (which can take the World a while). */
async function listHybrid(meta = false): Promise<ListResponse> {
  const r = await fetch(`/api/sessions?harness=hybrid,hybrid-fx${meta ? '&list=0' : ''}`);
  if (!r.ok) throw new Error(`/api/sessions ${r.status}`);
  return r.json();
}

/** A Hybrid brain's hands (`Hands` but `sandbox`, which a hybrid session doesn't take yet). */
const hybridHands = (hands: Hands | undefined): HybridHands | undefined => (hands && hands !== 'sandbox' ? hands : undefined);

/** The Hybrid brain: sessions whose home is this tab. */
export async function createClient(): Promise<DemoClient> {
  // Every lane must call the same model, so take the server's rather than
  // this bundle's (it can be configured with HARNESS_MODEL).
  const config = await fetchHybridConfig(location.origin);
  // Marks this tab makes about what it observed (not written to the log):
  // the moment one of its reads saw a server lane hand the session back.
  const local = new Map<string, Set<(event: unknown) => void>>();
  const lanes = new Map<string, Lane>();
  const observe = (runId: string, lane: Lane) => {
    const was = lanes.get(runId);
    lanes.set(runId, lane);
    if (was === undefined || was === lane || lane !== 'browser') return;
    const event = mark(runId, 'handoff.picked', { lane: 'browser', from: was, to: 'browser', observed: true });
    for (const fn of local.get(runId) ?? []) fn(event);
  };
  let firstList: Promise<SessionRow[]> | undefined = listHybrid().then((r) => r.sessions);
  firstList.catch(() => {});
  const [first, hybrid] = await Promise.all([
    listHybrid(true),
    createHybridClient({
      origin: location.origin,
      model: config?.model ?? MODEL,
      gateway: tabGateway(),
      // The page polls the open session itself; this only covers sessions
      // away from the tab (and it pauses while the page is hidden). With
      // live hints a handoff back reads at once, so the poll is a fallback.
      ...(hintsFlag() === false ? { pollMs: 3000, hints: false } : { pollMs: 5000 }),
      ...(driveFlag() ? { drive: driveFlag() } : {}),
      ...(relayFlag() ? { relay: relayFlag() } : {}),
      log: (m, f) => console.log(`[hybrid] ${m}`, f ?? ''),
      onState: (runId, state) => observe(runId, currentLane(state)),
      // A crash in the tab's lane reloads the tab; the page returns to the
      // session and says so.
      crash: () => {
        try {
          sessionStorage.setItem('how:crash', JSON.stringify({ mode: 'hybrid', at: Date.now() }));
        } catch {}
        location.reload();
        // Like the kernel's default crash: nothing after this line runs.
        throw new Error('durable-harness chaos: crashed');
      },
    }).catch((e) => {
      throw new Error(`/api/world: ${e instanceof Error ? e.message : String(e)}`);
    }),
  ]);
  const { world, sessions } = hybrid;
  const reads = worldReads(world, sessions);
  const pending = pendingRows();
  // Pre-created sessions, one per harness and hands (a session's hands are fixed when it is made).
  const spares = createSpares({
    enabled: prewarmFlag(),
    key: 'how:spare:hybrid',
    defaultHarness: spareKey('hybrid', 'machine'),
    create: (key) => {
      const { harness, hands } = fromSpareKey(key);
      const h = hybridHands(hands as Hands | undefined);
      return hybrid.start(undefined, harness as 'hybrid' | 'hybrid-fx', h ? { hands: h } : {});
    },
    release: releaseByBeacon,
  });
  const settled = new Set<string>();
  const visible = (rows: SessionRow[]) => rows.filter((r) => !spares.hidden(r.id));
  // Keep a drive-route instance warm: a handoff to the
  // function lane then lands on a warm Function. At most once every 3
  // minutes, and only while the page is visible.
  if (driveFlag() !== 'queue' && prewarmFlag()) {
    let lastWarm = 0;
    const warm = () => {
      if (document.hidden || Date.now() - lastWarm < 3 * 60_000) return;
      lastWarm = Date.now();
      fetch('/api/hybrid/drive?warm=1', { cache: 'no-store' }).catch(() => {});
    };
    warm();
    setInterval(warm, 60_000);
  }
  return {
    mode: 'hybrid',
    worldName: first.world,
    chaosEnabled: first.chaos,
    fxAvailable: hasJspi(),
    ...(first.sandboxReason ? { sandboxReason: first.sandboxReason } : {}),
    async list() {
      const listed = firstList ?? listHybrid().then((r) => r.sessions);
      firstList = undefined;
      return visible(pending.merge(await listed));
    },
    // The page asks for `pi` or `fx` (or already the hybrid name), with the hands it picked.
    start: async (harness, prompt, startOptions) => {
      const name = harness === 'fx' || harness === 'hybrid-fx' ? 'hybrid-fx' : 'hybrid';
      const hands = hybridHands(startOptions?.hands);
      // A pre-created session takes the prompt: no run creation on the TTFT path.
      const spare = await spares.take(spareKey(name, hands));
      if (spare) {
        hybrid.watch(spare);
        if (prompt) await sessions.send(spare, prompt, 'prompt');
      }
      const id = spare ?? (await hybrid.start(prompt, name, hands ? { hands } : {}));
      pending.add(id, name);
      return id;
    },
    send: async (id, text, kind) => {
      hybrid.watch(id);
      await sessions.send(id, text, kind);
    },
    // The first read of a session in this page also drives it here when it
    // is back in the tab's lane with work queued, and arms or parks its
    // watch (a reload, a session opened from the list). After that the
    // page's reads are only reads: the watch (hints, 5 s fallback poll)
    // is what notices a handback and drives it, not the page's refresh.
    inspect: async (id) => {
      // With hints off (a debugging flag) every read settles, as before.
      if (settled.has(id) && hintsFlag() !== false) return withLedger(world, sessionView(id, await hybrid.peek(id)));
      settled.add(id);
      return withLedger(world, sessionView(id, await hybrid.state(id)));
    },
    // Hints of this session's commits: the page refreshes on them, and its
    // busy poll is only a 5 s fallback.
    hints: hintsFlag() === false ? undefined : (id, onHint) => hybrid.hints(id, onHint),
    chaos: async (id, spec) => {
      hybrid.watch(id);
      await sessions.chaos(id, spec);
    },
    disarm: async (id) => {
      const armed = armedChaos(await sessions.inspect(id));
      if (armed) await sessions.withdraw(id, armed.id);
    },
    ...reads,
    live(id, onEvent) {
      let set = local.get(id);
      if (!set) local.set(id, (set = new Set()));
      set.add(onEvent);
      const off = reads.live(id, (event: any) => {
        // A lane change seen on the stream: the next read that finds the
        // session back in this tab is when this tab noticed the handback.
        if ((event?.type === 'lane' || (event?.type === 'mark' && event.name === 'handoff.sent')) && typeof event.to === 'string' && event.to !== 'browser') {
          lanes.set(id, event.to);
        }
        onEvent(event);
      });
      return () => {
        set.delete(onEvent);
        off();
      };
    },
  };
}
