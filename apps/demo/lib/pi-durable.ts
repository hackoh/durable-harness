import type { World } from '@workflow/world';
import type { ChaosSpec, Hands } from 'harness-world-demo-ui';
import { type PiChaosLine, piProjection, runningEffect, type PiSnapshot } from 'harness-world-demo-ui/pi-view';
import { anchorKey } from 'harness-world/anchor';
import { harnessOfQueue } from 'harness-world/names';
import { encodeLine, readJsonLines } from 'harness-world/streams';
import type { HarnessLease, Opener } from 'durable-harness/pi-durable';
import type { JournalReader } from 'pi-world/reader';
import { isHands } from 'harness-world-demo-ui/axes';
import { gatewayKey, instructionsFor, MODEL } from './model';
import { getWorld } from './world';

/**
 * Pi 1.0 on its own durable engine (`@earendil-works/pi-durable`), on this
 * app's World: the "Pi (pi-durable)" harness choice. The other Pi
 * (harness-world-pi) runs pi-agent-core's Agent on our kernel; this one is a
 * plain pi-durable app whose storage is the World's.
 *
 * This is the code a pi-durable user writes (`durable-harness/pi-durable`):
 * Pi's own models, registry and `Harness.open` in one opener, registered
 * with `resumeWith`; each request shares the session's open Harness
 * (`acquireHarness`), submits with Pi's `root.submit`, and waits until idle
 * in `background` (Next's `after()`). The storage stands behind its own
 * commits: before the first commit that may leave work, it queues a wake
 * delayed past its deadline (renewed while Pi keeps committing), so a process
 * that dies mid-turn is resumed by that wake with the same opener; a Harness
 * closed with work left hands the session to a wake at once. Nothing beats.
 */

export const PI_DURABLE = 'pi-durable';
export const chaosStreamName = (id: string) => `${id}_pichaos`;
/**
 * A session's hands (the demo's Hands axis), written once when it is made:
 * a pi-durable run carries no config of the kernel's, and every open of it
 * (a request's, a wake's on another instance) reads them back here.
 */
export const handsStreamName = (id: string) => `${id}_pihands`;
/**
 * How long a holder may stay silent with work unfinished before the wake
 * behind its storage may take the session over: a silent crash is recovered
 * within this plus 5 s.
 */
export const RECOVER_AFTER_MS = Number(process.env.PI_RECOVER_AFTER_MS ?? process.env.PI_DIRECT_DRIVE_MS ?? 120_000);

interface State {
  world: World;
  /** Pi's own opener: models, registry, `Harness.open`. */
  open: Opener;
  agent: { model: { provider: string; modelId: string } };
  /** Each session's hands, once read (they never change). */
  hands: Map<string, Promise<Hands>>;
  dh: typeof import('durable-harness/pi-durable');
  registered: typeof import('durable-harness').registered;
  readers: Map<string, { reader: JournalReader; busy: Promise<unknown> }>;
  ctx: unknown;
  JournalReader: typeof JournalReader;
  decodeJournalPayload: typeof import('pi-world/reader').decodeJournalPayload;
}

const g = globalThis as { __piDurableLane?: Promise<State> };

/** The process's pi-durable state, loaded on first use (pi-ai 1.0 and pi-durable stay out of other routes). */
export function piState(): Promise<State> {
  g.__piDurableLane ??= (async () => {
    const [world, dh, core, pd, agentMod, readerMod, chord] = await Promise.all([
      getWorld(),
      import('durable-harness/pi-durable'),
      import('durable-harness'),
      import('@earendil-works/pi-durable'),
      import('pi-world/agent'),
      import('pi-world/reader'),
      import('@earendil-works/chord/context'),
    ]);
    const ctx = chord.BACKGROUND_CONTEXT;
    const models = dh.gatewayModels({ apiKey: gatewayKey });
    if (!models.getModel(dh.GATEWAY_PROVIDER, MODEL)) throw new Error(`pi-ai 1.0 does not know ${MODEL}`);
    // Pi's own setup, per open, for the session's hands: Pi's coding tools on a virtual workspace whose
    // files commit with each call's result (durable-harness/pi-durable's CodingTools and virtualEnv()), the
    // same in memory (virtualEnv({ durable: false })), or none; and the two unsafe example tools.
    const envs = { virtual: dh.virtualEnv(), ephemeral: dh.virtualEnv({ durable: false }) };
    const hands = new Map<string, Promise<Hands>>();
    const open: Opener = async (storage) => {
      const h = await handsFor(world, hands, storage.sessionId);
      const registry = pd.createRegistry();
      if (h !== 'none') registry.install(dh.CodingTools);
      registry.install(pd.defineExtension({ name: 'examples', tools: agentMod.unsafeExampleTools() }));
      // sandbox() hands are refused at the session's start (PI_DURABLE_HANDS) until pi-durable's sandboxEnv() lands.
      const env = h === 'sandbox' ? dh.sandboxEnv(await (await import('./hands')).demoSandbox()) : h === 'ephemeral' ? envs.ephemeral : envs.virtual;
      return pd.Harness.open(storage, { models, registry, env, settings: { toolExecution: 'sequential' } }, ctx);
    };
    dh.resumeWith(open, { world, name: PI_DURABLE });
    return {
      world,
      open,
      agent: { model: { provider: dh.GATEWAY_PROVIDER, modelId: MODEL } },
      hands,
      dh,
      registered: core.registered,
      readers: new Map(),
      ctx,
      JournalReader: readerMod.JournalReader,
      decodeJournalPayload: readerMod.decodeJournalPayload,
    };
  })();
  return g.__piDurableLane;
}

const log = (message: string, fields?: Record<string, unknown>) => console.log(`[pi-durable] ${message}`, fields ?? {});
const storageOptions = (s: State) => ({ world: s.world, name: PI_DURABLE, recoverAfterMs: RECOVER_AFTER_MS });

/** A session's hands, as its hands stream has them: Virtual for one made before the hands axis. */
function handsFor(world: World, cache: Map<string, Promise<Hands>>, id: string): Promise<Hands> {
  let hands = cache.get(id);
  if (!hands) {
    hands = readJsonLines(world, id, handsStreamName(id)).then((lines) => {
      const last = (lines as { hands?: unknown }[]).at(-1)?.hands;
      return isHands(last) ? last : 'virtual';
    });
    cache.set(id, hands);
    hands.catch(() => cache.delete(id));
    while (cache.size > 256) cache.delete(cache.keys().next().value as string);
  }
  return hands;
}

/** A session's hands (lib/hands.ts checks them before `createSession`). */
export async function sessionHands(id: string): Promise<Hands> {
  const s = await piState();
  return handsFor(s.world, s.hands, id);
}

/**
 * A new session with these hands: a run with an empty Pi journal (opening a
 * storage without an id creates one; it is closed at once, unwritten), and
 * its hands written before anything can open it.
 */
export async function createSession(hands: Hands = 'virtual'): Promise<string> {
  const s = await piState();
  const storage = await s.dh.openWorldStorage(undefined, storageOptions(s));
  await storage.close(s.ctx as never);
  await s.world.streams.write(storage.sessionId, handsStreamName(storage.sessionId), encoder.encode(`${encodeLine({ hands })}\n\n`));
  s.hands.set(storage.sessionId, Promise.resolve(hands));
  return storage.sessionId;
}

/** Leases a crash drill abandoned: never released (a dead process lets go of nothing). */
const dead = new WeakSet<HarnessLease>();

/**
 * Durably admit a message (Pi's `submit` with a request id, so a retried
 * request finds the same submission), then drive the session until idle in
 * `background` (Next's `after()`), on the session's shared open Harness.
 */
export async function submit(
  id: string,
  text: string,
  kind: 'prompt' | 'steer' | 'followUp',
  requestId: string,
  background: (work: () => Promise<void>) => void
): Promise<string> {
  const s = await piState();
  const lease = await s.dh.acquireHarness(id, s.open, storageOptions(s));
  try {
    const root = await lease.harness.root(s.ctx as never, { agent: { ...s.agent, instructions: instructionsFor(await handsFor(s.world, s.hands, id)) } });
    const submission = await root.submit({ type: 'input', content: text, requestId, whenBusy: kind === 'steer' ? 'steer' : 'followUp' }, s.ctx as never);
    background(() => drive(s, id, lease));
    return String(submission.id);
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/** Wait until the session is idle here, firing an armed crash on the way; then let go of it. */
async function drive(s: State, id: string, lease: HarnessLease): Promise<void> {
  const stop = new AbortController();
  const watcher = watchChaos(s, id, lease, stop);
  try {
    const { withAbortSignal } = await import('@earendil-works/chord/context');
    await lease.harness.waitForIdle(withAbortSignal(stop.signal, s.ctx as never));
  } catch (error) {
    if (!dead.has(lease)) log('drive ended', { id, error: String(error) });
  } finally {
    stop.abort();
    await watcher.catch(() => {});
    // Closing with work left (this one gave up) hands the session to a wake: the storage does it.
    if (!dead.has(lease)) await lease.release().catch((error: unknown) => log('release failed', { id, error: String(error) }));
  }
}

// ---------- reads ----------

/** A snapshot of the session from its log, read incrementally by one reader per session in this process. */
export async function snapshot(id: string): Promise<PiSnapshot> {
  const s = await piState();
  let r = s.readers.get(id);
  if (!r) {
    r = { reader: new s.JournalReader(s.world, id), busy: Promise.resolve() };
    s.readers.set(id, r);
    while (s.readers.size > 32) s.readers.delete(s.readers.keys().next().value as string);
  }
  const entry = r;
  const next = entry.busy.then(async () => {
    await entry.reader.refresh();
    return entry.reader.snapshot();
  });
  entry.busy = next.catch(() => {});
  try {
    return (await next) as PiSnapshot;
  } catch (error) {
    s.readers.delete(id);
    throw error;
  }
}

export async function chaosLines(world: World, id: string): Promise<PiChaosLine[]> {
  return (await readJsonLines(world, id, chaosStreamName(id))) as PiChaosLine[];
}

export async function view(id: string) {
  const s = await piState();
  const [snap, chaos, hands] = await Promise.all([snapshot(id), chaosLines(s.world, id), handsFor(s.world, s.hands, id)]);
  const projection = piProjection(snap, chaos);
  return { snap, chaos, ...projection, view: { ...projection.view, hands } };
}

export async function eventPayload(id: string, eventId: string): Promise<unknown> {
  const s = await piState();
  const crash = /:chaos:(\d+)$/.exec(eventId);
  if (crash) return (await chaosLines(s.world, id))[Number(crash[1])];
  const e = await s.world.events.get(id, eventId.replace(/:start$/, ''), { resolveData: 'all' } as never);
  const payload = (e as { eventData?: { payload?: unknown } }).eventData?.payload;
  if (payload === undefined) return (e as { eventData?: unknown }).eventData;
  // A journal commit: JSON text in the `devl` codec (bare JSON text in sessions written before 2026-10-07).
  try {
    return s.decodeJournalPayload(payload);
  } catch {
    return payload;
  }
}

// ---------- crashes ----------

const encoder = new TextEncoder();
async function writeChaos(world: World, id: string, line: PiChaosLine): Promise<void> {
  await world.streams.write(id, chaosStreamName(id), encoder.encode(`${encodeLine(line)}\n\n`));
}

/**
 * Arm a crash: whichever process drives the session next fires it (see `watchChaos`).
 * `silent` dies the way a platform kill does: no continuation, so the wake behind the drive recovers it.
 */
export async function arm(id: string, spec: ChaosSpec & { silent?: boolean }): Promise<void> {
  const s = await piState();
  await writeChaos(s.world, id, { t: 'armed', at: Date.now(), spec });
}

/**
 * While a drive runs: poll the crash stream, and when an armed crash's step
 * has been running for its delay, record the kill and die. On Vercel the
 * function exits (`process.exit`), exactly a crashed invocation; elsewhere
 * (a local dev server, where exiting would stop the server) the storage is
 * abandoned instead, as the pi-world tests simulate a crash: no more
 * commits, no close entry, the harness never closed. Recovery is the wake
 * behind the storage's newest commit (past its deadline); a drill that is
 * not `silent` also hands the session to a continuation as its last act, so
 * it resumes at once (a shortcut a real crash does not take).
 */
async function watchChaos(s: State, id: string, lease: HarnessLease, stop: AbortController): Promise<void> {
  const signal = stop.signal;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (!signal.aborted && !dead.has(lease)) {
    await sleep(400);
    if (signal.aborted) return;
    const lines = await chaosLines(s.world, id).catch(() => []);
    const last = lines.at(-1);
    if (last?.t !== 'armed') continue;
    const snap = await snapshot(id).catch(() => undefined);
    if (!snap) continue;
    const target = runningEffect(snap);
    if (!target) continue;
    const at = last.spec.at;
    const isTool = target.name.startsWith('tool.');
    if ((at === 'tool' && !isTool) || (at === 'model' && isTool)) continue;
    const task = snap.tasks.find((t) => `${t.kind === 'pi.tool' ? 'tool' : 'gen'}:${t.id}` === target.key);
    const since = task?.starts.at(-1) ? Date.parse(task.starts.at(-1)!.at) : Date.now();
    if (Date.now() - since < (last.spec.afterMs ?? 1500)) continue;
    const storage = lease.storage;
    await writeChaos(s.world, id, { t: 'fired', at: Date.now(), spec: last.spec, effectKey: target.key, effectName: target.name, by: storage.writer });
    log('crash', { id, effect: target.name, vercel: !!process.env.VERCEL });
    const anchor = storage.anchor;
    if (!(last.spec as { silent?: boolean }).silent && anchor) {
      const { wake } = await import('pi-world');
      await wake(s.world, id, { continues: anchorKey(anchor), delaySeconds: 1, idempotencyKey: `${id}:pi-chaos:${anchor.m}` }).catch(() => {});
    }
    if (process.env.VERCEL) process.exit(1);
    dead.add(lease);
    storage.abandon();
    stop.abort();
    return;
  }
}

// ---------- the queue ----------

/** A message on the World's queue that is a pi-world wake (`worldStorage.wake`). */
export function isPiWake(message: unknown): message is { runId: string; input: { kind: 'pi-wake'; continues?: string } } {
  const m = message as { runId?: unknown; input?: { kind?: unknown } } | undefined;
  return typeof m?.runId === 'string' && m.input?.kind === 'pi-wake';
}

/** A World recovery delivery for a pi-durable run: its queue is named after the run's workflow. */
export const isPiDurableQueue = (queueName: string) => harnessOfQueue(queueName) === PI_DURABLE;

/**
 * One delivery for a pi-durable session (a wake, a continuation, a World's
 * recovery delivery), handed to the opener this app registered with
 * `resumeWith`: it opens the session under the delivery's message, resumes
 * it, waits until idle and closes it. A session this process holds open is
 * joined (through the shared Harness), never acked.
 */
export async function handleWake(message: unknown, meta: { messageId: string; queueName: string; attempt?: number }): Promise<unknown> {
  const s = await piState();
  const agent = s.registered().find((a) => a.name === PI_DURABLE && a.world === s.world);
  if (!agent) throw new Error('pi-durable: no opener registered for this World');
  const runId = (message as { runId?: unknown } | undefined)?.runId;
  log('wake', { runId, queueName: meta.queueName });
  return agent.consume(message, { attempt: meta.attempt ?? 1, ...meta });
}

// ---------- live ----------

/** How often the live route reads the log. pi-durable commits its streamed partial about every 100 ms. */
const LIVE_POLL_MS = 150;

/**
 * Server-sent events for a pi-durable session, from its log: Pi commits the
 * in-flight response (`pi.live`) about every 100 ms, so following the log is
 * the live stream. Sends `text` deltas of that partial, `tool_start` when a
 * tool task starts, `idle` when nothing is left to do, and a `mark` per
 * structural commit (an entry, a task changing state) so the page re-reads.
 */
export function liveStream(id: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (s: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          open = false;
        }
      };
      send('retry: 500\n: ready\n\n');
      const event = (e: unknown) => send(`data: ${JSON.stringify(e)}\n\n`);
      // A (re)connect replays the partial from its start: the page drops what it buffered.
      event({ type: 'rewind', reason: 'connect', t: Date.now() });
      let text = '';
      let gen = '';
      let shape = '';
      let busy: boolean | undefined;
      let chaos = 0;
      let polls = 0;
      const tools = new Set<string>();
      const hb = setInterval(() => send(': hb\n\n'), 15_000);
      const s = await piState();
      while (open && !signal.aborted) {
        try {
          const snap = await snapshot(id);
          const running = snap.tasks.find((t) => t.kind === 'pi.generation' && t.status !== 'terminal' && t.starts.length);
          const now = running ? `${running.id}:${running.starts.length}` : '';
          const partial = (snap.live?.generation?.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join('');
          if (now !== gen) {
            gen = now;
            text = '';
          }
          if (now && partial.length > text.length && partial.startsWith(text)) {
            event({ type: 'text', delta: partial.slice(text.length), t: Date.now() });
            text = partial;
          }
          for (const t of snap.tasks) {
            const key = `${t.id}:${t.starts.length}`;
            if (t.kind === 'pi.tool' && t.status !== 'terminal' && t.starts.length && !tools.has(key)) {
              tools.add(key);
              event({ type: 'tool_start', t: Date.now() });
            }
          }
          const nextShape = `${snap.entries.length}|${snap.tasks.map((t) => `${t.id}${t.status}${t.starts.length}`).join(',')}`;
          if (nextShape !== shape) {
            shape = nextShape;
            event({ type: 'mark', name: 'commit', commits: snap.commits, t: Date.now() });
          }
          const nowBusy = snap.unfinished;
          if (busy === true && !nowBusy) event({ type: 'idle', t: Date.now() });
          busy = nowBusy;
          const lines = ++polls % 7 === 0 ? await chaosLines(s.world, id).catch(() => []) : undefined;
          if (lines && lines.length !== chaos) {
            chaos = lines.length;
            const last = lines.at(-1);
            event(last?.t === 'fired' ? { type: 'chaos', t: Date.now() } : { type: 'mark', name: 'chaos', t: Date.now() });
          }
        } catch (error) {
          event({ type: 'mark', name: 'read_failed', error: String(error), t: Date.now() });
        }
        await new Promise((r) => setTimeout(r, LIVE_POLL_MS));
      }
      clearInterval(hb);
      if (open) {
        open = false;
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'content-encoding': 'identity', 'x-accel-buffering': 'no' },
  });
}
