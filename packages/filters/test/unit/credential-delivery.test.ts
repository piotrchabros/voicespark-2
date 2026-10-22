import { describe, expect, it } from 'vitest';
import {
  BORDERLINE_THRESHOLD,
  CREDENTIAL_DELIVERY_WEIGHTS,
  WHOLE_ITEM_THRESHOLD,
  scoreCredentialDelivery,
} from '../../src/credential-delivery';

describe('credential delivery scoring constants', () => {
  it('uses the contract weights', () => {
    expect(CREDENTIAL_DELIVERY_WEIGHTS).toEqual({ subject: 2, body: 1, otpToken: 1, resetLink: 1, noReplySender: 1 });
  });

  it('uses the contract thresholds', () => {
    expect(WHOLE_ITEM_THRESHOLD).toBe(3);
    expect(BORDERLINE_THRESHOLD).toBe(2);
  });
});

describe('scoreCredentialDelivery', () => {
  it('scores a verification-code email with all signals at or above the threshold', () => {
    const r = scoreCredentialDelivery({
      subject: 'Your verification code',
      bodyText: 'Your verification code is 482913. Do not share it.',
      from: 'Acme Security <no-reply@acme.test>',
    });
    expect(r.signals).toEqual({ subject: true, body: true, otpToken: true, resetLink: false, noReplySender: true });
    expect(r.score).toBeGreaterThanOrEqual(WHOLE_ITEM_THRESHOLD);
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('otp_codes');
  });

  it('scores a password-reset email under reset_verification_links', () => {
    const r = scoreCredentialDelivery({
      subject: 'Reset your password',
      bodyText: 'Click https://app.service.test/reset/password?token=aB3dE9fG7hJ2kL5mN8pQ to choose a new one.',
      from: 'noreply@service.test',
    });
    expect(r.signals.subject).toBe(true);
    expect(r.signals.resetLink).toBe(true);
    expect(r.signals.noReplySender).toBe(true);
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('reset_verification_links');
  });

  it('scores a temporary-password email under passwords', () => {
    const r = scoreCredentialDelivery({
      subject: 'Your temporary password',
      bodyText: 'Your temporary password has been created for your account.',
      from: 'no-reply@service.test',
    });
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('passwords');
  });

  it('recognises a Polish subject lexicon entry', () => {
    const r = scoreCredentialDelivery({
      subject: 'Kod weryfikacyjny',
      bodyText: 'Twój kod weryfikacyjny to 530962.',
      from: 'no-reply@bank.test',
    });
    expect(r.signals.subject).toBe(true);
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('otp_codes');
  });

  it('weighs a subject match 2 and a no-reply sender 1 for a borderline score of 2', () => {
    const r = scoreCredentialDelivery({
      subject: 'Reset your password',
      bodyText: 'Hello, see you at lunch.',
      from: 'Alice <alice@friend.test>',
    });
    expect(r.signals).toEqual({ subject: true, body: false, otpToken: false, resetLink: false, noReplySender: false });
    expect(r.score).toBe(2);
    expect(r.excluded).toBe(true);
  });

  it('excludes at the borderline score even below the whole-item threshold', () => {
    const r = scoreCredentialDelivery({
      subject: 'Reset your password',
      bodyText: 'Nothing else here.',
    });
    expect(r.score).toBe(CREDENTIAL_DELIVERY_WEIGHTS.subject);
    expect(r.score).toBeLessThan(WHOLE_ITEM_THRESHOLD);
    expect(r.excluded).toBe(true);
  });

  it('does not exclude at score 1 and reports a null category', () => {
    const r = scoreCredentialDelivery({
      subject: 'Weekly newsletter',
      bodyText: 'Here are this week\'s highlights from the team.',
      from: 'no-reply@news.test',
    });
    expect(r.signals.noReplySender).toBe(true);
    expect(r.score).toBe(1);
    expect(r.excluded).toBe(false);
    expect(r.category).toBeNull();
  });

  it('scores 0 for an ordinary personal email', () => {
    const r = scoreCredentialDelivery({
      subject: 'Lunch on Friday?',
      bodyText: 'Are you free for lunch on Friday? Let me know.',
      from: 'Bob <bob@friend.test>',
    });
    expect(r.score).toBe(0);
    expect(r.excluded).toBe(false);
    expect(r.category).toBeNull();
  });

  it('reports the dominant category when one signal clearly outweighs the others', () => {
    const otp = scoreCredentialDelivery({
      subject: 'Your verification code',
      bodyText: 'Open https://app.service.test/verify/email/abc to continue.',
    });
    expect(otp.category).toBe('otp_codes');

    const password = scoreCredentialDelivery({
      subject: 'Your temporary password',
      bodyText: 'Open https://app.service.test/reset/abc to continue.',
    });
    expect(password.category).toBe('passwords');
  });

  it('breaks a tie in favour of reset_verification_links over passwords', () => {
    // body password lexicon (1, passwords) vs reset link (1, reset_verification_links)
    const r = scoreCredentialDelivery({
      bodyText: 'We set a temporary password for you. Open https://app.service.test/reset/abc to continue.',
    });
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('reset_verification_links');
  });
});
