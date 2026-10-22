import { createPrivateKey, sign } from 'node:crypto';
import type { Env } from '@voicespark/core/env';

const DEFAULT_TTL_SECONDS = 180 * 24 * 60 * 60;
/** Regenerate well before Apple's 6-month maximum lifetime (research R3). */
const REFRESH_AFTER_MS = 150 * 24 * 60 * 60 * 1000;

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Apple "Sign in with Apple" client secret: an ES256 JWT signed with the team's private key. */
export function createAppleClientSecret(i: {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKeyPem: string;
  now?: Date;
  ttlSeconds?: number;
}): string {
  const iat = Math.floor((i.now ?? new Date()).getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: i.keyId }));
  const claims = b64url(
    JSON.stringify({
      iss: i.teamId,
      iat,
      exp: iat + (i.ttlSeconds ?? DEFAULT_TTL_SECONDS),
      aud: 'https://appleid.apple.com',
      sub: i.clientId,
    }),
  );
  const input = `${header}.${claims}`;
  // Env files often carry the PEM with escaped newlines.
  const key = createPrivateKey(i.privateKeyPem.replace(/\\n/g, '\n'));
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

let memo: { secret: string; createdAt: number } | undefined;

/** Memoized Apple client secret, regenerated once it is older than 150 days. */
export function getAppleClientSecret(
  env: Pick<Env, 'APPLE_TEAM_ID' | 'APPLE_KEY_ID' | 'APPLE_CLIENT_ID' | 'APPLE_PRIVATE_KEY'>,
  now: Date = new Date(),
): string {
  if (!memo || now.getTime() - memo.createdAt > REFRESH_AFTER_MS) {
    memo = {
      secret: createAppleClientSecret({
        teamId: env.APPLE_TEAM_ID,
        keyId: env.APPLE_KEY_ID,
        clientId: env.APPLE_CLIENT_ID,
        privateKeyPem: env.APPLE_PRIVATE_KEY,
        now,
      }),
      createdAt: now.getTime(),
    };
  }
  return memo.secret;
}
