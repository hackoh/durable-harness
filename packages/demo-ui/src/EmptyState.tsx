import type { ReactNode } from 'react';
import { EMPTY_CTA, EMPTY_CTA_OR, EMPTY_HEADING, emptyBody } from './copy.ts';
import { useTip } from './Tip.tsx';
import type { Mode, WorldName } from './view.ts';

/**
 * No session open: what the page shows, in one sentence, and the crash demo
 * in one click (the examples row's primary).
 */
export function EmptyState(props: {
  mode: Mode;
  world?: WorldName;
  /** The own-durability harnesses' line (pi-durable, fx-durable), under the sentence. */
  note?: ReactNode;
  onDemo?(): void;
  /** The button's words, when the demo isn't the command crash (`EMPTY_CTA`): the example's own label. */
  demoLabel?: string;
  /** Why the demo can't run here (Native records nothing). */
  demoDisabled?: string;
  busy?: boolean;
}) {
  const tip = useTip(props.demoDisabled);
  const off = !!props.demoDisabled || !props.onDemo || !!props.busy;
  return (
    <div className="empty">
      <h2>{EMPTY_HEADING}</h2>
      <p>{emptyBody(props.mode, props.world)}</p>
      {props.note}
      <div className="empty-cta">
        <button type="button" className="btn btn-primary" aria-disabled={off || undefined} {...tip.props} onClick={() => !off && props.onDemo?.()}>
          {props.demoLabel ?? EMPTY_CTA}
        </button>
        {tip.pop}
        <span className="muted">{EMPTY_CTA_OR}</span>
      </div>
    </div>
  );
}
