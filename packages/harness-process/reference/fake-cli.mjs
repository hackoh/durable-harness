#!/usr/bin/env node
/**
 * A fake agent CLI: the child process the reference harness drives. It
 * stands in for Claude Code, Codex or OpenCode with the parts that matter
 * to durability and none of the rest:
 *
 * - a native session file it owns (`session.jsonl`, append-only), written
 *   before it reports anything, and resumed from on start;
 * - native resume semantics: a tool call left without a result is answered
 *   "interrupted, outcome unknown" on load, as Claude Code and OpenCode do;
 * - a JSON-lines protocol on stdin/stdout (like app-server or stream-json):
 *   in, `{type:'user', id, text}` and `{type:'tool_result', id, text, isError}`;
 *   out, `{type:'ready'}`, `{type:'text', delta}`, `{type:'tool_call', id,
 *   name, args}` and `{type:'turn_end'}`;
 * - tools are the host's: a call waits for the host's result.
 *
 * Its "model" is a script, so tests need no network:
 *
 * - `call <tool> <json args>`: says so, calls the tool, reports the result;
 * - a message starting `[Recovery]`: acknowledges it and calls nothing;
 * - anything else: `echo: <text>`.
 *
 * Usage: `node fake-cli.mjs <session.jsonl>`. It exits when stdin closes,
 * unless `FAKE_CLI_LINGER=1` (a CLI that outlives its parent, for the
 * kill-before-resume tests). `FAKE_CLI_TYPE_MS` slows its "model" down
 * (milliseconds per 12 characters). With `FAKE_CLI_MODEL_URL`, its "model"
 * is remote, as a real CLI's is: each reply is a POST there (`{ text }`,
 * with `FAKE_CLI_MODEL_KEY`, else `ANTHROPIC_AUTH_TOKEN` (in a session's
 * sandbox, the attach's model key, as a real CLI's), as its bearer key)
 * streamed back as server-sent events (`reference/fake-model.ts`).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: fake-cli.mjs <session.jsonl>\n');
  process.exit(2);
}

const records = existsSync(file)
  ? readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const record = (r) => {
  records.push(r);
  appendFileSync(file, `${JSON.stringify(r)}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Native resume: a call left without a result has an unknown outcome.
const answered = new Set(records.filter((r) => r.type === 'tool_result').map((r) => r.id));
for (const r of [...records]) {
  if (r.type !== 'assistant') continue;
  for (const c of r.toolCalls ?? []) {
    if (!answered.has(c.id)) {
      record({ type: 'tool_result', id: c.id, text: 'interrupted: the session stopped before this call returned; its outcome is unknown', isError: true, synthetic: true });
    }
  }
}
let calls = records.filter((r) => r.type === 'assistant').reduce((n, r) => n + (r.toolCalls?.length ?? 0), 0);

const waiting = new Map();
const queue = [];
let busy = false;

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.type === 'tool_result') {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  } else if (m.type === 'user') {
    queue.push(m);
    void pump();
  }
});
rl.on('close', () => {
  if (process.env.FAKE_CLI_LINGER === '1') return setInterval(() => {}, 1 << 30);
  process.exit(0);
});

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await turn(queue.shift());
  busy = false;
}

/** How long the "model" takes per 12 characters (`FAKE_CLI_TYPE_MS`, default 5). */
const typeMs = Number(process.env.FAKE_CLI_TYPE_MS ?? 5);

const modelUrl = process.env.FAKE_CLI_MODEL_URL;

async function say(text) {
  if (modelUrl) return stream(text);
  for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) {
    out({ type: 'text', delta: piece });
    await sleep(typeMs);
  }
}

/** One model request: `text` streamed back from the remote "model", piece by piece. */
async function stream(text) {
  const res = await fetch(modelUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.FAKE_CLI_MODEL_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? ''}` },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) throw new Error(`the model answered ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
      const data = buffer.slice(0, at).replace(/^data: /, '');
      buffer = buffer.slice(at + 2);
      if (data === '[DONE]') return;
      if (data) out({ type: 'text', delta: JSON.parse(data).delta });
    }
  }
  throw new Error('the model stream was cut');
}

async function reply(text) {
  await say(text);
  record({ type: 'assistant', text });
}

function end() {
  record({ type: 'turn_end' });
  out({ type: 'turn_end' });
}

async function turn(m) {
  record({ type: 'user', id: m.id, text: m.text });
  const text = String(m.text ?? '').trim();
  if (text.startsWith('[Recovery]')) {
    await reply('Recovered from the log. I will check the actual state before repeating anything.');
    return end();
  }
  const call = /^call\s+(\w+)\s*([\s\S]*)$/.exec(text);
  if (call) {
    const id = `call_${++calls}`;
    let args = {};
    try {
      args = call[2] ? JSON.parse(call[2]) : {};
    } catch {
      await reply(`cannot parse the arguments for ${call[1]}`);
      return end();
    }
    const said = `Calling ${call[1]}.`;
    await say(said);
    // The record first, then the event: the host mirrors the file when it
    // sees the call, so the call is in its journal before the tool runs.
    record({ type: 'assistant', text: said, toolCalls: [{ id, name: call[1], args }] });
    out({ type: 'tool_call', id, name: call[1], args });
    const result = await new Promise((r) => waiting.set(id, r));
    record({ type: 'tool_result', id, text: result.text, isError: !!result.isError });
    await reply(`${call[1]} ${result.isError ? 'failed' : 'returned'}: ${String(result.text).slice(0, 200)}`);
    return end();
  }
  await reply(`echo: ${text}`);
  end();
}

out({ type: 'ready', records: records.length });
