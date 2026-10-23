import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getKeyring, type KeyPurpose, type Keyring } from './keyring';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Format: `v1.{kid}.{iv_b64url}.{tag_b64url}.{ct_b64url}`; the purpose is bound as AAD. */
export function encryptWith(k: Keyring, purpose: KeyPurpose, plaintext: string | Buffer): string {
  const kid = k.activeKeyId;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', k.subkey(kid, purpose), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, kid, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptWith(k: Keyring, purpose: KeyPurpose, ciphertext: string): Buffer {
  const parts = ciphertext.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('malformed ciphertext');
  const [, kid, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
  if (!k.hasKey(kid)) throw new Error('unknown encryption key id');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', k.subkey(kid, purpose), iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
}

export function encrypt(purpose: KeyPurpose, plaintext: string): string {
  return encryptWith(getKeyring(), purpose, plaintext);
}

export function decrypt(purpose: KeyPurpose, ciphertext: string): string {
  return decryptWith(getKeyring(), purpose, ciphertext).toString('utf8');
}

export function encryptBuffer(purpose: KeyPurpose, buf: Buffer): string {
  return encryptWith(getKeyring(), purpose, buf);
}

export function decryptBuffer(purpose: KeyPurpose, ciphertext: string): Buffer {
  return decryptWith(getKeyring(), purpose, ciphertext);
}

const BINARY_MAGIC = Buffer.from(VERSION, 'ascii');

/**
 * Binary envelope for large blobs (no base64): `v1` | kidlen (1 byte) | kid | iv (12) | tag (16) | ct.
 * The purpose is bound as AAD, as in the text envelope.
 */
export function encryptBinaryWith(k: Keyring, purpose: KeyPurpose, bytes: Uint8Array): Buffer {
  const kid = k.activeKeyId;
  const kidBytes = Buffer.from(kid, 'utf8');
  if (kidBytes.length === 0 || kidBytes.length > 255) throw new Error('key id must be 1..255 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', k.subkey(kid, purpose), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const ct = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BINARY_MAGIC, Buffer.from([kidBytes.length]), kidBytes, iv, tag, ct]);
}

function parseBinaryHeader(data: Uint8Array): { kid: string; iv: Buffer; tag: Buffer; ctOffset: number } {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < BINARY_MAGIC.length + 1 || !buf.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
    throw new Error('malformed ciphertext');
  }
  const kidLen = buf[BINARY_MAGIC.length]!;
  const kidStart = BINARY_MAGIC.length + 1;
  const ivStart = kidStart + kidLen;
  const ctOffset = ivStart + IV_BYTES + TAG_BYTES;
  if (kidLen === 0 || buf.length < ctOffset) throw new Error('malformed ciphertext');
  return {
    kid: buf.subarray(kidStart, ivStart).toString('utf8'),
    iv: buf.subarray(ivStart, ivStart + IV_BYTES),
    tag: buf.subarray(ivStart + IV_BYTES, ctOffset),
    ctOffset,
  };
}

/** The kid of a binary envelope, read from the header without any key. */
export function readBinaryKeyId(data: Uint8Array): string {
  return parseBinaryHeader(data).kid;
}

export function decryptBinaryWith(k: Keyring, purpose: KeyPurpose, data: Uint8Array): Buffer {
  const { kid, iv, tag, ctOffset } = parseBinaryHeader(data);
  if (!k.hasKey(kid)) throw new Error('unknown encryption key id');
  const decipher = createDecipheriv('aes-256-gcm', k.subkey(kid, purpose), iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(ctOffset)), decipher.final()]);
}

export function encryptBinary(purpose: KeyPurpose, bytes: Uint8Array): Buffer {
  return encryptBinaryWith(getKeyring(), purpose, bytes);
}

export function decryptBinary(purpose: KeyPurpose, data: Uint8Array): Buffer {
  return decryptBinaryWith(getKeyring(), purpose, data);
}
