import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { type DurableSessions, durableSessions, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { filesFromState, readLedger, unsafeTools, workspaceTools } from 'harness-world-hands';
import { workspaceRuntime } from 'harness-world-hands/runtime';
import { journalRecords, transcriptOf } from 'harness-world-process';
import { afterEach, describe, expect, it } from 'vitest';
import { opencodeHarness } from '../src/index.ts';
import { postgresWorld } from './postgres.ts';
import { EVENTS, eventName, type OpenCodeEvent } from '../src/records.ts';

/**
 * OpenCode v2 for real: real model turns through the AI Gateway, on
 * world-local (and world-postgres when `WORKFLOW_POSTGRES_URL` is set),
 * with real crashes: a chaos crash that SIGKILLs the app's process during
 * `unsafe_make_payment` or a built-in's command, and a SIGKILL while the
 * model is streaming. Each crash is recovered in a fresh process: from the
 * log alone.
 *
 * Skipped without a Gateway credential (`AI_GATEWAY_API_KEY` or
 * `VERCEL_OIDC_TOKEN`).
 */

const credential = !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const MODEL = process.env.MODEL ?? 'anthropic/claude-haiku-4.5';
const APP = fileURLToPath(new URL('./app.ts', import.meta.url));
/** The package's directory: `--import tsx` resolves from there (one process, so a SIGKILL kills the app itself). */
const CWD = fileURLToPath(new URL('..', import.meta.url));

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 120_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const turns = (s: SessionState) => transcriptOf(s).filter((r) => r.data.type === 'turn');
const waitTurns = (sessions: DurableSessions, id: string, n: number) =>
  until(async () => {
    const s = await sessions.inspect(id);
    return turns(s).length >= n ? s : undefined;
  });

async function local(dataDir: string, root: string, opts: { recover?: boolean; builtins?: boolean } = {}) {
  const world = createWorld({ dataDir, recoverActiveRuns: opts.recover ?? false });
  closers.push(() => world.close?.());
  return withWorld(world, root, opts.builtins);
}

async function withWorld(world: World & { registerHandler?: unknown }, root: string, builtins = false) {
  const sessions = durableSessions({
    world,
    harness: builtins
      ? // OpenCode's own tools, on a virtual workspace.
        opencodeHarness({ workspace: { kind: 'virtual', runtime: workspaceRuntime() }, tools: unsafeTools({ confirmMs: 4000 }), root, model: MODEL })
      : opencodeHarness({ tools: workspaceTools(), root, model: MODEL }),
    // The log holds the crash arming of a test below; it has fired, and must never kill this runner.
    chaos: true,
    crash: () => {
      throw new Error('a chaos crash in the test runner');
    },
  });
  (world as unknown as { registerHandler?(prefix: string, h: unknown): void }).registerHandler?.(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  return { world, sessions };
}

/** The app's process (test/app.ts), whose stdout lines are JSON. */
function app(dataDir: string, root: string, mode: string, arg: string, env: Record<string, string> = {}) {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', APP, dataDir, root, mode, arg], {
    cwd: CWD,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closers.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const lines: any[] = [];
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  createInterface({ input: child.stdout! }).on('line', (l) => {
    try {
      lines.push(JSON.parse(l));
    } catch {}
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return { child, lines, exited, stderr: () => stderr };
}

const events = (s: SessionState) => journalRecords<OpenCodeEvent>(s, EVENTS).map((r) => r.data);
/** A session's drive directories on `root` (each drive's: removed when it ends; a killed process's, by the next drive). */
const driveDirs = (root: string, sessionId: string) => readdirSync(join(root, sessionId), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe.skipIf(!credential)('OpenCode v2, durable, for real', () => {
  it('runs a turn with a tool call; another machine continues the session from the log', { timeout: 240_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
    const rootA = await mkdtemp(join(tmpdir(), 'oc-root-a-'));
    const a = await local(dataDir, rootA);
    const { sessionId } = await a.sessions.start({
      prompt: 'Use write_file to write the word "lighthouse" to word.txt. Then reply with just: done.',
    });
    let state = await waitTurns(a.sessions, sessionId, 1);
    // The drive's database is a cache it removes when it ends.
    await until(() => (driveDirs(rootA, sessionId).length ? undefined : true), 10_000);
    const write = state.effectOrder.find((e) => e.name === 'tool.write_file')!;
    expect(write).toMatchObject({ status: 'completed', key: expect.stringMatching(/^tool:toolu_/) });
    expect(filesFromState(state)['/workspace/word.txt']).toContain('lighthouse');
    // The tool's effect is keyed by the call OpenCode committed before running it.
    const called = events(state).find((e) => eventName(e) === 'session.tool.called')!;
    expect(write.key).toBe(`tool:${called.data.id}`);
    expect(turns(state).map((r) => r.data)).toEqual([{ type: 'turn', status: 'completed' }]);
    await a.world.close?.();

    // A fresh root: no OpenCode database, no session files. Only the log.
    const b = await local(dataDir, await mkdtemp(join(tmpdir(), 'oc-root-b-')));
    await b.sessions.send(sessionId, 'Use read_file to read word.txt, then reply with exactly what it says.');
    state = await waitTurns(b.sessions, sessionId, 2);
    expect(state.effectOrder.filter((e) => e.name === 'tool.read_file' && e.status === 'completed').length).toBeGreaterThanOrEqual(1);
    const last = transcriptOf(state).map((r) => r.data).filter((e) => e.type === 'message').at(-1) as { text: string };
    expect(last.text.toLowerCase()).toContain('lighthouse');
    // OpenCode's seq is contiguous across both machines.
    expect(events(state).map((e) => e.seq)).toEqual(events(state).map((_, i) => i));
  });

  it('a steer joins the running turn', { timeout: 180_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
    const a = await local(dataDir, await mkdtemp(join(tmpdir(), 'oc-root-')));
    const { sessionId } = await a.sessions.start();
    const started = (async () => {
      for await (const ev of a.sessions.live(sessionId) as AsyncIterable<any>) if (ev?.type === 'tool_start') return;
    })();
    await a.sessions.send(sessionId, 'Use bash to run `sleep 3; echo first`. Then reply with what it printed.');
    await started;
    const steer = await a.sessions.send(sessionId, 'Also use write_file to write the word "steer" to s.txt before you reply.', 'steer');
    const state = await until(async () => {
      const s = await a.sessions.inspect(sessionId);
      return filesFromState(s)['/workspace/s.txt'] && s.placed.has(steer) && transcriptOf(s).at(-1)?.data.type === 'turn' ? s : undefined;
    });
    // Placed, admitted under its own id with OpenCode's steer delivery, and acted on in the same session.
    const enq = events(state).find((e) => eventName(e) === 'session.inbox.enqueued' && e.data.inboxID === `msg_${steer}`);
    expect(enq?.data.item).toMatchObject({ type: 'user', delivery: 'steer' });
    expect(filesFromState(state)['/workspace/s.txt']).toContain('steer');
  });

  it('a crash during unsafe_make_payment: recovered from the log in a fresh process; the payment happened once', { timeout: 240_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
    // The app arms a crash at the next tool and sends the prompt; the crash SIGKILLs it mid-payment.
    const rootA = await mkdtemp(join(tmpdir(), 'oc-root-a-'));
    const a = app(dataDir, rootA, 'chaos-tool', "Pay acme@example.com 5 USD with unsafe_make_payment, memo 'order 7'. Pay exactly once: never retry a payment.");
    const exit = await Promise.race([a.exited, new Promise<never>((_, no) => setTimeout(() => no(new Error(`the app did not crash: ${a.stderr()}`)), 120_000))]);
    expect(exit.signal, a.stderr()).toBe('SIGKILL');
    const sessionId = a.lines[0].sessionId as string;
    expect(a.lines.some((l) => l.type === 'chaos' && l.effect === 'tool.unsafe_make_payment')).toBe(true);

    const rootB = await mkdtemp(join(tmpdir(), 'oc-root-b-'));
    const b = await local(dataDir, rootB, { recover: true });
    const state = await waitTurns(b.sessions, sessionId, 1);
    // Rebuilt on the empty root, and its drive's directory removed when it ended (just after the turn's last record).
    await until(() => (driveDirs(rootB, sessionId).length ? undefined : true), 10_000);
    const pays = state.effectOrder.filter((e) => e.name === 'tool.unsafe_make_payment');
    expect(pays[0]).toMatchObject({ status: 'failed', error: { interrupted: true } });
    // At most one side effect: the interrupted call was never rerun (the model may not repeat it either).
    const ledger = await readLedger(b.world, sessionId);
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.callKey).toBe(pays[0]!.key);
    const entries = transcriptOf(state).map((r) => r.data);
    const note = entries.find((e) => e.type === 'message' && e.role === 'user') as { text: string; synthetic: string };
    expect(note).toMatchObject({ synthetic: 'recovery' });
    expect(note.text).toContain('may have taken effect');
    expect(entries.at(-1)).toEqual({ type: 'turn', status: 'completed' });
    // OpenCode's own sweep resumed it: its restart notice and the interrupted call's settlement are in the log.
    const names = events(state).map(eventName);
    expect(names).toContain('session.synthetic');
    expect(events(state).find((e) => eventName(e) === 'session.tool.failed')?.data.error?.message).toContain('interrupted');
  });

  it('a SIGKILL while the model streams: the next process on the same machine resumes the turn from the log', { timeout: 240_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
    const rootA = await mkdtemp(join(tmpdir(), 'oc-root-a-'));
    const a = app(dataDir, rootA, 'stream', 'Write a 250-word story about a lighthouse keeper, in plain text. Do not use any tools.');
    await until(() => (a.lines.some((l) => l.type === 'text') ? true : undefined), 90_000).catch((err) => {
      throw new Error(`${err.message}: ${a.stderr()}`);
    });
    a.child.kill('SIGKILL');
    expect((await a.exited).signal).toBe('SIGKILL');
    const sessionId = a.lines[0].sessionId as string;
    expect(driveDirs(rootA, sessionId).length).toBeGreaterThan(0);

    // The same machine (the same session root): the dead drive's files swept.
    const b = await local(dataDir, rootA, { recover: true });
    const state = await waitTurns(b.sessions, sessionId, 1);
    await until(() => (driveDirs(rootA, sessionId).length ? undefined : true), 10_000);
    const entries = transcriptOf(state).map((r) => r.data);
    expect(entries.find((e) => e.type === 'message' && e.role === 'user')).toMatchObject({ synthetic: 'recovery' });
    expect(entries.at(-1)).toEqual({ type: 'turn', status: 'completed' });
    const story = entries.filter((e) => e.type === 'message' && e.role === 'assistant').map((e) => (e as { text: string }).text).join('\n');
    expect(story.length).toBeGreaterThan(400);
    // The step the kill cut off was started in the log before the kill (the barrier), and OpenCode resumed it.
    expect(events(state).filter((e) => eventName(e) === 'session.execution.started').length).toBeGreaterThanOrEqual(2);
  });

  it('"Crash during: model" after unsafe_send_email: the chaos crash kills the app in the model request for its reply, a fresh process recovers, the model call is made again, the email went out once', { timeout: 300_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
    const rootA = await mkdtemp(join(tmpdir(), 'oc-root-a-'));
    // Armed when the email starts: it fires 1.5 s into the next model request, the reply's.
    const a = app(dataDir, rootA, 'chaos-model-at-tool', 'Send an email with unsafe_send_email to ops@example.com, subject "status", body "all good". Then, in your reply, write a 20-line poem about a lighthouse keeper. Never send the email twice.');
    const exit = await Promise.race([a.exited, new Promise<never>((_, no) => setTimeout(() => no(new Error(`the app did not crash: ${a.stderr()}`)), 180_000))]);
    expect(exit.signal, a.stderr()).toBe('SIGKILL');
    const sessionId = a.lines[0].sessionId as string;
    const armedAt = a.lines.findIndex((l) => l.armed);
    expect(armedAt).toBeGreaterThan(0);
    expect(a.lines.some((l) => l.type === 'chaos' && l.effect === 'model')).toBe(true);
    const partial = a.lines.slice(armedAt).filter((l) => l.type === 'text').map((l) => l.delta).join('');

    const b = await local(dataDir, await mkdtemp(join(tmpdir(), 'oc-root-b-')), { recover: true });
    const state = await waitTurns(b.sessions, sessionId, 1);
    const chaos = state.effectOrder.find((e) => e.name === 'chaos')!;
    expect(chaos).toMatchObject({ status: 'completed', output: { v: 2, effect: 'model' } });
    expect(state.effects.get((chaos.output as { crashedDuring: string }).crashedDuring)).toMatchObject({ name: 'model', status: 'completed', attempt: 2 });
    expect(state.effectOrder.filter((e) => e.status === 'running' || e.status === 'pending')).toEqual([]);
    const emails = state.effectOrder.filter((e) => e.name === 'tool.unsafe_send_email');
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ status: 'completed' });
    expect((await readLedger(b.world, sessionId)).filter((l) => l.tool === 'unsafe_send_email')).toHaveLength(1);
    const entries = transcriptOf(state).map((r) => r.data);
    const note = entries.find((e) => e.type === 'message' && e.role === 'user') as { text: string };
    expect(note.text).toContain(`call ${emails[0]!.key.slice('tool:'.length)}: completed`);
    expect(entries.at(-1)).toEqual({ type: 'turn', status: 'completed' });
    console.log('[e2e] text streamed before the crash:', JSON.stringify(partial.slice(0, 200)));
    const said = entries.filter((e) => e.type === 'message' && e.role === 'assistant').map((e) => (e as { text: string }).text).join('\n');
    console.log('[e2e] reply after recovery:', JSON.stringify(said.slice(-300)));
  });

  it('"Crash during: model" armed before the prompt: the first model request dies, the same machine resumes and finishes the turn', { timeout: 300_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
    const rootA = await mkdtemp(join(tmpdir(), 'oc-root-a-'));
    const a = app(dataDir, rootA, 'chaos-model', 'Write a 250-word story about a lighthouse keeper, in plain text. Do not use any tools.');
    const exit = await Promise.race([a.exited, new Promise<never>((_, no) => setTimeout(() => no(new Error(`the app did not crash: ${a.stderr()}`)), 180_000))]);
    expect(exit.signal, a.stderr()).toBe('SIGKILL');
    const sessionId = a.lines[0].sessionId as string;
    const partial = a.lines.filter((l) => l.type === 'text').map((l) => l.delta).join('');

    const b = await local(dataDir, rootA, { recover: true });
    const state = await waitTurns(b.sessions, sessionId, 1);
    const chaos = state.effectOrder.find((e) => e.name === 'chaos')!;
    expect(chaos).toMatchObject({ status: 'completed', output: { effect: 'model' } });
    expect(state.effects.get((chaos.output as { crashedDuring: string }).crashedDuring)).toMatchObject({ name: 'model', status: 'completed', attempt: 2 });
    const entries = transcriptOf(state).map((r) => r.data);
    expect(entries.find((e) => e.type === 'message' && e.role === 'user')).toMatchObject({ synthetic: 'recovery' });
    expect(entries.at(-1)).toEqual({ type: 'turn', status: 'completed' });
    const story = entries.filter((e) => e.type === 'message' && e.role === 'assistant').map((e) => (e as { text: string }).text).join('\n');
    expect(story.length).toBeGreaterThan(400);
    console.log('[e2e] text streamed before the crash:', partial.length, 'characters');
  });

  it("built-ins on a virtual workspace: OpenCode's own write, shell, edit and read run on its files, each call in the log; another machine reads them from the log", { timeout: 300_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
    const a = await local(dataDir, await mkdtemp(join(tmpdir(), 'oc-root-a-')), { builtins: true });
    const { sessionId } = await a.sessions.start({
      prompt: 'Use your write tool to write "hello" to greet.txt. Then use your shell tool to run `cat greet.txt`. Then use your edit tool to change hello to durable in greet.txt. Then reply with one short sentence.',
    });
    let state = await waitTurns(a.sessions, sessionId, 1);
    const calls = state.effectOrder.filter((e) => e.name.startsWith('tool.'));
    console.log('[e2e] built-in calls:', JSON.stringify(calls.map((e) => [e.name, e.replay, e.status, e.input])));
    expect(calls.map((e) => e.name)).toEqual(expect.arrayContaining(['tool.write', 'tool.shell', 'tool.edit']));
    expect(calls.filter((e) => ['tool.write', 'tool.shell', 'tool.edit'].includes(e.name)).every((e) => e.status === 'completed' && e.replay === 'safe')).toBe(true);
    expect(calls.find((e) => e.name === 'tool.shell')?.output).toContain('hello');
    // Each call's intent came after OpenCode's record of it (its event) in the log.
    for (const c of calls) {
      const called = journalRecords<OpenCodeEvent>(state, EVENTS).find((r) => eventName(r.data) === 'session.tool.called' && `tool:${r.data.data.id}` === c.key);
      expect(called?.at ?? Infinity).toBeLessThan(state.effectOrder.indexOf(c));
    }
    // The files are the session's, in its log, not a directory of this machine.
    expect(filesFromState(state)['/workspace/greet.txt']).toMatch(/^durable/);
    await a.world.close?.();

    // Another machine: a fresh root, only the log.
    const b = await local(dataDir, await mkdtemp(join(tmpdir(), 'oc-root-b-')), { builtins: true });
    await b.sessions.send(sessionId, 'Read greet.txt with your read tool and reply with exactly what it says.');
    state = await waitTurns(b.sessions, sessionId, 2);
    expect(state.effectOrder.filter((e) => e.name === 'tool.read' && e.status === 'completed').length).toBeGreaterThanOrEqual(1);
    const last = transcriptOf(state).map((r) => r.data).filter((e) => e.type === 'message').at(-1) as { text: string };
    expect(last.text.toLowerCase()).toContain('durable');
  });

  it('built-ins on: a crash 1.5 s into a built-in shell command, recovered in a fresh process: the call is cut off with everything it changed, reported interrupted and safe to repeat, never rerun automatically', { timeout: 300_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
    const root = await mkdtemp(join(tmpdir(), 'oc-root-'));
    const a = app(dataDir, root, 'chaos-tool', 'Use your shell tool to run exactly `echo started >> runs.txt && sleep 8 && date > slow.txt`, then show slow.txt.', {
      BUILTINS: '1',
      CRASH_AFTER_MS: '1500',
    });
    const exit = await Promise.race([a.exited, new Promise<never>((_, no) => setTimeout(() => no(new Error(`the app did not crash: ${a.stderr()}`)), 150_000))]);
    expect(exit.signal, a.stderr()).toBe('SIGKILL');
    const sessionId = a.lines[0].sessionId as string;
    expect(a.lines.some((l) => l.type === 'chaos' && l.effect === 'tool.shell')).toBe(true);

    const b = await local(dataDir, root, { recover: true, builtins: true });
    const state = await waitTurns(b.sessions, sessionId, 1);
    const shell = state.effectOrder.filter((e) => e.name === 'tool.shell');
    console.log('[e2e] shell calls:', JSON.stringify(shell.map((e) => [e.status, e.input])));
    // The cut-off call: its intent in the log, no outcome, never run again by itself.
    expect(shell[0]).toMatchObject({ replay: 'safe' });
    expect(shell[0]!.status).not.toBe('completed');
    // What it wrote went with the process: only a call the model made again (after the note) left runs.txt.
    const later = (part: string) => shell.slice(1).filter((e) => e.status === 'completed' && String((e.input as { command?: string })?.command ?? '').includes(part)).length;
    const files = filesFromState(state);
    expect(files['/workspace/runs.txt'] ?? '').toBe('started\n'.repeat(later('echo started >> runs.txt')));
    if (!later('slow.txt')) expect(files['/workspace/slow.txt']).toBeUndefined();
    const entries = transcriptOf(state).map((r) => r.data);
    expect(entries.find((e) => e.type === 'message' && e.role === 'user')).toMatchObject({ synthetic: 'recovery', text: expect.stringContaining('safe to repeat') });
    expect(entries.at(-1)).toEqual({ type: 'turn', status: 'completed' });
    console.log('[e2e] reply after recovery:', JSON.stringify((entries.filter((e) => e.type === 'message').at(-1) as { text: string }).text));
  });

  it.skipIf(!process.env.WORKFLOW_POSTGRES_URL)('runs a turn on world-postgres', { timeout: 180_000 }, async () => {
    const pg = await postgresWorld();
    closers.push(pg.close);
    const a = await withWorld(pg.world, await mkdtemp(join(tmpdir(), 'oc-root-pg-')));
    pg.serve(a.sessions.handler);
    const { sessionId } = await a.sessions.start({ prompt: 'Use write_file to write "postgres" to db.txt, then reply with just: done.' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(filesFromState(state)['/workspace/db.txt']).toContain('postgres');
    expect(turns(state).at(-1)!.data).toEqual({ type: 'turn', status: 'completed' });
  });

  it.skipIf(!process.env.WORKFLOW_POSTGRES_URL)('a crash during unsafe_make_payment on world-postgres: another process recovers it; the payment happened once', { timeout: 240_000 }, async () => {
    const a = app('-', await mkdtemp(join(tmpdir(), 'oc-root-pg-a-')), 'chaos-tool', "Pay acme@example.com 5 USD with unsafe_make_payment, memo 'order 7'. Pay exactly once: never retry a payment.", {
      HARNESS_TEST_WORLD: 'postgres',
    });
    const exit = await Promise.race([a.exited, new Promise<never>((_, no) => setTimeout(() => no(new Error(`the app did not crash: ${a.stderr()}`)), 120_000))]);
    expect(exit.signal, a.stderr()).toBe('SIGKILL');
    const sessionId = a.lines[0].sessionId as string;

    // Another process (this one), another session root: the crash's wake reaches its flow route.
    const pg = await postgresWorld();
    closers.push(pg.close);
    const b = await withWorld(pg.world, await mkdtemp(join(tmpdir(), 'oc-root-pg-b-')));
    pg.serve(b.sessions.handler);
    const state = await waitTurns(b.sessions, sessionId, 1);
    const pays = state.effectOrder.filter((e) => e.name === 'tool.unsafe_make_payment');
    expect(pays[0]).toMatchObject({ status: 'failed', error: { interrupted: true } });
    const ledger = await readLedger(b.world, sessionId);
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.callKey).toBe(pays[0]!.key);
    const entries = transcriptOf(state).map((r) => r.data);
    expect(entries.find((e) => e.type === 'message' && e.role === 'user')).toMatchObject({ synthetic: 'recovery' });
    expect(entries.at(-1)).toEqual({ type: 'turn', status: 'completed' });
  });
});
