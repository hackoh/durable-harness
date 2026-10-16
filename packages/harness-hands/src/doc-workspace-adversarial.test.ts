import { durableSessions, type HostTool, QUEUE_PREFIX, readBlobContents, type SessionState, sha256Hex, writeBlob } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeEntry } from './files.ts';
import { filesFromState, readWorkspace, WorkspaceDoc, workspaceManifest, workspaceTools } from './index.ts';
import { type Call, localStore, scripted, toolRecords, until } from './test-harness.ts';

/**
 * The document-backed workspace (doc-workspace.ts) under attack: binary
 * files, executable bits, capacity with inline files, deletes, and a large
 * file in pieces, each read back on a fresh process (a new drive syncs its
 * filesystem from the manifest and the blob stream).
 */

const stores: Awaited<ReturnType<typeof localStore>>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll();
});

async function store() {
  const s = await localStore('hw-docws-adv-');
  stores.push(s);
  return s;
}

type Sessions = ReturnType<typeof durableSessions>;

function serve(world: ReturnType<Awaited<ReturnType<typeof localStore>>['open']>, tools: HostTool[] = workspaceTools({ confirmMs: 10 })): Sessions {
  const s = durableSessions({ world, harness: scripted(tools) });
  world.registerHandler(QUEUE_PREFIX, s.handler);
  return s;
}

async function run(s: Sessions, sessionId: string, prompts: (Call | Call[] | { seq: Call[] })[], timeoutMs = 30_000): Promise<SessionState> {
  const before = toolRecords(await s.inspect(sessionId)).length;
  const calls = prompts.reduce((n, p) => n + (Array.isArray(p) ? p.length : 'seq' in p ? p.seq.length : 1), 0);
  for (const p of prompts) await s.send(sessionId, JSON.stringify(p));
  let state!: SessionState;
  await until(
    async () => {
      state = await s.inspect(sessionId);
      if (state.status === 'failed') return true;
      const recs = toolRecords(state);
      return recs.length === before + calls && recs.every((r) => r.status === 'completed' || r.status === 'failed');
    },
    'tool calls',
    timeoutMs
  );
  return state;
}

const bash = (command: string): Call => ({ tool: 'bash', input: { command } });
const lastOutput = (state: SessionState) => String(toolRecords(state).at(-1)!.output ?? toolRecords(state).at(-1)!.error?.message);
const outputs = (state: SessionState, last: number) => toolRecords(state).slice(-last).map((r) => String(r.output ?? r.error?.message));
const manifestFiles = (state: SessionState) => (state.docs.get(WorkspaceDoc.definition.kind)?.value as { files: Record<string, unknown> }).files;

describe('the document-backed workspace on a fresh process', () => {
  // A file whose bytes are not UTF-8 (gzip, base64 -d) is kept as bytes: read
  // as text it would come back with U+FFFD, and gunzip would fail.
  it('keeps a binary file (bytes that are not UTF-8) as it was written', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    let state = await run(a, sessionId, [bash("printf 'hello' | gzip > h.gz && echo /w4AQUI= | base64 -d > b.dat && gunzip -c h.gz && base64 b.dat")]);
    expect(lastOutput(state)).toContain('hello');
    expect(lastOutput(state)).toContain('/w4AQUI=');
    await st.closeAll();
    const b = serve(st.open());
    state = await run(b, sessionId, [bash('gunzip -c h.gz; echo; base64 b.dat')]);
    expect(lastOutput(state)).toContain('hello');
    expect(lastOutput(state)).toContain('/w4AQUI=');
  });

  // A mode other than 0o644 is in the entry, so a script made executable in
  // one drive is executable in the next (without it, exit 126).
  it('keeps an executable bit', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    let state = await run(a, sessionId, [bash("printf 'echo ran\\n' > run.sh && chmod +x run.sh && ./run.sh")]);
    expect(lastOutput(state)).toContain('ran');
    await st.closeAll();
    const b = serve(st.open());
    state = await run(b, sessionId, [bash('./run.sh')]);
    expect(lastOutput(state)).toContain('ran');
  });

  it('stores bytes and modes in the entry only where they differ from text and 0o644, and reads them back', async () => {
    const st = await store();
    const worldA = st.open();
    const a = serve(worldA);
    const { sessionId } = await a.start();
    // A small gzip (inline, base64), 6,000 random-ish bytes (a blob of bytes),
    // a small script and a 5,000-byte script made executable (inline and blob),
    // a plain text file (a string, as before).
    let state = await run(a, sessionId, [
      bash(
        [
          "printf 'hello' | gzip > small.gz",
          "seq 1 2000 | gzip > big.gz && cat big.gz big.gz big.gz big.gz big.gz big.gz big.gz big.gz > big.bin",
          "printf '#!/bin/sh\\necho ran\\n' > run.sh && chmod 755 run.sh",
          "{ echo 'echo big'; printf '%05000d' 0 | sed 's/^/# /'; echo; } > big.sh && chmod +x big.sh",
          "echo plain > plain.txt",
          'echo ok',
        ].join(' && ')
      ),
    ]);
    expect(lastOutput(state)).toContain('ok');
    const files = manifestFiles(state);
    expect(files['/workspace/plain.txt']).toBe('plain\n');
    expect(files['/workspace/small.gz']).toEqual({ d: expect.stringMatching(/^H4sI/) });
    expect(files['/workspace/run.sh']).toEqual({ t: '#!/bin/sh\necho ran\n', m: 0o755 });
    expect(files['/workspace/big.bin']).toEqual({ n: expect.any(Number), h: expect.stringMatching(/^[0-9a-f]{64}$/), b: 1 });
    expect(files['/workspace/big.sh']).toEqual({ n: expect.any(Number), h: expect.stringMatching(/^[0-9a-f]{64}$/), m: 0o755 });
    // A blob of bytes is base64 in the stream, named by the SHA-256 of the bytes.
    const bigHash = (files['/workspace/big.bin'] as { h: string }).h;
    const blob = (await readBlobContents(worldA, sessionId)).get(bigHash);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(await sha256Hex(blob as Uint8Array)).toBe(bigHash);
    expect((blob as Uint8Array).length).toBe((files['/workspace/big.bin'] as { n: number }).n);

    const manifest = Object.fromEntries(workspaceManifest(state).map((f) => [f.path, f]));
    expect(manifest['/workspace/small.gz']).toMatchObject({ inline: true, binary: true });
    expect(manifest['/workspace/small.gz']!.text).toBeUndefined();
    expect(manifest['/workspace/big.bin']).toMatchObject({ inline: false, binary: true });
    expect(manifest['/workspace/run.sh']).toMatchObject({ inline: true, text: '#!/bin/sh\necho ran\n', mode: 0o755 });
    expect(manifest['/workspace/big.sh']).toMatchObject({ inline: false, mode: 0o755 });
    expect(manifest['/workspace/plain.txt']).toEqual({ path: '/workspace/plain.txt', bytes: 6, inline: true, text: 'plain\n' });
    // Synchronous readers have the text in the log; binary files are not text.
    expect(Object.keys(filesFromState(state)).sort()).toEqual(['/workspace/plain.txt', '/workspace/run.sh']);
    // readWorkspace: text as text, bytes as bytes.
    const read = await readWorkspace(worldA, state);
    expect(read['/workspace/plain.txt']).toBe('plain\n');
    expect(read['/workspace/small.gz']).toBeInstanceOf(Uint8Array);
    expect([...(read['/workspace/small.gz'] as Uint8Array).slice(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(read['/workspace/big.bin']).toEqual(blob);
    expect(typeof read['/workspace/big.sh']).toBe('string');

    // A fresh process: the same bytes and modes (sha256sum over every file, the
    // scripts run), and a mode change alone is an edit (chmod -x makes run.sh
    // a plain string again).
    const sums = 'sha256sum small.gz big.bin run.sh big.sh plain.txt';
    const written = lastOutput(await run(a, sessionId, [bash(sums)]));
    expect(written.match(/[0-9a-f]{64}/g)).toHaveLength(5);
    await st.closeAll();
    const b = serve(st.open());
    state = await run(b, sessionId, [bash(`${sums} && ./run.sh && ./big.sh && gunzip -c small.gz && chmod -x run.sh && echo done`)]);
    expect(lastOutput(state).match(/[0-9a-f]{64}/g)).toEqual(written.match(/[0-9a-f]{64}/g));
    expect(lastOutput(state)).toMatch(/ran\nbig\nhello/);
    expect(manifestFiles(state)['/workspace/run.sh']).toBe('#!/bin/sh\necho ran\n');
    state = await run(b, sessionId, [bash('./run.sh; echo "exit $?"')]);
    expect(lastOutput(state)).toContain('exit 126');
  }, 60_000);

  it('reads an entry two writers merged as one writer\'s content: h, then d, then t', () => {
    const h = 'a'.repeat(64);
    expect(normalizeEntry({ n: 3, h, t: 'stale', d: 'AAAA', m: 0o755 })).toEqual({ n: 3, h, m: 0o755 });
    expect(normalizeEntry({ d: 'AAAA', t: 'stale' })).toEqual({ d: 'AAAA' });
    expect(normalizeEntry({ t: 'text', m: 0o644 })).toBe('text');
    expect(normalizeEntry({ t: 'text', m: 0o755, b: 1 })).toEqual({ t: 'text', m: 0o755 });
    // Today's entries read as they always did.
    expect(normalizeEntry('text')).toBe('text');
    expect(normalizeEntry({ n: 10, h })).toEqual({ n: 10, h });
    // Not an entry: no content, a bad hash, base64 that is not.
    expect(normalizeEntry({ m: 0o755 })).toBeUndefined();
    expect(normalizeEntry({ n: 1, h: 'nothex' })).toBeUndefined();
    expect(normalizeEntry({ d: 'not base64!' })).toBeUndefined();
    // A mode that is not one is the default.
    expect(normalizeEntry({ t: 'x', m: -1 })).toBe('x');
  });

  it('holds about 500 files even when the first ones filled the inline budget', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    // Twelve files of 4,000 bytes: inline, about 48 KB of manifest.
    await run(a, sessionId, [bash(`for i in $(seq 1 12); do printf '%04000d' $i > inline$i.txt; done; echo ok`)]);
    // Then files of 5,000 bytes (blobs), 50 per call, until the workspace is full.
    let written = 12;
    for (let round = 0; round < 10; round++) {
      const state = await run(a, sessionId, [bash(`for i in $(seq 1 50); do printf '%05000d' $i > r${round}_$i.txt; done; echo ok`)], 60_000);
      if (toolRecords(state).at(-1)!.status === 'failed') break;
      written += 50;
    }
    expect(written).toBeGreaterThanOrEqual(450);
    // The files that moved out of the inline budget read back on a fresh process.
    await st.closeAll();
    const worldB = st.open();
    const b = serve(worldB);
    const state = await run(b, sessionId, [bash('wc -c < inline1.txt; wc -c < r0_1.txt')]);
    expect(lastOutput(state)).toMatch(/4000\s+5000/);
    const manifest = workspaceManifest(state);
    expect(manifest.find((f) => f.path === '/workspace/inline1.txt')).toMatchObject({ inline: false, bytes: 4000 });
    expect((await readWorkspace(worldB, state))['/workspace/inline12.txt']).toBe(`${'0'.repeat(3998)}12`);
  }, 120_000);

  it('a delete of a directory is gone on a fresh process, and a large file in pieces reads back whole', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    await run(a, sessionId, [bash('mkdir -p dir && echo 1 > dir/a && echo 2 > dir/b && echo keep > keep.txt && echo ok')]);
    await run(a, sessionId, [bash('rm -rf dir && echo ok')]);
    // 3,000,000 characters: more than one blob piece (2 Mi characters each).
    await run(a, sessionId, [bash("printf '%03000000d' 7 > big.txt && wc -c < big.txt")], 60_000);
    await st.closeAll();
    const worldB = st.open();
    const b = serve(worldB);
    const state = await run(b, sessionId, [bash('ls -R; wc -c < big.txt')], 60_000);
    expect(lastOutput(state)).not.toContain('dir');
    expect(lastOutput(state)).toContain('keep.txt');
    expect(lastOutput(state)).toContain('3000000');
    const files = await readWorkspace(worldB, state);
    expect(Object.keys(files).sort()).toEqual(['/workspace/big.txt', '/workspace/keep.txt']);
    expect(files['/workspace/big.txt']!.length).toBe(3_000_000);
    expect(workspaceManifest(state).find((f) => f.path === '/workspace/big.txt')).toMatchObject({ inline: false, bytes: 3_000_000 });
    expect((state.docs.get(WorkspaceDoc.definition.kind)?.value as { files: Record<string, unknown> }).files['/workspace/dir/a']).toBeUndefined();
  }, 120_000);
});

describe('the document-backed workspace, from its review', () => {
  // The manifest has files only. A link left in this drive's filesystem would
  // make the workspace depend on where drives end: an edit of the target
  // shows through it here, and not after a fresh drive copied it.
  it('a symbolic link is a copy once its call is over, in this drive as in the next', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    const steps = [bash('echo A > a && ln -s a b && ln -s nowhere dangling && mkdir d && echo x > d/x && ln -s d dirlink && cat b'), bash('echo Z > a && cat b'), bash('rm a && cat b && ls')];
    // One drive, three calls in a row.
    let state = await run(a, sessionId, [{ seq: steps }]);
    const sameDrive = outputs(state, 3);
    expect(sameDrive[0]).toContain('A');
    expect(sameDrive[1]).toMatch(/stdout:\nA\n/);
    expect(sameDrive[2]).toMatch(/stdout:\nA\nb\nd\n/);
    expect(manifestFiles(state)).toEqual({ '/workspace/b': 'A\n', '/workspace/d/x': 'x\n' });
    // The same calls with a fresh process before each: the same results.
    const { sessionId: other } = await a.start();
    const fresh: string[] = [];
    for (const step of steps) {
      await st.closeAll();
      const b = serve(st.open());
      fresh.push(lastOutput(await run(b, other, [step])));
    }
    expect(fresh).toEqual(sameDrive);
    state = await serve(st.open()).inspect(other);
    expect(manifestFiles(state)).toEqual({ '/workspace/b': 'A\n', '/workspace/d/x': 'x\n' });
  }, 60_000);

  it('a call that fails leaves no link behind', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    // The second call fills the manifest past its limit, so it is rolled back: its links go with it.
    const fill = "for i in $(seq 1 450); do echo x > $(printf 'f%0150d' $i); done";
    const state = await run(a, sessionId, [{ seq: [bash('echo A > a && echo ok'), bash(`ln -s a b && ln -s nowhere c && ${fill}; echo filled`), bash('echo C > nowhere && ls')] }], 60_000);
    const [, failed, after] = outputs(state, 3);
    expect(failed).toContain('the workspace is full');
    expect(after).toMatch(/stdout:\na\nnowhere\n$/);
    expect(Object.keys(manifestFiles(state)).sort()).toEqual(['/workspace/a', '/workspace/nowhere']);
  }, 60_000);

  // read_file and edit_file see text: a binary file as text is U+FFFD in place
  // of its bytes, and an edit would write that back.
  it('edit_file refuses a binary file and read_file says what it is; neither changes it', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    let state = await run(a, sessionId, [bash("printf 'hello' | gzip > h.gz && sha256sum h.gz")]);
    const sum = lastOutput(state).match(/[0-9a-f]{64}/)![0];
    state = await run(a, sessionId, [{ tool: 'read_file', input: { path: 'h.gz' } }]);
    expect(lastOutput(state)).toMatch(/^\(\/workspace\/h.gz is a binary file: \d+ bytes that are not UTF-8 text/);
    state = await run(a, sessionId, [{ tool: 'edit_file', input: { path: 'h.gz', oldText: '\u0000', newText: 'x' } }]);
    expect(toolRecords(state).at(-1)!.status).toBe('failed');
    expect(lastOutput(state)).toContain('is a binary file');
    await st.closeAll();
    const b = serve(st.open());
    state = await run(b, sessionId, [bash('sha256sum h.gz && gunzip -c h.gz')]);
    expect(lastOutput(state)).toContain(sum);
    expect(lastOutput(state)).toContain('hello');
  }, 60_000);

  it('edit_file and write_file keep an executable file executable', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    await run(a, sessionId, [bash("printf '#!/bin/sh\\necho one\\n' > run.sh && chmod +x run.sh && printf 'x\\n' > keep.sh && chmod 700 keep.sh")]);
    await run(a, sessionId, [{ tool: 'edit_file', input: { path: 'run.sh', oldText: 'one', newText: 'two' } }]);
    let state = await run(a, sessionId, [{ tool: 'write_file', input: { path: 'keep.sh', content: 'y\n' } }]);
    expect(manifestFiles(state)['/workspace/run.sh']).toEqual({ t: '#!/bin/sh\necho two\n', m: 0o755 });
    expect(manifestFiles(state)['/workspace/keep.sh']).toEqual({ t: 'y\n', m: 0o700 });
    await st.closeAll();
    state = await run(serve(st.open()), sessionId, [bash('./run.sh && stat -c %a keep.sh')]);
    expect(lastOutput(state)).toMatch(/two\n700/);
  }, 60_000);

  // A tar of text files is UTF-8 (octal headers, NUL padding), so it is text;
  // its NULs are six bytes each as JSON. The inline rule measures the JSON.
  it('a text of control characters goes to the blob stream by its size as JSON, and reads back', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    let state = await run(a, sessionId, [bash('echo hi > t1 && tar cf t.tar t1 && wc -c < t.tar && sha256sum t.tar')]);
    expect(lastOutput(state)).toMatch(/2048/);
    const sum = lastOutput(state).match(/[0-9a-f]{64}/)![0];
    const entry = manifestFiles(state)['/workspace/t.tar'];
    expect(entry).toEqual({ n: 2048, h: sum });
    // The edit that named it is about the size of the entry, not 12 KB.
    expect(JSON.stringify(state.docs.get(WorkspaceDoc.definition.kind)!.value).length).toBeLessThan(400);
    await st.closeAll();
    state = await run(serve(st.open()), sessionId, [bash('sha256sum t.tar && tar tf t.tar')]);
    expect(lastOutput(state)).toContain(sum);
    expect(lastOutput(state)).toContain('t1');
  }, 60_000);

  it('a mode change alone, on every entry shape, is the same file on a fresh process', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    const names = 's.sh big.sh g.gz bg.bin';
    await run(a, sessionId, [
      bash("printf 'echo s\\n' > s.sh && { echo 'echo big'; printf '%06000d\\n' 0 | sed 's/^/# /'; } > big.sh && printf 'hello' | gzip > g.gz && seq 1 3000 | gzip > z && cat z z z > bg.bin && rm z"),
    ]);
    let state = await run(a, sessionId, [bash(`sha256sum ${names}`)]);
    const sums = lastOutput(state).match(/[0-9a-f]{64}/g);
    state = await run(a, sessionId, [bash('chmod 755 s.sh big.sh g.gz && chmod 600 bg.bin')]);
    const files = manifestFiles(state);
    expect(files['/workspace/s.sh']).toEqual({ t: 'echo s\n', m: 0o755 });
    expect(files['/workspace/big.sh']).toMatchObject({ m: 0o755 });
    expect(files['/workspace/g.gz']).toMatchObject({ d: expect.any(String), m: 0o755 });
    expect(files['/workspace/bg.bin']).toMatchObject({ b: 1, m: 0o600 });
    await st.closeAll();
    state = await run(serve(st.open()), sessionId, [bash(`stat -c '%a %n' ${names} && sha256sum ${names} && ./s.sh && ./big.sh && chmod 644 ${names}`)]);
    expect(lastOutput(state)).toContain('755 s.sh\n755 big.sh\n755 g.gz\n600 bg.bin');
    expect(lastOutput(state).match(/[0-9a-f]{64}/g)).toEqual(sums);
    expect(lastOutput(state)).toMatch(/s\nbig/);
    expect(typeof manifestFiles(state)['/workspace/s.sh']).toBe('string');
    expect(manifestFiles(state)['/workspace/bg.bin']).not.toHaveProperty('m');
    await st.closeAll();
    state = await run(serve(st.open()), sessionId, [bash(`stat -c '%a' ${names} && sha256sum ${names}`)]);
    expect(lastOutput(state)).toContain('644\n644\n644\n644');
    expect(lastOutput(state).match(/[0-9a-f]{64}/g)).toEqual(sums);
  }, 90_000);

  it('a binary file of several blob pieces reads back on a fresh process', async () => {
    const st = await store();
    const a = serve(st.open());
    const { sessionId } = await a.start();
    // 160 copies of a gzip of 9,000 lines: about 3 MB, base64 in two pieces
    // (within the hardened profile's limits on one command's loop and output).
    // (One cat: just-bash passes a loop's output on as text.)
    const copies = Array.from({ length: 160 }, () => 's.gz').join(' ');
    let state = await run(a, sessionId, [bash(`seq 1 9000 | gzip -1 > s.gz && cat ${copies} > big.gz && rm s.gz && sha256sum big.gz`)], 120_000);
    const sum = lastOutput(state).match(/[0-9a-f]{64}/)![0];
    expect(manifestFiles(state)['/workspace/big.gz']).toMatchObject({ h: sum, b: 1 });
    await st.closeAll();
    const world = st.open();
    state = await run(serve(world), sessionId, [bash('sha256sum big.gz && gunzip -c big.gz | tail -n 1')], 120_000);
    expect(lastOutput(state)).toContain(sum);
    expect(lastOutput(state)).toContain('9000');
    expect(await sha256Hex((await readWorkspace(world, state))['/workspace/big.gz'] as Uint8Array)).toBe(sum);
  }, 240_000);

  // What the previous format wrote: strings, { n, h } and text blob lines.
  it('a manifest and blob stream in the previous format read and sync as they did', async () => {
    const st = await store();
    const world = st.open();
    const a = serve(world);
    const { sessionId } = await a.start();
    const big = `${'é'.repeat(3000)}\n`;
    const longer = 'x'.repeat(5_000_000);
    const h = await writeBlob(world, sessionId, big);
    const h2 = await writeBlob(world, sessionId, longer);
    await a.updateDoc(sessionId, WorkspaceDoc, () => ({
      files: { '/workspace/a.txt': 'old\n', '/workspace/big.txt': { n: 6001, h }, '/workspace/longer.txt': { n: 5_000_000, h: h2 } },
    }));
    let state = await a.inspect(sessionId);
    expect(workspaceManifest(state).map((f) => [f.path, f.inline, f.binary, f.mode])).toEqual([
      ['/workspace/a.txt', true, undefined, undefined],
      ['/workspace/big.txt', false, undefined, undefined],
      ['/workspace/longer.txt', false, undefined, undefined],
    ]);
    expect(await readWorkspace(world, state)).toEqual({ '/workspace/a.txt': 'old\n', '/workspace/big.txt': big, '/workspace/longer.txt': longer });
    state = await run(a, sessionId, [bash('cat a.txt && wc -c < big.txt && wc -c < longer.txt && echo new >> a.txt')]);
    expect(lastOutput(state)).toMatch(/old\n6001\n5000000/);
    expect(manifestFiles(state)).toEqual({ '/workspace/a.txt': 'old\nnew\n', '/workspace/big.txt': { n: 6001, h }, '/workspace/longer.txt': { n: 5_000_000, h: h2 } });
  }, 60_000);
});
