import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The stock Workflow CLI (`@workflow/cli`, pinned in this package), run the
 * way a user runs it: its own process, its own World instance, JSON output.
 * Nothing here reads the World directly; the checks compare what the CLI
 * prints with what the kernel and the World say (invariants.ts).
 */

/**
 * How long one CLI call may take. Only a call that fails waits this long, so
 * it is generous: each call is a cold Node process, and on a CI runner a
 * session's views run several at once on a few cores.
 */
export const CLI_TIMEOUT_MS = 60_000;

/** Its bin, as `pnpm install` links it into this package. */
export const WORKFLOW_BIN = fileURLToPath(new URL('../node_modules/.bin/workflow', import.meta.url));
/**
 * The CLI resolves `-b <package>` from its working directory
 * (`createRequire(cwd/package.json)`), so it runs from this package, which
 * depends on `@workflow/world-postgres`.
 */
const CWD = fileURLToPath(new URL('..', import.meta.url));

/** Which World the CLI reads, and how it is told (flags and env, never a secret on argv). */
export type Target =
  | { world: 'local'; dataDir: string }
  | { world: 'postgres'; url: string }
  | { world: 'vercel'; project: string; team: string; environment: string; token: string };

export interface CliCall {
  /** What was run, after `workflow` (no secrets: the Vercel token goes in the env). */
  argv: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  /** Stopped by the caller once it had what it needed (`options.enough`), before the CLI exited on its own. */
  stoppedEarly: boolean;
  /** stderr lines that report an error (see `errorLines`). */
  errors: string[];
}

function targetOf(target: Target): { args: string[]; env: Record<string, string> } {
  switch (target.world) {
    case 'local':
      return { args: [], env: { WORKFLOW_LOCAL_DATA_DIR: target.dataDir } };
    case 'postgres':
      return { args: ['-b', '@workflow/world-postgres'], env: { WORKFLOW_POSTGRES_URL: target.url } };
    case 'vercel':
      return {
        args: ['-b', 'vercel', '--project', target.project, '--team', target.team, '-e', target.environment],
        env: { WORKFLOW_VERCEL_AUTH_TOKEN: target.token },
      };
  }
}

/**
 * stderr lines a user would read as something going wrong. The CLI's own
 * chatter is not: `[Debug]`, `[Info]` and `[Warn]` lines, and the banner box
 * (printed to stderr in `--json` mode).
 */
export function errorLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.trim() && !/^\[(Debug|Info|Warn)\]/.test(line) && !/^[│┌└]/.test(line))
    .filter((line) => /\[Error\]|Error\b|Failed|^\s+at |^\{"error"/.test(line));
}

/**
 * Run `workflow <args> --json` against `target`. Never throws for a CLI
 * failure: the call says what happened. `enough(stdout, stderr)`: stop the
 * CLI as soon as it holds (a stream read that has printed what it needed to,
 * of a stream that is meant to stay open).
 */
export function workflow(
  target: Target,
  args: string[],
  options: { timeoutMs?: number; json?: boolean; enough?: (stdout: string, stderr: string) => boolean } = {}
): Promise<CliCall> {
  const { args: targetArgs, env } = targetOf(target);
  const argv = [...args, ...targetArgs, ...(options.json === false ? [] : ['--json'])];
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stoppedEarly = false;
    const child = spawn(WORKFLOW_BIN, argv, {
      cwd: CWD,
      env: {
        ...process.env,
        // A clean slate: only the target's settings reach the CLI.
        WORKFLOW_LOCAL_DATA_DIR: undefined,
        WORKFLOW_POSTGRES_URL: undefined,
        WORKFLOW_TARGET_WORLD: undefined,
        ...env,
        WORKFLOW_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = () => {
      try {
        child.kill('SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? CLI_TIMEOUT_MS);
    const check = () => {
      if (!stoppedEarly && !timedOut && options.enough?.(stdout, stderr)) {
        stoppedEarly = true;
        stop();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      check();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      check();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ argv, code: stoppedEarly || timedOut ? null : code, stdout, stderr, ms: Date.now() - started, timedOut, stoppedEarly, errors: errorLines(stderr) });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ argv, code: null, stdout, stderr: `${stderr}\n${String(err)}`, ms: Date.now() - started, timedOut, stoppedEarly, errors: [String(err)] });
    });
  });
}

/** The JSON a call printed. Throws, quoting the call, if there is none. */
export function jsonOf<T = unknown>(call: CliCall): T {
  try {
    return JSON.parse(call.stdout) as T;
  } catch {
    throw new Error(`workflow ${call.argv.join(' ')}: no JSON on stdout (exit ${call.code})\n${call.errors.join('\n') || call.stderr.slice(-2000)}`);
  }
}

/**
 * A list a call printed: runs and hooks print `{ data, cursor, hasMore }`,
 * steps, events, streams and sleeps a bare array.
 */
export function listOf<T = Record<string, any>>(call: CliCall): T[] {
  const value = jsonOf<unknown>(call);
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) return (value as { data: T[] }).data;
  throw new Error(`workflow ${call.argv.join(' ')}: expected a list, got ${call.stdout.slice(0, 200)}`);
}

/** The newline-delimited JSON `inspect stream --json` prints, one value per chunk it decoded. */
export function ndjsonOf(call: CliCall): unknown[] {
  return call.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}
