/**
 * Pi variant A: Pi 1.0's own durable Harness (`@earendil-works/pi-durable`)
 * with a World-backed Storage (`pi-world`). Pi owns durability; every Pi
 * commit is one event in the session's run.
 *
 * Pi's Harness runs where it is opened, and on this World the place a
 * session runs is its run object. So nothing opens it in the fetch handler:
 *
 * - a message is a queue message to the session (`pi-submit`), which the run
 *   object delivers here, in its own isolate: open the Harness, submit (by
 *   request id, so a redelivery finds the same submission), wait until idle,
 *   close;
 * - a steer cannot wait behind that delivery (the run object runs one at a
 *   time), so it goes through `world.invoke`, which the run object delivers
 *   alongside the running one: it lands on the Harness that delivery holds;
 * - after a crash the run object redelivers the `pi-submit` (its own
 *   message: the journal's commits carry it, so it resumes at once), and a
 *   `pi-wake` (a continuation, or a steer's hand-off) runs pi-world's
 *   `runWake`, which on this World proves any other message's holder gone:
 *   the run object runs one flow delivery at a time.
 *
 * Nothing beats and nothing waits on silence.
 */
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from '@earendil-works/chord/context';
import type { World } from '@workflow/world';
import { type Anchor, exclusiveAnchors, type QueueRoute } from 'harness-world';
import { runWake, WAKE_QUEUE, wake, worldStorage } from 'pi-world';
import { type PiDurableAgent, piDurableAgent } from 'pi-world/agent';
import { JournalReader } from 'pi-world/reader';
import { gatewayKey, INSTRUCTIONS, MODEL } from './model.ts';

export const PI_DURABLE = 'pi-durable';

/** One flow delivery per run at a time: another message's anchor names a delivery that is not running. */
const anchors = exclusiveAnchors();

type Harness = Awaited<ReturnType<PiDurableAgent['openAgent']>>;
type Root = Awaited<ReturnType<PiDurableAgent['root']>>;
interface Held {
  harness: Harness;
  root: Root;
  refs: number;
}

interface PiSubmit {
  kind: 'pi-submit' | 'pi-steer';
  text: string;
  requestId: string;
}

export function piDurable(world: World) {
  const agent = piDurableAgent({ world, modelId: MODEL, apiKey: async () => gatewayKey(), instructions: INSTRUCTIONS, name: PI_DURABLE });
  /** The Harness this isolate holds per session: Pi allows one owner, a second open fences the first. */
  const open = new Map<string, Promise<Held>>();

  /** Hold the session's Harness; `anchor`: what the commits made while this lease is the newest are written under. */
  async function acquire(id: string, anchor?: Anchor): Promise<Held & { unset?: () => void; opened: boolean }> {
    let p = open.get(id);
    let opened = false;
    if (!p) {
      opened = true;
      p = (async () => {
        const harness = await agent.openAgent(id, anchor);
        return { harness, root: await agent.root(harness, ctx), refs: 0 };
      })();
      open.set(id, p);
      p.catch(() => open.delete(id));
    }
    const held = await p;
    held.refs++;
    const storage = agent.storageOf(id);
    const unset = !opened && anchor && storage ? storage.setAnchor(anchor) : undefined;
    return Object.assign(held, { opened, ...(unset ? { unset } : {}) });
  }

  async function release(id: string, held: Held, unset?: () => void) {
    unset?.();
    if (--held.refs > 0) return;
    open.delete(id);
    // A storage closing with work live writes its close entry: the next wake takes it at once.
    await held.harness.close(ctx).catch(() => {});
  }

  async function submit(id: string, input: PiSubmit, meta: { attempt: number; messageId: string } | undefined, invoked: boolean) {
    // A queue message's lease is its own; an invoke (a steer alongside the
    // running delivery) is no message, and writes under whoever holds the Harness.
    const anchor = invoked ? undefined : anchors.own(meta ?? {});
    const held = await acquire(id, anchor);
    let continueAfter = false;
    try {
      // A redelivery after a crash: let Pi pick up the interrupted work.
      if ((meta?.attempt ?? 1) > 1) held.harness.resume();
      const submission = await held.root.submit(
        { type: 'input', content: input.text, requestId: input.requestId, whenBusy: input.kind === 'pi-steer' ? 'steer' : 'followUp' },
        ctx
      );
      if (input.kind === 'pi-submit') {
        await held.harness.waitForIdle(withAbortSignal(AbortSignal.timeout(10 * 60_000), ctx));
        continueAfter = (await held.harness.inspect(ctx)).tasks.some((t) => t.state.kind !== 'blocked');
      } else {
        // A steer that found nobody driving opened the Harness itself and
        // closes it at once: a flow delivery must drive what it started.
        continueAfter = held.opened;
      }
      // Not 'accepted': that would have the run object queue a plain wake,
      // which is the kernel's to take, not Pi's.
      return { status: 'submitted', submissionId: String(submission.id) };
    } finally {
      await release(id, held, held.unset);
      // I4: whoever lets go with work left hands it on (a pi-wake, a flow delivery of its own).
      if (continueAfter) await wake(world, id, { idempotencyKey: `${id}:pi-cont:${input.requestId}:${meta?.messageId ?? 'invoke'}` }).catch(() => {});
    }
  }

  const route: QueueRoute = (message, meta) => {
    const { runId, input, invoke } = message as { runId?: string; invoke?: boolean; input?: { kind?: string; text?: string; requestId?: string; continues?: string } };
    if (!runId || !input) return undefined;
    if (input.kind === 'pi-wake') {
      // Through `acquire`, so a steer of this isolate shares the wake's Harness instead of fencing it.
      const shared = async (id: string, anchor?: Anchor) => {
        const held = await acquire(id, anchor);
        return new Proxy(held.harness, {
          get(target, key) {
            if (key === 'close') return () => release(id, held, held.unset);
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
      return runWake(world, runId, shared, {
        anchors,
        anchor: anchors.own(meta),
        ...(typeof input.continues === 'string' ? { continues: input.continues } : {}),
        held: open.has(runId),
      }).then(() => undefined);
    }
    if (input.kind === 'pi-submit' || (invoke && input.kind === 'pi-steer')) return submit(runId, input as PiSubmit, invoke ? undefined : meta, !!invoke);
    return undefined;
  };

  return {
    route,
    create: () => worldStorage.create(world, { name: PI_DURABLE }),
    /** Queue the message for the session's run object; a steer goes in alongside the running delivery. */
    async send(id: string, text: string, kind: string) {
      const requestId = `req_${crypto.randomUUID()}`;
      if (kind === 'steer') {
        await world.invoke?.(id, { kind: 'pi-steer', text, requestId }, { idempotencyKey: requestId });
      } else {
        await world.queue(WAKE_QUEUE, { runId: id, input: { kind: 'pi-submit', text, requestId } } as never, { idempotencyKey: requestId });
      }
      return requestId;
    },
    /** The journal, read without opening the session (never fences the owner). */
    async read(id: string) {
      const reader = new JournalReader(world, id);
      await reader.refresh();
      return reader.snapshot();
    },
  };
}
