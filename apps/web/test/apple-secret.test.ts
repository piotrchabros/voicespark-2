import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAppleClientSecret, getAppleClientSecret } from '../lib/apple-secret';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const parse = (jwt: string) => {
  const [header, claims, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    claims: JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    signature: Buffer.from(signature!, 'base64url'),
    input: `${header}.${claims}`,
  };
};

describe('createAppleClientSecret', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const jwt = createAppleClientSecret({
    teamId: 'TEAM123',
    keyId: 'KEY456',
    clientId: 'com.example.web',
    privateKeyPem,
    now,
  });

  it('builds an ES256 JWT with the Apple claims', () => {
    const { header, claims } = parse(jwt);
    expect(header).toEqual({ alg: 'ES256', kid: 'KEY456' });
    const iat = now.getTime() / 1000;
    expect(claims).toEqual({
      iss: 'TEAM123',
      iat,
      exp: iat + 180 * 24 * 60 * 60,
      aud: 'https://appleid.apple.com',
      sub: 'com.example.web',
    });
  });

  it('carries a signature that verifies with the public key', () => {
    const { signature, input } = parse(jwt);
    expect(signature).toHaveLength(64);
    expect(
      verify(
        'sha256',
        Buffer.from(input),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
  });

  it('accepts a PEM with escaped newlines', () => {
    const escaped = privateKeyPem.replace(/\n/g, '\\n');
    const other = createAppleClientSecret({
      teamId: 't',
      keyId: 'k',
      clientId: 'c',
      privateKeyPem: escaped,
      now,
    });
    const { signature, input } = parse(other);
    expect(
      verify(
        'sha256',
        Buffer.from(input),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
  });
});

describe('getAppleClientSecret', () => {
  const env = {
    APPLE_TEAM_ID: 'TEAM123',
    APPLE_KEY_ID: 'KEY456',
    APPLE_CLIENT_ID: 'com.example.web',
    APPLE_PRIVATE_KEY: privateKeyPem,
  };

  it('memoizes and regenerates after 150 days', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const first = getAppleClientSecret(env, t0);
    expect(getAppleClientSecret(env, new Date(t0.getTime() + 149 * 86_400_000))).toBe(first);
    const later = getAppleClientSecret(env, new Date(t0.getTime() + 151 * 86_400_000));
    expect(later).not.toBe(first);
    expect(parse(later).claims.iat).toBe(t0.getTime() / 1000 + 151 * 86_400);
  });
});
