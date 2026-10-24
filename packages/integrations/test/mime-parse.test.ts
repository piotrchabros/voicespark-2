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

  it('survives deeply nested html without blocking or overflowing the stack', async () => {
    const depth = 200_000;
    const html = `${'<div>'.repeat(depth)}Deep text &amp; more${'</div>'.repeat(depth)}`;
    const raw = Buffer.from(['From: a@example.test', 'Subject: Deep', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n'));
    const started = performance.now();
    const m = await parseMessage(raw, { authored: true });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(m.bodyText).toBe('Deep text & more');
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

const eml = (lines: string[]) => Buffer.from(lines.join('\r\n'));

const hubMail = eml([
  'Message-ID: <m2@mail.acme.example>',
  'In-Reply-To: <M1@Mail.Acme.Example>',
  'References: <root@mail.acme.example>',
  ' <M1@mail.acme.example>',
  'Return-Path: <>',
  'List-Unsubscribe: <https://lists.acme.example/u?id=1>,',
  ' <mailto:unsub@lists.acme.example>',
  'List-Id: Acme news <news.acme.example>',
  'Precedence: bulk',
  'Auto-Submitted: auto-generated',
  'X-Auto-Response-Suppress: All',
  'Feedback-ID: 1:2:acme',
  'X-Mailgun-Variables: {"a":1}',
  'X-Mailchimp-Campaign: c1',
  'X-CampaignID: 42',
  'X-SG-EID: abc',
  'X-SES-Outgoing: 2025.01.06',
  'X-MC-User: u1',
  'X-Other: not kept',
  'Received: from relay.acme.example',
  'From: Ann <ann@acme.example>',
  'To: bob@corp.example',
  'Subject: News',
  'Date: Mon, 6 Jan 2025 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Plain part.',
  '',
  'On Sun, Jan 5, 2025 Bob <bob@corp.example> wrote:',
  '> earlier',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Html part.</p>',
  '--b1--',
  '',
]);

describe('parseMessage hub fields', () => {
  it('exposes reply ids, html, raw text and whitelisted headers', async () => {
    const m = await parseMessage(hubMail, { authored: true });
    expect(m.inReplyTo).toBe('<M1@Mail.Acme.Example>');
    expect(m.references).toEqual(['<root@mail.acme.example>', '<M1@mail.acme.example>']);
    expect(m.html).toContain('<p>Html part.</p>');
    expect(m.rawText).toContain('Plain part.');
    expect(m.rawText).toContain('> earlier');
    expect(m.bodyText).toBe('Plain part.');
    expect(m.headers).toEqual({
      'return-path': '<>',
      'list-unsubscribe': '<https://lists.acme.example/u?id=1>, <mailto:unsub@lists.acme.example>',
      'list-id': 'Acme news <news.acme.example>',
      precedence: 'bulk',
      'auto-submitted': 'auto-generated',
      'x-auto-response-suppress': 'All',
      'feedback-id': '1:2:acme',
      'x-mailgun-variables': '{"a":1}',
      'x-mailchimp-campaign': 'c1',
      'x-campaignid': '42',
      'x-sg-eid': 'abc',
      'x-ses-outgoing': '2025.01.06',
      'x-mc-user': 'u1',
    });
  });

  it('defaults the hub fields on a plain message', async () => {
    const m = await parseMessage(fixture('plain.eml'), { authored: false });
    expect(m.inReplyTo).toBeNull();
    expect(m.references).toEqual([]);
    expect(m.html).toBeNull();
    expect(m.rawText).toContain('This is the plain body.');
    expect(m.headers).toEqual({});
  });

  it('leaves rawText empty for an html-only message', async () => {
    const m = await parseMessage(fixture('html-only.eml'), { authored: false });
    expect(m.html).toContain('<b>world</b>');
    expect(m.rawText).toBe('');
  });

  it('keeps the authored-only reply-parser output byte-identical', async () => {
    const expected: [string, boolean, string][] = [
      ['plain.eml', true, 'Hello Bob,\n\nThis is the plain body.'],
      ['plain.eml', false, 'Hello Bob,\n\nThis is the plain body.'],
      ['html-only.eml', true, 'Hello world\n\nSecond paragraph'],
      ['html-only.eml', false, 'Hello world\n\nSecond paragraph'],
      ['reply.eml', true, 'Sounds good, lets go with option two.'],
      [
        'reply.eml',
        false,
        'Sounds good, lets go with option two.\n\nOn Mon, Jan 6, 2025 at 10:00 AM Bob <bob@example.test> wrote:\n> Which option do you prefer?\n> I think option one is cheaper.',
      ],
      ['attachment.eml', true, 'See attached notes.'],
      ['attachment.eml', false, 'See attached notes.'],
    ];
    for (const [name, authored, body] of expected) {
      const m = await parseMessage(fixture(name), { authored });
      expect(m.bodyText).toBe(body);
    }
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
