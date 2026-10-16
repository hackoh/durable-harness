import { armedChaos, type ChaosKind, type ChaosSpec } from 'harness-world';
import { waitUntil } from '@/lib/drive';
import { getSessions } from '@/lib/sessions';

/**
 * Arm a crash. The next matching step kills the process driving the session
 * partway through: on Vercel the function exits, the queue sees a failed
 * delivery and redrives it, and the session resumes from its log.
 *
 * `{ disarm: true }` withdraws the crash still armed, if any (the page does
 * when the turn it was armed for ended without the step it waited for):
 * `{ disarmed }` says whether there was one. `{ drill: true }`: the next
 * message goes to /api/drill, so arming wakes no drive now.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as Partial<ChaosSpec> & { disarm?: boolean; drill?: boolean };
  const sessions = await getSessions();
  if (body.disarm === true) {
    const armed = armedChaos(await sessions.inspect(id));
    if (!armed) return Response.json({ disarmed: false });
    return Response.json({ disarmed: (await sessions.withdraw(id, armed.id)) === 'withdrawn' });
  }
  const kinds: ChaosKind[] = ['process', 'sandbox-vm', 'sandbox-command', 'drop-callback', 'sandbox-new-vm', 'sandbox-zombie', 'relay-drop'];
  const kind = kinds.includes(body.kind as ChaosKind) ? (body.kind as ChaosKind) : 'process';
  const at = targetOf(kind, body.at);
  const afterMs = Math.min(600_000, Math.max(100, Number(body.afterMs ?? (at === 'sandbox' ? 4000 : 1500))));
  const spec: ChaosSpec = { at, afterMs, ...(kind !== 'process' ? { kind } : {}), ...(kind === 'process' && body.silent === true ? { silent: true } : {}) };
  // `drill`: the message that follows goes to /api/drill, whose drive fires
  // the crash. Arming must not wake another drive first: it would still be
  // up when the message lands, take the turn, and never fire a crash armed
  // before it began.
  const submissionId = await sessions.chaos(id, spec, body.drill === true ? { wake: 'backstop', waitUntil } : {});
  return Response.json({ submissionId });
}

/**
 * Where a kind fires (docs/workspaces.md §8 "Drills"): a hybrid session's
 * sandbox_exec for the parked kinds; a turn's start on the session's own
 * sandbox for D2 (`sandbox-new-vm`) and D3 (`sandbox-zombie`); for D1
 * (`sandbox-vm`) a tool call in the session's VM, or a sandbox_exec; for
 * D4 (`relay-drop`) and a Kill Function (D5) a tool call, a model stream or
 * either.
 */
function targetOf(kind: ChaosKind, at: ChaosSpec['at'] | undefined): ChaosSpec['at'] {
  if (kind === 'sandbox-command' || kind === 'drop-callback' || kind === 'sandbox-new-vm' || kind === 'sandbox-zombie') return 'sandbox';
  if (kind === 'sandbox-vm') return at === 'tool' ? 'tool' : 'sandbox';
  if (kind === 'relay-drop') return at === 'model' || at === 'any' ? at : 'tool';
  return at === 'model' || at === 'any' || at === 'sandbox' ? at : 'tool';
}
