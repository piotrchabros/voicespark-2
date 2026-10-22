import { describe, expect, it } from 'vitest';
import { DETECTOR_CHECKSUM, detect } from '../../src/detectors/reset-links';
import { covers, ctx } from './helpers';

describe('reset-links detector', () => {
  it('exports a checksum label', () => {
    expect(DETECTOR_CHECKSUM).toMatch(/^reset/);
  });

  it.each([
    'https://accounts.shop.test/reset/password?x=1',
    'https://accounts.shop.test/recover/account',
    'https://app.service.test/verify/email',
    'https://app.service.test/confirm/address',
    'https://app.service.test/magic/link',
    'https://app.service.test/activate/account',
  ])('redacts a URL with a sensitive path: %s', async (url) => {
    const text = `Click here: ${url} to continue.`;
    const spans = await detect(text, ctx());
    expect(covers(text, spans, url)).toBe(true);
    expect(covers(text, spans, 'Click here')).toBe(false);
  });

  it('redacts a URL with a high-entropy token query parameter', async () => {
    const url = 'https://app.service.test/go?token=aB3dE9fG7hJ2kL5mN8pQ';
    const text = `Open ${url} now`;
    const spans = await detect(text, ctx());
    expect(covers(text, spans, url)).toBe(true);
  });

  it('returns spans in the reset_verification_links category', async () => {
    const spans = await detect('See https://app.service.test/reset/abc', ctx());
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(s.category).toBe('reset_verification_links');
  });

  it('does not flag a benign URL', async () => {
    expect(await detect('Read more at https://www.voicespark.test/blog/new-features', ctx())).toEqual([]);
  });

  it('does not flag a low-entropy query value', async () => {
    expect(await detect('See https://shop.test/list?key=aaaaaaaaaaaaaaaaaaaa', ctx())).toEqual([]);
  });

  it('does not flag a non-sensitive query string', async () => {
    expect(await detect('Visit https://shop.test/search?q=shoes&page=2 today', ctx())).toEqual([]);
  });
});
