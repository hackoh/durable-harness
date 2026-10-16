import { isMark, type Mark, markTime, PROCESS_ID } from 'harness-world';

/** What a client may say about a message it sent. */
export interface SendReceipt {
  /**
   * How long the session refused the message as not ready yet (eve's
   * `409 session_not_ready` while a prewarmed session's inbox starts), until
   * the attempt it accepted. That is the session starting, which the other
   * lanes pay inside `start()`: a turn's clock starts after it.
   */
  notReadyMs?: number;
}

/** What the benchmark needs from a place a session can run (a `DemoClient` fits). */
export interface BenchClient {
  /** Without a prompt the session starts idle. */
  start(harness: string, prompt?: string): Promise<string>;
  send(id: string, text: string, kind: 'prompt' | 'steer'): Promise<void | SendReceipt>;
  /** Live events; `onReady` fires once the subscription is attached (default: at once). */
  live(id: string, onEvent: (event: any) => void, onReady?: () => void): () => void;
  /** Whether `live` calls `onReady`. Otherwise the recorder waits 300ms and assumes it is attached. */
  signalsReady?: boolean;
  /**
   * Run one turn and make more submissions from inside the process that
   * drives it (a stateless raw Function cannot be reached mid-turn). The
   * steer scenario uses it when present.
   */
  runScripted?(id: string, text: string, script: { on: 'first_token' | 'text' | 'tool_start' | 'idle'; afterMs?: number; text: string; kind?: 'prompt' | 'steer' | 'followUp' }[]): Promise<void>;
  chaos?(id: string, spec: { at: 'tool' | 'model' | 'any' | 'sandbox'; kind?: string; afterMs?: number; silent?: boolean }): Promise<void>;
  /**
   * Hybrid: resolve once the session has a live sandbox host (its `host`
   * fact), false if none attached within `timeoutMs`. The sandbox lane
   * exists only while one does; before that a machine tool runs remotely
   * from a function.
   */
  hostReady?(id: string, timeoutMs: number): Promise<boolean>;
}

export interface Seen {
  event: any;
  /** Arrival time in this process's clock (`markTime`). */
  at: number;
  index: number;
}

/** When something happened, in this process's clock: a mark's own `t` if this process wrote it, else its arrival. */
export function timeOf(seen: Seen): number {
  const e = seen.event;
  return isMark(e) && e.pid === PROCESS_ID ? e.t : seen.at;
}

export const isMarkNamed = (name: string) => (e: any): e is Mark => isMark(e) && e.name === name;

/** Every live event of one session, with arrival times, and waits on them. */
export class Recorder {
  readonly seen: Seen[] = [];
  readonly ready: Promise<void>;
  private waiters = new Set<() => void>();
  private stop: () => void;
  private failed?: string;

  constructor(client: BenchClient, readonly id: string) {
    let markReady!: () => void;
    this.ready = new Promise<void>((r) => {
      markReady = r;
    });
    let readied = false;
    const onReady = () => {
      if (readied) return;
      readied = true;
      markReady();
    };
    this.stop = client.live(
      id,
      (event) => {
        const seen = { event, at: markTime(), index: this.seen.length };
        this.seen.push(seen);
        if (event?.type === 'failed') this.failed = String(event.message ?? 'the session failed');
        for (const w of [...this.waiters]) w();
      },
      onReady
    );
    // Clients that cannot say when they are attached: give them a moment.
    if (!client.signalsReady) setTimeout(onReady, 300);
  }

  /** Index of the next event: `from` for waits that must see only what happens next. */
  get cursor(): number {
    return this.seen.length;
  }

  find(pred: (e: any) => boolean, from = 0): Seen | undefined {
    for (let i = from; i < this.seen.length; i++) if (pred(this.seen[i]!.event)) return this.seen[i];
    return undefined;
  }

  all(pred: (e: any) => boolean, from = 0): Seen[] {
    return this.seen.slice(from).filter((s) => pred(s.event));
  }

  /** The first event at or after `from` matching `pred`. */
  waitFor(pred: (e: any) => boolean, options: { from?: number; timeoutMs?: number; what?: string } = {}): Promise<Seen> {
    const from = options.from ?? 0;
    const timeoutMs = options.timeoutMs ?? 90_000;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        const hit = this.find(pred, from);
        if (hit) {
          done();
          resolve(hit);
          return;
        }
        if (this.failed) {
          done();
          reject(new Error(`session failed: ${this.failed}`));
        }
      };
      const done = () => {
        this.waiters.delete(check);
        clearTimeout(timer);
      };
      timer = setTimeout(() => {
        done();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${options.what ?? 'an event'}`));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  close(): void {
    this.stop();
    this.waiters.clear();
  }
}
