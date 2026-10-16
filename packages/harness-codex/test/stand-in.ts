/**
 * The Codex harness on the sandbox tier's stand-in (docs/workspaces.md §5.8):
 * the session factory (`sandboxSession`) over harness-world-sandbox's fake
 * Sandbox API, where every "VM" is a local relay child over fresh temp dirs
 * and every "Drive" a temp dir that outlives them, so a drive acquires its
 * machine exactly as on Vercel (`attachInDrive`, the `sandbox.attach` fact,
 * the fence, the `hw.sandbox` record), with no credentials. The CLI is the
 * fake app-server (`fake-app-server.mjs`) through the harness's test seam,
 * its model `fakeModel()` behind the drive's `gatewayHandler`.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DurableSessions, durableSessions, type HostTool, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { unsafeTools, workspaceTools } from 'harness-world-hands';
import { journalRecords, transcriptOf } from 'harness-world-process';
import { type FakeModel, type FakeModelOptions, fakeModel } from 'harness-world-process/reference/fake-model';
import { sandboxSession } from 'harness-world-sandbox';
import { sessionName } from 'harness-world-sandbox/names';
import { type FakeApiOptions, FakeSandboxApi } from 'harness-world-sandbox/testing/fake-api';
import { type CodexHarnessOptions, codexHarness } from '../src/harness.ts';
import { rolloutStream, THREAD_STREAM, type ThreadRecord } from '../src/rollout.ts';

export const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));

/** What every stand-in test sets: the stand-in's flag, and not Vercel. */
export function standInEnv(): void {
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
}

/** One test's platform: the fake Sandbox API, the fake model, and every world, to close after. */
export interface Rig {
  api: FakeSandboxApi;
  model: FakeModel;
  worlds: LocalWorld[];
  /** What the harness and the factory logged, in order. */
  logs: { message: string; fields?: Record<string, unknown> }[];
  dispose(): Promise<void>;
}

export async function rig(options: { model?: FakeModelOptions; api?: FakeApiOptions } = {}): Promise<Rig> {
  const api = new FakeSandboxApi(options.api);
  const model = await fakeModel(options.model);
  const worlds: LocalWorld[] = [];
  return {
    api,
    model,
    worlds,
    logs: [],
    async dispose() {
      for (const w of worlds.splice(0)) await w.close?.();
      await model.close();
      await api.dispose();
    },
  };
}

export interface SessionOptions {
  /** Codex's own shell and apply_patch (no line: the harness's default, off). */
  builtins?: boolean;
  tools?: HostTool[];
  /** The fake's switches (`FAKE_CODEX_*`), as `sandbox({ env })` would pass them. */
  env?: Record<string, string>;
  chaos?: boolean;
  recover?: boolean;
  crash?: () => void;
  confirmMs?: number;
  budget?: { turnUsd?: number; sessionUsd?: number };
  /** `sandbox({ commandTimeoutMs })`. */
  commandTimeoutMs?: number;
  /** Anything else the harness takes. */
  harness?: Partial<CodexHarnessOptions>;
}

/** A "machine" driving the session: a world over `dataDir` and the harness on the stand-in's factory. */
export async function session(dataDir: string, r: Rig, opts: SessionOptions = {}): Promise<{ world: LocalWorld; sessions: DurableSessions }> {
  const world = createWorld({ dataDir, recoverActiveRuns: opts.recover ?? false });
  r.worlds.push(world);
  const log = (message: string, fields?: Record<string, unknown>) => void r.logs.push({ message, ...(fields ? { fields } : {}) });
  const acquire = sandboxSession({
    spec: { vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: Infinity }, image: 'stand-in' },
    test: { api: r.api, allowDegraded: true, allowUnauthenticatedModel: true },
    log,
  });
  const sessions = durableSessions({
    world,
    harness: codexHarness({
      ...(opts.builtins !== undefined ? { builtins: opts.builtins } : {}),
      tools: opts.tools ?? (opts.builtins ? unsafeTools({ confirmMs: opts.confirmMs ?? 3000 }) : workspaceTools({ confirmMs: opts.confirmMs ?? 3000 })),
      machine: { acquire, env: { FAKE_CODEX_MODEL: 'remote', ...opts.env }, ...(opts.budget ? { budget: opts.budget } : {}), ...(opts.commandTimeoutMs ? { commandTimeoutMs: opts.commandTimeoutMs } : {}) },
      test: { command: process.execPath, args: [FAKE] },
      gatewayUrl: r.model.url,
      credential: async () => 'test-key',
      model: 'openai/gpt-5.4-mini',
      log,
      ...opts.harness,
    }),
    ...(opts.chaos ? { chaos: true, crash: opts.crash ?? (() => {}) } : {}),
  });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  return { world, sessions };
}

export const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

export async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const turnsEnded = (state: SessionState) => transcriptOf(state).filter((r) => r.data.type === 'turn').length;
export const waitTurns = (sessions: DurableSessions, id: string, n: number, timeoutMs?: number) =>
  until(async () => {
    const s = await sessions.inspect(id);
    return turnsEnded(s) >= n ? s : undefined;
  }, timeoutMs);

export const threadOf = (state: SessionState) => journalRecords<ThreadRecord>(state, THREAD_STREAM).at(-1)?.data;
export const rolloutLines = (state: SessionState) => {
  const t = threadOf(state);
  return t ? journalRecords<string>(state, rolloutStream(t.threadId)).map((r) => r.data) : [];
};
export const fileLines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);

/** The session's sandbox and Drive name on the stand-in. */
export const nameOf = (sessionId: string) => sessionName('prj_stand_in', sessionId);
/** The session's current "VM". */
export const vmOf = (r: Rig, sessionId: string): { sessionId: string; relay?: { config: { cacheRoot: string; modelPort: number } } } | undefined => r.api.vms.get(nameOf(sessionId));
/** The current VM's cache dirs (its `/var/lib/dh/s`). */
export const cacheRootOf = (r: Rig, sessionId: string) => vmOf(r, sessionId)!.relay!.config.cacheRoot;
/** The session's Drive (its `/workspace`). */
export const driveOf = (r: Rig, sessionId: string) => r.api.driveDir(nameOf(sessionId));
/** The rollout file on the current VM. */
export const rolloutFile = (r: Rig, sessionId: string, state: SessionState) => join(cacheRootOf(r, sessionId), 'codex-home', threadOf(state)!.path);
/** Tear the session's VM down (its relay, rootfs and cache dirs go); the Drive stays. */
export async function tearDown(r: Rig, sessionId: string): Promise<void> {
  await (await r.api.getSandbox(nameOf(sessionId)))?.delete();
}
