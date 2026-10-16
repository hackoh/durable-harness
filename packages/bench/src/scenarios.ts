import { isMark, markTime, PROCESS_ID } from 'harness-world';
import { type BenchClient, isMarkNamed, Recorder, type Seen, type SendReceipt, timeOf } from './recorder.ts';

/**
 * The measurements. Each scenario runs one sample
 * against one client and returns named metrics in milliseconds.
 *
 * Times are taken in one clock only: this process's. A mark written by this
 * process (a session driven in this tab) counts at its own `t`; anything
 * else counts when it arrived here, which is what a user sees. Spans inside
 * one other process (the model's own latency as the driver saw it) are
 * differences of that process's marks, never mixed with ours.
 */

export type ScenarioName = 'chat' | 'chat-long' | 'tool-write' | 'tool-bash' | 'steer' | 'handoff-function' | 'handoff-sandbox' | 'crash'
  | 'crash-silent';

export const PROMPTS = {
  short: 'Reply with one short sentence: what is 2+2?',
  followup: 'Now reply with one short sentence: what is 3+3?',
  write: "Write the file notes.txt containing exactly 'hi' using write_file, then reply 'done'.",
  bash: "Run `echo hi` with the bash tool, then reply 'done'.",
  steerBase: 'Run the bash command `sleep 2; echo ok` with the bash tool, then reply with one word.',
  steer: 'After the command finishes, reply with exactly: steered',
  lookup: 'Look up customer acme-42 with lookup_customer and reply with their plan in one short sentence.',
  sandbox: 'Use run_on_machine to run: node -v. Then reply with just the version.',
  crash: "Run the bash command `sleep 3; echo done` with the bash tool, then reply 'ok'.",
} as const;

export interface ScenarioContext {
  client: BenchClient;
  /** Harness name to start: `pi` / `fx`, or `hybrid` / `hybrid-fx` in Hybrid. */
  harness: string;
  /** Measured round trip to the app's Functions (for estimates that lack one hop). */
  rttMs?: number;
  /** For `chat`: how long to stay idle before the follow-up. Default 3000. */
  idleMs?: number;
  log?: (message: string) => void;
}

export interface SampleResult {
  sessionId?: string;
  metrics: Record<string, number | undefined>;
  /** Metrics that are estimates (e.g. a server-clock span plus a measured round trip). */
  estimated?: string[];
  notes?: string[];
}

const isText = (e: any) => e?.type === 'text';
/**
 * The end of a turn: the kernel's `idle` mark (the drive ended with nothing
 * pending). Not the harness's own `idle` event: Pi also emits one when a
 * rebuilt agent finishes replaying the previous turn.
 */
const isIdle = (e: any) => isMark(e) && e.name === 'idle';
const isToolStart = (e: any) => e?.type === 'tool_start';
const isLane = (e: any) => e?.type === 'lane';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const span = (a?: Seen, b?: Seen) => (a && b ? timeOf(b) - timeOf(a) : undefined);
/** `b.t - a.t` when both events carry a server-written time from processes other than this one. */
export function serverSpan(a: Seen, b: Seen): number | undefined {
  const ta = a.event?.t;
  const tb = b.event?.t;
  if (typeof ta !== 'number' || typeof tb !== 'number') return undefined;
  if (typeof a.event?.pid !== 'string' || typeof b.event?.pid !== 'string') return undefined;
  if (a.event.pid === PROCESS_ID || b.event.pid === PROCESS_ID) return undefined;
  return tb - ta;
}
/** A span inside one other process, from its own marks (same pid). */
const within = (a?: Seen, b?: Seen) =>
  a && b && isMark(a.event) && isMark(b.event) && a.event.pid === b.event.pid ? b.event.t - a.event.t : undefined;

async function open(ctx: ScenarioContext): Promise<{ id: string; rec: Recorder; createMs: number }> {
  const t0 = markTime();
  const id = await ctx.client.start(ctx.harness);
  const createMs = markTime() - t0;
  const rec = new Recorder(ctx.client, id);
  await rec.ready;
  return { id, rec, createMs };
}

/**
 * Send `text` now; return when it was sent and the index of the first event
 * after it. A session that refused the message as not ready yet (eve's
 * prewarmed session while its inbox starts: `SendReceipt.notReadyMs`) was
 * still starting, which the other lanes pay in `start()`: `t0` is the attempt
 * it accepted, and the wait is returned on its own.
 */
async function send(ctx: ScenarioContext, rec: Recorder, id: string, text: string, kind: 'prompt' | 'steer' = 'prompt') {
  const from = rec.cursor;
  const sentAt = markTime();
  const receipt = (await ctx.client.send(id, text, kind)) as SendReceipt | undefined;
  // Clients that say nothing about readiness (every lane but eve) report no figure, not 0.
  const notReadyMs = receipt ? (receipt.notReadyMs ?? 0) : undefined;
  const t0 = sentAt + (notReadyMs ?? 0);
  return { t0, from, sentMs: markTime() - t0, notReadyMs };
}

/** TTFT, first output, turn time, and the driver's own view of the model's latency, for one turn. */
async function turn(rec: Recorder, from: number, t0: number, timeoutMs = 90_000) {
  // The end of *this* turn: an idle after its first output (a late line of
  // the previous turn's tail is not it).
  const began = await rec.waitFor((e) => isText(e) || isToolStart(e), { from, timeoutMs, what: 'the first output' });
  const idle = await rec.waitFor(isIdle, { from: began.index, timeoutMs, what: 'the turn to end (idle)' });
  const text = rec.find(isText, from);
  const output = rec.find((e) => isText(e) || isToolStart(e), from);
  const request = rec.find(isMarkNamed('model.request'), from);
  // In the driving process: when its first token existed (a tab drive: before it went round the server's stream).
  const firstLocal = rec.find(isMarkNamed('model.first_token'), from);
  const first = rec.find(isMarkNamed('model.first_token'), from);
  const drive = rec.find(isMarkNamed('drive.start'), from);
  const submit = rec.find(isMarkNamed('submit'), from);
  // What the user sees: when the text and the end of the turn *arrived*
  // here, even from a drive in this very tab (in Hybrid its tokens come back
  // through the server's live stream before the page shows them).
  const modelTtft = within(request, first);
  const firstOutput = output ? output.at - t0 : undefined;
  return {
    ttft: text ? text.at - t0 : undefined,
    firstOutput,
    turn: idle.at - t0,
    /** First output less the model's own time to its first token: everything that is not the model (as /compare's). */
    ttftOverhead: firstOutput !== undefined && modelTtft !== undefined ? firstOutput - modelTtft : undefined,
    /** The turn less every model call's own duration and every tool's run time, from their marks (as /compare's). */
    turnOverhead: turnOverhead(rec, from, idle.index, idle.at - t0),
    /** Send → first token as the driving process had it (this tab's clock only when this tab drives). */
    ttftAtDriver: firstLocal && isMark(firstLocal.event) && firstLocal.event.pid === PROCESS_ID ? firstLocal.event.t - t0 : undefined,
    /** Request out → first output token, in the driving process: the model and network, nothing of ours. */
    modelTtft,
    /** Drive start → model request, in the driving process: rebuilding the harness and writing the intent. */
    driveToRequest: within(drive, request),
    /** How long the submission's own durable write took (0 with durability off). */
    submitLag: typeof submit?.event.lagMs === 'number' ? submit.event.lagMs : undefined,
    idleIndex: idle.index,
  };
}

/**
 * The turn less its model calls and tools: each `model.request` paired with
 * its `model.done` and each `tool.start` with its `tool.end` (same key, same
 * process), between the send and the turn's idle. Undefined when a call has
 * no end there (it cannot be taken out).
 */
function turnOverhead(rec: Recorder, from: number, to: number, turn: number): number | undefined {
  const spans = (start: string, end: string) => {
    const starts = rec.all(isMarkNamed(start), from).filter((x) => x.index < to);
    const ends = rec.all(isMarkNamed(end), from).filter((x) => x.index < to);
    let total = 0;
    for (const a of starts) {
      const b = ends.find((x) => x.event.pid === a.event.pid && x.event.key === a.event.key && x.index > a.index);
      if (!b) return undefined;
      total += (b.event.t as number) - (a.event.t as number);
    }
    return { total, n: starts.length };
  };
  const model = spans('model.request', 'model.done');
  const tools = spans('tool.start', 'tool.end');
  if (!model || !tools || model.n === 0) return undefined;
  return turn - model.total - tools.total;
}

/**
 * Run-ahead only: how far behind the harness its writes became durable
 * (each `ack` mark's `aheadMs`: enqueue to ack, queue wait included).
 */
function durabilityLag(acks: Seen[]): { durabilityLagP50?: number; durabilityLagMax?: number } {
  const ahead = acks.map((s) => (s.event as { aheadMs?: unknown }).aheadMs).filter((v): v is number => typeof v === 'number');
  if (!ahead.length) return {};
  return { durabilityLagP50: median(ahead), durabilityLagMax: Math.max(...ahead) };
}

/** Durable writes acked between two events (frames on the tool path). */
const acksBetween = (rec: Recorder, a?: Seen, b?: Seen) =>
  a && b ? rec.all(isMarkNamed('ack'), a.index).filter((s) => s.index < b.index).length : undefined;

export async function chat(ctx: ScenarioContext): Promise<SampleResult> {
  const { id, rec, createMs } = await open(ctx);
  try {
    const one = await send(ctx, rec, id, PROMPTS.short);
    const a = await turn(rec, one.from, one.t0);
    await sleep(ctx.idleMs ?? 3000);
    const two = await send(ctx, rec, id, PROMPTS.followup);
    const b = await turn(rec, two.from, two.t0);
    const acks = rec.all(isMarkNamed('ack'));
    return {
      sessionId: id,
      metrics: {
        createMs,
        ttft: a.ttft,
        firstOutput: a.firstOutput,
        turn: a.turn,
        ttftOverhead: a.ttftOverhead,
        turnOverhead: a.turnOverhead,
        modelTtft: a.modelTtft,
        ttftAtDriver: a.ttftAtDriver,
        driveToRequest: a.driveToRequest,
        submitLag: a.submitLag,
        sendMs: one.sentMs,
        // Not in any time above: the session still starting when the prompt was sent (eve's prewarm).
        notReadyMs: one.notReadyMs,
        followupTtft: b.ttft,
        followupTurn: b.turn,
        followupModelTtft: b.modelTtft,
        writesPerTurn: acks.length / 2,
        ackP50: median(acks.map((s) => s.event.lagMs as number)),
        ...durabilityLag(acks),
      },
    };
  } catch (err) {
    throw tagged(err, id);
  } finally {
    rec.close();
  }
}

/** A tool turn: model → tool → model. The gap is what the kernel adds between the two model calls. */
function toolScenario(prompt: string) {
  return async (ctx: ScenarioContext): Promise<SampleResult> => {
    const { id, rec } = await open(ctx);
    try {
      const s = await send(ctx, rec, id, prompt);
      const t = await turn(rec, s.from, s.t0);
      const done = rec.find(isMarkNamed('model.done'), s.from);
      const toolStart = done && rec.find(isMarkNamed('tool.start'), done.index);
      const toolEnd = toolStart && rec.find(isMarkNamed('tool.end'), toolStart.index);
      const next = toolEnd && rec.find(isMarkNamed('model.request'), toolEnd.index);
      const gap = within(done, next);
      const toolMs = within(toolStart, toolEnd);
      // `model.done` carries when the response ended and `commitMs` for its
      // own commit after that (the step's progress flush and outcome write
      // in Strict; next to nothing when run ahead). The gap includes that
      // commit. Marks written before 2026-10-02 (51284bc) were stamped after
      // it, so `toolGap - modelCommit` is what older reports call the gap.
      const modelCommit = typeof done?.event.commitMs === 'number' ? (done.event.commitMs as number) : undefined;
      // Model calls the turn took (model → tool → model hops + 1): the same for
      // every cell unless a harness's prompt changes how the model batches tools.
      const modelCalls = rec.all(isMarkNamed('model.request'), s.from).filter((x) => x.index < t.idleIndex).length;
      const notes = next ? [] : ['the model did not call a tool'];
      return {
        sessionId: id,
        metrics: {
          ttft: t.ttft,
          turn: t.turn,
          ttftOverhead: t.ttftOverhead,
          turnOverhead: t.turnOverhead,
          modelTtft: t.modelTtft,
          toolGap: gap,
          toolMs,
          toolOverhead: gap !== undefined && toolMs !== undefined ? gap - toolMs : undefined,
          modelCommit,
          toolWrites: acksBetween(rec, done, next),
          modelCalls,
          // Not in any time above: the session still starting when the prompt was sent (eve's prewarm).
          notReadyMs: s.notReadyMs,
        },
        notes,
      };
    } catch (err) {
      throw tagged(err, id);
    } finally {
      rec.close();
    }
  };
}

/**
 * Steer to effect: a steer sent the moment the tool starts, until the model
 * request that carries it goes out (it lands at the next model boundary).
 */
export async function steer(ctx: ScenarioContext): Promise<SampleResult> {
  const { id, rec } = await open(ctx);
  try {
    if (ctx.client.runScripted) {
      // A raw Function: the steer is made inside the invocation, the moment
      // the tool starts, and timed on that process's clock. Its trip from
      // here and the effect's trip back are one measured round trip.
      const from = rec.cursor;
      await ctx.client.runScripted(id, PROMPTS.steerBase, [{ on: 'tool_start', text: PROMPTS.steer, kind: 'steer' }]);
      const submitted = await rec.waitFor((e) => isMarkNamed('submit')(e) && e.kind === 'steer', { from, what: 'the steer' });
      const steerId = submitted.event.id as string;
      const placed = rec.find((e) => isMark(e) && Array.isArray(e.placed) && e.placed.includes(steerId), submitted.index);
      const carrier = placed && (placed.event.name === 'model.request' ? placed : rec.find(isMarkNamed('model.request'), placed.index));
      const inside = within(submitted, carrier);
      return {
        sessionId: id,
        metrics: { steerToEffect: inside !== undefined ? inside + (ctx.rttMs ?? 0) : undefined, steerToEffectInProcess: inside },
        estimated: ['steerToEffect'],
        notes: carrier ? [] : ['the steer was not carried by a model request'],
      };
    }
    const s = await send(ctx, rec, id, PROMPTS.steerBase);
    const tool = await rec.waitFor(isToolStart, { from: s.from, what: 'the tool to start' });
    const st = await send(ctx, rec, id, PROMPTS.steer, 'steer');
    // The steer's submission id, from its `submit` mark.
    const submitted = await rec.waitFor((e) => isMarkNamed('submit')(e) && e.kind === 'steer', { from: s.from, what: 'the steer to commit' });
    const steerId = submitted.event.id as string;
    const placed = await rec.waitFor((e) => isMark(e) && Array.isArray(e.placed) && e.placed.includes(steerId), {
      from: s.from,
      what: 'the steer to be placed',
    });
    const carrier =
      placed.event.name === 'model.request' ? placed : await rec.waitFor(isMarkNamed('model.request'), { from: placed.index, what: 'the request carrying the steer' });
    await rec.waitFor(isIdle, { from: carrier.index, what: 'the turn to end' });
    return {
      sessionId: id,
      metrics: {
        steerToEffect: timeOf(carrier) - st.t0,
        steerCommit: timeOf(submitted) - st.t0,
        toolStartToSteer: st.t0 - timeOf(tool),
      },
    };
  } catch (err) {
    throw tagged(err, id);
  } finally {
    rec.close();
  }
}

/**
 * A hybrid session moves to a server lane for one tool and back (Hybrid
 * mode only). tabToServer: this tab's handoff mark → the server lane's
 * first mark arriving here. serverToTab, in this tab's clock only: from the
 * first moment this tab could know of the handback (the server's handback
 * line arriving here, or this tab's own read that found it, `handoff.noticed`,
 * whichever came first) to this tab driving again (`handoff.picked`). The
 * server's line and the tab's own marks travel on different streams, so
 * they are searched from the server lane's start, never one after the other.
 */
export function handbackSpan(
  back: Seen | undefined,
  noticed: Seen | undefined,
  driven: Seen | undefined
): number | undefined {
  if (!driven) return undefined;
  const starts = [back ? back.at : Infinity, noticed ? timeOf(noticed) : Infinity];
  const start = Math.min(...starts);
  if (!Number.isFinite(start)) return undefined;
  return Math.max(0, timeOf(driven) - start);
}

/** How long `handoff-sandbox` waits for the session's sandbox host before it sends. */
const HOST_READY_TIMEOUT_MS = 60_000;

function handoffScenario(prompt: string, to: 'function' | 'sandbox') {
  return async (ctx: ScenarioContext): Promise<SampleResult> => {
    const t0 = markTime();
    const { id, rec } = await open(ctx);
    try {
      // The sandbox lane exists only while the session has a live host (its
      // daemon attached). Until then a machine tool is handed to
      // a function, which runs it remotely: the designed fallback, but not the
      // hop this scenario times. So wait for the host, and report how long
      // after the session's start it attached (a fresh VM without the VCR
      // image takes seconds; a pool VM, a few hundred ms).
      let hostReady: number | undefined;
      if (to === 'sandbox' && ctx.client.hostReady) {
        if (!(await ctx.client.hostReady(id, HOST_READY_TIMEOUT_MS))) {
          throw new Error(`the session's sandbox host did not attach within ${HOST_READY_TIMEOUT_MS}ms`);
        }
        hostReady = markTime() - t0;
      }
      const s = await send(ctx, rec, id, prompt);
      const timeoutMs = to === 'sandbox' ? 180_000 : 90_000;
      // The first handoff out of the tab. For the sandbox, a handoff to a
      // function instead means the machine tool went the remote way with a
      // host attached (lost, or not answering its probe): say so now rather
      // than wait out the timeout for a sandbox handoff that will not come.
      const first = await rec.waitFor(
        (e) => isMarkNamed('handoff.sent')(e) && e.from === 'browser' && (e.to === to || (to === 'sandbox' && e.to === 'function')),
        { from: s.from, timeoutMs, what: `the handoff to ${to}` }
      );
      if (first.event.to !== to) {
        throw new Error(`the machine tool was handed to the function lane, not the sandbox (${String(first.event.reason ?? 'no reason given')})`);
      }
      const sent = first;
      // A function drive instead: the host did not take the handoff (its wake
      // probe failed, so the session went to a function, which ran the tool).
      const tookOver = (e: any) => to === 'sandbox' && isMarkNamed('drive.start')(e) && e.lane === 'function';
      const picked = await rec.waitFor((e) => (isMark(e) && e.lane === to && e.name !== 'ack') || tookOver(e), {
        from: sent.index,
        timeoutMs,
        what: `the ${to} lane to start`,
      });
      if (tookOver(picked.event)) throw new Error('the sandbox host did not take the handoff: a function drove the session instead');
      const isBack = (e: any) => (isMarkNamed('handoff.sent')(e) || isLane(e)) && e.to === 'browser';
      const isDriven = (e: any) => isMarkNamed('handoff.picked')(e) && e.to === 'browser';
      const isNoticed = (e: any) => isMarkNamed('handoff.noticed')(e) && e.to === 'browser';
      // Whichever shows up first; then both, briefly (they arrive on separate streams).
      await rec.waitFor((e) => isBack(e) || isDriven(e), { from: picked.index, timeoutMs, what: 'the handback' });
      const driven = await rec.waitFor(isDriven, { from: picked.index, timeoutMs: 30_000, what: 'this tab to drive after the handback' }).catch(() => undefined);
      const back = await rec.waitFor(isBack, { from: picked.index, timeoutMs: 10_000, what: "the server's handback line" }).catch(() => undefined);
      const noticed = rec.find(isNoticed, picked.index);
      const serverDone = rec.find(isMarkNamed('tool.end'), picked.index);
      const notes: string[] = [];
      if (!driven) notes.push('this tab did not report driving after the handback within 30s');
      if (!back) notes.push("the server's handback line did not arrive");
      return {
        sessionId: id,
        metrics: {
          tabToServer: span(sent, picked),
          serverToTab: handbackSpan(back, noticed, driven),
          handoffAfterSend: timeOf(sent) - s.t0,
          serverTool: within(rec.find(isMarkNamed('tool.start'), picked.index), serverDone),
          // Send → this tab driving again, all in this tab's clock.
          total: driven ? timeOf(driven) - s.t0 : back ? timeOf(back) - s.t0 : undefined,
          // Not in any time above: session start → its host attached (the scenario sends after).
          hostReady,
        },
        notes,
      };
    } catch (err) {
      throw tagged(err, id);
    } finally {
      rec.close();
    }
  };
}

/**
 * Crash recovery (a durable server session): arm a crash that kills the
 * process driving the session partway through a tool, then time how long
 * until a new drive picks the session up and until the turn completes.
 */
export function crash(ctx: ScenarioContext): Promise<SampleResult> {
  return crashScenario(ctx, false);
}

/**
 * A crash that leaves no record and sends no wake (`silent`): what an OOM,
 * an instance loss or a SIGKILL from the platform costs. The plain `crash`
 * drill commits proof of death and wakes its own recovery, a shortcut no
 * real failure takes.
 */
export function crashSilent(ctx: ScenarioContext): Promise<SampleResult> {
  return crashScenario(ctx, true);
}

async function crashScenario(ctx: ScenarioContext, silent: boolean): Promise<SampleResult> {
  if (!ctx.client.chaos) throw new Error('this client cannot arm crashes');
  const { id, rec } = await open(ctx);
  try {
    await ctx.client.chaos(id, { at: 'tool', kind: 'process', afterMs: 1000, ...(silent ? { silent: true } : {}) });
    const s = await send(ctx, rec, id, PROMPTS.crash);
    const died = await rec.waitFor((e) => e?.type === 'chaos', { from: s.from, timeoutMs: 90_000, what: 'the crash' });
    const dead = died.event.driver as string | undefined;
    const next = await rec.waitFor((e) => isMarkNamed('drive.start')(e) && e.drv !== dead, { from: died.index, timeoutMs: 180_000, what: 'a new drive after the crash' });
    const recovered = rec.find(isMarkNamed('recover.done'), next.index - 1) ?? rec.find(isMarkNamed('recover.done'), died.index);
    const idle = await rec.waitFor(isIdle, { from: next.index, timeoutMs: 120_000, what: 'the recovered turn to end' });
    // Time the crash from the timestamps the servers wrote, not from when
    // the events reached the bench: the SIGKILL often takes the bench's live
    // connection with it, and the reconnect then replays the crash and the
    // new drive in one burst (a 3ms "recovery"). Server clocks of different
    // Fluid instances are NTP-synced, close enough for second-scale spans.
    const crashSpan = (to?: Seen) => (to ? serverSpan(died, to) ?? span(died, to) : undefined);
    const fromServer = serverSpan(died, next) !== undefined;
    const reannounced = !!died.event.reannounced;
    // Without server times, a crash and its recovery heard together (within
    // one reconnect burst) cannot be told apart: the span is not a recovery time.
    const burst = !fromServer && Math.abs(next.at - died.at) < 250;
    const estimated = reannounced || burst;
    return {
      sessionId: id,
      metrics: {
        crashToDrive: crashSpan(next),
        crashToRecovered: crashSpan(recovered),
        crashToIdle: crashSpan(idle),
        turn: timeOf(idle) - s.t0,
      },
      // The dying process's own `chaos` event was lost with it; this is the
      // recovery's re-announcement, so the crash is timed from the recovery
      // and the spans after it read short.
      ...(estimated
        ? {
            estimated: ['crashToDrive', 'crashToRecovered', 'crashToIdle'],
            notes: [
              reannounced
                ? "crash heard from the recovery (the crash's own live event was lost)"
                : 'crash and recovery arrived in one reconnect burst and carry no server times',
            ],
          }
        : fromServer
          ? { notes: ['timed from server clocks'] }
          : {}),
    };
  } catch (err) {
    throw tagged(err, id);
  } finally {
    rec.close();
  }
}

/** A sample's failure, naming the session it happened in (to inspect it afterwards). */
function tagged(err: unknown, sessionId: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  (e as Error & { sessionId?: string }).sessionId = sessionId;
  return e;
}

function median(xs: number[]): number | undefined {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return undefined;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
}

export const SCENARIOS: Record<ScenarioName, (ctx: ScenarioContext) => Promise<SampleResult>> = {
  chat,
  'chat-long': (ctx) => chat({ ...ctx, idleMs: 6 * 60_000 }),
  'tool-write': toolScenario(PROMPTS.write),
  'tool-bash': toolScenario(PROMPTS.bash),
  steer,
  'handoff-function': handoffScenario(PROMPTS.lookup, 'function'),
  'handoff-sandbox': handoffScenario(PROMPTS.sandbox, 'sandbox'),
  crash,
  'crash-silent': crashSilent,
};
