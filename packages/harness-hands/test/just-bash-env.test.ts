import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type DriveContext, deliver, durableSessions, type Harness, type HostTool, QUEUE_PREFIX, type SessionState, vercelAnchors } from 'harness-world';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureWorkers, createMachine, leaseOf, probeWorker, restartWorkers, workerStats } from '../src/isolation.ts';
import { RESET_NOTE, workspaceRuntime } from '../src/runtime.ts';
import { VIRTUAL_COMMANDS } from '../src/specs.ts';
import { type Call, localStore, scripted, toolRecords, until, yieldingAfterFirst } from '../src/test-harness.ts';
import { docWorkspaceTools, WorkspaceDoc, workspaceManifest } from '../src/tools.ts';
import type { WorkerPoolOptions } from '../src/worker.ts';

/**
 * The virtual workspace's hardening (docs/workspaces.md §4.2, the B2 tests
 * of §11.4): one worker per session, a busy neighbor that never stalls the
 * instance, deadlines and cancellation that end only the offender's worker
 * with a definite outcome and a rollback, limits as tool errors, no host
 * environment, a pinned command set, and the in-memory workspace's
 * per-call rollback and per-invocation clearing (in this process and a new
 * one).
 */

const run = promisify(execFile);
const CHILD = new URL('./drive-process.ts', import.meta.url).pathname;
const PACKAGE = new URL('..', import.meta.url).pathname;

/** A runaway: nested loops, each under just-bash's per-loop cap, that never yield to its deadline. */
const RUNAWAY = "awk 'BEGIN{for(i=0;i<99999;i++)for(j=0;j<99999;j++)x++; print x}'";

let defaults: WorkerPoolOptions | undefined;
beforeAll(async () => {
  defaults = await configureWorkers({});
});
beforeEach(async () => {
  // Every test starts on an empty pool with the default limits.
  await restartWorkers();
  if (defaults) await configureWorkers(defaults);
});
afterAll(async () => {
  await restartWorkers();
});

const stores: Awaited<ReturnType<typeof localStore>>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll();
});

async function serve(harness: Harness | Harness[], options: { maxInvocationMs?: number; deadlineMarginMs?: number } = {}) {
  const st = await localStore('hw-b2-');
  stores.push(st);
  const world = st.open();
  const s = durableSessions({ world, harness, ...options });
  world.registerHandler(QUEUE_PREFIX, s.handler);
  return s;
}

type Sessions = Awaited<ReturnType<typeof serve>>;

async function settled(s: Sessions, sessionId: string, calls: number, timeoutMs = 30_000): Promise<SessionState> {
  let state!: SessionState;
  await until(
    async () => {
      state = await s.inspect(sessionId);
      if (state.status === 'failed') return true;
      const recs = toolRecords(state);
      return recs.length >= calls && recs.every((r) => r.status === 'completed' || r.status === 'failed');
    },
    'tool calls',
    timeoutMs
  );
  return state;
}

const output = (state: SessionState, i: number) => {
  const r = toolRecords(state)[i]!;
  return r.status === 'completed' ? String(r.output) : `error: ${r.error?.message}`;
};

const seq = (...calls: Call[]) => JSON.stringify({ seq: calls });
const bash = (command: string): Call => ({ tool: 'bash', input: { command } });
const write = (path: string, content: string): Call => ({ tool: 'write_file', input: { path, content } });
const read = (path: string): Call => ({ tool: 'read_file', input: { path } });

/** A tool that runs `tool` with its call cancelled after `ms` (as a harness's abort would). */
function cancelledAfter(tool: HostTool, ms: number, name = `${tool.name}_cancelled`): HostTool {
  return { ...tool, name, execute: (input, io) => tool.execute(input, { ...io, signal: AbortSignal.timeout(ms) }) };
}

// ---------------------------------------------------------------------------

describe('one worker per session', () => {
  it("a session's machines share its worker; two sessions' never share one", async () => {
    const a1 = await createMachine({ session: 'A' });
    const a2 = await createMachine({ session: 'A' });
    const b = await createMachine({ session: 'B' });
    const la = await leaseOf('A');
    const lb = await leaseOf('B');
    expect(la && lb && la !== lb).toBe(true);
    expect(la!.threadId).not.toBe(lb!.threadId);
    const stats = await workerStats();
    expect(stats!.leases.find((l) => l.session === 'A')).toMatchObject({ machines: 2 });
    expect(stats!.leases.find((l) => l.session === 'B')).toMatchObject({ machines: 1 });
    // A machine of its own (no session given) is a lease of its own.
    const solo = await createMachine();
    expect((await workerStats())!.leases.length).toBe(3);
    // Each machine's files are its own.
    await a1.writeFile('x.txt', 'a1');
    expect((await b.exec('cat x.txt')).exitCode).not.toBe(0);
    expect((await a2.exec('cat x.txt')).exitCode).not.toBe(0);
    for (const m of [a1, a2, b, solo]) m.dispose();
  });

  it('a worker serves one lease: when it ends the thread is terminated, and the next lease, of any session, is a new thread', async () => {
    const seen = new Set<number>();
    const a = await createMachine({ session: 'A' });
    const first = (await leaseOf('A'))!;
    seen.add(first.threadId!);
    // The session's last machine is freed: the lease ends soon after, and its thread exits.
    a.dispose();
    await first.exited;
    expect(first.endedBy).toBe('released');
    expect(await leaseOf('A')).toBeUndefined();
    for (const session of ['A', 'B', 'A']) {
      const m = await createMachine({ session });
      const lease = (await leaseOf(session))!;
      expect(seen.has(lease.threadId!)).toBe(false);
      seen.add(lease.threadId!);
      m.dispose();
      await lease.exited;
    }
  });

  it.each([true, false])("durable: %s: a session's drives in one process share one machine on its worker, not one each", async (durable) => {
    const s = await serve(scripted(docWorkspaceTools({ kind: 'virtual', durable })));
    const { sessionId } = await s.start();
    for (let i = 1; i <= 5; i++) {
      // Each prompt is a turn of its own, driven by a drive of its own.
      await s.send(sessionId, seq(bash(`echo ${i} >> n.txt; wc -l < n.txt`)));
      const state = await settled(s, sessionId, i);
      expect(output(state, i - 1)).toBe(`exit code: 0\nstdout:\n${durable ? i : 1}\n`);
    }
    const state = await s.inspect(sessionId);
    expect(new Set(toolRecords(state).map((r) => r.driver)).size).toBe(5);
    expect((await workerStats())!.leases.find((l) => l.session === sessionId)).toMatchObject({ machines: 1 });
  });

  it('at its bound, a new session takes the worker idle the longest; that session is remade from the log on its next call', async () => {
    await configureWorkers({ maxWorkers: 2 });
    const s = await serve(scripted(docWorkspaceTools()));
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const { sessionId } = await s.start();
      ids.push(sessionId);
      await s.send(sessionId, seq(write(`${name}.txt`, `from ${name}\n`)));
      await settled(s, sessionId, 1);
      // a, then b, are idle long enough to be taken.
      await new Promise((r) => setTimeout(r, 700));
    }
    const stats = (await workerStats())!;
    expect(stats.leases.length).toBeLessThanOrEqual(2);
    expect(stats.leases.map((l) => l.session)).not.toContain(ids[0]);
    // a's worker went to c; a's next call starts from its log on a worker of its own.
    await s.send(ids[0]!, seq(bash('cat a.txt; ls')));
    const state = await settled(s, ids[0]!, 2);
    expect(output(state, 1)).toBe('exit code: 0\nstdout:\nfrom a\na.txt\n');
  });

  it('when every worker is running a call, a new session waits its turn, then is told the instance is busy', async () => {
    await configureWorkers({ maxWorkers: 2, admitWaitMs: 800 });
    const a = await createMachine({ session: 'A', timeoutMs: 20_000 });
    const b = await createMachine({ session: 'B', timeoutMs: 20_000 });
    const running = [a.exec(RUNAWAY).catch((e) => e), b.exec(RUNAWAY).catch((e) => e)];
    const started = Date.now();
    await expect(createMachine({ session: 'C' })).rejects.toMatchObject({ code: 'EBUSY', message: expect.stringMatching(/the instance is busy/) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    await restartWorkers();
    await Promise.all(running);
    // Room again: C gets a worker.
    const c = await createMachine({ session: 'C' });
    expect((await c.exec('echo ok')).stdout).toBe('ok\n');
    c.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('a busy neighbor (two sessions, the pool at its bound)', () => {
  it("one session's runaway awk is ended at its deadline and rolled back, while the other's calls and this thread's timers run on time", async () => {
    await configureWorkers({ maxWorkers: 2 });
    const timeoutMs = 2000;
    const RUNAWAY_CALL = `echo after > a.txt; ${RUNAWAY}`;
    const timing = new Map<string, number>();
    const timed = (tool: HostTool): HostTool => ({
      ...tool,
      async execute(input, io) {
        const t0 = Date.now();
        try {
          return await tool.execute(input, io);
        } finally {
          if ((input as { command?: string }).command === RUNAWAY_CALL) timing.set(io.ctx.runId, Date.now() - t0);
        }
      },
    });
    const s = await serve(scripted(docWorkspaceTools({ kind: 'virtual', durable: true, timeoutMs }).map(timed)));
    const noisy = await s.start();
    const quiet = await s.start();
    await s.send(noisy.sessionId, seq(write('a.txt', 'before')));
    await s.send(quiet.sessionId, seq(write('q.txt', '0')));
    await settled(s, noisy.sessionId, 1);
    await settled(s, quiet.sessionId, 1);
    expect((await workerStats())!.leases.length).toBe(2);

    // This thread's timer: how late it fires while the runaway runs.
    let late = 0;
    let last = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      late = Math.max(late, now - last - 10);
      last = now;
    }, 10);
    await s.send(noisy.sessionId, seq(bash(RUNAWAY_CALL), read('a.txt')));
    // Meanwhile the other session works: one short command after another.
    const quietCalls: Call[] = [];
    for (let i = 1; i <= 8; i++) quietCalls.push(bash(`echo ${i} > q.txt && cat q.txt`));
    await new Promise((r) => setTimeout(r, 200));
    await s.send(quiet.sessionId, seq(...quietCalls));
    const quietState = await settled(s, quiet.sessionId, 9);
    const noisyState = await settled(s, noisy.sessionId, 3);
    clearInterval(tick);

    expect(late).toBeLessThan(50);
    for (let i = 1; i <= 8; i++) expect(output(quietState, i)).toBe(`exit code: 0\nstdout:\n${i}\n`);
    expect(output(noisyState, 1)).toMatch(/^error: the command ran past its time limit \(2 s\), so it was stopped\. Nothing it changed was kept/);
    expect(timing.get(noisy.sessionId)).toBeLessThan(timeoutMs + 1000);
    // Rolled back: the file as the log has it, nothing of the cut-off call.
    expect(output(noisyState, 2)).toBe('before');
    expect(workspaceManifest(noisyState).find((f) => f.path === '/workspace/a.txt')).toMatchObject({ text: 'before' });
  });
});

describe('a budget abort mid-awk', () => {
  it('ends the worker within a second, records a definite outcome, and the next invocation in this process starts from the log', async () => {
    const at: { aborted?: number; exited?: number; lease?: number } = {};
    const tools = docWorkspaceTools().map(
      (tool): HostTool =>
        tool.name !== 'bash'
          ? tool
          : {
              ...tool,
              async execute(input, io) {
                const lease = await leaseOf(io.ctx.runId);
                if ((input as { command: string }).command.includes('awk') && lease) {
                  at.lease = lease.id;
                  io.ctx.signal.addEventListener('abort', () => (at.aborted ??= Date.now()), { once: true });
                  void lease.exited.then(() => (at.exited = Date.now()));
                }
                return tool.execute(input, io);
              },
            }
    );
    // The drive's budget ends about 2 s in, mid-command (the command's own limit is far off).
    const s = await serve(scripted(tools), { maxInvocationMs: 4000, deadlineMarginMs: 2000 });
    const { sessionId } = await s.start();
    await s.send(sessionId, seq(write('a.txt', 'before'), bash(`echo after > a.txt; ${RUNAWAY}`), read('a.txt'), bash('ls')));
    const state = await settled(s, sessionId, 4, 60_000);
    expect(at.aborted).toBeDefined();
    expect(at.exited).toBeDefined();
    expect(at.exited! - at.aborted!).toBeLessThan(1000);
    // A definite outcome, not an open intent: the command never reruns.
    const records = toolRecords(state);
    expect(records.filter((r) => r.name === 'tool.bash' && String((r.input as { command: string }).command).includes('awk'))).toHaveLength(1);
    expect(output(state, 1)).toMatch(/^error: the command was stopped: this invocation of the session ran out of time\. Nothing it changed was kept/);
    // The next invocation (a new drive, here) reads the files from the log, on a new worker.
    expect(new Set(records.map((r) => r.driver)).size).toBeGreaterThan(1);
    expect(output(state, 2)).toBe('before');
    expect(output(state, 3)).toBe('exit code: 0\nstdout:\na.txt\n');
    expect((await leaseOf(sessionId))?.id).not.toBe(at.lease);
  });
});

// ---------------------------------------------------------------------------

describe('limits are tool errors', () => {
  it.each([true, false])('durable: %s: a file over maxFileBytes, a workspace over maxBytes', async (durable) => {
    const tools = docWorkspaceTools({ kind: 'virtual', durable, maxBytes: 200_000, maxFileBytes: 50_000 });
    const s = await serve(scripted(tools));
    const { sessionId } = await s.start();
    await s.send(
      sessionId,
      seq(
        write('big.txt', 'x'.repeat(60_000)),
        bash("printf '%060000d' 0 > big2.txt; echo exit=$?"),
        write('f1.txt', 'x'.repeat(45_000)),
        write('f2.txt', 'x'.repeat(45_000)),
        write('f3.txt', 'x'.repeat(45_000)),
        write('f4.txt', 'x'.repeat(45_000)),
        write('f5.txt', 'x'.repeat(45_000)),
        bash("printf '%045000d' 0 > f6.txt; echo exit=$?"),
        bash('wc -c *')
      )
    );
    const state = await settled(s, sessionId, 9);
    expect(state.status).not.toBe('failed');
    expect(output(state, 0)).toMatch(/^error: EFBIG: .*largest file size/);
    // A command that writes past a cap fails as a command does (exit 1, the reason on stderr).
    expect(output(state, 1)).toMatch(/^exit code: 1\nstderr:\nEFBIG: .*largest file size/);
    expect(output(state, 6)).toMatch(/^error: ENOSPC.*the workspace is full\. Delete files to make room\./);
    expect(output(state, 7)).toMatch(/^exit code: 1\nstderr:\nENOSPC.*the workspace is full/);
    // What the writes left: the files that fit, and (as a shell's failed write would) the empty files the failed redirects opened.
    expect(output(state, 8).replace(/ +/g, ' ')).toMatch(/^exit code: 0\nstdout:\n 0 big2\.txt\n 45000 f1\.txt\n 45000 f2\.txt\n 45000 f3\.txt\n 45000 f4\.txt\n( 0 f6\.txt\n)?180000 total\n$/);
  });
});

describe('the worker has no host environment', () => {
  const SECRETS = { AI_GATEWAY_API_KEY: 'vck_fake_gateway_key_b2_0123456789', VERCEL_OIDC_TOKEN: 'eyJfake.b2.oidc' };
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("a fresh worker's process.env is empty, with defense-in-depth on; the model's commands see none of the host's", async () => {
    const probe = await probeWorker();
    expect(probe?.env).toEqual([]);
    expect(probe?.defense).toMatchObject({ state: 'enabled', level: 'full', processLifetimeIntrinsicHardening: true });
    const s = await serve(scripted(docWorkspaceTools()));
    const { sessionId } = await s.start();
    await s.send(sessionId, seq(bash('env; printenv; echo "[$AI_GATEWAY_API_KEY][${!VERCEL*}]"; cat /proc/self/environ; awk \'BEGIN{print ENVIRON["AI_GATEWAY_API_KEY"]}\'')));
    const state = await settled(s, sessionId, 1);
    const text = output(state, 0);
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
    expect(text).toContain('[][]');
  });
});

describe('the command set', () => {
  /** Pinned: a just-bash upgrade that adds a command fails here until it is reviewed. */
  const PINNED = [
    'alias', 'awk', 'base64', 'basename', 'bash', 'cat', 'chmod', 'clear', 'column', 'comm', 'cp', 'cut', 'date', 'diff', 'dirname', 'du',
    'echo', 'egrep', 'env', 'expand', 'expr', 'false', 'fgrep', 'file', 'find', 'fold', 'grep', 'gunzip', 'gzip', 'head', 'help',
    'history', 'hostname', 'html-to-markdown', 'join', 'jq', 'ln', 'ls', 'md5sum', 'mkdir', 'mv', 'nl', 'od', 'paste', 'printenv',
    'printf', 'pwd', 'readlink', 'rev', 'rg', 'rm', 'rmdir', 'sed', 'seq', 'sh', 'sha1sum', 'sha256sum', 'sleep', 'sort', 'split',
    'stat', 'strings', 'tac', 'tail', 'tar', 'tee', 'time', 'timeout', 'touch', 'tr', 'tree', 'true', 'unalias', 'unexpand', 'uniq',
    'wc', 'which', 'whoami', 'xan', 'xargs', 'yq', 'zcat',
  ];

  it('is the pinned list, and just-bash has nothing more than what it leaves out', async () => {
    expect([...VIRTUAL_COMMANDS]).toEqual(PINNED);
    const jb = await import('just-bash');
    const all = [...jb.getCommandNames(), ...jb.getNetworkCommandNames(), ...jb.getPythonCommandNames(), ...jb.getJavaScriptCommandNames()].sort();
    expect(all.filter((c) => !PINNED.includes(c))).toEqual(['curl', 'js-exec', 'node', 'python', 'python3', 'sqlite3']);
  });

  it.each(['worker', 'process'] as const)('is what the shell registers (%s): nothing else runs', async (isolation) => {
    const m = await createMachine({ isolation });
    expect((await m.exec('ls /bin')).stdout.trim().split('\n')).toEqual(PINNED);
    for (const name of ['sqlite3', 'curl', 'wget', 'python3', 'python', 'js-exec', 'node', 'nc']) {
      const r = await m.exec(`${name} --version`);
      expect({ name, exit: r.exitCode, err: r.stderr }).toMatchObject({ name, exit: 127, err: expect.stringMatching(/command not found|command not available/) });
    }
    m.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('rollback', () => {
  it('durable: a call that throws commits nothing', async () => {
    const tools = docWorkspaceTools();
    const runtime = workspaceRuntime({ kind: 'virtual', durable: true });
    const throwing = runtime.tool<{ path: string }>({
      name: 'write_then_throw',
      description: 'test',
      inputSchema: {},
      mode: 'write',
      async run({ path }, m) {
        await m.writeFile(path, 'half-done');
        await m.exec('echo more > other.txt');
        throw new Error('the tool failed after writing');
      },
    });
    const s = await serve(scripted([...tools, throwing]));
    const { sessionId } = await s.start();
    await s.send(sessionId, seq(write('kept.txt', 'kept'), { tool: 'write_then_throw', input: { path: 'kept.txt' } }, bash('cat kept.txt; ls')));
    const state = await settled(s, sessionId, 3);
    expect(output(state, 1)).toBe('error: the tool failed after writing');
    expect(output(state, 2)).toBe('exit code: 0\nstdout:\nkeptkept.txt\n');
    expect(workspaceManifest(state).map((f) => f.path)).toEqual(['/workspace/kept.txt']);
  });

  it.each([true, false])('durable: %s: a call cancelled mid-command fails, and leaves nothing behind (a runaway, and one that stops on its own)', async (durable) => {
    const tools = docWorkspaceTools({ kind: 'virtual', durable });
    const bashTool = tools.find((t) => t.name === 'bash')!;
    const s = await serve(scripted([...tools, cancelledAfter(bashTool, 500)]));
    const { sessionId } = await s.start();
    const cancelled = (command: string): Call => ({ tool: 'bash_cancelled', input: { command } });
    await s.send(
      sessionId,
      seq(
        write('a.txt', 'before'),
        cancelled(`echo after > a.txt; echo new > b.txt; ${RUNAWAY}`),
        read('a.txt'),
        cancelled('echo after > a.txt; echo new > c.txt; sleep 5'),
        bash('cat a.txt; ls')
      )
    );
    const state = await settled(s, sessionId, 5);
    expect(output(state, 1)).toMatch(/^error: the command was stopped: its call was cancelled\. Nothing it changed was kept/);
    expect(output(state, 2)).toBe('before');
    expect(output(state, 3)).toMatch(/^error: the command was stopped: its call was cancelled/);
    expect(output(state, 4)).toBe('exit code: 0\nstdout:\nbeforea.txt\n');
    if (durable) expect(workspaceManifest(state).map((f) => f.path)).toEqual(['/workspace/a.txt']);
    else expect(state.docs.get(WorkspaceDoc.definition.kind)?.revision ?? 0).toBe(0);
  });
});

describe('the in-memory workspace is cleared on a new invocation', () => {
  const tools = () => docWorkspaceTools({ kind: 'virtual', durable: false });
  const TURN = JSON.stringify([write('a.txt', 'written in the first invocation'), read('a.txt'), bash('ls')]);

  async function prepared() {
    const st = await localStore('hw-b2-inv-');
    stores.push(st);
    const world = st.open();
    // Only the deliveries below drive the session.
    const unqueued = new Proxy(world, { get: (t, k) => (k === 'queue' ? async () => ({ messageId: 'msg_dropped' }) : (t as never)[k]) }) as unknown as DriveContext['world'];
    const s = durableSessions({ world: unqueued, harness: yieldingAfterFirst(tools()) });
    const { sessionId } = await s.start({ harness: 'yielding' });
    await s.send(sessionId, TURN);
    return { s, sessionId, world: unqueued, dataDir: st.dataDir };
  }

  const expectCleared = (state: SessionState) => {
    expect(output(state, 0)).toMatch(/^wrote/);
    expect(output(state, 1)).toContain(RESET_NOTE);
    expect(output(state, 1)).toMatch(/ENOENT|no such file/i);
    expect(output(state, 2)).toBe('exit code: 0');
    expect(new Set(toolRecords(state).map((r) => r.driver)).size).toBe(2);
  };

  it('in the same process', async () => {
    const { s, sessionId, world } = await prepared();
    const harness = yieldingAfterFirst(tools());
    for (let i = 0; i < 2; i++) await deliver({ world, harness, anchors: vercelAnchors(), contendedDelaySeconds: 1 }, sessionId, { anchor: { k: 'msg', m: `msg_same_${i}` } });
    expectCleared(await s.inspect(sessionId));
  });

  it('in a new process', async () => {
    const { s, sessionId, dataDir } = await prepared();
    for (let i = 0; i < 2; i++) {
      const { stdout } = await run(process.execPath, ['--import', 'tsx', CHILD, dataDir, sessionId], { cwd: PACKAGE });
      expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({ isolation: 'worker' });
    }
    expectCleared(await s.inspect(sessionId));
  }, 60_000);
});
