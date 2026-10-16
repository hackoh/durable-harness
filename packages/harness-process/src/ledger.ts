import type { GatewayLedger } from './gateway.ts';
import type { NativeJournal } from './journal.ts';
import type { JournalRecord } from './records.ts';

/**
 * A `GatewayLedger` (docs/workspaces.md §5.5 step 6) kept in the session's
 * native journal: each charge is a record on the `hw.spend` stream, so the
 * turn's and the session's totals carry across invocations and redeliveries
 * (a later drive reads what earlier ones charged from the log). A turn is
 * keyed by the id the harness gives it (`turn(id)`, the first submission the
 * turn carries): a redelivered turn keeps its key, and so its total.
 *
 * Records ride the journal's group commit, so a crash can lose the charges of
 * the batch still in flight (at most a few responses' worth): the caps are a
 * spend bound within that margin, not an exact one. The handler's own
 * `ceiling` estimate covers a response cut off before its cost arrived.
 */

/** The journal stream the charges are on. */
export const SPEND_STREAM = 'hw.spend';

/** One charge, as recorded. */
export interface SpendRecord {
  usd: number;
  /** The turn's key (`turn(id)`), if one was set. */
  turn?: string;
  /** Charged at the handler's ceiling: the Gateway gave no cost for the response. */
  estimated?: boolean;
  path: string;
  model?: string;
}

export interface JournalLedger extends GatewayLedger {
  /** Start (or resume) the turn keyed by `id`: its total is what the log holds for that key, plus what this drive charges. */
  turn(id: string): void;
}

/**
 * A ledger over `journal`, its totals read from the log at once: from
 * `records` when given (`await journal.read()`, offloaded records read back
 * from the blob stream), else `journal.records()` (a charge is far below the
 * offload size, so none is offloaded). A record that isn't a charge counts
 * nothing.
 */
export function journalLedger(journal: NativeJournal, options: { records?: readonly JournalRecord[] } = {}): JournalLedger {
  let session = 0;
  const byTurn = new Map<string, number>();
  const records = options.records ? (options.records.filter((r) => r.stream === SPEND_STREAM) as JournalRecord<SpendRecord>[]) : journal.records<SpendRecord>(SPEND_STREAM);
  for (const r of records) {
    const usd = typeof r.data?.usd === 'number' && Number.isFinite(r.data.usd) && r.data.usd >= 0 ? r.data.usd : 0;
    session += usd;
    if (typeof r.data?.turn === 'string') byTurn.set(r.data.turn, (byTurn.get(r.data.turn) ?? 0) + usd);
  }
  let current: string | undefined;
  return {
    turn(id) {
      current = id;
    },
    spent() {
      return { turnUsd: current === undefined ? 0 : (byTurn.get(current) ?? 0), sessionUsd: session };
    },
    add(usd, info) {
      if (!(Number.isFinite(usd) && usd >= 0)) return;
      session += usd;
      if (current !== undefined) byTurn.set(current, (byTurn.get(current) ?? 0) + usd);
      const record: SpendRecord = { usd, ...(current !== undefined ? { turn: current } : {}), ...(info.estimated ? { estimated: true } : {}), path: info.path, ...(info.model ? { model: info.model } : {}) };
      journal.append(SPEND_STREAM, record);
    },
  };
}
