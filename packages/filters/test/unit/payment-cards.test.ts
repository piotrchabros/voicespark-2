import { describe, expect, it } from 'vitest';
import { DETECTOR_CHECKSUM, detect } from '../../src/detectors/payment-cards';
import { luhnValid } from '../../src/detectors/checksums';
import { coveredText, covers, ctx } from './helpers';

describe('luhnValid', () => {
  it('accepts valid numbers, with or without separators', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111 1111 1111 1111')).toBe(true);
    expect(luhnValid('5555-5555-5555-4444')).toBe(true);
    expect(luhnValid('378282246310005')).toBe(true);
  });

  it('rejects numbers with a bad check digit', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('5555 5555 5555 4443')).toBe(false);
  });
});

describe('payment-cards detector', () => {
  it('exports a checksum label', () => {
    expect(DETECTOR_CHECKSUM).toMatch(/^payment-cards@/);
  });

  it.each([
    ['Visa spaced', 'Please charge my card 4111 1111 1111 1111 today.', '4111 1111 1111 1111'],
    ['Mastercard dashed', 'Karta: 5555-5555-5555-4444, ważna do 12/29.', '5555-5555-5555-4444'],
    ['Amex plain', 'Meine Amex ist 378282246310005, bitte belasten.', '378282246310005'],
  ])('redacts %s', async (_name, text, value) => {
    const spans = await detect(text, ctx());
    expect(covers(text, spans, value)).toBe(true);
    expect(spans.every((s) => s.category === 'payment_cards')).toBe(true);
  });

  it('does not redact Luhn-invalid digit runs', async () => {
    expect(await detect('Order 4111 1111 1111 1112 shipped.', ctx())).toEqual([]);
  });

  it('does not redact Luhn-valid numbers without a known IIN prefix', async () => {
    // 0000000000000000 is Luhn-valid but has no card IIN prefix
    expect(await detect('Reference 0000 0000 0000 0000 received.', ctx())).toEqual([]);
  });

  it('does not redact short numbers or ordinary prose', async () => {
    expect(await detect('Invoice 2024-001 for 1500 PLN, call me at noon.', ctx())).toEqual([]);
  });

  it('covers only the card number, not surrounding words', async () => {
    const text = 'card 4111 1111 1111 1111 expires soon';
    const spans = await detect(text, ctx());
    expect(coveredText(text, spans).join(' ')).not.toContain('expires');
  });
});
