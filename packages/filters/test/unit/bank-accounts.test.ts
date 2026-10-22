import { describe, expect, it } from 'vitest';
import { DETECTOR_CHECKSUM, detect } from '../../src/detectors/bank-accounts';
import { abaValid, ibanValid, nrbValid } from '../../src/detectors/checksums';
import { covers, ctx } from './helpers';

describe('ibanValid', () => {
  it('accepts valid IBANs of several countries, with or without spaces', () => {
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('PL61 1090 1014 0000 0712 1981 2874')).toBe(true);
    expect(ibanValid('FR1420041010050500013M02606')).toBe(true);
  });

  it('rejects a failed mod-97', () => {
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
    expect(ibanValid('DE89370400440532013001')).toBe(false);
  });
});

describe('nrbValid', () => {
  it('accepts a valid 26-digit Polish NRB', () => {
    expect(nrbValid('61109010140000071219812874')).toBe(true);
    expect(nrbValid('61 1090 1014 0000 0712 1981 2874')).toBe(true);
  });

  it('rejects a bad checksum or wrong length', () => {
    expect(nrbValid('62109010140000071219812874')).toBe(false);
    expect(nrbValid('6110901014000007121981287')).toBe(false);
  });
});

describe('abaValid', () => {
  it('accepts valid ABA routing numbers', () => {
    expect(abaValid('021000021')).toBe(true);
    expect(abaValid('111000025')).toBe(true);
  });

  it('rejects a bad checksum or wrong length', () => {
    expect(abaValid('021000022')).toBe(false);
    expect(abaValid('02100002')).toBe(false);
  });
});

describe('bank-accounts detector', () => {
  it('exports a checksum label', () => {
    expect(DETECTOR_CHECKSUM).toMatch(/^bank-accounts@/);
  });

  it('redacts an IBAN with spaces', async () => {
    const text = 'Please wire the money to DE89 3704 0044 0532 0130 00 by Friday.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, 'DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(spans.every((s) => s.category === 'bank_accounts')).toBe(true);
  });

  it('redacts a Polish NRB, with and without the PL prefix', async () => {
    const text = 'Numer konta: 61 1090 1014 0000 0712 1981 2874, dziękuję.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, '61 1090 1014 0000 0712 1981 2874')).toBe(true);

    const text2 = 'Konto PL61109010140000071219812874 jest aktywne.';
    expect(covers(text2, await detect(text2, ctx()), 'PL61109010140000071219812874')).toBe(true);
  });

  it('redacts a UK sort code and account number near a keyword', async () => {
    const text = 'Bank details: sort code 12-34-56, account number 12345678.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, '12-34-56')).toBe(true);
    expect(covers(text, spans, '12345678')).toBe(true);
  });

  it('redacts a US ABA routing number and account near a keyword', async () => {
    const text = 'ACH: routing number 021000021, account number 123456789012.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, '021000021')).toBe(true);
    expect(covers(text, spans, '123456789012')).toBe(true);
  });

  it('does not redact an IBAN-shaped string with a bad checksum', async () => {
    expect(await detect('Ref DE89 3704 0044 0532 0130 01 pending.', ctx())).toEqual([]);
  });

  it('does not redact an 8-digit number or ABA-shaped number without a keyword', async () => {
    expect(await detect('Order 12345678 and ticket 021000021 were closed.', ctx())).toEqual([]);
  });
});
