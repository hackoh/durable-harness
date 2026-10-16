import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { base64ToBytes, blobStreamName, bytesToBase64, readBlobContents, readBlobs, sha256Hex, writeBlob } from './blobs.ts';
import { encodeLine } from './streams.ts';

const worlds: { close?(): Promise<void> }[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function world() {
  const w = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-blobs-')), recoverActiveRuns: false });
  worlds.push(w);
  return w;
}

const line = (value: unknown) => new TextEncoder().encode(`${encodeLine(value)}\n\n`);

describe('the blob stream', () => {
  it('has no blobs before its first write', async () => {
    expect((await readBlobs(await world(), 'wrun_none')).size).toBe(0);
  });

  it('round-trips text by its SHA-256, in pieces when it is long', async () => {
    const w = await world();
    const text = `${'é'.repeat(10)}\u{1F600}${'x'.repeat(25)}`;
    const h = await writeBlob(w, 'wrun_a', text, { pieceChars: 7 });
    expect(h).toBe(await sha256Hex(text));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await writeBlob(w, 'wrun_a', 'short')).toBe(await sha256Hex('short'));
    const blobs = await readBlobs(w, 'wrun_a');
    expect(blobs.get(h)).toBe(text);
    expect(blobs.get(await sha256Hex('short'))).toBe('short');
  });

  it('trusts a blob only for its own hash: a forged copy is ignored, the first good one wins', async () => {
    const w = await world();
    const h = await sha256Hex('the real text');
    await w.streams.write('wrun_b', blobStreamName('wrun_b'), line({ h, s: 'forged' }));
    expect((await readBlobs(w, 'wrun_b')).has(h)).toBe(false);
    await writeBlob(w, 'wrun_b', 'the real text');
    await w.streams.write('wrun_b', blobStreamName('wrun_b'), line({ h, s: 'forged again' }));
    expect((await readBlobs(w, 'wrun_b')).get(h)).toBe('the real text');
    // An incomplete blob in pieces is no blob.
    const p = await sha256Hex('abcdef');
    await w.streams.write('wrun_b', blobStreamName('wrun_b'), line({ h: p, p: 0, n: 2, s: 'abc' }));
    expect((await readBlobs(w, 'wrun_b')).has(p)).toBe(false);
    await w.streams.write('wrun_b', blobStreamName('wrun_b'), line({ h: p, p: 1, n: 2, s: 'def' }));
    expect((await readBlobs(w, 'wrun_b')).get(p)).toBe('abcdef');
  });

  it('round-trips bytes that are not text as base64, named by the SHA-256 of the bytes, in pieces too', async () => {
    const w = await world();
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 7919) % 256);
    const h = await writeBlob(w, 'wrun_c', bytes, { pieceChars: 10_000 });
    expect(h).toBe(await sha256Hex(bytes));
    const text = await writeBlob(w, 'wrun_c', 'plain text');
    const contents = await readBlobContents(w, 'wrun_c');
    expect(contents.get(h)).toEqual(bytes);
    expect(contents.get(text)).toBe('plain text');
    // readBlobs (text only, as the journal reads it) leaves bytes out.
    const texts = await readBlobs(w, 'wrun_c');
    expect(texts.has(h)).toBe(false);
    expect(texts.get(text)).toBe('plain text');
    // Text and its UTF-8 written as bytes are the same blob: one hash.
    expect(await sha256Hex(new TextEncoder().encode('plain text'))).toBe(text);
  });

  it('ignores a line of bytes that is not base64, or whose bytes are not its hash', async () => {
    const w = await world();
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    const h = await sha256Hex(bytes);
    await w.streams.write('wrun_d', blobStreamName('wrun_d'), line({ h, b: 'not base64!' }));
    await w.streams.write('wrun_d', blobStreamName('wrun_d'), line({ h, b: bytesToBase64(new Uint8Array([1, 2, 3])) }));
    expect((await readBlobContents(w, 'wrun_d')).has(h)).toBe(false);
    await writeBlob(w, 'wrun_d', bytes);
    expect((await readBlobContents(w, 'wrun_d')).get(h)).toEqual(bytes);
  });

  it('base64 round-trips any length, past the chunk size', () => {
    for (const n of [0, 1, 2, 3, 24_575, 24_576, 24_577, 100_001]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) % 256);
      const b64 = bytesToBase64(bytes);
      expect(b64.length).toBe(Math.ceil(n / 3) * 4);
      expect(base64ToBytes(b64)).toEqual(bytes);
    }
  });
});
