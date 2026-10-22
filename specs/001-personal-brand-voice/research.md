# Research: Personal Brand Voice

**Branch**: `001-personal-brand-voice` | **Date**: 2026-10-19

All Technical Context unknowns resolved; no NEEDS CLARIFICATION remain.

Verified platform facts this document relies on:

- **Supermemory v5 uses namespaces.** Path-scoped endpoints: `POST /ns/{namespace}/document`, `POST /ns/{namespace}/document/batch`, `DELETE /ns/{namespace}/document` (body `{ids: [...]}`, 1-100 ids), `POST /ns/{namespace}/list/{documents|chunks|memories}`, `GET /ns/{namespace}/document/{id}`, `DELETE /ns/{namespace}`. The TS SDK is the npm package `supermemory`: `new Supermemory({apiKey})`, `add(ns, {content, id, metadata})`, `search(ns, {query, filter, limit, searchMode})`, `documents.delete(ns, {ids})`, `list(ns, "documents", {...})`, `namespaces.delete(ns)`. The v3 `customId` is now `id`; reusing an `id` merges content into the existing document, which makes writes idempotent. Namespace pattern `^[a-zA-Z0-9_:-]+$`, at most 100 characters. Metadata values are string, number, boolean or string[]; keys use `a-zA-Z0-9_-.`. Filters are `{field, operator, value}` combined with `and`/`or`; operators are `eq, neq, gt, gte, lt, lte, contains, notContains, arrayContains, arrayNotContains`. Deleting a namespace keeps documents shared with other namespaces; this design never shares documents across namespaces.
- **Better Auth** has `account.accountLinking.disableImplicitLinking`. With it on, a matching email returns the `account_not_linked` error instead of linking. It also has `allowDifferentEmails`, `trustedProviders`, `linkSocial()`, `listAccounts()` and `unlinkAccount()`.
- **Claude models**: `claude-sonnet-5-5` ($2/$10 per MTok) and `claude-haiku-5-5` ($0.10/$0.50 per MTok, prompts up to 100K tokens) exist. SDK `@anthropic-ai/sdk`. Structured outputs use `output_config.format` through `client.messages.parse()` (`output_format` is deprecated). No assistant prefill and no forced `tool_choice` on Sonnet 5.5. Sonnet 5.5 can return `stop_reason: "refusal"`; server-side fallback is `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`. Haiku 5.5 thinking is adaptive by default at effort `medium`; use `effort: "low"` for classification.

Items checked during this pass (2026-10-19) are flagged "Verification" inside the relevant entry (R3, R10).

---

## R1: Monorepo and process topology

**Decision**: pnpm workspaces with no Turborepo. Two apps (`@voicespark/web`, `@voicespark/worker`) and four packages (`@voicespark/db`, `@voicespark/core`, `@voicespark/filters`, `@voicespark/integrations`). Scripts run with `pnpm -r`.

**Rationale**: One deployable repo with shared types and zod contracts. The worker isolates long-running I/O and LLM work from request handling.

**Alternatives considered**: Turborepo or Nx (unneeded at this size); a separate admin app (duplicates auth and sessions); serverless (needs a long-lived IMAP and queue runtime).

**Sources**: https://pnpm.io/workspaces

---

## R2: ORM: Drizzle

**Decision**: Drizzle ORM with drizzle-kit migrations.

**Rationale**:
- SQL-first schema in TypeScript.
- No engine binary in the Docker images.
- First-class Better Auth adapter, with the Better Auth CLI generating the auth schema.
- Explicit column selection makes the admin metadata-only repositories easy to audit.
- Partial unique indexes and enums are supported.

**Alternatives considered**: Prisma 6/7 (good DX, but implicit selects make metadata-only enforcement weaker, and it adds a generate step); Kysely (no schema or migration story).

**Sources**: https://orm.drizzle.team, https://www.better-auth.com/docs/adapters/drizzle

---

## R3: Auth: Better Auth

**Decision**: Better Auth 1.x with the social providers `google`, `apple`, `microsoft` (`tenantId: "common"` for personal and work accounts) and `facebook`. Email/password is disabled. All ids are UUID v4 via `advanced.database.generateId`.

Account-linking settings: `account.accountLinking = { enabled: true, disableImplicitLinking: true, trustedProviders: [], allowDifferentEmails: true }`.

Linking flow (FR-003): a sign-in whose email matches an existing user gets the `account_not_linked` error. The app redirects to `/link-account?provider=X`, which explains the situation. The user signs in with their existing provider and confirms, then the client calls `linkSocial({provider: X})`. The link offer appears only if the new provider reports `email_verified=true` and the address is not a relay (`*@privaterelay.appleid.com`). Facebook is treated as unverified, so it only links manually (FR-004). Manual linking from settings uses `linkSocial`; unlinking uses `unlinkAccount`. Unlinking the last identity is blocked.

Suspension (FR-006): `databaseHooks.session.create.before` rejects users whose `user_status` is not `active`. Suspending deletes all sessions. Guards re-check status on every request; cookie cache is at most 60 s.

Sign-in tokens are never used for mailbox access (FR-005). Request only the `openid email profile` scopes and do not use provider tokens. Better Auth persists provider tokens in the `account` table by default; builders must enable Better Auth's account token encryption option if the installed 1.x version exposes it (look for an `account.encryptOAuthTokens` flag in the installed version's types), and otherwise null the token columns in an `account` create/update database hook. Verification: the Better Auth OAuth concepts page was fetched on 2026-10-19 and did not mention such an option, so its existence could not be confirmed from the docs; the null-the-columns hook is the fallback that satisfies the decision either way.

Apple needs a client-secret JWT. Generate it at boot from `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` and refresh it at least every 6 months. Apple needs an HTTPS callback, including in development (use a tunnel).

**Rationale**: Built-in confirm-then-link primitives, a Drizzle adapter, all four providers, and active maintenance. Auth.js has joined Better Auth.

**Alternatives considered**: Auth.js/NextAuth v5. Its only linking knob is `allowDangerousEmailAccountLinking`, an automatic and unconfirmed link that violates FR-003; it also had a long beta.

**Sources**: https://www.better-auth.com/docs/concepts/users-accounts, https://www.better-auth.com/docs/authentication/apple, https://www.better-auth.com/docs/authentication/microsoft, https://www.better-auth.com/blog/authjs-joins-better-auth (verified to exist on 2026-10-19; title "Auth.js is now part of Better Auth"), https://www.better-auth.com/docs/concepts/oauth

---

## R4: Gmail mailbox access

**Decision**:
- A separate OAuth client (`GOOGLE_MAIL_CLIENT_ID`, `GOOGLE_MAIL_CLIENT_SECRET`), run with `arctic` and PKCE, scope `https://www.googleapis.com/auth/gmail.readonly` with `access_type=offline` and `prompt=consent`.
- Fetch messages as `format=raw` and parse them with mailparser.
- Initial import: `users.messages.list`, with `q` holding `after:`/`before:` for the date range, excluding SPAM/TRASH/DRAFT, and `pageToken` checkpointing. Record `historyId` from `users.getProfile` at start.
- Ongoing sync: poll `users.history.list(startHistoryId)` every `SYNC_POLL_INTERVAL_MINUTES`. An HTTP 404 (expired historyId) triggers a `resync` import job, deduplicated by occurrence.
- Authorship: `SENT` label, or From is one of the user's known addresses.
- Throughput: concurrency 10 `messages.get` per mailbox, about 50 units/s, below the 250 units/s per-user limit (15,000 units/min; `messages.get` costs 5 units).

**External dependency**: `gmail.readonly` is a restricted scope. It needs OAuth app verification plus an annual CASA Tier 2 assessment by an authorized lab. Testing mode allows at most 100 test users. This is a launch dependency, not a build blocker.

**Rationale**: Delegated read-only access and an official incremental sync.

**Alternatives considered**:
- Using the sign-in token with extra scopes: violates FR-005 and would put sign-in behind CASA.
- Pub/Sub push watch: needs GCP Pub/Sub and a public webhook; deferred.
- Gmail over IMAP: weaker incremental sync.

**Sources**: https://developers.google.com/workspace/gmail/api/guides/sync, https://developers.google.com/workspace/gmail/api/reference/quota, https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification, https://arcticjs.dev

---

## R5: Microsoft mailbox access

**Decision**:
- A separate app registration (`MICROSOFT_MAIL_CLIENT_ID`, `MICROSOFT_MAIL_CLIENT_SECRET`, `MICROSOFT_MAIL_TENANT_ID` default `common`). Delegated scopes `Mail.Read offline_access User.Read`; `User.Read` resolves the mailbox address.
- Enumerate folders and run a per-folder delta query `GET /me/mailFolders/{id}/messages/delta`, with `$filter=receivedDateTime ge {from}` and `$select=id`. Store `@odata.deltaLink` per folder.
- Fetch raw MIME with `GET /me/messages/{id}/$value`, at most 4 concurrent requests per mailbox (Graph allows 10,000 requests per 10 min and 4 concurrent per mailbox).
- Honor `Retry-After` on 429/503. Skip Deleted Items, Junk Email and Drafts.
- Authorship: Sent Items folder, or From matches the mailbox.
- Auth failure (`invalid_grant`, or 401 after refresh) sets the source to `needs_reconnection`.

**Rationale**: Delegated read-only access with an official incremental mechanism and raw MIME, so the same parser handles every mailbox type.

**Alternatives considered**: Change-notification subscriptions (need a public webhook and renewals; deferred); IMAP to Outlook (basic auth disabled, so OAuth is needed anyway).

**Sources**: https://learn.microsoft.com/en-us/graph/delta-query-messages, https://learn.microsoft.com/en-us/graph/throttling-limits, https://learn.microsoft.com/en-us/graph/api/message-get (`$value`)

---

## R6: IMAP

**Decision**:
- ImapFlow over TLS, port 993 by default, STARTTLS optional. Credentials are username plus app password, validated synchronously on connect: a failure returns `422 imap_auth_failed` and stores nothing.
- Open every folder with `mailboxOpen(path, {readOnly: true})` and fetch with `source` / `BODY.PEEK`, so `\Seen` is never set.
- Skip folders with special-use `\Trash`, `\Junk` or `\Drafts`. `\Sent` means authored.
- Per-folder cursor `{uidValidity, lastUid}`. Date range via `SEARCH SINCE/BEFORE`. Fetch in UID batches of 50.
- If UIDVALIDITY changes, rescan the folder with dedup.
- Poll every `SYNC_POLL_INTERVAL_MINUTES`; no IDLE.

**Rationale**: Read-only access that never mutates mailbox state, and a polling model that scales on one box.

**Alternatives considered**: node-imap (unmaintained); IDLE connections (a long-lived connection per mailbox does not scale on one box).

**Sources**: https://imapflow.com/, RFC 3501, RFC 6154

---

## R7: Encryption at rest

**Decision**:
- AES-256-GCM through Node `crypto`. Each purpose gets a key derived by HKDF-SHA256 from the active keyring key, with info strings `mailbox-credentials`, `user-content` and `upload-staging`.
- Ciphertext string format: `v1.{kid}.{iv_b64url}.{tag_b64url}.{ct_b64url}`.
- Keyring (`ENCRYPTION_KEYRING`, `ENCRYPTION_ACTIVE_KEY_ID`) rotation: add a new kid, set it active, and a lazy re-encrypt job converts old values.
- Dedup hashes use HMAC-SHA256 with a separate stable `DEDUP_HMAC_KEY`, never rotated with the keyring.
- Encrypted columns: mailbox tokens and passwords, profile bodies, draft brief/text/edits/feedback, and profile feedback.

**Rationale**: Authenticated encryption with no extra service, purpose-separated keys, and rotation without downtime.

**Alternatives considered**: pgcrypto (keys reach the database); KMS/Vault (out of scope on a single server; can be added later).

**Sources**: Node.js `crypto` documentation (https://nodejs.org/api/crypto.html), NIST SP 800-38D (GCM), RFC 5869 (HKDF)

---

## R8: Sensitive-content pipeline (test-first, fail-closed)

**Decision**: `@voicespark/filters` exposes `inspect(input, policy) -> InspectionResult`. Stages run in this order:

1. **User exclusion rules.** Sender, domain and folder/label match on metadata; keyword match on text, case-insensitive with word boundaries. A match excludes the whole item under `user_rule`.
2. **Credential-delivery classifier (FR-019).** Deterministic and scored: subject/body lexicons in EN, PL, DE, FR and ES ("verification code", "kod weryfikacyjny", "reset your password", ...); OTP-shaped tokens near keywords; links with token query params or reset/verify paths; no-reply/security sender patterns. At or above the threshold, the whole message is excluded under `otp_codes`, `reset_verification_links` or `passwords`. Borderline scores are also excluded. This stage never calls an LLM.
3. **Deterministic span redaction** for every locked category, plus selected optional categories that have reliable patterns: cards, IBAN and bank accounts, government IDs, emails and phones (see contracts/filter-categories.md). Spans are replaced with `[excluded: <label>]`.
4. **Haiku second pass**, only when `health`, `special_category` or `third_party_contacts` is selected. It runs on the stage-3 output, so credentials are already gone, with model `LLM_CLASSIFIER_MODEL` and `effort: "low"`. A locked system prompt lives in code and is not admin-editable. Structured output: `{spans: [{category, text}], mostlySensitive: boolean}`. Located spans are redacted. If a span cannot be found verbatim, or `mostlySensitive` is true, the whole item is excluded.
5. **Post-check.** Re-run the locked-category detectors on the final text. Any hit excludes the item.

Fail-closed (FR-023): any exception or timeout, or a classifier failure after 3 inline retries, gives `outcome: "excluded"` with key `inspection_failed`. The item is not written and an `import_item_failure` row is recorded so a later run can retry it.

The result carries only category counts, `{category, redactedValues, wholeItem}`. Matched values are discarded immediately and never logged. pino redaction is configured, and the logger is typed to accept only `SafeLogFields` (ids, counts, error codes, enum literals), so passing an `InspectionInput` to any `logger.*` call fails `pnpm typecheck`.

The same pipeline runs at three points:
- the import, upload and note write path;
- generation inputs (authored samples and memory snippets, re-filtered with the current preferences);
- draft input (brief) and output (FR-059).

Test-first: write the corpus at `packages/filters/test/corpus/fixtures/` before detector code. It holds at least 30 synthetic positive items per category (at least 300 total) plus at least 200 benign hard negatives, with `expected.json` labels. Gates:
- 100% recall on locked categories and on the overall excluded-value count (SC-005);
- at least 99% item-level recall over all categories (SC-004);
- false-positive rate on benign items reported (target 5% or less).

CI uses recorded Haiku responses. `pnpm test:corpus:live` hits the real API.

**Rationale**: Deterministic checks catch credentials without sending them to a third party; the LLM only sees already-redacted text and only covers semantic categories regex cannot. Failing closed protects the user when anything breaks.

**Alternatives considered**:
- Microsoft Presidio sidecar: a Python plus spaCy container of about 1 GB+; its NER mainly helps names and locations, which Haiku covers; adds a service. Rejected under gate G5 (simplicity); revisit if Haiku cost or latency becomes a problem.
- LLM-only detection: sends credentials to a third party and is non-deterministic; rejected.
- gitleaks binary: Go subprocess; rejected in favor of secretlint, which is TS-native, plus ported gitleaks regexes.

**Sources**: https://github.com/secretlint/secretlint, https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml, https://microsoft.github.io/presidio/, https://gitlab.com/catamphetamine/libphonenumber-js, ISO 13616 (IBAN mod-97), ISO/IEC 7812 (Luhn)

---

## R9: LLM usage (Anthropic)

**Decision**:
- `@anthropic-ai/sdk` with `client.messages.parse()` and `output_config.format` (zod to JSON schema). Use streaming with `.finalMessage()` for profile generation.
- Profile generation: `LLM_PROFILE_MODEL` (default `claude-sonnet-5-5`), `effort: "high"`.
- Drafts: `LLM_DRAFT_MODEL` (default `claude-sonnet-5-5`), `effort: "medium"`.
- Classifier: `LLM_CLASSIFIER_MODEL` (default `claude-haiku-5-5`), `effort: "low"`, max_tokens about 1024.
- Sonnet requests include server-side fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`).
- Always check `stop_reason` for `refusal`, which marks the generation `failed` with code `llm_refused`. No assistant prefill and no forced `tool_choice`.
- Prompt caching: a top-level `cache_control` ephemeral marker on the stable system prompt.
- Prompt-injection hygiene: user content is wrapped in `<sample ref="A1">` tags with an instruction to treat it as data. Output schemas constrain the response. Excerpts are verified verbatim against authored samples; non-matching ones are dropped.
- Cost estimate: one 10k-email import through Haiku is about 20M input tokens, about $2.
- Data handling: no training on API data by default; zero data retention is available by agreement. Anthropic and Supermemory are listed as subprocessors.

**Rationale**: Structured outputs remove JSON parsing failures; model choice per task balances quality and cost; env-configurable models allow changes without a release.

**Alternatives considered**: Batch API (too slow for SC-006 and SC-012); Opus for drafts (cost; remains available through `LLM_ALLOWED_MODELS`).

**Sources**: https://platform.claude.com/docs/en/build-with-claude/structured-outputs, https://platform.claude.com/docs/en/build-with-claude/prompt-caching, https://platform.claude.com/docs/en/about-claude/models/overview

---

## R10: Memory store: Supermemory v5

**Decision**:
- Write through a `MemoryStore` port in `@voicespark/integrations/supermemory`, with a real adapter on the `supermemory` SDK and an in-memory fake for tests.
- One namespace per user, `vs_user_{userId}`. Document `id` = `{contentItemId}`, which makes retries idempotent.
- Safe metadata only; see contracts/supermemory.md.
- Use batch add (`/ns/{ns}/document/batch`) per import page.
- Deletion: `documents.delete(ns, {ids})` in chunks of 100 for items and sources, and `namespaces.delete(ns)` for accounts. Verify with `list` and a filter.
- Search for drafts: `search(ns, {query, limit: 8, filter})`, where the limit comes from `draft.memory_context_limit`.
- Use `searchMode: "chunks"` (the value used in every example of the filtering docs). The full `searchMode` enum could not be verified: the Supermemory filtering page fetched on 2026-10-19 lists no other values. The adapter contract test therefore asserts the accepted `searchMode` values and the document `content` read shape against the installed SDK types, and the adapter pins one constant for the mode so a change is a one-line edit.

**Rationale**: Per-user index isolation, metadata filtering and bulk delete.

**Alternatives considered**: v3 `containerTag` API (deprecated in favor of namespaces); a self-hosted vector DB (contradicts the requirement that the memory store is chosen by the business).

**Sources**: https://supermemory.ai/docs/concepts/container-tags.md, https://supermemory.ai/docs/migration/api-v5-document-writes.md, https://supermemory.ai/docs/migration/api-v5-document-reads.md, https://supermemory.ai/docs/concepts/filtering.md, https://supermemory.ai/docs/integrations/supermemory-sdk.md, https://supermemory.ai/docs/api-reference/ingest/bulk-delete-documents.md

---

## R11: What content is stored locally (FR-045, FR-060)

**Decision**:
- Postgres stores no raw email, file or note content, and no subjects or bodies.
- `content_item` holds only metadata: kind, authorship, date, language, word count, HMAC hashes and the Supermemory id.
- Generated artifacts (profile versions with excerpts, drafts, feedback, briefs) are stored because the user needs them, in encrypted content-class columns.
- Profile generation and retroscans read source content back from Supermemory: list with filter `vs_authorship eq authored`, then fetch the document content.
- Uploads are staged only in encrypted temporary files under `UPLOAD_TMP_DIR`, deleted after processing; a sweep deletes anything older than 24 h.

**Rationale**: Minimizes the breach surface and admin exposure, and gives one deletion target.

**Alternatives considered**: A local encrypted authored corpus (faster generation, but a second copy to purge and protect); rejected.

**Sources**: Internal design (spec FR-045, FR-060); see R10 and R13.

---

## R12: Job queue and throughput (SC-003)

**Decision**: BullMQ 5 on Redis 7.4, prefix `vs`. Queues: `import`, `sync-poll`, `upload`, `profile`, `draft`, `deletion`, `retroscan`, `notify`, `maintenance`.

- Import work is split into `import.page` jobs of 100 message refs. There is at most one in-flight page per source, enforced with jobId `import-{sourceId}`. Items within a page are processed with concurrency 10, at most 4 for Graph. Each page persists its checkpoint before enqueueing the next.
- Fairness: small pages interleave across sources. Worker concurrency is `WORKER_CONCURRENCY_IMPORT`.
- Budget: a page takes about 15-25 s (fetch, parse, filter, batch write), so 100 pages take about 25-40 min, under 1 h.
- Polling uses BullMQ job schedulers: `upsertJobScheduler('poll-{sourceId}', {every})`.
- Stalled-job recovery: the `maintenance.stale-imports` scheduler re-enqueues running jobs idle for more than 15 min.
- Custom job ids use `-` separators and never contain `:`.

**Rationale**: BullMQ has the rate-limit, delay and job-scheduler primitives needed, on Redis already required for rate limiting.

**Alternatives considered**: pg-boss (fewer moving parts, but weaker rate-limit and delay primitives and no job schedulers); BullMQ Pro groups (paid); Temporal (heavy).

**Sources**: https://docs.bullmq.io/guide/job-schedulers, https://docs.bullmq.io/guide/rate-limiting

---

## R13: Admin isolation from content

**Decision**: four layers.

1. **Data.** Source content lives only in Supermemory. Content-class columns are encrypted.
2. **Code.**
   - `@voicespark/db/repos/admin/*` selects whitelisted metadata columns only.
   - `repos/user/*` requires a `UserContext {userId}` taken from the session, and every query includes `user_id = ctx.userId`.
   - ESLint `no-restricted-imports` bans `@voicespark/db/repos/user/*`, `@voicespark/integrations/supermemory` and `@voicespark/core/crypto` (content keys) from `apps/web/app/api/admin/**`, `apps/web/app/(admin)/**` and `packages/core/src/services/admin-users.ts`.
3. **API.** Every `/api/admin/*` response is validated against a zod schema with no content fields. User content endpoints return 404 when the resource is not the caller's, admins included. There is no impersonation feature.
4. **Tests (SC-010).** A contract test enumerates the admin route manifest and checks response schemas against a forbidden-field list. E2E tests have an admin request another user's sources, items, profiles and drafts, and expect 404. Each denial writes an `admin.content_access_denied` audit entry (via `auditForeignAccess`; list routes are owner-scoped and cannot target another user).

**Rationale**: Defence in depth, so no single mistake exposes content to an admin; each layer is mechanically checkable.

**Alternatives considered**: A separate DB role or row-level security (adds operational complexity; optional hardening later).

**Sources**: https://eslint.org/docs/latest/rules/no-restricted-imports; internal design (FR-045, FR-060, SC-010).

---

## R14: Audit logging

**Decision**: an append-only `audit_log_entry` table. Its `metadata` jsonb is validated per action by a zod whitelist and holds only ids, category keys, counts and version ids. `actor_type` is `audit_actor_type` (`user | admin | system`).
- Retained for 2 years.
- On account deletion, `actor_user_id` and `target_id` referencing the user are nulled and `subject_ref = HMAC(userId)` is kept.
- Admins can read it at `/admin/audit`, showing actor and target metadata only.
- The action list is in data-model.md.

**Rationale**: Queryable governance trail (FR-048, FR-064) that cannot become a content leak because the metadata shape is whitelisted.

**Alternatives considered**: Logging to files only (not queryable, and risks content leaks).

**Sources**: Internal design (FR-048, FR-064).

---

## R15: Versioning model for definitions and prompts (FR-041, FR-042, FR-057, SC-008)

**Decision**:
- Immutable version rows with `version_status`: `draft` (editable, at most one per parent), then `active` (exactly one per parent, referenced by `active_version_id`), then `superseded`.
- Publishing atomically sets the old active version to `superseded`, the new one to `active`, and moves the pointer. Rollback sets a chosen superseded version active the same way.
- Every activation writes a `version_activation` row (who, when, from, to, action) and an audit entry. "What changed" is a server-computed JSON diff between versions.
- A generation pins `definition_version_id` and `prompt_version_id` when the job is created, so generations already running finish on their versions (FR-033, FR-058). The active pointer is read uncached, so new jobs see a publish immediately (SC-008).
- `definition_availability` (`available | retired`) sits on the definition, not the version. A definition needs an active version before it can be marked `available`. The last available definition cannot be retired (FR-068).

**Rationale**: Immutability makes pinning, rollback and diffs trivial and auditable.

**Alternatives considered**: Mutable rows plus a history table (harder pinning); git-backed prompts (needs a release, violates FR-041).

**Sources**: Internal design (FR-033, FR-041, FR-042, FR-057, FR-058, FR-068, SC-008).

---

## R16: Prompt templating

**Decision**: Mustache, logic-less, with HTML escaping disabled because the output is plain text.
- A version has `system_template`, `user_template`, `model` (must be in `LLM_ALLOWED_MODELS`), `effort` (`low | medium | high`) and `max_tokens`.
- On save and publish, templates are parsed and every tag must be in the key's variable whitelist (contracts/prompt-template-variables.md). Unknown variables give `422 unknown_template_variable`.
- Output schemas are fixed in code per `prompt_key`, so admins cannot change the output shape.
- System keys (`tone_profile.generate`, `tone_profile.feedback`, `draft.social_post`, `draft.bio`, `draft.short_article`) are seeded and not deletable; custom keys match `^custom\.[a-z0-9_]{2,60}$`.

**Rationale**: Logic-less templates are statically checkable, so admins cannot break generation or inject unvetted data.

**Alternatives considered**: Handlebars or Liquid (logic in templates; harder to validate).

**Sources**: https://github.com/janl/mustache.js

---

## R17: Content parsing and authorship

**Decision**:
- Every email is parsed from raw RFC 822 with `mailparser`. Plain text is preferred, otherwise `html-to-text`.
- For authored items, quoted replies are stripped with `email-reply-parser`, so received text is never attributed to the user (FR-028).
- Text-bearing attachments (pdf, docx, txt, md, html) of 10 MB or less are extracted into separate `attachment` content items (parent = email), inheriting the parent's authorship. Other attachments are skipped and counted (`non_text_attachment`, `attachment_too_large`, `unreadable_attachment`).
- Language is detected with `franc`, ISO 639-3 mapped to 639-1, on texts of 50+ characters.
- Documents are capped at 100k characters. Longer text is split into `part` documents with a `vs_part` metadata field.

Uploads:
- `file-type` sniffing: allow `application/pdf`, DOCX, `text/plain`, `text/markdown`; anything else is `unsupported_type`.
- `unpdf`: a pdf.js password exception gives `encrypted`. Fewer than 20 characters of text per page on average gives `no_text`.
- `mammoth.extractRawText` for DOCX.
- Text files must be valid UTF-8 (`TextDecoder` with `fatal`), otherwise `corrupt`.
- Files over `UPLOAD_MAX_BYTES` (10 MB) get `too_large`; empty files get `empty`.

**Rationale**: One parser path for all mailbox types, and quote stripping prevents mis-attributing others' words to the user.

**Alternatives considered**: Provider-specific body formats (three code paths); sending whole threads (violates FR-028).

**Sources**: https://nodemailer.com/extras/mailparser/, https://github.com/unjs/unpdf, https://github.com/mwilliamson/mammoth.js, https://github.com/wooorm/franc

---

## R18: Dedup across mailboxes (FR-014, SC-011)

**Decision**:
- `message_id_hash = HMAC(DEDUP_HMAC_KEY, lowercase(Message-ID))`.
- `content_hash = HMAC(normalized from|date-to-minute|subject|body)`, used when Message-ID is missing or as a secondary check.
- Partial unique index `(user_id, message_id_hash)`.
- A `content_item_occurrence (source_id, provider_ref)` row is unique per source. A duplicate adds an occurrence only, with no second Supermemory write, and counts as `items_duplicate`.
- If an occurrence is authored in any source, the item is `authored`.
- Deleting a source deletes the Supermemory document only when no other occurrence remains.
- Pause and resume are idempotent through the checkpoint plus the occurrence check plus the deterministic Supermemory id.

**Rationale**: Keyed hashes dedup without storing identifiers in the clear, and the deterministic id makes retries safe.

**Alternatives considered**: Raw Message-ID only (missing on some messages; also leaks identifiers).

**Sources**: RFC 5322 section 3.6.4 (Message-ID); RFC 2104 (HMAC).

---

## R19: Deletion propagation (SC-009)

**Decision**:
- A `deletion_request` row (`deletion_scope`, `deletion_status`) with `due_by = requested_at + 24h`, run by `deletion.execute`.
- Steps: stop schedulers, delete Supermemory documents (chunks of 100) or the whole namespace, verify with list and filter (zero remaining), delete Postgres rows, notify.
- Retries back off exponentially (1 min doubling, capped at 2 h, 12 attempts).
- `maintenance.deletion-sla` runs every 15 min, flags requests overdue or within 2 h of their due time, and raises an admin dashboard alert plus an audit entry.
- Account deletion order:
  1. Set the user to `pending_deletion`.
  2. Revoke sessions.
  3. Remove the poll schedulers.
  4. Revoke Google tokens at `https://oauth2.googleapis.com/revoke`; delete Microsoft and IMAP credentials.
  5. Run `namespaces.delete`.
  6. Verify.
  7. Delete user rows with cascade.
  8. Email the user through SMTP to the address captured on the request (`notify_email_enc`).
  9. Pseudonymize audit entries.
- Source purge after disconnect follows the user's choice (FR-015).

**Rationale**: A durable request row with a deadline makes the 24 h guarantee observable and retryable.

**Alternatives considered**: Synchronous deletion in the request (times out on large mailboxes); fire-and-forget queue jobs without a SLA monitor (failures go unnoticed).

**Sources**: https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke, https://supermemory.ai/docs/api-reference/ingest/bulk-delete-documents.md

---

## R20: Retroscans: offer removal of matching content already stored (FR-021, FR-062)

**Decision**: creating or updating a rule, or newly selecting a category, creates a `retroscan` (`retroscan_trigger`, `retroscan_status`).
- Sender, domain and folder rules use Supermemory `list` with metadata filters (`vs_sender_hash`, `vs_sender_domain_hash`, `vs_folders arrayContains`).
- Keyword rules and categories page through the documents, fetch content and run the matcher or `inspect()`.
- Matched ids are stored, never content. The user confirms (purge through a `deletion_request` with scope `retroscan_purge`) or dismisses. Results expire after 7 days.

**Rationale**: Metadata filters avoid downloading content where a rule is metadata-only; storing ids only keeps content out of Postgres.

**Alternatives considered**: Always rescan all content (slow and costly); keeping a local content index (violates R11).

**Sources**: https://supermemory.ai/docs/concepts/filtering.md

---

## R21: Notifications

**Decision**: an in-app `notification` table plus email via nodemailer/SMTP (`SMTP_URL`, `MAIL_FROM`) for `source_needs_reconnection`, `deletion_completed` and `import_completed` (first import only). Payloads hold safe metadata only.

**Rationale**: Covers the events users must not miss without building a push channel.

**Alternatives considered**: Web push (deferred).

**Sources**: https://nodemailer.com/

---

## R22: Thresholds and settings (FR-029)

**Decision**: an `app_setting` key/value table:
- `profile.min_authored_words`, default 5000 (about 50 sent emails at about 100 words);
- `profile.significant_new_content_ratio`, default 0.25;
- `draft.memory_context_limit`, default 8.

Progress is the authored word count over the threshold.

**Rationale**: Admin-tunable without redeploy; defaults are conservative enough for a usable first profile.

**Alternatives considered**: Env vars (need a restart and are not admin-editable); hard-coded constants (violate FR-029).

**Sources**: Internal design (FR-029).

---

## R23: Hosting

**Decision**: docker-compose with `web` (`next start`, port 3000), `worker`, `postgres:17`, `redis:7.4` (AOF on, `maxmemory-policy noeviction` as BullMQ requires) and a one-shot `migrate`.
- Volumes: `pgdata`, `redisdata`, `uploads_tmp` (shared by web and worker).
- Host Caddy reverse-proxies `APP_URL` to `web:3000` with automatic HTTPS; `docker/Caddyfile.example` is provided, and Caddy can run in the optional compose profile `proxy`.
- Backups: nightly `pg_dump` (documented in the quickstart).

**Rationale**: Four runtime services on one box fit the v1 scale (1,000 users) with minimal operations.

**Alternatives considered**: Kubernetes (excess for one server); managed PaaS (long-lived worker and IMAP needs, and data-residency control).

**Sources**: https://docs.bullmq.io/guide/going-to-production, https://caddyserver.com/docs/

---

## R24: Testing strategy

**Decision**:
- Unit tests with Vitest 3 per package.
- Integration tests against compose Postgres/Redis (or Testcontainers), the fake `MemoryStore` and a fake Anthropic (recorded fixtures).
- The corpus suite (R8), `pnpm test:corpus`.
- IMAP load and dedup through GreenMail (`docker-compose.test.yml`), seeded with 10k generated messages, including 500 duplicated across two accounts.
- Playwright e2e with `AUTH_TEST_MODE=1`, which enables a Better Auth test-only generic OAuth mock provider. It is never enabled in production; startup asserts this.
- SC-010 admin isolation suite.

**Rationale**: Fakes keep CI deterministic and free of external cost, while the live corpus command covers real-model drift on demand.

**Alternatives considered**: Hitting real Supermemory and Anthropic in CI (flaky, costly, and would send test data to third parties); Jest (slower with TS ESM).

**Sources**: https://vitest.dev, https://playwright.dev, https://greenmail-mail-test.github.io/greenmail/

---

## R25: Date range and ongoing sync (FR-009, FR-012)

**Decision**: `date_range_from` and `date_range_to` are both nullable. Null/null means full history plus ongoing sync. If `to` is set and in the past, no ongoing sync runs after the initial import and the source shows "range complete". Users can edit the range to clear `to`, which resumes ongoing sync.

**Rationale**: One representation covers "everything", "since X" and "bounded window" with no special flags.

**Alternatives considered**: A separate "ongoing sync" boolean (redundant state that can contradict the range); mandatory ranges (hurts the common case).

**Sources**: Internal design (FR-009, FR-012).
