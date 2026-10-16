import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReport, REPORT_CLIP_CHARS, reportFromOutput, streamText, WRAPPER } from './sandbox-job.ts';

/**
 * A command's output reaches the model clipped to a head and a tail. Nothing
 * between them may vanish without the elision marker saying so: output just
 * over the head's size used to lose everything past the head.
 */

const H = REPORT_CLIP_CHARS;
const text = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

function expectFaithful(original: string, shown: string) {
  if (!shown.includes('elided')) {
    expect(shown).toBe(original);
    return;
  }
  const [head, tail] = shown.split(/\n… \[\d+ bytes elided\] …\n/);
  expect(original.startsWith(head!)).toBe(true);
  expect(original.endsWith(tail!)).toBe(true);
  const elided = Number(/\[(\d+) bytes elided\]/.exec(shown)![1]);
  expect(head!.length + tail!.length + elided).toBe(original.length);
}

/** The wrapper's own clipper, run under python3 on a real file. */
function wrapperClip(path: string): { bytes: number; head: string; tail: string } {
  const body = WRAPPER.slice(WRAPPER.indexOf("<<'PY'\n") + 7, WRAPPER.indexOf('\nPY\n'));
  const def = body.slice(body.indexOf('def clip'), body.indexOf('r={'));
  const script = `import json,os,stat,sys\nH=${H}\n${def}\nprint(json.dumps(clip(sys.argv[1])))`;
  return JSON.parse(execFileSync('python3', ['-c', script, path], { encoding: 'utf8' }));
}

describe('clipping a command output', () => {
  for (const n of [10, H, H + 1, H + 1000, 2 * H, 2 * H + 1, 5 * H, 40 * H]) {
    it(`keeps a head and a tail with nothing silently dropped (${n} chars)`, () => {
      const t = text(n);
      expectFaithful(t, streamText(reportFromOutput(0, t, '').stdout));
    });
  }

  it.runIf(hasPython())('the wrapper clips the same way, and never follows a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clip-'));
    for (const n of [10, H + 1000, 2 * H + 1, 5 * H, 40 * H]) {
      const t = text(n);
      writeFileSync(join(dir, 'out'), t);
      const clipped = wrapperClip(join(dir, 'out'));
      const report = parseReport({ v: 1, exitCode: 0, stdout: clipped, stderr: { bytes: 0, head: '', tail: '' } })!;
      expectFaithful(t, streamText(report.stdout));
    }
    symlinkSync('/dev/zero', join(dir, 'zero'));
    expect(wrapperClip(join(dir, 'zero'))).toEqual({ bytes: 0, head: '', tail: '' });
  });
});

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass']);
    return true;
  } catch {
    return false;
  }
}
