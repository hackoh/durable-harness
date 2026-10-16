import { describe, expect, it } from 'vitest';
import aiSdk from './fixtures/ai-sdk-crashes.json' with { type: 'json' };
import opencode from './fixtures/opencode-crashes.json' with { type: 'json' };
import { crashes, laneOf, stepTimes } from './lanes.ts';
import { compactArgs, docText, exitCode, toolSummary, unwrapCommand, workspacePath } from './tools.ts';
import { buildItems, type Item, kindWidth } from './Transcript.tsx';
import type { EventView, SessionView } from './view.ts';

/** A fixture's rows, the page's way: lanes, step times, crashes, then the transcript. */
function rows(fixture: { view: unknown; events: unknown[] }) {
  const view = fixture.view as SessionView;
  const events = (fixture.events as Omit<EventView, 'index'>[]).map((e, i) => ({ ...e, index: i + 1 }));
  const lanes = laneOf(view.effects, 'server');
  const times = stepTimes(events);
  const list = crashes(view, lanes, times, 'server');
  return { items: buildItems(view, lanes, list), list };
}

const label = (i: Item) => (i.t === 'user' ? `user:${i.text.slice(0, 12)}` : i.t === 'crash' ? `crash:${i.crash?.state}` : `${i.t}:${i.effect.name}`);

describe('transcript rows: the AI SDK on the kernel, three crashes (production)', () => {
  const { items, list } = rows(aiSdk);

  it('reads each crash the way it ended: a rerun step, an unsafe tool, a model call', () => {
    expect(list.map((c) => c.state)).toEqual(['replayed', 'interrupted', 'replayed']);
  });

  it('puts the crash row before a step that was run again (its row shows the rerun), and after one left interrupted', () => {
    const seq = items.map(label);
    const bash = seq.indexOf('crash:replayed');
    expect(seq.slice(bash, bash + 2)).toEqual(['crash:replayed', 'tool:tool.bash']);
    const pay = seq.indexOf('tool:tool.unsafe_make_payment');
    expect(seq[pay + 1]).toBe('crash:interrupted');
    // The model call the third crash killed was run again: its reply follows the crash row.
    const last = seq.lastIndexOf('crash:replayed');
    expect(seq[last + 1]).toBe('model:model');
  });

  it('folds a model call that only asked for tools into the tool row it asked for', () => {
    const bashRow = items.find((i): i is Extract<Item, { t: 'tool' }> => i.t === 'tool' && i.effect.name === 'tool.bash');
    expect(bashRow?.model?.name).toBe('model');
    // No row reads "Called bash" on its own.
    expect(items.filter((i) => i.t === 'model' && !i.effect.output?.text && !(i.effect.output?.content ?? []).some((c: { type?: string }) => c.type === 'text'))).toEqual([]);
  });
});

describe('transcript rows: a view that keeps a model call and its tool apart', () => {
  it('folds a text-less model call into the tool row right after it, even without tool calls it can read', () => {
    const fx = (key: string, name: string, output: unknown) => ({ key, stepId: key, name, status: 'completed', attempt: 1, input: {}, output, placed: [] });
    const view = {
      id: 's',
      submissions: [],
      effects: [fx('m1', 'model', { finishReason: 'tool-calls' }), fx('t1', 'tool.bash', 'ok'), fx('m2', 'model', { text: 'done' })],
    } as unknown as SessionView;
    const items = buildItems(view, new Map(), []);
    expect(items.map(label)).toEqual(['tool:tool.bash', 'model:model']);
    expect(items[0]!.t === 'tool' && items[0]!.model?.key).toBe('m1');
  });
});

describe('transcript rows: OpenCode, its notes and three crashes (production)', () => {
  const { items } = rows(opencode);

  it('hides the environment notes, folds each recovery note into the crash row it follows, and keeps the rest as one-line rows', () => {
    const notes = items.filter((i) => i.t === 'note');
    expect(notes.every((n) => n.t === 'note' && n.synthetic === 'recovery')).toBe(true);
    const crashRows = items.filter((i): i is Extract<Item, { t: 'crash' }> => i.t === 'crash');
    expect(crashRows.length).toBe(3);
    expect(crashRows.every((c) => typeof c.told === 'string' && c.told.length > 40)).toBe(true);
    // Two recovery notes came with no crash row (a turn on a new instance): they stay, as notes.
    expect(notes.length).toBe(2);
  });

  it('keeps every prompt in log order', () => {
    const prompts = items.filter((i) => i.t === 'user' && !i.steer).map((i) => (i.t === 'user' ? i.text : ''));
    const subs = (opencode.view as SessionView).submissions.filter((s) => s.kind === 'prompt').map((s) => s.text);
    expect(prompts).toEqual(subs);
  });
});

describe('tool summaries', () => {
  it('says what each family of tools did, whatever the harness calls it', () => {
    expect(toolSummary('bash', { command: 'sleep 8 && date > slow.txt' })).toEqual({ kind: 'command', text: 'sleep 8 && date > slow.txt' });
    expect(toolSummary('Bash', { command: 'cat /Users/me/app/.sessions/wrun_1/workspace/slow.txt', description: 'Show it' }).text).toBe('cat slow.txt');
    expect(toolSummary('shell', { command: "/bin/bash -lc 'pwd && ls'", cwd: '/tmp/s/workspace' }).text).toBe('pwd && ls');
    expect(toolSummary('shell', { request: { action: 'run', command: 'sleep 8 && date > slow.txt' } })).toEqual({ kind: 'command', text: 'sleep 8 && date > slow.txt' });
    expect(toolSummary('write_file', { path: 'notes.md', content: 'héllo' })).toEqual({ kind: 'write', text: 'Wrote notes.md (6 bytes)', path: 'notes.md' });
    expect(toolSummary('Write', { file_path: '/srv/.sessions/wrun_2/workspace/notes.md', content: 'hi' }).text).toBe('Wrote notes.md (2 bytes)');
    expect(toolSummary('read', { filePath: '/workspace/a/b.txt' })).toEqual({ kind: 'read', text: 'Read a/b.txt', path: 'a/b.txt' });
    expect(toolSummary('Edit', { file_path: 'notes.md', old_string: 'a', new_string: 'b' }).text).toBe('Edited notes.md');
    expect(toolSummary('unsafe_make_payment', { to: 'alice@example.com', amount_usd: 5, memo: 'demo' }).text).toBe('to: alice@example.com, amount_usd: 5, memo: demo');
    expect(toolSummary('read_todos', {})).toEqual({ kind: 'doc', text: 'Read todos', reads: true });
    expect(toolSummary('update_todos', { value: '{"items":["ship it"]}', expectRevision: 0 }).text).toBe('Set todos: ship it');
    expect(docText('{"revision":1,"value":{"items":["ship it","test"]}}')).toBe('ship it\ntest');
    expect(docText('{"revision":0,"value":{"items":[]}}')).toBe('(empty)');
  });

  it('reads exit codes, and keeps the session-relative part of a path', () => {
    expect(exitCode('exit code: 1\nstderr:\nnope')).toBe(1);
    expect(exitCode('exit code 127\n/bin/bash: find: command not found')).toBe(127);
    expect(exitCode('hello')).toBeUndefined();
    expect(workspacePath('/tmp/harness-sessions/wrun_1/workspace/x/y.md')).toBe('x/y.md');
    expect(workspacePath('notes.md')).toBe('notes.md');
    expect(unwrapCommand("/bin/sh -c 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(compactArgs({ description: 'skip', n: 1 })).toBe('n: 1');
  });
});

describe('the kind column', () => {
  const tool = (name: string) => ({ t: 'tool', key: name, effect: { name } }) as unknown as Item;
  it('fits the harness name, and a tool name set in Mono, up to a limit', () => {
    expect(kindWidth('Pi', [])).toBe(5);
    expect(kindWidth('Claude Code', [])).toBe(11);
    expect(kindWidth('Pi', [tool('tool.update_todos')])).toBe(10);
    expect(kindWidth('Pi', [tool('tool.unsafe_make_payment')])).toBe(16);
    expect(kindWidth('Pi', [tool('tool.a_very_long_tool_name_from_some_mcp_server')])).toBe(18);
  });
});
