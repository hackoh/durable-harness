import { describe, expect, it } from 'vitest';
import { fxPromptTraceIdentity, fxTraceIdentity, fxTraceRequestBody } from './fx-trace';

const journal = (entry: unknown) => ({ eventType: 'step_created', eventData: { stepName: 'fx.log', input: new TextEncoder().encode(JSON.stringify(entry)) } });
describe('native libfx trace identity', () => {
  it('uses the fresh engine turn before the journal is visible', () => {
    expect(fxPromptTraceIdentity({ method: 'session/prompt', params: { sessionId: 'session', prompt: [{ type: 'text', text: 'Hello 世界' }], _meta: { fx: { turnId: 'accepted' } } } })).toEqual({ sessionId: 'session', turnId: 'accepted', prompt: 'Hello 世界' });
    expect(fxPromptTraceIdentity({ method: 'session/prompt', params: { sessionId: 'session', prompt: [], _meta: { fx: { continueRecovery: true } } } })).toBeUndefined();
    expect(fxPromptTraceIdentity({ method: 'session/cancel', params: { sessionId: 'session' } })).toBeUndefined();
  });
  it('uses the accepted JSON prompt for the first invocation and across resumed model calls', () => {
    const input = journal({ k: 'input', type: 'prompt', messageId: 'turn_1', input: 'Hello 世界' });
    expect(fxTraceIdentity([input], 'request_1')).toEqual({ turnId: 'turn_1', prompt: 'Hello 世界' });
    expect(fxTraceIdentity([journal({ k: 'record', marks: [{ start: 'turn_1' }] }), input], 'request_2')).toEqual({ turnId: 'turn_1', prompt: 'Hello 世界' });
  });
  it('selects a fresh prompt ahead of older turn marks and does not use a queued future prompt as an active turn title', () => {
    const previous = journal({ k: 'input', type: 'prompt', messageId: 'old', input: 'Previous' });
    const next = journal({ k: 'input', type: 'prompt', messageId: 'new', input: 'Next' });
    expect(fxTraceIdentity([next, journal({ k: 'record', marks: [{ start: 'old' }, { end: true }] }), previous], 'request')).toEqual({ turnId: 'new', prompt: 'Next' });
    expect(fxTraceIdentity([journal({ k: 'record', marks: [{ start: 'old' }] }), next, previous], 'request')).toEqual({ turnId: 'old', prompt: 'Previous' });
  });
  it('ignores unrelated or malformed payloads and preserves checkpointed turn identity', () => {
    const unrelated = { eventType: 'step_created', eventData: { stepName: 'kernel', input: new TextEncoder().encode('devl[]') } };
    const broken = { eventType: 'step_created', eventData: { stepName: 'fx.log', input: new TextEncoder().encode('{') } };
    expect(fxTraceIdentity([unrelated, broken, journal({ k: 'checkpoint', openTurn: { id: 'resumed' } })], 'request')).toEqual({ turnId: 'resumed' });
  });
});

describe('native libfx request capture', () => {
  it('decodes transport bytes and offset views without losing Unicode model inputs', () => {
    const request = { model: 'test', messages: [{ role: 'user', content: 'Hello 世界' }] };
    const json = JSON.stringify(request);
    const bytes = new TextEncoder().encode(json);
    expect(fxTraceRequestBody(bytes)).toEqual(request);
    expect(fxTraceRequestBody(bytes.buffer)).toEqual(request);
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 2);
    expect(fxTraceRequestBody(new DataView(padded.buffer, 2, bytes.length))).toEqual(request);
    expect(fxTraceRequestBody(json)).toEqual(request);
  });
  it('omits malformed, unsupported and oversized request bodies', () => {
    expect(fxTraceRequestBody('{')).toBeUndefined();
    expect(fxTraceRequestBody(undefined)).toBeUndefined();
    expect(fxTraceRequestBody(new Uint8Array(256_001))).toBeUndefined();
    expect(fxTraceRequestBody(' '.repeat(256_001))).toBeUndefined();
  });
});
