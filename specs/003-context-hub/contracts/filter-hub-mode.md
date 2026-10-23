# Contract: Filter hub mode (`@voicespark/filters`) - delta against 001 `filter-categories.md`

This file is a delta against `specs/001-personal-brand-voice/contracts/filter-categories.md`. The category table, locked flags, defaults and the `inspect()` contract are unchanged. This file adds a hub mode of the pipeline, one new text brand, one contact-value brand and two helpers. New code lives in `packages/filters/src/hub.ts`; `pipeline.ts` gets a `contactMode` option.

## Why hub mode exists (FR-028)

Email addresses and phone numbers MAY be kept in the email, phone and domain fields of hub records, even when the user selected `third_party_contacts`. To extract those fields, the AI call must see them in the conversation. Hub mode lets the extraction call see contact values and nothing else that the normal pipeline would remove.

## What stays always excluded in hub mode

Hub mode changes exactly one thing: the deterministic `contacts` detector (emails and phones) is skipped and the `From` address is kept. Everything else is unchanged and must reach 100% locked recall:

- Locked categories: `passwords`, `otp_codes`, `reset_verification_links`, `api_keys_tokens`. Span redaction, and whole-item exclusion for credential delivery.
- `payment_cards`, `bank_accounts`, `government_ids`, `health`, `special_category`, when the user selected them.
- The postal-address sense of `third_party_contacts`, through the Haiku classifier, when the user selected it.
- The user's exclusion rules (sender, domain, keyword).
- Credential-delivery whole-item exclusion and the post-check.
- Fail-closed behaviour: if any step cannot complete, the call returns an exclusion with reason `inspection_failed` and nothing is used.

Hub mode never softens the other categories. A phone number inside a redacted span (for example a card line) stays redacted. An email that is part of a `user:pass@` URL stays redacted.

## API

### `inspectForHubExtraction(input, policy, deps) -> HubInspectionResult`

```ts
type HubInspectionResult =
  | { excluded: false; text: HubLlmText; redactions: Redaction[] }
  | { excluded: true; category: FilterCategoryKey | 'inspection_failed' };
```

- Runs the normal pipeline with `contactMode: 'hub_extraction'`.
- Returns `HubLlmText`, a new brand. `HubLlmText` is not assignable to `FilteredText` (the brand symbols differ), so `MemoryDoc.content` and every other `FilteredText` sink reject it at compile time. A type test with `@ts-expect-error` guards this.
- `HubLlmText` is accepted only by the hub extraction prompt builder.
- A lint rule bans importing `inspectForHubExtraction` outside `packages/core/src/services/hub/extraction*.ts`.
- Participant names are inspected as short fields by the locked detectors. Addresses of participants are structured header data and are not text-inspected.

### `validateContactValue(kind, raw) -> ContactValue | null`

`kind` is `'email' | 'phone' | 'domain'`.

- `email`: a strict address parse. Lower-cased, at most 320 chars.
- `phone`: `libphonenumber-js` validity, kept as written, at most 50 chars, matching `^[0-9+()\-.\s/x]*$`.
- `domain`: matches `^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$`, lower-cased, no `www.`.
- All three also run the four locked detectors and the payment, bank and government-id detectors on the raw value. Any hit returns `null`. Examples that return `null`: `jan@acme.com password: x`, a token in a phone field, an IBAN in a phone field, a reset URL as a domain.
- Returns the brand `ContactValue`. Only a `ContactValue` can be stored in `hub_person_email`, `hub_person.phone_enc` and `hub_company_domain`, and passed to `buildHubDocument` as a contact. `FilteredText` and plain strings do not type-check as `ContactValue`.
- Website values are validated as http(s) URLs and then go through `inspectSegments` (they are not contact values).

### `inspectSegments(segments, policy, deps) -> SegmentsResult`

```ts
type SegmentsResult =
  | { excluded: false; segments: FilteredText[]; redactedValues: number }
  | { excluded: true; category: FilterCategoryKey | 'inspection_failed' };
```

- Runs the full user policy (not hub mode) on a list of strings in one pass.
- Segments are joined with the separator `\n \n`, which no detector spans. Classifier spans are mapped back per segment.
- Used for: rich-text notes (text nodes and link hrefs, rebuilt into JSON), record free-text fields, and the extraction outputs (`summary`, `evidence`, `description`, `name`, `roleTitle`, link `role`, `industry`).
- A segment can come back empty after redaction. Whole-item exclusion applies to the call, not to one segment, unless the caller inspects segments one by one.

### `buildHubDocument(kind, parts) -> MemoryDoc`

- The only producer of hub memory documents (contracts/memory-store-hub.md).
- `parts` carry `FilteredText` fields and `ContactValue[]`. No other string type compiles.
- Contact values (emails, phones) are included only when the policy does not select `third_party_contacts`. Domains are included either way.
- Output `content` is `FilteredText`, produced inside the filters package.

## Where each mode is used

| Place | Function | Policy |
|---|---|---|
| Extraction call input (`hub.thread`) | `inspectForHubExtraction` | hub mode |
| Triage call input | `inspect` (normal) | full policy, contacts redacted |
| Extraction outputs (summary, evidence, names, roles, industry, description) | `inspectSegments` | full policy |
| Contact values from the model or headers | `validateContactValue` | validity plus locked detectors |
| Note save and edit | `inspectSegments` | full policy |
| Record free-text fields | `inspectSegments` | full policy |
| File extracted text | `inspect` kind `file` | full policy |
| Memory store documents | `buildHubDocument` | full policy, contact rule |
| Draft record context | `inspect` of every segment | full policy |
| Tone-of-voice content | unchanged | full policy |

## Corpus and gates (Principle IV, test-first)

New fixtures in `packages/filters/test/corpus/hub/`. Tests are written failing first.

- Hub mode keeps emails and phones in signatures and bodies: hard negatives (signature with phone and email must survive).
- Hub mode still redacts every locked category at 100% recall, plus cards, IBANs, government ids and postal addresses (when selected). The corpus has positive cases where an email or phone sits next to a secret (`login: jan@acme.com / password: x`).
- `validateContactValue` rejects contact values that carry secrets or ids, and accepts normal PL and EN values.
- `inspectSegments`: segment boundaries, a classifier span that crosses a boundary, link hrefs, rebuilt JSON.
- `buildHubDocument`: contacts omitted when `third_party_contacts` is selected, included when not, domains always included.
- Compile-time tests: `HubLlmText` is rejected by `MemoryDoc`, a plain string is rejected as `ContactValue`.
- The CI corpus gate gains a hub-mode run. Locked-category recall in hub mode must be 100% (same threshold as normal mode). Precision gates for hard negatives are reported separately.
