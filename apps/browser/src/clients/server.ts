import { type AgentRunsLink, type DemoClient, type HarnessOption, SessionNotFound, type SessionRow, type SessionView, type WorldName } from 'harness-world-demo-ui';
import { ReplayDedupe } from 'harness-world-bench/replay';
import { prewarmFlag } from '../flags.ts';
import { pendingRows } from './pending.ts';
import { createSpares, fromSpareKey, releaseByBeacon, spareKey } from './spares.ts';

/**
 * The server World over the demo app's API routes: plain fetch and
 * EventSource, so it ships in the page's first chunk.
 */

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.url.replace(location.origin, '')} ${response.status}`);
  return response.json() as Promise<T>;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface ListResponse {
  world: WorldName;
  /** On Vercel: where the sessions show in Agent Runs. */
  agentRuns?: AgentRunsLink;
  /** The port the server answered on. */
  port?: string;
  chaos: boolean;
  /** Messages to a session with an armed crash go to `/api/drill`, where crashes fire in a Function of their own. */
  drill?: boolean;
  sessions: SessionRow[];
  /** The process harnesses the server registered (with `include=process`). */
  harnesses?: HarnessOption[];
  /** Why the server can't make Vercel Sandbox VMs (the machine and sandbox hands), when it can't. */
  sandboxReason?: string;
}

/** Server-mode sessions: Pi, fx and every process harness the server registered. */
const LIST = '/api/sessions?harness=pi,fx&include=process';

export async function createClient(options: { durability?: 'run-ahead' } = {}): Promise<DemoClient> {
  // The server's description comes back at once; the runs list can take the
  // World a while, so the page is ready before it (the first list() waits for it).
  let firstList: Promise<SessionRow[]> | undefined = fetch(LIST).then((r) => json<ListResponse>(r)).then((r) => r.sessions);
  firstList.catch(() => {});
  const first = await fetch(`${LIST}&list=0`).then((r) => json<ListResponse>(r));
  // A first crash drill otherwise waits on two cold Functions in a row (arming it, then the
  // drill's own): wake both while the page loads. A GET answers 405 and starts the Function.
  if (first.chaos && first.drill) for (const path of ['/api/drill', '/api/sessions/warm/chaos']) void fetch(path).catch(() => {});
  const pending = pendingRows();
  // The last fold read per session: an unchanged poll costs a few bytes.
  const views = new Map<string, SessionView>();
  const create = async (harness: string, prompt?: string, hands?: string) =>
    (
      await post('/api/sessions', {
        harness,
        ...(prompt ? { prompt } : {}),
        ...(options.durability ? { durability: options.durability } : {}),
        // Recorded on its run_created: every drive builds the harness for them.
        ...(hands ? { hands } : {}),
      }).then((r) => json<{ sessionId: string }>(r))
    ).sessionId;
  const spares = createSpares({
    enabled: prewarmFlag(),
    key: options.durability ? `how:spare:server:${options.durability}` : 'how:spare:server',
    defaultHarness: spareKey('pi', 'virtual'),
    // One spare per harness and hands: a session's hands are fixed when it is made.
    create: (key) => {
      const { harness, hands } = fromSpareKey(key);
      return create(harness, undefined, hands);
    },
    release: releaseByBeacon,
  });
  const visible = (rows: SessionRow[]) => rows.filter((r) => !spares.hidden(r.id));
  return {
    mode: 'server',
    worldName: first.world,
    ...(first.agentRuns ? { agentRuns: first.agentRuns } : {}),
    chaosEnabled: first.chaos,
    fxAvailable: true,
    harnesses: first.harnesses ?? [],
    ...(first.sandboxReason ? { sandboxReason: first.sandboxReason } : {}),
    ...(first.port ? { serverPort: first.port } : {}),
    async list() {
      const listed = firstList ?? fetch(LIST).then((r) => json<ListResponse>(r)).then((r) => r.sessions);
      firstList = undefined;
      return visible(pending.merge(await listed));
    },
    start: async (harness, prompt, startOptions) => {
      // A pre-created session takes the prompt: no run creation on the TTFT path.
      const spare = await spares.take(spareKey(harness, startOptions?.hands));
      if (spare && prompt) await post(`/api/sessions/${spare}/messages`, { text: prompt, kind: 'prompt' }).then(json);
      const sessionId = spare ?? (await create(harness, prompt, startOptions?.hands));
      pending.add(sessionId, harness);
      return sessionId;
    },
    send: async (id, text, kind, options) => {
      if (options?.crash && first.drill) await post('/api/drill', { runId: id, text, kind }).then(json);
      else await post(`/api/sessions/${id}/messages`, { text, kind }).then(json);
    },
    async inspect(id) {
      const prev = views.get(id);
      const body = await fetch(`/api/sessions/${id}${prev ? `?known=${prev.eventCount}` : ''}`).then((r) => {
        if (r.status === 404) throw new SessionNotFound(id);
        return json<SessionView | { unchanged: true }>(r);
      });
      if ('unchanged' in body && prev) return prev;
      views.set(id, body as SessionView);
      return body as SessionView;
    },
    events: (id, cursor) =>
      fetch(`/api/sessions/${id}/events${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`).then((r) => json(r)),
    event: async (id, eventId) =>
      (await fetch(`/api/sessions/${id}/events/${eventId}`).then((r) => json<{ payload: unknown }>(r))).payload,
    chaos: async (id, spec) => {
      // With drills, the next message goes to /api/drill: arming must not wake a regular drive that would take it.
      await post(`/api/sessions/${id}/chaos`, { ...spec, ...(first.drill && (spec.kind ?? 'process') === 'process' ? { drill: true } : {}) }).then(json);
    },
    disarm: async (id) => {
      await post(`/api/sessions/${id}/chaos`, { disarm: true }).then(json);
    },
    // Every commit of a server-driven session is marked on `live` (an `ack`
    // per write), so the page refreshes on those and polls only as a fallback.
    livePushes: true,
    live(id, onEvent) {
      const source = new EventSource(`/api/sessions/${id}/live`);
      // EventSource reconnects on its own when the response ends or drops,
      // and the route replays the stream from the start: skip what this
      // subscription already delivered, so a reconnect adds nothing twice.
      // By value, not by count: a connection served by a process that was
      // then killed (a crash drill) can have carried events the replay does
      // not have, and a count would then swallow new ones (the crash itself).
      const dedupe = new ReplayDedupe();
      let opened = 0;
      source.onopen = () => {
        dedupe.reconnect();
        // A re-open (the response ended or dropped): say so, so a timing
        // view can tell a reconnect from harness latency.
        if (opened++ > 0) onEvent({ type: 'reconnect', t: Date.now(), n: opened - 1 });
      };
      source.onmessage = (m) => {
        if (!dedupe.accept(m.data)) return;
        try {
          onEvent(JSON.parse(m.data));
        } catch {}
      };
      return () => source.close();
    },
  };
}
