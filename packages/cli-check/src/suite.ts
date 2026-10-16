import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collect, type Evaluation, evaluate, INVARIANTS, type Phase } from './invariants.ts';
import { KNOWN, knownFor, partition } from './known.ts';
import { type CellReport, type SessionReport, writeFragment } from './report.ts';
import type { Scenario, ScenarioRun } from './scenario.ts';
import { outDir, selectedWorlds, storageFor, type WorldName, worldSkipReason } from './worlds.ts';

/**
 * One test file per scenario: for each selected World and each of the
 * scenario's sessions, drive the session (open), inspect it with the CLI,
 * close it, inspect it again, and turn every invariant into a test. A known
 * issue (known.ts) becomes an `it.fails` naming its reason, next to a plain
 * test that the invariant has no other findings.
 */

const PHASES: Phase[] = ['open', 'closed'];
/** How long a session may take to drive and settle, and the CLI to inspect it twice. */
const SESSION_TIMEOUT_MS = 480_000;

export function defineCliCheck(scenario: Scenario): void {
  const nonBlockingOff = !scenario.blocking && process.env.CLI_CHECK_NONBLOCKING !== '1';
  for (const world of selectedWorlds()) {
    const skip =
      worldSkipReason(world) ??
      scenario.skip?.() ??
      (nonBlockingOff ? 'a non-blocking scenario: set CLI_CHECK_NONBLOCKING=1 to run it' : undefined);
    const cell: CellReport = { scenario: scenario.name, title: scenario.title, world, blocking: scenario.blocking, sessions: [] };
    if (skip) {
      describe.skip(`${scenario.title} on world-${world} (skipped: ${skip})`, () => {
        it('is skipped', () => {});
      });
      // Only a skip for this machine is worth reporting; a World nobody selected is not.
      cell.skipped = skip;
      writeFragment(outDir(), cell);
      continue;
    }
    describe(`${scenario.title} on world-${world}`, () => {
      afterAll(() => writeFragment(outDir(), cell));
      for (const spec of scenario.sessions) {
        const why = spec.skip?.();
        if (why) {
          describe.skip(`${spec.label} session (skipped: ${why})`, () => {
            it('is skipped', () => {});
          });
          cell.sessions.push({ label: spec.label, phase: 'open', findings: [], error: `skipped: ${why}` });
          continue;
        }
        defineSession(scenario, world, spec.label, spec.run, cell);
      }
    });
  }
}

function defineSession(scenario: Scenario, world: WorldName, label: string, drive: Scenario['sessions'][number]['run'], cell: CellReport) {
  describe(`${label} session`, () => {
    const results: Partial<Record<Phase, Evaluation>> = {};
    const reports: Partial<Record<Phase, SessionReport>> = {};
    let run: ScenarioRun | undefined;
    let failure: unknown;

    beforeAll(async () => {
      const storage = storageFor(world, `${scenario.name}-${label}`);
      const target = storage.target.world === 'local' ? storage.target.dataDir : storage.target.world;
      try {
        run = await drive(storage);
        const s = run.session;
        for (const phase of PHASES) {
          if (phase === 'closed') {
            if (!s.close) {
              results.closed = { findings: [{ invariant: 'status', code: 'no-close', message: 'the harness has no way to close a session (no run_completed)' }], observed: undefined as never };
              break;
            }
            await s.close();
          }
          const truth = await s.truth();
          const collected = await collect(storage.target, s.runId, phase, { workflowName: s.expect.workflowName, ...(truth.streamChunks ? { streamChunks: truth.streamChunks } : {}) });
          results[phase] = evaluate(collected, { ...s.expect, phase }, truth);
        }
      } catch (err) {
        failure = err;
      } finally {
        for (const phase of PHASES) {
          const r = results[phase];
          const report: SessionReport = {
            label,
            phase,
            ...(run ? { runId: run.session.runId } : {}),
            target,
            ...(r?.observed ? { observed: r.observed } : {}),
            findings: (r?.findings ?? []).map((f) => {
              const k = knownFor(f.invariant, { scenario: scenario.name, world, label, phase }).find((x) => x.codes.includes(f.code));
              return k ? { ...f, known: k.reason } : f;
            }),
            ...(failure ? { error: String(failure instanceof Error ? (failure.stack ?? failure.message) : failure).slice(0, 2000) } : {}),
          };
          reports[phase] = report;
          cell.sessions.push(report);
        }
      }
    }, SESSION_TIMEOUT_MS);

    afterAll(async () => {
      await run?.dispose().catch(() => {});
    });

    it('drives the session and inspects it with the CLI', () => {
      if (failure) throw failure;
    });

    for (const phase of PHASES) {
      for (const inv of INVARIANTS) {
        const known = knownFor(inv.id, { scenario: scenario.name, world, label, phase }, KNOWN);
        const name = `${phase}: ${inv.id}: ${inv.title}`;
        const findingsOf = () => {
          if (failure) throw new Error('the session did not run (see the first test)');
          const r = results[phase];
          if (!r) throw new Error(`no ${phase} inspection`);
          return r.findings.filter((f) => f.invariant === inv.id);
        };
        // A harness with no close path has no closed session to inspect (the `status` test says so).
        const noClosedSession = () => phase === 'closed' && inv.id !== 'status' && !!results.closed?.findings.some((f) => f.code === 'no-close');
        it(name, (ctx) => {
          if (noClosedSession()) ctx.skip();
          const { unexpected } = partition(findingsOf(), known);
          expect(unexpected.map((f) => `[${f.code}] ${f.message}`)).toEqual([]);
        });
        for (const k of known.filter((x) => !x.intermittent)) {
          it.fails(`${name}: known (${k.owner === 'workflow' ? 'Workflow' : 'ours'}): ${k.reason}`, (ctx) => {
            if (noClosedSession()) ctx.skip();
            const covered = findingsOf().filter((f) => k.codes.includes(f.code));
            expect(covered.map((f) => `[${f.code}] ${f.message}`)).toEqual([]);
          });
        }
      }
    }
  });
}
