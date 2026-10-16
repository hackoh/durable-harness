/**
 * The driver's link (`src/relay/dial.ts`) against a hostile or broken relay,
 * over fake sockets (no network): every byte from the VM is untrusted, and the
 * link runs in a shared Function process, so nothing a relay sends may throw
 * out of a listener, hang a caller, or get a model call answered before the
 * hello proofs check (docs/workspaces.md §5.4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, WS_FRAME } from 'harness-world-remote/ws';
import { RelayLink, dialRelay, type RelaySocket } from '../src/relay/dial.ts';
import { CTL, frame, helloProof, json, mintNonce, mintToken, pack, parse } from '../src/relay/protocol.ts';
import { RemoteMachine } from '../src/env.ts';

type L = (e: any) => void;

/** A socket the test plays the relay through. `deliver` hands it a frame from the relay. */
class FakeSocket implements RelaySocket {
  readyState = 1;
  binaryType = 'arraybuffer';
  sent: Uint8Array[] = [];
  pings = 0;
  terminated = false;
  closedWith: number | undefined;
  /** Answer each ping with a pong (a live relay). */
  pongs = true;
  private listeners: Record<string, L[]> = {};
  private wsListeners: Record<string, (() => void)[]> = {};
  addEventListener(type: string, fn: L) {
    (this.listeners[type] ??= []).push(fn);
  }
  on(event: 'ping' | 'pong', fn: () => void) {
    (this.wsListeners[event] ??= []).push(fn);
  }
  send(data: Uint8Array | string) {
    if (this.readyState !== 1) throw new Error('not open');
    if (typeof data !== 'string') this.sent.push(data.slice());
  }
  ping() {
    this.pings++;
    if (this.pongs) for (const fn of this.wsListeners.pong ?? []) fn();
  }
  close(code?: number) {
    this.closedWith = code;
    this.end(code ?? 1005);
  }
  terminate() {
    this.terminated = true;
    this.end(1006);
  }
  end(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const fn of this.listeners.close ?? []) fn({ code });
  }
  /** A frame from the relay, synchronously (as `ws` dispatches a burst in one read). */
  deliver(bytes: Uint8Array | string) {
    const data = typeof bytes === 'string' ? bytes : bytes.slice().buffer;
    for (const fn of this.listeners.message ?? []) fn({ data });
  }
  sentOf(type: number) {
    return this.sent.filter((f) => f[0] === type);
  }
}

function fakeLink(options: { model?: Parameters<typeof dialRelay>[0]['model']; readyTimeoutMs?: number } = {}) {
  const token = mintToken();
  const nonce = mintNonce();
  const ctl = new FakeSocket();
  const model = new FakeSocket();
  const losses: { reason: string; protocol: boolean }[] = [];
  const link = new RelayLink({
    ctlUrl: 'ws://relay/ctl',
    modelUrl: 'ws://relay/model',
    token,
    nonce,
    model: options.model,
    readyTimeoutMs: options.readyTimeoutMs ?? 1_000,
    onLost: (reason, protocol) => losses.push({ reason, protocol }),
    openSocket: (url) => (url.endsWith('/ctl') ? ctl : model),
  });
  const hello = () => frame(CTL.HELLO, 0, json({ hmac: helloProof(token, nonce) }));
  return { link, ctl, model, losses, hello, ready: async () => (ctl.deliver(hello()), model.deliver(hello()), link.ready()) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the driver link against a hostile relay', () => {
  for (const [what, bytes] of [
    ['a 2-byte frame', new Uint8Array([10, 0])],
    ['an unknown frame type', frame(99, 1)],
    ['a spawn ack for no spawn', frame(CTL.SPAWN_ACK, 7, json({ pid: 1 }))],
    ['a result that is not JSON', frame(CTL.RESULT, 1, new TextEncoder().encode('{nope'))],
    ['a text frame', 'hello'],
    ['an oversized frame', frame(CTL.STDOUT, 1, new Uint8Array((1 << 20) + 1))],
    ['a tail frame with a short header', frame(CTL.TAIL_DATA, 1, new Uint8Array([0, 0]))],
  ] as const) {
    it(`${what}: no throw out of the listener, the link is lost as a protocol violation`, async () => {
      const t = fakeLink();
      await t.ready();
      expect(() => t.ctl.deliver(bytes as Uint8Array)).not.toThrow();
      expect(t.link.isLost()).toBe(true);
      expect(t.losses[0]?.protocol).toBe(true);
      expect(t.ctl.terminated && t.model.terminated).toBe(true);
    });
  }

  it('a malformed exit (a non-numeric code, an unknown signal shape) is a violation', async () => {
    const t = fakeLink();
    await t.ready();
    const proc = t.link.spawn({ command: 'x' });
    t.ctl.deliver(frame(CTL.SPAWN_ACK, 1, json({ pid: 5 })));
    await proc;
    t.ctl.deliver(frame(CTL.EXIT, 1, json({ code: 'zero', signal: 'kill everything' })));
    expect(t.link.lossReason()?.protocol).toBe(true);
  });

  it('a spawn ack, stdout and exit in one burst are all delivered (the process is registered before SPAWN is sent)', async () => {
    const t = fakeLink();
    await t.ready();
    const pending = t.link.spawn({ command: 'echo' });
    // The relay's three frames, dispatched synchronously before the spawn's continuation runs.
    t.ctl.deliver(frame(CTL.SPAWN_ACK, 1, json({ pid: 42 })));
    t.ctl.deliver(frame(CTL.STDOUT, 1, new TextEncoder().encode('one\ntwo')));
    t.ctl.deliver(frame(CTL.EXIT, 1, json({ code: 0, signal: null })));
    const proc = await pending;
    const lines: string[] = [];
    for await (const l of proc.lines()) lines.push(l);
    expect(lines).toEqual(['one', 'two']);
    expect(await proc.exited).toEqual({ code: 0, signal: null });
    expect(proc.pid).toBe(42);
  });

  it('an impostor that sends a model REQUEST instead of a hello gets nothing served, and the dial rejects', async () => {
    let served = 0;
    const t = fakeLink({
      model: async () => {
        served++;
        return { status: 200, headers: {}, body: (async function* () {})() };
      },
    });
    const dial = t.link.ready();
    t.model.deliver(encodeFrame(WS_FRAME.REQUEST, 1, JSON.stringify({ method: 'POST', path: '/v1/messages', headers: {}, hasBody: false })));
    t.ctl.deliver(t.hello());
    await expect(dial).rejects.toThrow(/hello/);
    await new Promise((r) => setTimeout(r, 20));
    expect(served).toBe(0);
    expect(t.ctl.terminated && t.model.terminated).toBe(true);
  });

  it('a model REQUEST after the /model hello but before the /ctl hello is not served', async () => {
    let served = 0;
    const t = fakeLink({
      model: async () => {
        served++;
        return { status: 200, headers: {}, body: (async function* () {})() };
      },
    });
    const dial = t.link.ready();
    t.model.deliver(t.hello());
    t.model.deliver(encodeFrame(WS_FRAME.REQUEST, 1, JSON.stringify({ method: 'POST', path: '/v1/messages', headers: {}, hasBody: false })));
    t.ctl.deliver(t.hello());
    await expect(dial).rejects.toThrow();
    expect(served).toBe(0);
  });

  it('a wrong hello proof rejects the dial and closes both sockets', async () => {
    const t = fakeLink();
    const dial = t.link.ready();
    t.ctl.deliver(frame(CTL.HELLO, 0, json({ hmac: '0'.repeat(64) })));
    await expect(dial).rejects.toThrow(/hello proof/);
    expect(t.ctl.terminated && t.model.terminated).toBe(true);
  });

  it('a relay that never says hello: ready() rejects at its deadline, and the sockets are closed', async () => {
    const t = fakeLink({ readyTimeoutMs: 100 });
    await expect(t.link.ready()).rejects.toThrow(/timed out/);
    expect(t.ctl.terminated && t.model.terminated).toBe(true);
  });

  it('/model closing before its hello rejects the dial (no hang)', async () => {
    const t = fakeLink();
    const dial = t.link.ready();
    t.ctl.deliver(t.hello());
    t.model.end(1006);
    await expect(dial).rejects.toThrow(/model/);
  });

  it('spawn and requests reject at once once the link is lost, and a loss mid-spawn rejects the spawn', async () => {
    const t = fakeLink();
    await t.ready();
    const mid = t.link.spawn({ command: 'sleep' });
    t.ctl.end(1006);
    await expect(mid).rejects.toThrow(/lost/);
    await expect(t.link.spawn({ command: 'x' })).rejects.toThrow(/lost/);
    await expect(t.link.wipe()).rejects.toThrow(/lost/);
    expect(() => t.link.tail('codex-home', 'rollout.jsonl').read()).toThrow(/lost/);
  });

  it('a superseded close (4409) is a loss that names it', async () => {
    const t = fakeLink();
    await t.ready();
    t.ctl.end(4409);
    expect(t.link.lossReason()?.reason).toMatch(/superseded/);
  });

  it('an idle link stays up while pongs answer its pings; a silent one is lost at 15 s', async () => {
    vi.useFakeTimers();
    const live = fakeLink();
    await live.ready();
    const silent = fakeLink();
    await silent.ready();
    silent.ctl.pongs = false;
    silent.model.pongs = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live.link.isLost()).toBe(false);
    expect(live.ctl.pings).toBeGreaterThanOrEqual(10);
    expect(silent.link.lossReason()?.reason).toBe('silence');
  });

  it('a relay ping counts as liveness too', async () => {
    vi.useFakeTimers();
    const t = fakeLink();
    await t.ready();
    t.ctl.pongs = false;
    t.model.pongs = false;
    const relayPings = setInterval(() => {
      for (const s of [t.ctl, t.model]) for (const fn of (s as unknown as { wsListeners: Record<string, (() => void)[]> }).wsListeners.ping ?? []) fn();
    }, 5_000);
    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(relayPings);
    expect(t.link.isLost()).toBe(false);
  });

  it('a big stdin line and a big FILES tar go out in frames under the limit', async () => {
    const t = fakeLink();
    await t.ready();
    const pending = t.link.spawn({ command: 'cat' });
    t.ctl.deliver(frame(CTL.SPAWN_ACK, 1, json({ pid: 1 })));
    const proc = await pending;
    expect(proc.send('x'.repeat(3 << 20))).toBe(true);
    void t.link.files('config', new Uint8Array(5 << 20));
    expect(Math.max(...t.ctl.sent.map((f) => f.length))).toBeLessThanOrEqual((512 << 10) + 5);
    expect(t.ctl.sentOf(CTL.STDIN).reduce((n, f) => n + f.length - 5, 0)).toBe((3 << 20) + 1);
    expect(t.ctl.sentOf(CTL.FILES_CHUNK).reduce((n, f) => n + f.length - 5, 0)).toBe(5 << 20);
    expect(() => proc.send('y'.repeat((16 << 20) + 1))).toThrow(RangeError);
  });

  it('a tail: lines split across frames, the offset tracks consumed lines, an error makes read() throw', async () => {
    const t = fakeLink();
    await t.ready();
    const tail = t.link.tail('codex-home', 'rollout.jsonl', { offset: 10 });
    const id = new DataView(t.ctl.sentOf(CTL.TAIL)[0]!.buffer).getUint32(1);
    const enc = new TextEncoder();
    t.ctl.deliver(frame(CTL.TAIL_DATA, id, pack({ offset: 15 }, enc.encode('ab\ncd'))));
    t.ctl.deliver(frame(CTL.TAIL_DATA, id, pack({ offset: 18 }, enc.encode('e\nf'))));
    expect(tail.read()).toEqual(['ab', 'cde']);
    expect(tail.offset).toBe(10 + 3 + 4);
    t.ctl.deliver(frame(CTL.TAIL_ERROR, id, json({ error: 'the tailed file shrank' })));
    expect(() => tail.read()).toThrow(/shrank/);
    await expect(tail.sync()).rejects.toThrow(/shrank/);
  });

  it('a tail frame whose offset skips bytes is a violation', async () => {
    const t = fakeLink();
    await t.ready();
    t.link.tail('codex-home', 'r.jsonl');
    const id = new DataView(t.ctl.sentOf(CTL.TAIL)[0]!.buffer).getUint32(1);
    t.ctl.deliver(frame(CTL.TAIL_DATA, id, pack({ offset: 100 }, new TextEncoder().encode('x\n'))));
    expect(t.link.lossReason()?.protocol).toBe(true);
  });

  it('a /model frame that breaks the protocol after the hellos drops the link', async () => {
    const t = fakeLink();
    await t.ready();
    t.model.deliver(new Uint8Array([1, 2]));
    expect(t.link.lossReason()).toMatchObject({ protocol: true });
  });
});

describe('ENV_CALL against a hostile relay (the workspace, docs/workspaces.md §5.4)', () => {
  /** The id of the last `ENV_CALL` the link sent, and its header. */
  const lastCall = (t: ReturnType<typeof fakeLink>) => {
    const f = t.ctl.sentOf(CTL.ENV_CALL).at(-1)!;
    return { id: new DataView(f.buffer, f.byteOffset).getUint32(1), header: parse(f.subarray(5)) as { op: string; args: unknown[]; input: number } };
  };
  const machineOf = (t: ReturnType<typeof fakeLink>) => new RemoteMachine({ link: t.link, root: '/workspace', fence: { count: 1, fenced: true }, flush: 'manual' });

  it("sends a call's input in ENV_DATA frames under the chunk size, and assembles a streamed result", async () => {
    const t = fakeLink();
    await t.ready();
    const big = new Uint8Array(1_300_000).fill(7);
    const done = t.link.envCall('writeFile', ['/workspace/a', {}], { input: big });
    const { id, header } = lastCall(t);
    expect(header).toEqual({ op: 'writeFile', args: ['/workspace/a', {}], input: big.length });
    const chunks = t.ctl.sentOf(CTL.ENV_DATA);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length - 5 <= 512 << 10)).toBe(true);
    t.ctl.deliver(frame(CTL.ENV_RESULT, id, json({ ok: true })));
    await expect(done).resolves.toEqual({ value: undefined });
    const read = t.link.envCall('readFile', ['/workspace/a']);
    const r = lastCall(t).id;
    t.ctl.deliver(frame(CTL.ENV_STREAM, r, new Uint8Array([1, 2])));
    t.ctl.deliver(frame(CTL.ENV_STREAM, r, new Uint8Array([3])));
    t.ctl.deliver(frame(CTL.ENV_RESULT, r, json({ ok: true, data: 'bytes' })));
    expect(Array.from((await read).data!)).toEqual([1, 2, 3]);
  });

  for (const [what, bad] of [
    ['an ENV_STREAM for a call never made', (_id: number) => frame(CTL.ENV_STREAM, 999, new Uint8Array(1))],
    ['an ENV_RESULT for a call never made', (_id: number) => frame(CTL.ENV_RESULT, 999, json({ ok: true }))],
    ['an ENV_RESULT that is not JSON', (id: number) => frame(CTL.ENV_RESULT, id, new TextEncoder().encode('{'))],
    ['an ENV_RESULT error with a code outside the fixed shape', (id: number) => frame(CTL.ENV_RESULT, id, json({ ok: false, error: { code: 'not-a-code', message: 'x' } }))],
    ['an ENV_RESULT with an unknown data kind', (id: number) => frame(CTL.ENV_RESULT, id, json({ ok: true, data: 'pickle' }))],
  ] as const) {
    it(`${what}: the link is lost as a protocol violation, and the call rejects`, async () => {
      const t = fakeLink();
      await t.ready();
      const call = t.link.envCall('stat', ['/workspace/x']);
      const { id } = lastCall(t);
      expect(() => t.ctl.deliver(bad(id))).not.toThrow();
      expect(t.link.lossReason()?.protocol).toBe(true);
      await expect(call).rejects.toThrow(/lost/);
    });
  }

  it('a result over its limit is a violation', async () => {
    const t = fakeLink();
    await t.ready();
    const call = t.link.envCall('readFile', ['/workspace/x'], { maxBytes: 4 });
    const { id } = lastCall(t);
    t.ctl.deliver(frame(CTL.ENV_STREAM, id, new Uint8Array(5)));
    expect(t.link.lossReason()?.protocol).toBe(true);
    await expect(call).rejects.toThrow(/lost/);
  });

  it('cancelling a read sends CANCEL and rejects at once; its late result is dropped, not a violation', async () => {
    const t = fakeLink();
    await t.ready();
    const controller = new AbortController();
    const call = t.link.envCall('readFile', ['/workspace/a'], { signal: controller.signal });
    const { id } = lastCall(t);
    controller.abort(new Error('stop'));
    await expect(call).rejects.toThrow('stop');
    expect(t.ctl.sentOf(CTL.CANCEL).map((f) => new DataView(f.buffer, f.byteOffset).getUint32(1))).toEqual([id]);
    t.ctl.deliver(frame(CTL.ENV_STREAM, id, new Uint8Array(1)));
    t.ctl.deliver(frame(CTL.ENV_RESULT, id, json({ ok: true, data: 'bytes' })));
    expect(t.link.isLost()).toBe(false);
  });

  it('a cancelled mutating call settles only once the relay answers it (the command is dead), with the reason it was given up for', async () => {
    const t = fakeLink();
    await t.ready();
    const controller = new AbortController();
    let settled = false;
    const call = t.link.envCall('exec', ['sleep 9', { cwd: '/workspace' }], { signal: controller.signal }).finally(() => (settled = true));
    const { id } = lastCall(t);
    controller.abort(new Error('stop'));
    await new Promise((r) => setTimeout(r, 50));
    expect(t.ctl.sentOf(CTL.CANCEL).map((f) => new DataView(f.buffer, f.byteOffset).getUint32(1))).toEqual([id]);
    expect(settled).toBe(false);
    // Bytes the helper sent before the CANCEL are dropped; its answer settles the call.
    t.ctl.deliver(frame(CTL.ENV_STREAM, id, new Uint8Array(1)));
    t.ctl.deliver(frame(CTL.ENV_RESULT, id, json({ ok: false, error: { code: 'EINTR', message: 'the command was stopped: its call was cancelled' } })));
    await expect(call).rejects.toThrow('stop');
    expect(t.link.isLost()).toBe(false);
  });

  it('a cancelled mutating call the relay never answers drops the link (not as a violation)', async () => {
    const t = fakeLink();
    await t.ready();
    const controller = new AbortController();
    const call = t.link.envCall('writeFile', ['/workspace/a', {}], { signal: controller.signal, input: new Uint8Array(1) });
    controller.abort(new Error('stop'));
    await expect(call).rejects.toThrow('stop');
    expect(t.link.lossReason()).toMatchObject({ protocol: false, reason: expect.stringMatching(/not confirmed stopped/) });
  }, 10_000);

  for (const [op, call, reply] of [
    ['stat', (m: RemoteMachine) => m.stat('/workspace/x'), { ok: true, value: { type: 'socket', size: 1, mode: 0o644, mtimeMs: 0 } }],
    ['stat', (m: RemoteMachine) => m.stat('/workspace/x'), { ok: true, value: { type: 'file', size: -1, mode: 0o644, mtimeMs: 0 } }],
    ['list', (m: RemoteMachine) => m.list('/workspace'), { ok: true, value: [{ name: '../escape', type: 'file' }] }],
    ['walk', (m: RemoteMachine) => m.walk('/workspace/sub'), { ok: true, value: [{ path: '/etc/passwd', type: 'file', size: 1, mode: 0o644, mtimeMs: 0 }] }],
    ['walk', (m: RemoteMachine) => m.walk('/workspace'), { ok: true, value: [{ path: '/workspace/a/../../etc', type: 'file', size: 1, mode: 0o644, mtimeMs: 0 }] }],
    ['realpath', (m: RemoteMachine) => m.realpath('/workspace/x'), { ok: true, value: 'relative/path' }],
    ['exec', (m: RemoteMachine) => m.exec('true'), { ok: true, value: { exitCode: 0, stdoutBytes: 5, stderrBytes: 0 }, data: 'bytes' }],
  ] as const) {
    it(`a ${op} result that doesn't fit its operation fails EPROTO and drops the link as a violation`, async () => {
      const t = fakeLink();
      await t.ready();
      const pending = (call as (m: RemoteMachine) => Promise<unknown>)(machineOf(t)).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 0));
      t.ctl.deliver(frame(CTL.ENV_RESULT, lastCall(t).id, json(reply)));
      expect(await pending).toMatchObject({ code: 'EPROTO' });
      expect(t.link.lossReason()?.protocol).toBe(true);
    });
  }
});
