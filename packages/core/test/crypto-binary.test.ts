import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { resetEnvForTests } from '../src/env';
import {
  decryptBinary,
  encryptBinary,
  encryptBinaryWith,
  parseKeyring,
  readBinaryKeyId,
  resetKeyringForTests,
  type KeyPurpose,
} from '../src/crypto';

const keyA = randomBytes(32).toString('base64');

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET ??= 'x'.repeat(32);
  process.env.DEDUP_HMAC_KEY ??= 'test-dedup-key';
  process.env.ENCRYPTION_KEYRING = JSON.stringify({ k1: keyA });
  process.env.ENCRYPTION_ACTIVE_KEY_ID = 'k1';
  resetEnvForTests();
  resetKeyringForTests();
});

/** Header: 'v1' (2 bytes) | kidlen (1 byte) | kid | iv (12) | tag (16). */
function headerLength(kid: string): number {
  return 2 + 1 + Buffer.byteLength(kid, 'utf8') + 12 + 16;
}

describe('binary aead envelope', () => {
  it('writes the v1|kidlen|kid|iv|tag header followed by raw ciphertext', () => {
    const plain = Buffer.from('hello hub files', 'utf8');
    const out = Buffer.from(encryptBinary('hub-files', plain));
    expect(out.subarray(0, 2).toString('ascii')).toBe('v1');
    expect(out[2]).toBe(2);
    expect(out.subarray(3, 5).toString('utf8')).toBe('k1');
    // AES-GCM is a stream mode: raw ciphertext has the plaintext length (no base64).
    expect(out.length).toBe(headerLength('k1') + plain.length);
    expect(out.includes(plain)).toBe(false);
    const again = Buffer.from(encryptBinary('hub-files', plain));
    expect(again.subarray(5, 17).equals(out.subarray(5, 17))).toBe(false);
  });

  it.each([
    ['0 bytes', 0],
    ['1 byte', 1],
    ['26 MB', 26 * 1024 * 1024],
  ])('round-trips %s', (_label, size) => {
    const plain = randomBytes(size);
    const ct = encryptBinary('hub-files', plain);
    expect(ct.length).toBe(headerLength('k1') + size);
    expect(Buffer.from(decryptBinary('hub-files', ct)).equals(plain)).toBe(true);
  });

  it('binds the purpose as AAD', () => {
    const ct = encryptBinary('hub-files', Buffer.from('secret'));
    expect(() => decryptBinary('user-content', ct)).toThrow();
  });

  it('fails when a ciphertext byte is flipped', () => {
    const ct = Buffer.from(encryptBinary('hub-files', Buffer.from('secret bytes')));
    ct[ct.length - 1] = ct[ct.length - 1]! ^ 0x01;
    expect(() => decryptBinary('hub-files', ct)).toThrow();
  });

  it('fails on an unknown kid and on a malformed envelope', () => {
    const other = parseKeyring(JSON.stringify({ k9: randomBytes(32).toString('base64') }), 'k9');
    const ct = encryptBinaryWith(other, 'hub-files', Buffer.from('secret'));
    expect(() => decryptBinary('hub-files', ct)).toThrow(/unknown encryption key id/);
    expect(() => decryptBinary('hub-files', Buffer.from('garbage'))).toThrow();
    expect(() => decryptBinary('hub-files', Buffer.alloc(0))).toThrow();
  });

  it('reads the kid from the header without the key', () => {
    const other = parseKeyring(JSON.stringify({ 'key-2026': randomBytes(32).toString('base64') }), 'key-2026');
    expect(readBinaryKeyId(encryptBinaryWith(other, 'hub-files', Buffer.from('x')))).toBe('key-2026');
    expect(readBinaryKeyId(encryptBinary('hub-files', Buffer.alloc(0)))).toBe('k1');
    expect(() => readBinaryKeyId(Buffer.from('nope'))).toThrow();
  });

  it("accepts 'hub-files' as a KeyPurpose with its own subkey", () => {
    expectTypeOf<'hub-files'>().toMatchTypeOf<KeyPurpose>();
    const ring = parseKeyring(JSON.stringify({ k1: keyA }), 'k1');
    const sub = ring.subkey('k1', 'hub-files');
    expect(sub).toHaveLength(32);
    expect(sub.equals(ring.subkey('k1', 'user-content'))).toBe(false);
  });
});
