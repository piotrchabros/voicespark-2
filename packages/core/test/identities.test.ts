import { describe, expect, it } from 'vitest';
import {
  canOfferLink,
  canOfferLinkForProvider,
  isRelayEmail,
  isSignInProvider,
  startLink,
  type SocialLinker,
} from '../src/services/identities';

const ctx = { userId: '3f2b8c1e-9d4a-4c1b-8e7a-1a2b3c4d5e6f', role: 'user' as const };

describe('isRelayEmail', () => {
  it('detects Apple private relay addresses case-insensitively', () => {
    expect(isRelayEmail('abc123@privaterelay.appleid.com')).toBe(true);
    expect(isRelayEmail('ABC123@PrivateRelay.AppleID.com ')).toBe(true);
  });

  it('is false for ordinary or missing addresses', () => {
    expect(isRelayEmail('user@icloud.com')).toBe(false);
    expect(isRelayEmail('privaterelay.appleid.com@example.com')).toBe(false);
    expect(isRelayEmail(null)).toBe(false);
    expect(isRelayEmail(undefined)).toBe(false);
  });
});

describe('isSignInProvider', () => {
  it('accepts the four sign-in providers only', () => {
    for (const p of ['google', 'apple', 'microsoft', 'facebook']) expect(isSignInProvider(p)).toBe(true);
    expect(isSignInProvider('gmail')).toBe(false);
    expect(isSignInProvider('test-mock')).toBe(false);
  });
});

describe('canOfferLink', () => {
  it('offers linking for a verified, non-relay, non-Facebook identity', () => {
    expect(canOfferLink({ provider: 'google', emailVerified: true, isRelayEmail: false })).toBe(true);
  });

  it('refuses unverified, relay and Facebook identities', () => {
    expect(canOfferLink({ provider: 'microsoft', emailVerified: false, isRelayEmail: false })).toBe(false);
    expect(canOfferLink({ provider: 'apple', emailVerified: true, isRelayEmail: true })).toBe(false);
    expect(canOfferLink({ provider: 'facebook', emailVerified: true, isRelayEmail: false })).toBe(false);
  });
});

describe('canOfferLinkForProvider', () => {
  it('offers for non-Facebook sign-in providers only', () => {
    expect(canOfferLinkForProvider('google')).toBe(true);
    expect(canOfferLinkForProvider('apple')).toBe(true);
    expect(canOfferLinkForProvider('microsoft')).toBe(true);
    expect(canOfferLinkForProvider('facebook')).toBe(false);
    expect(canOfferLinkForProvider('gmail')).toBe(false);
    expect(canOfferLinkForProvider('')).toBe(false);
  });
});

describe('startLink', () => {
  it('passes the completion and error callbacks to the linker and returns its url', async () => {
    const calls: Parameters<SocialLinker>[0][] = [];
    const linker: SocialLinker = async (args) => {
      calls.push(args);
      return { url: 'https://provider.example/authorize?x=1' };
    };
    await expect(startLink(ctx, 'microsoft', 'confirmed_link', linker)).resolves.toEqual({
      redirectUrl: 'https://provider.example/authorize?x=1',
    });
    expect(calls).toEqual([
      {
        provider: 'microsoft',
        callbackURL: '/api/identities/link/complete?provider=microsoft&via=confirmed_link',
        errorCallbackURL: '/settings/identities?error=link_failed',
      },
    ]);
  });

  it('rejects an unknown provider without calling the linker', async () => {
    let called = false;
    const linker: SocialLinker = async () => {
      called = true;
      return { url: 'x' };
    };
    await expect(startLink(ctx, 'gmail' as never, 'manual_link', linker)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(called).toBe(false);
  });
});
