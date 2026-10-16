/**
 * The Drive's manifest (`hw.sandbox-files`, src/files.ts; docs/workspaces.md
 * §8 "Files panel"), on the stand-in: a stat-only listing through the
 * relay's helper stays within 500 entries and 48 KB on a Drive holding a
 * `node_modules`, reuses what it knew, and, written by a drive, is read back
 * from the log with no VM (after the VM is deleted).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, EffectFailure, type Harness, liveStreamName, QUEUE_PREFIX, readJsonLines, type SessionState } from 'harness-world';
import type { AcquireMachine } from 'harness-world-process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DRIVE_MANIFEST_LIMITS, type DriveFilesEvent, type DriveManifest, type DriveReader, driveKey, driveManifestBehind, listDrive, readDriveManifest } from '../src/files.ts';
import { sessionName } from '../src/names.ts';
import { kernelSandbox, sandboxSession } from '../src/session.ts';
import { FakeSandboxApi } from './fake-api.ts';
import { type LocalSandbox, localMachine } from './local-machine.ts';

beforeAll(() => {
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
});

const later = () => Date.now() + 30_000;
const bytesOf = (m: DriveManifest) => new TextEncoder().encode(JSON.stringify(m)).length;

/** Count the helper calls a listing makes. */
function counting(fs: DriveReader) {
  const calls = { list: 0, stat: 0, readFile: 0 };
  const reader: DriveReader = {
    root: fs.root,
    list: (d) => (calls.list++, fs.list(d)),
    stat: (p) => (calls.stat++, fs.stat(p)),
    readFile: (p) => (calls.readFile++, fs.readFile(p)),
  };
  return { reader, calls };
}

describe('the Drive manifest: a stat-only listing through the helper', () => {
  let box: LocalSandbox;
  beforeAll(async () => {
    box = await localMachine();
    const ws = box.config.workspace;
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'README.md'), '# demo\n');
    writeFileSync(join(ws, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(10_000));
    writeFileSync(join(ws, 'logo.bin'), new Uint8Array([0xff, 0xfe, 0x00, 0x81]));
    // A node_modules of 3,000 files and a .git: listed by name, never walked.
    for (let p = 0; p < 30; p++) {
      const dir = join(ws, 'node_modules', `pkg-${p}`, 'lib');
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 100; f++) writeFileSync(join(dir, `f${f}.js`), `module.exports = ${f};\n`);
    }
    mkdirSync(join(ws, '.git', 'objects'), { recursive: true });
    writeFileSync(join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }, 60_000);
  afterAll(async () => {
    await box?.dispose();
  });

  it('on a Drive holding a node_modules: within 500 entries and 48 KB, the dependency dirs by name only, small texts inline', async () => {
    const { reader, calls } = counting(box.machine.workspace as unknown as DriveReader);
    const m = await listDrive(reader, undefined, { deadline: later(), calls: 0 });
    const paths = Object.keys(m.files);
    expect(paths.length).toBeLessThanOrEqual(DRIVE_MANIFEST_LIMITS.entries);
    expect(bytesOf(m)).toBeLessThanOrEqual(DRIVE_MANIFEST_LIMITS.bytes);
    expect(m.files['/workspace/node_modules']).toMatchObject({ d: 1, s: 1 });
    expect(m.files['/workspace/.git']).toMatchObject({ d: 1, s: 1 });
    expect(paths.some((p) => p.startsWith('/workspace/node_modules/') || p.startsWith('/workspace/.git/'))).toBe(false);
    expect(m.files['/workspace/README.md']).toMatchObject({ n: 7, x: '# demo\n' });
    expect(m.files['/workspace/src/index.ts']?.x).toBe('export const x = 1;\n');
    // Over 4 KB, or not UTF-8: listed, no text.
    expect(m.files['/workspace/big.txt']).toMatchObject({ n: 10_000 });
    expect(m.files['/workspace/big.txt']?.x).toBeUndefined();
    expect(m.files['/workspace/logo.bin']?.x).toBeUndefined();
    expect(m.truncated).toBeUndefined();
    // The node_modules cost one stat, not 3,000: nothing under it was listed or read.
    expect(calls.list).toBeLessThan(5);
    expect(calls.readFile).toBe(3);
  });

  it('past 500 entries or 48 KB it stops, and says so', async () => {
    const ws = box.config.workspace;
    mkdirSync(join(ws, 'many'), { recursive: true });
    for (let f = 0; f < 700; f++) writeFileSync(join(ws, 'many', `a-long-file-name-for-the-budget-${String(f).padStart(4, '0')}.txt`), `${f}\n`);
    try {
      const m = await listDrive(box.machine.workspace as unknown as DriveReader, undefined, { deadline: later(), calls: 0 });
      expect(m.truncated).toBe(true);
      expect(Object.keys(m.files).length).toBeLessThanOrEqual(DRIVE_MANIFEST_LIMITS.entries);
      expect(bytesOf(m)).toBeLessThanOrEqual(DRIVE_MANIFEST_LIMITS.bytes);
      // Breadth first: the root's own files made it.
      expect(m.files['/workspace/README.md']?.x).toBe('# demo\n');
    } finally {
      await box.machine.workspace.remove(join(ws, 'many'), { recursive: true });
    }
  });

  it('incremental: a file whose size and mtime are unchanged keeps its text unread; a touched path comes first', async () => {
    const fs = box.machine.workspace as unknown as DriveReader;
    const first = await listDrive(fs, undefined, { deadline: later(), calls: 1 });
    const { reader, calls } = counting(fs);
    writeFileSync(join(box.config.workspace, 'src', 'index.ts'), 'export const x = 2;\n');
    const next = await listDrive(reader, first, { deadline: later(), calls: 2, touched: ['/workspace/src/index.ts'] });
    expect(next.files['/workspace/src/index.ts']?.x).toBe('export const x = 2;\n');
    expect(next.files['/workspace/README.md']?.x).toBe('# demo\n');
    expect(calls.readFile).toBe(1);
    expect(Object.keys(next.files)[0]).toBe('/workspace/src/index.ts');
    expect(next.calls).toBe(2);
  });

  it('a listing its deadline cut short keeps what the last snapshot had, and says so', async () => {
    const fs = box.machine.workspace as unknown as DriveReader;
    const first = await listDrive(fs, undefined, { deadline: later(), calls: 0 });
    const m = await listDrive(fs, first, { deadline: Date.now() - 1, calls: 0 });
    expect(m.truncated).toBe(true);
    expect(m.files['/workspace/README.md']).toMatchObject({ x: '# demo\n' });
  });

  it('names paths under the Drive only', () => {
    expect(driveKey('/tmp/dh-x/workspace', '/tmp/dh-x/workspace/a/b.txt')).toBe('/workspace/a/b.txt');
    expect(driveKey('/workspace', '/workspace/./a//b.txt')).toBe('/workspace/a/b.txt');
    expect(driveKey('/workspace', 'notes.md')).toBe('/workspace/notes.md');
    expect(driveKey('/workspace', '/etc/passwd')).toBeUndefined();
    expect(driveKey('/workspace', '/workspace/../etc/passwd')).toBeUndefined();
    expect(driveKey('/workspace', '/workspace')).toBeUndefined();
  });
});

describe('the Drive manifest in the log', () => {
  const worlds: LocalWorld[] = [];
  const apis: FakeSandboxApi[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) await w.close?.();
    for (const a of apis.splice(0)) await a.dispose();
  });

  /** A drive that runs each prompt as a command on the VM, reports it changed (`notes.md` named), and (unless the prompt says `crash`) snapshots at the turn's end. */
  function writer(acquire: AcquireMachine): Harness {
    const sandbox = kernelSandbox(acquire);
    return {
      name: 'writer',
      async drive(ctx: DriveContext) {
        if (ctx.pending().length === 0) return;
        const machine = await sandbox.attach(ctx, {});
        const files = sandbox.files(ctx, machine);
        await files.catchUp();
        for (const s of ctx.pending()) {
          await ctx
            .effect(`tool:${s.id}`, { name: 'tool.Bash', replay: 'never', input: s.text, placed: [s.id] }, async () => (await machine.workspace.exec(s.text ?? '')).stdout)
            .catch((err) => {
              if (!(err instanceof EffectFailure)) throw err;
            });
          files.changed({ tool: 'Bash', callId: s.id, paths: ['/workspace/notes.md'] });
          if (!s.text?.includes('crash')) await files.snapshot();
        }
        await machine.close();
      },
    };
  }

  async function session() {
    const api = new FakeSandboxApi();
    apis.push(api);
    const acquire = sandboxSession({
      spec: { vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: Infinity }, image: 'stand-in' },
      test: { api, allowDegraded: true, allowUnauthenticatedModel: true },
    });
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'dh-files-')), recoverActiveRuns: false });
    worlds.push(world);
    const sessions = durableSessions({ world, harness: writer(acquire) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    await world.start?.();
    const { sessionId } = await sessions.start();
    const settled = (n: number) =>
      (async () => {
        for (const start = Date.now(); Date.now() - start < 30_000; await new Promise((r) => setTimeout(r, 50))) {
          const s = await sessions.inspect(sessionId);
          const bash = s.effectOrder.filter((e) => e.name === 'tool.Bash');
          const files = s.effectOrder.filter((e) => e.name === 'sandbox.files');
          if (bash.length >= n && bash.every((e) => e.status !== 'running') && files.every((e) => e.status !== 'running') && s.submissions.every((x) => x.kind !== 'prompt' || s.placed.has(x.id))) return s;
        }
        throw new Error('timed out');
      })();
    return { api, world, sessions, sessionId, settled, name: sessionName('prj_stand_in', sessionId) };
  }

  it('a turn that changed files writes the snapshot, readable from the log after the VM is gone; each mutating call is a live event', async () => {
    const s = await session();
    await s.sessions.send(s.sessionId, 'echo "the code word is heron" > notes.md');
    await new Promise((r) => setTimeout(r, 200));
    let state: SessionState = await s.settled(1);
    for (let i = 0; i < 100 && !readDriveManifest(state); i++) state = await new Promise((r) => setTimeout(r, 50)).then(() => s.sessions.inspect(s.sessionId));
    // The VM and its relay go; the snapshot is in the log.
    await (await s.api.getSandbox(s.name))!.delete();
    state = await s.sessions.inspect(s.sessionId);
    const snap = readDriveManifest(state)!;
    expect(snap.files.find((f) => f.path === '/workspace/notes.md')).toMatchObject({ text: 'the code word is heron\n', bytes: 23 });
    expect(snap.driveId).toBe(s.api.drives.get(s.name)!.info.driveId);
    expect(driveManifestBehind(state)).toBe(false);
    const live = (await readJsonLines(s.world, s.sessionId, liveStreamName(s.sessionId))) as { type?: string }[];
    expect(live.filter((e): e is DriveFilesEvent => e.type === 'drive_files')).toEqual([expect.objectContaining({ tool: 'Bash', paths: ['/workspace/notes.md'] })]);
  }, 60_000);

  it('an invocation that ended before its snapshot: the next one lists first', async () => {
    const s = await session();
    await s.sessions.send(s.sessionId, 'echo one > notes.md # crash before the snapshot');
    let state = await s.settled(1);
    expect(readDriveManifest(state)).toBeUndefined();
    expect(driveManifestBehind(state)).toBe(true);
    await s.sessions.send(s.sessionId, 'cat notes.md # crash again');
    state = await s.settled(2);
    // The second drive's catch-up listed the first one's write, before its own command.
    const snap = readDriveManifest(state)!;
    expect(snap.files.find((f) => f.path === '/workspace/notes.md')?.text).toBe('one\n');
    const order = state.effectOrder.filter((e) => e.name === 'sandbox.files' || e.name === 'tool.Bash').map((e) => e.name);
    expect(order).toEqual(['tool.Bash', 'sandbox.files', 'tool.Bash']);
  }, 60_000);
});
