import type { World } from '@workflow/world';

/**
 * The World's in-band writer fence (`WorldCapabilities.inBandFence`,
 * vercel/workflow #4733 and #4821), as harness-world and pi-world use it: who
 * may send it, and how its refusal is recognised. No dependencies, so a bundle
 * of pi-world carries only this.
 */

/** Whether `err` is the World's in-band fence refusing a write (by name and code, never `instanceof`: world-remote rebuilds errors by name). */
export function isInBandSuperseded(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; status?: unknown };
  return e.name === 'InBandSupersededError' || (e.status === 412 && e.code === 'in-band-superseded');
}

/** World errors that are answered before anything is written or counted (world-local's `isDefinitiveRefusal`). */
const DEFINITIVE = new Set([
  'EntityConflictError',
  'RunExpiredError',
  'TooEarlyError',
  'HookNotFoundError',
  'HookForceClaimedError',
  'WorkflowRunNotFoundError',
  'RunNotSupportedError',
]);

export function isDefinitiveRefusal(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; status?: unknown };
  if (typeof e.name === 'string' && DEFINITIVE.has(e.name)) return true;
  return typeof e.status === 'number' && e.status >= 400 && e.status < 500;
}

/**
 * Whether drives on `world` mark their writes in-band and fence them with the
 * World's in-band writer fence (`WorldCapabilities.inBandFence`, vercel/workflow
 * #4733 and #4821). Only a World that declares the capability is ever sent the
 * fence; `HARNESS_IN_BAND_FENCE=0` switches it off everywhere.
 */
export function inBandFenceSupported(world: World): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env?.HARNESS_IN_BAND_FENCE === '0') return false;
  return (world.capabilities as { inBandFence?: unknown } | undefined)?.inBandFence === true;
}

/** A run's fence counters, as a World reads them under its fence: the top slot allocated (`seq`) and the in-band count (`seqInBand`). */
export interface InBandCounters {
  seq: number;
  seqInBand: number;
}

/**
 * Whether a snapshot (or a probe's counters) can be adopted by a reader whose
 * fold holds `eventCount` slots: the counters were read before the listing,
 * so they count only positions up to `seq`, and the reader must have folded
 * every one of them. A listing can stop short of `seq` (world-vercel's sealed
 * log ends a read at a slot still in flight): such a count may include an
 * in-band write the reader never saw, and adopting it would let a decision
 * made without that write through the fence.
 */
export function covers(eventCount: number, counters: InBandCounters | undefined): boolean {
  return !!counters && Number.isSafeInteger(counters.seq) && Number.isSafeInteger(counters.seqInBand) && eventCount >= counters.seq;
}

/** No run's in-band count is this high, so a write expecting it is always refused. */
const UNREACHABLE_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * Read a run's fence counters on a World that fences but lists no snapshot
 * (world-vercel: its backend fences every sealed-log run, but its
 * `events.list` reports no counters): an
 * in-band write at a count no run holds, which the fence refuses before it
 * writes or allocates anything, and whose refusal carries the counters, read
 * under the fence (a strongly consistent read). The write is an `attr_set`
 * the fold ignores, should a World ever take it. Undefined when the World
 * answers anything else (no fence on this run, a transport failure): the
 * caller then writes unfenced.
 *
 * Like a snapshot, the counters may count positions the log does not show
 * yet: adopt them only once a read made after this one `covers` them.
 */
export async function probeInBandCounters(world: World, runId: string): Promise<InBandCounters | undefined> {
  try {
    const created = await (world.events.create as (runId: string, data: unknown, params?: unknown) => Promise<unknown>)(
      runId,
      { eventType: 'attr_set', eventData: { changes: [{ key: 'harness.fence', value: 'probe' }], writer: { type: 'workflow' } } },
      { inBand: true, expectedSeqInBand: UNREACHABLE_COUNT }
    );
    void created;
    return undefined;
  } catch (err) {
    if (!isInBandSuperseded(err)) return undefined;
    const { seq, seqInBand } = err as { seq?: unknown; seqInBand?: unknown };
    if (typeof seq !== 'number' || typeof seqInBand !== 'number') return undefined;
    return { seq, seqInBand };
  }
}

