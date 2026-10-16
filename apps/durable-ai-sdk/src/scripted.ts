import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';

/**
 * A scripted language model for tests that need no credential: each call
 * takes the next step of the script (a response, or an error to throw) and
 * records the prompt it was given.
 */
export interface ScriptedModel extends LanguageModelV4 {
  calls: LanguageModelV4CallOptions[];
}

type Step = LanguageModelV4GenerateResult | Error;

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

export function text(value: string): LanguageModelV4GenerateResult {
  return { content: [{ type: 'text', text: value }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] };
}

export function toolCall(toolName: string, input: unknown, toolCallId: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage,
    warnings: [],
  };
}

export function scriptedModel(script: Step[]): ScriptedModel {
  const calls: LanguageModelV4CallOptions[] = [];
  return {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId: 'scripted',
    supportedUrls: {},
    calls,
    async doGenerate(options) {
      calls.push(options);
      const step = script.shift();
      if (!step) throw new Error('scripted model: the script ran out');
      if (step instanceof Error) throw step;
      return step;
    },
    // The same script, streamed: each text in two deltas, then the rest of the content, then the finish.
    async doStream(options) {
      calls.push(options);
      const step = script.shift();
      if (!step) throw new Error('scripted model: the script ran out');
      if (step instanceof Error) throw step;
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: step.warnings }];
      step.content.forEach((c, i) => {
        if (c.type !== 'text') return void parts.push(c as LanguageModelV4StreamPart);
        const id = `t${i}`;
        const half = Math.ceil(c.text.length / 2);
        parts.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: c.text.slice(0, half) }, { type: 'text-delta', id, delta: c.text.slice(half) }, { type: 'text-end', id });
      });
      parts.push({ type: 'finish', finishReason: step.finishReason, usage: step.usage, ...(step.providerMetadata ? { providerMetadata: step.providerMetadata } : {}) });
      return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
    },
  };
}
