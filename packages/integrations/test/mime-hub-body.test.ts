import { describe, expect, it } from 'vitest';
import { assembleThreadText, cleanHubBody, MESSAGE_CAP, THREAD_CAP, type HubThreadMessage } from '../src/mime/hub-body';

const text = (rawText: string) => cleanHubBody({ rawText, html: null, bodyText: rawText.trim() });
const html = (h: string) => cleanHubBody({ rawText: '', html: h, bodyText: '' });

describe('cleanHubBody: source', () => {
  it('prefers plain text over html', () => {
    const r = cleanHubBody({ rawText: 'Plain wins.', html: '<p>Html loses.</p>', bodyText: 'Plain wins.' });
    expect(r.body).toBe('Plain wins.');
  });

  it('converts html and skips quote containers', () => {
    const r = html(
      '<div>Fresh reply.</div>' +
        '<div class="gmail_quote">On Mon Bob wrote: <blockquote>old gmail</blockquote></div>' +
        '<blockquote type="cite">old apple</blockquote>' +
        '<div id="appendonsend"></div>',
    );
    expect(r.body).toBe('Fresh reply.');
  });

  it('drops #divRplyFwdMsg and everything after it', () => {
    const r = html('<p>Answer here.</p><hr><div id="divRplyFwdMsg"><b>From:</b> Bob</div><div>old outlook text</div>');
    expect(r.body).toBe('Answer here.');
  });

  it('falls back to bodyText when there is neither plain text nor html', () => {
    expect(cleanHubBody({ rawText: '', html: null, bodyText: 'Only this.' }).body).toBe('Only this.');
  });
});

describe('cleanHubBody: quoted history', () => {
  it.each([
    ['On Mon, Jan 6, 2025 at 10:00 AM Bob <bob@corp.example> wrote:\nold'],
    ['On Mon, Jan 6, 2025 at 10:00 AM Bob <bob@corp.example>\nwrote:\nold'],
    ['-----Original Message-----\nFrom: Bob\nold'],
    ['W dniu 6.01.2025 o 10:00, Bob <bob@corp.example> napisał(a):\nold'],
    ['Dnia 6 stycznia 2025 Bob napisał:\nold'],
    ['-------- Wiadomość oryginalna --------\nold'],
    ['> old quoted line\n> more'],
    ['From: Bob <bob@corp.example>\nSent: Monday, January 6, 2025 10:00\nTo: Ann\nSubject: x\n\nold'],
    ['Od: Bob <bob@corp.example>\nWysłano: poniedziałek, 6 stycznia 2025 10:00\nDo: Ann\n\nold'],
  ])('cuts at %j', (quote) => {
    expect(text(`New text first.\n\n${quote}`).body).toBe('New text first.');
  });

  it('does not cut on a lone From: line without Sent:', () => {
    expect(text('From: the warehouse team\nwe shipped it.').body).toBe('From: the warehouse team\nwe shipped it.');
  });

  it.each(['---------- Forwarded message ---------', 'Begin forwarded message:', '---------- Przekazana wiadomość ----------'])(
    'keeps the block after forward marker %j',
    (marker) => {
      const r = text(`FYI see below.\n\n${marker}\nFrom: Cy <cy@vendor.example>\nSent: Monday\nSubject: Offer\n\nOur offer is 10 units.\n> quoted inside`);
      expect(r.body).toContain('Our offer is 10 units.');
      expect(r.body).toContain('From: Cy <cy@vendor.example>');
      expect(r.body).toContain('> quoted inside');
    },
  );
});

describe('cleanHubBody: disclaimers and signature', () => {
  it.each([
    'This message is CONFIDENTIAL and may be privileged.',
    'Treść tej wiadomości jest poufna.',
    'Klauzula informacyjna: administratorem danych jest Acme.',
    'Zgodnie z RODO informujemy...',
    'Under GDPR you may ask us...',
    'It is intended solely for the named addressee.',
    'It is intended for the addressee only.',
    'This email and any attachments are private.',
    'This e-mail and any attachments are private.',
  ])('removes disclaimer paragraph %j', (disclaimer) => {
    const r = text(`Meeting moved to Friday.\n\n${disclaimer}\nSecond line of it.\n\nSee you.`);
    expect(r.body).toBe('Meeting moved to Friday.\n\nSee you.');
  });

  it('splits the signature after a -- line', () => {
    const r = text('Body line.\n\n-- \nAnn Nowak\nHead of Sales, Acme sp. z o.o.\n+48 600 000 000');
    expect(r.body).toBe('Body line.');
    expect(r.signature).toBe('Ann Nowak\nHead of Sales, Acme sp. z o.o.\n+48 600 000 000');
  });

  it('falls back to the last 12 lines as signature on long messages', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const r = text(lines.join('\n'));
    expect(r.body).toBe(lines.slice(0, 8).join('\n'));
    expect(r.signature).toBe(lines.slice(8).join('\n'));
  });

  it('keeps short messages whole without a signature split', () => {
    expect(text('Thanks!\nAnn')).toEqual({ body: 'Thanks!\nAnn', signature: '' });
  });

  it('caps the message at MESSAGE_CAP with the signature at most 1500', () => {
    const r = text(`${'word '.repeat(5000)}\n-- \n${'sig '.repeat(1000)}`);
    expect(r.signature.length).toBeLessThanOrEqual(1500);
    expect(r.body.length + r.signature.length).toBeLessThanOrEqual(MESSAGE_CAP);
    expect(r.body.length).toBeGreaterThan(4000);
  });
});

describe('cleanHubBody: adversarial input', () => {
  it.each([
    ['deep nesting', '<div>'.repeat(200_000)],
    ['mismatched end tags', '<div></span>'.repeat(90_000)],
    ['one long text node', '<p>' + 'a'.repeat(1_000_000) + '</p>'],
    ['unterminated tags', '<'.repeat(1_000_000)],
    ['id attributes', '<div id'.repeat(140_000)],
  ])('stays fast on ~1M chars of html %s', (_name, input) => {
    const started = performance.now();
    const r = cleanHubBody({ rawText: '', html: input, bodyText: 'fallback' });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(r.body.length + r.signature.length).toBeLessThanOrEqual(MESSAGE_CAP);
  });

  it('falls back to bodyText for html nested deeper than the limit', () => {
    expect(cleanHubBody({ rawText: '', html: '<div>'.repeat(5000) + 'deep', bodyText: 'fallback' }).body).toBe('fallback');
    expect(cleanHubBody({ rawText: '', html: '<div>'.repeat(50) + 'shallow', bodyText: 'fallback' }).body).toBe('shallow');
  });

  it.each([
    ['one long token', 'a'.repeat(1_000_000)],
    ['spaces', ' '.repeat(1_000_000) + 'x'],
    ['blank lines', '\n \n'.repeat(250_000)],
    ['On without wrote', 'On ' + 'x '.repeat(500_000)],
    ['quote markers', '>'.repeat(1_000_000)],
    ['dashes', '-'.repeat(1_000_000)],
    ['disclaimer near-miss', 'intended solely for the named '.repeat(35_000)],
    ['header lines', 'From: x\n'.repeat(125_000)],
  ])('stays fast on 1M chars of %s', (_name, input) => {
    const started = performance.now();
    const r = text(input);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(r.body.length + r.signature.length).toBeLessThanOrEqual(MESSAGE_CAP);
  });
});

const m = (over: Partial<HubThreadMessage>): HubThreadMessage => ({
  date: new Date('2025-01-06T10:00:00Z'),
  direction: 'inbound',
  from: 'Ann <ann@acme.example>',
  subject: 'Offer',
  body: 'Hello.',
  signature: '',
  ...over,
});

describe('assembleThreadText', () => {
  it('renders numbered messages oldest first', () => {
    const r = assembleThreadText([m({ body: 'First.' }), m({ direction: 'outbound', from: 'bob@corp.example', body: 'Second.' })]);
    expect(r.omitted).toBe(0);
    expect(r.text).toBe(
      '[M1] 2025-01-06 10:00 | inbound | Ann <ann@acme.example> | Offer\nFirst.\n\n' +
        '[M2] 2025-01-06 10:00 | outbound | bob@corp.example | Offer\nSecond.',
    );
  });

  it('keeps the first signature per sender and replaces repeats', () => {
    const sig = 'Ann Nowak\nAcme';
    const r = assembleThreadText([
      m({ body: 'One.', signature: sig }),
      m({ from: 'bob@corp.example', body: 'Two.', signature: 'Bob' }),
      m({ from: 'ANN@acme.example', body: 'Three.', signature: sig }),
      m({ body: 'Four.', signature: 'Ann Nowak\nAcme\nnew phone 600' }),
    ]);
    expect(r.text).toContain('One.\n-- \nAnn Nowak\nAcme\n\n');
    expect(r.text).toContain('Three.\n[signature as above]');
    expect(r.text).toContain('Two.\n-- \nBob');
    expect(r.text).toContain('Four.\n-- \nAnn Nowak\nAcme\nnew phone 600');
  });

  it('caps at THREAD_CAP: first message, newest that fit, omitted line', () => {
    const messages = Array.from({ length: 20 }, (_, i) => m({ body: `msg${i + 1} ` + 'x'.repeat(5000) }));
    const r = assembleThreadText(messages);
    expect(r.text.length).toBeLessThanOrEqual(THREAD_CAP);
    expect(r.text.startsWith('[M1]')).toBe(true);
    expect(r.text).toContain('[M20]');
    expect(r.omitted).toBeGreaterThan(0);
    const kept = 20 - 1 - r.omitted;
    expect(r.text).toContain(`[${r.omitted} earlier messages omitted: M2-M${r.omitted + 1}]`);
    expect(r.text).toContain(`[M${20 - kept + 1}]`);
    expect(r.text).not.toContain(`[M${r.omitted + 1}] `);
    expect(r.text.indexOf('earlier messages omitted')).toBeLessThan(r.text.indexOf('[M20]'));
  });

  it('a signature first seen in an omitted message is shown again', () => {
    const sig = 'Cy Vendor\nphone 600';
    const big = 'y'.repeat(5000);
    const messages = [
      m({ from: 'ann@acme.example', body: 'start' }),
      m({ from: 'cy@vendor.example', body: big, signature: sig }),
      ...Array.from({ length: 8 }, () => m({ from: 'bob@corp.example', body: big })),
      m({ from: 'cy@vendor.example', body: 'last', signature: sig }),
    ];
    const r = assembleThreadText(messages);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.text).toContain('last\n-- \nCy Vendor\nphone 600');
  });
});
