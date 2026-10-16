import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { EffectRecord } from 'durable-harness';
import type { Checkpoint } from './harness.ts';
import { readLedger } from './tools.ts';

/** What the crash drill asks, and the system prompt both processes use. */
export const CRASH_PROMPT = 'Pay $5 to alice@example.com with the memo "lunch". Then tell me the payment id.';
export const CRASH_INSTRUCTIONS =
  'You are a careful assistant with a payment tool. If a payment comes back interrupted or with an unknown outcome, do not retry it: tell the user. Keep answers short.';

export async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const child = (args: string[]) =>
  spawn(process.execPath, ['--import', 'tsx', 'src/crash-child.ts', ...args], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

/**
 * Start a session in a child process (src/crash-child.ts) that asks for a
 * payment, wait until the payment tool has written its ledger line, and
 * SIGKILL the child: the side effect happened, its result never reached the
 * log. Returns the World's data dir, the ledger and the session id, for
 * another process to recover from (`recoverInChild`).
 */
export async function crashDuringPayment(model: 'scripted' | (string & {})) {
  const dataDir = await mkdtemp(join(tmpdir(), 'durable-ai-sdk-'));
  const ledger = join(dataDir, 'ledger.jsonl');
  const victim = child([dataDir, ledger, model]);
  let out = '';
  let err = '';
  victim.stdout.on('data', (d) => (out += d));
  victim.stderr.on('data', (d) => (err += d));
  const exited = new Promise<NodeJS.Signals | null>((resolve) => victim.on('exit', (_code, signal) => resolve(signal)));
  let sessionId: string;
  try {
    sessionId = await until(async () => {
      if (victim.exitCode !== null) throw new Error(`crash child exited early (${victim.exitCode}): ${err.slice(-2000)}`);
      const line = out.split('\n').find((l) => l.startsWith('{'));
      return line ? (JSON.parse(line) as { sessionId: string }).sessionId : undefined;
    }, 60_000, 'the child to start a session');
    // The tool appends the ledger line, then waits a minute for its "bank".
    await until(async () => ((await readLedger(ledger)).length > 0 ? true : undefined), 90_000, 'the payment to hit the ledger');
  } finally {
    victim.kill('SIGKILL');
  }
  const signal = await exited;
  return { dataDir, ledger, sessionId, signal, childPid: victim.pid! };
}

/** What the recovering process saw in the log once the turn checkpointed. */
export interface Recovery {
  pid: number;
  /** When it started its World (ms since the epoch, this machine's clock). */
  startedAt: number;
  /** When it first saw the payment step resolved as failed. */
  interruptedAt?: number;
  checkpointedAt: number;
  submissions: string[];
  effects: Pick<EffectRecord, 'key' | 'name' | 'status' | 'replay' | 'error'>[];
  checkpoint: Checkpoint;
  /** With the scripted model: every request the recovering process made. */
  modelCalls?: LanguageModelV4Prompt[];
}

/**
 * Recover a session in a new OS process (src/crash-child.ts --recover) that
 * never drove it: it opens the same World with recovery on, its `start()`
 * redelivers the session, and the open steps' anchor names a process that
 * is gone (its pid), so the kernel resolves them at once. Resolves with what
 * that process saw when the turn checkpointed, after it exited.
 */
export async function recoverInChild(opts: { dataDir: string; ledger: string; sessionId: string; model: 'scripted' | (string & {}) }) {
  const { dataDir, ledger, sessionId, model } = opts;
  const recoverer = child([dataDir, ledger, model, '--recover', sessionId]);
  let out = '';
  let err = '';
  recoverer.stdout.on('data', (d) => (out += d));
  recoverer.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => recoverer.kill('SIGKILL'), 180_000);
  const code = await new Promise<number | null>((resolve) => recoverer.on('exit', (c) => resolve(c)));
  clearTimeout(timer);
  const line = out.split('\n').findLast((l) => l.startsWith('{'));
  if (code !== 0 || !line) throw new Error(`the recovering process exited ${code}: ${err.slice(-2000)}`);
  return JSON.parse(line) as Recovery;
}
