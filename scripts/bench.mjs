#!/usr/bin/env node
// Headless latency benchmark.
//
//   node scripts/bench.mjs --origin https://<deployment> \
//     --bypass-file /tmp/bypass [--n 5] [--warmup 1] [--harness pi,fx] \
//     [--cells server/native,server/on,server/run-ahead,server/off,server/eve,hybrid/on,tab/on,tab/off] \
//     [--scenarios chat,tool-write,tool-bash,steer,handoff-function,handoff-sandbox,crash,crash-silent] \
//     [--out bench/results] [--session bench] [--gateway auto|direct|proxy] [--drive auto|http|queue]
//     [--hints auto|on|off] [--relay auto|http|ws] [--vm-raw wrun_...] [--dirty] [--note "..."]
//
// Cells that live on the server (server/on, server/off) run here, in Node,
// over the app's HTTP API. Cells that live in a tab (tab/*, hybrid/*) run in
// a headless browser (agent-browser) on the app's /bench page, which leaves
// its report on window.__bench. Both halves are merged into one JSON report,
// written to <out>/<deployment>-<date>.json, and printed as tables.
//
// The protection bypass secret is read from a file (never an argument) and
// sent as `x-vercel-protection-bypass`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { register } from 'tsx/esm/api';

register();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bench = await import(join(root, 'packages/bench/src/index.ts'));

const { values: args } = parseArgs({
  options: {
    origin: { type: 'string', default: 'http://localhost:3100' },
    'bypass-file': { type: 'string' },
    n: { type: 'string', default: '5' },
    warmup: { type: 'string', default: '1' },
    harness: { type: 'string', default: 'pi,fx' },
    cells: { type: 'string', default: 'server/native,server/on,server/run-ahead,server/off,server/eve,hybrid/on,tab/on,tab/off' },
    scenarios: { type: 'string', default: 'chat,tool-write,tool-bash,steer,handoff-function,handoff-sandbox,crash,crash-silent' },
    out: { type: 'string', default: join(root, 'bench/results') },
    session: { type: 'string', default: 'hw-bench' },
    'browser-timeout-min': { type: 'string', default: '120' },
    // How the tab reaches AI Gateway: auto (direct with /api/token, else the proxy), direct, or proxy.
    gateway: { type: 'string', default: 'auto' },
    // How the server drives durable turns: auto (the deployment's default), http (the drive route), or queue.
    drive: { type: 'string', default: 'auto' },
    // The deployment runs code that is not its reported sha (a CLI deploy of a dirty tree): say so in the result.
    dirty: { type: 'boolean', default: false },
    note: { type: 'string', default: '' },
    // Tab cells only: live hints (on) or polls (off); the tab's World over HTTP or the session host's WebSocket.
    hints: { type: 'string', default: 'auto' },
    relay: { type: 'string', default: 'auto' },
    prewarm: { type: 'string', default: 'auto' },
    // server/off cells run inside this session's sandbox VM (the VM raw baseline) instead of a Function.
    'vm-raw': { type: 'string', default: '' },
  },
});

const origin = args.origin.replace(/\/+$/, '');
const bypass = args['bypass-file'] ? readFileSync(args['bypass-file'], 'utf8').trim() : undefined;
const headers = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
const http = { origin, headers, ...(args.drive === 'http' || args.drive === 'queue' ? { drive: args.drive } : {}) };
const n = Number(args.n);
const warmup = Number(args.warmup);
const harnesses = args.harness.split(',').filter(Boolean);
const scenarios = args.scenarios.split(',').filter(Boolean);
const cellKeys = args.cells.split(',').filter(Boolean);
const serverCells = cellKeys.filter((c) => c.startsWith('server/'));
const tabCells = cellKeys.filter((c) => !c.startsWith('server/'));
// `server/eve` is eve's own cell (eve on Vercel Workflow, `/eve/v1`), whatever --harness says.
// A process harness's cells it has no lane for are left out, with the reason.
const toCells = (keys) => bench.parseCells(keys, harnesses, (why) => console.log(`skipped ${why}`));

const info = await bench.appInfo(http);
const rtt = await bench.measureRtt(http, 10);
console.log(`deployment ${info.deploymentId ?? '(local)'} · sha ${info.sha ?? '?'} · world ${info.world} · model ${info.model} · Function RTT p50 ${rtt.p50} ms`);
const meta = {
  runner: 'scripts/bench.mjs',
  ...(args['vm-raw'] ? { rawLane: 'vm' } : {}),
  origin,
  deploymentId: info.deploymentId,
  sha: info.sha,
  ...(args.dirty ? { dirty: true } : {}),
  ...(args.note ? { note: args.note } : {}),
  region: info.region,
  world: info.world,
  model: info.model,
  rttMs: rtt,
};

// Tab cells first, in a browser, while nothing else runs.
let tabReport;
if (tabCells.length) {
  const q = new URLSearchParams({ auto: '1', cells: tabCells.join(','), harness: harnesses.join(','), scenarios: scenarios.join(','), n: String(n), warmup: String(warmup), gateway: args.gateway, drive: args.drive });
  if (args.hints === 'off' || args.hints === 'on') q.set('hints', args.hints === 'off' ? '0' : '1');
  if (args.relay === 'http' || args.relay === 'ws') q.set('relay', args.relay);
  // `--prewarm on`: pool VMs and pre-created sessions on /bench (off there by default).
  if (args.prewarm === 'on' || args.prewarm === 'off') q.set('prewarm', args.prewarm === 'on' ? '1' : '0');
  const url = `${origin}/bench?${q}`;
  const ab = (...cmd) => execFileSync('agent-browser', ['--session', args.session, ...cmd], { encoding: 'utf8', maxBuffer: 64 << 20 });
  console.log(`browser: ${url}`);
  ab('open', url, ...(bypass ? ['--headers', JSON.stringify(headers)] : []));
  const deadline = Date.now() + Number(args['browser-timeout-min']) * 60_000;
  let printed = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const raw = ab('eval', 'JSON.stringify(window.__bench ?? null)').trim();
    let state;
    try {
      state = JSON.parse(JSON.parse(raw));
    } catch {
      state = JSON.parse(raw);
    }
    const lines = state?.progress ?? [];
    for (const line of lines.slice(printed)) console.log(`  [tab] ${line}`);
    printed = lines.length;
    if (state?.status === 'done') {
      tabReport = state.report;
      break;
    }
    if (state?.status === 'failed') throw new Error(`bench page failed: ${state.error}`);
    if (Date.now() > deadline) throw new Error('bench page timed out');
  }
  ab('close');
}

let serverReport;
if (serverCells.length) {
  serverReport = await bench.runBench({
    cells: toCells(serverCells),
    scenarios,
    n,
    warmup,
    rttMs: rtt.p50,
    pauseMs: 500,
    log: (m) => console.log(`  [node] ${m}`),
    meta,
    client: async (cell) =>
      cell.harness === 'eve'
        ? bench.eveClient({ origin, headers })
        : cell.durability === 'native'
        ? bench.nativeFunctionClient(http)
        : cell.durability === 'off'
        ? bench.rawFunctionClient(http, args['vm-raw'] ? { vmRunId: args['vm-raw'] } : {})
        : bench.serverClient(cell.durability === 'run-ahead' ? { ...http, durability: 'run-ahead' } : http),
    onProgress: (p) => {
      const m = p.sample?.metrics ?? {};
      const shown = Object.entries(m)
        .filter(([, v]) => v !== undefined)
        .slice(0, 5)
        .map(([k, v]) => `${k} ${Math.round(v)}`)
        .join(' · ');
      console.log(`  [node] ${p.warmup ? 'warm-up ' : ''}${p.scenario} ${bench.cellKey(p.cell)} #${p.round + 1}: ${p.sample?.error ? `ERROR ${p.sample.error}` : shown}`);
    },
  });
}

const results = [...(tabReport?.results ?? []), ...(serverReport?.results ?? [])];
const report = {
  meta: { ...meta, n, warmup, startedAt: tabReport?.meta.startedAt ?? serverReport?.meta.startedAt, finishedAt: new Date().toISOString(), ...(tabReport ? { userAgent: tabReport.meta.userAgent, gateway: tabReport.meta.gateway } : {}) },
  results,
  comparisons: bench.compare(results),
};
mkdirSync(args.out, { recursive: true });
const file = join(args.out, `${info.deploymentId ?? 'local'}-${report.meta.startedAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${bench.formatReport(report)}\n\nwrote ${file}`);
