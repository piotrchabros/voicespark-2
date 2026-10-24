import type { Detector, Span } from '../categories';
import { luhnValid } from './checksums';

export const DETECTOR_CHECKSUM = 'payment-cards@1';

/**
 * 13-19 digits, optionally grouped with single spaces or dashes. A run that follows a letter or
 * another digit group, or continues into a further 4-digit group, is part of an IBAN or NRB,
 * not a card (an expiry "12/26" or a 3-digit CVV after the number still passes).
 */
const CANDIDATE = /(?<![\p{L}\d-])(?<!\d )\d(?:[ -]?\d){12,18}(?!\d|[ -]\d{4})/gu;

/** Known issuer (IIN) prefix ranges: [prefix length, low, high]. */
const IIN_RANGES: readonly (readonly [number, number, number])[] = [
  [1, 4, 4], // Visa
  [2, 51, 55], // Mastercard
  [4, 2221, 2720], // Mastercard 2-series
  [2, 34, 34], // Amex
  [2, 37, 37], // Amex
  [4, 6011, 6011], // Discover
  [3, 644, 649], // Discover
  [2, 65, 65], // Discover
  [2, 62, 62], // UnionPay
  [3, 300, 305], // Diners Club
  [2, 36, 36], // Diners Club
  [2, 38, 39], // Diners Club
  [4, 3528, 3589], // JCB
  [4, 2200, 2204], // Mir
  [2, 50, 50], // Maestro
  [2, 56, 69], // Maestro
];

function hasKnownIin(digits: string): boolean {
  return IIN_RANGES.some(([len, low, high]) => {
    const prefix = Number(digits.slice(0, len));
    return prefix >= low && prefix <= high;
  });
}

/** Synchronous core of `detect`, for callers that cannot await (contact-value validation). */
export const detectSync = (text: string): Span[] => {
  const spans: Span[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!hasKnownIin(digits) || !luhnValid(digits)) continue;
    spans.push({ start: m.index, end: m.index + m[0].length, category: 'payment_cards' });
  }
  return spans;
};

export const detect: Detector = async (text) => detectSync(text);
