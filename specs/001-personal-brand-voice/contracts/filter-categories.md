# Contract: Filter categories (`@voicespark/filters`)

Canonical definition of the `filter_category` enum and the inspection contract. Every key below is used verbatim in code, the database, the UI and the exclusion report.

## Category table

| key | label (UI) | locked | defaultSelected | handling | detectors |
|-----|------------|--------|-----------------|----------|-----------|
| `passwords` | Passwords and passphrases | yes | yes | Span redaction; whole message excluded if it is credential delivery | Keyword-anchored patterns, "your temporary password" patterns, `user:pass@` URLs |
| `otp_codes` | One-time and verification codes | yes | yes | Span redaction, or whole message | Digit/alphanumeric codes near a lexicon; TOTP backup-code lists |
| `reset_verification_links` | Password-reset and verification links | yes | yes | Span redaction, or whole message | URLs by path or high-entropy query parameter |
| `api_keys_tokens` | API keys and access tokens | yes | yes | Span redaction | secretlint, gitleaks rules, JWT, Bearer, generic key assignments |
| `payment_cards` | Payment card numbers | no | yes | Span redaction | 13-19 digits, Luhn-valid, known IIN prefix |
| `bank_accounts` | Bank account numbers | no | yes | Span redaction | IBAN, Polish NRB, UK sort code + account, US ABA + account |
| `government_ids` | Government ID numbers | no | yes | Span redaction | SSN, NINO, PESEL, Polish ID/passport, German Steuer-ID, generic anchored patterns |
| `health` | Health information | no | yes | Span or whole item | Haiku classifier only |
| `special_category` | Other special-category data (religion, political views, sexual orientation, ethnicity, trade-union membership, biometrics/genetics) | no | yes | Span or whole item | Haiku classifier only |
| `third_party_contacts` | Other people's contact details (phone numbers, postal addresses, email addresses) | no | yes | Span redaction | Email regex, libphonenumber-js, Haiku for postal addresses |

Locked categories cannot be deselected by the user. Optional categories are all selected by default.

## Locked categories

### `passwords`: "Passwords and passphrases"
- Locked; selected by default.
- Handling: span redaction. Whole message excluded if it is credential delivery.
- Detectors:
  - Keyword-anchored patterns: `password|passcode|passphrase|pwd|pass|hasło|Passwort|mot de passe|contraseña` followed by `:`, `=` or `is`, then the token up to whitespace or line end.
  - "your temporary password" patterns.
  - `user:pass@` URLs.

### `otp_codes`: "One-time and verification codes"
- Locked; selected by default.
- Handling: span redaction, or whole message.
- Detectors:
  - 4-8 digits or a 6-10 character alphanumeric code within 60 characters of a lexicon (code, OTP, verification, 2FA, kod, Bestätigungscode, ...).
  - TOTP backup-code lists.

### `reset_verification_links`: "Password-reset and verification links"
- Locked; selected by default.
- Handling: span redaction, or whole message.
- Detectors: URLs whose path matches `reset|recover|verify|confirm|magic|login|signin|activate|unsubscribe-token`, or whose query has `token|code|key|sig|otp|auth|t=` with high entropy (>= 3.5 bits/char, >= 16 characters).

### `api_keys_tokens`: "API keys and access tokens"
- Locked; selected by default.
- Handling: span redaction.
- Detectors:
  - secretlint preset-recommend (AWS, GCP, GitHub, Slack, npm, OpenAI, Anthropic, Stripe, private keys, basic auth).
  - Ported gitleaks rules.
  - JWT (`eyJ...\.eyJ...\.`).
  - `Bearer <token>`.
  - Generic `(api[_-]?key|secret|token)\s*[:=]\s*<>=20 chars, high entropy>`.

## Optional categories (all selected by default)

- **`payment_cards`**, "Payment card numbers". Span redaction. 13-19 digits allowing spaces or dashes, Luhn-valid, with a known IIN prefix.
- **`bank_accounts`**, "Bank account numbers". Span redaction.
  - IBAN via ISO 13616 mod-97 (all countries, spaces allowed).
  - Polish NRB as 26 digits with mod-97 on the PL prefix.
  - UK sort code plus 8-digit account near a keyword.
  - US ABA routing (checksum) plus account near a keyword.
- **`government_ids`**, "Government ID numbers". Span redaction.
  - US SSN (with area/group rules); UK NINO; PESEL (checksum).
  - Polish ID card and passport near a keyword.
  - German Steuer-ID (checksum).
  - Generic "passport|ID number|dowód" anchored patterns.
- **`health`**, "Health information". Span or whole item. Haiku classifier only.
- **`special_category`**, "Other special-category data (religion, political views, sexual orientation, ethnicity, trade-union membership, biometrics/genetics)". Span or whole item. Haiku classifier only.
- **`third_party_contacts`**, "Other people's contact details (phone numbers, postal addresses, email addresses)". Span redaction.
  - Emails: regex, excluding the user's own addresses (identities plus connected mailbox addresses).
  - Phones: libphonenumber-js `findPhoneNumbersInText`, default region from mailbox locale or PL, excluding the user's own numbers. v1 keeps no list of the user's own numbers, so all phone numbers are treated as third-party.
  - Postal addresses: Haiku.
  - When selected, email header addresses are also removed from content and Supermemory metadata (see `contracts/supermemory.md`).

## Summary-only keys (`exclusion_summary_key`)

Never user-selectable; they appear only in exclusion summaries.

| key | label (UI) | handling |
|-----|------------|----------|
| `user_rule` | Matched your exclusion rules | Whole item |
| `inspection_failed` | Could not be checked (not stored) | Whole item (FR-023) |

## Redaction token

`[excluded: {label}]`, where `{label}` is the UI label of the matched category.

## Whole-item thresholds

- Credential-delivery score of 3 or more gives whole-item exclusion.
- A borderline score of 2 also gives whole-item exclusion.
- Haiku `mostlySensitive: true` excludes the whole item.

The credential-delivery stage is deterministic and never calls an LLM. When excluded, the item is reported under `otp_codes`, `reset_verification_links` or `passwords`, whichever signal dominates.

### Scoring table

| signal | weight |
|--------|--------|
| Subject matches credential-delivery lexicon (EN, PL, DE, FR, ES: "verification code", "kod weryfikacyjny", "reset your password", ...) | 2 |
| Body matches credential-delivery lexicon | 1 |
| OTP-shaped token near a keyword | 1 |
| Link with reset/verify path or token query parameter | 1 |
| Sender is a no-reply/security sender pattern | 1 |

Weights are the initial values; they are tuned against the corpus gates below and live in `src/credential-delivery.ts`.

## TypeScript shapes

```ts
type InspectionInput = {
  kind: "email" | "attachment" | "file" | "note"; // content_kind
  subject?: string;  // email, attachment
  title?: string;    // note
  filename?: string; // file, attachment
  bodyText: string;
  headers: { from?: string; to?: string; cc?: string };
  folders: string[];
  ownAddresses: string[];
};

type Policy = {
  selectedCategories: string[]; // filter_category keys
  rules: ExclusionRule[];
};

type InspectionResult = {
  outcome: "accepted" | "excluded";
  text?: string; // only when accepted, already redacted
  fields?: {     // only when accepted, already redacted
    subject?: FilteredText;
    fromName?: FilteredText;
    fromAddress?: FilteredText; // omitted when third_party_contacts is selected
    title?: FilteredText;
    filename?: FilteredText;
  };
  counts: Array<{ category: string; redactedValues: number; wholeItem: boolean }>;
  languageHint?: string;
};

type FilteredText = string & { readonly __brand: "FilteredText" };

type DocumentHeader = {
  kind: "email" | "attachment" | "file" | "note";
  date: string; // item_date
  direction?: "sent" | "received";
  subject?: FilteredText;
  fromName?: FilteredText;
  fromAddress?: FilteredText;
  title?: FilteredText;
  filename?: FilteredText;
};

// src/document.ts
function buildDocument(result: InspectionResult, header: DocumentHeader): FilteredText;
```

- Values are never present in `InspectionResult`; only counts.
- Locked categories are forced on inside `inspect()` regardless of the `Policy` input.
- `subject`, `title`, `filename` and the sender in `headers.from` are inspected like the body: same policy, spans redacted in place and counted. Their filtered values are returned in `fields`.
- `buildDocument()` is the only producer of a Supermemory document `FilteredText` (contracts/supermemory.md "Document"). It throws unless `outcome` is `accepted`, and it takes header text only from inspected values; `From:` shows the display name alone when `fromAddress` is absent.

## Classifier contract

- Model: `LLM_CLASSIFIER_MODEL`.
- The system prompt is locked in code.
- Output:
  ```
  { spans: [{ category: "health" | "special_category" | "third_party_contacts", text: string }],
    mostlySensitive: boolean }
  ```
- Its output is never logged.

## Corpus layout and gates (R8)

- `fixtures/{category}/NNN.eml|.txt`
- `fixtures/benign/`
- `expected.json` maps each file to `[{category, count, wholeItem}]`.
