import type { VercelSandboxProvider } from 'harness-world-hybrid/sandbox';

type SandboxModule = typeof import('harness-world-hybrid/sandbox');

const gs = globalThis as { __harnessSandbox?: VercelSandboxProvider };

/**
 * The one sandbox provider this process uses: for hybrid's `run_on_machine`
 * (each session's own VM, `hybrid-<runId>`), from a Hybrid brain or a
 * Server brain's Virtual + machine hands. Built with `callback: undefined`,
 * whatever the environment says: `run_on_machine` waits for its command
 * inside the call and refuses a provider with a push callback, which would
 * have the VM's egress proxy carry the deployment's protection bypass to app
 * routes (docs/workspaces.md §8). VMs start from the Sandbox's default image
 * (the brain-in-VM daemon's VCR image went with that lane). The sandbox SDK
 * is imported on first use (see sessions.ts).
 */
export async function getSandboxProvider(): Promise<VercelSandboxProvider> {
  return providerFrom(await import('harness-world-hybrid/sandbox'));
}

/** The provider, from an already-loaded sandbox module. */
export function providerFrom(sandbox: SandboxModule): VercelSandboxProvider {
  gs.__harnessSandbox ??= new sandbox.VercelSandboxProvider({ callback: undefined });
  return gs.__harnessSandbox;
}
