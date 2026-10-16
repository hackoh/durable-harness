/**
 * `RemoteMachine` against the `WorkspaceMachine` interface (docs/workspaces.md
 * §11.4 A4): the same cases (`machine-cases.ts`) through the in-memory machine
 * and through `RemoteMachine` on the stand-in (`localMachine()`, the relay
 * bundle and its helper as a local child), so the two agree. The live run of
 * the same cases is `live-env.test.ts`.
 */
import { beforeAll } from 'vitest';
import { createMachine } from 'harness-world-hands/runtime';
import { machineCases } from './machine-cases.ts';
import { localMachine } from './local-machine.ts';

beforeAll(() => {
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
});

machineCases('the in-memory machine (just-bash)', async () => {
  const machine = await createMachine();
  return { machine, dispose: async () => machine.dispose() };
});

machineCases('RemoteMachine on the stand-in', async () => {
  const sb = await localMachine();
  return { machine: sb.machine.workspace, dispose: () => sb.dispose() };
});
