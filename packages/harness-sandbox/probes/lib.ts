/**
 * What every probe shares: names, logging, a shell helper, and cleanup.
 *
 * The probes check the Vercel Sandbox behaviour the sandbox tier relies on
 * (docs/workspaces.md §11.2, results in docs/sandbox-probes.md). Each one is
 * a short script that creates what it needs, prints `[probe] key: value`
 * lines, and deletes every sandbox, snapshot and Drive it made, whatever
 * happened. Run one from a directory linked to a scratch project:
 *
 *   cd <dir> && vercel link --project <scratch> --scope <team>
 *   node <repo>/packages/harness-sandbox/probes/<probe>.ts
 *
 * Credentials come from the Vercel CLI's login through `@vercel/oidc`, which
 * mints a development token for the linked project; nothing reads or prints
 * a token. Never point a probe at a production project: P0.15 creates Drives
 * until the platform refuses one.
 */
import { randomBytes } from 'node:crypto';
import { Drive, Sandbox } from '@vercel/sandbox';

/** Every name a probe creates starts with this, so a sweep finds leftovers. */
export const PREFIX = 'dh-probe';

/**
 * What a sweep lists by: the prefix and its hyphen. A real session's name is
 * `dh-<base32>`, which can start with `dh-probe` but never `dh-probe-` (base32
 * has no hyphen), so a sweep can't take a session's sandbox or Drive.
 */
export const SWEEP_PREFIX = `${PREFIX}-`;

/** Tags on every probe sandbox. */
export const TAGS = { purpose: 'dh-sandbox-probe' };

/** A unique name for this run: `dh-probe-<what>-<6 hex>`. */
export function probeName(what: string, id = runId): string {
  const name = `${PREFIX}-${what}-${id}`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new TypeError(`not a valid sandbox name: ${name}`);
  return name;
}

/** One id per process, shared by every name a probe makes. */
export const runId = randomBytes(3).toString('hex');

export const results: Record<string, unknown> = {};

/** Print one result line, and keep it for `summary()`. */
export function log(key: string, value: unknown): void {
  results[key] = value;
  console.log(`[probe] ${key}:`, typeof value === 'string' ? value : JSON.stringify(value));
}

/** The parts of an SDK error worth printing: never headers or bodies beyond the error code. */
export function describeError(err: unknown): { msg: string; status?: number; code?: string } {
  const e = err as { message?: string; response?: { status?: number }; json?: { error?: { code?: string } } };
  return { msg: String(e?.message ?? err).slice(0, 300), status: e?.response?.status, code: e?.json?.error?.code };
}

/** Run `fn`, log how long it took (or the error), and return its result. */
export async function timed<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    const r = await fn();
    log(`${key}.ms`, Date.now() - t);
    return r;
  } catch (err) {
    log(`${key}.error`, { ms: Date.now() - t, ...describeError(err) });
    throw err;
  }
}

/** Like `timed`, but a failure is a result, not the end of the probe. */
export async function attempt<T>(key: string, fn: () => Promise<T>): Promise<{ ok: true; value: T; ms: number } | { ok: false; ms: number; error: ReturnType<typeof describeError> }> {
  const t = Date.now();
  try {
    const value = await fn();
    const r = { ok: true as const, value, ms: Date.now() - t };
    log(key, { ok: true, ms: r.ms });
    return r;
  } catch (err) {
    const r = { ok: false as const, ms: Date.now() - t, error: describeError(err) };
    log(key, r);
    return r;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ShResult {
  exit: number | null;
  out: string;
  err: string;
}

/** `bash -lc script` in the VM, as the default user unless `sudo`. */
export async function sh(sb: Sandbox, script: string, opts: { sudo?: boolean; tail?: number } = {}): Promise<ShResult> {
  const c = await sb.runCommand({ cmd: 'bash', args: ['-lc', script], sudo: opts.sudo });
  const tail = opts.tail ?? 2000;
  return { exit: c.exitCode, out: (await c.stdout()).trim().slice(-tail), err: (await c.stderr()).trim().slice(-500) };
}

/**
 * Start `vm/echo-server.js` on `port` (detached) and wait for its `/health`
 * through the port ingress. Returns the port's public base URL; the sandbox
 * must have been created with `port` in `ports`.
 */
export async function startEchoServer(sb: Sandbox, port = 3000): Promise<string> {
  const { readFileSync } = await import('node:fs');
  await sb.writeFiles([{ path: '/tmp/echo-server.js', content: readFileSync(new URL('./vm/echo-server.js', import.meta.url)) }]);
  await sb.runCommand({ cmd: 'bun', args: ['/tmp/echo-server.js'], env: { PORT: String(port) }, detached: true });
  const url = sb.domain(port).replace(/\/+$/, '');
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${url}/health`, { cache: 'no-store' });
      if (r.ok) return url;
    } catch {}
    await sleep(250);
  }
  throw new Error(`echo server on ${port} never answered /health`);
}

/** p50/p95/max of a list of samples, in the samples' unit. */
export function percentiles(samples: number[]): { n: number; p50: number; p95: number; max: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? NaN;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? NaN };
}

/** Base options for a probe sandbox: short-lived, non-persistent, tagged. */
export const BASE = { persistent: false, timeout: 6 * 60_000, tags: TAGS } as const;

/**
 * What a probe created, deleted in `cleanup()` in reverse order: sandboxes
 * first (a Drive can't be deleted while attached), then snapshots, then
 * Drives, retried while they detach.
 */
export const created = { sandboxes: new Set<string>(), snapshots: new Set<string>(), drives: new Set<string>() };

/**
 * Register a name for cleanup and return it. Call it before the `create`
 * that makes it, not after: a create can succeed on the platform and still
 * reject here (a timeout, a sibling in `Promise.all` failing), and `cleanup()`
 * takes a 404 for a name that was never made.
 */
export function track(kind: 'sandbox' | 'drive', name: string): string {
  (kind === 'sandbox' ? created.sandboxes : created.drives).add(name);
  return name;
}

/** Delete what this run created; returns the names it couldn't delete. */
export async function cleanup(): Promise<string[]> {
  const undeleted: string[] = [];
  for (const name of created.sandboxes) {
    try {
      const s = await Sandbox.get({ name });
      await s.delete({ deleteOrphanSnapshots: true });
      log(`cleanup.sandbox.${name}`, 'deleted');
    } catch (err) {
      const e = describeError(err);
      if (e.status !== 404) undeleted.push(name);
      log(`cleanup.sandbox.${name}`, e.status === 404 ? 'never made' : e);
    }
  }
  if (created.snapshots.size) {
    const { Snapshot } = await import('@vercel/sandbox');
    for (const snapshotId of created.snapshots) {
      try {
        await (await Snapshot.get({ snapshotId })).delete();
        log(`cleanup.snapshot.${snapshotId}`, 'deleted');
      } catch (err) {
        const e = describeError(err);
        if (e.status !== 404) undeleted.push(snapshotId);
        log(`cleanup.snapshot.${snapshotId}`, e);
      }
    }
  }
  // A Drive can be deleted only some seconds after its sandbox detached.
  for (const name of created.drives) {
    for (let i = 0; ; i++) {
      try {
        await (await Drive.get({ name })).delete();
        log(`cleanup.drive.${name}`, { deleted: true, tries: i + 1 });
        break;
      } catch (err) {
        const e = describeError(err);
        if (e.status === 404) break;
        if (i === 30) {
          undeleted.push(name);
          log(`cleanup.drive.${name}`, e);
          break;
        }
        await sleep(2000);
      }
    }
  }
  // Every probe's leftovers in the project, this run's or another's.
  log('cleanup.remaining', await leftovers());
  return undeleted;
}

/** Every probe sandbox (by name and tag) and Drive (by name) in the project, every page of each list. */
export async function listProbes(): Promise<{ sandboxes: { name: string; status: string }[]; drives: Drive[] }> {
  const s = await (await Sandbox.list({ namePrefix: SWEEP_PREFIX, sortBy: 'name', limit: 50 })).toArray();
  const d = await (await Drive.list({ namePrefix: SWEEP_PREFIX, sortBy: 'name', limit: 50 })).toArray();
  return {
    sandboxes: s.filter((x) => x.name.startsWith(SWEEP_PREFIX) && x.tags?.purpose === TAGS.purpose),
    drives: d.filter((x) => x.name.startsWith(SWEEP_PREFIX)),
  };
}

/** Every probe sandbox and Drive still in the project. */
export async function leftovers(): Promise<{ sandboxes: string[]; drives: string[] }> {
  const { sandboxes, drives } = await listProbes();
  return { sandboxes: sandboxes.map((x) => `${x.name}:${x.status}`), drives: drives.map((x) => x.name) };
}

/** The exit code of a probe run: 1 if its body threw, or cleanup couldn't delete something it made (or didn't finish: `undefined`). */
export function exitCode(failed: boolean, undeleted: string[] | undefined): 0 | 1 {
  return failed || !undeleted || undeleted.length > 0 ? 1 : 0;
}

/**
 * Run a probe's body, then clean up and exit, whatever happened: 0 if the
 * body finished and everything it made is deleted, 1 otherwise, so a
 * scripted re-run can tell a failed probe from a passing one. (Another
 * run's leftovers are listed, but don't fail this one: probes can run side
 * by side.)
 */
export async function probe(body: () => Promise<void>): Promise<never> {
  let failed = false;
  let undeleted: string[] | undefined;
  try {
    await body();
  } catch (err) {
    failed = true;
    log('fatal', String((err as Error)?.stack ?? err).slice(0, 800));
  } finally {
    undeleted = await cleanup().catch((err) => {
      log('cleanup.fatal', describeError(err));
      return undefined;
    });
    if (undeleted?.length) log('cleanup.undeleted', undeleted);
  }
  process.exit(exitCode(failed, undeleted));
}
