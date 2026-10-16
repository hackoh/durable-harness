/**
 * The relay and the stand-in (docs/workspaces.md §5.4, §11.4 A2 row), over a
 * real relay child (`localMachine`, the bundle). Every case outside the last
 * block runs on the degraded tier (one uid, process-group kill): the protocol,
 * auth, hello, fence, heartbeats, frames, `FILES`/`WIPE`, tails and the model
 * tunnel. The privileged cases (the uid drop, cgroup kills of a setsid'd
 * grandchild, cache dirs the agent owns) run only as root and in the live
 * suite (`live-relay.test.ts`).
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isBrandedMachine, type SessionMachine } from 'harness-world-process';
import type { WsRequestHandler } from 'harness-world-remote/ws';
import { localMachine, SESSION, startRelay, type LocalSandbox } from './local-machine.ts';
import { armRequest, requestArm, runArm } from '../src/relay/arm.ts';
import { dialRelay, type RelaySocket } from '../src/relay/dial.ts';
import { CTL, frame, json, mintToken, tokenHash } from '../src/relay/protocol.ts';
import { brandForTests } from '../src/session.ts';

beforeAll(() => {
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
});

const PRIV = process.getuid?.() === 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const collect = async (lines: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const l of lines) out.push(l);
  return out;
};

const toDispose: Array<{ dispose: () => Promise<void> } | { stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of toDispose.splice(0)) await ('dispose' in d ? d.dispose() : d.stop()).catch(() => {});
});
function track<T extends { dispose: () => Promise<void> } | { stop: () => Promise<void> }>(d: T): T {
  toDispose.push(d);
  return d;
}

/** Spawn `echo $$; <rest>` and return the process and the pid it printed. */
async function spawnPid(machine: SessionMachine, script: string) {
  const proc = await machine.spawn({ command: 'bash', args: ['-c', `echo $$; ${script}`] });
  const it0 = proc.lines()[Symbol.asyncIterator]();
  const pid = Number((await it0.next()).value);
  return { proc, pid, it: it0 };
}

describe('the relay, degraded tier', () => {
  it('spawns a command as the session user and streams its output', async () => {
    const sb = track(await localMachine());
    const proc = await sb.machine.spawn({ command: 'bash', args: ['-c', 'echo hello-relay'] });
    const [line] = await collect(proc.lines());
    const exit = await proc.exited;
    expect(line).toBe('hello-relay');
    expect(exit.code).toBe(0);
  });

  it('a driver close kills the whole session tree', async () => {
    const sb = track(await localMachine());
    const { pid } = await spawnPid(sb.machine, 'sleep 30');
    sb.link.close();
    await sleep(500);
    expect(aliveProcess(pid)).toBe(false);
  });

  it('an idle link survives past the 15 s silence window (pings and pongs are liveness)', async () => {
    const sb = track(await localMachine());
    const { pid } = await spawnPid(sb.machine, 'sleep 60');
    await sleep(21_000);
    expect(sb.link.isLost()).toBe(false);
    expect(aliveProcess(pid)).toBe(true);
    // And it still works.
    const proc = await sb.machine.spawn({ command: 'bash', args: ['-c', 'echo still-here'] });
    expect(await collect(proc.lines())).toEqual(['still-here']);
  }, 40_000);

  it('every stdout byte arrives before the exit (EXIT on close)', async () => {
    const sb = track(await localMachine());
    const proc = await sb.machine.spawn({ command: 'bash', args: ['-c', "head -c 3000000 /dev/zero | tr '\\0' a"] });
    let bytes = 0;
    for await (const chunk of (proc as unknown as { chunks(): AsyncIterable<Uint8Array> }).chunks()) bytes += chunk.length;
    expect(bytes).toBe(3_000_000);
    expect((await proc.exited).code).toBe(0);
  });

  it('a 3 MB stdin line reaches the child whole', async () => {
    const sb = track(await localMachine());
    const proc = await sb.machine.spawn({ command: 'bash', args: ['-c', 'wc -c'] });
    proc.send('x'.repeat(3_000_000));
    proc.end();
    expect((await collect(proc.lines())).join('').trim()).toBe('3000001');
  });

  it('kill() takes the whole session: a sibling and a SIGTERM-trapping child die too', async () => {
    const sb = track(await localMachine());
    const a = await spawnPid(sb.machine, 'sleep 30');
    const b = await spawnPid(sb.machine, "trap '' TERM; sleep 30");
    a.proc.kill('SIGTERM');
    await sleep(300);
    expect(aliveProcess(a.pid)).toBe(false);
    expect(aliveProcess(b.pid)).toBe(true); // it trapped SIGTERM
    // A loss is SIGKILL: the trapping child is still tracked, and dies.
    sb.link.close();
    await sleep(500);
    expect(aliveProcess(b.pid)).toBe(false);
  });

  it("a spawn's abort signal kills the session's processes", async () => {
    const sb = track(await localMachine());
    const ac = new AbortController();
    const proc = await sb.machine.spawn({ command: 'bash', args: ['-c', 'echo $$; sleep 30'], signal: ac.signal });
    const pid = Number((await proc.lines()[Symbol.asyncIterator]().next()).value);
    ac.abort();
    await sleep(400);
    expect(aliveProcess(pid)).toBe(false);
  });

  it('serves the CLI model port through the /model socket to the driver handler', async () => {
    const seen: { method: string; path: string; body: string }[] = [];
    const model: WsRequestHandler = async (req) => {
      seen.push({ method: req.method, path: req.path, body: req.body ? Buffer.from(req.body as Uint8Array).toString() : '' });
      return { status: 200, headers: { 'content-type': 'application/json' }, body: toStream(Buffer.from(JSON.stringify({ ok: true, echo: req.path }))) };
    };
    const sb = track(await localMachine({ model }));
    const port = sb.config.modelPort;
    const proc = await sb.machine.spawn({
      command: 'node',
      args: ['-e', `fetch('http://127.0.0.1:${port}/v1/messages',{method:'POST',body:'{"m":1}',headers:{authorization:'Bearer '+process.env.ANTHROPIC_AUTH_TOKEN}}).then(r=>r.text()).then(t=>console.log('RESP '+t))`],
      env: { ANTHROPIC_AUTH_TOKEN: sb.machine.modelKey },
    });
    const lines = await collect(proc.lines());
    await proc.exited;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1/messages', body: '{"m":1}' });
    expect(lines.join('\n')).toContain('RESP {"ok":true,"echo":"/v1/messages"}');
  });

  it('a driver refusal reaches the CLI as a status it handles: a spend cap 403 (not retried), the concurrency cap 429 (retried)', async () => {
    const model: WsRequestHandler = async (req) => {
      throw Object.assign(new Error('cap'), { code: req.path.slice(1) });
    };
    const sb = track(await localMachine({ model, modelKey: null }));
    const base = `http://127.0.0.1:${sb.config.modelPort}`;
    const got: Record<string, [number, string]> = {};
    for (const code of ['bad_request', 'forbidden', 'budget', 'busy', 'upstream', 'internal']) {
      const r = await fetch(`${base}/${code}`, { method: 'POST', body: '{}' });
      got[code] = [r.status, ((await r.json()) as { error: { type: string } }).error.type];
    }
    expect(got).toEqual({ bad_request: [400, 'bad_request'], forbidden: [403, 'forbidden'], budget: [403, 'budget'], busy: [429, 'busy'], upstream: [502, 'upstream'], internal: [500, 'internal'] });
  });

  it('a 3 MB model body goes through, a ninth concurrent call gets 503, and a /model close mid-request is a 502 with the handler aborted', async () => {
    let held: (() => void)[] = [];
    let aborted = 0;
    const model: WsRequestHandler = (req, signal) => {
      if (req.path === '/size') return Promise.resolve({ status: 200, headers: {}, body: toStream(Buffer.from(String((req.body as Uint8Array).length))) });
      return new Promise((resolve, reject) => {
        held.push(() => resolve({ status: 200, headers: {}, body: toStream(Buffer.from('ok')) }));
        signal.addEventListener('abort', () => (aborted++, reject(new Error('aborted'))));
      });
    };
    const sb = track(await localMachine({ model, modelKey: null }));
    const base = `http://127.0.0.1:${sb.config.modelPort}`;
    const size = await fetch(`${base}/size`, { method: 'POST', body: new Uint8Array(3_000_000) });
    expect(await size.text()).toBe('3000000');
    const eight = Array.from({ length: 8 }, () => fetch(`${base}/hold`).then((r) => r.status));
    await sleep(300);
    expect((await fetch(`${base}/ninth`)).status).toBe(503);
    for (const r of held.splice(0)) r();
    expect(await Promise.all(eight)).toEqual(Array(8).fill(200));
    const mid = fetch(`${base}/hold`).then((r) => r.status);
    await sleep(200);
    sb.link.close();
    expect(await mid).toBe(502);
    await sleep(100);
    expect(aborted).toBe(1);
    held = [];
  });

  it("the model port admits only the attach's key (its bearer or x-api-key), and says so at arm (P0.16)", async () => {
    const model: WsRequestHandler = async () => ({ status: 200, headers: {}, body: toStream(Buffer.from('ok')) });
    const sb = track(await localMachine({ model }));
    const url = `http://127.0.0.1:${sb.config.modelPort}/v1/messages`;
    // A process the attach spawned, with and without the key.
    const call = async (header: string) => {
      const proc = await sb.machine.spawn({ command: 'node', args: ['-e', `fetch(${JSON.stringify(url)},{method:'POST',body:'{}',headers:${header}}).then(r=>console.log('STATUS '+r.status))`], env: { ANTHROPIC_AUTH_TOKEN: sb.machine.modelKey } });
      const lines = await collect(proc.lines());
      await proc.exited;
      return lines.find((l) => l.startsWith('STATUS'));
    };
    expect(await call(`{authorization:'Bearer '+process.env.ANTHROPIC_AUTH_TOKEN}`)).toBe('STATUS 200');
    expect(await call(`{'x-api-key':process.env.ANTHROPIC_AUTH_TOKEN}`)).toBe('STATUS 200');
    expect(await call(`{}`)).toBe('STATUS 401');
    expect(await call(`{authorization:'Bearer dhm-not-the-key-of-this-attach'}`)).toBe('STATUS 401');
    // The arm reply: the key was named, and where /proc can tell processes apart, the caller's pid is checked too.
    const { reply } = await sb.arm();
    expect(reply.ok && reply.modelAuth).toBe(existsSync('/proc/net/tcp'));
    const unkeyed = await sb.arm({ modelKey: null });
    expect(unkeyed.reply.ok && unkeyed.reply.modelAuth).toBe(false);
  });

  it('the model port checks its caller before anything else: a call without the key is 401 from a driver with no model handler too (the release gate checks it with no /model link at all)', async () => {
    const sb = track(await localMachine());
    const url = `http://127.0.0.1:${sb.config.modelPort}/v1/messages`;
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', body: '{}', headers: { authorization: 'Bearer dhm-not-the-key-of-this-attach' } })).status).toBe(401);
    // The attach's own process, with the key: past the check, and only then told the driver has no handler.
    const proc = await sb.machine.spawn({ command: 'node', args: ['-e', `fetch(${JSON.stringify(url)},{method:'POST',body:'{}',headers:{authorization:'Bearer '+process.env.ANTHROPIC_AUTH_TOKEN}}).then(r=>console.log('STATUS '+r.status))`], env: { ANTHROPIC_AUTH_TOKEN: sb.machine.modelKey } });
    const lines = await collect(proc.lines());
    await proc.exited;
    expect(lines.find((l) => l.startsWith('STATUS'))).toBe('STATUS 500');
  });

  it.runIf(existsSync('/proc/net/tcp'))("the model port refuses a caller that isn't a process the attach spawned, even with the key: a descendant, or another process", async () => {
    const model: WsRequestHandler = async () => ({ status: 200, headers: {}, body: toStream(Buffer.from('ok')) });
    const sb = track(await localMachine({ model }));
    const url = `http://127.0.0.1:${sb.config.modelPort}/v1/messages`;
    const fetchJs = `fetch(${JSON.stringify(url)},{method:'POST',body:'{}',headers:{authorization:'Bearer '+process.env.ANTHROPIC_AUTH_TOKEN}}).then(r=>console.log('STATUS '+r.status))`;
    // The child runs a grandchild that holds the key (what a model command inherits) and calls the port.
    const proc = await sb.machine.spawn({ command: 'node', args: ['-e', `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(fetchJs)}],{stdio:'inherit'})`], env: { ANTHROPIC_AUTH_TOKEN: sb.machine.modelKey } });
    const lines = await collect(proc.lines());
    await proc.exited;
    expect(lines.find((l) => l.startsWith('STATUS'))).toBe('STATUS 403');
    // This process holds the key, and was never spawned by the attach.
    const r = await fetch(url, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${sb.machine.modelKey}` } });
    expect(r.status).toBe(403);
  });

  it('FILES unpacks into a cache dir (5 MB through chunks), WIPE clears it, FSYNC answers', async () => {
    const sb = track(await localMachine());
    const big = new Uint8Array(5 << 20).fill(65);
    await sb.machine.files.upload('config', [
      { path: 'projects/a/note.txt', bytes: new TextEncoder().encode('kept') },
      { path: 'projects/a/big.bin', bytes: big },
    ]);
    const read = await sb.machine.workspace.exec(`cat ${sb.machine.dirs.config}/projects/a/note.txt; echo; wc -c < ${sb.machine.dirs.config}/projects/a/big.bin | tr -d ' '`);
    expect(read.stdout).toBe(`kept\n${5 << 20}\n`);
    await sb.machine.fsync();
    await sb.machine.files.wipe();
    const gone = await sb.machine.workspace.exec(`test -e ${sb.machine.dirs.config}/projects/a/note.txt && echo there || echo gone`);
    expect(gone.stdout).toBe('gone\n');
  });

  it('a FILES whose tar is corrupt fails alone: the link stays up and the next op works', async () => {
    const sb = track(await localMachine());
    await expect(sb.machine.files.upload('config', [{ path: 'ok.txt', bytes: new Uint8Array(1) }]).then(() => sb.link.files('config', new Uint8Array(4096).fill(7)))).rejects.toThrow(/tar/);
    expect(sb.link.isLost()).toBe(false);
    await sb.machine.fsync();
  });

  it('exec returns stdout byte for byte', async () => {
    const sb = track(await localMachine());
    const r = await sb.machine.workspace.exec("printf 'a\\r\\nb'");
    expect(r.stdout).toBe('a\r\nb');
  });

  it('tails a file the session appends to; sync drains it; the offset tracks consumed lines', async () => {
    const sb = track(await localMachine());
    const sh = sb.machine.workspace.exec.bind(sb.machine.workspace);
    const dir = sb.machine.dirs['codex-home'];
    await sh(`printf 'a\\nb\\n' > ${dir}/rollout.jsonl`);
    const tail = await sb.machine.tail('codex-home', 'rollout.jsonl');
    await tail.sync();
    expect(tail.read()).toEqual(['a', 'b']);
    await sh(`printf 'c\\npartial' >> ${dir}/rollout.jsonl`);
    await tail.sync();
    expect(tail.read()).toEqual(['c']);
    expect(tail.offset).toBe(6);
    tail.close();
  });

  it('a tail fails for good when the file shrinks, is replaced, is a symlink (last or middle component), or holds a line over 16 MiB', async () => {
    const sb = track(await localMachine());
    // Every file is made by the session user, as the CLI would (the privileged tier refuses a file it does not own).
    const sh = async (script: string) => expect((await sb.machine.workspace.exec(script)).exitCode).toBe(0);
    const dir = sb.machine.dirs['codex-home'];
    const outside = join(sb.config.stateDir, '..', 'outside.txt');
    writeFileSync(outside, 'secret\n');

    await sh(`printf 'one\\ntwo\\n' > ${dir}/shrink.jsonl`);
    const shrink = await sb.machine.tail('codex-home', 'shrink.jsonl');
    await shrink.sync();
    await sh(`truncate -s 2 ${dir}/shrink.jsonl`);
    await expect(shrink.sync()).rejects.toThrow(/shrank/);
    expect(() => shrink.read()).toThrow(/shrank/);

    await sh(`printf 'one\\n' > ${dir}/replace.jsonl`);
    const replace = await sb.machine.tail('codex-home', 'replace.jsonl');
    await replace.sync();
    await sh(`printf 'one\\nmore\\n' > ${dir}/other.jsonl && mv ${dir}/other.jsonl ${dir}/replace.jsonl`);
    await expect(replace.sync()).rejects.toThrow(/replaced/);

    await sh(`ln -s ${outside} ${dir}/link.jsonl`);
    const link = await sb.machine.tail('codex-home', 'link.jsonl');
    await expect(link.sync()).rejects.toThrow(/symlink/);
    expect(() => link.read()).toThrow(/symlink/);

    await sh(`ln -s ${join(sb.config.stateDir, '..')} ${dir}/up`);
    const viaDir = await sb.machine.tail('codex-home', 'up/outside.txt');
    await expect(viaDir.sync()).rejects.toThrow(/outside|not the session/);

    await sh(`head -c ${(16 << 20) + 10} /dev/zero | tr '\\0' x > ${dir}/long.jsonl`);
    const long = await sb.machine.tail('codex-home', 'long.jsonl');
    await expect(long.sync()).rejects.toThrow(/16 MiB/);

    expect(sb.link.isLost()).toBe(false);
  });

  it("a tail doesn't outlive its link: a later attach never sees the old tail's lines", async () => {
    const sb = track(await localMachine());
    const dir = sb.machine.dirs['codex-home'];
    await sb.machine.workspace.exec(`touch ${dir}/old.jsonl ${dir}/new.jsonl`);
    const first = sb.link.tail('codex-home', 'old.jsonl');
    sb.link.close();
    expect(() => first.read()).toThrow(/lost/);
    await sleep(300);
    const again = await sb.arm({ fence: { count: 1, fenced: true } });
    if (!again.reply.ok) throw new Error(JSON.stringify(again.reply));
    const link2 = await sb.dial({ token: again.token, nonce: again.reply.R });
    const second = link2.tail('codex-home', 'new.jsonl'); // the same tail id (1) on the new link
    appendFileSync(join(dir, 'old.jsonl'), 'from-the-old-file\n');
    await sleep(400);
    await second.sync();
    expect(second.read()).toEqual([]);
    link2.close();
  });

  for (const [what, bad] of [
    ['a SPAWN that is not JSON', frame(CTL.SPAWN, 99, new TextEncoder().encode('{not json'))],
    ['an unknown frame type', frame(77, 1)],
    ['a frame over 1 MiB', frame(CTL.STDIN, 1, new Uint8Array((1 << 20) + 16))],
    ['a 3-byte frame', new Uint8Array([11, 0, 0])],
    ['a FILES chunk for no FILES', frame(CTL.FILES_CHUNK, 5, new Uint8Array(10))],
    ['an ENV_CALL naming no operation', frame(CTL.ENV_CALL, 5, json({ op: 'unlinkAll', args: [], input: 0 }))],
    ['an ENV_CALL announcing more input than a call may carry', frame(CTL.ENV_CALL, 5, json({ op: 'writeFile', args: ['/x', {}], input: 1 << 30 }))],
    ['ENV_DATA for no ENV_CALL', frame(CTL.ENV_DATA, 5, new Uint8Array(10))],
  ] as const) {
    it(`${what} on /ctl is relay loss: the session tree is killed, the relay stays up`, async () => {
      const sb = track(await localMachine());
      const { pid } = await spawnPid(sb.machine, 'sleep 30');
      (sb.link as unknown as { ctl: RelaySocket }).ctl.send(bad);
      await sleep(500);
      expect(aliveProcess(pid)).toBe(false);
      expect(sb.link.isLost()).toBe(true);
      // The relay itself survived: the same fence is admitted again.
      expect((await sb.arm({ fence: { count: 1, fenced: true } })).reply.ok).toBe(true);
    });
  }
});

describe('the machine builder (fence gate, env check, loss)', () => {
  it('without a fenced token: no spawn, no FILES, no WIPE', async () => {
    const sb = track(await localMachine());
    for (const fence of [undefined, { count: 1, fenced: false }]) {
      const m = sb.machineFor(sb.link, fence);
      await expect(m.spawn({ command: 'true' })).rejects.toThrow(/fenced token/);
      await expect(m.files.upload('config', [])).rejects.toThrow(/fenced token/);
      await expect(m.files.wipe()).rejects.toThrow(/fenced token/);
    }
  });

  it('refuses a spawn env with a credential-like name, a credential-shaped value, or a value of the Function’s own env, naming the key only', async () => {
    const sb = track(await localMachine());
    process.env.DH_TEST_HOST_SECRET = 'a-host-value-of-some-length';
    try {
      for (const [env, key] of [
        [{ GITHUB_TOKEN: 'value-of-a-token' }, 'GITHUB_TOKEN'],
        [{ NOTE: 'sk-abcdefghijklmnopqrstuvwxyz' }, 'NOTE'],
        [{ COPY: 'a-host-value-of-some-length' }, 'COPY'],
        [{ LD_PRELOAD: '/workspace/x.so' }, 'LD_PRELOAD'],
        [{ BASH_ENV: '/workspace/x' }, 'BASH_ENV'],
      ] as const) {
        const err = await sb.machine.spawn({ command: 'true', env: env as Record<string, string> }).catch((e: Error) => e);
        expect(err).toBeInstanceOf(TypeError);
        expect((err as Error).message).toContain(key);
        for (const v of Object.values(env)) expect((err as Error).message).not.toContain(v);
      }
      const ok = await sb.machine.workspace.exec('echo $GIT_AUTHOR_NAME', { env: { GIT_AUTHOR_NAME: 'someone' } });
      expect(ok.stdout).toBe('someone\n');
    } finally {
      delete process.env.DH_TEST_HOST_SECRET;
    }
  });

  it('loss aborts the machine signal and marks the workspace lost; the fence is frozen', async () => {
    const sb = track(await localMachine());
    expect(sb.machine.signal.aborted).toBe(false);
    expect(sb.machine.workspace.lost).toBe(false);
    expect(Object.isFrozen(sb.machine.fence)).toBe(true);
    sb.link.close();
    expect(sb.machine.signal.aborted).toBe(true);
    expect(sb.machine.workspace.lost).toBe(true);
    await expect(sb.machine.spawn({ command: 'true' })).rejects.toThrow(/lost/);
  });
});

describe('auth and the hello proof', () => {
  it('refuses a wrong bearer token with 401', async () => {
    const relay = track(await startRelay());
    const token = mintToken();
    const reply = await requestArm(relay.config.stateDir, armRequest(tokenHash(token), SESSION, { count: 1, fenced: true }));
    expect(reply?.ok).toBe(true);
    expect(await upgradeStatus(relay.config.port, '/ctl', mintToken())).toBe(401);
    await expect(dialRelay({ ...urls(relay.config.port), token: mintToken(), nonce: (reply as { R: string }).R })).rejects.toThrow();
  });

  it('refuses an expired arm with 401', async () => {
    const relay = track(await startRelay({ armTtlMs: 200 }));
    const token = mintToken();
    await requestArm(relay.config.stateDir, armRequest(tokenHash(token), SESSION, { count: 1, fenced: true }));
    await sleep(400);
    expect(await upgradeStatus(relay.config.port, '/ctl', token)).toBe(401);
  });

  it('refuses a reused admission (a third socket of a kind) with 401', async () => {
    const relay = track(await startRelay());
    const token = mintToken();
    const reply = await requestArm(relay.config.stateDir, armRequest(tokenHash(token), SESSION, { count: 1, fenced: true }));
    const link = await dialRelay({ ...urls(relay.config.port), token, nonce: (reply as { R: string }).R });
    expect(await upgradeStatus(relay.config.port, '/ctl', token)).toBe(401);
    link.close();
  });

  it('refuses an upgrade that carries an Origin header, and any other path, with 404', async () => {
    const relay = track(await startRelay());
    const token = mintToken();
    await requestArm(relay.config.stateDir, armRequest(tokenHash(token), SESSION, { count: 1, fenced: true }));
    expect(await upgradeStatus(relay.config.port, '/ctl', token, { Origin: 'https://evil.example' })).toBe(404);
    expect(await upgradeStatus(relay.config.port, '/health', token)).toBe(404);
    expect((await fetch(`http://127.0.0.1:${relay.config.port}/`)).status).toBe(404);
  });

  it('refuses a relay whose hello proof does not match (wrong nonce)', async () => {
    const relay = track(await startRelay());
    const token = mintToken();
    const reply = await requestArm(relay.config.stateDir, armRequest(tokenHash(token), SESSION, { count: 1, fenced: true }));
    expect(reply?.ok).toBe(true);
    await expect(dialRelay({ ...urls(relay.config.port), token, nonce: 'not-the-real-nonce' })).rejects.toThrow(/hello proof/);
  });

  it('the control socket and state dir are owner-only', async () => {
    const relay = track(await startRelay());
    const { statSync } = await import('node:fs');
    expect(statSync(relay.config.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(relay.config.stateDir, 'control.sock')).mode & 0o077).toBe(0);
  });
});

describe('the fence (the VM-side half of the World’s)', () => {
  it('refuses a lower fence than it was armed with', async () => {
    const relay = track(await startRelay());
    await requestArm(relay.config.stateDir, armRequest(tokenHash(mintToken()), SESSION, { count: 5, fenced: true }));
    const low = await requestArm(relay.config.stateDir, armRequest(tokenHash(mintToken()), SESSION, { count: 4, fenced: true }));
    expect(low).toMatchObject({ ok: false, code: 'stale' });
  });

  it('a restarted relay still refuses a lower fence (the fence is persisted, 0600)', async () => {
    const sb = track(await localMachine());
    expect((await sb.arm({ fence: { count: 5, fenced: true } })).reply.ok).toBe(true);
    await sb.restart();
    const low = await sb.arm({ fence: { count: 4, fenced: true } });
    expect(low.reply).toMatchObject({ ok: false, code: 'stale' });
    const { statSync } = await import('node:fs');
    expect(statSync(join(sb.config.stateDir, 'fence.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses an arm for another session, and a malformed fence', async () => {
    const sb = track(await localMachine());
    expect((await sb.arm({ session: 'another' })).reply).toMatchObject({ ok: false, code: 'session' });
    const bad = await requestArm(sb.config.stateDir, { sha256: tokenHash(mintToken()), session: SESSION, fence: Number.POSITIVE_INFINITY, fenced: true });
    expect(bad).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('a higher fence preempts: the old CLI is killed and its sockets close with 4409', async () => {
    const sb = track(await localMachine());
    const { pid } = await spawnPid(sb.machine, 'sleep 30');
    const next = await sb.arm({ fence: { count: 2, fenced: true } });
    expect(next.reply.ok).toBe(true);
    await sleep(400);
    expect(aliveProcess(pid)).toBe(false);
    expect(sb.link.lossReason()?.reason).toMatch(/superseded/);
  });

  it('a frozen superseded owner: its late SPAWN is never run, and its late close never kills the new owner (35 s)', async () => {
    const relay = track(await startRelay());
    const t1 = mintToken();
    const a1 = await requestArm(relay.config.stateDir, armRequest(tokenHash(t1), SESSION, { count: 1, fenced: true }));
    // The old owner: two raw sockets that stop reading (a frozen Function).
    const frozen = await rawPair(relay.config.port, t1);
    frozen.freeze();
    const t2 = mintToken();
    const a2 = await requestArm(relay.config.stateDir, armRequest(tokenHash(t2), SESSION, { count: 2, fenced: true }));
    if (!a1?.ok || !a2?.ok) throw new Error('arm failed');
    // The frozen owner's frames, sent after it was superseded (its socket is still open on the relay for up to a second).
    const marker = join(relay.config.workspace, 'stale-spawn-ran');
    const keep = join(relay.config.cacheRoot, 'config', 'kept');
    writeFileSync(keep, 'x');
    frozen.ctl.send(frame(CTL.SPAWN, 1, json({ command: 'touch', args: [marker], env: {} })));
    frozen.ctl.send(frame(CTL.WIPE, 2, json({})));
    const link2 = await dialRelay({ ...urls(relay.config.port), token: t2, nonce: a2.R });
    const owner = await link2.spawn({ command: 'bash', args: ['-c', 'echo $$; sleep 60'] });
    const pid = Number((await owner.lines()[Symbol.asyncIterator]().next()).value);
    frozen.ctl.send(frame(CTL.SPAWN, 3, json({ command: 'touch', args: [marker], env: {} })));
    await sleep(35_000);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(aliveProcess(pid)).toBe(true);
    expect(link2.isLost()).toBe(false);
    link2.close();
    frozen.destroy();
  }, 60_000);

  it('refuses the same fence while the old attach still answers (contended)', async () => {
    const sb = track(await localMachine());
    const again = await sb.arm({ fence: { count: 1, fenced: true } });
    expect(again.reply).toMatchObject({ ok: false, code: 'contended' });
  });

  it('fenced: false, or no token, never preempts, even with a higher count', async () => {
    const sb = track(await localMachine());
    const { pid } = await spawnPid(sb.machine, 'sleep 30');
    expect((await sb.arm({ fence: { count: 9, fenced: false } })).reply).toMatchObject({ ok: false, code: 'contended' });
    expect((await sb.arm({ fence: null })).reply).toMatchObject({ ok: false, code: 'contended' });
    expect(aliveProcess(pid)).toBe(true);
    expect(sb.link.isLost()).toBe(false);
  });

  it('a pending, unconsumed arm is not overwritten by a non-preempting one; the owner still dials', async () => {
    const sb = track(await localMachine());
    sb.link.close();
    await sleep(300);
    const owner = await sb.arm({ fence: { count: 2, fenced: true } });
    expect(owner.reply.ok).toBe(true);
    expect((await sb.arm({ fence: { count: 2, fenced: true } })).reply).toMatchObject({ ok: false, code: 'contended' });
    expect((await sb.arm({ fence: null })).reply).toMatchObject({ ok: false, code: 'contended' });
    // The owner re-arming with its own token is fine (a retried upgrade).
    const retry = await sb.arm({ fence: { count: 2, fenced: true }, token: owner.token });
    if (!retry.reply.ok) throw new Error(JSON.stringify(retry.reply));
    const link = await sb.dial({ token: owner.token, nonce: retry.reply.R });
    link.close();
  });

  it('admits the same fence once the old sockets are dead, and kills the tree they left', async () => {
    const sb = track(await localMachine());
    sb.link.close();
    await sleep(300);
    const again = await sb.arm({ fence: { count: 1, fenced: true } });
    if (!again.reply.ok) throw new Error(JSON.stringify(again.reply));
    const link2 = await sb.dial({ token: again.token, nonce: again.reply.R });
    const proc = await link2.spawn({ command: 'bash', args: ['-c', 'echo back'] });
    expect(await collect(proc.lines())).toEqual(['back']);
    link2.close();
  });

  it('a dropped /model alone is relay loss: the tree is killed, and a same-fence re-arm is admitted', async () => {
    let model: RelaySocket | undefined;
    const sb = track(await localMachine());
    const again = async () => {
      await sleep(300);
      const r = await sb.arm({ fence: { count: 1, fenced: true } });
      if (!r.reply.ok) throw new Error(JSON.stringify(r.reply));
      return r;
    };
    // Re-dial with a socket hook to reach /model.
    sb.link.close();
    const first = await again();
    const link = await sb.dial({
      token: first.token,
      nonce: first.reply.ok ? first.reply.R : '',
      openSocket: (url, token) => {
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } }) as unknown as RelaySocket;
        if (url.endsWith('/model')) model = ws;
        return ws;
      },
    });
    const m = sb.machineFor(link, { count: 1, fenced: true });
    const { pid } = await spawnPid(m, 'sleep 30');
    model!.terminate!();
    await sleep(500);
    expect(aliveProcess(pid)).toBe(false);
    expect(link.isLost()).toBe(true);
    const second = await again();
    expect(second.reply.ok).toBe(true);
  });

  it('a driver-side loss (the link declares silence) terminates its sockets, so a same-fence re-arm is admitted at once', async () => {
    const sb = track(await localMachine());
    const { pid } = await spawnPid(sb.machine, 'sleep 30');
    (sb.link as unknown as { markLost(r: string): void }).markLost('silence');
    await sleep(400);
    expect(aliveProcess(pid)).toBe(false);
    expect((await sb.arm({ fence: { count: 1, fenced: true } })).reply.ok).toBe(true);
  });

  it('two arms racing on a cold relay start exactly one relay, and both get an answer from it', async () => {
    const relay = track(await startRelay());
    await relay.kill();
    const reqs = [mintToken(), mintToken()].map((t) => armRequest(tokenHash(t), SESSION, { count: 1, fenced: true }));
    const replies = await Promise.all(reqs.map((r) => runArm(relay.configPath, r, { entryPath: relay.bundle.path })));
    const ok = replies.filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    expect(replies.find((r) => !r.ok)).toMatchObject({ code: 'contended' });
    // One relay answers both later arms.
    const later = await requestArm(relay.config.stateDir, armRequest(tokenHash(mintToken()), SESSION, { count: 3, fenced: true }));
    expect(later?.ok && later.relayId).toBe((ok[0] as { relayId: string }).relayId);
    // Leave no detached relay behind. No shell: on Linux `pkill -f` would match the shell's own command line, which names the path, and kill it.
    const { spawnSync } = await import('node:child_process');
    spawnSync('pkill', ['-f', relay.configPath]);
  });
});

describe('the brand (docs/workspaces.md §6 rule 1)', () => {
  it('a stand-in machine is branded and frozen; a hand-written one is not branded', async () => {
    const sb = track(await localMachine());
    expect(isBrandedMachine(sb.machine)).toBe(true);
    expect(Object.isFrozen(sb.machine)).toBe(true);
    expect(isBrandedMachine({ sessionId: 's', spawn: async () => ({}) })).toBe(false);
    expect(isBrandedMachine({ ...sb.machine })).toBe(false);
  });

  it.todo('a hand-written SessionMachine is refused by Claude Code and Codex (A5, A6: the harness-level refusal)');

  for (const [what, env] of [
    ['without the test flag', { DH_TEST_LOCAL_SANDBOX: undefined }],
    ['with VERCEL set', { VERCEL: '1' }],
    ['in production', { NODE_ENV: 'production' }],
    ['outside a test runner', { VITEST: undefined, NODE_ENV: undefined }],
  ] as const) {
    it(`the stand-in and brandForTests refuse to run ${what}`, async () => {
      const saved: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        await expect(startRelay()).rejects.toThrow();
        expect(() => brandForTests({} as never)).toThrow();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  }
});

describe('not yet built here (each names the item that lands it)', () => {
  it.todo('WIPE stays on its filesystem (rm --one-file-system; privileged tier)');
});

describe.skipIf(!PRIV)('privileged tier (root: setpriv, cgroups)', () => {
  it('runs model commands as the unprivileged user, with no root env', async () => {
    const sb = track(await localMachine());
    const r = await sb.machine.workspace.exec('id -un; echo "$PATH"');
    expect(r.stdout.split('\n')[0]).toBe(sb.config.runAs);
  });

  it('a link loss cgroup-kills a setsid grandchild', async () => {
    const sb = track(await localMachine());
    const proc = await sb.machine.spawn({ command: 'bash', args: ['-c', 'setsid sleep 300 >/dev/null 2>&1 & echo $!; sleep 300'] });
    const grandchild = Number((await proc.lines()[Symbol.asyncIterator]().next()).value);
    sb.link.close();
    await sleep(800);
    expect(aliveProcess(grandchild)).toBe(false);
  });

  it('the agent owns its cache dirs after WIPE and after FILES', async () => {
    const sb = track(await localMachine());
    await sb.machine.files.wipe();
    await sb.machine.files.upload('home', [{ path: 'a.txt', bytes: new Uint8Array([1]) }]);
    const r = await sb.machine.workspace.exec(`touch ${sb.machine.dirs.home}/w ${sb.machine.dirs.tmp}/w && echo wrote`);
    expect(r.stdout).toBe('wrote\n');
  });

  it.todo('a symlink to /opt/dh does not let the agent write it (EACCES): the live suite');
});

// --- helpers ---------------------------------------------------------------

function urls(port: number): { ctlUrl: string; modelUrl: string } {
  return { ctlUrl: `ws://127.0.0.1:${port}/ctl`, modelUrl: `ws://127.0.0.1:${port}/model` };
}

function aliveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The HTTP status an upgrade gets (101 if it was accepted). */
function upgradeStatus(port: number, path: string, token: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('upgrade', () => {
      resolve(101);
      ws.terminate();
    });
    ws.on('error', () => resolve(-1));
  });
}

/** Two raw `ws` sockets on an armed relay, read until their hellos; `freeze` stops reading them (the peer never answers a close or a ping). */
async function rawPair(port: number, token: string) {
  const open = (path: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` }, autoPong: true });
      ws.once('message', () => resolve(ws));
      ws.on('error', reject);
    });
  const ctl = await open('/ctl');
  const model = await open('/model');
  const raw = (ws: WebSocket) => (ws as unknown as { _socket: import('node:net').Socket })._socket;
  return {
    ctl,
    model,
    freeze() {
      raw(ctl).pause();
      raw(model).pause();
    },
    destroy() {
      raw(ctl).destroy();
      raw(model).destroy();
    },
  };
}

function toStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}
