/**
 * The AI SDK's ToolLoopAgent (ai 7) on the kernel (apps/durable-ai-sdk),
 * with the same workspace and unsafe tools as Pi.
 */
import { createGateway } from 'ai';
import { aiSdkHarness as kernelAiSdk } from 'durable-ai-sdk';
import { fromHostTools } from 'durable-ai-sdk/tools';
import type { Harness } from 'harness-world';
import { unsafeTools } from 'harness-world-hands';
import { piCodingTools, workspaceRuntime } from 'harness-world-hands/runtime';
import { CONFIRM_MS, gatewayCredential, INSTRUCTIONS, MODEL } from './model.ts';

export function aiSdkHarness(): Harness {
  let built: Harness | undefined;
  const build = () => {
    // The credential is set per request (it may rotate), not captured here;
    // the placeholder only keeps the provider from looking for one itself.
    const gateway = createGateway({ apiKey: 'set-per-request', fetch: (input, init) => fetch(input, withCredential(init)) });
    return kernelAiSdk({
      model: gateway(MODEL),
      instructions: INSTRUCTIONS,
      // Pi's coding tools (read, bash, edit, write), as the AI SDK's line has them, and the unsafe tools.
      tools: fromHostTools([...piCodingTools(workspaceRuntime({ kind: 'virtual', durable: true }, { isolation: 'auto' })), ...unsafeTools({ confirmMs: CONFIRM_MS })]),
    });
  };
  return { name: 'ai-sdk', drive: (ctx) => (built ??= build()).drive(ctx) };
}

function withCredential(init: RequestInit | undefined): RequestInit {
  const { token, method } = gatewayCredential();
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('ai-gateway-auth-method', method);
  return { ...init, headers };
}
