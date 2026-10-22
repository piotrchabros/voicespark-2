import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMessage, splitParts } from '../src/mime/parse';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/mail/${name}`, import.meta.url)));

describe('parseMessage', () => {
  it('parses headers and plain body', async () => {
    const m = await parseMessage(fixture('plain.eml'), { authored: false, folders: ['INBOX'] });
    expect(m.messageId).toBe('<a1@example.test>');
    expect(m.subject).toBe('Plain');
    expect(m.from).toContain('ann@example.test');
    expect(m.to).toContain('bob@example.test');
    expect(m.cc).toContain('cy@example.test');
    expect(m.date?.toISOString()).toBe('2025-01-06T10:00:00.000Z');
    expect(m.bodyText).toContain('This is the plain body.');
    expect(m.folders).toEqual(['INBOX']);
    expect(m.attachments).toEqual([]);
  });

  it('falls back to html-to-text', async () => {
    const m = await parseMessage(fixture('html-only.eml'), { authored: false });
    expect(m.bodyText).toContain('Hello world');
    expect(m.bodyText).toContain('Second paragraph');
    expect(m.bodyText).not.toContain('<');
  });

  it('strips quoted replies only for authored items', async () => {
    const authored = await parseMessage(fixture('reply.eml'), { authored: true });
    expect(authored.bodyText).toContain('option two');
    expect(authored.bodyText).not.toContain('option one');
    const received = await parseMessage(fixture('reply.eml'), { authored: false });
    expect(received.bodyText).toContain('option one');
  });

  it('extracts attachments', async () => {
    const m = await parseMessage(fixture('attachment.eml'), { authored: false });
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.filename).toBe('notes.txt');
    expect(m.attachments[0]!.buffer.toString()).toBe('Some attached notes.');
    expect(m.bodyText).toBe('See attached notes.');
  });
});

describe('splitParts', () => {
  it('returns [] for empty and one part for short text', () => {
    expect(splitParts('')).toEqual([]);
    expect(splitParts('hello')).toEqual(['hello']);
  });

  it('splits on paragraph boundaries', () => {
    expect(splitParts('aaaa bbbb\n\ncccc dddd', 12)).toEqual(['aaaa bbbb', 'cccc dddd']);
  });

  it('falls back to line then whitespace, never mid-word', () => {
    expect(splitParts('aaaa bbbb\ncccc dddd', 12)).toEqual(['aaaa bbbb', 'cccc dddd']);
    const parts = splitParts('alpha beta gamma delta epsilon', 12);
    expect(parts.join(' ')).toBe('alpha beta gamma delta epsilon');
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(12);
  });

  it('handles 250k chars into parts within the cap', () => {
    const text = Array.from({ length: 25_000 }, () => 'abcdefghi').join(' ');
    const parts = splitParts(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100_000);
  });
});
