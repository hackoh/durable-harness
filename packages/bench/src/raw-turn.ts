import { isMark, markTime, PROCESS_ID, type RawSessions, type RawSnapshot } from 'harness-world';
import type { ScriptStep } from './http.ts';

/**
 * One busy period of a raw (durability off) session in a stateless process:
 * what `POST /api/bench/raw` does, shared with the tests. Continues the
 * session from `snapshot` (or starts one), submits `text`, runs `script`
 * submissions from inside the process when their trigger fires, and writes
 * every live event, then the new snapshot, through `write`.
 */
export interface RawTurnRequest {
  harness: string;
  snapshot?: RawSnapshot;
  text: string;
  kind?: 'prompt' | 'steer' | 'followUp';
  script?: ScriptStep[];
}

export async function rawTurn(raw: RawSessions, body: RawTurnRequest, write: (line: unknown) => void, meta: Record<string, unknown> = {}): Promise<void> {
  write({ type: 'hello', t: markTime(), pid: PROCESS_ID, ...meta });
  try {
    const id = body.snapshot ? raw.restore(body.snapshot) : (await raw.start({ harness: body.harness })).sessionId;
    const steps = [...(body.script ?? [])];
    let timers = 0;
    let settle: (() => void) | undefined;
    const fire = (step: ScriptStep) => {
      timers++;
      setTimeout(() => {
        void raw.send(id, step.text, step.kind ?? 'prompt').finally(() => {
          timers--;
          settle?.();
        });
      }, step.afterMs ?? 0);
    };
    const trigger = (on: ScriptStep['on']) => {
      const i = steps.findIndex((s) => s.on === on);
      if (i >= 0) fire(steps.splice(i, 1)[0]!);
    };
    let sawText = false;
    const off = raw.subscribe(id, (event) => {
      write(event);
      const e = event as { type?: string; name?: string };
      if (isMark(event) && e.name === 'model.first_token') trigger('first_token');
      if (e.type === 'text' && !sawText) {
        sawText = true;
        trigger('text');
      }
      if (e.type === 'tool_start') trigger('tool_start');
    });
    try {
      await raw.send(id, body.text, body.kind ?? 'prompt');
      for (;;) {
        await raw.idle(id);
        if (timers > 0) {
          await new Promise<void>((r) => {
            settle = r;
          });
          settle = undefined;
          continue;
        }
        if (steps.some((s) => s.on === 'idle')) {
          trigger('idle');
          continue;
        }
        break;
      }
    } finally {
      off();
    }
    write({ type: 'snapshot', snapshot: raw.snapshot(id) });
    raw.close(id);
  } catch (err) {
    write({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
  write({ type: 'end', t: markTime() });
}
