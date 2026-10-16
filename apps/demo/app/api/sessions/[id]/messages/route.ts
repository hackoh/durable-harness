import { driveAfterResponse, driveMode, waitUntil } from '@/lib/drive';
import { getSessions } from '@/lib/sessions';

// With the drive route on, the turn runs in this invocation after the response.
export const maxDuration = 800;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { text, kind, drive } = (await request.json()) as { text: string; kind?: 'prompt' | 'steer' | 'followUp'; drive?: string };
  const mode = driveMode(drive);
  // The drive route answers as soon as the submission is durable; the
  // companion wake and flushes finish under `after()`, and
  // the drive starts from the log the submit just wrote.
  const submissionId = await (await getSessions()).send(id, text, kind, mode === 'http' ? { wake: 'backstop', waitUntil } : {});
  if (mode === 'http') driveAfterResponse(id, `submit:${kind ?? 'prompt'}`);
  return Response.json({ submissionId, drive: mode });
}
