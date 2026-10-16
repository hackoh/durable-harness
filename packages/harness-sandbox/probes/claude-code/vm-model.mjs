// A scripted Anthropic Messages server for a probe inside a VM (P0.10, P0.16):
// it answers each request with the next Bash command from COMMANDS (a JSON
// array in the env), then a final text, and appends every tool result it is
// sent to RESULTS (a file only root reads). Listens on 127.0.0.1:$PORT.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const commands = JSON.parse(process.env.COMMANDS ?? '[]');
const results = process.env.RESULTS ?? '/tmp/vm-model-results.jsonl';
let n = 0;
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    appendFileSync(results, `${JSON.stringify({ kind: 'request', method: req.method, url: req.url, model: j.model, auth: (req.headers.authorization ?? '').length > 0, betas: req.headers['anthropic-beta'] })}\n`);
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(req.url.includes('count_tokens') ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const last = (j.messages ?? []).at(-1);
    for (const b of Array.isArray(last?.content) ? last.content : []) if (b.type === 'tool_result') appendFileSync(results, `${JSON.stringify({ kind: 'result', id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('') })}\n`);
    const cmd = commands[n++];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev('message_start', { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (cmd) {
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name: 'Bash', input: {} } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: cmd, description: `probe ${n}` }) } });
    } else {
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
    }
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: cmd ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  });
}).listen(Number(process.env.PORT ?? 4200), '127.0.0.1');
