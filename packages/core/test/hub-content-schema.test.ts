import { describe, expect, it } from 'vitest';
// Static import on purpose: the hub content schema module is RED until T032 lands.
import {
  noteTextSegments,
  noteToMarkdown,
  noteToPlainText,
  rebuildNoteDoc,
  validateNoteDoc,
  type HubNoteDoc,
} from '../src/hub/content-schema';

const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

const full = doc(
  { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
  para(
    text('plain '),
    text('b', [{ type: 'bold' }]),
    text('i', [{ type: 'italic' }]),
    text('u', [{ type: 'underline' }]),
    text('s', [{ type: 'strike' }]),
    text('c', [{ type: 'code' }]),
    text('site', [{ type: 'link', attrs: { href: 'https://example.com/a' } }]),
    { type: 'hardBreak' },
    text('mail', [{ type: 'link', attrs: { href: 'mailto:a@example.com' } }]),
  ),
  { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('one'))] }] },
  { type: 'orderedList', content: [{ type: 'listItem', content: [para(text('first'))] }] },
  {
    type: 'taskList',
    content: [
      { type: 'taskItem', attrs: { checked: false }, content: [para(text('todo'))] },
      { type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] },
    ],
  },
  { type: 'horizontalRule' },
  { type: 'blockquote', content: [para(text('quoted'))] },
  { type: 'codeBlock', content: [text('const a = 1;')] },
);

describe('validateNoteDoc accepts', () => {
  it('every allowed node and mark', () => {
    expect(validateNoteDoc(full).ok).toBe(true);
  });

  it.each([1, 2, 3])('heading level %i', (level) => {
    expect(validateNoteDoc(doc({ type: 'heading', attrs: { level }, content: [text('h')] })).ok).toBe(true);
  });

  it('a minimal empty paragraph', () => {
    expect(validateNoteDoc(doc({ type: 'paragraph' })).ok).toBe(true);
  });
});

describe('validateNoteDoc rejects', () => {
  it('non-objects and a wrong root', () => {
    expect(validateNoteDoc(null).ok).toBe(false);
    expect(validateNoteDoc('x').ok).toBe(false);
    expect(validateNoteDoc({ type: 'paragraph' }).ok).toBe(false);
  });

  it('unknown nodes', () => {
    expect(validateNoteDoc(doc({ type: 'image', attrs: { src: 'https://example.com/a.png' } })).ok).toBe(false);
    expect(validateNoteDoc(doc({ type: 'table', content: [] })).ok).toBe(false);
  });

  it('unknown marks', () => {
    expect(validateNoteDoc(doc(para(text('x', [{ type: 'highlight' }])))).ok).toBe(false);
  });

  it('heading level 4', () => {
    expect(validateNoteDoc(doc({ type: 'heading', attrs: { level: 4 }, content: [text('h')] })).ok).toBe(false);
  });

  it('script content', () => {
    expect(validateNoteDoc(doc({ type: 'script', content: [text('alert(1)')] })).ok).toBe(false);
    expect(validateNoteDoc(doc(para({ type: 'script' }))).ok).toBe(false);
  });

  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'ftp://example.com', '//example.com', 'example.com'])(
    'link href %s',
    (href) => {
      expect(validateNoteDoc(doc(para(text('x', [{ type: 'link', attrs: { href } }])))).ok).toBe(false);
    },
  );

  it('a link without href', () => {
    expect(validateNoteDoc(doc(para(text('x', [{ type: 'link', attrs: {} }])))).ok).toBe(false);
  });

  it('more than 1 MB serialised', () => {
    const big = doc(...Array.from({ length: 60 }, () => para(text('a'.repeat(20_000)))));
    expect(JSON.stringify(big).length).toBeGreaterThan(1_048_576);
    expect(validateNoteDoc(big).ok).toBe(false);
  });

  it('more than 100,000 text chars (but under 1 MB)', () => {
    const many = doc(...Array.from({ length: 11 }, () => para(text('a'.repeat(10_000)))));
    expect(JSON.stringify(many).length).toBeLessThan(1_048_576);
    expect(validateNoteDoc(many).ok).toBe(false);
  });

  it('exactly 100,000 text chars is accepted', () => {
    const edge = doc(...Array.from({ length: 10 }, () => para(text('a'.repeat(10_000)))));
    expect(validateNoteDoc(edge).ok).toBe(true);
  });

  it('structurally invalid nesting (listItem at the root)', () => {
    expect(validateNoteDoc(doc({ type: 'listItem', content: [para(text('x'))] })).ok).toBe(false);
  });
});

describe('noteTextSegments / rebuildNoteDoc', () => {
  it('lists text nodes and hrefs in order', () => {
    const segs = noteTextSegments(full as HubNoteDoc);
    const kinds = segs.map((s) => `${s.kind}:${s.value}`);
    expect(kinds.slice(0, 2)).toEqual(['text:Title', 'text:plain ']);
    expect(kinds).toContain('href:https://example.com/a');
    expect(kinds).toContain('href:mailto:a@example.com');
    // the href of a link comes right after its text
    expect(kinds.indexOf('href:https://example.com/a')).toBe(kinds.indexOf('text:site') + 1);
    expect(kinds.at(-1)).toBe('text:const a = 1;');
  });

  it('round-trips unchanged segments', () => {
    const segs = noteTextSegments(full as HubNoteDoc).map((s) => s.value);
    expect(rebuildNoteDoc(full as HubNoteDoc, segs)).toEqual(full);
  });

  it('puts filtered segments back without mutating the input', () => {
    const before = JSON.stringify(full);
    const segs = noteTextSegments(full as HubNoteDoc).map((s) => (s.value === 'plain ' ? '[redacted] ' : s.value));
    const out = rebuildNoteDoc(full as HubNoteDoc, segs);
    expect(JSON.stringify(full)).toBe(before);
    expect(noteToPlainText(out)).toContain('[redacted] ');
    expect(noteToPlainText(out)).not.toContain('plain ');
  });

  it('throws when the segment count differs', () => {
    expect(() => rebuildNoteDoc(full as HubNoteDoc, ['only one'])).toThrow();
  });
});

describe('noteToPlainText / noteToMarkdown', () => {
  const tasks = doc(
    para(text('Intro')),
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false }, content: [para(text('todo'))] },
        { type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] },
      ],
    },
  ) as HubNoteDoc;

  it('renders tasks as - [ ] and - [x] in plain text', () => {
    const out = noteToPlainText(tasks);
    expect(out).toContain('- [ ] todo');
    expect(out).toContain('- [x] done');
    expect(out).toContain('Intro');
  });

  it('renders tasks as - [ ] and - [x] in markdown', () => {
    const out = noteToMarkdown(tasks);
    expect(out).toContain('- [ ] todo');
    expect(out).toContain('- [x] done');
  });

  it('renders headings, lists and links in markdown', () => {
    const md = noteToMarkdown(full as HubNoteDoc);
    expect(md).toContain('## Title');
    expect(md).toContain('- one');
    expect(md).toContain('1. first');
    expect(md).toContain('[site](https://example.com/a)');
    expect(md).toContain('**b**');
  });

  it('plain text has no markup and keeps link text', () => {
    const txt = noteToPlainText(full as HubNoteDoc);
    expect(txt).toContain('Title');
    expect(txt).toContain('site');
    expect(txt).not.toContain('**');
    expect(txt).not.toContain('<');
  });
});
