import { describe, expect, it } from 'vitest';
import { fmtDelta, fmtSeconds, LatencyTracker } from './latency.ts';

describe('LatencyTracker', () => {
  it('times a turn from send to first text and to idle, and learns its submission id', () => {
    const t = new LatencyTracker();
    // History replayed on subscribe, before anything was sent here: ignored.
    t.event({ type: 'text', delta: 'old' }, 50);
    t.event({ type: 'idle' }, 60);
    t.sent('prompt', 1000);
    t.event({ type: 'mark', name: 'submit', id: 'evnt_4', kind: 'prompt', pid: 'p1', t: 1 }, 1100);
    t.event({ type: 'mark', name: 'ack', lagMs: 40, pid: 'p1', t: 2 }, 1150);
    t.event({ type: 'mark', name: 'model.request', pid: 'p2', t: 10_000 }, 1200);
    t.event({ type: 'mark', name: 'model.first_token', pid: 'p2', t: 10_750 }, 1900);
    t.event({ type: 'text', delta: 'hi' }, 1950);
    t.event({ type: 'text', delta: ' there' }, 2000);
    t.event({ type: 'idle' }, 3000);
    t.event({ type: 'mark', name: 'idle', pid: 'p2', t: 12_000 }, 3100);
    expect(t.turns).toEqual([
      {
        sentAt: 1000,
        kind: 'prompt',
        subId: 'evnt_4',
        output: true,
        firstTokenAt: 1950,
        ttft: 950,
        firstOutputAt: 1950,
        firstOutput: 950,
        idleAt: 3000,
        turn: 2000,
        durableAt: 2100,
        durableEndAt: 3100,
        modelTtft: 750,
      },
    ]);
    expect(t.durable).toEqual({ acks: 1, recent: [40], ahead: [] });
  });

  it('starts a turn at the attempt the session accepted, not while it was still starting', () => {
    const t = new LatencyTracker();
    t.sent('prompt', 1000);
    // eve refused the prompt for 300 ms (a prewarmed session's inbox starting), then accepted it.
    t.startedLate(t.turns[0]!, 300);
    t.event({ type: 'mark', name: 'model.request', pid: 'eve', t: 5000 }, 1500);
    t.event({ type: 'text', delta: 'hi' }, 2300);
    t.event({ type: 'idle' }, 2600);
    t.event({ type: 'mark', name: 'idle', pid: 'eve', t: 5900 }, 2600);
    expect(t.turns[0]).toMatchObject({ sentAt: 1300, notReadyMs: 300, ttft: 1000, turn: 1300 });
    // Late receipts (after the output) move what was already measured.
    const late = new LatencyTracker();
    late.sent('prompt', 0);
    late.event({ type: 'text' }, 900);
    late.event({ type: 'mark', name: 'idle' }, 1500);
    late.startedLate(late.turns[0]!, 200);
    expect(late.turns[0]).toMatchObject({ sentAt: 200, ttft: 700, turn: 1300, notReadyMs: 200 });
  });

  it("counts a turn's first output from the first text or tool start, whichever came first", () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'tool_start', name: 'bash' }, 400);
    t.event({ type: 'text', delta: 'done' }, 900);
    expect(t.turns[0]).toMatchObject({ firstOutput: 400, ttft: 900 });
  });

  it('keeps a run-ahead write\'s durability lag apart from its ack round trip', () => {
    const t = new LatencyTracker();
    t.event({ type: 'mark', name: 'ack', lagMs: 30, aheadMs: 95, pid: 'p1', t: 2 }, 10);
    expect(t.durable).toEqual({ acks: 1, recent: [30], ahead: [95] });
  });

  it('prefers the kernel idle mark: a replayed turn ending is not this turn ending', () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'mark', name: 'idle' }, 50); // the previous turn's tail, landing late
    t.event({ type: 'mark', name: 'drive.start' }, 100);
    t.event({ type: 'idle' }, 120); // Pi finishing the replay of the previous turn
    t.event({ type: 'text' }, 900);
    t.event({ type: 'mark', name: 'idle' }, 1500);
    expect(t.turns[0]).toMatchObject({ ttft: 900, turn: 1500 });
  });

  it('keeps turns apart and does not time a steer as a turn', () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'text' }, 500);
    t.sent('steer', 600);
    t.event({ type: 'mark', name: 'submit', id: 'a', kind: 'prompt' }, 610);
    t.event({ type: 'mark', name: 'submit', id: 'b', kind: 'steer' }, 700);
    t.event({ type: 'mark', name: 'idle' }, 900);
    t.sent('prompt', 1000);
    t.event({ type: 'text' }, 1300);
    t.event({ type: 'mark', name: 'idle' }, 1500);
    expect(t.turns.map((x) => [x.kind, x.subId, x.ttft, x.turn])).toEqual([
      ['prompt', 'a', 500, 900],
      ['steer', 'b', undefined, undefined],
      ['prompt', undefined, 300, 500],
    ]);
  });

  it("ends a turn only on the idle of the drive that placed its submission, at the harness's own idle", () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'mark', name: 'submit', id: 'sub_1', kind: 'prompt' }, 50);
    t.event({ type: 'mark', name: 'intent', drv: 'drv_A', key: 'model:0', placed: ['sub_1'] }, 100);
    t.event({ type: 'tool_start', name: 'bash' }, 900);
    // A trailing drive of the previous turn (a companion) going idle mid-turn.
    t.event({ type: 'mark', name: 'drive.start', drv: 'drv_B' }, 950);
    t.event({ type: 'idle' }, 960);
    t.event({ type: 'mark', name: 'idle', drv: 'drv_B' }, 1000);
    expect(t.turns[0]!.idleAt).toBeUndefined();
    t.event({ type: 'tool_end', name: 'bash' }, 1100);
    t.event({ type: 'text', delta: 'done' }, 2500);
    t.event({ type: 'idle' }, 2600);
    t.event({ type: 'mark', name: 'idle', drv: 'drv_A' }, 3000);
    expect(t.turns[0]).toMatchObject({ ttft: 2500, turn: 2600, durableAt: 3000, drvs: ['drv_A'] });
  });

  it('a run-ahead intent that arrives before its submission\'s mark still names the drive that ends the turn', () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'mark', name: 'intent', drv: 'drv_A', placed: ['sub_1'] }, 30);
    t.event({ type: 'mark', name: 'submit', id: 'sub_1', kind: 'prompt', ahead: true }, 60);
    t.event({ type: 'text', delta: 'hi' }, 900);
    t.event({ type: 'mark', name: 'idle', drv: 'drv_A' }, 1000);
    expect(t.turns[0]).toMatchObject({ turn: 1000, drvs: ['drv_A'] });
  });

  it("ends a turn on its output when its drive's idle overtook it (a slow chunk landed late)", () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'mark', name: 'submit', id: 'sub_1', kind: 'prompt' }, 20);
    t.event({ type: 'mark', name: 'intent', drv: 'drv_A', placed: ['sub_1'] }, 30);
    t.event({ type: 'mark', name: 'idle', drv: 'drv_A' }, 1000);
    expect(t.turns[0]!.idleAt).toBeUndefined();
    t.event({ type: 'text', delta: 'late' }, 1400);
    expect(t.turns[0]).toMatchObject({ ttft: 1400, turn: 1400, durableAt: 1400 });
  });

  it('gives up a turn that never ended instead of holding every later turn open', () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'mark', name: 'submit', id: 'sub_1', kind: 'prompt' }, 20);
    t.event({ type: 'mark', name: 'intent', drv: 'drv_A', placed: ['sub_1'] }, 30);
    // Its output and end never arrive. The next prompt, two minutes on:
    t.sent('prompt', 120_000);
    expect(t.turns[0]!.lost).toBe(true);
    t.event({ type: 'mark', name: 'submit', id: 'sub_2', kind: 'prompt' }, 120_020);
    t.event({ type: 'mark', name: 'intent', drv: 'drv_B', placed: ['sub_2'] }, 120_030);
    t.event({ type: 'text', delta: 'hi' }, 120_900);
    t.event({ type: 'mark', name: 'idle', drv: 'drv_B' }, 121_000);
    expect(t.turns[1]).toMatchObject({ ttft: 900, turn: 1000 });
  });

  it("a later turn's own idle gives up an earlier one still open", () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'mark', name: 'submit', id: 'sub_1', kind: 'prompt' }, 20);
    t.event({ type: 'mark', name: 'intent', drv: 'drv_A', placed: ['sub_1'] }, 30);
    t.event({ type: 'text', delta: 'a' }, 500);
    t.sent('prompt', 5_000);
    t.event({ type: 'mark', name: 'submit', id: 'sub_2', kind: 'prompt' }, 5_020);
    t.event({ type: 'mark', name: 'intent', drv: 'drv_B', placed: ['sub_2'] }, 5_030);
    t.event({ type: 'mark', name: 'idle', drv: 'drv_B' }, 6_000);
    expect(t.turns[0]!.lost).toBe(true);
    expect(t.turns[1]!.idleSeenAt).toBe(6_000);
    t.event({ type: 'text', delta: 'b' }, 6_100);
    expect(t.turns[1]).toMatchObject({ ttft: 1_100, turn: 1_100 });
  });

  it('a lane with model marks but no kernel (Native) ends the turn on the harness idle', () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'mark', name: 'model.request', pid: 'n', t: 10 }, 100);
    t.event({ type: 'mark', name: 'model.first_token', pid: 'n', t: 810 }, 900);
    t.event({ type: 'text', delta: 'hi' }, 905);
    t.event({ type: 'mark', name: 'model.done', pid: 'n', t: 900 }, 990);
    t.event({ type: 'idle' }, 1000);
    expect(t.turns[0]).toMatchObject({ ttft: 905, turn: 1000, modelTtft: 800 });
  });

  it('a drive that took the turn over and finished it ends it; one that ran nothing still does not', () => {
    const t = new LatencyTracker();
    t.sent('prompt', 0);
    t.event({ type: 'mark', name: 'submit', id: 'sub_1', kind: 'prompt' }, 20);
    t.event({ type: 'mark', name: 'intent', drv: 'drv_A', placed: ['sub_1'] }, 30);
    t.event({ type: 'text', delta: 'h' }, 900);
    t.event({ type: 'mark', name: 'rewind', drv: 'drv_A' }, 950);
    t.event({ type: 'mark', name: 'idle', drv: 'drv_C' }, 960); // an empty companion
    expect(t.turns[0]!.idleAt).toBeUndefined();
    t.event({ type: 'mark', name: 'intent', drv: 'drv_B', key: 'model:1' }, 1000);
    t.event({ type: 'text', delta: 'hi' }, 1500);
    t.event({ type: 'mark', name: 'idle', drv: 'drv_B' }, 1600);
    expect(t.turns[0]).toMatchObject({ turn: 1600, workers: ['drv_A', 'drv_B'] });
  });

  it('formats', () => {
    expect(fmtSeconds(980)).toBe('980 ms');
    expect(fmtSeconds(1040)).toBe('1.04 s');
    expect(fmtSeconds(12_340)).toBe('12.3 s');
    expect(fmtDelta(60)).toBe('+60 ms');
    expect(fmtDelta(-1200)).toBe('−1.20 s');
  });
});
