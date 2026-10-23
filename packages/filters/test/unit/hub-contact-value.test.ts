import { describe, expect, it } from 'vitest';
import { validateContactValue } from '../../src/hub';

describe('validateContactValue: accepts', () => {
  it('email: strict parse, lower-cased', () => {
    expect(validateContactValue('email', 'Jan.Kowalski@Acme.Example')).toBe('jan.kowalski@acme.example');
    expect(validateContactValue('email', 'o.brien+crm@mail.acme.example')).toBe('o.brien+crm@mail.acme.example');
  });

  it('phone: valid numbers kept as written', () => {
    expect(validateContactValue('phone', '+48 601 234 567')).toBe('+48 601 234 567');
    expect(validateContactValue('phone', '601 234 567')).toBe('601 234 567');
    expect(validateContactValue('phone', '+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(validateContactValue('phone', '+1 (202) 555-0143')).toBe('+1 (202) 555-0143');
  });

  it('domain: lower-cased', () => {
    expect(validateContactValue('domain', 'Acme.Example')).toBe('acme.example');
    expect(validateContactValue('domain', 'mail.fjord-works.example')).toBe('mail.fjord-works.example');
  });
});

describe('validateContactValue: format limits', () => {
  it('rejects malformed emails and over-long values', () => {
    expect(validateContactValue('email', 'not-an-email')).toBeNull();
    expect(validateContactValue('email', 'jan@')).toBeNull();
    expect(validateContactValue('email', `${'a'.repeat(310)}@acme.example`)).toBeNull();
  });

  it('rejects invalid phones, bad characters and over-long values', () => {
    expect(validateContactValue('phone', '12')).toBeNull();
    expect(validateContactValue('phone', '+48 601 234 567 abc')).toBeNull();
    expect(validateContactValue('phone', `+48 ${'6'.repeat(60)}`)).toBeNull();
  });

  it('rejects domains with www., a scheme, a path or a bad shape', () => {
    expect(validateContactValue('domain', 'www.acme.example')).toBeNull();
    expect(validateContactValue('domain', 'https://acme.example')).toBeNull();
    expect(validateContactValue('domain', 'acme.example/path')).toBeNull();
    expect(validateContactValue('domain', 'localhost')).toBeNull();
    expect(validateContactValue('domain', `${'a'.repeat(64)}.example`)).toBeNull();
  });
});

describe('validateContactValue: rejects secrets and ids', () => {
  it('rejects an email carrying a password', () => {
    expect(validateContactValue('email', 'jan@acme.com password: x')).toBeNull();
    expect(validateContactValue('email', 'login: jan@acme.example / password: Xk9mQ2vLp7')).toBeNull();
  });

  it('rejects a token in a phone field', () => {
    expect(validateContactValue('phone', 'ghp_8hJuQoN86WVSTAZKtlDIlSNJuELijmlyWdyU')).toBeNull();
    expect(validateContactValue('phone', '+48 601 234 567 token: ghp_8hJuQoN86WVSTAZKtlDIlSNJuELijmlyWdyU')).toBeNull();
  });

  it('rejects an IBAN and a card number in a phone field', () => {
    expect(validateContactValue('phone', 'DE57771707652489594255')).toBeNull();
    expect(validateContactValue('phone', '4195 4147 2233 9041')).toBeNull();
  });

  it('rejects a reset URL as a domain', () => {
    expect(
      validateContactValue('domain', 'https://accounts.acme.example/reset-password?token=GGXXvg2SRXJUCkKIUDrEZ00BDS4kpD4O'),
    ).toBeNull();
  });

  it('rejects a government id in an email or phone field', () => {
    expect(validateContactValue('phone', 'PESEL: 77081952528')).toBeNull();
    expect(validateContactValue('email', 'jan@acme.example PESEL 77081952528')).toBeNull();
  });
});
