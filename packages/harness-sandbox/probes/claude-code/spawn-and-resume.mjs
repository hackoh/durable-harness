// Claude Code through the Agent SDK with a custom spawner, on the laptop
// against a scripted Anthropic Messages server (no real key, no network):
// the research behind docs/workspaces.md §5.6 (spawn, env, resume files,
// mirror rewrite). Turn 1 runs Bash and an in-process MCP tool; turn 2
// resumes from an InMemorySessionStore. Writes /tmp/ccprobe-data/report.json:
// the spawner's arguments and env, the config dir's files before and after,
// hook and MCP calls (with the pid they ran in), and every model request.
//
//   node spawn-and-resume.mjs <agent-sdk sdk.mjs> <claude binary> <zod entry>
//
// REMAP=none|inplace|rewrite moves CLAUDE_CONFIG_DIR to a stand-in "VM" dir
// (rewrite also maps transcript_mirror paths back, variant C); PROJ sets
// CLAUDE_CODE_PROJECT_DIR_NAME; SDKCWD runs the CLI in the workspace dir.
// A5's fake-anthropic.ts and its fixture grow from this.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

const SDK = process.argv[2];
const BIN = process.argv[3];
const D = '/tmp/ccprobe-data';
const LOG = join(D, 'protocol.log');
// Every directory the run writes to or runs in, made up front (a clean machine has none).
for (const d of ['config', 'home', 'tmp', 'workspace', 'sdktmp']) mkdirSync(join(D, d), { recursive: true });
const { query, createSdkMcpServer, tool, InMemorySessionStore } = await import(SDK);
const { z } = await import(process.argv[4]);

const reqs = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {}; try { j = JSON.parse(body); } catch {}
    const msgs = j.messages ?? [];
    const last = msgs.at(-1);
    const hasResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
    const toolNames = (j.tools ?? []).map((t) => t.name);
    reqs.push({ nmsgs: msgs.length, method: req.method, url: req.url, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/auth|key/.test(k))), auth: req.headers.authorization, xkey: req.headers['x-api-key'], model: j.model, tools: toolNames.length, hasResult, stream: j.stream });
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ input_tokens: 10 })); }
    const turnText = JSON.stringify(msgs).includes('second prompt');
    let block;
    if (toolNames.includes('Bash') && !hasResult && !turnText) block = { type: 'tool_use', id: 'toolu_bash_' + reqs.length, name: 'Bash', input: {} , json: JSON.stringify({ command: 'echo hi > out.txt && pwd && echo $HOME $TMPDIR && ls -la', description: 'probe' }) };
    else if (toolNames.includes('mcp__probe__ping') && hasResult && !JSON.stringify(msgs).includes('pong-result') && !turnText) block = { type: 'tool_use', id: 'toolu_mcp_' + reqs.length, name: 'mcp__probe__ping', input: {}, json: JSON.stringify({ x: 'hello' }) };
    else block = { type: 'text', text: 'done' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev('message_start', { type: 'message_start', message: { id: 'msg_' + reqs.length, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (block.type === 'tool_use') {
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: block.json } });
    } else {
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } });
    }
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

function list(dir) {
  const out = [];
  const walk = (d) => { let es; try { es = readdirSync(d); } catch { return; } for (const e of es) { const p = join(d, e); let s; try { s = statSync(p); } catch { continue; } if (s.isDirectory()) { out.push(relative(dir, p) + '/'); walk(p); } else out.push(`${relative(dir, p)} (${s.size})`); } };
  walk(dir); return out;
}

const spawns = [];
const REMAP = process.env.REMAP ?? 'none';
const spawnFn = (label) => (opts) => {
  const origCfg = opts.env.CLAUDE_CONFIG_DIR;
  if (process.env.SDKCWD) opts = { ...opts, cwd: join(D, 'workspace') };
  if (REMAP !== 'none') { const nd = join(D, 'vm-config-' + label); mkdirSync(nd, { recursive: true }); if (existsSync(origCfg)) cpSync(origCfg, nd, { recursive: true }); if (REMAP === 'inplace') opts.env.CLAUDE_CONFIG_DIR = nd; else opts = { ...opts, env: { ...opts.env, CLAUDE_CONFIG_DIR: nd } }; }
  const vmCfg = opts.env.CLAUDE_CONFIG_DIR;
  const rec = { origCfg, vmCfg, label, command: opts.command, args: opts.args, cwd: opts.cwd, env: opts.env, configDirFiles: list(opts.env.CLAUDE_CONFIG_DIR) };
  spawns.push(rec);
  const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = new PassThrough();
  const inp = new PassThrough();
  createInterface({ input: child.stdout }).on('line', (l) => { if (REMAP === 'rewrite' && l.startsWith('{"type":"transcript_mirror"')) l = l.split(JSON.stringify(vmCfg).slice(0,-1)).join(JSON.stringify(origCfg).slice(0,-1)); appendFileSync(LOG, `[${label}] < ${l.slice(0, 1500)}\n`); out.write(l + '\n'); });
  child.stdout.on('end', () => out.end());
  inp.on('data', (c) => { appendFileSync(LOG, `[${label}] > ${String(c).slice(0, 1500)}`); child.stdin.write(c); });
  inp.on('end', () => child.stdin.end());
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.on('exit', (c, s) => { rec.exit = { c, s }; rec.stderr = stderr.slice(-2000); });
  opts.signal.addEventListener('abort', () => child.kill('SIGTERM'));
  return { stdin: inp, stdout: out, get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; }, kill: (s) => child.kill(s), on: (e, f) => child.on(e, f), once: (e, f) => child.once(e, f), off: (e, f) => child.off(e, f) };
};

const store = new InMemorySessionStore();
const hookCalls = [];
const mcpCalls = [];
const server2 = createSdkMcpServer({ name: 'probe', version: '1.0.0', tools: [tool('ping', 'ping', { x: z.string() }, async (args, extra) => { mcpCalls.push({ args, meta: extra?._meta, pid: process.pid }); return { content: [{ type: 'text', text: 'pong-result' }] }; })] });
const env = {
  PATH: process.env.PATH, HOME: join(D, 'home'), TMPDIR: join(D, 'tmp'), CLAUDE_CONFIG_DIR: join(D, 'config'),
  CLAUDE_CODE_PROJECT_DIR_NAME: process.env.PROJ ?? undefined,
  ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'placeholder', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
};
if (!env.CLAUDE_CODE_PROJECT_DIR_NAME) delete env.CLAUDE_CODE_PROJECT_DIR_NAME;
const sessionId = '0b3e1c2a-1111-5222-8333-444455556666';
// The CLI's project directory name: PROJ, or its cwd with every other character as '-'.
const PROJECT_KEY = process.env.PROJ ?? (process.env.SDKCWD ?? join(D, 'workspace')).replace(/[^a-zA-Z0-9]/g, '-');
const base_opts = (label) => ({
  model: 'claude-sonnet-4-5', cwd: process.env.SDKCWD ?? join(D, 'workspace'), env: { ...env }, permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true,
  allowedTools: ['mcp__probe__ping'], disallowedTools: ['WebSearch'],
  mcpServers: { probe: server2 }, persistSession: true, sessionStore: store, sessionStoreFlush: 'eager',
  pathToClaudeCodeExecutable: BIN, spawnClaudeCodeProcess: spawnFn(label),
  hooks: { PreToolUse: [{ hooks: [async (input) => { hookCalls.push({ label, pid: process.pid, tool: input.tool_name, id: input.tool_use_id, cwd: input.cwd, transcript_path: input.transcript_path }); return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }; }] }] },
});
async function run(label, prompt, extra) {
  const q = query({ prompt: (async function* () { yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }; })(), options: { ...base_opts(label), ...extra } });
  const types = [];
  for await (const m of q) { types.push(m.type + (m.subtype ? ':' + m.subtype : '')); if (m.type === 'result') break; }
  q.close();
  await new Promise((r) => setTimeout(r, 1500));
  return types;
}
const t1 = await run('new', 'first prompt', { sessionId });
const filesAfter1 = { config: list(join(D, 'config')), home: list(join(D, 'home')), tmp: list(join(D, 'tmp')), workspace: list(join(D, 'workspace')), sdktmp: list(join(D, 'sdktmp')) };
const loaded = await store.load({ projectKey: PROJECT_KEY, sessionId }); const storeKeys = { proj: PROJECT_KEY, loadedEntries: loaded ? loaded.length : null, sessions: await store.listSessions?.(PROJECT_KEY).catch(e=>String(e)) };
const t2 = await run('resume', 'second prompt', { resume: sessionId });
const filesAfter2 = { sdktmp: list(join(D, 'sdktmp')) };
server.close();
writeFileSync(join(D, 'report.json'), JSON.stringify({ t1, t2, spawns, hookCalls, mcpCalls, reqs, filesAfter1, filesAfter2, sdkPid: process.pid, storeKeys }, null, 2));
console.log('ok');
process.exit(0);
