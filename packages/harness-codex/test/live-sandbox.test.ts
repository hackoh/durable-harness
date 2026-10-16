/**
 * L2 (docs/workspaces.md §11.4): Codex on Vercel Sandbox for real. The
 * session factory boots VM A from a base built by the recipe (the relay, the
 * pinned Codex, bwrap, the agent user), the real `codex app-server` runs
 * there as `agent` with its built-ins on, its model calls go through the
 * VM's model port to this process's `gatewayHandler` and on to the AI
 * Gateway with this machine's credential. Turn 1 writes a file on the Drive
 * and learns a code word, and tries what a hostile model would (a bare write
 * to `CODEX_HOME`, which bwrap denies and Codex then offers to rerun without
 * the sandbox; the placeholder in its env and in every process's
 * `/proc/<pid>/environ`, where app-server's is root's: its binary is
 * execute-only, so it is not dumpable, and the model port admits it by the
 * key and its pid). Turn 2 runs a long command, and VM A is deleted under
 * it: the drive re-attaches to VM B in the same invocation, and the dangling
 * call gets its output from the log (`thread/inject_items`). Turn 3, from a
 * new process, recalls the word through `thread/resume` from the log and
 * reads the file back. Every request Codex sends through the port is logged
 * (P0.7), and the bwrap self-test's pick (P0.10).
 *
 * Gated behind `DH_LIVE_SANDBOX=1`. Run it from a directory linked to the
 * project (the SDK's and the Gateway's development token come from `vercel
 * link`). Everything it creates is named `dh-probe-a6*` and tagged, so
 * harness-sandbox's `probes/sweep.ts` finds what a killed run left, and
 * `afterAll` deletes the sandboxes, the Drive and the base it built.
 */
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { unsafeTools } from 'harness-world-hands';
import { type AcquireMachine, journalRecords, transcriptOf } from 'harness-world-process';
import { devRelayArtifact, prepareBase, sandboxSession } from 'harness-world-sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, created, probeName, TAGS, track } from '../../harness-sandbox/probes/lib.ts';
import { codexHarness } from '../src/harness.ts';
import { rolloutStream, summarizeRollout, THREAD_STREAM } from '../src/rollout.ts';
import { BUILTIN_INSTRUCTIONS, LIVE_MODEL, recording, report, type Seen } from './live-setup.ts';
import { tmp, until } from './stand-in.ts';

const LIVE = process.env.DH_LIVE_SANDBOX === '1';

beforeAll(() => {
  // The test seam (the names) is guarded like the stand-in.
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
});

// A Drive can be deleted only once it detached (6-20 s after its VM went, P0.5): the cleanup retries for longer than a hook's default.
afterAll(async () => {
  if (LIVE) expect(await cleanup()).toEqual([]);
}, 180_000);

const turnsEnded = (state: SessionState) => transcriptOf(state).filter((r) => r.data.type === 'turn').length;
const lastSaid = (state: SessionState) => (transcriptOf(state).filter((r) => r.data.type === 'message' && r.data.role === 'assistant').at(-1)?.data as { text?: string } | undefined)?.text ?? '';
const shellOutputs = (state: SessionState) =>
  state.effectOrder
    .filter((e) => e.name === 'tool.shell')
    .map((e) => String(e.output ?? e.error?.message ?? ''))
    .join('\n');
/** The shell calls whose command contains `text`. */
const shellCalls = (state: SessionState, text: string) => state.effectOrder.filter((e) => e.name === 'tool.shell' && String((e.input as { command?: string })?.command ?? '').includes(text));

describe.runIf(LIVE)('live: Codex on Vercel Sandbox (L2)', () => {
  it(
    'turn 1 on VM A writes a file and learns a code word; VM A deleted, the Drive kept; turn 2 on VM B recalls it from the log and reads the file',
    async () => {
      const builder = track('sandbox', probeName('a6base'));
      const base = await prepareBase({ region: 'iad1', relay: await devRelayArtifact(), name: builder, tags: TAGS, log: (m, f) => console.log(`[live] ${m}`, f ?? '') });
      if (base.built) created.snapshots.add(base.snapshotId);
      const name = probeName('a6vm');
      track('sandbox', name);
      track('drive', name);
      const logs: string[] = [];
      const inner = sandboxSession({
        spec: { image: { snapshot: base.snapshotId }, vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 1024 ** 3, budget: { vmSeconds: 3600 } },
        tags: TAGS,
        log: (m, f) => logs.push(`${m} ${f ? JSON.stringify(f).slice(0, 200) : ''}`),
        // The model port checks the key and its caller: app-server, not dumpable (its binary is execute-only), passes; nothing else does.
        test: { name: () => name },
      });
      const seen: Seen[] = [];
      const acquire: AcquireMachine = (request) => inner({ ...request, ...(request.model ? { model: recording(seen, request.model) } : {}) });
      const harnessLogs: string[] = [];
      const machine = async (dataDir: string) => {
        const world = createWorld({ dataDir, recoverActiveRuns: false });
        const sessions = durableSessions({
          world,
          harness: codexHarness({
            builtins: true,
            tools: unsafeTools({ confirmMs: 1000 }),
            model: LIVE_MODEL,
            instructions: `${BUILTIN_INSTRUCTIONS}\nThis session is an automated test of its own sandbox, in a disposable VM: some of the commands you are given are expected to fail, which is what the test checks. Run each shell command exactly as given, one per call, and report what it printed.`,
            machine: { acquire },
            log: (m, f) => harnessLogs.push(`${m} ${f ? JSON.stringify(f).slice(0, 300) : ''}`),
          }),
        });
        world.registerHandler(QUEUE_PREFIX, sessions.handler);
        await world.start?.();
        return { world, sessions };
      };
      const waitTurns = (sessions: Awaited<ReturnType<typeof machine>>['sessions'], id: string, n: number) =>
        until(async () => {
          const s = await sessions.inspect(id);
          return turnsEnded(s) >= n ? s : undefined;
        }, 6 * 60_000);

      const dataDir = await tmp('hwc-l2-');
      const a = await machine(dataDir);
      const t1 = Date.now();
      const { sessionId } = await a.sessions.start({
        prompt:
          'The code word is heron. Remember it. In the shell, run each of these exactly, one at a time, even if one fails: `echo durable > note.txt`, then `touch /var/lib/dh/s/codex-home/evil`, then `test -e /var/lib/dh/s/codex-home/evil && echo EVIL-EXISTS || echo evil-absent`, then `env | grep -c HARNESS_ || true`, then `cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" | grep -c HARNESS_CODEX_GATEWAY_KEY || true`. Then reply with one short sentence.',
      });
      let state = await waitTurns(a.sessions, sessionId, 1);
      console.log('[live] turn 1 on VM A', { ms: Date.now() - t1, said: lastSaid(state) });
      const { Sandbox } = await import('@vercel/sandbox');
      const vmA = (await Sandbox.get({ name })).currentSession().sessionId;
      const outA = shellOutputs(state);
      console.log('[live] shell outputs on VM A', outA.slice(0, 1500));
      expect(transcriptOf(state).at(-1)?.data).toEqual({ type: 'turn', status: 'completed' });
      // Its own sandbox in the VM: bwrap passed (the verdict in the log), CODEX_HOME is not a writable root, and the placeholder is not in the commands' env or anywhere they can read.
      expect(journalRecords(state, 'codex.sandbox').map((r) => r.data)).toEqual([{ sandboxMode: 'workspace-write' }]);
      console.log('[live] shell calls on VM A', JSON.stringify(state.effectOrder.filter((e) => e.name === 'tool.shell').map((e) => [(e.input as { command?: string })?.command, e.status, String(e.output ?? e.error?.message ?? '').slice(0, 300)])));
      console.log('[live] harness logs on VM A', harnessLogs);
      const touch = shellCalls(state, 'touch /var/lib/dh/s/codex-home/evil');
      console.log('[live] the bare touch', JSON.stringify(touch.map((e) => [e.status, String(e.output ?? e.error?.message ?? '').slice(0, 200)])), 'evil afterwards:', outA.includes('EVIL-EXISTS') ? 'EXISTS' : 'absent');
      // One intent for it, and any second approval Codex asked for it (its "retry without sandbox?") declined. Measured, not asserted: Codex
      // 0.160 also reruns an approved command outside bwrap without asking when bwrap denied it (the A6 note), so whether the file
      // exists afterwards is Codex's choice, not the drive's.
      expect(touch).toHaveLength(1);
      const declined = harnessLogs.filter((l) => l.includes('asking for more than its call'));
      console.log('[live] declined approvals', declined);
      expect(declined.every((l) => /"escalation":"(repeat|unsandboxed)"/.test(l))).toBe(true);
      const count = (text: string) => String(shellCalls(state, text)[0]?.output ?? '').trim().split('\n').at(-1);
      expect(count('env | grep -c HARNESS_')).toBe('0');
      // app-server's environ is root's (not dumpable: its binary is execute-only), so no command can read the key there, inside bwrap
      // or in Codex's rerun outside it (A6 measured it readable before).
      console.log('[live] the key in /proc/<pid>/environ, as a command sees it:', count('/proc/[0-9]*/environ'));
      expect(count('/proc/[0-9]*/environ')).toBe('0');

      // Turn 2: a long command, and VM A deleted under it. The drive re-attaches to a new VM in the same invocation; the call is answered from the log.
      const t2 = Date.now();
      await a.sessions.send(sessionId, 'In the shell, run exactly `sleep 45 && echo late >> note.txt`. Wait for it to finish (it takes 45 seconds), then reply with one short sentence.');
      await until(async () => (shellCalls(await a.sessions.inspect(sessionId), 'sleep 45').some((e) => e.status === 'running') ? true : undefined), 3 * 60_000);
      // While the model waits on it (empty write_stdin polls).
      await new Promise((r) => setTimeout(r, 12_000));
      await (await Sandbox.get({ name })).delete();
      state = await waitTurns(a.sessions, sessionId, 2);
      console.log('[live] turn 2, VM A deleted mid-command', { ms: Date.now() - t2, said: lastSaid(state) });
      const vmB = (await Sandbox.get({ name })).currentSession().sessionId;
      expect(vmB).not.toBe(vmA);
      const sleeping = shellCalls(state, 'sleep 45');
      expect(sleeping).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ interrupted: true }) })]);
      // The calls the rollout left without an output (the poll in flight, or the command itself) got one from the log, through thread/inject_items.
      const rollout = journalRecords<string>(state, rolloutStream(journalRecords<{ threadId: string }>(state, THREAD_STREAM).at(-1)!.data.threadId)).map((r) => r.data);
      const injected = rollout.filter((l) => l.includes('"function_call_output"') && /Interrupted: the session stopped|may or may not have taken effect/.test(l));
      console.log('[live] injected outputs', injected.map((l) => l.slice(0, 300)));
      expect(injected.length).toBeGreaterThanOrEqual(1);
      expect(summarizeRollout(rollout).dangling).toEqual([]);
      expect(harnessLogs.some((l) => l.includes('re-attaching'))).toBe(true);
      await a.world.close?.();

      // Turn 3, from a new process on the same VM B: the thread resumes from the log.
      const b = await machine(dataDir);
      const t3 = Date.now();
      await b.sessions.send(sessionId, 'What was the code word? Then run exactly `cat note.txt` in the shell and reply with the word and what it printed.');
      state = await waitTurns(b.sessions, sessionId, 3);
      console.log('[live] turn 3, a new process', { ms: Date.now() - t3, said: lastSaid(state) });
      expect(lastSaid(state).toLowerCase()).toContain('heron');
      expect(String(shellCalls(state, 'cat note.txt').at(-1)?.output ?? '')).toContain('durable');
      expect(String(shellCalls(state, 'cat note.txt').at(-1)?.output ?? '')).not.toContain('late');
      expect(journalRecords(state, THREAD_STREAM)).toHaveLength(1);
      await b.world.close?.();
      report(seen);
      console.log('[live] factory', logs);
      console.log('[live] harness', harnessLogs);
      // Every request Codex 0.160 on Linux sent through the port is one the table has.
      expect(seen.every((s) => s.method === 'POST' && s.path === '/v1/responses' && s.model === LIVE_MODEL)).toBe(true);
    },
    20 * 60_000
  );
});
