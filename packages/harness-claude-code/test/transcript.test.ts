import { readFileSync } from 'node:fs';
import type { TranscriptEntry } from 'harness-world-process';
import { describe, expect, it } from 'vitest';
import { bareToolName, TranscriptBuilder } from '../src/transcript.ts';

/**
 * The normalized transcript from the SDK's messages. `fixtures/turn.json` is
 * one real turn (claude 2.1.289, claude-haiku-4-5 through AI Gateway):
 * "Write "hello" to a.txt, then tell me in one sentence what you did", with
 * every message `query()` yielded and every line the SDK mirrored.
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/turn.json', import.meta.url), 'utf8')) as {
  messages: { type: string; subtype?: string }[];
  appends: { key: { projectKey: string; sessionId: string }; entries: { type: string; uuid?: string }[] }[];
  toolCalls: { name: string; args: unknown; meta: Record<string, unknown> }[];
  transcript: TranscriptEntry[];
};

function build() {
  const entries: TranscriptEntry[] = [];
  const live: unknown[] = [];
  const builder = new TranscriptBuilder({ message: (e) => entries.push(e), live: (e) => live.push(e) });
  return { builder, entries, live };
}

describe('TranscriptBuilder', () => {
  it('turns a recorded turn into the normalized transcript and live text', () => {
    const { builder, entries, live } = build();
    const ends = fixture.messages.map((m) => builder.observe(m)).filter(Boolean);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ status: 'completed', queued: 0 });
    builder.endTurn(ends[0]!);
    expect(entries).toEqual(fixture.transcript);
    // The tool call is keyed by the id the MCP handler received.
    const call = entries.find((e) => e.type === 'message' && e.role === 'assistant' && e.toolCalls?.length);
    expect(call).toMatchObject({ toolCalls: [{ id: fixture.toolCalls[0]!.meta['claudecode/toolUseId'], name: 'write_file' }] });
    // The live text is the streamed deltas: they spell the final reply.
    const text = live.filter((e: any) => e.type === 'text').map((e: any) => e.delta).join('');
    const reply = entries.filter((e): e is Extract<TranscriptEntry, { role: 'assistant' }> => e.type === 'message' && e.role === 'assistant').map((e) => e.text).join('');
    expect(text).toBe(reply);
  });

  it('writes a call from the tool handler when the handler runs before the message is seen, and only once', async () => {
    const { builder, entries } = build();
    builder.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Let me look.' }] } });
    await builder.beforeCall('toolu_1', 'read_file', 10);
    builder.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__hands__read_file', input: {} }] } });
    expect(entries).toEqual([{ type: 'message', role: 'assistant', text: 'Let me look.', toolCalls: [{ id: 'toolu_1', name: 'read_file' }] }]);
  });

  it('a handler waits for the tool_use the CLI is about to report', async () => {
    const { builder, entries } = build();
    const waiting = builder.beforeCall('toolu_2', 'bash', 5000);
    builder.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Running it.' }] } });
    builder.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__hands__bash', input: {} }] } });
    await waiting;
    expect(entries).toEqual([{ type: 'message', role: 'assistant', text: 'Running it.', toolCalls: [{ id: 'toolu_2', name: 'bash' }] }]);
  });

  it('an error result fails the turn with its message; subagent messages are left out', () => {
    const { builder, entries, live } = build();
    builder.observe({ type: 'assistant', parent_tool_use_id: 'toolu_task', message: { content: [{ type: 'text', text: 'subagent text' }] } });
    builder.observe({ type: 'stream_event', parent_tool_use_id: 'toolu_task', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
    const end = builder.observe({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401', queued_turn_count: 0, user_message_uuids: ['u1'] });
    expect(end).toEqual({ status: 'failed', error: 'API Error: 401', queued: 0, consumed: ['u1'] });
    builder.endTurn(end!);
    expect(entries).toEqual([{ type: 'turn', status: 'failed', error: 'API Error: 401' }]);
    expect(live).toEqual([]);
    expect(builder.observe({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['max turns'] })).toMatchObject({ status: 'failed', error: 'max turns' });
  });

  it('strips the MCP prefix from tool names', () => {
    expect(bareToolName('mcp__hands__bash')).toBe('bash');
    expect(bareToolName('Bash')).toBe('Bash');
  });
});
