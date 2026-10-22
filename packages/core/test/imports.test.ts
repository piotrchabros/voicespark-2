import { describe, expect, it } from 'vitest';
import { hmacHex } from '../src/crypto';
import { hashes, senderDomainHash, senderHash, toProgress, type ImportJobRow } from '../src/services/imports';

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';

describe('hashes', () => {
  const base = {
    messageId: '<ABC@Example.test>',
    from: 'Author <Author@Example.test>',
    date: new Date('2024-03-01T10:15:42.123Z'),
    subject: 'Hello there',
    bodyText: 'Line one\n\nLine   two\t end',
  };

  it('hashes the trimmed, lowercased Message-ID with angle brackets kept', () => {
    expect(hashes({ ...base, messageId: '  <abc@EXAMPLE.test> ' }).messageIdHash).toBe(hmacHex('<abc@example.test>'));
    expect(hashes(base).messageIdHash).toHaveLength(64);
  });

  it('returns a null Message-ID hash when there is none', () => {
    expect(hashes({ ...base, messageId: null }).messageIdHash).toBeNull();
    expect(hashes({ ...base, messageId: '   ' }).messageIdHash).toBeNull();
    expect(hashes({ bodyText: 'x' }).messageIdHash).toBeNull();
  });

  it('normalizes from, date to the minute, subject and body whitespace', () => {
    const a = hashes(base).contentHash;
    const b = hashes({
      ...base,
      from: '  author <author@example.test> ',
      date: new Date('2024-03-01T10:15:01.000Z'),
      subject: '  Hello there ',
      bodyText: ' Line one Line two end ',
    }).contentHash;
    expect(a).toBe(b);
    expect(a).toBe(
      hmacHex('author <author@example.test>|2024-03-01T10:15:00.000Z|Hello there|Line one Line two end'),
    );
  });

  it('distinguishes different minutes, subjects and bodies', () => {
    const a = hashes(base).contentHash;
    expect(hashes({ ...base, date: new Date('2024-03-01T10:16:00Z') }).contentHash).not.toBe(a);
    expect(hashes({ ...base, subject: 'hello there' }).contentHash).not.toBe(a);
    expect(hashes({ ...base, bodyText: 'Line one two end' }).contentHash).not.toBe(a);
  });

  it('uses an empty date for missing or invalid dates', () => {
    expect(hashes({ ...base, date: null }).contentHash).toBe(hashes({ ...base, date: new Date('nope') }).contentHash);
  });
});

describe('sender hashes', () => {
  it('normalize case and whitespace', () => {
    expect(senderHash(' Me@Example.TEST ')).toBe(hmacHex('me@example.test'));
    expect(senderDomainHash('Example.TEST ')).toBe(hmacHex('example.test'));
  });
});

function row(over: Partial<ImportJobRow> = {}): ImportJobRow {
  return {
    id: '3f2b8c1e-9d4a-4c1b-8e7a-1a2b3c4d5e6f',
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    kind: 'initial',
    status: 'running',
    pauseReason: null,
    filterPolicyVersion: 1,
    totalEstimate: null,
    itemsDiscovered: 120,
    itemsProcessed: 100,
    itemsImported: 80,
    itemsDuplicate: 10,
    itemsExcluded: 5,
    itemsRedacted: 3,
    itemsSkipped: 2,
    itemsFailed: 1,
    startedAt: new Date('2024-01-01T00:00:00Z'),
    finishedAt: null,
    lastActivityAt: new Date('2024-01-01T00:05:00Z'),
    errorCode: null,
    ...over,
  };
}

describe('toProgress', () => {
  it('maps the row to the API shape with ISO timestamps', () => {
    expect(toProgress(row())).toEqual({
      id: '3f2b8c1e-9d4a-4c1b-8e7a-1a2b3c4d5e6f',
      kind: 'initial',
      status: 'running',
      pauseReason: null,
      itemsDiscovered: 120,
      itemsProcessed: 100,
      itemsImported: 80,
      itemsDuplicate: 10,
      itemsExcluded: 5,
      itemsSkipped: 2,
      itemsFailed: 1,
      totalEstimate: null,
      remainingEstimate: null,
      startedAt: '2024-01-01T00:00:00.000Z',
      finishedAt: null,
      lastActivityAt: '2024-01-01T00:05:00.000Z',
    });
  });

  it('computes remainingEstimate from the total, never below zero', () => {
    expect(toProgress(row({ totalEstimate: 1000 })).remainingEstimate).toBe(900);
    expect(toProgress(row({ totalEstimate: 50 })).remainingEstimate).toBe(0);
    expect(toProgress(row({ totalEstimate: 0, itemsProcessed: 0 })).remainingEstimate).toBe(0);
  });

  it('never exposes internal fields', () => {
    const p = toProgress(row({ errorCode: 'cursor_expired' })) as unknown as Record<string, unknown>;
    expect(p).not.toHaveProperty('userId');
    expect(p).not.toHaveProperty('errorCode');
    expect(p).not.toHaveProperty('itemsRedacted');
  });
});
