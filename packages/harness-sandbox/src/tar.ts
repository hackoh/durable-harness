/**
 * A minimal ustar writer for `FILES` (docs/workspaces.md §5.4): regular files
 * only, the relay unpacks it with `tar --no-same-owner`. Paths are checked
 * here, before anything is sent: relative, no `..`, no empty segment, at most
 * 100 bytes (ustar's name field; no prefix field is written), so the archive
 * can only name files under the cache dir it is unpacked into.
 */
import type { CacheFile } from 'harness-world-process';

const te = new TextEncoder();

/** Throw a `TypeError` for a `CacheFile` path the archive must not carry. */
export function checkCachePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('harness-sandbox: a cache file needs a path');
  if (path.startsWith('/')) throw new TypeError(`harness-sandbox: a cache file path must be relative: ${JSON.stringify(path)}`);
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new TypeError(`harness-sandbox: a cache file path must have no empty, '.' or '..' segment: ${JSON.stringify(path)}`);
  if (path.includes('\0')) throw new TypeError('harness-sandbox: a cache file path holds a NUL byte');
  if (te.encode(path).length > 99) throw new TypeError(`harness-sandbox: a cache file path over 99 bytes: ${JSON.stringify(path.slice(0, 40))}…`);
}

/** Pack `files` into a ustar archive. */
export function ustar(files: readonly CacheFile[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const f of files) {
    checkCachePath(f.path);
    const mode = f.mode ?? 0o600;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new TypeError(`harness-sandbox: a cache file mode must be 0..0o777: ${f.path}`);
    const header = new Uint8Array(512);
    writeField(header, 0, f.path, 100);
    writeField(header, 100, mode.toString(8).padStart(7, '0'), 8);
    writeField(header, 108, '0000000', 8);
    writeField(header, 116, '0000000', 8);
    writeField(header, 124, f.bytes.length.toString(8).padStart(11, '0'), 12);
    writeField(header, 136, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 12);
    header[156] = 0x30; // '0': a regular file
    header.set(te.encode('ustar\u000000'), 257);
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (const b of header) sum += b;
    writeField(header, 148, sum.toString(8).padStart(6, '0'), 8);
    header[155] = 0x20;
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(f.bytes.length / 512) * 512);
    padded.set(f.bytes);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks end the archive
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function writeField(block: Uint8Array, at: number, value: string, len: number): void {
  block.set(te.encode(value).subarray(0, len - 1), at);
}
