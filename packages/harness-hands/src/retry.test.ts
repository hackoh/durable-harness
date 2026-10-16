import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, EffectFailure, type Harness, type HostTool, hostToolIO, QUEUE_PREFIX, readBlobs, blobStreamName, type SessionState, sha256Hex } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { filesFromState, readLedger, readWorkspace, WorkspaceDoc, workspaceManifest, workspaceTools } from './index.ts';

/**
 * Failure injection for the replay policies: a process dies in the middle
 * of a tool call, after the tool changed something and before its result
 * reached the log. A `safe` tool's retry must produce exactly what one clean
 * run produces; a `never` tool must not run again.
 */

interface Call {
  tool: string;
  input: Record<string, unknown>;
}

/** One tool call per prompt (the prompt is the call, as JSON). Re-runs a released call on the next drive. */
function scripted(tools: HostTool[]): Harness {
  return {
    name: 'scripted',
    async drive(ctx: DriveContext) {
      for (const s of ctx.state().submissions) {
        if (s.kind !== 'prompt' || !s.text || ctx.state().withdrawn.has(s.id)) continue;
        const call = JSON.parse(s.text) as Call;
        const tool = tools.find((t) => t.name === call.tool)!;
        try {
          await ctx.effect(
            `tool:${s.id}`,
            { name: `tool.${tool.name}`, replay: tool.replay, input: call.input, placed: [s.id] },
            (io) => tool.execute(call.input, hostToolIO(io, ctx))
          );
        } catch (err) {
          if (!(err instanceof EffectFailure)) throw err;
        }
      }
    },
  };
}

/** The same tools, except that each one hangs after doing its work (so a crash lands after it, before its result). */
function hangingAfterWork(tools: HostTool[]): HostTool[] {
  return tools.map((t) => ({
    ...t,
    async execute(input, io) {
      await t.execute(input, io);
      await new Promise((r) => setTimeout(r, 60_000));
      return 'never reached';
    },
  }));
}

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function until(fn: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const toolRecords = (s: SessionState) => s.effectOrder.filter((e) => e.name.startsWith('tool.'));

/**
 * Run `setup` cleanly, then `call` in a process that dies right after the
 * tool did its work, then recover in a fresh process. Returns the final fold.
 */
async function crashMidCall(setup: Call[], call: Call, opts: { confirmMs?: number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hw-retry-'));
  const tools = workspaceTools({ confirmMs: opts.confirmMs ?? 60_000 });
  const worldA = createWorld({ dataDir, recoverActiveRuns: false });
  worlds.push(worldA);
  let crashed!: () => void;
  const died = new Promise<void>((r) => (crashed = r));
  // Process A: setup calls run through the real tools; the crashed call hangs after its work.
  const aTools = [...tools.filter((t) => t.name !== call.tool), ...hangingAfterWork(tools.filter((t) => t.name === call.tool))];
  const a = durableSessions({ world: worldA, harness: scripted(aTools), chaos: true, crash: () => crashed() });
  worldA.registerHandler(QUEUE_PREFIX, a.handler);
  const { sessionId } = await a.start();
  for (const [i, c] of setup.entries()) {
    await a.send(sessionId, JSON.stringify(c));
    await until(async () => {
      const recs = toolRecords(await a.inspect(sessionId));
      return recs.length === i + 1 && recs.every((r) => r.status === 'completed');
    }, 'setup call');
  }
  await a.chaos(sessionId, { at: 'tool', afterMs: 400 });
  await a.send(sessionId, JSON.stringify(call));
  await died;
  const before = await a.inspect(sessionId);
  await worldA.close?.();

  const worldB = createWorld({ dataDir, recoverActiveRuns: true });
  worlds.push(worldB);
  const b = durableSessions({ world: worldB, harness: scripted(workspaceTools({ confirmMs: 10 })), chaos: true });
  worldB.registerHandler(QUEUE_PREFIX, b.handler);
  await worldB.start?.();
  let state = await b.inspect(sessionId);
  await until(async () => {
    state = await b.inspect(sessionId);
    const last = toolRecords(state).at(-1);
    return toolRecords(state).length === setup.length + 1 && (last?.status === 'completed' || last?.status === 'failed');
  }, 'recovery');
  return { before, state, sessionId, world: worldB, ledger: await readLedger(worldB, sessionId) };
}

/** The same calls, run cleanly in one process. */
async function cleanRun(calls: Call[]) {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-clean-')), recoverActiveRuns: false });
  worlds.push(world);
  const s = durableSessions({ world, harness: scripted(workspaceTools({ confirmMs: 10 })) });
  world.registerHandler(QUEUE_PREFIX, s.handler);
  const { sessionId } = await s.start();
  for (const c of calls) {
    await s.send(sessionId, JSON.stringify(c));
  }
  let state = await s.inspect(sessionId);
  await until(async () => {
    state = await s.inspect(sessionId);
    return toolRecords(state).length === calls.length && toolRecords(state).every((r) => r.status === 'completed');
  }, 'clean run');
  return state;
}

const seed: Call = { tool: 'write_file', input: { path: 'notes.txt', content: 'hello\n' } };

describe('a crash in the middle of a workspace tool, after it changed the workspace', () => {
  for (const call of [
    { tool: 'bash', input: { command: 'echo x >> notes.txt && touch made.txt && wc -l < notes.txt' } },
    { tool: 'edit_file', input: { path: 'notes.txt', oldText: 'hello', newText: 'hello world' } },
    { tool: 'write_file', input: { path: 'notes.txt', content: 'replaced\n' } },
  ] satisfies Call[]) {
    it(`${call.tool}: the retry produces exactly one clean run's result`, async () => {
      // Seed with a different tool (the crashed one hangs in process A).
      const first = call.tool === 'write_file' ? { tool: 'bash', input: { command: "printf 'hello\\n' > notes.txt" } } : seed;
      const { before, state } = await crashMidCall([first], call);
      // The first attempt changed the workspace and died before it reported:
      // its edit rides on the outcome it never wrote, so none of it is in the log...
      expect(before.docs.get(WorkspaceDoc.definition.kind)?.revision).toBe(1);
      expect(before.effectOrder.some((e) => e.name === 'fs')).toBe(false);
      expect(toolRecords(before).at(-1)?.status).toBe('running');
      // ...and the retry ran against the workspace as it was before it.
      const clean = await cleanRun([first, call]);
      const last = toolRecords(state).at(-1)!;
      expect(last.status).toBe('completed');
      expect(last.retryOf).toBeDefined();
      expect(last.output).toEqual(toolRecords(clean).at(-1)!.output);
      expect(filesFromState(state)).toEqual(filesFromState(clean));
      // One edit for the setup call, one for the retry: the interrupted attempt left none.
      expect(state.docs.get(WorkspaceDoc.definition.kind)?.revision).toBe(2);
    });
  }
});

describe('a crash in the middle of a large write, after its blob was written', () => {
  it('leaves an orphan blob and no manifest entry; the retry writes the file once', async () => {
    const content = `big\n${'y'.repeat(9000)}\n`;
    const call: Call = { tool: 'write_file', input: { path: 'big.txt', content } };
    // Seeded with bash: the crashed tool hangs in process A.
    const { before, state, sessionId, world } = await crashMidCall([{ tool: 'bash', input: { command: "printf 'hello\\n' > notes.txt" } }], call);
    const hash = await sha256Hex(content);
    // Before recovery: the blob is in the stream (written inside the call), the manifest does not name it.
    expect(workspaceManifest(before).map((f) => f.path)).toEqual(['/workspace/notes.txt']);
    const last = toolRecords(state).at(-1)!;
    expect(last.status).toBe('completed');
    expect(last.retryOf).toBeDefined();
    expect(workspaceManifest(state).find((f) => f.path === '/workspace/big.txt')).toMatchObject({ inline: false, hash });
    expect((await readWorkspace(world, state))['/workspace/big.txt']).toBe(content);
    expect((await readBlobs(world, sessionId)).has(hash)).toBe(true);
    // Two copies: the interrupted attempt's (an orphan nothing named until the retry) and the retry's own.
    expect((await world.streams.getChunks(sessionId, blobStreamName(sessionId), {})).data).toHaveLength(2);
    expect(state.docs.get(WorkspaceDoc.definition.kind)?.revision).toBe(2);
  });
});

describe('a crash in the middle of an unsafe tool, after its side effect', () => {
  it('is not rerun: one ledger record, and an interrupted result', async () => {
    const call: Call = { tool: 'unsafe_make_payment', input: { to: 'alice@example.com', amount_usd: 5, memo: 'demo' } };
    const { state, ledger } = await crashMidCall([], call, { confirmMs: 60_000 });
    const last = toolRecords(state).at(-1)!;
    expect(last.status).toBe('failed');
    expect(last.error).toMatchObject({ interrupted: true });
    expect(last.error?.message).toMatch(/not safe to rerun/);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ tool: 'unsafe_make_payment', callKey: last.key, input: call.input });
  });
});
