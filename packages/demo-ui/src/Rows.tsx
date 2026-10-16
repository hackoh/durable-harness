import { memo, type ReactNode, useState } from 'react';
import { CrashGlyph, type LiveText, Ticker, useLiveText } from './bits.tsx';
import { CRASH_BELOW, checkpointText, handoffReason, interruptedNote, laneInline, laneLabel, openText } from './copy.ts';
import {
  cite,
  fmtDone,
  fmtRecovery,
  inFlight,
  type LogIndex,
  midId,
  modelText,
  modelToolCalls,
  partialText,
  settledBy,
  type StepTimes,
  toolText,
} from './lanes.ts';
import { Markdown } from './Markdown.tsx';
import { docText, exitCode, relativizePaths, showsOutput, toolSummary } from './tools.ts';
import { type Item, itemIndexes } from './Transcript.tsx';
import { type LedgerEntry, type Mode, movesLanes, type WorldName } from './view.ts';

/**
 * The transcript's rows, one component per item kind. They load with the
 * page in their own chunk, together with the Markdown renderer they use
 * (the first chunk has a budget); the transcript shows rows once it's here.
 */

export interface RowCtx {
  mode: Mode;
  world?: WorldName;
  harnessName: string;
  times: Map<string, StepTimes>;
  index: LogIndex;
  live: LiveText;
  /** The server went away at this time: running timers stop there. */
  frozenAt?: number;
  selectedKey?: string;
  /** The one row in the tab order (arrow keys move between rows). */
  tabKey?: string;
  /** The session's side effects (the unsafe example tools' ledger), for the payment rows. */
  ledger?: LedgerEntry[];
  onSelect(item: Item): void;
  onHover(item: Item | undefined): void;
  onCite(indexes: number[]): void;
  onOpenFile(path: string): void;
}

function Cite({ indexes, onCite }: { indexes: number[]; onCite(i: number[]): void }) {
  const text = cite(indexes);
  if (!text) return null;
  return (
    <button
      type="button"
      className="t-cite"
      tabIndex={-1}
      aria-label={`Show events ${text} in the log`}
      onClick={(ev) => {
        ev.stopPropagation();
        onCite(indexes);
      }}
    >
      {text}
    </button>
  );
}

function stepDuration(times: Map<string, StepTimes>, stepId: string): string {
  const t = times.get(stepId);
  return t?.started !== undefined && t.ended !== undefined ? fmtDone(t.ended - t.started) : '';
}

function Duration({ times, stepId, running, frozenAt }: { times: Map<string, StepTimes>; stepId: string; running: boolean; frozenAt?: number }) {
  if (running) return <Ticker since={times.get(stepId)?.started} until={frozenAt} every={100} />;
  return <>{stepDuration(times, stepId)}</>;
}

function RowShell(props: {
  item: Item;
  ctx: RowCtx;
  kind: ReactNode;
  status?: ReactNode;
  tone?: string;
  duration?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { item, ctx } = props;
  // A lane border only where a session moves between lanes.
  const lane = movesLanes(ctx.mode) && 'lane' in item ? item.lane : undefined;
  const indexes = itemIndexes(item, ctx.index);
  return (
    <div
      className={`t-row ${props.className ?? ''}`}
      data-key={item.key}
      {...(lane ? { 'data-lane': lane } : {})}
      {...selectable(item, ctx)}
    >
      <div className="t-kind">
        <span>{props.kind}</span>
        <Cite indexes={indexes} onCite={ctx.onCite} />
      </div>
      <div className="t-content">{props.children}</div>
      <div className="t-status" data-tone={props.tone}>
        {props.status}
      </div>
      <div className="t-dur num">{props.duration}</div>
    </div>
  );
}

const StatusIcon = ({ running }: { running: boolean }) => (running ? <span className="spinner" aria-hidden="true" /> : <span />);

function UserRow({ item, ctx }: { item: Extract<Item, { t: 'user' }>; ctx: RowCtx }) {
  return (
    <RowShell
      item={item}
      ctx={ctx}
      kind={item.steer ? 'Steer' : 'You'}
      status={
        item.queued || item.withdrawn ? (
          <>
            <span />
            {item.queued ? 'Queued' : 'Withdrawn'}
          </>
        ) : undefined
      }
    >
      <div className="bubble" {...(item.queued ? { 'data-queued': '' } : {})} {...(item.withdrawn ? { 'data-withdrawn': '' } : {})}>
        <Markdown text={item.text} className="prose" />
      </div>
    </RowShell>
  );
}

/** Arrow keys move focus between rows; the transcript is one tab stop. */
function moveFocus(from: HTMLElement, dir: 1 | -1 | 'first' | 'last') {
  const rows = Array.from(from.parentElement?.querySelectorAll<HTMLElement>(':scope > [data-key]') ?? []);
  const i = rows.indexOf(from);
  const next = dir === 'first' ? rows[0] : dir === 'last' ? rows.at(-1) : rows[i + dir];
  if (!next) return;
  from.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
}

/** Click, hover and keyboard selection, shared by every row kind. */
function selectable(item: Item, ctx: RowCtx) {
  return {
    tabIndex: ctx.tabKey === item.key ? 0 : -1,
    'aria-current': ctx.selectedKey === item.key || undefined,
    onClick: () => ctx.onSelect(item),
    onKeyDown: (ev: React.KeyboardEvent<HTMLElement>) => {
      if (ev.target !== ev.currentTarget) return;
      const dir = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : ev.key === 'Home' ? 'first' : ev.key === 'End' ? 'last' : undefined;
      if (dir) {
        ev.preventDefault();
        moveFocus(ev.currentTarget, dir);
        return;
      }
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      ctx.onSelect(item);
    },
    onMouseEnter: () => ctx.onHover(item),
    onMouseLeave: () => ctx.onHover(undefined),
  };
}

function StreamingText({ live }: { live: LiveText }) {
  const text = useLiveText(live);
  if (!text) return <span className="thinking">Thinking…</span>;
  return <Markdown text={relativizePaths(text)} className="prose streaming" caret />;
}

function ModelRow({ item, ctx }: { item: Extract<Item, { t: 'model' }>; ctx: RowCtx }) {
  const e = item.effect;
  const running = inFlight(e);
  const failed = e.status === 'failed';
  const text = modelText(e);
  const calls = modelToolCalls(e);
  let body: ReactNode;
  if (running) body = <StreamingText live={ctx.live} />;
  else if (failed) body = <pre className="prose" style={{ color: 'var(--crash)' }}>{e.error?.message ?? 'The model call failed.'}</pre>;
  else if (text) body = <Markdown text={relativizePaths(text)} className="prose" />;
  else body = <span className="muted">{calls.length ? `Called ${calls.join(', ')}` : 'No text in this response.'}</span>;
  return (
    <RowShell
      item={item}
      ctx={ctx}
      className="t-assistant"
      kind={ctx.harnessName}
      tone={failed ? 'failed' : undefined}
      status={
        running || failed ? (
          <>
            <span />
            <span>{running ? 'Streaming' : 'Failed'}</span>
          </>
        ) : undefined
      }
      duration={<Duration times={ctx.times} stepId={e.stepId} running={running} frozenAt={ctx.frozenAt} />}
    >
      {body}
    </RowShell>
  );
}

/** A process harness's assistant message, from its normalized transcript. */
function MessageRow({ item, ctx }: { item: Extract<Item, { t: 'message' }>; ctx: RowCtx }) {
  return (
    <RowShell item={item} ctx={ctx} className="t-assistant" kind={ctx.harnessName}>
      {item.text ? <Markdown text={relativizePaths(item.text)} className="prose" /> : <span className="muted">No text in this response.</span>}
    </RowShell>
  );
}

/** "Show What It Was Told": the note a process harness sent its model after a crash, behind a disclosure. */
function Told({ text, label = 'Show What It Was Told' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="link"
        aria-expanded={open}
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {open ? 'Hide What It Was Told' : label}
      </button>
      {open && <pre className="tool-out told">{relativizePaths(text)}</pre>}
    </>
  );
}

/** A recovery note with no crash row above it (a kill nobody recorded, a turn on a new instance): one line. */
function NoteRow({ item, ctx }: { item: Extract<Item, { t: 'note' }>; ctx: RowCtx }) {
  return (
    <RowShell item={item} ctx={ctx} kind="">
      <div className="sub-note">{ctx.harnessName} was told its turn was interrupted and what the log knows.</div>
      <Told text={item.text} />
    </RowShell>
  );
}

/**
 * A process harness's live text, before its message is in the log: its
 * model call is the CLI's, not a step, so there is no running model row to
 * stream into.
 */
export function StreamRow({ ctx }: { ctx: RowCtx }) {
  return (
    <div className="t-row t-assistant" data-key="stream:live">
      <div className="t-kind">
        <span>{ctx.harnessName}</span>
      </div>
      <div className="t-content">
        <StreamingText live={ctx.live} />
      </div>
      <div className="t-status">
        <span />
        <span>Streaming</span>
      </div>
      <div className="t-dur" />
    </div>
  );
}

/** Below a payment: how many times it really ran, from the side-effect ledger outside the log. */
function Charged({ ledger, callKey }: { ledger?: LedgerEntry[]; callKey: string }) {
  const runs = (ledger ?? []).filter((r) => r.callKey === callKey);
  if (!runs.length) return null;
  const input = runs[0]!.input as { to?: unknown; amount_usd?: unknown };
  const what = [typeof input.to === 'string' ? input.to : undefined, input.amount_usd !== undefined ? `$${input.amount_usd}` : undefined].filter(Boolean).join(' ');
  return runs.length === 1 ? (
    <div className="sub-note">Charged once{what ? `: ${what}` : ''}</div>
  ) : (
    <div className="sub-note" data-tone="failed">
      Ran {runs.length === 2 ? 'twice' : `${runs.length} times`}
      {what ? `: ${what}` : ''}
    </div>
  );
}

function ToolRow({ item, ctx }: { item: Extract<Item, { t: 'tool' }>; ctx: RowCtx }) {
  const e = item.effect;
  const [all, setAll] = useState(false);
  const [raw, setRaw] = useState(false);
  const running = inFlight(e);
  const interrupted = e.status === 'failed' && !!e.error?.interrupted;
  const failed = e.status === 'failed' && !interrupted;
  const name = e.name.slice(5);
  const summary = toolSummary(name, e.input);
  const out = e.status === 'completed' ? toolText(e.output) : interrupted ? partialText(e.error) : failed ? String(e.error?.message ?? '') : '';
  // A shell that exited non-zero is a normal result: "exit 1", not a failure.
  const code = summary.kind === 'command' ? exitCode(failed ? out : e.status === 'completed' ? out.split('\n')[0] : undefined) : undefined;
  const shown = failed ? relativizePaths(out) : summary.kind === 'doc' ? (summary.reads ? docText(out) : '') : showsOutput(summary.kind) ? relativizePaths(out) : '';
  const lines = shown.split('\n').length;
  const clamp = !all && lines > 8;
  let args = '';
  try {
    args = JSON.stringify(e.input ?? {}, null, 2);
  } catch {}
  const status = running
    ? 'Running'
    : interrupted
      ? 'Interrupted'
      : code !== undefined && code !== 0
        ? `exit ${code}`
        : failed
          ? 'Failed'
          : undefined;
  const modelMs = item.model ? stepDuration(ctx.times, item.model.stepId) : '';
  const text = summary.kind === 'write' && running && summary.path ? `Writing ${summary.path}` : summary.text;
  return (
    <RowShell
      item={item}
      ctx={ctx}
      kind={<span className="mono">{name}</span>}
      tone={failed && code === undefined ? 'failed' : interrupted ? 'interrupted' : undefined}
      status={
        status ? (
          <>
            <StatusIcon running={running} />
            {status}
          </>
        ) : undefined
      }
      duration={
        <>
          <Duration times={ctx.times} stepId={e.stepId} running={running} frozenAt={ctx.frozenAt} />
          {modelMs && <span className="t-model">model {modelMs}</span>}
        </>
      }
    >
      <div className="tool-head">
        {summary.kind === 'command' ? (
          <code className="tool-cmd">{text}</code>
        ) : summary.path ? (
          <span>
            {text.slice(0, text.indexOf(summary.path))}
            <button
              type="button"
              tabIndex={-1}
              className="path"
              onClick={(ev) => {
                ev.stopPropagation();
                ctx.onOpenFile(summary.path!);
              }}
            >
              {summary.path}
            </button>
            {text.slice(text.indexOf(summary.path) + summary.path.length)}
          </span>
        ) : (
          <span className="tool-args">{text}</span>
        )}
        {e.attempt >= 2 && <span className="muted">attempt {e.attempt}</span>}
      </div>
      {shown.trim() && (
        <pre className="tool-out" {...(clamp ? { 'data-clamp': '' } : {})}>
          {shown}
        </pre>
      )}
      <div className="tool-links">
        {lines > 8 && (
          <button
            type="button"
            className="link"
            onClick={(ev) => {
              ev.stopPropagation();
              setAll((a) => !a);
            }}
          >
            {all ? 'Show Less' : 'Show All'}
          </button>
        )}
        <button
          type="button"
          className="link"
          aria-expanded={raw}
          onClick={(ev) => {
            ev.stopPropagation();
            setRaw((r) => !r);
          }}
        >
          {raw ? 'Hide Raw' : 'Show Raw'}
        </button>
      </div>
      {raw && (
        <pre className="tool-out raw">
          {args}
          {e.status === 'completed' && (summary.kind === 'doc' || !showsOutput(summary.kind)) ? `\n\n${out}` : ''}
        </pre>
      )}
      {name === 'unsafe_make_payment' && <Charged ledger={ctx.ledger} callKey={e.key} />}
      {e.park && running && !e.settlement && (
        <div className="sub-note">
          Running in the sandbox{e.park.cmdId ? ` (cmd ${midId(e.park.cmdId)})` : ''}, no function attached.{' '}
          {e.park.push ? 'It reports back when it exits.' : 'A result check polls the Sandbox API.'}
        </div>
      )}
      {e.settlement && e.settlement.by !== 'inline' && (
        <div className="sub-note">
          Reported by{' '}
          {e.settlement.by === 'push'
            ? 'the sandbox (push)'
            : e.settlement.by === 'check'
              ? 'a result check'
              : e.settlement.by === 'tether'
                ? "the sandbox lane's tether"
                : 'the (retired) backstop'}
          .
        </div>
      )}
      {interrupted && <div className="sub-note">{item.crashed ? CRASH_BELOW : interruptedNote(!!out.trim())}</div>}
    </RowShell>
  );
}

function HandoffRow({ item, ctx }: { item: Extract<Item, { t: 'handoff' }>; ctx: RowCtx }) {
  const back = item.to === 'browser';
  const text = back ? (
    <>
      Back in <strong data-lane="browser">this tab</strong>: the {item.from ? `${laneLabel(item.from, ctx.mode, ctx.world)} lane` : 'server lane'} went idle
    </>
  ) : (
    <>
      Moved to <strong data-lane={item.to}>{laneInline(item.to, ctx.mode, ctx.world)}</strong>
      {item.reason ? `: ${handoffReason(item.reason, item.to)}` : ''}
    </>
  );
  return (
    <div className="t-divider" data-key={item.key} {...selectable(item, ctx)}>
      <span className="text">{text}</span>
      <span className="rule" />
      <Cite indexes={itemIndexes(item, ctx.index)} onCite={ctx.onCite} />
    </div>
  );
}

/** "1.5 s", from a crash's `afterMs`; a non-breaking space keeps the number with its unit when the sentence wraps. */
const seconds = (ms: unknown) => `${(Number(ms ?? 0) / 1000).toFixed(1).replace(/\.0$/, '')}\u00a0s`;
/** A duration ("4.8 s", "1 min 05 s") that wraps as one word. */
const unbroken = (text: string) => text.replace(/ (s|min)\b/g, '\u00a0$1');
const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);
/** A tool name opening a sentence: "bash" reads "Bash", an identifier such as unsafe_make_payment stays as written. */
const sentenceStart = (name: string) => (/^[a-z]+$/.test(name) ? capital(name) : name);

/** What a crash row says: who died, how far into what, and how the session came back. Plain text plus a ticker. */
export function crashSentence(item: Extract<Item, { t: 'crash' }>, ctx: Pick<RowCtx, 'mode' | 'world' | 'harnessName' | 'frozenAt'>): { text: ReactNode; waiting: boolean } {
  const c = item.crash;
  const out = item.effect.output ?? {};
  const effect = String(out.effect ?? 'a step');
  const effectName = effect.startsWith('tool.') ? effect.slice(5) : effect;
  const target = effect === 'model' ? 'the model call' : effectName;
  const hybrid = movesLanes(ctx.mode);
  const secs = seconds(out.afterMs);
  const kind = c?.kind ?? (out.kind as string | undefined) ?? 'process';
  // In the Sandbox lane the drive runs in the VM's host daemon, not a Function.
  const inSandbox = (c?.lane ?? out.lane) === 'sandbox';
  const reloaded = c?.lane === 'browser';
  const local = ctx.world === 'local' || ctx.world === 'postgres';
  const where = c && hybrid && !inSandbox && !reloaded ? ` in the ${laneInline(c.lane, ctx.mode, ctx.world)} lane` : '';
  const ticker = (
    <span className="timer">
      <Ticker since={c?.crashAt} until={ctx.frozenAt} every={100} />
    </span>
  );
  const later = c?.recoveryMs !== undefined ? `${unbroken(fmtRecovery(c.recoveryMs))} later` : 'later';

  let killed: string;
  if (kind === 'sandbox-vm') killed = `Sandbox VM stopped ${secs} into ${effectName}.`;
  else if (kind === 'relay-drop') killed = `The relay link dropped ${effect === 'model' ? 'its /model socket' : 'its /ctl socket'} ${secs} into ${target}.`;
  else if (kind === 'sandbox-new-vm') killed = 'The session’s VM was deleted before this turn; its Drive was kept.';
  else if (kind === 'sandbox-zombie') killed = 'The session’s VM was stopped before this turn and left holding its Drive.';
  else if (kind === 'sandbox-command') killed = `Command killed ${secs} into ${effectName}.`;
  else if (kind === 'drop-callback') killed = `The sandbox’s report for ${effectName} was dropped.`;
  else {
    const who = reloaded ? 'Tab reloaded' : inSandbox ? 'Sandbox host killed' : local && !hybrid ? 'The server was killed' : 'Function killed';
    killed = `${who} ${secs} into ${target}${where} (attempt ${c?.killedAttempt ?? 1}).`;
  }

  let then: ReactNode;
  let waiting = false;
  if (!c) {
    waiting = true;
    then = <>Waiting for the queue to hand the turn over {ticker}</>;
  } else if (kind !== 'process' && !c.parked) {
    // A drill on the session's own sandbox: the Function lived, and re-attached.
    if (c.state === 'waiting') {
      waiting = true;
      then = <>Waiting for the Function to re-attach to the sandbox {ticker}</>;
    } else if (kind === 'sandbox-new-vm') then = 'The turn started on a new VM over the same Drive: its files and the conversation carried on.';
    else if (kind === 'sandbox-zombie') then = 'The new driver deleted the old VM once it stopped, waited for the Drive to let go of it, and resumed on a new VM.';
    else if (c.state === 'interrupted')
      then = `The Function re-attached${kind === 'sandbox-vm' ? ' on a new VM over the same Drive' : ' to the VM'} ${later}. ${sentenceStart(effectName)} isn’t safe to rerun, so ${ctx.harnessName} was told it was interrupted.`;
    else if (c.state === 'replayed') then = `The Function re-attached and made ${target} again ${later}.`;
    else then = 'The Function re-attached in the same invocation, and the turn went on.';
  } else if (c.parked) {
    const how = settledBy(c.resolvedBy);
    if (c.state === 'waiting') {
      waiting = true;
      then =
        kind === 'drop-callback' ? (
          <>The command finished; waiting for a result check to collect it from the Sandbox API {ticker}</>
        ) : kind === 'process' ? (
          <>The command keeps running in the sandbox; waiting for it to report {ticker}</>
        ) : (
          <>Waiting for a result check to notice {ticker}</>
        );
    } else if (kind === 'sandbox-vm' || c.state === 'interrupted') {
      then = `${c.resolvedBy === 'backstop' ? 'The (retired) backstop' : 'A result check'} found the VM gone ${later} and gave the model an interrupted result; the next command restores /workspace from the log on a resumed VM.`;
    } else if (kind === 'sandbox-command') {
      then = `The command exited ${c.exitCode ?? 137} and ${how}, ${later}.`;
    } else if (kind === 'drop-callback') {
      then = `${capital(how)} ${later}.`;
    } else {
      then = `The command kept running in the sandbox and reported ${later} (${how}).`;
    }
  } else if (c.state === 'waiting') {
    waiting = true;
    const open = openText(c.open);
    then = (
      <>
        {open ? `${open}. ` : ''}
        {reloaded ? 'Waiting for this tab to come back' : local && !hybrid ? 'Waiting for the server to come back' : 'Waiting for the queue to hand the turn to a new Function'}{' '}
        {ticker}
      </>
    );
  } else if (c.state === 'clear') {
    then = 'Nothing was left open: the session carried on.';
  } else if (c.state === 'replayed') {
    then = reloaded
      ? `It resumed from the log on attempt ${c.attempt}, ${later}.`
      : `The queue redelivered the turn and it resumed from the log on attempt ${c.attempt}, ${later}.`;
  } else {
    then = `${reloaded ? 'It resumed from the log' : 'The queue redelivered the turn and it resumed from the log'} ${later}. ${sentenceStart(effectName)} isn’t safe to rerun, so ${ctx.harnessName} was told it was interrupted.`;
  }
  return {
    text: (
      <>
        {killed} {then}
      </>
    ),
    waiting,
  };
}

function CrashRow({ item, ctx }: { item: Extract<Item, { t: 'crash' }>; ctx: RowCtx }) {
  const { text, waiting } = crashSentence(item, ctx);
  return (
    <div className="t-crash" data-key={item.key} data-waiting={waiting || undefined} {...selectable(item, ctx)}>
      <div className="t-kind">
        <CrashGlyph />
        <Cite indexes={itemIndexes(item, ctx.index)} onCite={ctx.onCite} />
      </div>
      <div className="t-content">
        <p className="crash-text">{text}</p>
        {item.told && (
          <div className="crash-told">
            <span>{ctx.harnessName} was told its turn was interrupted and what the log knows.</span> <Told text={item.told} />
          </div>
        )}
      </div>
    </div>
  );
}

function MetaRow({ item, ctx }: { item: Extract<Item, { t: 'fs' | 'checkpoint' }>; ctx: RowCtx }) {
  const lane = movesLanes(ctx.mode) ? item.lane : undefined;
  return (
    <div className="t-meta" data-key={item.key} {...(lane ? { 'data-lane': lane } : {})} {...selectable(item, ctx)}>
      <span />
      <span className="t-content">
        <span className="one-line">
          {item.t === 'fs' ? (
            <>
              Wrote{' '}
              {item.paths.map((p, i) => (
                <span key={p}>
                  {i > 0 && ', '}
                  <button
                    type="button"
                    tabIndex={-1}
                    className="path"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      ctx.onOpenFile(p);
                    }}
                  >
                    {p}
                  </button>
                </span>
              ))}
            </>
          ) : (
            checkpointText(item.effect.input?.turn, item.effect.output?.stopReason)
          )}
        </span>
        <Cite indexes={itemIndexes(item, ctx.index)} onCite={ctx.onCite} />
      </span>
    </div>
  );
}

export const rowSig = (item: Item) =>
  item.t === 'user'
    ? `${item.queued}${item.withdrawn}${item.lane}`
    : item.t === 'crash'
      ? `${item.crash?.state}${item.crash?.recoveryMs}${item.crash?.open.join()}${item.crash?.resolvedBy}${item.told ? 1 : 0}`
      : `${item.effect.status}${item.effect.attempt}${'lane' in item ? item.lane : ''}${item.t === 'tool' ? `${item.crashed}${item.model?.status}` : ''}`;

export const Row = memo(
  function Row({
    item,
    ctx,
  }: { item: Item; ctx: RowCtx; sig: string; cites: string; started?: number; ended?: number; selected: boolean; tab: boolean; ledger?: number }) {
    switch (item.t) {
      case 'user':
        return <UserRow item={item} ctx={ctx} />;
      case 'model':
        return <ModelRow item={item} ctx={ctx} />;
      case 'tool':
        return <ToolRow item={item} ctx={ctx} />;
      case 'handoff':
        return <HandoffRow item={item} ctx={ctx} />;
      case 'crash':
        return <CrashRow item={item} ctx={ctx} />;
      case 'message':
        return <MessageRow item={item} ctx={ctx} />;
      case 'note':
        return <NoteRow item={item} ctx={ctx} />;
      default:
        return <MetaRow item={item} ctx={ctx} />;
    }
  },
  (a, b) =>
    a.sig === b.sig &&
    a.cites === b.cites &&
    a.ended === b.ended &&
    a.started === b.started &&
    a.selected === b.selected &&
    a.tab === b.tab &&
    a.ledger === b.ledger &&
    a.item.key === b.item.key &&
    a.ctx.harnessName === b.ctx.harnessName &&
    a.ctx.frozenAt === b.ctx.frozenAt
);
