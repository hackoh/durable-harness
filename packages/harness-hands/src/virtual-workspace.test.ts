import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DriveContext, durableSessions, EffectFailure, type Harness, type HostTool, hostToolIO, QUEUE_PREFIX, type SessionState, Yield } from 'harness-world';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { docWorkspaceTools, WorkspaceDoc, workspaceManifest } from './index.ts';
import { createMachine, findJustBash, probeWorker, restartWorkers, type VirtualMachine } from './isolation.ts';
import { EPHEMERAL_NOTE, RESET_NOTE, VIRTUAL_NOTE, workspaceInstructions, workspaceRuntime } from './runtime.ts';
import { type Call, localStore, scripted, toolRecords, until } from './test-harness.ts';

/**
 * The virtual workspace: its shell reaches nothing of the machine that runs
 * it (environment, disk, processes, network), in the isolated worker and in
 * this realm; the in-memory workspace lasts one turn and says when it was
 * reset; the durable one survives its worker being restarted.
 */

const SECRETS = { AI_GATEWAY_API_KEY: 'vck_fake_gateway_key_0123456789', VERCEL_OIDC_TOKEN: 'eyJfake.oidc.token' };
let hostDir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  hostDir = await mkdtemp(join(tmpdir(), 'hw-escape-'));
  await writeFile(join(hostDir, 'host-secret.txt'), 'HOST-FILE-CONTENT');
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(hostDir, { recursive: true, force: true });
});

/** Scripts that try to reach the host: each must come back with nothing of it. */
const escapes = () => [
  'env',
  'printenv',
  'set',
  'export -p',
  'declare -x',
  'compgen -v',
  'echo "[$AI_GATEWAY_API_KEY][$VERCEL_OIDC_TOKEN][${!AI*}][${!VERCEL*}]"',
  'printenv AI_GATEWAY_API_KEY; printenv VERCEL_OIDC_TOKEN',
  'cat /proc/self/environ; cat /proc/1/environ; ls -R /proc',
  'cat /proc/self/cmdline; cat /proc/self/status',
  `ls ${hostDir}; cat ${hostDir}/host-secret.txt`,
  'ls /tmp /etc /Users /home /var /private 2>&1',
  'cat /etc/passwd /etc/hosts',
  'cat ../../../../../../etc/passwd; cd ../../../..; pwd; ls',
  `cd /workspace && cat ..${hostDir}/host-secret.txt`,
  `ln -s ${hostDir}/host-secret.txt out && cat out; ln -s /etc/passwd pw && cat pw; ln -s / root && ls root`,
  'curl -s https://example.com; wget -q -O - https://example.com; nc example.com 80; html-to-markdown https://example.com',
  'node -e "console.log(process.env)"; python3 -c "import os; print(os.environ)"; js-exec "console.log(1)"; deno eval 1; bun -e 1',
  "awk 'BEGIN{ system(\"env\") }'; awk 'BEGIN{ print ENVIRON[\"AI_GATEWAY_API_KEY\"] }'",
  `sqlite3 :memory: "ATTACH '${hostDir}/host-secret.txt' AS x; select 1"; sqlite3 :memory: "select load_extension('/usr/lib/x')"`,
  "jq -n 'env'; jq -n '$ENV'",
  'source /proc/self/environ; . /etc/profile; exec printenv',
];

function leaks(text: string): string[] {
  const found: string[] = [];
  for (const [k, v] of Object.entries(SECRETS)) if (text.includes(v)) found.push(k);
  if (text.includes('HOST-FILE-CONTENT')) found.push('host file');
  if (text.includes('host-secret.txt') && !text.includes('No such file')) found.push('host directory listing');
  if (/root:.*:0:0:/.test(text)) found.push('/etc/passwd');
  if (/Example Domain/.test(text)) found.push('network');
  return found;
}

describe.each(['worker', 'process'] as const)('a virtual machine (%s)', (isolation) => {
  let machine: VirtualMachine;
  beforeAll(async () => {
    machine = await createMachine({ isolation });
  });
  afterAll(() => machine.dispose());

  it('runs where it was asked to', () => {
    expect(machine.isolation).toBe(isolation);
  });

  it('reaches nothing of the host: environment, disk, processes, network', async () => {
    for (const script of escapes()) {
      const r = await machine.exec(script);
      expect({ script, leaks: leaks(r.stdout + r.stderr) }).toEqual({ script, leaks: [] });
    }
    // The workspace still works, and a link out names nothing real.
    expect((await machine.exec('echo ok > f && cat f')).stdout).toBe('ok\n');
  });

  it('stops a command at its timeout', async () => {
    const started = Date.now();
    const r = await machine.exec('sleep 5; echo late', { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.stdout).not.toContain('late');
    expect(r.exitCode).not.toBe(0);
  });

  it(isolation === 'worker' ? "enforces normal counts (its deadline bounds a command's time) and hardened sizes" : 'enforces the hardened limits', async () => {
    // In a worker, a real script's loop runs; in this realm, where nothing can stop a command that never yields, it is capped.
    const loop = await machine.exec('seq 1 20000 | wc -l');
    if (isolation === 'worker') expect(loop.stdout.trim()).toBe('20000');
    else {
      expect(loop.exitCode).not.toBe(0);
      expect(loop.stderr).toMatch(/limit/);
    }
    const longer = await machine.exec('seq 1 200000 | wc -l');
    expect(longer.exitCode).not.toBe(0);
    // Either way a command's output stays a size a tool result can be.
    const output = await machine.exec("x=$(printf '%01000000d' 0); for i in $(seq 1 12); do echo $x; done | wc -c");
    expect(output.exitCode).not.toBe(0);
  });
});

describe('the worker', () => {
  it('finds just-bash for the worker even where it does not resolve (a bundle that renamed it)', async () => {
    const resolved = await findJustBash();
    expect(resolved).toMatch(/just-bash.*dist\/bundle\/index\.js$/);
    expect(await findJustBash({ unresolvable: true })).toBe(resolved);
  });

  it('has an empty environment and full defense-in-depth', async () => {
    await createMachine({ isolation: 'worker' }).then((m) => m.dispose());
    const probe = await probeWorker();
    expect(probe?.env).toEqual([]);
    expect(probe?.defense).toMatchObject({ state: 'enabled', level: 'full', processLifetimeIntrinsicHardening: true });
  });

  it('a long command holds the worker, not this thread', async () => {
    const machine = await createMachine({ isolation: 'worker' });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const started = Date.now();
    await machine.exec('for i in $(seq 1 9000); do echo $i; done | wc -l');
    const elapsed = Date.now() - started;
    clearInterval(timer);
    machine.dispose();
    // This thread kept turning while the command ran.
    expect(ticks).toBeGreaterThan(Math.floor(elapsed / 5 / 4));
  });

  it('a restart loses its machines, and new ones work', async () => {
    const machine = await createMachine({ isolation: 'worker' });
    await machine.writeFile('a.txt', 'x');
    await restartWorkers();
    expect(machine.lost).toBe(true);
    await expect(machine.readFile('a.txt')).rejects.toMatchObject({ code: 'EGONE' });
    const next = await createMachine({ isolation: 'worker' });
    expect((await next.exec('echo again')).stdout).toBe('again\n');
    next.dispose();
  });
});

// ---------------------------------------------------------------------------
// The tools, on a session

const stores: Awaited<ReturnType<typeof localStore>>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll();
});

async function serve(harness: Harness) {
  const st = await localStore('hw-virtual-');
  stores.push(st);
  const world = st.open();
  const s = durableSessions({ world, harness });
  world.registerHandler(QUEUE_PREFIX, s.handler);
  return s;
}

type Sessions = Awaited<ReturnType<typeof serve>>;

async function settled(s: Sessions, sessionId: string, calls: number): Promise<SessionState> {
  let state!: SessionState;
  await until(async () => {
    state = await s.inspect(sessionId);
    if (state.status === 'failed') return true;
    const recs = toolRecords(state);
    return recs.length >= calls && recs.every((r) => r.status === 'completed' || r.status === 'failed');
  }, 'tool calls');
  return state;
}

const output = (state: SessionState, i: number) => {
  const r = toolRecords(state)[i]!;
  return r.status === 'completed' ? String(r.output) : `error: ${r.error?.message}`;
};

describe('the in-memory workspace (virtual({ durable: false }))', () => {
  const ephemeral = () => docWorkspaceTools({ kind: 'virtual', durable: false });

  it('says where it runs and how long files last', () => {
    const tools = ephemeral();
    for (const t of tools) expect(t.description).toContain(EPHEMERAL_NOTE);
    expect(tools.find((t) => t.name === 'bash')!.description).toContain(VIRTUAL_NOTE);
    const durable = docWorkspaceTools();
    for (const t of durable) expect(t.description).not.toContain(EPHEMERAL_NOTE);
    expect(durable.find((t) => t.name === 'bash')!.description).toContain(VIRTUAL_NOTE);
    expect(workspaceInstructions(false)).toMatch(/not real Linux: no network, no package installs, no real processes/);
    expect(workspaceInstructions(false)).toMatch(/files last until the end of this turn/);
    expect(workspaceInstructions(true)).not.toMatch(/end of this turn/);
  });

  it('keeps files for the turn, writes nothing to the log, and is empty on the next turn', async () => {
    const s = await serve(scripted(ephemeral()));
    const { sessionId } = await s.start();
    const turn1: { seq: Call[] } = {
      seq: [
        { tool: 'write_file', input: { path: 'notes.txt', content: 'kept for this turn\n' } },
        { tool: 'bash', input: { command: 'cat notes.txt && echo more >> notes.txt && chmod 755 notes.txt' } },
        { tool: 'read_file', input: { path: 'notes.txt' } },
        { tool: 'list_files', input: {} },
      ],
    };
    await s.send(sessionId, JSON.stringify(turn1));
    let state = await settled(s, sessionId, 4);
    expect(output(state, 1)).toContain('kept for this turn');
    expect(output(state, 2)).toBe('kept for this turn\nmore\n');
    expect(output(state, 3)).toBe('/workspace/notes.txt');
    // Nothing in the log: no manifest, no fs steps.
    expect(state.docs.get(WorkspaceDoc.definition.kind)?.revision ?? 0).toBe(0);
    expect(workspaceManifest(state)).toEqual([]);
    expect(state.effectOrder.some((e) => e.name === 'fs')).toBe(false);

    await s.send(sessionId, JSON.stringify({ seq: [{ tool: 'list_files', input: {} }, { tool: 'read_file', input: { path: 'notes.txt' } }] }));
    state = await settled(s, sessionId, 6);
    expect(output(state, 4)).toBe('(empty workspace)');
    expect(output(state, 5)).toMatch(/^error: .*(ENOENT|no such file)/i);
  });

  it('tells the model when a turn picked up by a new drive found it reset', async () => {
    // One turn, two calls; the first drive yields after the first (as a drive out of budget does).
    const tools = ephemeral();
    const drives: DriveContext[] = [];
    const harness: Harness = {
      name: 'yielding',
      async drive(ctx) {
        drives.push(ctx);
        for (const sub of ctx.state().submissions) {
          if (sub.kind !== 'prompt' || !sub.text) continue;
          const calls = JSON.parse(sub.text) as Call[];
          for (const [i, call] of calls.entries()) {
            const key = `tool:${sub.id}:${i}`;
            const memo = ctx.isMemoized(key);
            const tool = tools.find((t) => t.name === call.tool) as HostTool;
            try {
              await ctx.effect(key, { name: `tool.${tool.name}`, replay: tool.replay, input: call.input, placed: [sub.id] }, (io) => tool.execute(call.input, hostToolIO(io, ctx)));
            } catch (err) {
              if (!(err instanceof EffectFailure)) throw err;
            }
            if (!memo && i === 0 && drives.length === 1) throw new Yield('budget');
          }
        }
      },
    };
    const s = await serve(harness);
    const { sessionId } = await s.start();
    await s.send(
      sessionId,
      JSON.stringify([
        { tool: 'write_file', input: { path: 'a.txt', content: 'written before the yield' } },
        { tool: 'read_file', input: { path: 'a.txt' } },
        { tool: 'list_files', input: {} },
      ])
    );
    const state = await settled(s, sessionId, 3);
    expect(drives.length).toBeGreaterThanOrEqual(2);
    expect(output(state, 0)).toMatch(/^wrote/);
    // The first call the new drive ran says why the file is gone, once.
    expect(output(state, 1)).toContain(RESET_NOTE);
    expect(output(state, 1)).toMatch(/ENOENT|no such file/i);
    expect(output(state, 2)).toBe('(empty workspace)');
  });
});

describe('the in-memory workspace, its worker restarted mid-turn', () => {
  it('comes back with its files: only the call that was running is lost', async () => {
    const tools = docWorkspaceTools({ kind: 'virtual', durable: false }, { isolation: 'worker' });
    const restarting: HostTool = { name: 'restart_shell', description: 'test', inputSchema: {}, replay: 'safe', execute: async () => (await restartWorkers(), 'restarted') };
    const s = await serve(scripted([...tools, restarting]));
    const { sessionId } = await s.start();
    await s.send(
      sessionId,
      JSON.stringify({
        seq: [
          { tool: 'write_file', input: { path: 'a.txt', content: 'x' } },
          { tool: 'bash', input: { command: 'chmod 755 a.txt && mkdir -p d && echo y > d/b.txt' } },
          { tool: 'restart_shell', input: {} },
          { tool: 'bash', input: { command: 'stat -c %a a.txt; cat a.txt d/b.txt' } },
        ],
      })
    );
    const state = await settled(s, sessionId, 4);
    expect(output(state, 3)).toBe('exit code: 0\nstdout:\n755\nxy\n');
  });
});

describe('limits', () => {
  it('a command that never yields is stopped at its time limit, on its worker, while this thread turns', async () => {
    const machine = await createMachine({ isolation: 'worker', timeoutMs: 1000 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    // Nested loops: each under the hardened per-loop cap, together far past the deadline (just-bash never yields here).
    const run = machine.exec("awk 'BEGIN{for(i=0;i<9999;i++)for(j=0;j<9999;j++)x++; print x}'");
    await expect(run).rejects.toMatchObject({ code: 'ETIMEDOUT', message: expect.stringMatching(/time limit \(1 s\)/) });
    const elapsed = Date.now() - started;
    clearInterval(timer);
    expect(elapsed).toBeLessThan(10_000);
    expect(ticks).toBeGreaterThan(Math.floor(elapsed / 10 / 4));
    expect(machine.lost).toBe(true);
  });

  it("one deadline decides, not the clock: just-bash's own stop at the limit fails, a command's own exit 124 is its own", async () => {
    for (const isolation of ['worker', 'process'] as const) {
      const machine = await createMachine({ isolation, timeoutMs: 400 });
      // just-bash stops a sleep with a timer, which can fire a little before the limit has passed by the clock.
      for (const command of ['sleep 5', 'echo x > a.txt; sleep 5', 'x=$(sleep 5)', 'sleep 5 | cat']) {
        await expect(machine.exec(command), `${isolation}: ${command}`).rejects.toMatchObject({ code: 'ETIMEDOUT', message: expect.stringMatching(/time limit \(0.4 s\)/) });
      }
      expect(await machine.exec('sleep 0.1; exit 124')).toMatchObject({ exitCode: 124 });
      // A command's own deadline below the machine's exits 124, like `timeout`; one at or past it is the machine's.
      expect(await machine.exec('sleep 5', { timeoutMs: 100 })).toMatchObject({ exitCode: 124 });
      await expect(machine.exec('sleep 5', { timeoutMs: 400 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      machine.dispose();
    }
  });

  it('a workspace holds at most maxBytes, a file at most maxFileBytes', async () => {
    for (const isolation of ['worker', 'process'] as const) {
      const machine = await createMachine({ isolation, maxBytes: 200_000, maxFileBytes: 50_000 });
      const big = await machine.exec("printf '%060000d' 0 > big; echo $?");
      expect(big.stdout + big.stderr).toMatch(/EFBIG/);
      await expect(machine.writeFile('big2', new Uint8Array(60_000))).rejects.toMatchObject({ code: 'EFBIG' });
      for (let i = 0; i < 4; i++) await machine.writeFile(`f${i}`, new Uint8Array(45_000));
      const full = await machine.exec("printf '%045000d' 0 > f5; echo $?");
      expect(full.stdout + full.stderr).toMatch(/the workspace is full/);
      await expect(machine.writeFile('f6', new Uint8Array(45_000))).rejects.toMatchObject({ code: 'ENOSPC' });
      machine.dispose();
    }
  });

  it('a durable call past its time limit fails and changes nothing', async () => {
    const tools = docWorkspaceTools({ kind: 'virtual', durable: true, timeoutMs: 1000 } as never, { isolation: 'worker' });
    const s = await serve(scripted(tools));
    const { sessionId } = await s.start();
    await s.send(
      sessionId,
      JSON.stringify({
        seq: [
          { tool: 'write_file', input: { path: 'a.txt', content: 'before' } },
          { tool: 'bash', input: { command: "echo after > a.txt; awk 'BEGIN{for(i=0;i<9999;i++)for(j=0;j<9999;j++)x++}'" } },
          { tool: 'read_file', input: { path: 'a.txt' } },
        ],
      })
    );
    const state = await settled(s, sessionId, 3);
    expect(output(state, 1)).toMatch(/^error: the command ran past its time limit/);
    expect(output(state, 2)).toBe('before');
  });
});

describe('the durable workspace (virtual())', () => {
  it('a restarted worker loses nothing: the next call rebuilds the files from the log', async () => {
    const s = await serve(scripted(docWorkspaceTools()));
    const { sessionId } = await s.start();
    await s.send(sessionId, JSON.stringify({ seq: [{ tool: 'write_file', input: { path: 'kept.txt', content: 'in the log\n' } }] }));
    await settled(s, sessionId, 1);
    await restartWorkers();
    await s.send(sessionId, JSON.stringify({ tool: 'bash', input: { command: 'cat kept.txt' } }));
    const state = await settled(s, sessionId, 2);
    expect(output(state, 1)).toContain('in the log');
  });

  it('refuses to run without a World, saying what to use', async () => {
    const runtime = workspaceRuntime({ kind: 'virtual', durable: true });
    const tool = runtime.tool<{ path: string }>({ name: 'peek', description: 'Peek.', inputSchema: {}, mode: 'read', run: async () => 'ok' });
    const io = { ctx: { world: undefined, state: () => ({}) }, signal: new AbortController().signal, progress() {}, docs: {} } as never;
    await expect(tool.execute({ path: 'x' }, io)).rejects.toThrow(/durable: false/);
  });
});
