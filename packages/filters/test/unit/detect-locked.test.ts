import { describe, expect, it } from 'vitest';
// Static import on purpose: detectLocked is RED until U2 lands.
import { detectLocked } from '../../src';

const AWS_KEY = 'AKIAQ3XW7ZP2LM9TR5VB';

describe('detectLocked', () => {
  it.each([
    ['passwords', 'Your Password: Hunter2xyz!'],
    ['otp_codes', 'Your verification code is 482913. It expires soon.'],
    ['reset_verification_links', 'Click here: https://accounts.shop.test/reset/password?x=1 to continue.'],
    ['api_keys_tokens', `aws id ${AWS_KEY} in the console`],
  ])('counts a %s hit', async (category, text) => {
    const hits = await detectLocked(text);
    expect(hits).toEqual([{ category, count: 1 }]);
  });

  it('counts each locked category in one text and omits zero counts', async () => {
    const text = [
      'Password: Hunter2xyz!',
      'Your verification code is 482913.',
      'Open https://accounts.shop.test/reset/password?x=1 please',
      `key ${AWS_KEY}`,
    ].join('\n');
    const hits = await detectLocked(text);
    expect(hits.map((h) => h.category).sort()).toEqual(
      ['api_keys_tokens', 'otp_codes', 'passwords', 'reset_verification_links'],
    );
    for (const h of hits) expect(h.count).toBeGreaterThanOrEqual(1);
  });

  it('counts multiple separate hits of one category', async () => {
    const hits = await detectLocked('Password: Hunter2xyz!\n\nlater\n\nPassword: Zielony#Kot77');
    expect(hits).toEqual([{ category: 'passwords', count: 2 }]);
  });

  it('returns [] for benign text', async () => {
    expect(await detectLocked('Lunch at noon on Friday? I will bring the slides.')).toEqual([]);
  });

  it('does not report non-locked categories such as card numbers', async () => {
    expect(await detectLocked('Pay with card 4111 1111 1111 1111 today.')).toEqual([]);
  });

  it('accepts a partial detector context', async () => {
    expect(await detectLocked('Password: Hunter2xyz!', { defaultRegion: 'PL' })).toEqual([
      { category: 'passwords', count: 1 },
    ]);
  });
});
