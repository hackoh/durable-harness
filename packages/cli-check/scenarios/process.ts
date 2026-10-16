import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DurableSessions, type DurableSessionsOptions, durableSessions, type Harness, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { type HostedProcess, ProcessHost, type SpawnOptions, transcriptOf } from 'harness-world-process';
import { kernelSession, type ScenarioRun, settled } from '../src/scenario.ts';
import type { OpenWorld, Storage } from '../src/worlds.ts';

/**
 * The process harnesses (Claude Code, Codex, OpenCode, Cursor, the reference
 * harness) drive a child CLI and mirror what it writes into the log: a
 * `journal` step per batch of native records, `place` before a prompt goes
 * in, `tool.*` through the tool bridge, `fs` for workspace changes. Their
 * scripted CLIs answer `call <tool> <json args>` with one tool call and
 * echo anything else.
 */

/** A process host that remembers its children, so a scenario can kill any its World left behind. */
export class TrackedHost extends ProcessHost {
  readonly spawned: HostedProcess[] = [];
  override async spawn(runId: string, options: SpawnOptions): Promise<HostedProcess> {
    const proc = await super.spawn(runId, options);
    this.spawned.push(proc);
    return proc;
  }
  killAll(): void {
    for (const p of this.spawned) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {}
    }
  }
}

export const newHost = async (name: string) => new TrackedHost({ root: await mkdtemp(join(tmpdir(), `cli-check-${name}-`)) });

export const turnsEnded = (state: SessionState) => transcriptOf(state).filter((r) => (r.data as { type?: string } | undefined)?.type === 'turn').length;

/** Effects a process harness writes (on a sandbox, also the attach fact and the notes' acknowledgement). */
export const PROCESS_VOCABULARY = /^(journal|place|fs|model|tool\..+|recover|restart|chaos|handoff|steer|park|settle|host|sandbox\.(?:attach|notes))$/;

export const WRITE_PROMPT = 'call write_file {"path":"notes.txt","content":"hi"}';

/**
 * The basic process-harness session: a turn with one `write_file` call, then
 * an echo turn, each settled (its `turn` record in the transcript, nothing
 * pending, the log quiet).
 */
export async function processBasic(
  storage: Storage,
  harness: Harness,
  options: {
    name: string;
    host?: TrackedHost;
    startHarness?: string;
    sessionOptions?: Partial<DurableSessionsOptions>;
    /** The tool calls the session makes. Default: the one `write_file`. */
    expectCalls?: string[];
    dispose?: () => Promise<void>;
  }
): Promise<ScenarioRun> {
  const open: OpenWorld = await storage.open();
  const sessions: DurableSessions = durableSessions({ world: open.world, harness, ...options.sessionOptions });
  await open.serve(QUEUE_PREFIX, sessions.handler);
  const { sessionId } = await sessions.start({ ...(options.startHarness ? { harness: options.startHarness } : {}), prompt: WRITE_PROMPT });
  const turns = (n: number) => (s: SessionState) => turnsEnded(s) >= n;
  await settled(open.world, sessions, sessionId, turns(1), { what: 'the tool turn', timeoutMs: 90_000 });
  await sessions.send(sessionId, 'hello');
  await settled(open.world, sessions, sessionId, turns(2), { what: 'the echo turn', timeoutMs: 90_000 });
  return {
    session: kernelSession(() => open.world, () => sessions, sessionId, {
      harness: options.name,
      submissions: 2,
      calls: options.expectCalls ?? ['tool.write_file'],
      callsMatch: 'subsequence',
      callPattern: /^tool\./,
      vocabulary: PROCESS_VOCABULARY,
    }),
    dispose: async () => {
      await open.close();
      options.host?.killAll();
      await options.dispose?.();
    },
  };
}
