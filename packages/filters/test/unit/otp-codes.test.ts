import { describe, expect, it } from 'vitest';
import { DETECTOR_CHECKSUM, detect } from '../../src/detectors/otp-codes';
import { covers, ctx } from './helpers';

describe('otp-codes detector', () => {
  it('exports a checksum label', () => {
    expect(DETECTOR_CHECKSUM).toMatch(/^otp/);
  });

  it.each([
    ['en code', 'Your verification code is 482913. It expires soon.', '482913', 'verification'],
    ['en OTP', 'Use OTP 7391 to confirm the transfer.', '7391', 'OTP'],
    ['en 2FA', 'Your 2FA code: 90417265', '90417265', '2FA'],
    ['pl kod', 'Twój kod weryfikacyjny to 530962, nie udostępniaj go.', '530962', 'kod'],
    ['de code', 'Ihr Bestätigungscode lautet 815027.', '815027', 'Bestätigungscode'],
    ['alphanumeric', 'Your login code: K7P2QX9M', 'K7P2QX9M', 'code'],
  ])('redacts the code (%s) and not the keyword', async (_name, text, value, keyword) => {
    const spans = await detect(text, ctx());
    expect(covers(text, spans, value)).toBe(true);
    expect(covers(text, spans, keyword)).toBe(false);
  });

  it('redacts every code in a TOTP backup-code list', async () => {
    const text = ['Backup codes for 2FA:', '4821-9937', '1204-8856', '7733-0191'].join('\n');
    const spans = await detect(text, ctx());
    for (const code of ['4821-9937', '1204-8856', '7733-0191']) {
      expect(covers(text, spans, code)).toBe(true);
    }
  });

  it('returns spans in the otp_codes category', async () => {
    const spans = await detect('Your verification code is 482913.', ctx());
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(s.category).toBe('otp_codes');
  });

  it('does not flag digits far from any lexicon word', async () => {
    const text = 'The invoice total was 4829 and the meeting is booked for room 12 on the second floor of the building.';
    expect(await detect(text, ctx())).toEqual([]);
  });

  it('returns nothing for benign prose', async () => {
    expect(await detect('Thanks for the update, talk to you tomorrow.', ctx())).toEqual([]);
  });
});
