import type { World } from '@workflow/world';
import { decodeLine, encodeLine } from './streams.ts';

/**
 * The session's blob stream: content kept outside the log, addressed by the
 * SHA-256 of its bytes and append-only, one stream line per blob (or per
 * piece of a large one). Text is stored as text (`{ h, s }`, its bytes the
 * UTF-8 of `s`), bytes that are not text as base64 (`{ h, b }`): the hash
 * names the bytes either way, so text and the same bytes written as bytes
 * are one blob. The log names a blob by its hash; the blob is
 * written before the event that names it, so a blob the log names and the
 * stream does not hold means the World lost data.
 *
 * Shared by everything that offloads text from a session's log (a process
 * harness's native journal, the document-backed workspace's large files): a
 * blob is the same bytes whoever wrote it, so a second writer of one hash
 * writes nothing new to read. A blob written by work that never reported (a
 * crash before its outcome) is harmless garbage: nothing names it.
 *
 * Browser-safe: SHA-256 through WebCrypto.
 */
export const blobStreamName = (runId: string) => `${runId}_blobs`;

/**
 * A blob longer than this many characters is written as several lines: a
 * World stream chunk is at most 10 MB on Vercel, and 2M characters of text
 * are at most 8 MB of UTF-8.
 */
export const BLOB_PIECE_CHARS = 2 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a blob holds: text, or bytes that are not text. */
export type BlobContent = string | Uint8Array;

/** SHA-256 of `content`'s bytes (a string's UTF-8), as lowercase hex. */
export async function sha256Hex(content: BlobContent): Promise<string> {
  const bytes = typeof content === 'string' ? encoder.encode(content) : content;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** `bytes` as base64 (browser-safe, no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  // In chunks (String.fromCharCode takes its arguments on the stack) of a
  // multiple of 3 bytes, so only the last chunk is padded and the joined
  // string is one base64 string.
  const chunk = 3 * 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) out += btoa(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  return out;
}

/** The bytes of a base64 string; throws on one that is not base64. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Append `content` to the session's blob stream and return its hash (of its
 * bytes). Text is written as text, bytes as base64. Resolves once every piece
 * is written: write it before the event that names it. `hash` skips hashing
 * when the caller already has it.
 */
export async function writeBlob(
  world: Pick<World, 'streams'>,
  runId: string,
  content: BlobContent,
  options: { hash?: string; pieceChars?: number } = {}
): Promise<string> {
  const hash = options.hash ?? (await sha256Hex(content));
  const size = Math.max(1, options.pieceChars ?? BLOB_PIECE_CHARS);
  const name = blobStreamName(runId);
  const text = typeof content === 'string' ? content : bytesToBase64(content);
  const key = typeof content === 'string' ? 's' : 'b';
  const n = Math.max(1, Math.ceil(text.length / size));
  for (let p = 0; p < n; p++) {
    const piece = text.slice(p * size, (p + 1) * size);
    const line = n === 1 ? { h: hash, [key]: piece } : { h: hash, p, n, [key]: piece };
    await world.streams.write(runId, name, encoder.encode(`${encodeLine(line)}\n\n`));
  }
  return hash;
}

/**
 * Every text blob in the session's blob stream whose bytes match its hash (a
 * blob is only ever trusted for the hash it is named by; the first good copy
 * of one wins). Blobs of bytes that are not text are left out
 * (`readBlobContents` has them). No stream yet is no blobs; any other failed
 * read is thrown as it is.
 */
export async function readBlobs(world: Pick<World, 'streams'>, runId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [h, content] of await readBlobContents(world, runId)) if (typeof content === 'string') out.set(h, content);
  return out;
}

/**
 * Every blob in the session's blob stream whose bytes match its hash: text as
 * a string, bytes that are not text as a `Uint8Array`. As `readBlobs`.
 */
export async function readBlobContents(world: Pick<World, 'streams'>, runId: string): Promise<Map<string, BlobContent>> {
  const name = blobStreamName(runId);
  let buffer = '';
  let cursor: string | undefined;
  for (;;) {
    let page: Awaited<ReturnType<World['streams']['getChunks']>>;
    try {
      page = await world.streams.getChunks(runId, name, cursor ? { cursor } : {});
    } catch (err) {
      if ((await world.streams.list(runId).catch(() => [name])).includes(name)) throw err;
      return new Map();
    }
    for (const chunk of page.data) buffer += decoder.decode(chunk.data, { stream: true });
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  const out = new Map<string, BlobContent>();
  const candidates: { h: string; s: string; bytes: boolean }[] = [];
  const pieces = new Map<string, (string | undefined)[]>();
  for (const line of buffer.split('\n')) {
    if (!line) continue;
    let blob: { h?: unknown; s?: unknown; b?: unknown; p?: unknown; n?: unknown };
    try {
      blob = decodeLine(line) as typeof blob;
    } catch {
      continue;
    }
    if (typeof blob !== 'object' || blob === null || typeof blob.h !== 'string') continue;
    // A text line has `s`, a line of bytes `b` (base64); never both.
    const bytes = typeof blob.b === 'string' && blob.s === undefined;
    const s = bytes ? (blob.b as string) : blob.s;
    if (typeof s !== 'string') continue;
    if (typeof blob.n !== 'number' || typeof blob.p !== 'number') {
      candidates.push({ h: blob.h, s, bytes });
      continue;
    }
    // A blob in pieces: complete once every piece is here (the first copy of each counts).
    const key = `${blob.h}:${blob.n}:${bytes ? 'b' : 's'}`;
    const parts = pieces.get(key) ?? new Array<string | undefined>(blob.n);
    pieces.set(key, parts);
    if (blob.p >= 0 && blob.p < blob.n) parts[blob.p] ??= s;
    if (parts.filter((x) => x !== undefined).length === blob.n) {
      candidates.push({ h: blob.h, s: parts.join(''), bytes });
      pieces.delete(key);
    }
  }
  for (const { h, s, bytes } of candidates) {
    if (out.has(h)) continue;
    let content: BlobContent;
    try {
      content = bytes ? base64ToBytes(s) : s;
    } catch {
      continue;
    }
    if ((await sha256Hex(content)) === h) out.set(h, content);
  }
  return out;
}
