import { parse, stringify } from 'devalue';

/**
 * Payload codec for everything this kernel writes into the event log.
 *
 * Uses the same wire shape the Workflow runtime does (a 4-byte `devl` format
 * prefix, then devalue text) so `workflow web`, `wf inspect` and the Vercel
 * dashboard can render harness payloads exactly like ordinary step I/O.
 */
const DEVALUE_PREFIX = 'devl';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(value: unknown): Uint8Array {
  const body = encoder.encode(stringify(value));
  const out = new Uint8Array(4 + body.length);
  out.set(encoder.encode(DEVALUE_PREFIX), 0);
  out.set(body, 4);
  return out;
}

export function decode(data: unknown): unknown {
  if (data === undefined || data === null) return data;
  if (!(data instanceof Uint8Array)) {
    // Worlds may hand back already-decoded JSON for legacy payloads.
    return data;
  }
  const prefix = decoder.decode(data.subarray(0, 4));
  if (prefix !== DEVALUE_PREFIX) {
    throw new Error(
      `harness-world: unsupported payload format "${prefix}" (only unencrypted devalue payloads are supported)`
    );
  }
  return parse(decoder.decode(data.subarray(4)));
}
