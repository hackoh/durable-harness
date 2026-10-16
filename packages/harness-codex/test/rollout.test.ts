import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EffectRecord, SessionState, Submission } from 'harness-world';
import { owedSubmissions, recoveryClientId, repairOutput } from '../src/harness.ts';
import { BUILTINS_OFF, codexConfig, toToml } from '../src/config.ts';
import { endsTurn, hasCall, isSessionMeta, relativeRolloutPath, rolloutText, summarizeRollout } from '../src/rollout.ts';

/**
 * The rollout mirror's pure parts, on rollouts Codex 0.160.0 wrote
 * (`fixtures/`): a turn with one dynamic tool call through the AI Gateway,
 * and the two prefixes a crash leaves (Codex writes completed items only,
 * line by line): mid model stream, and mid tool call.
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const linesOf = (text: string) => text.split('\n').filter(Boolean);
const THREAD = '01a112ed-6d63-7283-936e-ee25f0fc9794';
const CALL = 'call_jPhux2a8Xx4z3qtNmDAOplZp';

describe('the rollout', () => {
  it('restores byte for byte from its lines', () => {
    for (const name of ['turn-with-tool.jsonl', 'crash-mid-tool.jsonl', 'crash-mid-stream.jsonl']) {
      const text = fixture(name);
      expect(rolloutText(linesOf(text))).toBe(text);
    }
  });

  it('a completed turn: the thread, the call and its output, the client id, idle', () => {
    const lines = linesOf(fixture('turn-with-tool.jsonl'));
    expect(isSessionMeta(lines[0])).toBe(true);
    expect(isSessionMeta(lines[1])).toBe(false);
    const s = summarizeRollout(lines);
    expect(s.threadId).toBe(THREAD);
    expect(s.calls).toEqual([{ callId: CALL, name: 'write_file', arguments: '{"content":"hi","path":"notes.txt"}', answered: true, line: 10 }]);
    expect(s.dangling).toEqual([]);
    expect(s.clientIds).toEqual(new Set(['sub_1']));
    expect(s).toMatchObject({ turnsStarted: 1, turnsEnded: 1, idle: true, lastTurn: 'completed', lastAgentMessage: 'DONE' });
    expect(s.lastTurnClientIds).toEqual(new Set(['sub_1']));
    expect(hasCall(lines, CALL)).toBe(true);
    expect(hasCall(lines, 'call_nope')).toBe(false);
    expect(lines.filter(endsTurn)).toHaveLength(1);
  });

  it('a crash mid tool call: the call dangles and the turn is open', () => {
    const s = summarizeRollout(linesOf(fixture('crash-mid-tool.jsonl')));
    expect(s.dangling.map((c) => c.callId)).toEqual([CALL]);
    expect(s).toMatchObject({ turnsStarted: 1, turnsEnded: 0, idle: false });
    expect(s.lastAgentMessage).toBeUndefined();
    expect(s.lastTurn).toBeUndefined();
  });

  it('an aborted last turn is not a completed one', () => {
    const lines = linesOf(fixture('turn-with-tool.jsonl'));
    const aborted = JSON.stringify({ timestamp: '2026-10-06T20:36:00.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' } });
    const started = JSON.stringify({ timestamp: '2026-10-06T20:35:59.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } });
    const s = summarizeRollout([...lines, started, aborted]);
    expect(s).toMatchObject({ turnsStarted: 2, turnsEnded: 2, idle: true, lastTurn: 'aborted' });
    expect(s.lastAgentMessage).toBeUndefined();
    expect(s.lastTurnClientIds).toEqual(new Set());
  });

  it('a crash mid model stream: only the user message, nothing partial', () => {
    const s = summarizeRollout(linesOf(fixture('crash-mid-stream.jsonl')));
    expect(s.calls).toEqual([]);
    expect(s.clientIds).toEqual(new Set(['sub_1']));
    expect(s.idle).toBe(false);
  });

  it('keeps the file name pattern Codex resumes by', () => {
    expect(relativeRolloutPath(`/private/tmp/x/home/.codex/sessions/2026/10/06/rollout-2026-10-06T13-35-12-${THREAD}.jsonl`, THREAD)).toBe(
      `sessions/2026/10/06/rollout-2026-10-06T13-35-12-${THREAD}.jsonl`
    );
    // Anything else gets a canonical name of its own (Codex refuses others).
    const fallback = `sessions/rollout-1970-01-01T00-00-00-${THREAD}.jsonl`;
    expect(relativeRolloutPath('', THREAD)).toBe(fallback);
    expect(relativeRolloutPath(`/x/sessions/../../etc/rollout-2026-10-06T13-35-12-${THREAD}.jsonl`, THREAD)).toBe(fallback);
    expect(relativeRolloutPath(`/x/sessions/rollout-x-${THREAD}.jsonl`, THREAD)).toBe(fallback);
    expect(relativeRolloutPath(`/x/sessions/rollout-2026-10-06T13-35-12-other.jsonl`, THREAD)).toBe(fallback);
  });
});

const sub = (id: string, kind: Submission['kind'], text: string): Submission => ({ id, kind, text, receivedAt: new Date(0) });
const effect = (key: string, e: Partial<EffectRecord>): EffectRecord => ({ key, stepId: `step_${key}`, name: 'tool.x', replay: 'never', input: {}, status: 'running', attempt: 1, placed: [], ...e });
const stateWith = (effects: EffectRecord[], submissions: Submission[] = []): SessionState =>
  ({ effects: new Map(effects.map((e) => [e.key, e])), effectOrder: effects, submissions }) as unknown as SessionState;
const call = { callId: 'c1', name: 'x', arguments: '{}', answered: false, line: 0 };

describe('dangling-call repair', () => {
  it('injects what the log knows about the call', () => {
    expect(repairOutput(stateWith([effect('tool:c1', { status: 'completed', output: 'paid' })]), call)).toBe('paid');
    expect(repairOutput(stateWith([]), call)).toMatch(/^Not executed/);
    const interrupted = repairOutput(
      stateWith([effect('tool:c1', { status: 'failed', error: { message: 'Interrupted: the process running this call stopped. It may or may not have taken effect.', interrupted: true, partial: [{ phase: 'confirming' }] } })]),
      call
    );
    expect(interrupted).toContain('may or may not have taken effect');
    expect(interrupted).toContain('confirming');
    expect(repairOutput(stateWith([effect('tool:c1', { status: 'failed', replay: 'safe', error: { message: 'x', interrupted: true } })]), call)).toMatch(/safe to repeat/);
    expect(repairOutput(stateWith([effect('tool:c1', { status: 'failed', error: { message: 'no such file' } })]), call)).toBe('no such file');
  });

  it('owes the placed submissions Codex never recorded', () => {
    const subs = [sub('a', 'prompt', 'first'), sub('b', 'steer', 'second'), sub('c', 'followUp', 'third')];
    const state = stateWith([], subs);
    expect(owedSubmissions(state, ['a', 'b', 'c'], new Set(['a'])).map((s) => s.id)).toEqual(['b', 'c']);
    expect(owedSubmissions(state, ['a'], new Set(['a']))).toEqual([]);
  });

  it('counts the submissions a recovery note carried as recorded', () => {
    const subs = [sub('a', 'prompt', 'first'), sub('b', 'steer', 'second'), sub('c', 'followUp', 'third')];
    const state = stateWith([], subs);
    expect(recoveryClientId(2, [subs[1]!, subs[2]!])).toBe('recover:2:b,c');
    expect(recoveryClientId(0, [])).toBe('recover:0');
    expect(owedSubmissions(state, ['a', 'b', 'c'], new Set(['a', 'recover:2:b,c']))).toEqual([]);
    expect(owedSubmissions(state, ['a', 'b', 'c'], new Set(['a', 'recover:0'])).map((s) => s.id)).toEqual(['b', 'c']);
  });
});

describe('config.toml', () => {
  it('routes the model to the Gateway proxy and turns the built-ins off', () => {
    const text = toToml(codexConfig({ model: 'openai/gpt-5.4-mini', baseUrl: 'http://127.0.0.1:1234/v1', envKey: 'KEY', contextWindow: 272000, extra: { features: { goals: true }, model_reasoning_effort: 'low' } }));
    expect(text).toContain('model = "openai/gpt-5.4-mini"\nmodel_provider = "gateway"\nmodel_context_window = 272000\n');
    expect(text).toContain('[model_providers.gateway]\nname = "AI Gateway"\nbase_url = "http://127.0.0.1:1234/v1"\nenv_key = "KEY"\nwire_api = "responses"\nsupports_websockets = false\n');
    expect(text).toContain('[features]\nshell_tool = false\nunified_exec = false\n');
    expect(text).toContain('goals = true');
    expect(text).toContain('model_reasoning_effort = "low"');
    expect(Object.keys(BUILTINS_OFF)).toEqual(expect.arrayContaining(['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'plugins', 'apps']));
  });
});
