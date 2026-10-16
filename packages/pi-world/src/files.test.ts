import type { StorageWrite } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { deltaOf, SessionFiles, WORKSPACE_DETAILS_KEY, withDelta } from './files.ts';

/** A commit's write of a tool result whose details carry `files`. */
const result = (files: Record<string, unknown>, extra: Record<string, unknown> = {}): StorageWrite =>
  ({
    type: 'entry',
    value: { id: 1, conversationId: 0, kind: 'pi.tool-result', model: [{ role: 'toolResult', details: { ...extra, [WORKSPACE_DETAILS_KEY]: { files } } }] },
  }) as never;

describe('SessionFiles: the fold of tool results’ file changes', () => {
  it('writes, removes, keeps entries well-formed and under /workspace', () => {
    const f = new SessionFiles();
    f.fold([result({ '/workspace/a.txt': 'a', '/workspace/b.bin': { d: 'AP8B' }, '/etc/passwd': 'x', '/workspace/../x': 'y', '/workspace/bad': { nope: 1 } })]);
    expect([...f.entries.keys()].sort()).toEqual(['/workspace/a.txt', '/workspace/b.bin']);
    f.fold([result({ '/workspace/a.txt': null })]);
    expect([...f.entries.keys()]).toEqual(['/workspace/b.bin']);
  });

  it('keeps the files a tree when two side-by-side calls disagree about a path: the later wins', () => {
    const f = new SessionFiles();
    f.fold([result({ '/workspace/x': 'a file' })]);
    f.fold([result({ '/workspace/x/y': 'under a directory x' })]);
    expect([...f.entries.keys()]).toEqual(['/workspace/x/y']);
    f.fold([result({ '/workspace/x': 'a file again' })]);
    expect([...f.entries.keys()]).toEqual(['/workspace/x']);
  });

  it('ignores other entries and details without changes; withDelta keeps a tool’s own details', () => {
    const f = new SessionFiles();
    f.fold([{ type: 'entry', value: { kind: 'pi.assistant', model: [{ details: { [WORKSPACE_DETAILS_KEY]: { files: { '/workspace/a': 'a' } } } }] } } as never]);
    f.fold([{ type: 'entry', value: { kind: 'pi.tool-result', model: [{ details: { diff: '...' } }] } } as never]);
    expect(f.entries.size).toBe(0);
    expect(withDelta({ diff: 'd' }, { files: {} })).toEqual({ diff: 'd', [WORKSPACE_DETAILS_KEY]: { files: {} } });
    expect(withDelta(['x'], { turn: 't' })).toEqual({ value: ['x'], [WORKSPACE_DETAILS_KEY]: { turn: 't' } });
    expect(deltaOf({ [WORKSPACE_DETAILS_KEY]: 'nope' })).toBeUndefined();
    f.fold([result({}, {})]);
    const turns = new SessionFiles();
    turns.fold([{ type: 'entry', value: { kind: 'pi.tool-result', model: [{ details: { [WORKSPACE_DETAILS_KEY]: { turn: '7' } } }] } } as never]);
    expect([...turns.turns]).toEqual(['7']);
  });
});
