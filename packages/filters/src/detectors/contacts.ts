import { findPhoneNumbersInText, type CountryCode } from 'libphonenumber-js/max';
import type { Detector, Span } from '../categories';

export const DETECTOR_CHECKSUM = 'contacts@1';

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

/**
 * Third-party email addresses and phone numbers. Postal addresses are left to the classifier.
 * v1 keeps no list of the user's own numbers, so every phone number is third-party.
 * Full ("max") metadata is used so that dates and version numbers are not taken for phones.
 */
export const detect: Detector = async (text, ctx) => {
  const own = new Set(ctx.ownAddresses.map((a) => a.toLowerCase()));
  const spans: Span[] = [];

  for (const m of text.matchAll(EMAIL)) {
    if (own.has(m[0].toLowerCase())) continue;
    spans.push({ start: m.index, end: m.index + m[0].length, category: 'third_party_contacts' });
  }

  const region = (ctx.defaultRegion ?? 'PL') as CountryCode;
  for (const p of findPhoneNumbersInText(text, region)) {
    spans.push({ start: p.startsAt, end: p.endsAt, category: 'third_party_contacts' });
  }

  return spans.sort((a, b) => a.start - b.start);
};
