/**
 * Resume a live subscription that replays from its start after a reconnect.
 *
 * The replay is not guaranteed to be the prefix this subscription already
 * delivered: a connection served by the process that wrote the events can
 * carry events that never became durable (the process was killed right
 * after), and events from two writers can land in either order. So neither
 * a count nor a stream index is a safe resume point. Instead, each replayed
 * event is matched against what was delivered (by value, as a multiset): a
 * match is skipped, anything else is new. Only an event identical to one
 * delivered earlier and not replayed can be skipped wrongly, which a
 * measurement tolerates better than a lost `chaos` or `drive.start`.
 */
export class ReplayDedupe {
  private delivered = new Map<string, number>();
  private pending = new Map<string, number>();

  /** A new connection opened: everything delivered so far may come again. */
  reconnect(): void {
    this.pending = new Map(this.delivered);
  }

  /** Whether `raw` (an event's serialized form) is new; records it if so. */
  accept(raw: string): boolean {
    const left = this.pending.get(raw) ?? 0;
    if (left > 0) {
      if (left === 1) this.pending.delete(raw);
      else this.pending.set(raw, left - 1);
      return false;
    }
    this.delivered.set(raw, (this.delivered.get(raw) ?? 0) + 1);
    return true;
  }
}
