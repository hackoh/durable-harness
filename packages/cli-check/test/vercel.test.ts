import { workflowNameFor } from 'harness-world/names';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WRITE_PROMPT, PROCESS_VOCABULARY } from '../scenarios/process.ts';
import type { Target } from '../src/cli.ts';
import { collect, type Evaluation, evaluate, INVARIANTS, type Phase, type SessionExpect, type Truth } from '../src/invariants.ts';
import { knownFor, partition } from '../src/known.ts';
import { type CellReport, writeFragment } from '../src/report.ts';
import { until } from '../src/scenario.ts';
import { outDir } from '../src/worlds.ts';

/**
 * world-vercel, through a deployment of apps/demo: the CLI cannot write to
 * world-vercel from CI (sessions need a deployment's OIDC identity), so this
 * drives a session of the demo's `reference` harness (a scripted CLI: no
 * model, no cost) over the demo's own API, then inspects it with
 * `workflow inspect -b vercel` and checks the same invariants.
 *
 * Runs only with a deployment and a token:
 *
 *   CLI_CHECK_VERCEL_URL=https://<deployment>   the demo
 *   VERCEL_TOKEN=…                              read access to the project (workflow inspect -a)
 *   VERCEL_AUTOMATION_BYPASS_SECRET=…           when the deployment is protected
 *   CLI_CHECK_VERCEL_PROJECT, CLI_CHECK_VERCEL_TEAM  the deployment's Vercel project and team
 *   CLI_CHECK_VERCEL_ENV                        default preview
 */

const url = process.env.CLI_CHECK_VERCEL_URL?.replace(/\/+$/, '');
const token = process.env.VERCEL_TOKEN;
const project = process.env.CLI_CHECK_VERCEL_PROJECT;
const team = process.env.CLI_CHECK_VERCEL_TEAM;
const missing = !url
  ? 'CLI_CHECK_VERCEL_URL (a deployment of apps/demo)'
  : !token
    ? 'VERCEL_TOKEN'
    : !project || !team
      ? 'CLI_CHECK_VERCEL_PROJECT and CLI_CHECK_VERCEL_TEAM'
      : undefined;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}), ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** What GET /api/sessions/:id answers (harness-world-demo-ui's sessionView), as far as this reads it. */
interface View {
  status: string;
  eventCount: number;
  turnOpen?: boolean;
  submissions: { id: string; placed: boolean }[];
  effects: { stepId: string; name: string; status: string }[];
}

const settledView = (view: View, prompts: number) =>
  view.submissions.length >= prompts &&
  view.submissions.every((s) => s.placed) &&
  view.turnOpen === false &&
  !view.effects.some((e) => e.status === 'pending' || e.status === 'running');

async function settle(runId: string, prompts: number): Promise<View> {
  let view = await until(async () => {
    const v = await api<View>(`/api/sessions/${runId}`);
    return settledView(v, prompts) ? v : undefined;
  }, 180_000, `${runId} to settle on the deployment`);
  // Quiet: the event count holds for a few seconds.
  for (let stable = 0; stable < 3; ) {
    await new Promise((r) => setTimeout(r, 1000));
    const next = await api<View>(`/api/sessions/${runId}`);
    stable = next.eventCount === view.eventCount ? stable + 1 : 0;
    view = next;
  }
  return view;
}

const truthOf = (view: View): Truth => ({
  eventCount: view.eventCount,
  kernel: { effects: view.effects.map((e) => ({ stepId: e.stepId, name: e.name, status: e.status })), ignored: [] },
});

(missing ? describe.skip : describe)(`Reference process harness on world-vercel${missing ? ` (skipped: needs ${missing})` : ''}`, () => {
  const target: Target = {
    world: 'vercel',
    project: project ?? '',
    team: team ?? '',
    environment: process.env.CLI_CHECK_VERCEL_ENV ?? 'preview',
    token: token ?? '',
  };
  const results: Partial<Record<Phase, Evaluation>> = {};
  const cell: CellReport = { scenario: 'reference', title: 'Reference process harness (through the demo)', world: 'vercel', blocking: false, sessions: [] };
  let runId: string | undefined;
  let failure: unknown;

  beforeAll(async () => {
    try {
      ({ sessionId: runId } = await api<{ sessionId: string }>('/api/sessions', { method: 'POST', body: JSON.stringify({ harness: 'reference', prompt: WRITE_PROMPT }) }));
      await settle(runId, 1);
      await api(`/api/sessions/${runId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
      let view = await settle(runId, 2);
      const expect: Omit<SessionExpect, 'phase'> = {
        workflowName: workflowNameFor('reference'),
        inputHarness: 'reference',
        submissions: 2,
        hookToken: `harness:${runId}:inbox`,
        calls: ['tool.write_file'],
        callsMatch: 'subsequence',
        callPattern: /^tool\./,
        vocabulary: PROCESS_VOCABULARY,
        hookPayload: 'submission',
      };
      for (const phase of ['open', 'closed'] as const) {
        if (phase === 'closed') {
          await api(`/api/sessions/${runId}`, { method: 'DELETE' });
          view = await api<View>(`/api/sessions/${runId}`);
        }
        const collected = await collect(target, runId, phase, { workflowName: expect.workflowName });
        results[phase] = evaluate(collected, { ...expect, phase }, truthOf(view));
      }
    } catch (err) {
      failure = err;
    } finally {
      for (const phase of ['open', 'closed'] as const) {
        cell.sessions.push({
          label: 'basic',
          phase,
          ...(runId ? { runId } : {}),
          ...(results[phase]?.observed ? { observed: results[phase]!.observed } : {}),
          findings: (results[phase]?.findings ?? []).map((f) => {
            const k = knownFor(f.invariant, { scenario: 'reference', world: 'vercel', label: 'basic', phase }).find((x) => x.codes.includes(f.code));
            return k ? { ...f, known: k.reason } : f;
          }),
          ...(failure ? { error: String(failure) } : {}),
        });
      }
    }
  }, 600_000);

  afterAll(() => writeFragment(outDir(), cell));

  it('drives a session through the deployment and inspects it with the CLI', () => {
    if (failure) throw failure;
  });

  for (const phase of ['open', 'closed'] as const) {
    for (const inv of INVARIANTS) {
      const known = knownFor(inv.id, { scenario: 'reference', world: 'vercel', label: 'basic', phase });
      it(`${phase}: ${inv.id}: ${inv.title}`, () => {
        if (failure) throw new Error('the session did not run (see the first test)');
        const findings = (results[phase]?.findings ?? []).filter((f) => f.invariant === inv.id);
        expect(partition(findings, known).unexpected.map((f) => `[${f.code}] ${f.message}`)).toEqual([]);
      });
      for (const k of known.filter((x) => !x.intermittent)) {
        it.fails(`${phase}: ${inv.id}: known (${k.owner === 'workflow' ? 'Workflow' : 'ours'}): ${k.reason}`, () => {
          const findings = (results[phase]?.findings ?? []).filter((f) => f.invariant === inv.id && k.codes.includes(f.code));
          expect(findings).toEqual([]);
        });
      }
    }
  }
});
