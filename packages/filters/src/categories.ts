export type FilterCategory =
  | 'passwords'
  | 'otp_codes'
  | 'reset_verification_links'
  | 'api_keys_tokens'
  | 'payment_cards'
  | 'bank_accounts'
  | 'government_ids'
  | 'health'
  | 'special_category'
  | 'third_party_contacts';

export type LockedCategory = 'passwords' | 'otp_codes' | 'reset_verification_links' | 'api_keys_tokens';
export type ClassifierCategory = 'health' | 'special_category' | 'third_party_contacts';
export type ExclusionSummaryKey = 'user_rule' | 'inspection_failed';
export type CountCategory = FilterCategory | ExclusionSummaryKey;
export type ContentKind = 'email' | 'attachment' | 'file' | 'note';

export interface FilterCategoryDef {
  key: FilterCategory;
  label: string;
  description: string;
  locked: boolean;
  defaultSelected: boolean;
  handling: 'span' | 'span_or_whole' | 'classifier_span_or_whole';
}

/** Catalog order matches the table in contracts/filter-categories.md. */
export const FILTER_CATEGORIES: readonly FilterCategoryDef[] = [
  {
    key: 'passwords',
    label: 'Passwords and passphrases',
    description:
      'Keyword-anchored passwords, "your temporary password" patterns and user:pass@ URLs. Whole message excluded if it is credential delivery.',
    locked: true,
    defaultSelected: true,
    handling: 'span_or_whole',
  },
  {
    key: 'otp_codes',
    label: 'One-time and verification codes',
    description: 'Digit or alphanumeric codes near a verification lexicon, and TOTP backup-code lists.',
    locked: true,
    defaultSelected: true,
    handling: 'span_or_whole',
  },
  {
    key: 'reset_verification_links',
    label: 'Password-reset and verification links',
    description: 'URLs whose path or high-entropy query parameter marks a reset, verification or sign-in link.',
    locked: true,
    defaultSelected: true,
    handling: 'span_or_whole',
  },
  {
    key: 'api_keys_tokens',
    label: 'API keys and access tokens',
    description: 'Provider keys, private keys, JWTs, Bearer tokens and generic high-entropy key assignments.',
    locked: true,
    defaultSelected: true,
    handling: 'span',
  },
  {
    key: 'payment_cards',
    label: 'Payment card numbers',
    description: '13-19 digit Luhn-valid card numbers with a known issuer prefix.',
    locked: false,
    defaultSelected: true,
    handling: 'span',
  },
  {
    key: 'bank_accounts',
    label: 'Bank account numbers',
    description: 'IBAN, Polish NRB, UK sort code with account and US ABA with account numbers.',
    locked: false,
    defaultSelected: true,
    handling: 'span',
  },
  {
    key: 'government_ids',
    label: 'Government ID numbers',
    description: 'SSN, NINO, PESEL, Polish ID and passport, German Steuer-ID and other anchored ID patterns.',
    locked: false,
    defaultSelected: true,
    handling: 'span',
  },
  {
    key: 'health',
    label: 'Health information',
    description: 'Medical conditions, treatments and other health details, detected by the classifier.',
    locked: false,
    defaultSelected: true,
    handling: 'classifier_span_or_whole',
  },
  {
    key: 'special_category',
    label:
      'Other special-category data (religion, political views, sexual orientation, ethnicity, trade-union membership, biometrics/genetics)',
    description: 'Special-category personal data other than health, detected by the classifier.',
    locked: false,
    defaultSelected: true,
    handling: 'classifier_span_or_whole',
  },
  {
    key: 'third_party_contacts',
    label: "Other people's contact details (phone numbers, postal addresses, email addresses)",
    description: 'Phone numbers, postal addresses and email addresses of people other than you.',
    locked: false,
    defaultSelected: true,
    handling: 'span',
  },
];

export const FILTER_CATEGORY_KEYS: readonly FilterCategory[] = FILTER_CATEGORIES.map((c) => c.key);

export const LOCKED_CATEGORIES: readonly LockedCategory[] = [
  'passwords',
  'otp_codes',
  'reset_verification_links',
  'api_keys_tokens',
];

export const CLASSIFIER_CATEGORIES: readonly ClassifierCategory[] = ['health', 'special_category', 'third_party_contacts'];

export const EXCLUSION_SUMMARY_KEYS: Readonly<Record<ExclusionSummaryKey, string>> = {
  user_rule: 'Matched your exclusion rules',
  inspection_failed: 'Could not be checked (not stored)',
};

export function isLocked(c: string): c is LockedCategory {
  return (LOCKED_CATEGORIES as readonly string[]).includes(c);
}

export function labelFor(c: CountCategory): string {
  if (c === 'user_rule' || c === 'inspection_failed') return EXCLUSION_SUMMARY_KEYS[c];
  const def = FILTER_CATEGORIES.find((d) => d.key === c);
  return def ? def.label : c;
}

export function redactionToken(label: string): string {
  return `[excluded: ${label}]`;
}

export interface ExclusionRule {
  id?: string;
  type: 'sender' | 'domain' | 'folder_label' | 'keyword';
  value: string;
}

export interface InspectionInput {
  kind: ContentKind;
  subject?: string;
  title?: string;
  filename?: string;
  bodyText: string;
  headers: { from?: string; to?: string; cc?: string };
  folders: string[];
  ownAddresses: string[];
}

export interface Policy {
  selectedCategories: readonly string[];
  rules: readonly ExclusionRule[];
}

export type FilteredText = string & { readonly __brand: 'FilteredText' };

/**
 * Text kept by the hub-mode inspection (emails and phones left in). Not assignable to `FilteredText`, so no
 * memory-store or other `FilteredText` sink accepts it; only the hub extraction prompt builder does.
 */
export type HubLlmText = string & { readonly __brand: 'HubLlmText' };

/**
 * A validated email, phone or domain (`validateContactValue`). Allowed only in the hub contact columns and,
 * when the policy allows, in hub memory documents.
 */
export type ContactValue = string & { readonly __brand: 'ContactValue' };

/** `hub_extraction` skips the deterministic contacts detector and keeps the From address (FR-028). */
export type ContactMode = 'normal' | 'hub_extraction';

export interface CategoryCount {
  category: CountCategory;
  redactedValues: number;
  wholeItem: boolean;
}

export interface InspectionResult {
  outcome: 'accepted' | 'excluded';
  text?: FilteredText;
  fields?: {
    subject?: FilteredText;
    fromName?: FilteredText;
    fromAddress?: FilteredText;
    title?: FilteredText;
    filename?: FilteredText;
  };
  counts: CategoryCount[];
  languageHint?: string;
}

export interface DocumentHeader {
  kind: ContentKind;
  date: string;
  direction?: 'sent' | 'received';
  subject?: FilteredText;
  fromName?: FilteredText;
  fromAddress?: FilteredText;
  title?: FilteredText;
  filename?: FilteredText;
}

/** `end` is exclusive and the span covers the VALUE only. */
export interface Span {
  start: number;
  end: number;
  category: FilterCategory;
}

/** `defaultRegion` defaults to 'PL'. */
export interface DetectorContext {
  ownAddresses: readonly string[];
  defaultRegion?: string;
}

export type Detector = (text: string, ctx: DetectorContext) => Promise<Span[]>;
