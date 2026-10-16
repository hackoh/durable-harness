import { createModels } from '@earendil-works/pi-ai';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import type { DemoClient } from 'harness-world-demo-ui';
import { type NativeFxConfig, type NativePiConfig, nativeTurn, steerNative } from 'harness-world-hands/native';
import { withFetch } from 'harness-world-hybrid';
import type { FxEngineOptions } from 'libfx/browser';
import { tabGateway } from '../direct.ts';
import { MODEL } from '../model.ts';
import { createNativeClient, type NativeRunner } from './native.ts';
import { hasJspi, INSTRUCTIONS } from './tab-harnesses.ts';

/**
 * Native in this tab: plain Pi (pi-agent-core's `Agent`) and plain fx
 * (libfx in Wasm) run right here, with model calls through the server's
 * AI Gateway proxy and nothing else: no harness-world,
 * no World. The session lives in this page's memory and is gone on reload.
 */

let config: { pi: NativePiConfig; fx: NativeFxConfig } | undefined;
function tabNativeConfig() {
  if (config) return config;
  const models = createModels();
  models.setProvider(vercelAIGatewayProvider());
  const gateway = tabGateway();
  config = {
    pi: {
      model: models.getModel('vercel-ai-gateway', MODEL)!,
      streamFn: withFetch(models.streamSimple.bind(models), gateway),
      getApiKey: () => 'gateway',
      systemPrompt: INSTRUCTIONS,
    },
    fx: {
      createFxEngine: (async (options: FxEngineOptions) => (await import('libfx/browser')).createFxEngine(options)) as never,
      apiKey: () => 'gateway',
      model: MODEL,
      instructions: INSTRUCTIONS,
      fetch: gateway,
      agentOptions: { backend: 'wasm' },
    },
  };
  return config;
}

const tabRunner: NativeRunner = {
  turn: (req, emit) => nativeTurn(req as Parameters<typeof nativeTurn>[0], emit, tabNativeConfig()),
  steer: (turnId, text) => steerNative(turnId, text),
};

export function createClient(): Promise<DemoClient> {
  return createNativeClient(tabRunner, 'tab', { fxAvailable: hasJspi() });
}
