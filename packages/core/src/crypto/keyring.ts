import { createSecretKey, hkdfSync } from 'node:crypto';
import { loadEnv } from '../env';

export type KeyPurpose = 'mailbox-credentials' | 'user-content' | 'upload-staging';

export interface Keyring {
  activeKeyId: string;
  hasKey(kid: string): boolean;
  /** 32-byte AES-256 subkey derived with HKDF-SHA256 (empty salt, info = purpose). */
  subkey(kid: string, purpose: KeyPurpose): Buffer;
}

export function parseKeyring(json: string, activeKeyId: string): Keyring {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('keyring must be a JSON object {kid: base64}');
  }
  const masters = new Map<string, Buffer>();
  for (const [kid, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`keyring entry "${kid}" must be a base64 string`);
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error(`keyring entry "${kid}" must be base64 of 32 bytes`);
    masters.set(kid, key);
  }
  if (!masters.has(activeKeyId)) throw new Error('active key id is not present in the keyring');

  const cache = new Map<string, Buffer>();
  return {
    activeKeyId,
    hasKey: (kid) => masters.has(kid),
    subkey(kid, purpose) {
      const master = masters.get(kid);
      if (!master) throw new Error(`unknown encryption key id "${kid}"`);
      const cacheKey = `${kid}\u0000${purpose}`;
      let derived = cache.get(cacheKey);
      if (!derived) {
        derived = Buffer.from(hkdfSync('sha256', createSecretKey(master), Buffer.alloc(0), purpose, 32));
        cache.set(cacheKey, derived);
      }
      return Buffer.from(derived);
    },
  };
}

let cached: Keyring | undefined;

export function getKeyring(): Keyring {
  if (!cached) {
    const env = loadEnv();
    cached = parseKeyring(JSON.stringify(env.ENCRYPTION_KEYRING), env.ENCRYPTION_ACTIVE_KEY_ID);
  }
  return cached;
}

export function resetKeyringForTests(): void {
  cached = undefined;
}
