import { durableSessions, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { workspaceTools } from 'harness-world-hands';
import { referenceHarness } from 'harness-world-process/reference';
import { kernelSession, type Scenario, settled } from '../src/scenario.ts';
import { newHost, PROCESS_VOCABULARY, processBasic, turnsEnded } from './process.ts';

/** The reference process harness (harness-world-process): the template the process harnesses follow, driving `fake-cli.mjs`. */

export const reference: Scenario = {
  name: 'reference',
  title: 'Reference process harness (harness-world-process)',
  blocking: true,
  sessions: [
    {
      label: 'basic',
      async run(storage) {
        const host = await newHost('reference');
        return processBasic(storage, referenceHarness({ tools: workspaceTools({ confirmMs: 3000 }), host }), { name: 'reference', host });
      },
    },
    {
      label: 'recovered',
      async run(storage) {
        // Process A dies 300 ms into an unsafe payment; its child outlives it (its own process group).
        const hostA = await newHost('reference-a');
        const a = await storage.open();
        let crashed!: () => void;
        const died = new Promise<void>((r) => (crashed = r));
        const sessionsA = durableSessions({
          world: a.world,
          harness: referenceHarness({ tools: workspaceTools({ confirmMs: 3000 }), host: hostA }),
          chaos: true,
          crash: () => crashed(),
        });
        await a.serve(QUEUE_PREFIX, sessionsA.handler);
        const { sessionId } = await sessionsA.start();
        await sessionsA.chaos(sessionId, { at: 'tool', afterMs: 300 });
        await sessionsA.send(sessionId, 'call unsafe_make_payment {"to":"acme","amount_usd":5,"memo":"order 7"}');
        await died;
        await a.close();
        hostA.killAll();

        // Process B, a fresh machine: recovers from the log (the payment is interrupted, never rerun), then one more turn.
        const host = await newHost('reference-b');
        const open = await storage.open({ recover: true });
        const sessions = durableSessions({
          world: open.world,
          harness: referenceHarness({ tools: workspaceTools({ confirmMs: 3000 }), host }),
          chaos: true,
          crash: () => {},
        });
        await open.serve(QUEUE_PREFIX, sessions.handler);
        const turns = (n: number) => (s: SessionState) => turnsEnded(s) >= n;
        await settled(open.world, sessions, sessionId, turns(1), { what: 'recovery', timeoutMs: 90_000 });
        await sessions.send(sessionId, 'hello');
        await settled(open.world, sessions, sessionId, turns(2), { what: 'the turn after recovery', timeoutMs: 90_000, drain: () => open.drained() });
        return {
          session: kernelSession(() => open.world, () => sessions, sessionId, {
            harness: 'reference',
            submissions: 3,
            calls: ['tool.unsafe_make_payment'],
            callsMatch: 'subsequence',
            callPattern: /^tool\./,
            vocabulary: PROCESS_VOCABULARY,
            failedSteps: /interrupted/i,
          }),
          dispose: async () => {
            await open.close();
            host.killAll();
          },
        };
      },
    },
  ],
};
