import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocMarkdown, renderDocMarkdown } from '../components/profiles/doc-markdown';

const html = (markdown: string) => renderToStaticMarkup(createElement(DocMarkdown, { markdown }));

describe('DocMarkdown', () => {
  it('renders paragraphs separated by blank lines', () => {
    const out = html('First one.\n\nSecond one.');
    expect(out.match(/<p[ >]/g)).toHaveLength(2);
    expect(out).toContain('First one.');
    expect(out).toContain('Second one.');
  });

  it('renders flat bullet and numbered lists', () => {
    const ul = html('- a\n- b');
    expect(ul).toContain('<ul');
    expect(ul.match(/<li/g)).toHaveLength(2);
    const ol = html('1. one\n2. two\n3. three');
    expect(ol).toContain('<ol');
    expect(ol.match(/<li/g)).toHaveLength(3);
  });

  it('renders bold and italic', () => {
    const out = html('a **bold** and *italic* word');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
  });

  it('renders ### as a level 3 heading only', () => {
    expect(html('### Title')).toMatch(/<h3[^>]*>Title<\/h3>/);
    for (const src of ['# One', '## Two']) {
      const out = html(src);
      expect(out).not.toMatch(/<h[1-6]/);
      expect(out).toContain(src);
    }
  });

  it('shows raw HTML as literal text', () => {
    const out = html('<b>x</b> <script>alert(1)</script>');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('keeps links, images, tables, fences and quotes literal', () => {
    const out = html(
      '[x](http://e.com)\n\n![i](http://e.com/i.png)\n\n| a | b |\n|---|---|\n\n```\ncode\n```\n\n> quote',
    );
    expect(out).not.toMatch(/<(a|img|table|pre|code|blockquote)[ >]/);
    expect(out).toContain('[x](http://e.com)');
    expect(out).toContain('![i](http://e.com/i.png)');
    expect(out).toContain('| a | b |');
    expect(out).toContain('```');
    expect(out).toContain('&gt; quote');
  });

  it('returns an empty list for empty input', () => {
    expect(renderDocMarkdown('')).toEqual([]);
    expect(renderDocMarkdown('  \n\n ')).toEqual([]);
  });

  it('does not use dangerouslySetInnerHTML', () => {
    const src = readFileSync(
      new URL('../components/profiles/doc-markdown.tsx', import.meta.url),
      'utf8',
    );
    expect(src).not.toContain('dangerouslySetInnerHTML');
  });
});
