'use client';

import { useEffect, useRef, useState } from 'react';

type Line = { role: 'user' | 'agent' | 'note'; text: string };

/**
 * A chat on one durable session. The session id, and the last cursor of a
 * turn still running, are kept in localStorage: reload mid-turn and the page
 * follows the same turn from where it stopped.
 */
export default function Page() {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const session = useRef<string | undefined>(undefined);
  const reattached = useRef(false);

  const note = (text: string) => setLines((l) => [...l.slice(0, -1), { role: 'note', text }, l.at(-1)!]);

  async function follow(response: Response) {
    setBusy(true);
    setLines((l) => [...l, { role: 'agent', text: '' }]);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    read: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const event = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (event.sessionId) {
          session.current = event.sessionId;
          localStorage.setItem('session', event.sessionId);
        }
        if (typeof event.cursor === 'number') localStorage.setItem('cursor', String(event.cursor));
        if (event.type === 'text_delta') setLines((l) => [...l.slice(0, -1), { role: 'agent', text: l.at(-1)!.text + event.delta }]);
        else if (event.type === 'tool_start') note(`running ${event.name}`);
        else if (event.type === 'turn_resume') note('continued after an interruption');
        else if (event.type === 'turn_end') {
          localStorage.removeItem('cursor');
          if (event.stopReason === 'error') note(`error: ${event.error?.message ?? 'the turn failed'}`);
          await reader.cancel().catch(() => {});
          break read;
        }
      }
    }
    setBusy(false);
  }

  useEffect(() => {
    // Once: React runs effects twice in development.
    if (reattached.current) return;
    reattached.current = true;
    session.current = localStorage.getItem('session') ?? undefined;
    const cursor = localStorage.getItem('cursor');
    if (session.current && cursor) {
      setLines([{ role: 'note', text: 'Following the turn that was running when the page closed.' }]);
      fetch(`/api/chat?sessionId=${session.current}&cursor=${cursor}`).then(follow);
    }
  }, []);

  async function send() {
    if (!text.trim() || busy) return;
    setLines((l) => [...l, { role: 'user', text }]);
    setText('');
    const query = session.current ? `?sessionId=${session.current}` : '';
    await follow(await fetch(`/api/chat${query}`, { method: 'POST', body: text }));
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>Durable fx agent</h1>
      <p style={{ color: '#a1a1a1', marginTop: 0 }}>
        libfx keeps the session in Vercel&apos;s World and runs each turn in a queue-delivered Function. Reload mid-turn,
        or let the Function crash: the turn continues from its last record.
        {session.current ? ` Session ${session.current}.` : ''}
      </p>
      {lines.map((line, i) => (
        <div key={i} style={{ margin: '10px 0', whiteSpace: 'pre-wrap', color: line.role === 'note' ? '#a1a1a1' : undefined }}>
          <strong>{line.role === 'user' ? 'You' : line.role === 'agent' ? 'fx' : '·'}</strong> {line.text}
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        style={{ display: 'flex', gap: 8, marginTop: 16 }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask fx something"
          style={{ flex: 1, padding: 10, background: '#111', color: 'inherit', border: '1px solid #333', borderRadius: 6 }}
        />
        <button type="submit" disabled={busy} style={{ padding: '10px 16px', borderRadius: 6 }}>
          {busy ? 'Running…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.clear();
            session.current = undefined;
            setLines([]);
          }}
          style={{ padding: '10px 16px', borderRadius: 6 }}
        >
          New Session
        </button>
      </form>
    </main>
  );
}
