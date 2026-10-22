import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptWith, encryptWith, hmacHex, parseKeyring } from '../src/crypto';

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');
const ring = parseKeyring(JSON.stringify({ k1: keyA }), 'k1');

describe('aead', () => {
  it('round-trips strings and buffers', () => {
    const ct = encryptWith(ring, 'user-content', 'zażółć gęślą jaźń');
    expect(decryptWith(ring, 'user-content', ct).toString('utf8')).toBe('zażółć gęślą jaźń');
    const bin = randomBytes(64);
    expect(decryptWith(ring, 'upload-staging', encryptWith(ring, 'upload-staging', bin)).equals(bin)).toBe(true);
  });

  it('produces the v1.{kid}.{iv}.{tag}.{ct} format with a fresh 12-byte iv', () => {
    const a = encryptWith(ring, 'mailbox-credentials', 'x');
    const b = encryptWith(ring, 'mailbox-credentials', 'x');
    const parts = a.split('.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe('k1');
    expect(Buffer.from(parts[2]!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[3]!, 'base64url')).toHaveLength(16);
    expect(a).not.toBe(b);
  });

  it('fails with the wrong key', () => {
    const other = parseKeyring(JSON.stringify({ k1: keyB }), 'k1');
    const ct = encryptWith(ring, 'user-content', 'secret');
    expect(() => decryptWith(other, 'user-content', ct)).toThrow();
  });

  it('fails with the wrong purpose or tampered ciphertext', () => {
    const ct = encryptWith(ring, 'user-content', 'secret');
    expect(() => decryptWith(ring, 'mailbox-credentials', ct)).toThrow();
    const parts = ct.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptWith(ring, 'user-content', parts.join('.'))).toThrow();
    expect(() => decryptWith(ring, 'user-content', 'garbage')).toThrow();
  });

  it('keeps old keys decryptable after rotation', () => {
    const oldRing = parseKeyring(JSON.stringify({ k1: keyA }), 'k1');
    const ct = encryptWith(oldRing, 'user-content', 'old');
    const rotated = parseKeyring(JSON.stringify({ k1: keyA, k2: keyB }), 'k2');
    expect(decryptWith(rotated, 'user-content', ct).toString()).toBe('old');
    expect(encryptWith(rotated, 'user-content', 'new').split('.')[1]).toBe('k2');
  });
});

describe('keyring', () => {
  it('derives distinct 32-byte subkeys per purpose', () => {
    const a = ring.subkey('k1', 'user-content');
    const b = ring.subkey('k1', 'mailbox-credentials');
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects an active key id that is not in the ring', () => {
    expect(() => parseKeyring(JSON.stringify({ k1: keyA }), 'nope')).toThrow();
  });
});

describe('hmac', () => {
  it('is deterministic 64-char hex and key dependent', () => {
    const key = randomBytes(32);
    const h = hmacHex('value', key);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex('value', key)).toBe(h);
    expect(hmacHex('value', randomBytes(32))).not.toBe(h);
  });
});
