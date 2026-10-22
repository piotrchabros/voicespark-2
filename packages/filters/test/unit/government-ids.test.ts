import { describe, expect, it } from 'vitest';
import { DETECTOR_CHECKSUM, detect } from '../../src/detectors/government-ids';
import { ninoValid, peselValid, ssnValid, steuerIdValid } from '../../src/detectors/checksums';
import { covers, ctx } from './helpers';

describe('ssnValid', () => {
  it('accepts structurally valid SSNs', () => {
    expect(ssnValid('078-05-1120')).toBe(true);
    expect(ssnValid('078051120')).toBe(true);
    expect(ssnValid('123 45 6789')).toBe(true);
  });

  it('rejects invalid area, group or serial', () => {
    expect(ssnValid('000-12-3456')).toBe(false);
    expect(ssnValid('666-12-3456')).toBe(false);
    expect(ssnValid('900-12-3456')).toBe(false);
    expect(ssnValid('123-00-4567')).toBe(false);
    expect(ssnValid('123-45-0000')).toBe(false);
  });
});

describe('ninoValid', () => {
  it('accepts valid NINOs, with or without spaces', () => {
    expect(ninoValid('AB123456C')).toBe(true);
    expect(ninoValid('AB 12 34 56 C')).toBe(true);
  });

  it('rejects disallowed prefixes and suffixes', () => {
    expect(ninoValid('BG123456C')).toBe(false);
    expect(ninoValid('QQ123456C')).toBe(false);
    expect(ninoValid('AB123456E')).toBe(false);
  });
});

describe('peselValid', () => {
  it('accepts a valid PESEL', () => {
    expect(peselValid('44051401359')).toBe(true);
  });

  it('rejects a bad checksum or wrong length', () => {
    expect(peselValid('44051401358')).toBe(false);
    expect(peselValid('4405140135')).toBe(false);
  });
});

describe('steuerIdValid', () => {
  it('accepts a valid Steuer-ID', () => {
    expect(steuerIdValid('65929970489')).toBe(true);
    expect(steuerIdValid('65 929 970 489')).toBe(true);
  });

  it('rejects a bad checksum, wrong length or leading zero', () => {
    expect(steuerIdValid('65929970488')).toBe(false);
    expect(steuerIdValid('6592997048')).toBe(false);
    expect(steuerIdValid('05929970489')).toBe(false);
  });
});

describe('government-ids detector', () => {
  it('exports a checksum label', () => {
    expect(DETECTOR_CHECKSUM).toMatch(/^government-ids@/);
  });

  it('redacts a PESEL', async () => {
    const text = 'Mój numer PESEL to 44051401359, proszę o potwierdzenie.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, '44051401359')).toBe(true);
    expect(spans.every((s) => s.category === 'government_ids')).toBe(true);
  });

  it('redacts a US SSN', async () => {
    const text = 'My SSN is 078-05-1120, please keep it safe.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, '078-05-1120')).toBe(true);
  });

  it('redacts a UK NINO', async () => {
    const text = 'National Insurance number: AB 12 34 56 C.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, 'AB 12 34 56 C')).toBe(true);
  });

  it('redacts a German Steuer-ID', async () => {
    const text = 'Meine Steuer-ID lautet 65 929 970 489.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, '65 929 970 489')).toBe(true);
  });

  it('redacts a Polish ID card and passport number near a keyword', async () => {
    const text = 'Dowód osobisty ABC123456, paszport EA1234567.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, 'ABC123456')).toBe(true);
    expect(covers(text, spans, 'EA1234567')).toBe(true);
  });

  it('redacts a generic anchored ID number', async () => {
    const text = 'Passport number: X1234567 was scanned.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, 'X1234567')).toBe(true);
  });

  it('does not redact checksum-invalid or unanchored numbers', async () => {
    expect(await detect('PESEL 44051401358 and ticket 123-45-0000.', ctx())).toEqual([]);
    expect(await detect('Order ABC123456 shipped on 2024-05-14.', ctx())).toEqual([]);
  });
});
