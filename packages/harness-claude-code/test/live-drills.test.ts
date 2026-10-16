/**
 * The live drills (docs/workspaces.md §11.4, decision 7): Claude Code in a
 * real Vercel Sandbox VM, with the real model through the AI Gateway, end to
 * end through the kernel (world-local), the session factory and the relay.
 *
 * - L1: turn 1 on VM A writes a file with Bash and learns a code word; VM A is
 *   deleted, the Drive kept; turn 2 on VM B reads the file and recalls the
 *   word, resumed from the log (`sessionStore`).
 * - L3: the VM deleted mid-Bash: the call comes back interrupted, with the
 *   recovery note, and is never rerun.
 * - L4: the driver's process killed mid-turn (SIGKILL, `live-driver.ts`): the
 *   relay kills the session's processes (`pgrep -u agent` empty) within 15 s,
 *   and the next delivery resumes the turn.
 * - L5: no secrets in the VM while the CLI runs (every process's environment
 *   and argv, and the dirs Claude's sandbox leaves to commands: TMPDIR, HOME,
 *   the cache, read as root: no Gateway credential, no OIDC token, no relay
 *   token, and no model key in those dirs), and the model's own commands
 *   have neither the CLI's model key nor a way to the model port (Claude's
 *   sandbox), not even through the sandbox's proxy by another loopback name.
 * - L8: the old VM session still holds the Drive (a VM deleted, its Drive not
 *   yet detached): the next VM waits out the 409s and resumes.
 * - L9: the relay's sockets dropped mid-turn (in the VM, as root): the drive
 *   re-attaches and finishes the turn in the same delivery.
 * - P0.7: every request the pinned CLI makes, at the tunnel (as it leaves
 *   the VM: method, path, query, header names, `anthropic-beta`, the body's
 *   model) and on its way to the Gateway (and the Gateway's status), with a
 *   main model and a distinct small one, and WebFetch exercised.
 *
 * Gated behind `DH_LIVE_SANDBOX=1`. Run it from a directory linked to the
 * project (`harness-sandbox/probes/lib.ts`: the Sandbox API and the Gateway
 * both take the development OIDC token `vercel link` gives), with a cheap
 * model (`DH_LIVE_MODEL`, default `claude-haiku-4-5`). Every sandbox and
 * Drive is named `dh-probe-a5*` and tagged, and `afterAll` deletes them (the
 * base's builder with its snapshot); `harness-sandbox/probes/sweep.ts` finds
 * what a killed run left. Nothing secret is printed or sent into a VM: the
 * logs keep header names and beta values only, and what is searched for a
 * secret is copied out of the VM and searched here.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { type DurableSessions, type SessionState } from 'harness-world';
import { CLAUDE_BETAS, gatewayCredential, gatewayUrl, type SessionMachine, transcriptOf } from 'harness-world-process';
import { devRelayArtifact, prepareBase } from 'harness-world-sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, created, probeName, TAGS, track } from '../../harness-sandbox/probes/lib.ts';
import { type LiveSession, liveSession, type TunnelEntry } from './live-session.ts';

const LIVE = process.env.DH_LIVE_SANDBOX === '1';
const MODEL = process.env.DH_LIVE_MODEL ?? 'claude-haiku-4-5';

/** What the request log keeps of one request: never a header's value but `anthropic-beta`'s, never a body's content. */
interface Logged {
  method: string;
  path: string;
  query: string;
  headers: string[];
  betas: string[];
  bodyKeys: string[];
  model?: string;
  status?: number;
}

/**
 * Between the drive's gateway handler and the Gateway: forwards every request
 * as it is (the handler already added the credential) and logs its shape.
 */
async function loggingProxy(): Promise<{ url: string; log: Logged[]; close(): Promise<void> }> {
  const target = new URL(gatewayUrl());
  const log: Logged[] = [];
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy');
    const body = await read(req);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = body.length ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {};
    } catch {}
    const entry: Logged = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.search.replace(/^\?/, ''),
      headers: Object.keys(req.headers).sort(),
      betas: String(req.headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean),
      bodyKeys: Object.keys(parsed).sort(),
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
    };
    log.push(entry);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length' && k !== 'connection') headers.set(k, v);
    try {
      const upstream = await fetch(new URL(`${url.pathname}${url.search}`, target), { method: req.method, headers, ...(body.length ? { body } : {}) });
      entry.status = upstream.status;
      res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k))));
      if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
    } catch (err) {
      entry.status = 599;
      res.writeHead(502).end(String((err as Error)?.message ?? err).slice(0, 200));
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log, close: () => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))) };
}

const turns = (s: SessionState) => transcriptOf(s).filter((r) => (r.data as { type?: string }).type === 'turn').length;
const assistantText = (s: SessionState) =>
  transcriptOf(s)
    .map((r) => r.data as { type?: string; role?: string; text?: string })
    .filter((e) => e.type === 'message' && e.role === 'assistant')
    .map((e) => e.text ?? '')
    .join('\n');
const bashCalls = (s: SessionState) => s.effectOrder.filter((e) => e.name === 'tool.Bash');
const commandOf = (e: { input?: unknown }) => String((e.input as { command?: unknown } | undefined)?.command ?? '');
const outputOf = (s: SessionState, key: string) => JSON.stringify(s.effects.get(key)?.output ?? s.effects.get(key)?.error ?? '');

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.runIf(LIVE)('live drills: Claude Code in a Vercel Sandbox, the real model through the Gateway', () => {
  let snapshot: string;
  let proxy: Awaited<ReturnType<typeof loggingProxy>>;
  const live: LiveSession[] = [];

  beforeAll(async () => {
    // The test seam (the names) is guarded like the stand-in.
    process.env.DH_TEST_LOCAL_SANDBOX = '1';
    const builder = track('sandbox', probeName('a5base'));
    const base = await prepareBase({ region: 'iad1', relay: await devRelayArtifact(), name: builder, tags: TAGS });
    created.snapshots.add(base.snapshotId);
    snapshot = base.snapshotId;
    proxy = await loggingProxy();
  }, 10 * 60_000);

  // A Drive can be deleted only once it detached (6-20 s after its VM went, P0.5): the cleanup retries for longer than a hook's default.
  afterAll(async () => {
    for (const l of live) await l.world.close?.().catch(() => {});
    await proxy?.close();
    expect(await cleanup()).toEqual([]);
  }, 300_000);

  interface Session extends LiveSession {
    name: string;
    dataDir: string;
    logs: string[];
    machines: SessionMachine[];
    tunnel: TunnelEntry[];
  }

  /** A session on a Drive and VM of its own (`dh-probe-a5<what>`), Claude Code's own tools on. `continues` reuses another's names and log (a later invocation). */
  async function session(what: string, options: { model?: string; smallModel?: string; continues?: Session; recover?: boolean } = {}): Promise<Session> {
    const name = options.continues?.name ?? probeName(`a5${what}`);
    if (!options.continues) {
      track('sandbox', name);
      track('drive', name);
    }
    const dataDir = options.continues?.dataDir ?? (await mkdtemp(join(tmpdir(), `dh-live-${what}-`)));
    const logs: string[] = [];
    const machines: SessionMachine[] = [];
    const tunnel: TunnelEntry[] = [];
    const log = (m: string, f?: Record<string, unknown>) => void logs.push(`${m} ${f ? JSON.stringify(f).slice(0, 300) : ''}`);
    const s = await liveSession({
      dataDir,
      snapshot,
      name,
      gatewayUrl: proxy.url,
      model: options.model ?? MODEL,
      ...(options.smallModel ? { smallModel: options.smallModel } : {}),
      ...(options.recover ? { recover: true } : {}),
      log,
      onAttach: (m) => void machines.push(m),
      tunnel: (e) => void tunnel.push(e),
    });
    live.push(s);
    return { ...s, name, dataDir, logs, machines, tunnel };
  }

  const waitTurns = (sessions: DurableSessions, id: string, n: number) =>
    until(
      async () => {
        const s = await sessions.inspect(id);
        return turns(s) >= n ? s : undefined;
      },
      6 * 60_000,
      `${n} turns`
    );

  /** Run a shell script in the VM as root (the platform's control plane, not the relay). */
  async function asRoot(name: string, script: string): Promise<{ code: number | null; out: string }> {
    const { Sandbox } = await import('@vercel/sandbox');
    const r = await (await Sandbox.get({ name })).runCommand({ cmd: 'bash', args: ['-c', script], sudo: true });
    return { code: r.exitCode, out: `${await r.stdout()}${await r.stderr()}` };
  }

  /** The Function's secrets this test can see: what must never be in a VM. */
  const secrets = async () =>
    [
      await gatewayCredential().catch(() => ''),
      ...Object.entries(process.env)
        .filter(([k, v]) => /TOKEN|KEY|SECRET|PASSWORD|OIDC|BYPASS/i.test(k) && typeof v === 'string' && v.length >= 16)
        .map(([, v]) => v as string),
    ].filter(Boolean);

  it('L1: a file and a code word on VM A; VM A deleted, the Drive kept; VM B reads the file and recalls the word', async () => {
    const { Sandbox } = await import('@vercel/sandbox');
    const { sessions, name, logs } = await session('l1');
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'The code word is heron. Run this Bash command: echo heron > note.txt');
    const one = await waitTurns(sessions, sessionId, 1);
    expect(bashCalls(one).map((e) => e.status)).toContain('completed');
    const vmA = (await Sandbox.get({ name })).currentSession().sessionId;
    await (await Sandbox.get({ name })).delete();

    await sessions.send(sessionId, 'What was the code word? Then run this Bash command: cat note.txt');
    const two = await waitTurns(sessions, sessionId, 2);
    const vmB = (await Sandbox.get({ name })).currentSession().sessionId;
    console.log('[live] L1', { vmA, vmB, said: assistantText(two).slice(-300) });
    expect(vmB).not.toBe(vmA);
    const cat = bashCalls(two).find((e) => commandOf(e).includes('cat note.txt'));
    expect(cat?.status).toBe('completed');
    expect(outputOf(two, cat!.key)).toContain('heron');
    expect(assistantText(two).toLowerCase()).toContain('heron');
    expect(logs.filter((l) => /mirror_unmapped/.test(l))).toEqual([]);
  }, 15 * 60_000);

  it('L3: the VM deleted mid-Bash: the call comes back interrupted with the recovery note, never rerun', async () => {
    const { Sandbox } = await import('@vercel/sandbox');
    const { sessions, name } = await session('l3');
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'Run this Bash command: echo started >> runs.txt; sleep 40; echo done >> runs.txt');
    await until(
      async () => {
        const s = await sessions.inspect(sessionId);
        return bashCalls(s).some((e) => e.status === 'running') ? true : undefined;
      },
      5 * 60_000,
      'the command to start'
    );
    await new Promise((r) => setTimeout(r, 3000));
    await (await Sandbox.get({ name })).delete();
    const state = await waitTurns(sessions, sessionId, 1);
    const runs = bashCalls(state).filter((e) => commandOf(e).includes('echo started'));
    console.log('[live] L3', { calls: bashCalls(state).map((e) => [commandOf(e).slice(0, 60), e.status]), said: assistantText(state).slice(-300) });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: { interrupted: true } });
    const note = transcriptOf(state)
      .map((r) => r.data as { type?: string; synthetic?: string; text?: string })
      .find((e) => e.type === 'message' && e.synthetic === 'recovery');
    expect(note?.text).toContain('interrupted before it reported a result');
    // What the Drive holds: the command's first half, once.
    await sessions.send(sessionId, 'Run this Bash command: cat runs.txt');
    const after = await waitTurns(sessions, sessionId, 2);
    const cat = bashCalls(after).find((e) => commandOf(e) === 'cat runs.txt' || commandOf(e).startsWith('cat runs.txt'));
    expect(outputOf(after, cat!.key).match(/started/g)).toHaveLength(1);
  }, 15 * 60_000);

  it("L4: the driver's process killed mid-turn: the session's processes in the VM are gone within 15 s, and the next delivery resumes the turn", async () => {
    const name = probeName('a5l4');
    track('sandbox', name);
    track('drive', name);
    const dataDir = await mkdtemp(join(tmpdir(), 'dh-live-l4-'));
    const prompt = 'Run this Bash command: echo started >> runs.txt; sleep 60; echo done >> runs.txt';
    const child = spawn(process.execPath, ['--import', 'tsx', new URL('./live-driver.ts', import.meta.url).pathname, JSON.stringify({ dataDir, snapshot, name, gatewayUrl: proxy.url, model: MODEL, prompt })], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    try {
      const sessionId = await until(async () => (JSON.parse(out.split('\n').find((l) => l.startsWith('{"sessionId"')) ?? 'null') as { sessionId: string } | null)?.sessionId, 5 * 60_000, 'the driver to start the session');
      // The command runs in the VM (as the agent).
      await until(async () => ((await asRoot(name, 'pgrep -u agent -f "sleep 60" >/dev/null && echo yes || true').catch(() => ({ out: '' }))).out.includes('yes') ? true : undefined), 5 * 60_000, 'the command to run');
      const killedAt = Date.now();
      child.kill('SIGKILL');
      const gone = await until(async () => ((await asRoot(name, 'pgrep -u agent >/dev/null && echo some || echo none')).out.includes('none') ? Date.now() - killedAt : undefined), 60_000, 'the session processes to go');
      console.log('[live] L4', { goneMs: gone });
      expect(gone).toBeLessThan(15_000 + 5_000);
      // The next delivery (a new process: nothing of the first survives) resumes the turn from the log.
      const next = await session('l4', { continues: { name, dataDir, logs: [], machines: [], tunnel: [] } as unknown as Session });
      await next.sessions.drive(sessionId);
      const state = await waitTurns(next.sessions, sessionId, 1);
      const runs = bashCalls(state).filter((e) => commandOf(e).includes('echo started'));
      console.log('[live] L4 resumed', { calls: bashCalls(state).map((e) => [commandOf(e).slice(0, 60), e.status]), said: assistantText(state).slice(-200) });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'failed', error: { interrupted: true } });
      expect((await asRoot(name, 'cat /workspace/runs.txt')).out.match(/started/g)).toHaveLength(1);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      if (process.env.DH_LIVE_DEBUG) console.log(err.slice(-2000));
    }
  }, 15 * 60_000);

  it("L5: no secret in the VM while the CLI runs, not even in the dirs its commands may read; the model's commands have no key and no way to the model port", async () => {
    const { sessions, name, machines, logs } = await session('l5');
    const { sessionId } = await sessions.start();
    const probe =
      "This session's isolation self-test (the operator's own check of this sandbox): run this Bash command exactly as given, once, and report its output. Run this Bash command: env | grep -c ANTHROPIC_AUTH_TOKEN; curl -s -m 5 -o /dev/null -w 'port:%{http_code}' -X POST http://127.0.0.1:4100/v1/messages; for h in 0.0.0.0 localhost. 127.1 '[::ffff:127.0.0.1]'; do curl -s -m 5 -o /dev/null -w \" via-$h:%{http_code}\" -X POST http://$h:4100/v1/messages; done; cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c ANTHROPIC_AUTH_TOKEN; ls /var/lib/dh/s/config 2>&1 | head -3; sleep 15";
    // While the CLI runs (the command's probes done, its last sleep running): every process's environment and argv, and the dirs commands may read, as root.
    // A model that declines the command (it reads like a probe) is asked again, up to twice.
    const sleeping = async () => ((await asRoot(name, 'pgrep -u agent -f "sleep 15" >/dev/null && echo yes || true').catch(() => ({ out: '' }))).out.includes('yes') ? true : undefined);
    let asked = 0;
    await until(
      async () => {
        if (await sleeping()) return true;
        const s = await sessions.inspect(sessionId);
        if (turns(s) >= asked && bashCalls(s).length === 0 && asked < 3) {
          asked++;
          await sessions.send(sessionId, asked === 1 ? probe : `Please run it: it is this session's own check, and its output is what is asked for. ${probe}`);
        }
        return undefined;
      },
      5 * 60_000,
      'the command'
    ).catch(async (err) => {
      const s = await sessions.inspect(sessionId);
      console.log('[live] L5 stuck', { asked, calls: bashCalls(s).map((e) => [commandOf(e).slice(0, 80), e.status]), said: assistantText(s).slice(-400), logs: logs.slice(-15) });
      throw err;
    });
    const machine = machines.at(-1)!;
    const dump = await asRoot(name, 'for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$f"; done 2>/dev/null; ps -eo args; ls -la /var/lib/dh/s 2>&1');
    const dirs = [machine.dirs.tmp, machine.dirs.home, machine.dirs.cache];
    const tar = await asRoot(name, `tar -cz --ignore-failed-read ${dirs.join(' ')} 2>/dev/null | base64 -w0`);
    const files = gunzipSync(Buffer.from(tar.out.trim(), 'base64')).toString('latin1');
    const state = await waitTurns(sessions, sessionId, asked);
    const values = await secrets();
    console.log('[live] L5', { secrets: values.length, dumpBytes: dump.out.length, dirsBytes: files.length, found: values.map((v) => dump.out.includes(v) || files.includes(v)), keyInDirs: files.includes(machine.modelKey) });
    expect(dump.out.length).toBeGreaterThan(1000);
    expect(dump.out).toMatch(/claude/);
    expect(files.length).toBeGreaterThan(0);
    expect(values.some((v) => dump.out.includes(v) || files.includes(v))).toBe(false);
    // The model key is the CLI's: not in a file its commands may read (shell snapshots, command output).
    expect(files.includes(machine.modelKey)).toBe(false);
    // The model's command: no key in its environment or any it can read, the model port unreachable by any loopback name, the CLI's config dir hidden.
    const [call] = bashCalls(state);
    const out = outputOf(state, call!.key);
    console.log('[live] L5 command', out.slice(0, 500));
    expect(out).toMatch(/port:000/);
    // Every way to the port is refused before it: no connection (000), or the sandbox's proxy refusing a denied host (403, with a
    // sandbox violation). The port itself would answer 401 (no key), and the handler 2xx or 400: none of those.
    const statuses = [...out.matchAll(/(?:port|via-(?:\[[^\]]*\]|[^:\s]+)):(\d{3})/g)].map((m) => m[1]);
    expect(statuses).toHaveLength(5);
    expect(statuses.every((c) => c === '000' || c === '403')).toBe(true);
    if (statuses.includes('403')) expect(out).toContain('deny network-outbound');
    expect(out).toMatch(/(^|\\n|")0(\\n|\\\\n)/);
  }, 15 * 60_000);

  it('L8: the old VM session still holds the Drive (deleted, not yet detached): the next VM waits out the 409s, then resumes', async () => {
    const { Sandbox } = await import('@vercel/sandbox');
    const { sessions, name, logs, failed } = await session('l8');
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'Run this Bash command: echo kestrel > word.txt');
    await waitTurns(sessions, sessionId, 1);
    const vmA = (await Sandbox.get({ name })).currentSession().sessionId;
    // Deleted; its Drive detaches 6-20 s later (P0.5). The next turn starts at once.
    await (await Sandbox.get({ name })).delete();
    const at = Date.now();
    await sessions.send(sessionId, 'Run this Bash command: cat word.txt');
    const two = await waitTurns(sessions, sessionId, 2);
    const vmB = (await Sandbox.get({ name })).currentSession().sessionId;
    const waited = logs.filter((l) => /still attached|stayed busy|contended/.test(l));
    console.log('[live] L8', { vmA, vmB, ms: Date.now() - at, waited, failed: failed.length });
    expect(vmB).not.toBe(vmA);
    // The new VM's create met the old session's hold on the Drive (409), and waited it out.
    expect(waited.some((l) => l.includes('still attached to an earlier VM session'))).toBe(true);
    const cat = bashCalls(two).find((e) => commandOf(e).includes('cat word.txt'));
    expect(outputOf(two, cat!.key)).toContain('kestrel');
  }, 15 * 60_000);

  it("L9: the relay's sockets dropped mid-turn: the drive re-attaches and finishes the turn in the same delivery", async () => {
    const { sessions, name, logs, failed } = await session('l9');
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'Run this Bash command: echo started >> runs.txt; sleep 20; echo done >> runs.txt');
    await until(async () => ((await asRoot(name, 'pgrep -u agent -f "sleep 20" >/dev/null && echo yes || true').catch(() => ({ out: '' }))).out.includes('yes') ? true : undefined), 5 * 60_000, 'the command to run');
    // Both of the link's sockets (/ctl and /model come in on the relay port), killed in the VM's kernel.
    const killed = await asRoot(name, "ss -K state established '( sport = :2010 )' 2>&1 | tail -3; echo exit=$?");
    await until(async () => (logs.some((l) => l.startsWith('relay link lost')) ? true : undefined), 30_000, 'the link to drop').catch(async () => {
      // A kernel without socket destroy: restart the relay instead (its sockets go with it).
      console.log('[live] L9: ss -K had no effect; killing the relay', killed.out.slice(0, 200));
      await asRoot(name, "pkill -9 -f '/opt/dh/relay serve' || true");
      await until(async () => (logs.some((l) => l.startsWith('relay link lost')) ? true : undefined), 30_000, 'the link to drop');
    });
    const state = await waitTurns(sessions, sessionId, 1);
    console.log('[live] L9', { calls: bashCalls(state).map((e) => [commandOf(e).slice(0, 60), e.status]), rebuilt: logs.filter((l) => l.includes('rebuilt from the log')).length, failed });
    // In the same delivery: no failed delivery, the drive rebuilt from the log, the command interrupted, not rerun.
    expect(failed).toEqual([]);
    expect(logs.some((l) => l.includes('the drive is rebuilt from the log'))).toBe(true);
    const runs = bashCalls(state).filter((e) => commandOf(e).includes('echo started'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect((await asRoot(name, 'cat /workspace/runs.txt')).out.match(/started/g)).toHaveLength(1);
  }, 15 * 60_000);

  it('P0.7: every request the CLI makes, at the tunnel and at the Gateway, with a main model and a distinct small one and WebFetch exercised', async () => {
    const main = 'claude-sonnet-4-5';
    const small = MODEL === main ? 'claude-haiku-4-5' : MODEL;
    const { sessions, logs, tunnel } = await session('p07', { model: main, smallModel: small });
    const { sessionId } = await sessions.start();
    const from = proxy.log.length;
    await sessions.send(sessionId, 'Use the WebFetch tool to fetch https://example.com and tell me the page title in a few words.');
    const state = await waitTurns(sessions, sessionId, 1);
    const sent = proxy.log.slice(from);
    console.log('[live] P0.7 tunnel', JSON.stringify(tunnel, null, 1));
    console.log('[live] P0.7 gateway', JSON.stringify(sent.map((r) => ({ method: r.method, path: r.path, query: r.query, model: r.model, status: r.status })), null, 1));
    console.log('[live] P0.7 calls', JSON.stringify(state.effectOrder.filter((e) => e.name.startsWith('tool.')).map((e) => [e.name, e.status])), assistantText(state).slice(-200));
    expect(tunnel.length).toBeGreaterThan(0);
    expect(sent.every((r) => r.status !== undefined && r.status < 400)).toBe(true);
    for (const r of [...tunnel, ...sent]) for (const b of r.betas) expect(CLAUDE_BETAS.has(b)).toBe(true);
    // The handler passed every beta the CLI sent (it drops, and logs, any it doesn't know), and every model the CLI named was one of the session's two.
    expect(logs.filter((l) => l.includes('dropped anthropic-beta values'))).toEqual([]);
    for (const r of tunnel) if (r.model) expect([main, small]).toContain(r.model);
    expect(sent.some((r) => r.method === 'POST' && r.path === '/v1/messages')).toBe(true);
  }, 15 * 60_000);
});
