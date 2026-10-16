/**
 * `RemoteProcess` (docs/workspaces.md §5.4, §11.4 A2): a `LineChannel` and
 * `ProcessLike` over the relay's `/ctl` frames, so a process harness drives a
 * child in the VM through the same shape it uses for a child on this machine
 * (`HostedProcess`). The stdio is `STDIN`/`STDOUT`/`STDERR` frames; `kill` is a
 * `KILL` frame that always takes the whole session (the cgroup in the VM, every
 * child's process group in the degraded tier), as `SessionProcess` says. The
 * transport is the relay link (`relay/dial.ts`); this file only turns one
 * spawn's frames into a channel.
 *
 * The link registers a `RemoteProcess` before it sends the `SPAWN`, so a
 * `STDOUT` or `EXIT` that arrives in the same read as the `SPAWN_ACK` is never
 * dropped; `started` attaches the pid once the ack arrives.
 */
import type { ChannelExit, KillSignal, ProcessLike } from 'harness-world-process';

/** What a `RemoteProcess` asks of its link: send on this spawn's stream, or kill the session. */
export interface RemoteProcessHost {
  /** Send stdin bytes (split into frames by the link); false once the link is gone. Throws a `RangeError` past the line limit. */
  sendStdin(id: number, bytes: Uint8Array): boolean;
  endStdin(id: number): void;
  /** `KILL`: always the whole session. */
  killSession(signal: KillSignal): void;
}

/**
 * A child's stdout as it arrives: raw chunks, read either as lines
 * (`lines()`) or as the raw bytes (`chunks()`), by one reader.
 */
class StdoutQueue {
  private queue: Uint8Array[] = [];
  private waiting: ((r: IteratorResult<Uint8Array>) => void) | undefined;
  private ended = false;

  push(bytes: Uint8Array): void {
    if (this.ended) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: bytes, done: false });
    } else this.queue.push(bytes);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  chunks(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Uint8Array>>((resolve) => {
            if (this.queue.length) return resolve({ value: this.queue.shift()!, done: false });
            if (this.ended) return resolve({ value: undefined, done: true });
            this.waiting = resolve;
          }),
      }),
    };
  }

  /** Complete lines (a last line without a newline is emitted at the end). */
  async *lines(): AsyncIterable<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of this.chunks()) {
      buffer += decoder.decode(bytes, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.length) yield buffer;
  }
}

/** A child in the VM, as a `ProcessLike`. Created by the relay link before its `SPAWN` is sent. */
export class RemoteProcess implements ProcessLike {
  private readonly stdout = new StdoutQueue();
  private stderrChunks: Uint8Array[] = [];
  private stderrLen = 0;
  private running = true;
  private exit: ChannelExit | undefined;
  private readerTaken = false;
  private childPid: number | undefined;
  readonly exited: Promise<ChannelExit>;
  private settleExit!: (exit: ChannelExit) => void;

  constructor(
    private readonly id: number,
    private readonly host: RemoteProcessHost
  ) {
    this.exited = new Promise((resolve) => (this.settleExit = resolve));
  }

  /** The child's pid in the VM (undefined until the relay acked the spawn). Informational only: it names a process in the VM, never one here. */
  get pid(): number | undefined {
    return this.childPid;
  }

  /** The relay acked the spawn with the child's pid. */
  started(pid: number): void {
    this.childPid = pid;
  }

  /** Feed a `STDOUT` frame. */
  onStdout(bytes: Uint8Array): void {
    this.stdout.push(bytes);
  }

  /** Feed a `STDERR` frame, keeping the last 8 KB as the tail. */
  onStderr(bytes: Uint8Array): void {
    this.stderrChunks.push(bytes);
    this.stderrLen += bytes.length;
    while (this.stderrLen > 8192 && this.stderrChunks.length > 1) this.stderrLen -= this.stderrChunks.shift()!.length;
  }

  /** Feed the `EXIT` frame. */
  onExit(exit: ChannelExit, stderrTail?: string): void {
    if (!this.running) return;
    this.running = false;
    this.exit = exit;
    if (stderrTail) {
      this.stderrChunks = [new TextEncoder().encode(stderrTail)];
      this.stderrLen = this.stderrChunks[0]!.length;
    }
    this.stdout.end();
    this.settleExit(exit);
  }

  /** The link was lost while the child was running: end it as a kill (the relay kills the session on a loss). */
  onLost(): void {
    if (!this.running) return;
    this.running = false;
    this.exit = { code: null, signal: 'SIGKILL' };
    this.stdout.end();
    this.settleExit(this.exit);
  }

  send(line: unknown): boolean {
    if (!this.running) return false;
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    return this.host.sendStdin(this.id, new TextEncoder().encode(`${text}\n`));
  }

  end(): void {
    if (this.running) this.host.endStdin(this.id);
  }

  lines(): AsyncIterable<string> {
    this.takeReader();
    return this.stdout.lines();
  }

  /** The raw stdout bytes, as they arrive (instead of `lines()`: one reader per process). */
  chunks(): AsyncIterable<Uint8Array> {
    this.takeReader();
    return this.stdout.chunks();
  }

  stderrTail(): string {
    return new TextDecoder().decode(concat(this.stderrChunks)).slice(-8192);
  }

  alive(): boolean {
    return this.running;
  }

  /** Kill the session's processes (this child and everything the session started), as `SessionProcess.kill` says. Default `SIGTERM`. */
  kill(signal: KillSignal = 'SIGTERM'): void {
    if (this.running) this.host.killSession(signal);
  }

  private takeReader(): void {
    if (this.readerTaken) throw new Error('harness-sandbox: a RemoteProcess has one stdout reader (lines() or chunks())');
    this.readerTaken = true;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
