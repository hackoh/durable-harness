import type { AgentRunsLink, DemoClient, SessionRow, SessionView, WorldName } from 'harness-world-demo-ui';
import { pendingRows } from './pending.ts';

/**
 * "Pi (pi-durable)": Pi 1.0's own durable Harness on the server's World
 * (`pi-world`), over the demo app's `/api/pi-durable` routes. Server mode
 * only; every commit is awaited (Durable Strict).
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
  chaos: boolean;
  sessions: SessionRow[];
}

const LIST = '/api/sessions?harness=pi-durable';

export async function createClient(): Promise<DemoClient> {
  // The runs list can take the World a while: the page is ready on the server's description alone.
  let firstList: Promise<SessionRow[]> | undefined = fetch(LIST).then((r) => json<ListResponse>(r)).then((r) => r.sessions);
  firstList.catch(() => {});
  const first = await fetch(`${LIST}&list=0`).then((r) => json<ListResponse>(r));
  const pending = pendingRows();
  const views = new Map<string, SessionView & { version?: string }>();
  return {
    mode: 'server',
    durability: 'on',
    worldName: first.world,
    ...(first.agentRuns ? { agentRuns: first.agentRuns } : {}),
    chaosEnabled: first.chaos,
    fxAvailable: true,
    async list() {
      const listed = firstList ?? fetch(LIST).then((r) => json<ListResponse>(r)).then((r) => r.sessions);
      firstList = undefined;
      return pending.merge(await listed);
    },
    async start(_harness, prompt, startOptions) {
      const body = { ...(prompt ? { prompt, requestId: crypto.randomUUID() } : {}), ...(startOptions?.hands ? { hands: startOptions.hands } : {}) };
      const { sessionId } = await post('/api/pi-durable', body).then((r) => json<{ sessionId: string }>(r));
      pending.add(sessionId, 'pi-durable');
      return sessionId;
    },
    async send(id, text, kind) {
      await post(`/api/pi-durable/${id}/messages`, { text, kind, requestId: crypto.randomUUID() }).then(json);
    },
    async inspect(id) {
      const prev = views.get(id);
      const body = await fetch(`/api/pi-durable/${id}${prev?.version ? `?known=${encodeURIComponent(prev.version)}` : ''}`).then((r) =>
        json<(SessionView & { version?: string }) | { unchanged: true }>(r)
      );
      if ('unchanged' in body && prev) return prev;
      views.set(id, body as SessionView & { version?: string });
      return body as SessionView;
    },
    // Every row, every time: the page skips the ids it has, and a crash row
    // (from the crash stream) can land between commits it already read.
    events: (id) => fetch(`/api/pi-durable/${id}/events`).then((r) => json<Awaited<ReturnType<DemoClient['events']>>>(r)),
    event: async (id, eventId) =>
      (await fetch(`/api/pi-durable/${id}/events/${encodeURIComponent(eventId)}`).then((r) => json<{ payload: unknown }>(r))).payload,
    chaos: async (id, spec) => {
      await post(`/api/pi-durable/${id}/chaos`, spec).then(json);
    },
    livePushes: true,
    live(id, onEvent) {
      const source = new EventSource(`/api/pi-durable/${id}/live`);
      let opened = 0;
      source.onopen = () => {
        if (opened++ > 0) onEvent({ type: 'reconnect', t: Date.now(), n: opened - 1 });
      };
      source.onmessage = (m) => {
        try {
          onEvent(JSON.parse(m.data));
        } catch {}
      };
      return () => source.close();
    },
  };
}
