// The Cloudflare lane's drills, with a real model, on local workerd
// (`wrangler dev` with local Durable Object storage), or on a deployed
// Worker with --url (no crash drill there: the process cannot be killed).
//
//   node scripts/drill.mjs [--harness pi|ai-sdk|fx] [--durability strict|run-ahead] [--port 8791] [--only turn,safe,never,second,steer]
//
// Per harness, in one persisted state directory:
//   turn    a tool turn (write a file, read it back)
//   safe    SIGKILL the whole wrangler process group while `bash`
//           (replay: 'safe') runs, restart on the same state, and check the
//           command reran once from the workspace the log had before it
//   never   SIGKILL while `unsafe_make_payment` (replay: 'never') waits for
//           its confirmation, after the payment went out; check the ledger
//           holds one payment and the model got an interrupted result
//   second  another turn on the same session
//   steer   a steer sent while a tool runs, placed at the next model call
//
// After each restart nothing touches the session for --quiet seconds, so
// the recovery is the run object's own alarm, not a request waking it.
// Needs .dev.vars with the AI Gateway credential (see the app's README).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appDir, startDev } from './dev-server.mjs';

const { values: args } = parseArgs({
  options: {
    harness: { type: 'string', default: 'pi' },
    durability: { type: 'string', default: 'strict' },
    port: { type: 'string', default: String(8790 + Math.floor(Math.random() * 100)) },
    only: { type: 'string', default: 'turn,safe,never,second,steer' },
    quiet: { type: 'string', default: '25' },
    url: { type: 'string' },
    headers: { type: 'string' },
    // Non-secret Worker vars for this run, e.g. HARNESS_DEBUG=1 (repeatable).
    var: { type: 'string', multiple: true, default: [] },
  },
});
const steps = new Set(args.only.split(','));
const runDir = join(appDir, '.drill', `${args.harness}-${args.durability}-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const persistTo = join(runDir, 'state');
const report = { harness: args.harness, durability: args.durability, where: args.url ?? 'local workerd (wrangler dev)', steps: {} };
const extraHeaders = args.headers ? JSON.parse(args.headers) : {};

let server;
let base = args.url;
const start = async () => {
  if (args.url) return;
  const vars = Object.fromEntries(args.var.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
  server = await startDev({ port: Number(args.port), persistTo, vars, log: (s) => writeFileSync(join(runDir, 'dev.log'), s, { flag: 'a' }) });
  base = server.url;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (path, body) => {
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: extraHeaders });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const say = (...a) => console.log(...a);
const brief = (s) => s.effects.map((e) => `${e.name}:${e.interrupted ? 'interrupted' : e.status}${e.retryOf ? '(rerun)' : ''}`);

async function waitIdle(id, submissionId, timeoutMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await call(`/sessions/${id}`);
    const sub = s.submissions.find((x) => x.id === submissionId);
    if (s.idle && (sub?.placed || sub?.withdrawn)) return { s, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`turn ${submissionId} did not finish: ${JSON.stringify(brief(s))}`);
    await sleep(500);
  }
}

/** Wait until `tool` runs in a step after the first `from` effects (the ones before this turn). */
async function waitRunning(id, tool, from, submissionId, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await call(`/sessions/${id}`);
    const fresh = s.effects.slice(from);
    const e = fresh.find((x) => x.name === tool);
    if (e?.status === 'running') return s;
    const other = fresh.find((x) => x.name.startsWith('tool.') && x.name !== tool && x.status === 'running');
    if (other) throw new Error(`the model picked ${other.name}, not ${tool}`);
    const placed = s.submissions.find((x) => x.id === submissionId)?.placed;
    if (s.idle && placed && !e) throw new Error(`the turn ended without ${tool}: ${JSON.stringify(brief(s))}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`${tool} never started`);
    await sleep(150);
  }
}

async function turn(id, text, kind = 'prompt') {
  const { submissionId } = await call(`/sessions/${id}/messages`, { text, kind });
  return { submissionId, ...(await waitIdle(id, submissionId)) };
}

/** SIGKILL everything, restart on the same state, and leave the session alone for --quiet seconds. */
async function killAndRestart(tool, eventsPath) {
  await sleep(1500);
  const killedAt = Date.now();
  const signal = await server.kill();
  say(`   killed wrangler dev (${signal}) 1.5 s into ${tool}`);
  await start();
  const restartedAt = Date.now();
  await sleep(Math.max(0, Number(args.quiet) * 1000 - (restartedAt - killedAt)));
  const pokedAt = Date.now();
  const events = await call(eventsPath);
  const beforePoke = events.filter((e) => Date.parse(e.createdAt) > restartedAt && Date.parse(e.createdAt) < pokedAt);
  return {
    killedAt,
    restartMs: restartedAt - killedAt,
    eventsByAlarmBeforeFirstRequest: beforePoke.length,
    firstRecoveredEvent: beforePoke[0] ? { type: beforePoke[0].eventType, afterKillMs: Date.parse(beforePoke[0].createdAt) - killedAt } : null,
  };
}

/** When the session's last event committed, from the log (not when we looked). */
const finishedAfter = async (eventsPath, killedAt) => Date.parse((await call(eventsPath)).at(-1).createdAt) - killedAt;

/** Kill everything mid-tool, restart on the same state, and let the alarm recover it. */
async function crashDrill(id, prompt, tool) {
  const from = (await call(`/sessions/${id}`)).effects.length;
  const { submissionId } = await call(`/sessions/${id}/messages`, { text: prompt });
  await waitRunning(id, tool, from, submissionId);
  const crash = await killAndRestart(tool, `/sessions/${id}/events`);
  const { s } = await waitIdle(id, submissionId);
  return { ...crash, finishedAfterKillMs: await finishedAfter(`/sessions/${id}/events`, crash.killedAt), submissionId, s };
}

// ---------------------------------------------------------------------------
// Pi variant A (pi-durable): its sessions are Pi journals, read through /pi-durable.

async function piATurn(id, text, kind = 'prompt') {
  const before = (await call(`/pi-durable/${id}`)).entries.length;
  await call(`/pi-durable/${id}/messages`, { text, kind });
  return piAIdle(id, before);
}

async function piAIdle(id, before, timeoutMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await call(`/pi-durable/${id}`);
    if (s.entries.length > before && !s.unfinished && s.running.length === 0 && s.entries.at(-1) === 'pi.assistant') return { s, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`the Pi turn did not finish: ${JSON.stringify(s.tasks)}`);
    await sleep(500);
  }
}

async function piARunning(id, tool, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await call(`/pi-durable/${id}`);
    if (s.running.includes(tool)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${tool} never started: ${JSON.stringify(s.tasks)}`);
    await sleep(150);
  }
}

async function piACrash(id, prompt, tool) {
  const before = (await call(`/pi-durable/${id}`)).entries.length;
  await call(`/pi-durable/${id}/messages`, { text: prompt });
  await piARunning(id, tool);
  const crash = await killAndRestart(tool, `/pi-durable/${id}/events`);
  const { s } = await piAIdle(id, before);
  const runs = s.tasks.filter((t) => t.kind === 'pi.tool' && t.tool === tool);
  return {
    ...crash,
    finishedAfterKillMs: await finishedAfter(`/pi-durable/${id}/events`, crash.killedAt),
    // One start per process that ran the call: 2 is a rerun after the crash.
    toolTaskStarts: runs.at(-1)?.starts,
    toolResult: s.tools.filter((t) => t.name === tool.replace('tool.', '')).at(-1),
    s,
  };
}

async function drillPiA() {
  const { sessionId: id } = await call('/pi-durable', {});
  report.sessionId = id;
  say(`pi-durable (Pi variant A) on the Cloudflare World (${report.where}): ${id}`);
  if (steps.has('turn')) {
    const r = await piATurn(id, 'Write a haiku about Durable Objects to /workspace/haiku.txt, then read it back with bash cat.');
    report.steps.turn = { ms: r.ms, tools: r.s.tools.map((t) => t.name), text: r.s.text, haiku: r.s.files['/workspace/haiku.txt'] };
    say('1. tool turn', JSON.stringify(report.steps.turn, null, 1));
  }
  if (steps.has('safe') && server) {
    const cmd = 'echo started >> /workspace/log.txt && sleep 6 && echo finished >> /workspace/log.txt';
    const r = await piACrash(id, `Run exactly this bash command once, then say done: ${cmd}`, 'bash');
    const { s, ...rest } = r;
    report.steps.safe = { ...rest, logTxt: s.files['/workspace/log.txt'], text: s.text };
    say('2. crash in bash (safe)', JSON.stringify(report.steps.safe, null, 1));
  }
  if (steps.has('never') && server) {
    const r = await piACrash(id, 'Pay $5 to alice@example.com for lunch with unsafe_make_payment.', 'unsafe_make_payment');
    const { s, ...rest } = r;
    report.steps.never = { ...rest, text: s.text };
    say('3. crash in unsafe_make_payment (never)', JSON.stringify(report.steps.never, null, 1));
  }
  if (steps.has('second')) {
    const r = await piATurn(id, 'Which files are in /workspace now? Answer in one line.');
    report.steps.second = { ms: r.ms, tools: r.s.tools.slice(-2).map((t) => t.name), text: r.s.text };
    say('4. second turn', JSON.stringify(report.steps.second, null, 1));
  }
  if (steps.has('steer')) {
    const before = (await call(`/pi-durable/${id}`)).entries.length;
    await call(`/pi-durable/${id}/messages`, { text: 'Run this bash command: sleep 5 && echo slept. Then report its output.' });
    await piARunning(id, 'bash');
    await call(`/pi-durable/${id}/messages`, { text: 'Also: end your answer with the word PINEAPPLE.', kind: 'steer' });
    const { s } = await piAIdle(id, before);
    report.steps.steer = { honored: /PINEAPPLE/i.test(s.text ?? ''), entries: s.entries.slice(before), text: s.text };
    say('5. steer', JSON.stringify(report.steps.steer, null, 1));
  }
  report.events = (await call(`/pi-durable/${id}/events`)).length;
  report.object = await call(`/sessions/${id}/object`);
}

try {
  await start();
  if (args.harness === 'pi-durable') {
    await drillPiA();
    report.ok = true;
  } else await drillKernel();
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await server?.kill();
  writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  say(`report: ${join(runDir, 'report.json')}`);
}

async function drillKernel() {
  // fx's command tool is libfx's `shell` ({ request: { action: 'run', command } }); Pi's and the AI SDK's is `bash`.
  const shell = args.harness === 'fx' ? 'shell' : 'bash';
  const commandOf = (input) => String(input?.command ?? input?.request?.command ?? '');
  const { sessionId: id } = await call('/sessions', { harness: args.harness, durability: args.durability });
  report.sessionId = id;
  say(`${args.harness} on the Cloudflare World (${report.where}), Durable ${args.durability === 'strict' ? 'Strict' : 'On'}: ${id}`);

  if (steps.has('turn')) {
    const r = await turn(id, `Write a haiku about Durable Objects to /workspace/haiku.txt, then read it back with ${shell} cat.`);
    const files = await call(`/sessions/${id}/files`);
    report.steps.turn = { ms: r.ms, effects: brief(r.s), text: r.s.text, haiku: files['/workspace/haiku.txt'] };
    say('1. tool turn', JSON.stringify(report.steps.turn, null, 1));
  }

  if (steps.has('safe') && server) {
    const cmd = 'echo started >> /workspace/log.txt && sleep 6 && echo finished >> /workspace/log.txt';
    const r = await crashDrill(id, `Run exactly this command once with ${shell}, then say done: ${cmd}`, `tool.${shell}`);
    const files = await call(`/sessions/${id}/files`);
    const bash = r.s.effects.filter((e) => e.name === `tool.${shell}` && commandOf(e.input).includes('sleep 6'));
    report.steps.safe = {
      restartMs: r.restartMs,
      finishedAfterKillMs: r.finishedAfterKillMs,
      eventsByAlarmBeforeFirstRequest: r.eventsByAlarmBeforeFirstRequest,
      firstRecoveredEvent: r.firstRecoveredEvent,
      bashAttempts: bash.map((e) => `${e.interrupted ? 'interrupted' : e.status}${e.retryOf ? ' (rerun)' : ''}`),
      logTxt: files['/workspace/log.txt'],
      effects: brief(r.s),
      text: r.s.text,
    };
    say(`2. crash in ${shell} (safe)`, JSON.stringify(report.steps.safe, null, 1));
  }

  if (steps.has('never') && server) {
    const r = await crashDrill(id, 'Pay $5 to alice@example.com for lunch with unsafe_make_payment.', 'tool.unsafe_make_payment');
    const ledger = await call(`/sessions/${id}/ledger`);
    const payments = r.s.effects.filter((e) => e.name === 'tool.unsafe_make_payment');
    report.steps.never = {
      restartMs: r.restartMs,
      finishedAfterKillMs: r.finishedAfterKillMs,
      eventsByAlarmBeforeFirstRequest: r.eventsByAlarmBeforeFirstRequest,
      firstRecoveredEvent: r.firstRecoveredEvent,
      paymentAttempts: payments.map((e) => `${e.interrupted ? 'interrupted' : e.status}${e.retryOf ? ' (rerun)' : ''}`),
      ledgerRecords: ledger.length,
      effects: brief(r.s),
      text: r.s.text,
    };
    say('3. crash in unsafe_make_payment (never)', JSON.stringify(report.steps.never, null, 1));
  }

  if (steps.has('second')) {
    const r = await turn(id, 'Which files are in /workspace now? Answer in one line.');
    report.steps.second = { ms: r.ms, effects: brief(r.s).slice(-4), text: r.s.text };
    say('4. second turn', JSON.stringify(report.steps.second, null, 1));
  }

  if (steps.has('steer')) {
    const from = (await call(`/sessions/${id}`)).effects.length;
    const { submissionId } = await call(`/sessions/${id}/messages`, { text: `Run this command with ${shell}: sleep 5 && echo slept. Then report its output.` });
    await waitRunning(id, `tool.${shell}`, from, submissionId);
    const { submissionId: steerId } = await call(`/sessions/${id}/messages`, { text: 'Also: end your answer with the word PINEAPPLE.', kind: 'steer' });
    const { s } = await waitIdle(id, steerId);
    await waitIdle(id, submissionId);
    const placedBy = s.effects.find((e) => e.placed.includes(steerId));
    report.steps.steer = { placedBy: placedBy && `${placedBy.name} ${placedBy.key}`, honored: /PINEAPPLE/i.test(s.text ?? ''), text: s.text };
    say('5. steer', JSON.stringify(report.steps.steer, null, 1));
  }

  report.object = await call(`/sessions/${id}/object`);
  report.events = (await call(`/sessions/${id}/events`)).length;
  report.ok = true;
}
