import type { AgentRunsLink, ChaosSpec, DemoClient, SessionRow, SessionView, WorldName } from 'harness-world-demo-ui';
import { type FxLine, type FxSide, fxBusy, fxLiveEvents, fxPartial, fxProjection } from 'harness-world-demo-ui/fx-view';
import { pendingRows } from './pending.ts';

/**
 * "fx (libfx durable)": libfx's own durable sessions on the server's World,
 * over the demo app's `/api/fx-durable` routes. Server mode only.
 *
 * The page follows each session the way the libfx durability doc has a
 * browser do it: one subscription to the session's stream, which reconnects
 * with the last `cursor` it saw, from whichever server answers. The view,
 * the event rows and the live events all come from those lines (plus the
 * crash and workspace streams the app keeps beside libfx).
 */

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // The routes say why in `error` (fx (libfx durable) off on this server's World, crashes off, a foreign run id).
    const error = await response.json().then((body: { error?: unknown }) => body?.error, () => undefined);
    throw new Error(typeof error === 'string' ? error : `${response.url.replace(location.origin, '')} ${response.status}`);
  }
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

const LIST = '/api/sessions?harness=fx-durable';
/** A first read waits this long for the stream's first line (a new session has none). */
const FIRST_LINE_MS = 2500;
/** Once lines flow, the stream has caught up when none arrives for this long. */
const QUIET_MS = 250;
/**
 * A subscription stops this long after its last listener leaves (`live`'s
 * unsubscribe), so a quick re-subscribe (a re-render, a reconnect) reuses it.
 */
const GRACE_MS = 5_000;
/** A subscription only read (`inspect`, `events`), never listened to, stops this long after its last read. */
const IDLE_MS = 120_000;

interface Follow {
  lines: FxLine[];
  listeners: Set<(line: FxLine) => void>;
  caughtUp: Promise<void>;
  /** The timer that stops it while nobody listens; `grace` when a listener's leaving armed it. */
  parked?: { timer: ReturnType<typeof setTimeout>; grace: boolean };
  stop(): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Subscribe to one session's stream, reconnecting from the last cursor until stopped. */
function follow(id: string): Follow {
  const controller = new AbortController();
  let caughtUp!: () => void;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const f: Follow = {
    lines: [],
    listeners: new Set(),
    caughtUp: new Promise<void>((resolve) => (caughtUp = resolve)),
    stop: () => {
      clearTimeout(f.parked?.timer);
      f.parked = undefined;
      controller.abort();
    },
  };
  const settle = (ms: number) => {
    clearTimeout(quiet);
    quiet = setTimeout(caughtUp, ms);
  };
  settle(FIRST_LINE_MS);
  void (async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const cursor = f.lines.at(-1)?.cursor ?? 0;
        // No line yet is -1, so a stream whose first line has cursor 0 keeps it.
        const last = f.lines.at(-1)?.cursor ?? -1;
        const response = await fetch(`/api/fx-durable/${id}/stream?cursor=${cursor}`, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
        failures = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
            const raw = buffered.slice(0, index);
            buffered = buffered.slice(index + 1);
            let parsed: Omit<FxLine, 'at'>;
            try {
              parsed = JSON.parse(raw);
            } catch {
              continue;
            }
            if (!Number.isSafeInteger(parsed.cursor) || parsed.cursor <= (f.lines.at(-1)?.cursor ?? last)) continue;
            const line: FxLine = { ...parsed, at: Date.now() };
            f.lines.push(line);
            settle(QUIET_MS);
            for (const listener of f.listeners) listener(line);
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        failures += 1;
      }
      // The server closes a stream at its function's duration limit: reconnect from the last cursor.
      await sleep(Math.min(5000, 250 * 2 ** failures));
    }
  })();
  return f;
}

export async function createClient(): Promise<DemoClient> {
  // The runs list can take the World a while: the page is ready on the server's description alone.
  let firstList: Promise<SessionRow[]> | undefined = fetch(LIST).then((r) => json<ListResponse>(r)).then((r) => r.sessions);
  firstList.catch(() => {});
  const first = await fetch(`${LIST}&list=0`).then((r) => json<ListResponse>(r));
  const pending = pendingRows();
  const follows = new Map<string, Follow>();
  const sides = new Map<string, FxSide>();
  // Sessions started without a prompt have no World run until their first
  // message (libfx creates it then), so a crash armed on one waits here and
  // goes with that message.
  const unstarted = new Set<string>();
  const prearmed = new Map<string, ChaosSpec>();

  // What live() attached, so close() can detach it.
  const detachers = new Set<() => void>();
  let closed = false;

  /** Stop `f` after `ms` unless a listener arrives first. */
  const park = (id: string, f: Follow, ms: number, grace: boolean) => {
    clearTimeout(f.parked?.timer);
    const timer = setTimeout(() => {
      if (f.listeners.size) return;
      f.stop();
      if (follows.get(id) === f) follows.delete(id);
    }, ms);
    f.parked = { timer, grace };
  };
  const followOf = (id: string): Follow => {
    let f = follows.get(id);
    if (!f) {
      f = follow(id);
      follows.set(id, f);
    }
    // A read with nobody listening keeps it a while; a grace period a
    // listener's leaving started runs out as it was (after close, every
    // follow gets only that).
    if (!f.listeners.size && !f.parked?.grace) park(id, f, closed ? GRACE_MS : IDLE_MS, closed);
    return f;
  };
  const sideOf = async (id: string): Promise<FxSide> => {
    const side = await fetch(`/api/fx-durable/${id}/side`).then((r) => json<FxSide>(r));
    sides.set(id, side);
    return side;
  };
  const projection = async (id: string) => {
    const f = followOf(id);
    const [side] = await Promise.all([sideOf(id), f.caughtUp]);
    return { f, side, ...fxProjection(id, f.lines, side.chaos, side.workspace) };
  };

  return {
    mode: 'server',
    // libfx awaits the prompt and an unsafe tool's intent; its other records trail the turn.
    durability: 'run-ahead',
    worldName: first.world,
    ...(first.agentRuns ? { agentRuns: first.agentRuns } : {}),
    chaosEnabled: first.chaos,
    fxAvailable: true,
    async list() {
      const listed = firstList ?? fetch(LIST).then((r) => json<ListResponse>(r)).then((r) => r.sessions);
      firstList = undefined;
      return pending.merge(await listed);
    },
    async start(_harness, prompt) {
      const { sessionId } = await post('/api/fx-durable', prompt ? { prompt, requestId: crypto.randomUUID() } : {}).then((r) => json<{ sessionId: string }>(r));
      pending.add(sessionId, 'fx-durable');
      if (!prompt) unstarted.add(sessionId);
      return sessionId;
    },
    async send(id, text, kind) {
      const chaos = prearmed.get(id);
      await post(`/api/fx-durable/${id}/messages`, { text, kind, requestId: crypto.randomUUID(), ...(chaos ? { chaos } : {}) }).then(json);
      unstarted.delete(id);
      prearmed.delete(id);
    },
    async inspect(id): Promise<SessionView> {
      const { view } = await projection(id);
      const armed = prearmed.get(id);
      return armed ? { ...view, armedChaos: armed } : view;
    },
    // Every row, every time: the page skips the ids it has, and a crash row can land between lines it already read.
    async events(id) {
      const { events } = await projection(id);
      return { events, ...(events.length ? { cursor: events.at(-1)!.eventId } : {}) };
    },
    async event(id, eventId) {
      const line = /:line:(\d+)$/.exec(eventId);
      if (line) return followOf(id).lines.find((l) => l.cursor === Number(line[1]));
      const crash = /:chaos:(\d+)$/.exec(eventId);
      if (crash) return (sides.get(id) ?? (await sideOf(id))).chaos[Number(crash[1])];
      return undefined;
    },
    chaos: async (id, spec) => {
      if (unstarted.has(id)) prearmed.set(id, spec);
      else await post(`/api/fx-durable/${id}/chaos`, spec).then(json);
    },
    livePushes: true,
    /** Stop every subscription this client holds (the compare page closes a column's client with it). */
    close() {
      closed = true;
      for (const detach of [...detachers]) detach();
      for (const f of follows.values()) f.stop();
      follows.clear();
    },
    live(id, onEvent) {
      const f = followOf(id);
      // An attach replays the running model call's text from its start: the page drops what it buffered.
      onEvent({ type: 'rewind', reason: 'connect', t: Date.now() });
      const partial = fxBusy(f.lines) ? fxPartial(f.lines) : '';
      if (partial) onEvent({ type: 'text', delta: partial, t: Date.now() });
      let busy = fxBusy(f.lines);
      const listener = (line: FxLine) => {
        if (line.type === 'turn_start' || line.type === 'turn_resume') busy = true;
        else if (line.type === 'turn_end') busy = fxBusy(f.lines);
        for (const event of fxLiveEvents(line, busy)) onEvent(event);
      };
      clearTimeout(f.parked?.timer);
      f.parked = undefined;
      f.listeners.add(listener);
      // Timing marks (model and tool steps), so the page can take the model's
      // own time out of each turn. The route replays them from the start, so
      // a reconnect skips the ones already passed on.
      const marksAbort = new AbortController();
      void (async () => {
        let passed = 0;
        let failures = 0;
        while (!marksAbort.signal.aborted) {
          try {
            const response = await fetch(`/api/fx-durable/${id}/marks`, { signal: marksAbort.signal });
            if (!response.ok || !response.body) throw new Error(`marks ${response.status}`);
            failures = 0;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let skip = passed;
            let buffered = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffered += decoder.decode(value, { stream: true });
              for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
                const raw = buffered.slice(0, index);
                buffered = buffered.slice(index + 1);
                if (!raw.trim()) continue;
                if (skip > 0) {
                  skip -= 1;
                  continue;
                }
                passed += 1;
                try {
                  onEvent(JSON.parse(raw));
                } catch {}
              }
            }
          } catch {
            if (marksAbort.signal.aborted) return;
            failures += 1;
          }
          await sleep(Math.min(5000, 250 * 2 ** failures));
        }
      })();
      // Crash lines live outside the session's stream: look for new ones while the page follows it.
      let crashes = sides.get(id)?.chaos.length;
      const poll = setInterval(async () => {
        const side = await sideOf(id).catch(() => undefined);
        if (!side || side.chaos.length === crashes) return;
        crashes = side.chaos.length;
        // Not a mark: see fxLiveEvents.
        onEvent(side.chaos.at(-1)?.t === 'fired' ? { type: 'chaos', t: Date.now() } : { type: 'armed', t: Date.now() });
      }, 2000);
      const detach = () => {
        if (!detachers.delete(detach)) return;
        f.listeners.delete(listener);
        marksAbort.abort();
        clearInterval(poll);
        // The last listener gone: stop following soon, unless one comes back first.
        if (!f.listeners.size) park(id, f, GRACE_MS, true);
      };
      detachers.add(detach);
      return detach;
    },
  };
}
