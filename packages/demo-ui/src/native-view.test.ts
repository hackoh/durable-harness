import { describe, expect, it } from 'vitest';
import { NativeFold } from './native-view.ts';

describe('NativeFold', () => {
  it('streams into a running model effect, then completes it', () => {
    const f = new NativeFold('n1', 'pi');
    const sub = f.submit('hi');
    expect(f.view().submissions[0]).toMatchObject({ placed: false });
    f.begin([sub]);
    let v = f.view();
    expect(v.status).toBe('running');
    expect(v.effects).toHaveLength(1);
    expect(v.effects[0]).toMatchObject({ name: 'model', status: 'running', placed: [sub] });
    f.event({ type: 'text', delta: 'He' });
    f.event({ type: 'text', delta: 'llo' });
    expect(f.view().effects[0]!.output).toEqual({ text: 'Hello' });
    f.event({ type: 'idle' });
    v = f.view();
    expect(v.status).toBe('idle');
    expect(v.effects[0]).toMatchObject({ status: 'completed', output: { text: 'Hello' } });
    expect(v.submissions[0]!.placed).toBe(true);
    // Each structural change is a row, so the page's refresh re-reads the view.
    expect(v.eventCount).toBe(3);
    const page = f.events();
    expect(page.events.map((e) => e.eventType)).toEqual(['prompt', 'turn', 'idle']);
    expect(f.events(page.cursor).events).toEqual([]);
  });

  it('splits model calls around tools and drops the empty trailing call', () => {
    const f = new NativeFold('n2', 'fx');
    f.begin([f.submit('ls')]);
    f.event({ type: 'tool_start', name: 'bash', args: { command: 'ls' } });
    f.event({ type: 'tool_end', name: 'bash', output: 'a.txt' });
    f.event({ type: 'text', delta: 'Done.' });
    f.event({ type: 'tool_start', name: 'list_files' });
    f.event({ type: 'tool_end', name: 'list_files' });
    f.event({ type: 'idle' });
    const names = f.view().effects.map((e) => `${e.name}:${e.status}`);
    expect(names).toEqual(['model:completed', 'tool.bash:completed', 'model:completed', 'tool.list_files:completed']);
    expect(f.view().effects[0]!.output.toolCalls).toEqual([{ name: 'bash' }]);
    expect(f.view().effects[1]!.output).toBe('a.txt');
  });

  it('marks an error on the open model call', () => {
    const f = new NativeFold('n3', 'pi');
    f.begin([f.submit('x')]);
    f.event({ type: 'error', message: 'boom' });
    f.event({ type: 'idle' });
    expect(f.view().effects[0]).toMatchObject({ status: 'failed', error: { message: 'boom' } });
  });

  it('a landed steer is placed on the next model call', () => {
    const f = new NativeFold('n4', 'pi');
    f.begin([f.submit('a')]);
    f.event({ type: 'tool_start', name: 'bash' });
    f.steered('also b');
    f.event({ type: 'tool_end', name: 'bash' });
    const v = f.view();
    expect(v.submissions[1]).toMatchObject({ kind: 'steer', placed: true });
    expect(v.effects.at(-1)!.placed).toEqual([v.submissions[1]!.id]);
  });
});
