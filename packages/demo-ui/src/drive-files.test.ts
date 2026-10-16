/**
 * The Files panel of a `sandbox()` session (docs/workspaces.md §8): the
 * Drive's last snapshot, labelled as one, with what the live stream reported
 * since it was taken.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DriveList, driveRows } from './Inspector.tsx';
import type { DriveView } from './view.ts';

const drive: DriveView = {
  at: 1_000,
  truncated: true,
  files: [
    { path: '/workspace/node_modules', bytes: 4096, mtimeMs: 900, directory: true, skipped: true },
    { path: '/workspace/notes.md', bytes: 6, mtimeMs: 950, text: 'heron\n' },
    { path: '/workspace/src', bytes: 4096, mtimeMs: 900, directory: true },
    { path: '/workspace/src/big.ts', bytes: 9000, mtimeMs: 950 },
  ],
};

const render = (props: Partial<Parameters<typeof DriveList>[0]>) =>
  renderToStaticMarkup(createElement(DriveList, { drive, rows: driveRows(drive), changes: [], hasSession: true, onSelect() {}, ...props })).replace(/<[^>]+>/g, ' ');

describe('the Drive files panel', () => {
  it('lists the snapshot, says it is one, and names the dependency dirs it did not walk', () => {
    const text = render({});
    expect(text).toContain('Snapshot; the Drive is the source of truth.');
    expect(text).toContain('/workspace/notes.md');
    expect(text).toContain('/workspace/src/big.ts');
    expect(text).toContain('/workspace/node_modules/');
    expect(text).toContain('not listed');
    // A plain directory is not a row of its own.
    expect(text).not.toMatch(/\/workspace\/src\/ /);
    expect(text).toContain('500 entries and 48 KB');
  });

  it('shows the calls since the snapshot from the live stream, and none from before it', () => {
    const text = render({
      changes: [
        { tool: 'Write', callId: 'old', paths: ['/workspace/notes.md'], t: 500 },
        { tool: 'Bash', callId: 'new', t: 2_000 },
        { tool: 'Edit', callId: 'newer', paths: ['/workspace/src/big.ts'], t: 3_000 },
      ],
    });
    expect(text).toContain('Changed since the snapshot');
    expect(text).toContain('Bash: may have changed any file');
    expect(text).toContain('Edit: /workspace/src/big.ts');
    expect(text).not.toContain('Write: /workspace/notes.md');
  });

  it('before the first snapshot: says one comes after a turn and outlives the VM', () => {
    const text = renderToStaticMarkup(createElement(DriveList, { rows: [], changes: [], hasSession: true, onSelect() {} }));
    expect(text).toContain('No snapshot of the Drive yet');
    expect(text).toContain('stays readable after the VM stops');
  });
});
