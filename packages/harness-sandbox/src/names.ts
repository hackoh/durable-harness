/**
 * The names of a session's sandbox and Drive (docs/workspaces.md §5.7): one
 * deterministic name per (project, session), `dh-` and 20 base32 characters
 * (100 bits) of `sha256(projectId "\n" sessionId)`. Both the named sandbox
 * and the Drive carry it (they live in separate namespaces), so no runtime
 * needs a record to find them, and a sweep that takes only `dh-probe-` names
 * can never take a session's (base32 has no hyphen).
 *
 * With them, the project the hash takes (`resolveProjectId`) and the region
 * a Drive goes to when none is named (`defaultRegion`). A leaf: it loads neither the session factory (which claims the machine
 * brand at load) nor the relay link (`ws`), so `durable-harness/sandbox` can
 * name a session's sandbox without them (`harness-world-sandbox/names`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The name of a session's sandbox and of its Drive. */
export function sessionName(projectId: string, sessionId: string): string {
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('harness-sandbox: a project id is required to name a session\'s sandbox');
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('harness-sandbox: a session id is required to name its sandbox');
  return `dh-${base32(createHash('sha256').update(`${projectId}\n${sessionId}`).digest()).slice(0, 20)}`;
}

/**
 * The project id the names hash (synchronous): `credentials.projectId`, else the
 * deployment's `VERCEL_PROJECT_ID`, else the linked project of a laptop
 * (`.vercel/project.json` from the working directory up, as `vercel link`
 * wrote it).
 */
export function resolveProjectId(credentials?: { projectId?: string }): string {
  if (credentials?.projectId) return credentials.projectId;
  if (process.env.VERCEL_PROJECT_ID) return process.env.VERCEL_PROJECT_ID;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    try {
      const linked = JSON.parse(readFileSync(join(dir, '.vercel', 'project.json'), 'utf8')) as { projectId?: unknown };
      if (typeof linked.projectId === 'string' && linked.projectId) return linked.projectId;
    } catch {}
    if (dirname(dir) === dir) break;
  }
  throw new Error('harness-sandbox: no Vercel project for the sandbox: set VERCEL_PROJECT_ID, pass sandbox({ credentials }), or run `vercel link`');
}

/** The regions `@vercel/sandbox` 3.7.0 names (`SandboxRegion`). */
export const SANDBOX_REGIONS: ReadonlySet<string> = new Set(['iad1', 'sfo1', 'cle1', 'cdg1', 'fra1', 'arn1', 'sin1', 'pdx1', 'lhr1', 'icn1', 'bom1', 'cpt1', 'dub1', 'gru1', 'hkg1', 'syd1', 'yul1', 'hnd1', 'kix1']);

/** Where a session's Drive (and the base it boots) goes when the descriptor names no region: `VERCEL_REGION` when Vercel Sandbox lists it, else `iad1` (§3.1). */
export function defaultRegion(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const r = env.VERCEL_REGION;
  return r && SANDBOX_REGIONS.has(r) ? r : 'iad1';
}
