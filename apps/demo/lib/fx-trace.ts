type JournalEvent = { eventType: string; eventData?: unknown };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** The engine starts a fresh turn before its optimistic journal writes land. */
export function fxPromptTraceIdentity(message: unknown): { sessionId: string; turnId: string; prompt?: string } | undefined {
  const frame = object(message);
  if (frame.method !== 'session/prompt') return;
  const params = object(frame.params);
  const turnId = object(object(params._meta).fx).turnId;
  if (typeof params.sessionId !== 'string' || typeof turnId !== 'string') return;
  const blocks = Array.isArray(params.prompt) ? params.prompt.map(object) : [];
  const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  return { sessionId: params.sessionId, turnId, ...(text ? { prompt: text } : {}) };
}

/** libfx's WASM transport supplies request bodies as bytes. Never capture headers. */
export function fxTraceRequestBody(body: unknown): unknown {
  let text: string;
  if (typeof body === 'string') text = body;
  else {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
      : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : undefined;
    if (!bytes || bytes.byteLength > 256_000) return;
    text = new TextDecoder().decode(bytes);
  }
  if (text.length > 256_000) return;
  try { return JSON.parse(text); } catch { return; }
}

/** Newest-first native libfx journal events: JSON bytes, not the kernel's devalue codec. */
export function fxTraceIdentity(events: readonly JournalEvent[], fallback: string): { turnId: string; prompt?: unknown } {
  let turnId = fallback;
  let foundTurn = false;
  for (const event of events) {
    const data = object(event.eventData);
    if (event.eventType !== 'step_created' || data.stepName !== 'fx.log') continue;
    try {
      const raw = data.input instanceof Uint8Array ? new TextDecoder().decode(data.input) : data.input;
      if (typeof raw !== 'string') continue;
      const entry = object(JSON.parse(raw));
      const marks = Array.isArray(entry.marks) ? entry.marks.map(object) : [];
      const start = marks.findLast(mark => typeof mark.start === 'string')?.start ?? object(entry.openTurn).id;
      if (typeof start === 'string' && !foundTurn) { turnId = start; foundTurn = true; }
      if (entry.k === 'input' && entry.type === 'prompt' && typeof entry.messageId === 'string') {
        if (foundTurn && entry.messageId !== turnId) continue;
        return { turnId: foundTurn ? turnId : entry.messageId, prompt: entry.input };
      }
    } catch { /* A malformed or unrelated event cannot change trace identity. */ }
  }
  return { turnId };
}
