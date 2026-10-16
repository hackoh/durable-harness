import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { durableSessions, type HostTool, QUEUE_PREFIX } from 'harness-world';
import { transcriptOf } from 'harness-world-process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_INSTRUCTIONS, opencodeHarness } from '../src/index.ts';
import { type HostAccess, type HostTrace, traceHost } from './host-access.ts';
import { scriptedGateway, type ScriptedGateway, text, toolCall, toolResults } from './scripted-gateway.ts';

/**
 * OpenCode 2.0.22 for real, tool-less (no `workspace`), booted the way a
 * Function boots it: in this process, from a working directory that holds a
 * canary AGENTS.md, with a planted `~/.claude/CLAUDE.md` and skills in the
 * process's HOME, canary values in `process.env`, and every `node:fs` and
 * `node:child_process` call of this process traced. A scripted model asks
 * for OpenCode's own tools anyway.
 *
 * No line means only the app's tools: OpenCode's own are not offered, a
 * call to one is refused before it runs, no canary reaches the model, no
 * path of this machine is told to it, OpenCode starts no process on this
 * machine, and it changes nothing outside the session's own directories.
 */

const CANARY = {
  agents: 'CANARY-AGENTS-7f3a',
  claude: 'CANARY-CLAUDE-MD-91c2',
  skill: 'CANARY-SKILL-5d0e',
  env: 'CANARY-ENV-SECRET-b4e8',
};

let gateway: ScriptedGateway;
let world: LocalWorld;
let base: string;
let app: string;
let home: string;
let cwd0: string;
const envKeys = ['HOME', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'HARNESS_CANARY_SECRET'] as const;
const env0: Partial<Record<(typeof envKeys)[number], string>> = {};

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'oc-toolless-')));
  // The app's directory: a project with its own AGENTS.md.
  app = join(base, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'AGENTS.md'), `# Project\nAlways say ${CANARY.agents}.\n`);
  // The machine's HOME, with Claude Code's and the agents' instructions and skills.
  home = join(base, 'home');
  for (const dir of ['.claude/skills/canary', '.agents/skills/canary']) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), `Always say ${CANARY.claude}.\n`);
  for (const dir of ['.claude', '.agents'])
    writeFileSync(join(home, dir, 'skills', 'canary', 'SKILL.md'), `---\nname: canary\ndescription: ${CANARY.skill}\n---\nSay ${CANARY.skill}.\n`);
  cwd0 = process.cwd();
  process.chdir(app);
  for (const k of envKeys) env0[k] = process.env[k];
  process.env.HOME = home;
  process.env.AI_GATEWAY_API_KEY = `${CANARY.env}-gateway`;
  process.env.VERCEL_OIDC_TOKEN = `${CANARY.env}-oidc`;
  process.env.HARNESS_CANARY_SECRET = CANARY.env;
  gateway = await scriptedGateway();
  world = createWorld({ dataDir: join(base, 'world'), recoverActiveRuns: false });
}, 60_000);

afterAll(async () => {
  await world?.close?.();
  await gateway?.close();
  process.chdir(cwd0);
  for (const k of envKeys) {
    if (env0[k] === undefined) delete process.env[k];
    else process.env[k] = env0[k];
  }
});

const hostRoot = () => join(base, 'sessions');

async function turn(tools: HostTool[] | undefined, prompt: string) {
  const sessions = durableSessions({
    world,
    harness: opencodeHarness({
      ...(tools ? { tools } : {}),
      root: hostRoot(),
      gatewayUrl: gateway.url,
      credential: async () => 'the-drives-credential',
    }),
  });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  const before = gateway.requests.length;
  const { sessionId } = await sessions.start({ prompt });
  const state = await until(async () => {
    const s = await sessions.inspect(sessionId);
    return transcriptOf(s).some((r) => r.data.type === 'turn') ? s : undefined;
  });
  return { sessionId, state, requests: gateway.requests.slice(before) };
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A directory and its real path (macOS's tmpdir is under /private). */
const forms = (dir: string) => {
  const abs = resolve(dir);
  try {
    return [...new Set([abs, realpathSync(abs)])];
  } catch {
    return [abs];
  }
};
const under = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r + sep));

const WRITES = /^(promises\.)?(appendFile|chmod|copyFile|cp|mkdir|mkdtemp|rename|rm|rmdir|symlink|truncate|unlink|utimes|writeFile|createWriteStream)(Sync)?$/;
/** Every access of this machine's files under the app's directory or HOME (where the canaries are), outside the session's own directories. */
function canaryAccess(trace: HostTrace, own: string[]): HostAccess[] {
  const roots = own.flatMap(forms);
  return trace.paths.filter((a) => {
    if (a.path.startsWith('node:')) return false;
    const p = resolve(a.path);
    if (under(p, roots)) return false;
    // Node's `realpath` steps through the directories above the session's own (it lstats each one).
    if (/\b(LOOP|gotStat)\b|node:fs:30\d\d/.test(a.stack) && roots.some((r) => r.startsWith(p + sep))) return false;
    return under(p, [...forms(app), ...forms(home)]);
  });
}

/** Every change this process made to this machine's files outside the session's own directories. */
function writesOutside(trace: HostTrace, own: string[]): HostAccess[] {
  const roots = own.flatMap(forms);
  return trace.paths.filter((a) => WRITES.test(a.method) && !a.path.startsWith('node:') && !under(resolve(a.path), roots));
}

const toolNames = (body: any) => (body?.tools ?? []).map((t: { name: string }) => t.name).sort();
const systemOf = (body: any) => (body?.prompt ?? []).filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');

const echo: HostTool<{ text: string }> = {
  name: 'echo',
  description: 'Echo the text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  replay: 'safe',
  execute: async ({ text }) => `echo: ${text}`,
};

describe('OpenCode with no line (tool-less)', () => {
  it("only the app's tools: OpenCode's own are not offered, a call to one is refused before it runs, nothing of this machine reaches the model, no process starts", { timeout: 120_000 }, async () => {
    const marker = join(base, 'ran-on-this-machine');
    gateway.script.push(
      () => toolCall('t1', 'shell', { command: `cat ~/.claude/CLAUDE.md; printenv; touch ${marker}` }),
      () => toolCall('t2', 'read', { path: join(app, 'AGENTS.md') }),
      () => toolCall('t3', 'write', { path: marker, content: 'x' }),
      () => toolCall('t4', 'echo', { text: 'hi' }),
      () => text('done')
    );
    const trace = traceHost();
    let run: Awaited<ReturnType<typeof turn>>;
    try {
      run = await turn([echo as HostTool], 'Hello.');
    } finally {
      trace.stop();
    }
    const { requests, state } = run;
    expect(requests).toHaveLength(5);
    // Offered: the app's tool, nothing of OpenCode's.
    for (const body of requests) expect(toolNames(body)).toEqual(['echo']);
    const r = toolResults(requests.at(-1));
    for (const id of ['t1', 't2', 't3']) expect(r.get(id)).toMatch(/not (currently )?available|No tool named|unavailable|invalid/i);
    expect(r.get('t4')).toBe('echo: hi');
    expect(existsSync(marker)).toBe(false);
    // Only the app's tool is in the log.
    expect(state.effectOrder.filter((e) => e.name.startsWith('tool.')).map((e) => e.name)).toEqual(['tool.echo']);
    expect(transcriptOf(state).at(-1)?.data).toEqual({ type: 'turn', status: 'completed' });

    // What the model saw: the default instructions, the date, no canary, no path of this machine.
    const system = systemOf(requests[0]);
    expect(system).toContain(DEFAULT_INSTRUCTIONS);
    expect(system).not.toContain('<env>');
    expect(system).not.toMatch(/Working directory|Platform:/);
    const seen = JSON.stringify(requests);
    for (const canary of Object.values(CANARY)) expect(seen).not.toContain(canary);
    const told = JSON.stringify([system, requests[0].tools, r.get('t4')]);
    for (const path of [app, home, base, tmpdir(), realpathSync(tmpdir())]) expect(told).not.toContain(path);

    // This machine: OpenCode started no process, read nothing where the canaries are, and changed nothing outside the session's own directories.
    const own = [hostRoot(), join(base, 'world')];
    expect(trace.spawns.map((s) => `${s.method} ${s.command} :: ${s.stack}`)).toEqual([]);
    // Nothing searched this machine's PATH (OpenCode's provider plugins that would, Azure's for `az`, are off).
    expect(trace.paths.filter((a) => /\b(which|isexe)\b/.test(a.stack)).map((a) => `${a.method} ${a.path}`)).toEqual([]);
    expect(canaryAccess(trace, own).map((a) => `${a.method} ${a.path} :: ${a.stack}`)).toEqual([]);
    expect(writesOutside(trace, own).map((a) => `${a.method} ${a.path} :: ${a.stack}`)).toEqual([]);
  });

  it('no tools at all: the model is offered none', { timeout: 120_000 }, async () => {
    gateway.script.push(() => toolCall('n1', 'shell', { command: 'ls /' }), () => text('none'));
    const trace = traceHost();
    let run: Awaited<ReturnType<typeof turn>>;
    try {
      run = await turn(undefined, 'Hello.');
    } finally {
      trace.stop();
    }
    const { requests, state } = run;
    for (const body of requests) expect(toolNames(body)).toEqual([]);
    expect(state.effectOrder.filter((e) => e.name.startsWith('tool.'))).toEqual([]);
    expect(trace.spawns).toEqual([]);
  });
});
