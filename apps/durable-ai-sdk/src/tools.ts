import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { type JSONSchema7, jsonSchema, tool } from 'ai';
import type { HostTool, HostToolIO } from 'durable-harness';
import { z } from 'zod';
import type { DurableTool } from './harness.ts';

/**
 * A harness-neutral `HostTool` (what Pi and fx take: harness-world-hands'
 * workspace tools) as an AI SDK tool. Its replay rule comes along, and its
 * `execute` gets the kernel's io (the drive context, the step id), which the
 * workspace tools need to fold their files from the log.
 */
export function fromHostTool(host: HostTool): DurableTool {
  return {
    ...tool({ description: host.description, inputSchema: jsonSchema(host.inputSchema as JSONSchema7) }),
    replay: host.replay,
    execute: (input: unknown, _options: unknown, io?: HostToolIO) => host.execute(input, io!),
  };
}

export function fromHostTools(hosts: HostTool[]): Record<string, DurableTool> {
  return Object.fromEntries(hosts.map((h) => [h.name, fromHostTool(h)]));
}

/** One payment, as the ledger file records it. */
export interface Payment {
  id: string;
  toolCallId: string;
  to: string;
  amountUsd: number;
  memo: string;
  pid: number;
  at: number;
}

/**
 * A payment tool that is not safe to rerun: every call appends one line to
 * `ledger` (a file outside the event log, which nothing can take back), then
 * waits `confirmMs` for the "bank" to confirm. A crash in that window is the
 * case that matters: the money moved, the result never reached the log.
 */
export function makePayment(ledger: string, confirmMs = 3000): DurableTool {
  return {
    ...tool({
      description:
        'Send a payment. Every call moves money once more: only call it when the user asks for a payment, once per payment.',
      inputSchema: z.object({
        to: z.string().describe('Who to pay (an email address).'),
        amountUsd: z.number().describe('Amount in US dollars.'),
        memo: z.string(),
      }),
      async execute({ to, amountUsd, memo }, { toolCallId, abortSignal }) {
        const id = `pay_${randomUUID().slice(0, 8)}`;
        const payment: Payment = { id, toolCallId, to, amountUsd, memo, pid: process.pid, at: Date.now() };
        await appendFile(ledger, `${JSON.stringify(payment)}\n`);
        await sleep(confirmMs, abortSignal);
        return `paid $${amountUsd.toFixed(2)} to ${to} (payment ${id})`;
      },
    }),
    replay: 'never',
  };
}

/** Every payment the ledger file holds. */
export async function readLedger(ledger: string): Promise<Payment[]> {
  const text = await readFile(ledger, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Payment);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
