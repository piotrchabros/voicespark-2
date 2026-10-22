import {
  LOCKED_CATEGORIES,
  type Detector,
  type DetectorContext,
  type FilterCategory,
  type LockedCategory,
  type Span,
} from '../categories';
import { mergeSpans } from '../redact';
import * as apiKeys from './api-keys';
import * as bankAccounts from './bank-accounts';
import * as contacts from './contacts';
import * as governmentIds from './government-ids';
import * as otpCodes from './otp-codes';
import * as passwords from './passwords';
import * as paymentCards from './payment-cards';
import * as resetLinks from './reset-links';

interface DetectorModule {
  detect: Detector;
  DETECTOR_CHECKSUM: string;
}

/**
 * Deterministic detector per filter category. `health` and `special_category` are
 * classifier-only; `third_party_contacts` covers emails and phones (postal addresses
 * come from the classifier).
 */
const MODULES: Readonly<Partial<Record<FilterCategory, DetectorModule>>> = {
  passwords,
  otp_codes: otpCodes,
  reset_verification_links: resetLinks,
  api_keys_tokens: apiKeys,
  payment_cards: paymentCards,
  bank_accounts: bankAccounts,
  government_ids: governmentIds,
  third_party_contacts: contacts,
};

export const DETECTORS: Readonly<Partial<Record<FilterCategory, Detector>>> = Object.fromEntries(
  Object.entries(MODULES).map(([category, mod]) => [category, mod.detect]),
);

export const LOCKED_DETECTORS: Readonly<Record<LockedCategory, Detector>> = {
  passwords: passwords.detect,
  otp_codes: otpCodes.detect,
  reset_verification_links: resetLinks.detect,
  api_keys_tokens: apiKeys.detect,
};

/** Version label of every detector, keyed by category. */
export const DETECTOR_CHECKSUMS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MODULES).map(([category, mod]) => [category, mod.DETECTOR_CHECKSUM]),
);

/** Runs the detectors of the given categories (those without one are skipped) and concatenates their spans. */
export async function detectAll(
  text: string,
  categories: readonly FilterCategory[],
  ctx: DetectorContext,
): Promise<Span[]> {
  const unique = [...new Set(categories)];
  const results = await Promise.all(
    unique.map((category) => DETECTORS[category]?.(text, ctx) ?? Promise.resolve([])),
  );
  return results.flat();
}

/**
 * Counts locked-category hits (credentials) in `text` with the existing LOCKED_DETECTORS; no new detector. One
 * count per merged span of a category; categories without hits are omitted. Returns counts only, never values.
 */
export async function detectLocked(
  text: string,
  ctx: Partial<DetectorContext> = {},
): Promise<{ category: LockedCategory; count: number }[]> {
  const full: DetectorContext = { ownAddresses: [], ...ctx };
  const out: { category: LockedCategory; count: number }[] = [];
  for (const category of LOCKED_CATEGORIES) {
    const count = mergeSpans(await LOCKED_DETECTORS[category](text, full)).length;
    if (count > 0) out.push({ category, count });
  }
  return out;
}
