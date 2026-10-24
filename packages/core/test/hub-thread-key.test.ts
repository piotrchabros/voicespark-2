import { describe, expect, it } from 'vitest';
import { hmacHex } from '../src/crypto';
import { normalizeMessageId, syntheticRoot, threadKey, threadRoot } from '../src/hub/thread-key';

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';

describe('normalizeMessageId', () => {
  it('trims angle brackets and whitespace and lower-cases', () => {
    expect(normalizeMessageId(' <AbC@Example.COM> ')).toBe('abc@example.com');
    expect(normalizeMessageId('abc@x')).toBe('abc@x');
  });
  it('returns null for empty ids', () => {
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId('<>')).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });
});

describe('threadRoot', () => {
  const own = '<Own@x>';
  it('uses the first reference', () => {
    expect(threadRoot({ messageId: own, inReplyTo: '<b@x>', references: ['<A@X>', '<b@x>'] }, 'fb')).toBe('a@x');
  });
  it('falls back to In-Reply-To, then the own Message-ID', () => {
    expect(threadRoot({ messageId: own, inReplyTo: '<B@x>', references: [] }, 'fb')).toBe('b@x');
    expect(threadRoot({ messageId: own, references: [] }, 'fb')).toBe('own@x');
  });
  it('skips blank references', () => {
    expect(threadRoot({ messageId: own, references: ['<>', '<a@x>'] }, 'fb')).toBe('a@x');
  });
  it('uses the synthetic root when no id is present', () => {
    expect(threadRoot({ references: [] }, syntheticRoot('src1', 'ref9'))).toBe('source:src1:ref9');
  });
});

describe('threadKey', () => {
  it('is the HMAC of hubthread:{userId}:{root}', () => {
    expect(threadKey('u1', 'a@x')).toBe(hmacHex('hubthread:u1:a@x'));
  });
  it('differs between users for the same root', () => {
    expect(threadKey('u1', 'a@x')).not.toBe(threadKey('u2', 'a@x'));
  });
});
