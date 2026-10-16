/**
 * Pi (`pi-agent-core`'s Agent) on the kernel: Pi variant B, the harness the
 * demo's "Pi" runs. pi-ai talks to AI Gateway with fetch, and the tools are
 * the demo's: Pi's coding tools (read, bash, edit, write) on a just-bash
 * workspace whose files live in the log, plus the two unsafe tools
 * (`replay: 'never'`) whose ledger is a World stream.
 */
import { createModels } from '@earendil-works/pi-ai';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import type { Harness } from 'harness-world';
import { unsafeTools } from 'harness-world-hands';
import { piCodingTools, workspaceRuntime } from 'harness-world-hands/runtime';
import { piHarness as kernelPi } from 'harness-world-pi';
import { CONFIRM_MS, gatewayKey, INSTRUCTIONS, MODEL } from './model.ts';

export function piHarness(): Harness {
  let built: Harness | undefined;
  // Built on first drive: pi-ai's model catalog is not needed to serve reads.
  const build = () => {
    const models = createModels();
    models.setProvider(vercelAIGatewayProvider());
    const model = models.getModel('vercel-ai-gateway', MODEL);
    if (!model) throw new Error(`pi-ai does not know ${MODEL}`);
    return kernelPi({
      model,
      streamFn: models.streamSimple.bind(models),
      getApiKey: () => gatewayKey(),
      systemPrompt: INSTRUCTIONS,
      // No worker threads in workerd: the shell runs in this isolate (its hardened limits).
      tools: [...piCodingTools(workspaceRuntime({ kind: 'virtual', durable: true }, { isolation: 'auto' })), ...unsafeTools({ confirmMs: CONFIRM_MS })],
    });
  };
  return { name: 'pi', drive: (ctx) => (built ??= build()).drive(ctx) };
}
