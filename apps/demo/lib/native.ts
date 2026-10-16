import { createModels } from '@earendil-works/pi-ai';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import type { NativeDocSpec, NativeFxConfig, NativePiConfig } from 'harness-world-hands/native';
import { createFxEngine } from 'libfx';
import { gatewayKey, INSTRUCTIONS, MODEL } from './model';
import { TODOS } from './todos';

/**
 * The native baseline's configuration: the model, prompt and Gateway
 * credential the durable Function lane uses (`sessions.ts` builds its
 * harnesses from the same `model.ts`), with pi-ai and libfx called directly,
 * and the same todo list tools (on state the caller carries).
 */
const g = globalThis as { __nativeConfig?: { pi: NativePiConfig; fx: NativeFxConfig; docs: NativeDocSpec[] } };

export function nativeConfig() {
  if (!g.__nativeConfig) {
    const models = createModels();
    models.setProvider(vercelAIGatewayProvider());
    const model = models.getModel('vercel-ai-gateway', MODEL);
    if (!model) throw new Error(`pi-ai does not know ${MODEL}`);
    g.__nativeConfig = {
      pi: { model, streamFn: models.streamSimple.bind(models), getApiKey: () => gatewayKey(), systemPrompt: INSTRUCTIONS },
      fx: { createFxEngine: createFxEngine as NativeFxConfig['createFxEngine'], apiKey: gatewayKey, model: MODEL, instructions: INSTRUCTIONS },
      // The durable lanes' todo list tools (docTools([Todos])), so Native advertises the same tools.
      docs: [TODOS],
    };
  }
  return g.__nativeConfig;
}
