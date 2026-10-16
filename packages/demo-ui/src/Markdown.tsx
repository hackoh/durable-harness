import { memo, type ReactNode } from 'react';

/**
 * The small subset of Markdown models actually write: paragraphs, headings,
 * lists, quotes, code fences, tables, bold, italic, inline code and links.
 * No HTML passes through, and no image is ever loaded: an image in model
 * output (`![alt](https://...)`) is a placeholder, never an `<img>` or a
 * link, since its URL is the model's (or a tool result's) to choose and
 * fetching it would send whatever it carries to that host. It re-parses on
 * every streamed frame, so an unfinished fence simply renders as code until
 * it closes.
 */

const INLINE = /(`[^`\n]+`)|(\*\*(?=\S)[^\n]*?\S\*\*)|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)|!\[([^\]\n]*)\]\([^)\n]*\)|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** What an image in model output shows instead of loading it. */
export const imageNotShown = (alt: string) => `[image not shown${alt.trim() ? `: ${alt.trim()}` : ''}]`;

/**
 * Marks where the streaming caret goes. The caret is a fresh element on
 * every flush (keyed by the text's length): an inserted box is not a layout
 * shift, while a pseudo-element riding the end of the text is one per token.
 */
const CARET = '\u2063';
let caretKey = 0;
function caretize(nodes: ReactNode[]): ReactNode[] {
  return nodes.flatMap((n): ReactNode[] => {
    if (typeof n !== 'string' || !n.includes(CARET)) return [n];
    const [before, after] = n.split(CARET);
    return [before, <span key={`caret${caretKey}`} className="caret" aria-hidden="true" />, after].filter((x) => x !== '');
  });
}

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}.${n++}`;
    const t = m[0];
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{t.slice(1, -1)}</em>);
    else if (t.startsWith('!['))
      out.push(
        <span key={k} className="md-image" title="Images in model output are not loaded">
          {imageNotShown(m[4] ?? '')}
        </span>
      );
    else
      out.push(
        <a key={k} href={m[6]} target="_blank" rel="noreferrer">
          {m[5]}
        </a>
      );
    last = at + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return caretize(out);
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE = /^\s*\|.*\|[\s⁣]*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}[\s⁣]*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}/;

function cells(line: string): string[] {
  let l = line.trim();
  const caret = l.endsWith(CARET);
  if (caret) l = l.slice(0, -1).trim();
  const out = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  if (caret) out[out.length - 1] += CARET;
  return out;
}

function blocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const startsBlock = (l: string) =>
    FENCE.test(l) || HEADING.test(l) || QUOTE.test(l) || BULLET.test(l) || ORDERED.test(l) || TABLE.test(l) || RULE.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    const k = `b${i}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push(
        <pre key={k} className="md-code">
          {caretize([body.join('\n')])}
        </pre>
      );
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push(
        <p key={k} className="md-h">
          {inline(h[1]!)}
        </p>
      );
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(<hr key={k} />);
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push(<blockquote key={k}>{inline(body.join('\n'))}</blockquote>);
      continue;
    }
    if (TABLE.test(line)) {
      const rows: string[][] = [];
      let head = false;
      while (i < lines.length && TABLE.test(lines[i]!)) {
        const l = lines[i++]!;
        if (TABLE_SEP.test(l) && !/[^\s|:-]/.test(l)) head = rows.length === 1;
        else rows.push(cells(l));
      }
      const [first, ...rest] = rows;
      out.push(
        <div key={k} className="md-table">
          <table>
            {head && first && (
              <thead>
                <tr>
                  {first.map((c, j) => (
                    <th key={j}>{inline(c)}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {(head ? rest : rows).map((r, j) => (
                <tr key={j}>
                  {r.map((c, x) => (
                    <td key={x}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: ReactNode[] = [];
      const re = ordered ? ORDERED : BULLET;
      while (i < lines.length && re.test(lines[i]!)) {
        const m = re.exec(lines[i]!)!;
        const depth = Math.min(3, Math.floor(m[1]!.length / 2));
        const body = ordered ? m[3]! : m[2]!;
        items.push(
          <li key={i} style={depth ? { marginLeft: depth * 16 } : undefined} {...(ordered ? { value: Number(m[2]) } : {})}>
            {inline(body)}
          </li>
        );
        i++;
      }
      out.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!))) para.push(lines[i++]!);
    out.push(<p key={k}>{inline(para.join('\n'))}</p>);
  }
  return out;
}

export const Markdown = memo(function Markdown({ text, className, caret }: { text: string; className?: string; caret?: boolean }) {
  if (!caret) return <div className={`md ${className ?? ''}`}>{blocks(text)}</div>;
  caretKey = text.length;
  // The caret rides the last line of text (trailing newlines would put it on a line of its own).
  return <div className={`md ${className ?? ''}`}>{blocks(text.replace(/\s*$/, CARET))}</div>;
});
