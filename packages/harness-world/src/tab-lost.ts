import type { World } from '@workflow/world';
import { anchorKey } from './anchor.ts';
import { commitHandoff, type DeliverMeta, type DriverOptions, deliver, QUEUE_NAME } from './driver.ts';
import { isDetached, isFactStep } from './facts.ts';
import { pendingSubmissions } from './fold.ts';
import { type Hint, hintsStreamName, publishHint } from './hints.ts';
import { currentLane, type HandoffOutput, type LaneOptions, needsOf } from './lanes.ts';
import { harnessOf } from './names.ts';
import { SessionLog } from './session-log.ts';
import { JsonLinesWriter, liveStreamName, readJsonLines } from './streams.ts';
import type { Lane, SessionState } from './types.ts';

/**
 * A tab's tether: the server stands behind a tab that drives a
 * session's `browser` lane through a request the tab holds open to a server
 * Function while it drives. A tab that closes or crashes closes its sockets,
 * and the Function holding the tether hears it; that close is the callback.
 * Nothing in it is periodic: the stream's keepalive comments only keep
 * proxies from cutting an idle connection, and nobody judges their silence.
 *
 * The close does not take the session itself (the Function holding the
 * tether is not a queue delivery: it could die between a handoff and its
 * wake). It queues one `tab-lost` message, delayed a few seconds so a tab
 * whose connection only blipped can re-tether first. The flow-route
 * delivery of that message takes the session over if, by then, it is still
 * in the browser lane at the epoch the tab held, with work the tab was doing
 * or had yet to do, and the tab has not re-tethered since (a one-shot
 * `tether` hint each time it connects). Taking over is a handoff to a
 * server lane, so whatever the tab still writes comes back fenced.
 *
 * Inside the browser, a reloaded tab proves the old page gone with the Web
 * Lock its drives hold (`tabAnchors`), so it recovers at once, before this.
 */
export interface TabLostMessage {
  kind: 'tab-lost';
  tab: string;
  /** The session's epoch when the tether closed: a takeover only applies to that epoch. */
  epoch: number;
  /** The tether connection that closed (the tab counts them). */
  seq: number;
}

/** How long a tab-lost message waits, so a blip can re-tether first. */
export const TAB_LOST_DELAY_SECONDS = 10;

/** Queue the callback for a tether that closed (see the module comment). */
export async function armTabLost(
  world: World,
  runId: string,
  tether: { tab: string; epoch: number; seq: number; delaySeconds?: number }
): Promise<void> {
  const input: TabLostMessage = { kind: 'tab-lost', tab: tether.tab, epoch: tether.epoch, seq: tether.seq };
  await world.queue(QUEUE_NAME, { runId, input }, {
    idempotencyKey: `${runId}:tablost:${tether.epoch}:${tether.tab}:${tether.seq}`,
    delaySeconds: tether.delaySeconds ?? TAB_LOST_DELAY_SECONDS,
  });
}

/** Say a tab (re)tethered: a tab-lost message for an earlier connection of it is then moot. */
export function announceTether(world: World, runId: string, tether: { tab: string; epoch: number; seq: number }): Promise<void> {
  return publishHint(world, runId, { eventType: 'tether', tab: tether.tab, epoch: tether.epoch, slot: tether.seq });
}

/** Whether the tab tethered again after the connection `message` names closed. */
async function retethered(world: World, runId: string, message: TabLostMessage): Promise<boolean> {
  const lines = (await readJsonLines(world, runId, hintsStreamName(runId)).catch(() => [])) as Hint[];
  return lines.some((h) => h?.type === 'hint' && h.eventType === 'tether' && h.tab === message.tab && (h.slot ?? 0) > message.seq);
}

/** Which server lane can finish what the session was doing when the `from` lane stopped driving it. */
export function takeoverLane(state: SessionState, lanes: LaneOptions, from: Lane): Lane {
  const needsSandbox = (key?: string) => {
    const e = key ? state.effects.get(key) : undefined;
    return !!e && (needsOf(e).includes('machine') || e.name === 'tool.sandbox_exec');
  };
  // A sandbox lane that stopped driving lost its host: never hand it back there.
  const serves = (l: Lane) => lanes.serves.includes(l) && !(l === 'sandbox' && from === 'sandbox');
  const unfinished = state.effectOrder.filter((e) => e.status === 'running' || e.status === 'pending');
  if (serves('sandbox') && unfinished.some((e) => needsSandbox(e.key))) return 'sandbox';
  const lastHandoff = state.effectOrder.findLast((e) => e.name === 'handoff');
  if (serves('sandbox') && needsSandbox((lastHandoff?.input as HandoffOutput | undefined)?.forKey)) return 'sandbox';
  if (from === 'sandbox' && serves('sandbox')) return 'sandbox';
  return serves('function') ? 'function' : lanes.serves[0]!;
}

/** One delivery of a `tab-lost` message (see the module comment). */
export async function tabLost(options: DriverOptions, runId: string, message: TabLostMessage, meta: DeliverMeta): Promise<void> {
  const { world } = options;
  const say = options.log ?? (() => {});
  const log = new SessionLog(world, runId);
  await log.refresh();
  const state = log.state;
  if (state.status !== 'running') return;
  const harness = [options.harness].flat().find((h) => h.name === harnessOf(state.workflowName));
  const lanes = harness?.lanes ?? options.lanes;
  if (!lanes) return;
  const lane = currentLane(state, lanes.initial);
  if (lane !== 'browser') {
    // The tab had moved it on (a handoff it committed): make sure that lane
    // has a driver if it has work, the way any delivery would. If it moved it
    // on by escalating, a sibling it was still running stays its drive's
    // (anchorVerdict), so the next lane finds it covered. The tab holds its
    // tether until that drive lets go: a tether that closed and did not come
    // back means the tab is gone, so this callback hands its work over.
    const held = state.effectOrder.some(
      (r) => r.status === 'running' && !isFactStep(r.name) && !(r.park && isDetached(r)) && r.anchor?.k === 'tab' && r.anchor.m === message.tab
    );
    const grant = held && !(await retethered(world, runId, message)) ? { continues: anchorKey({ k: 'tab', m: message.tab }) } : {};
    if (grant.continues) say('tab-lost: handing over what the tab left running', { runId, tab: message.tab });
    await deliver(options, runId, { ...meta, log, ...grant });
    return;
  }
  if (state.epoch !== message.epoch) {
    say('tab-lost: the session moved on since the tether closed', { runId, tab: message.tab });
    return;
  }
  if (await retethered(world, runId, message)) {
    say('tab-lost: the tab tethered again', { runId, tab: message.tab });
    return;
  }
  const open = state.effectOrder.filter((r) => r.status === 'running' && !isFactStep(r.name) && !(r.park && isDetached(r)));
  // Another tab (another profile or device) drives it: its own tether covers it.
  if (open.some((r) => r.anchor?.k === 'tab' && r.anchor.m !== message.tab)) {
    say('tab-lost: another tab drives the session', { runId, tab: message.tab });
    return;
  }
  const settled = state.effectOrder.some((r) => r.status === 'running' && r.park && r.settlement);
  if (open.length === 0 && pendingSubmissions(state).length === 0 && !settled) {
    say('tab-lost: nothing was left to do', { runId, tab: message.tab });
    return;
  }
  const to = takeoverLane(state, lanes, 'browser');
  const handoff: HandoffOutput = { from: 'browser', to, reason: 'takeover: the tab disconnected' };
  const { won } = await commitHandoff(log, handoff, state.epoch, meta.anchor ? { anchor: meta.anchor } : {});
  if (!won) return;
  void publishHint(world, runId, { eventType: 'handoff', slot: log.state.eventCount, to, epoch: log.state.epoch });
  const live = new JsonLinesWriter(world, runId, liveStreamName(runId));
  live.write({ type: 'lane', ...handoff, takeover: true });
  await live.flush();
  say('tab-lost: took the session over', { runId, tab: message.tab, to });
  if (lanes.serves.includes(to)) {
    // Drive it here, under this delivery: the tab's intents are older than
    // the epoch now, so they are resolved without another fence.
    await deliver(options, runId, { ...meta, log });
    return;
  }
  await lanes.wake(runId, to, handoff, { idempotencyKey: `${runId}:${to}:${log.state.epoch}:tablost` });
}
