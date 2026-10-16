import {
  appInfo,
  type BenchClient,
  type BenchReport,
  type Cell,
  cellKey,
  EVE_CELL_KEY,
  eveClient,
  formatReport,
  measureRtt,
  parseCells,
  runBench,
  type ScenarioName,
  serverClient,
} from 'harness-world-bench';
import { useEffect, useRef, useState } from 'react';
import { functionRaw } from '../clients/raw-server.ts';
import { tabGateway } from '../direct.ts';
import { driveFlag, hintsFlag, relayFlag } from '../flags.ts';
import { MODEL } from '../model.ts';

/**
 * The latency benchmark, at `/bench`.
 *
 * Every cell is a place a session runs and how durable it is; every
 * durable cell is compared with the raw harness (no World) in the same
 * place. `?auto=1` runs what the URL asks for and leaves the report on
 * `window.__bench` for scripts/bench.mjs:
 * `/bench?auto=1&cells=server/on,server/off&harness=pi,fx&scenarios=chat,steer&n=5&warmup=1`.
 */

const ALL_CELLS: { mode: Cell['mode']; durability: Cell['durability']; key?: string; label: string; note: string }[] = [
  { mode: 'server', durability: 'native', label: 'Server · Native', note: 'plain Pi / fx in a Function, no durable-harness (the baseline when it runs)' },
  { mode: 'server', durability: 'on', label: 'Server · Strict', note: 'durable server session (every write awaited)' },
  { mode: 'server', durability: 'off', label: 'Server · Wrapped', note: 'the same harness, no World, in a Function' },
  { mode: 'hybrid', durability: 'on', label: 'Hybrid (tab) · Strict', note: 'this tab drives, on the server World' },
  { mode: 'tab', durability: 'on', label: 'This Tab · Strict', note: 'this tab drives, on IndexedDB' },
  { mode: 'tab', durability: 'off', label: 'This Tab · Wrapped', note: 'the same harness, no World, in this tab' },
  { mode: 'server', durability: 'run-ahead', label: 'Server · Durable', note: 'durable server session whose writes trail the agent' },
  // One cell whatever the harness choice: eve is its own harness.
  { mode: 'server', durability: 'on', key: EVE_CELL_KEY, label: 'eve', note: 'eve on Vercel Workflow (/eve/v1), same model, instructions and tools' },
];
const keyOf = (c: (typeof ALL_CELLS)[number]) => c.key ?? `${c.mode}/${c.durability}`;
const ALL_SCENARIOS: { name: ScenarioName; note: string; on: boolean }[] = [
  { name: 'chat', note: 'first output, turn, follow-up after 3 s idle', on: true },
  { name: 'tool-write', note: 'write_file turn: model → tool → model gap', on: true },
  { name: 'tool-bash', note: 'just-bash turn', on: true },
  { name: 'steer', note: 'steer at tool start → the request carrying it', on: true },
  { name: 'handoff-function', note: 'Hybrid: tab → Function (lookup_customer) → tab', on: true },
  { name: 'handoff-sandbox', note: 'Hybrid: tab → Function (run_on_machine on the session’s VM) → tab', on: true },
  { name: 'crash', note: 'Function killed mid-tool → recovered drive (drill: proof + self-wake)', on: true },
  { name: 'crash-silent', note: 'Function killed with no record or wake (what a real kill costs)', on: true },
  { name: 'chat-long', note: 'follow-up after 6 min idle (slow)', on: false },
];

declare global {
  interface Window {
    __bench?: { status: 'idle' | 'running' | 'done' | 'failed'; progress: string[]; report?: BenchReport; error?: string };
  }
}

async function clientFor(cell: Cell): Promise<BenchClient> {
  if (cell.harness === 'eve') return eveClient();
  if (cell.mode === 'server' && cell.durability === 'native') return (await import('../clients/native.ts')).createClient();
  if (cell.mode === 'server') return cell.durability === 'off' ? functionRaw() : serverClient(cell.durability === 'run-ahead' ? { durability: 'run-ahead' } : {});
  if (cell.mode === 'hybrid') return (await import('../clients/hybrid.ts')).createClient();
  if (cell.durability === 'off') return (await import('../clients/raw-tab.ts')).createClient();
  return (await import('../clients/tab.ts')).createClient();
}

function fromUrl() {
  const q = new URLSearchParams(location.search);
  const list = (k: string) => q.get(k)?.split(',').filter(Boolean);
  const cells = list('cells');
  const harness = (list('harness') ?? ['pi', 'fx']) as Cell['harness'][];
  return {
    auto: q.has('auto'),
    cells: cells ?? ALL_CELLS.map(keyOf),
    harness,
    scenarios: (list('scenarios') ?? ALL_SCENARIOS.filter((s) => s.on).map((s) => s.name)) as ScenarioName[],
    n: Number(q.get('n') ?? 5),
    warmup: Number(q.get('warmup') ?? 1),
  };
}

export function BenchPage() {
  const initial = useRef(fromUrl()).current;
  const [cells, setCells] = useState<Set<string>>(new Set(initial.cells));
  const [harnesses, setHarnesses] = useState<Set<Cell['harness']>>(new Set(initial.harness));
  const [scenarios, setScenarios] = useState<Set<ScenarioName>>(new Set(initial.scenarios));
  const [n, setN] = useState(initial.n);
  const [warmup, setWarmup] = useState(initial.warmup);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [report, setReport] = useState<BenchReport>();
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>(undefined);

  async function run() {
    const skipped: string[] = [];
    const selected = parseCells([...cells], [...harnesses], (why) => skipped.push(why));
    setRunning(true);
    setError(undefined);
    setReport(undefined);
    setProgress([]);
    const lines: string[] = [];
    const say = (line: string) => {
      lines.push(line);
      setProgress([...lines]);
      window.__bench = { ...(window.__bench ?? { status: 'running' }), status: 'running', progress: lines };
    };
    window.__bench = { status: 'running', progress: lines };
    for (const why of skipped) say(`skipped ${why}`);
    abort.current = new AbortController();
    try {
      const info = await appInfo({}).catch(() => undefined);
      const rtt = await measureRtt({}, 8).catch(() => undefined);
      const gateway = tabGateway();
      const probe = await gateway.warm();
      say(`deployment ${info?.deploymentId ?? '(local)'} · world ${info?.world} · Function RTT p50 ${rtt?.p50 ?? '?'} ms · gateway ${gateway.status().route}${gateway.status().reason ? ` (${gateway.status().reason})` : ''} · probe ${probe.ms} ms`);
      const result = await runBench({
        cells: selected,
        scenarios: [...scenarios],
        n,
        warmup,
        client: clientFor,
        pauseMs: 500,
        log: say,
        ...(rtt ? { rttMs: rtt.p50 } : {}),
        signal: abort.current.signal,
        meta: {
          runner: 'bench-page',
          origin: location.origin,
          deploymentId: info?.deploymentId ?? null,
          sha: info?.sha ?? null,
          region: info?.region ?? null,
          world: info?.world,
          model: info?.model ?? MODEL,
          ...(rtt ? { rttMs: rtt } : {}),
          userAgent: navigator.userAgent,
          gateway: gateway.status().route,
          drive: driveFlag() ?? 'default',
          hints: hintsFlag() === false ? 'off' : 'on',
          relay: relayFlag() ?? 'http',
        },
        onProgress: (p) => {
          const m = p.sample?.metrics ?? {};
          const shown = Object.entries(m)
            .filter(([, v]) => v !== undefined)
            .slice(0, 5)
            .map(([k, v]) => `${k} ${Math.round(v!)}`)
            .join(' · ');
          say(`${p.warmup ? 'warm-up ' : ''}${p.scenario} ${cellKey(p.cell)} #${p.round + 1}: ${p.sample?.error ? `ERROR ${p.sample.error}` : shown}`);
        },
      });
      // What actually served the tab's model calls (the fallback may have kicked in).
      result.meta.gateway = gateway.status().last ?? gateway.status().route;
      setReport(result);
      window.__bench = { status: 'done', progress: lines, report: result };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      window.__bench = { status: 'failed', progress: lines, error: message };
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    window.__bench ??= { status: 'idle', progress: [] };
    if (initial.auto) void run();
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once, from the URL
  }, []);

  const download = () => {
    if (!report) return;
    const name = `${report.meta.deploymentId ?? 'local'}-${report.meta.startedAt.replace(/[:.]/g, '-')}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    a.download = name;
    a.click();
  };

  const toggle = <T,>(set: Set<T>, value: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  return (
    <div className="bench">
      <header>
        <h1>durable-harness · bench</h1>
        <p className="muted">
          Durable lanes against Native (plain Pi or fx, on the server) where it runs, else against Wrapped (the same harness, no World) in the same
          place. Model {MODEL}. Times are p50 / p90 in ms, measured in this page's clock; each budget's verdict reads its 90% interval: ok, over, or
          inconclusive when the interval spans it.
        </p>
      </header>
      <section className="bench-controls">
        <fieldset>
          <legend>Cells</legend>
          {ALL_CELLS.map((c) => {
            const key = keyOf(c);
            const disabled = false;
            return (
              <label key={key} title={c.note} aria-disabled={disabled || undefined}>
                <input type="checkbox" disabled={disabled || running} checked={!disabled && cells.has(key)} onChange={() => toggle(cells, key, setCells)} />
                {c.label} <span className="muted">{c.note}</span>
              </label>
            );
          })}
        </fieldset>
        <fieldset>
          <legend>Harness</legend>
          {(['pi', 'fx'] as const).map((h) => (
            <label key={h}>
              <input type="checkbox" disabled={running} checked={harnesses.has(h)} onChange={() => toggle(harnesses, h, setHarnesses)} />
              {h === 'pi' ? 'Pi' : 'fx'}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Scenarios</legend>
          {ALL_SCENARIOS.map((s) => (
            <label key={s.name} title={s.note}>
              <input type="checkbox" disabled={running} checked={scenarios.has(s.name)} onChange={() => toggle(scenarios, s.name, setScenarios)} />
              {s.name} <span className="muted">{s.note}</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Samples</legend>
          <label>
            n <input type="number" min={1} max={50} value={n} disabled={running} onChange={(e) => setN(Number(e.target.value))} />
          </label>
          <label>
            warm-up <input type="number" min={0} max={5} value={warmup} disabled={running} onChange={(e) => setWarmup(Number(e.target.value))} />
          </label>
          <div className="bench-actions">
            {running ? (
              <button type="button" className="btn" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void run()}>
                Run
              </button>
            )}
            <button type="button" className="btn" disabled={!report} onClick={download}>
              Download JSON
            </button>
          </div>
        </fieldset>
      </section>
      {error && <div className="note" data-tone="error">{error}</div>}
      {report && <pre className="bench-report">{formatReport(report)}</pre>}
      <pre className="bench-progress">{progress.join('\n')}</pre>
    </div>
  );
}
