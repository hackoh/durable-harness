import { type DurableSessions, durableSessions, QUEUE_PREFIX, workflowNameFor } from 'harness-world';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { echoHarness } from '../scenarios/echo.ts';
import { jsonOf, listOf, type Target, workflow } from '../src/cli.ts';
import { eventCount, settled } from '../src/scenario.ts';
import { type OpenWorld, selectedWorlds, storageFor, worldSkipReason } from '../src/worlds.ts';

/**
 * The Workflow CLI's own rough edges (see the package README). One still open is pinned as a strict expected
 * failure (`it.fails`): when a CLI or World release fixes it, its test fails
 * until it moves to `it`. The fixed ones (vercel/workflow#4760, #4756) are
 * plain tests, so a regression shows. They are checked on a session of a
 * harness with no model (echoHarness).
 */

const WORKFLOW_NAME = workflowNameFor('cli-check-echo');
/** Turns in the long session: 7 events each, so past the CLI's 100-row page. */
const LONG_TURNS = 16;

for (const world of selectedWorlds()) {
  const skip = worldSkipReason(world);
  (skip ? describe.skip : describe)(`Workflow CLI quirks on world-${world}${skip ? ` (skipped: ${skip})` : ''}`, () => {
    let open: OpenWorld;
    let sessions: DurableSessions;
    let target: Target;
    let runId: string;
    let longRunId: string;
    let firstStepId: string;
    const rawStream = () => `${runId}_raw`;

    beforeAll(async () => {
      const storage = storageFor(world, 'quirks');
      target = storage.target;
      open = await storage.open();
      sessions = durableSessions({ world: open.world, harness: echoHarness() });
      await open.serve(QUEUE_PREFIX, sessions.handler);
      // A turn ends with its tool step.
      const turns = (n: number) => (s: { effectOrder: { name: string; status: string }[] }) => s.effectOrder.filter((e) => e.name === 'tool.echo' && e.status === 'completed').length >= n;

      ({ sessionId: runId } = await sessions.start({ prompt: 'hello' }));
      await settled(open.world, sessions, runId, turns(1));
      firstStepId = (await sessions.inspect(runId)).effectOrder[0]!.stepId;
      // A stream the CLI cannot decode (plain JSON lines), closed, to see what `inspect stream` does with it.
      await open.world.streams.write(runId, rawStream(), new TextEncoder().encode('{"type":"not devalue"}\n'));
      await open.world.streams.close(runId, rawStream());

      ({ sessionId: longRunId } = await sessions.start());
      for (let i = 0; i < LONG_TURNS; i++) {
        await sessions.send(longRunId, `turn ${i}`);
        await settled(open.world, sessions, longRunId, turns(i + 1), { quietMs: 200 });
      }
    }, 240_000);

    afterAll(async () => {
      for (const id of [runId, longRunId]) if (id) await sessions.close(id).catch(() => {});
      await open?.close();
    });

    it('lists the sessions under their full workflow name', async () => {
      const runs = listOf(await workflow(target, ['inspect', 'runs', '-n', WORKFLOW_NAME, '--limit', '100']));
      expect(runs.map((r) => r.runId)).toEqual(expect.arrayContaining([runId, longRunId]));
    });

    // Q1 is half fixed: --all (#4760) reads every page, but steps, events and sleeps still print a bare array (a page object is for the next major).
    it.fails('Q1: inspect steps --json prints a page cursor, as inspect runs does (it prints a bare array)', async () => {
      const value = jsonOf<unknown>(await workflow(target, ['inspect', 'steps', '-r', runId]));
      expect(value).toMatchObject({ cursor: expect.anything(), hasMore: expect.any(Boolean) });
    });

    it('Q1: inspect events --json --all reaches every event of a session longer than 100, and a short page names the next --cursor', async () => {
      const total = await eventCount(open.world, longRunId);
      expect(total).toBeGreaterThan(100);
      const all = listOf(await workflow(target, ['inspect', 'events', '-r', longRunId, '--limit', '100', '--all']));
      expect(all.length).toBe(total);
      const page = await workflow(target, ['inspect', 'events', '-r', longRunId, '--limit', '100']);
      expect(listOf(page).length).toBe(100);
      expect(page.stderr).toMatch(/--cursor \S+/);
    });

    it('Q2: inspect stream exits non-zero when it cannot decode a stream', async () => {
      const call = await workflow(target, ['inspect', 'stream', rawStream(), '-r', runId]);
      expect(call.stderr).toContain('Failed to read stream');
      expect(call.code).not.toBe(0);
    });

    it('Q3: the streams hint names --runId, and inspect stream <id> without it fails up front', async () => {
      const listing = await workflow(target, ['inspect', 'streams', '-r', runId], { json: false });
      expect(`${listing.stdout}${listing.stderr}`).toContain(`inspect stream <stream-id> --runId=${runId}`);
      const call = await workflow(target, ['inspect', 'stream', rawStream()]);
      expect(call.code).not.toBe(0);
      expect(call.stderr).toContain('needs --runId');
    });

    it('Q4: inspect event <id> -r shows one event, as the events hint suggests', async () => {
      const events = listOf(await workflow(target, ['inspect', 'events', '-r', runId, '--limit', '10']));
      const eventId = String(events[1]!.eventId);
      const call = await workflow(target, ['inspect', 'event', eventId, '-r', runId]);
      expect(call.code).toBe(0);
      expect(call.errors).toEqual([]);
      expect(jsonOf<{ eventId: string }>(call).eventId).toBe(eventId);
    });

    it('Q5: inspect runs -n accepts the short name the runs table shows', async () => {
      // The short name is the harness (`workflow//durable-harness@<version>//cli-check-echo`).
      const runs = listOf(await workflow(target, ['inspect', 'runs', '-n', 'cli-check-echo', '--limit', '100']));
      expect(runs.map((r) => r.runId)).toContain(runId);
    });

    it('Q6: inspect step <id> without -r says it needs --runId (it no longer looks in the most recent run)', async () => {
      const call = await workflow(target, ['inspect', 'step', firstStepId]);
      expect(call.code).not.toBe(0);
      expect(call.stderr).toContain('needs --runId');
      const scoped = await workflow(target, ['inspect', 'step', firstStepId, '-r', runId]);
      expect(jsonOf<{ stepId: string }>(scoped).stepId).toBe(firstStepId);
    });

    it('Q7: inspect steps --sort asc lists the oldest step first', async () => {
      const steps = listOf(await workflow(target, ['inspect', 'steps', '-r', longRunId, '--sort', 'asc', '--limit', '10']));
      const created = steps.map((s) => Date.parse(s.createdAt));
      expect(created).toEqual([...created].sort((a, b) => a - b));
    });
  });
}
