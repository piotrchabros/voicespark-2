import type { Detector, Span } from '../categories';
import { abaValid, ibanValid, nrbValid } from './checksums';

export const DETECTOR_CHECKSUM = 'bank-accounts@1';

/** IBAN candidate: country, check digits, then 11-30 alphanumerics with optional single spaces. */
const IBAN_CANDIDATE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}(?![A-Za-z0-9])/g;

/** Polish NRB: 26 digits, optionally spaced, optionally prefixed with PL. */
const NRB_CANDIDATE = /(?<![A-Za-z0-9])(?:PL ?)?\d{2}(?: ?\d){24}(?!\d)/g;

const SORT_CODE = /\bsort[ -]?code\b[^\d\n]{0,20}(\d{2}[- ]?\d{2}[- ]?\d{2})(?![\d-])/gi;
const ROUTING_NUMBER =
  /\b(?:routing|ABA|RTN|transit)(?:\s*(?:number|no\.?|#))?[^\d\n]{0,20}(\d{9})(?!\d)/gi;
// Account keywords in EN, DE, FR, ES and PL ("Kontonummer", "Numéro de compte", "Numer konta", ...).
const ACCOUNT_NUMBER =
  /(?<![\p{L}\p{N}])(?:account|acct|a\/c|konto(?:nummer|nr)?|compte|cuenta|rachunek|rachunku|konta)(?:\s*(?:number|no\.?|#|nummer|nr\.?|numéro|número|numer))?[^\d\n]{0,20}(\d{4,17})(?!\d)/giu;

/** An account number counts only within this many characters of a sort code or routing number. */
const ACCOUNT_PROXIMITY = 120;

function groupSpan(m: RegExpExecArray | RegExpMatchArray, group: number): Span {
  const value = m[group]!;
  const start = m.index! + m[0].lastIndexOf(value);
  return { start, end: start + value.length, category: 'bank_accounts' };
}

/** ISO 13616 registry: IBAN length per country code. Other two-letter prefixes are not IBANs. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BL: 27, BR: 29,
  BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24,
  FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GF: 27, GI: 23, GL: 18, GP: 27, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MF: 27, MK: 19, MN: 20, MQ: 27,
  MR: 27, MT: 31, MU: 30, NC: 27, NI: 28, NL: 18, NO: 15, OM: 23, PF: 27, PK: 24, PL: 28, PM: 27,
  PS: 29, PT: 25, QA: 29, RE: 27, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19,
  SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TF: 27, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24,
  WF: 27, XK: 20, YE: 30, YT: 27,
};

/** The candidate's prefix of exactly the registered length for its country, if it is a valid IBAN. */
function registeredIban(candidate: string): string | null {
  const length = IBAN_LENGTHS[candidate.slice(0, 2)];
  if (length === undefined) return null;
  let count = 0;
  let end = 0;
  while (end < candidate.length && count < length) {
    if (candidate[end] !== ' ') count++;
    end++;
  }
  if (count < length) return null;
  const next = candidate[end];
  if (next !== undefined && next !== ' ') return null;
  const slice = candidate.slice(0, end);
  return ibanValid(slice) ? slice : null;
}

export const detect: Detector = async (text) => {
  const spans: Span[] = [];

  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    const iban = registeredIban(m[0]);
    if (iban) spans.push({ start: m.index, end: m.index + iban.length, category: 'bank_accounts' });
  }

  for (const m of text.matchAll(NRB_CANDIDATE)) {
    const digits = m[0].replace(/^PL ?/, '');
    if (nrbValid(digits)) {
      spans.push({ start: m.index, end: m.index + m[0].length, category: 'bank_accounts' });
    }
  }

  const anchors: Span[] = [];
  for (const m of text.matchAll(SORT_CODE)) anchors.push(groupSpan(m, 1));
  for (const m of text.matchAll(ROUTING_NUMBER)) {
    if (abaValid(m[1]!)) anchors.push(groupSpan(m, 1));
  }
  spans.push(...anchors);

  if (anchors.length > 0) {
    for (const m of text.matchAll(ACCOUNT_NUMBER)) {
      const span = groupSpan(m, 1);
      const near = anchors.some(
        (a) => Math.abs(a.start - span.start) <= ACCOUNT_PROXIMITY && a.start !== span.start,
      );
      if (near) spans.push(span);
    }
  }

  return dedupe(spans);
};

function dedupe(spans: Span[]): Span[] {
  const seen = new Set<string>();
  return spans
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((s) => {
      const key = `${s.start}:${s.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
