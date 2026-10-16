import { useTip } from './Tip.tsx';
import type { LedgerEntry } from './view.ts';

/**
 * The session's external side effects (the unsafe example tools' ledger),
 * one row per record. A tool call that shows up twice ran twice: those rows
 * are marked, which is what a `replay: 'never'` tool exists to prevent.
 */
export function SideEffects({ ledger }: { ledger?: LedgerEntry[] }) {
  if (!ledger?.length) return null;
  const perCall = new Map<string, number>();
  for (const r of ledger) perCall.set(r.callKey, (perCall.get(r.callKey) ?? 0) + 1);
  const dupes = [...perCall.values()].filter((n) => n > 1).length;
  return (
    <div className="side-effects" aria-label="Side effects" style={{ borderTop: '1px solid var(--hairline)', padding: '8px 16px', maxHeight: 180, overflow: 'auto' }}>
      <div style={{ font: '500 12px/16px var(--sans)', display: 'flex', gap: 8, marginBottom: 4 }}>
        <span>Side effects</span>
        <span className="num" style={{ color: 'var(--graphite)' }}>{ledger.length}</span>
        <span style={{ color: dupes ? 'var(--crash)' : 'var(--graphite)', fontWeight: 400 }}>
          {dupes ? `${dupes} tool call${dupes > 1 ? 's' : ''} ran more than once` : 'outside the log: one row per execution'}
        </span>
      </div>
      {ledger.map((r) => (
        <SideEffectRow key={r.ref} r={r} dup={(perCall.get(r.callKey) ?? 0) > 1} />
      ))}
    </div>
  );
}

function SideEffectRow({ r, dup }: { r: LedgerEntry; dup: boolean }) {
  const tip = useTip(<pre>{`${r.tool} ${JSON.stringify(r.input)}\ncall ${r.callKey}${r.stepId ? `\nstep ${r.stepId}` : ''}`}</pre>, { wide: true });
  return (
    <div
      data-dup={dup ? '' : undefined}
      tabIndex={0}
      {...tip.props}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
        columnGap: 8,
        font: '400 12px/18px var(--mono)',
        color: dup ? 'var(--crash)' : 'var(--ink)',
        background: dup ? 'var(--crash-tint)' : undefined,
      }}
    >
      <span>{r.tool.replace(/^unsafe_/, '')}</span>
      <span className="one-line" style={{ color: dup ? undefined : 'var(--graphite)' }}>
        {r.callKey}
      </span>
      <span className="num" style={{ color: dup ? undefined : 'var(--graphite)', fontFamily: 'var(--sans)' }}>
        {new Date(r.at).toLocaleTimeString()}
      </span>
      {tip.pop}
    </div>
  );
}
