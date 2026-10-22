import { describe, expect, it } from 'vitest';
import { DETECTOR_CHECKSUM, detect } from '../../src/detectors/passwords';
import { covers, coveredText, ctx } from './helpers';

describe('passwords detector', () => {
  it('exports a checksum label', () => {
    expect(DETECTOR_CHECKSUM).toMatch(/^passwords@/);
  });

  it.each([
    ['Password', 'Password: Hunter2xyz!', 'Hunter2xyz!'],
    ['pwd', 'pwd=Tr0ub4dor&3', 'Tr0ub4dor&3'],
    ['passphrase', 'My passphrase is correcthorsebattery', 'correcthorsebattery'],
    ['hasło', 'Twoje hasło: Zielony#Kot77', 'Zielony#Kot77'],
    ['Passwort', 'Passwort: Sommer2024!x', 'Sommer2024!x'],
    ['mot de passe', 'Votre mot de passe : Bleu!Ciel42', 'Bleu!Ciel42'],
    ['contraseña', 'contraseña: Luna#Roja19', 'Luna#Roja19'],
  ])('redacts the value after the %s anchor and not the anchor', async (_name, text, value) => {
    const spans = await detect(text, ctx());
    expect(covers(text, spans, value)).toBe(true);
    const anchor = text.slice(0, text.indexOf(value));
    const anchorWord = anchor
      .trim()
      .split(/\s+/)
      .filter((t) => !/^[:=]+$/.test(t))
      .pop()!
      .replace(/[:=]$/, '');
    expect(coveredText(text, spans).join(' ')).not.toContain(anchorWord);
  });

  it('redacts a temporary password announcement', async () => {
    const text = 'Your temporary password is Xk93-Lm20-Qz!';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, 'Xk93-Lm20-Qz!')).toBe(true);
    expect(covers(text, spans, 'temporary')).toBe(false);
  });

  it('redacts the password in a user:pass@ URL', async () => {
    const text = 'Clone from https://deploy:S3cretPw99@git.internal.test/repo.git today';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, 'S3cretPw99')).toBe(true);
    expect(covers(text, spans, 'git.internal.test')).toBe(false);
  });

  it('returns spans in the passwords category', async () => {
    const spans = await detect('password: Hunter2xyz!', ctx());
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(s.category).toBe('passwords');
  });

  it('returns nothing for benign prose', async () => {
    expect(await detect('Please remember to bring your laptop to the meeting on Friday.', ctx())).toEqual([]);
    expect(await detect('Visit https://www.voicespark.test/pricing for plans.', ctx())).toEqual([]);
  });
});
