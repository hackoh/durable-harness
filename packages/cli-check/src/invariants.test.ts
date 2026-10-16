import { describe, expect, it } from 'vitest';
import { type CliCall, errorLines } from './cli.ts';
import { type Collected, evaluate, opaqueKind, type SessionExpect, type Truth } from './invariants.ts';
import { type KnownIssue, knownFor, partition } from './known.ts';

/** The checks themselves, on CLI output written by hand: no World, no CLI. */

const RUN = 'wrun_01TEST';
const call = (argv: string[], value: unknown, extra: Partial<CliCall> = {}): CliCall => ({
  argv,
  code: 0,
  stdout: value === undefined ? '' : JSON.stringify(value),
  stderr: '',
  ms: 1,
  timedOut: false,
  stoppedEarly: false,
  errors: [],
  ...extra,
});
const step = (stepId: string, name: string, at: number, extra: Record<string, unknown> = {}) => ({
  runId: RUN,
  stepId,
  stepName: `step//harness-world//${name}`,
  status: 'completed',
  input: { key: `${name}:${stepId}`, replay: 'safe', input: 'x', epoch: 0 },
  output: 'ok',
  createdAt: new Date(at).toISOString(),
  startedAt: new Date(at).toISOString(),
  completedAt: new Date(at + 1).toISOString(),
  ...extra,
});
const event = (n: number, eventType: string, correlationId?: string, eventData?: unknown) => ({
  eventId: `evnt_${String(n).padStart(26, '0')}`,
  eventType,
  runId: RUN,
  ...(correlationId ? { correlationId } : {}),
  ...(eventData ? { eventData } : {}),
  createdAt: new Date(1000 + n).toISOString(),
});

function session(overrides: { steps?: any[]; events?: any[]; hooks?: any[]; streams?: any[]; status?: string } = {}) {
  const steps = overrides.steps ?? [step('step_1', 'model', 1000), step('step_2', 'tool.shout', 1002)];
  const events = overrides.events ?? [
    event(1, 'run_created'),
    event(2, 'run_started'),
    event(3, 'hook_created', 'hook_1', { token: `harness:${RUN}:inbox` }),
    event(4, 'hook_received', 'hook_1', { payload: { kind: 'prompt', text: 'hi', nonce: 'n1' } }),
    event(5, 'step_created', 'step_1'),
    event(6, 'step_started', 'step_1'),
    event(7, 'step_completed', 'step_1'),
    event(8, 'step_created', 'step_2'),
    event(9, 'step_started', 'step_2'),
    event(10, 'step_completed', 'step_2'),
  ];
  const collected: Collected = {
    runId: RUN,
    phase: 'open',
    runs: call(['inspect', 'runs'], { data: [{ runId: RUN }], cursor: null, hasMore: false }),
    run: call(['inspect', 'run'], {
      runId: RUN,
      status: overrides.status ?? 'running',
      workflowName: 'workflow//harness-world//harness:test',
      input: { harness: 'test' },
      createdAt: new Date(1000).toISOString(),
      startedAt: new Date(1000).toISOString(),
    }),
    steps: call(['inspect', 'steps'], steps),
    stepDetails: [],
    events: call(['inspect', 'events'], events),
    hooks: call(['inspect', 'hooks'], { data: overrides.hooks ?? [{ token: `harness:${RUN}:inbox` }] }),
    streams: call(['inspect', 'streams'], overrides.streams ?? [{ runId: RUN, streamId: `${RUN}_live` }]),
    streamReads: [],
    broken: [],
  };
  const expect: SessionExpect = {
    workflowName: 'workflow//harness-world//harness:test',
    inputHarness: 'test',
    phase: 'open',
    submissions: 1,
    hookToken: `harness:${RUN}:inbox`,
    calls: ['model', 'tool.shout'],
    callsMatch: 'exact',
    vocabulary: /^(model|tool\..+)$/,
    hookPayload: 'submission',
  };
  const truth: Truth = {
    steps: steps.map((s) => ({ stepId: s.stepId, stepName: s.stepName, status: s.status })),
    eventCount: events.length,
    streams: (overrides.streams ?? [{ streamId: `${RUN}_live` }]).map((s: { streamId: string }) => s.streamId),
  };
  return { collected, expect, truth };
}

describe('evaluate', () => {
  it('finds nothing wrong with a session the CLI shows as expected', () => {
    const { collected, expect: want, truth } = session();
    expect(evaluate(collected, want, truth).findings).toEqual([]);
  });

  it('judges the call sequence in creation order and reports a listing that is not', () => {
    const { collected, expect: want, truth } = session({ steps: [step('step_2', 'tool.shout', 1002), step('step_1', 'model', 1000)] });
    const codes = evaluate(collected, want, truth).findings.map((f) => f.code);
    expect(codes).toEqual(['sort-order']);
  });

  it('reports a JSON-text hook payload, an unsettled step and a missing step', () => {
    const { collected, expect: want, truth } = session({
      steps: [step('step_1', 'model', 1000, { status: 'running' })],
      events: [event(1, 'run_created'), event(4, 'hook_received', 'hook_1', { payload: '{"v":1,"writes":[]}' })],
    });
    truth.steps!.push({ stepId: 'step_9', stepName: 'step//harness-world//model', status: 'completed' });
    const codes = evaluate(collected, want, truth).findings.map((f) => `${f.invariant}/${f.code}`);
    expect(codes).toEqual(expect.arrayContaining(['steps/unsettled', 'payloads/string-payload', 'agree/step-missing', 'steps/calls']));
  });

  it('reports a closed session that is still running and still has its hook', () => {
    const { collected, expect: want, truth } = session();
    const codes = evaluate(collected, { ...want, phase: 'closed' }, truth).findings.map((f) => `${f.invariant}/${f.code}`);
    expect(codes).toEqual(expect.arrayContaining(['status/status', 'status/completed-at', 'hooks/disposed', 'events/run-completed']));
  });

  it('reports streams that fail to decode, and one that does not end once closed', () => {
    const { collected, expect: want, truth } = session({ streams: [{ streamId: `${RUN}_live` }, { streamId: `${RUN}_step_1` }] });
    collected.streamReads = [
      { streamId: `${RUN}_live`, mustEnd: true, call: call(['inspect', 'stream'], undefined), chunks: [], decodeError: 'Error: Invalid input' },
      { streamId: `${RUN}_step_1`, mustEnd: true, call: call(['inspect', 'stream'], undefined, { timedOut: true, code: null, ms: 10_000 }), chunks: [{ a: 1 }] },
    ];
    const findings = evaluate(collected, { ...want, phase: 'closed' }, truth).findings.filter((f) => f.invariant === 'streams-read');
    expect(findings.map((f) => f.code).sort()).toEqual(['not-closed', 'stream-decode']);
  });
});

describe('opaqueKind', () => {
  it('tells unreadable values from readable ones', () => {
    expect(opaqueKind('devl["x"]', true)).toBe('devalue-text');
    expect(opaqueKind('{"a":1}', true)).toBe('json-text');
    expect(opaqueKind('{"a":1}', false)).toBeUndefined();
    expect(opaqueKind('A'.repeat(300), false)).toBe('base64');
    expect(opaqueKind({ type: 'Buffer', data: [1, 2] }, false)).toBe('bytes');
    expect(opaqueKind(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), i])), false)).toBe('bytes');
    expect(opaqueKind('hello { world', true)).toBeUndefined();
    expect(opaqueKind({ text: 'hi' }, true)).toBeUndefined();
  });
});

describe('errorLines', () => {
  it("ignores the CLI's chatter and keeps errors and stack frames", () => {
    const stderr = ['[Debug] Initializing world', '┌──────┐', '│ Workflow CLI │', '[Warn] something', '[Error] Error: Step not found', '    at foo (bar.js:1:1)', 'plain line'].join('\n');
    expect(errorLines(stderr)).toEqual(['[Error] Error: Step not found', '    at foo (bar.js:1:1)']);
  });
});

describe('known issues', () => {
  const known: KnownIssue[] = [
    { invariant: 'payloads', scenario: ['a', 'b'], world: '*', codes: ['base64'], reason: 'r', owner: 'ours' },
    { invariant: 'payloads', scenario: '*', world: 'postgres', phase: 'closed', codes: ['bytes'], reason: 'r2', owner: 'workflow' },
    { invariant: 'payloads', scenario: '*', world: '*', codes: ['x'], reason: 'never', owner: 'ours', when: () => false },
  ];
  it('match by scenario, World and phase, and only while their condition holds', () => {
    expect(knownFor('payloads', { scenario: 'a', world: 'local', label: 'basic', phase: 'open' }, known).map((k) => k.reason)).toEqual(['r']);
    expect(knownFor('payloads', { scenario: 'c', world: 'postgres', label: 'basic', phase: 'closed' }, known).map((k) => k.reason)).toEqual(['r2']);
    expect(knownFor('steps', { scenario: 'a', world: 'local', label: 'basic', phase: 'open' }, known)).toEqual([]);
  });
  it('cover only their own codes', () => {
    const findings = [
      { invariant: 'payloads' as const, code: 'base64', message: 'm' },
      { invariant: 'payloads' as const, code: 'json-text', message: 'm' },
    ];
    const { covered, unexpected } = partition(findings, [known[0]!]);
    expect(covered.map((f) => f.code)).toEqual(['base64']);
    expect(unexpected.map((f) => f.code)).toEqual(['json-text']);
  });
});
