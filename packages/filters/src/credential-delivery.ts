// Deterministic credential-delivery scoring (stage 2 of the inspection pipeline). Never calls an LLM.
// Weights and thresholds are tuned against the corpus gates; see contracts/filter-categories.md.

export const CREDENTIAL_DELIVERY_WEIGHTS = {
  subject: 2,
  body: 1,
  otpToken: 1,
  resetLink: 1,
  noReplySender: 1,
} as const;

/** Score at or above which the whole item is credential delivery. */
export const WHOLE_ITEM_THRESHOLD = 3;
/** Score at or above which the item is excluded (borderline included). */
export const BORDERLINE_THRESHOLD = 2;

type DeliveryCategory = 'otp_codes' | 'reset_verification_links' | 'passwords';

export type CredentialDeliveryInput = { subject?: string; bodyText: string; from?: string };

export type CredentialDeliveryResult = {
  score: number;
  excluded: boolean;
  category: DeliveryCategory | null;
  signals: {
    subject: boolean;
    body: boolean;
    otpToken: boolean;
    resetLink: boolean;
    noReplySender: boolean;
  };
};

type LexiconEntry = { category: DeliveryCategory; pattern: RegExp };

// Phrases that name a delivered credential (EN, PL, DE, FR, ES). Matched case-insensitively.
const LEXICON: readonly LexiconEntry[] = [
  // one-time / verification codes
  {
    category: 'otp_codes',
    pattern:
      /(verification|security|confirmation|login|one[- ]time|sign[- ]?in) (code|passcode)|kod weryfikacyjny|kod jednorazowy|kod potwierdzaj|kod bezpiecze|bestätigungscode|verifizierungscode|sicherheitscode|einmalcode|code de (vérification|confirmation|sécurité)|code à usage unique|código de (verificación|confirmación|seguridad)|código de un solo uso|\bone[- ]time (password|pin)\b/iu,
  },
  // password reset and address / account verification links
  {
    category: 'reset_verification_links',
    pattern:
      /reset your password|password reset|confirm your e-?mail|verify your e-?mail|verify your account|confirm your account|zresetuj hasło|resetowanie hasła|potwierdź (swój )?adres|zweryfikuj (swój )?adres|passwort (zurück|neu )setzen|passwort zurücksetzen|bestätigen sie ihre e-?mail|e-?mail-adresse bestätigen|réinitialis\w+ (votre|ton) mot de passe|confirmez votre adresse|restablec\w+ (tu|su) contraseña|confirma tu (correo|dirección)/iu,
  },
  // temporary / generated passwords
  {
    category: 'passwords',
    pattern:
      /temporary password|your new password|tymczasowe hasło|temporäres passwort|vorläufiges passwort|mot de passe temporaire|contraseña temporal/iu,
  },
];

const SENDER_PATTERN =
  /(?:^|[<\s"'])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|security|accounts?|verification|verify|auth|authentication)(?:[-_.+][\w.+-]*)?@/iu;

const OTP_KEYWORD =
  /code|otp|kod|código|codigo|pin\b|passcode|2fa|verification|bestätigung|verifizier|vérification|verificación|weryfikac/iu;
const OTP_DIGITS = /(?<![\w.:/-])\d{4,8}(?![\w@]|[.-]\d)/gu;
const OTP_KEYWORD_WINDOW = 60;

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/giu;
const LINK_PATH = /reset|recover|verify|confirm|magic|login|signin|activate|unsubscribe-token/iu;
const LINK_QUERY_KEY = /^(token|code|key|sig|otp|auth|t)$/iu;

function matchLexicon(text: string): DeliveryCategory[] {
  return LEXICON.filter((entry) => entry.pattern.test(text)).map((entry) => entry.category);
}

function hasOtpToken(text: string): boolean {
  for (const match of text.matchAll(OTP_DIGITS)) {
    const start = match.index;
    const end = start + match[0].length;
    const near = text.slice(Math.max(0, start - OTP_KEYWORD_WINDOW), end + OTP_KEYWORD_WINDOW);
    if (OTP_KEYWORD.test(near)) return true;
  }
  return false;
}

function hasCredentialLink(text: string): boolean {
  for (const match of text.matchAll(URL_PATTERN)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (LINK_PATH.test(url.pathname)) return true;
    for (const [key, value] of url.searchParams) {
      if (LINK_QUERY_KEY.test(key) && value.length >= 16) return true;
    }
  }
  return false;
}

export function scoreCredentialDelivery(input: CredentialDeliveryInput): CredentialDeliveryResult {
  const subjectCategories = matchLexicon(input.subject ?? '');
  const bodyCategories = matchLexicon(input.bodyText);
  const signals = {
    subject: subjectCategories.length > 0,
    body: bodyCategories.length > 0,
    otpToken: hasOtpToken(input.bodyText),
    resetLink: hasCredentialLink(input.bodyText),
    noReplySender: SENDER_PATTERN.test(input.from ?? ''),
  };

  const w = CREDENTIAL_DELIVERY_WEIGHTS;
  const score =
    (signals.subject ? w.subject : 0) +
    (signals.body ? w.body : 0) +
    (signals.otpToken ? w.otpToken : 0) +
    (signals.resetLink ? w.resetLink : 0) +
    (signals.noReplySender ? w.noReplySender : 0);
  const excluded = score >= BORDERLINE_THRESHOLD;

  let category: DeliveryCategory | null = null;
  if (excluded) {
    const tally: Record<DeliveryCategory, number> = {
      otp_codes: 0,
      reset_verification_links: 0,
      passwords: 0,
    };
    for (const c of subjectCategories) tally[c] += w.subject;
    for (const c of bodyCategories) tally[c] += w.body;
    if (signals.otpToken) tally.otp_codes += w.otpToken;
    if (signals.resetLink) tally.reset_verification_links += w.resetLink;
    // Tie order: otp_codes > reset_verification_links > passwords.
    const order: DeliveryCategory[] = ['otp_codes', 'reset_verification_links', 'passwords'];
    category = order.reduce((best, c) => (tally[c] > tally[best] ? c : best), order[0]!);
  }

  return { score, excluded, category, signals };
}
