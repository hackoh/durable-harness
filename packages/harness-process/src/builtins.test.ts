import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, type Harness } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { BuiltinCalls, replayBy } from './builtins.ts';
import { placeSubmissions } from './inbox.ts';
import { NativeJournal } from './journal.ts';
import { recoveryNote } from './recovery.ts';
import { journalRecords } from './records.ts';
import { openWorkspace, WORKSPACE_STREAM, workspaceNote } from './workspace.ts';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

/** One session, driven by `bodies[n]` on its n-th drive (each drive places what is pending first). */
async function session(bodies: ((ctx: DriveContext) => Promise<void>)[]) {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hwp-builtins-')), recoverActiveRuns: false });
  worlds.push(world);
  let n = 0;
  const lives: unknown[] = [];
  const harness: Harness = {
    name: 'builtins',
    async drive(ctx) {
      const body = bodies[n++];
      if (!body) return;
      if (ctx.pending().length) await placeSubmissions(ctx, ctx.pending());
      const live = ctx.live.bind(ctx);
      (ctx as { live: DriveContext['live'] }).live = (e) => {
        lives.push(e);
        live(e);
      };
      await body(ctx);
    },
  };
  const sessions = durableSessions({ world, harness });
  const { sessionId } = await sessions.start();
  await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
  return {
    lives,
    drive: () => sessions.drive(sessionId).catch((err: unknown) => err),
    send: (text: string) => sessions.send(sessionId, text, 'prompt', { wake: 'backstop' }),
    inspect: () => sessions.inspect(sessionId),
  };
}

describe('BuiltinCalls', () => {
  it('commits the intent before the call runs, and the outcome when the harness reports it', async () => {
    const order: string[] = [];
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx, { replay: replayBy(['Read']) });
        const start = await calls.begin({ callId: 'toolu_1', name: 'Bash', input: { command: 'date > d.txt' } });
        expect(start).toEqual({ run: true });
        // The intent is in the log (born running) before the hook lets the call run.
        expect(ctx.state().effects.get('tool:toolu_1')).toMatchObject({ name: 'tool.Bash', status: 'running', replay: 'never', input: { command: 'date > d.txt' } });
        order.push('ran');
        await calls.end('toolu_1', { text: 'ok' });
        expect(ctx.state().effects.get('tool:toolu_1')).toMatchObject({ status: 'completed', output: 'ok' });
        // A read is `safe`; a failed call is a failed step with the harness's text.
        await calls.begin({ callId: 'toolu_2', name: 'Read', input: { file_path: 'x' } });
        await calls.end('toolu_2', { text: 'ENOENT: no such file', isError: true });
        expect(calls.size).toBe(0);
      },
    ]);
    await s.drive();
    const state = await s.inspect();
    expect(order).toEqual(['ran']);
    expect(state.effects.get('tool:toolu_2')).toMatchObject({ name: 'tool.Read', replay: 'safe', status: 'failed', error: { message: 'ENOENT: no such file' } });
    expect(s.lives).toEqual([
      { type: 'tool_start', name: 'Bash', args: { command: 'date > d.txt' }, callId: 'toolu_1' },
      { type: 'tool_end', name: 'Bash', callId: 'toolu_1' },
      { type: 'tool_start', name: 'Read', args: { file_path: 'x' }, callId: 'toolu_2' },
      { type: 'tool_end', name: 'Read', callId: 'toolu_2', isError: true },
    ]);
  });

  it('a call id the log already finished is never run again: begin answers from the log', async () => {
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx);
        await calls.begin({ callId: 'c1', name: 'Bash', input: {} });
        await calls.end('c1', { text: 'paid once' });
        // The same call dispatched again (a harness that re-issues it after a resume).
        expect(await calls.begin({ callId: 'c1', name: 'Bash', input: {} })).toEqual({ run: false, result: { text: 'paid once', isError: false } });
      },
    ]);
    await s.drive();
    expect((await s.inspect()).effectOrder.filter((e) => e.key === 'tool:c1')).toHaveLength(1);
  });

  it('the barrier runs before a never call, not before a safe one', async () => {
    const s = await session([
      async (ctx) => {
        const barriers: string[] = [];
        const calls = new BuiltinCalls(ctx, {
          replay: replayBy(['Grep']),
          beforeNever: async (c) => {
            barriers.push(c.callId);
            await ctx.effect(`barrier:${c.callId}`, { name: 'barrier', replay: 'safe', input: null }, async () => true);
          },
        });
        await calls.begin({ callId: 'g1', name: 'Grep', input: {} });
        await calls.end('g1', { text: 'none' });
        await calls.begin({ callId: 'w1', name: 'Write', input: {} });
        await calls.end('w1', { text: 'written' });
        expect(barriers).toEqual(['w1']);
      },
    ]);
    await s.drive();
    expect((await s.inspect()).effectOrder.map((e) => e.key)).toEqual([expect.stringMatching(/^place:/), 'tool:g1', 'barrier:w1', 'tool:w1']);
  });

  it('the harness died mid-call (the drive lives): interruptAll commits it interrupted, and the note says it may have taken effect', async () => {
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx, { replay: replayBy(['Read']) });
        await calls.begin({ callId: 'b1', name: 'Bash', input: { command: 'pay' } });
        await calls.begin({ callId: 'r1', name: 'Read', input: { file_path: 'a' } });
        await calls.interruptAll();
        const note = recoveryNote(ctx.state())!;
        expect(note.calls.map((c) => [c.callId, c.status])).toEqual([
          ['b1', 'interrupted'],
          ['r1', 'retryable'],
        ]);
        expect(note.text).toContain('Bash({"command":"pay"}), call b1: interrupted before it reported a result. It is not safe to repeat, and it may have taken effect');
        expect(note.text).toContain('Read({"file_path":"a"}), call r1: interrupted before it reported a result. It is safe to repeat.');
      },
    ]);
    await s.drive();
    const state = await s.inspect();
    expect(state.effects.get('tool:b1')).toMatchObject({ status: 'failed', error: { interrupted: true } });
  });

  it('the drive stops mid-call: the next delivery resolves the intent, interrupted (never) or for a retry (safe), and nothing reruns it', async () => {
    let notes: string[] = [];
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx, { replay: replayBy(['Glob']) });
        await calls.begin({ callId: 'n1', name: 'Edit', input: {} });
        await calls.begin({ callId: 's1', name: 'Glob', input: {} });
        // The drive goes away with both calls open: nothing more is written by it.
        ctx.halt?.(new Error('the process went away'));
        await calls.settled(5000);
      },
      async (ctx) => {
        // The next drive: the kernel has resolved the dead drive's intents by now.
        notes = recoveryNote(ctx.state())!.calls.map((c) => `${c.callId}:${c.status}`);
      },
    ]);
    await s.drive();
    expect((await s.inspect()).effects.get('tool:n1')).toMatchObject({ status: 'running' });
    await s.send('again');
    await s.drive();
    const state = await s.inspect();
    expect(state.effects.get('tool:n1')).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect(state.effects.get('tool:s1')).toMatchObject({ status: 'pending' });
    expect(notes).toEqual(['n1:interrupted', 's1:retryable']);
  });

  it('an end without its begin (a hook that fired alone) is recorded after the fact', async () => {
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx);
        await calls.end('late1', { name: 'commandExecution', input: { command: 'ls' }, text: 'a.txt' });
      },
    ]);
    await s.drive();
    expect((await s.inspect()).effects.get('tool:late1')).toMatchObject({ name: 'tool.commandExecution', replay: 'safe', status: 'completed', output: 'a.txt' });
  });

  it('around: the call runs inside the wrapper, begin resolving only once the wrapper lets it run, and the wrapper gives the outcome', async () => {
    const order: string[] = [];
    let stepId: string | undefined;
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx, {
          around: async (call, run, io) => {
            stepId = io.stepId;
            expect(io.ctx).toBe(ctx);
            // The effect's documents, so a wrapper can commit what the call changed with its outcome.
            expect(io.docs).toBeDefined();
            order.push(`before ${call.callId}`);
            // Setup the call must see (a workspace synced in) before the harness lets it run.
            await new Promise((r) => setTimeout(r, 20));
            order.push('synced');
            const text = await run();
            order.push(`after ${call.callId}: ${text}`);
            return `${text} (committed with the files)`;
          },
        });
        const start = await calls.begin({ callId: 'oc_1', name: 'write', input: { filePath: 'a.txt' } });
        expect(start).toEqual({ run: true });
        order.push('ran');
        await calls.end('oc_1', { text: 'wrote a.txt' });
        order.push('ended');
      },
    ]);
    await s.drive();
    expect(order).toEqual(['before oc_1', 'synced', 'ran', 'after oc_1: wrote a.txt', 'ended']);
    const state = await s.inspect();
    expect(state.effects.get('tool:oc_1')).toMatchObject({ status: 'completed', output: 'wrote a.txt (committed with the files)' });
    expect(stepId).toBe(state.effects.get('tool:oc_1')!.stepId);
  });

  it('around: a wrapper that fails before it lets the call run fails the call, and begin says not to run it', async () => {
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx, {
          around: async () => {
            throw new Error('the workspace could not be synced');
          },
        });
        const start = await calls.begin({ callId: 'oc_2', name: 'edit', input: {} });
        expect(start).toEqual({ run: false, result: { text: expect.stringContaining('the workspace could not be synced'), isError: true } });
        expect(calls.size).toBe(0);
      },
    ]);
    await s.drive();
    expect((await s.inspect()).effects.get('tool:oc_2')).toMatchObject({ status: 'failed', error: { message: 'the workspace could not be synced' } });
    // It never started.
    expect(s.lives).toEqual([]);
  });

  it('around: a wrapper that throws after the call ran fails the step, ends it on the live stream as an error, and end() resolves', async () => {
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx, {
          around: async (_call, run) => {
            await run();
            throw new Error('the workspace commit failed');
          },
        });
        expect(await calls.begin({ callId: 'oc_3', name: 'write', input: {} })).toEqual({ run: true });
        await calls.end('oc_3', { text: 'wrote b.txt' });
        expect(calls.size).toBe(0);
      },
    ]);
    await s.drive();
    expect((await s.inspect()).effects.get('tool:oc_3')).toMatchObject({ status: 'failed', error: { message: 'the workspace commit failed' } });
    expect(s.lives).toEqual([expect.objectContaining({ type: 'tool_start', callId: 'oc_3' }), expect.objectContaining({ type: 'tool_end', callId: 'oc_3', isError: true })]);
  });

  it('around: a wrapper that returns without letting the call run decides its outcome; begin answers with it, and nothing goes on the live stream', async () => {
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx, { around: async () => 'nothing to do: a.txt is already there' });
        expect(await calls.begin({ callId: 'oc_4', name: 'write', input: {} })).toEqual({ run: false, result: { text: 'nothing to do: a.txt is already there', isError: false } });
        expect(calls.size).toBe(0);
      },
    ]);
    await s.drive();
    expect((await s.inspect()).effects.get('tool:oc_4')).toMatchObject({ status: 'completed', output: 'nothing to do: a.txt is already there' });
    expect(s.lives).toEqual([]);
  });

  it('around: a wrapper that calls run twice runs the call once', async () => {
    const s = await session([
      async (ctx) => {
        const calls = new BuiltinCalls(ctx, {
          around: async (_call, run) => {
            const [a, b] = await Promise.all([run(), run()]);
            return `${a} / ${b}`;
          },
        });
        expect(await calls.begin({ callId: 'oc_5', name: 'write', input: {} })).toEqual({ run: true });
        await calls.end('oc_5', { text: 'wrote c.txt' });
      },
    ]);
    await s.drive();
    expect((await s.inspect()).effects.get('tool:oc_5')).toMatchObject({ status: 'completed', output: 'wrote c.txt / wrote c.txt' });
    expect(s.lives.filter((e) => (e as { type: string }).type === 'tool_start')).toHaveLength(1);
  });
});

describe('openWorkspace', () => {
  it('records the copy a drive used, and says when a later drive has another one (a fresh directory, another machine)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hwp-ws-'));
    const path = join(root, 'workspace');
    const marker = join(root, '.harness', 'workspace.json');
    const seen: { created: boolean; moved: boolean }[] = [];
    const open = async (ctx: DriveContext) => {
      const journal = new NativeJournal(ctx);
      const ws = await openWorkspace(journal, { path, marker });
      await journal.flush();
      seen.push({ created: ws.created, moved: ws.moved });
    };
    const s = await session([
      open,
      // The same machine: the same copy.
      open,
      // Another machine: no directory, no marker.
      async (ctx) => {
        await rm(root, { recursive: true, force: true });
        await open(ctx);
      },
      // The same machine as the last drive.
      open,
    ]);
    for (let i = 0; i < 4; i++) {
      if (i > 0) await s.send(`turn ${i}`);
      await s.drive();
    }
    expect(seen).toEqual([
      { created: true, moved: false },
      { created: false, moved: false },
      { created: true, moved: true },
      { created: false, moved: false },
    ]);
    const records = journalRecords<{ id: string; previous?: string }>(await s.inspect(), WORKSPACE_STREAM).map((r) => r.data);
    // Written only when the copy changes.
    expect(records).toHaveLength(2);
    expect(records[1]!.previous).toBe(records[0]!.id);
    expect(JSON.parse(await readFile(marker, 'utf8')).id).toBe(records[1]!.id);
    expect(workspaceNote(path)).toContain(`working directory (${path})`);
  });
});
