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
