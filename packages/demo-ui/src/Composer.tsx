import { forwardRef } from 'react';
import { armedText, type Scenario } from './copy.ts';
import { ActionMenu } from './Menu.tsx';
import { useTip } from './Tip.tsx';

function Example({ s, onPick, disabled, reason }: { s: Scenario; onPick(s: Scenario): void; disabled: boolean; reason?: string }) {
  const tip = useTip(reason ?? (s.crash ? `${s.prompt} ${armedText(s.crash)}` : s.prompt));
  return (
    <>
      <button
        type="button"
        className={s.primary ? 'btn btn-primary' : 'btn'}
        aria-disabled={disabled || undefined}
        {...tip.props}
        onClick={() => !disabled && onPick(s)}
      >
        {s.label}
      </button>
      {tip.pop}
    </>
  );
}

/**
 * The examples row: at most four in the row, the rest under More. Crash
 * examples are disabled (with the reason) where nothing is recorded.
 */
export function ScenarioRow(props: { scenarios: Scenario[]; onPick(s: Scenario): void; disabled?: boolean; crashDisabled?: string; limit?: number }) {
  const { scenarios, onPick } = props;
  const row = scenarios.filter((s) => !s.more).slice(0, props.limit ?? 4);
  const more = scenarios.filter((s) => !row.includes(s));
  const off = (s: Scenario) => !!props.disabled || (!!s.crash && !!props.crashDisabled);
  return (
    <div className="scenarios" role="group" aria-label="Examples">
      <span className="label">Examples</span>
      <div className="scenario-buttons">
        {row.map((s) => (
          <Example key={s.label} s={s} onPick={onPick} disabled={off(s)} {...(s.crash && props.crashDisabled ? { reason: props.crashDisabled } : {})} />
        ))}
        {more.length > 0 && (
          <ActionMenu
            label="More"
            className="btn more"
            {...(props.disabled ? { disabled: true } : {})}
            items={more.map((s) => ({
              key: s.label,
              label: s.label,
              detail: s.crash && props.crashDisabled ? props.crashDisabled : s.prompt,
              ...(off(s) ? { disabled: true } : {}),
              run: () => onPick(s),
            }))}
          />
        )}
      </div>
    </div>
  );
}

export interface ComposerProps {
  text: string;
  onText(t: string): void;
  hasSession: boolean;
  harnessName: string;
  sending: boolean;
  /** A turn is running: the button steers it. */
  canSteer: boolean;
  disabled?: boolean;
  onSend(): void;
  onSteer(): void;
  /** Focus (pre-warming). */
  onFocus?(): void;
}

const SHORTCUTS_IDLE = 'Enter sends. Shift+Enter adds a line.';
const SHORTCUTS_RUNNING = 'Enter steers the running turn: delivered at its next model call. ⌘Enter queues it as the next prompt instead. Shift+Enter adds a line.';

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(props, ref) {
  const { text, hasSession, sending, canSteer } = props;
  const steer = canSteer && !sending;
  const label = sending ? 'Sending…' : steer ? 'Steer' : 'Send';
  const empty = !text.trim();
  const tip = useTip(steer ? SHORTCUTS_RUNNING : SHORTCUTS_IDLE);
  const act = () => {
    if (empty || sending || props.disabled) return;
    if (steer) props.onSteer();
    else props.onSend();
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        disabled={props.disabled}
        aria-label={hasSession ? `Message ${props.harnessName}` : 'First prompt'}
        placeholder={hasSession ? `Message ${props.harnessName}…` : `First prompt for a new ${props.harnessName} session…`}
        onChange={(e) => props.onText(e.target.value)}
        onFocus={() => props.onFocus?.()}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.shiftKey) return;
          e.preventDefault();
          // ⌘Enter while a turn runs: the next prompt, not a steer.
          if ((e.metaKey || e.ctrlKey) && steer) {
            if (!empty) props.onSend();
            return;
          }
          act();
        }}
      />
      <button
        type="button"
        className="btn btn-primary composer-send"
        aria-disabled={empty || sending || props.disabled || undefined}
        {...tip.props}
        onClick={act}
      >
        {label}
      </button>
      {tip.pop}
    </div>
  );
});
