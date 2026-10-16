import { steerNative } from 'harness-world-hands/native';

/**
 * Steer a running native turn. It lands only if this request reaches the
 * instance running the turn (Fluid usually routes it there); `landed: false`
 * tells the page to send it as the next turn instead.
 */
export async function POST(request: Request) {
  const { turnId, text } = (await request.json()) as { turnId: string; text: string };
  const landed = await steerNative(turnId, text).catch(() => false);
  return Response.json({ landed });
}
