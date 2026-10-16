import { createRequire } from 'node:module';
import { type CodexHarnessOptions, codexHarness } from 'harness-world-codex';
import { workspaceTools } from 'harness-world-hands';
import { sandboxSession } from 'harness-world-sandbox';
import { FakeSandboxApi } from 'harness-world-sandbox/testing/fake-api';
import type { Harness } from 'harness-world';
import type { Scenario } from '../src/scenario.ts';
import { processBasic } from './process.ts';

/**
 * Codex (harness-world-codex) against its fake `codex app-server`
 * (`test/fake-app-server.mjs`: the protocol subset and the rollout format,
 * a scripted model), run in the sandbox tier's stand-in (docs/workspaces.md
 * §5.8): the session factory over harness-world-sandbox's fake Sandbox API,
 * where each "VM" is a local relay child and each "Drive" a temp dir, so the
 * drive acquires its machine as on Vercel (the `sandbox.attach` fact).
 */
const FAKE_APP_SERVER = createRequire(import.meta.url).resolve('harness-world-codex/testing/fake-app-server');

/**
 * Codex's harness on a fresh stand-in: the fake app-server (or `command`,
 * the real binary) as the VM's CLI. `dispose` stops its relays and deletes
 * its temp dirs.
 */
export function codexStandIn(options: Omit<CodexHarnessOptions, 'machine' | 'test'> & { env?: Record<string, string>; command?: string }): { harness: Harness; dispose: () => Promise<void> } {
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  const api = new FakeSandboxApi();
  const acquire = sandboxSession({
    spec: { vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: Infinity }, image: 'stand-in' },
    test: { api, allowDegraded: true, allowUnauthenticatedModel: true },
  });
  const { env, command, ...rest } = options;
  const harness = codexHarness({
    ...rest,
    machine: { acquire, ...(env ? { env } : {}) },
    test: command ? { command } : { command: process.execPath, args: [FAKE_APP_SERVER] },
  });
  return { harness, dispose: () => api.dispose() };
}

export const codex: Scenario = {
  name: 'codex',
  title: 'Codex (harness-world-codex, fake app-server, stand-in sandbox)',
  blocking: true,
  sessions: [
    {
      label: 'basic',
      async run(storage) {
        const { harness, dispose } = codexStandIn({
          // The bridged tools only: the scenario's scripted turns call them.
          builtins: false,
          tools: workspaceTools({ confirmMs: 3000 }),
          credential: async () => 'unused',
        });
        return processBasic(storage, harness, { name: 'codex', dispose });
      },
    },
  ],
};
