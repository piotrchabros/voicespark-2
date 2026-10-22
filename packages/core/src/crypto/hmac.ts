import { createHmac } from 'node:crypto';
import { loadEnv } from '../env';

/** HMAC-SHA256 hex (64 chars). Default key is the base64-decoded `DEDUP_HMAC_KEY`. */
export function hmacHex(value: string, key?: Buffer): string {
  const k = key ?? Buffer.from(loadEnv().DEDUP_HMAC_KEY, 'base64');
  return createHmac('sha256', k).update(value, 'utf8').digest('hex');
}

/** Pseudonymous reference to a user that survives deletion of the user row (audit log, deletion requests). */
export function subjectRef(userId: string): string {
  return hmacHex(`subject:${userId}`);
}
