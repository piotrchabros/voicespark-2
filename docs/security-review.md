# Security review

The per-release security review that the constitution requires (Development Workflow & Quality Gates: scopes, logging,
encryption, admin isolation, rate limits and OAuth state handling), plus the T164 checks. Each section names what was
checked, how, and the result, with file and line references. Anything that does not fully hold is listed under
[Open issues](#open-issues). It is not glossed over in the sections.

- Reviewed: 2026-10-22, against the working tree (the repository has no commits yet, so the file list below comes from
  `git ls-files --cached --others --exclude-standard`, not `git ls-files`).
- Updated: 2026-10-24 for spec 003 (Context Hub), against the working tree of branch `003-context-hub`. The hub checks
  are in sections 1, 3, 7 and 8 (marked "Context Hub") and in sections 10 to 13. New open items are OI-9 to OI-15.
- Versions in use: better-auth 1.7.12, drizzle-orm 0.45.4, pino 9.x, arctic 3.x, imapflow 2.x, supermemory SDK 5.x (legacy adapter). The default adapter calls the self-hosted Supermemory v3 REST API directly
  over HTTPS with a Bearer key, with no SDK.
- Result: **pass with open issues**. The one medium issue (OI-1: raw error messages reach the worker log and Redis) is
  fixed. The rest are low severity or need a decision.

## 1. Scopes (constitution II, FR-005, FR-008)

Commands:

```sh
rg -n -i "gmail\.readonly|Mail\.Read|'openid|scopes?:" apps packages --glob '!**/node_modules/**' --glob '!**/drizzle/meta/**'
rg -n "mailboxOpen|BODY\.PEEK|\\\\Seen|messageFlags|flagsAdd|messageDelete|messageMove|append\(" packages/integrations/src
rg -n "method:|'POST'|'PATCH'|'DELETE'|modify|/send|trash" packages/integrations/src/gmail packages/integrations/src/microsoft
```

| Check | Result | Evidence |
|---|---|---|
| Sign-in requests only `openid email profile` | Holds | `apps/web/lib/auth.ts:17` `SIGN_IN_SCOPES`; every provider sets `disableDefaultScope: true` (`:62`, `:70`, `:79`, `:88`). Google and Microsoft use `SIGN_IN_SCOPES` (`:63`, `:80`). Microsoft also sets `disableProfilePhoto` (`:81`), so the default `User.Read` is not requested. The test-mode mock uses the same set (`:202`). |
| Provider equivalents | Holds (documented deviation) | Apple has no `openid`/`profile` scope and uses `name email` (`auth.ts:71`). Facebook uses `email public_profile` (`auth.ts:89`). Neither grants mailbox access. |
| Gmail mailbox: `gmail.readonly` only | Holds | `packages/integrations/src/oauth/mail-oauth.ts:19-20`, `gmailAuthorizeUrl` `:48-54`. The Gmail client calls only `users.getProfile`, `users.messages.list`, `users.messages.get` (format `raw`) and `users.history.list` (`packages/integrations/src/gmail/client.ts:183`, `:194`, `:213`, `:221`). |
| Microsoft mailbox: `Mail.Read offline_access User.Read` | Holds | `mail-oauth.ts:21`, `:56-58`; refresh re-requests the same set (`:114`). Graph client issues `GET` only (`packages/integrations/src/microsoft/graph-client.ts:68`). |
| Granted scopes are checked, not just requested | Holds | `assertMinimalScopes` (`mail-oauth.ts:96-103`) rejects anything beyond the requested set (plus the OIDC identity scopes Microsoft always reports) and requires the read scope. It is called in `completeConnect` (`packages/core/src/services/sources.ts`, after `exchangeCode`). On failure the Gmail grant is revoked. Tests: `packages/integrations/test/mail-oauth.test.ts:72-113`. |
| IMAP read-only | Holds | Every folder is opened with `mailboxOpen(path, { readOnly: true })` (EXAMINE), `packages/integrations/src/imap/client.ts:131`. Messages are fetched with `source: true` (BODY.PEEK[]), `:228-233`. The grep finds no flag, delete, move, copy or append call in `packages/integrations/src`. Test: `packages/integrations/test/imap-client.integration.test.ts:132` ("never sets \Seen", against GreenMail). |
| Separate OAuth clients for sign-in and mailbox | Holds | `GOOGLE_SIGNIN_*` / `MICROSOFT_SIGNIN_*` in `auth.ts` vs `GOOGLE_MAIL_*` / `MICROSOFT_MAIL_*` in `packages/core/src/services/mail-access.ts:57-59`. |
| Context Hub: no new OAuth scope (Principle II) | Holds | `git diff main -- apps/web/lib/auth.ts packages/integrations/src/oauth packages/integrations/src/gmail packages/integrations/src/microsoft` is empty. The hub reads mail through the existing read-only fetchers: `hub.thread` re-fetches a thread (`fetchThread`, `apps/worker/src/processors/hub-thread.ts:264`) and `hub.backfill` re-fetches already imported messages (`apps/worker/src/processors/hub-backfill.ts`). The only IMAP change is `isSkippedImapFolder` (`packages/integrations/src/imap/client.ts`), which skips more junk, trash and drafts folders by name; folders are still opened read-only. |

## 2. Logging (constitution VI, FR-020, FR-048)

Commands:

```sh
rg -n "log(ger)?\.(info|warn|error|debug|fatal|trace)\(" packages apps --glob '!**/node_modules/**' \
  | rg -i "body|subject|content|brief|topic|text|token|password"      # no matches
rg -n "log(ger)?\.(info|warn|error|debug|fatal|trace)\(" packages apps --glob '!**/test/**' --glob '!**/*.test.ts' -A2
rg -n "console\.(log|info|warn|error|debug)\(" packages apps --glob '!**/test/**' --glob '!**/e2e/**'
```

Results:

- **Typed logger.** `SafeLogFields` (`packages/core/src/logger.ts:8-27`) has no index signature and only accepts ids,
  counts, codes and enum literals. Every logger method takes `SafeLogFields` (`:29-39`). The compile-time test
  `packages/core/test/logger.types.test.ts:6` proves that an `InspectionInput` is rejected. All 26 non-test logger call
  sites pass only `status`, `errorCode`, `count`, `counts`, `attempt`, `durationMs` or ids, and the content grep returns
  nothing.
- **pino redaction.** `REDACT_PATHS` (`logger.ts:42-57`) covers `bodyText`, `subject`, `headers`, `password`,
  `access_token` and `refresh_token`, at top level and one level deep. **Partly ineffective. See OI-2 (fixed):** the `*_enc` and
  `*.*_enc` entries never match, because fast-redact has no partial-key wildcards. This was checked by running pino with
  those paths (a scratch script logging `{topic_enc: ...}` printed the value unredacted). camelCase `accessToken` /
  `refreshToken` keys are not covered either.
- **Raw error messages.** **Holds after the OI-1 fix:** `dispatch()` in `apps/worker/src/index.ts` logs
  `errorCode: toErrorCode(err)` and rethrows `toSafeError(err)`, so only safe codes reach the log and Redis.
- **`console.*`.** Only in CLIs: `packages/db/src/migrate.ts`, `packages/db/src/seed.ts`, `packages/core/src/cli.ts`.
  They print fixed strings and `err.message`. These are operator-run, and the inputs are seed data or the operator's own
  email, so the risk is acceptable. Note that they carry the same DrizzleQueryError behaviour as OI-1.
  `packages/core/src/cli.ts` printed `err.message` to the operator's terminal only (not to logs or Redis). **Fixed:** it
  now prints only `toErrorCode(err)` from `packages/core/src/error-code.ts`, the same mapping the worker uses.
- **Web.** Unhandled route errors log only `{ errorCode: 'internal_error' }` (`apps/web/lib/http.ts:36`) and the client
  gets a generic `internal_error`.
- **Audit metadata.** `packages/core/src/services/audit.ts:23-51` validates every entry. The default schema only allows
  scalar ids, numbers, booleans and `[a-z0-9_.-]{1,64}` tokens. Three actions have strict per-action schemas.
- **Notifications.** `NOTIFICATION_PAYLOAD_SCHEMA` (`packages/core/src/services/notifications.ts:9-18`) uses the same
  scalar-only rule and is applied before insert.
- **Queue payloads** carry ids only: no free-text `z.string()` fields in `packages/core/src/queues/index.ts`.

## 3. Encryption at rest (constitution VII)

Commands:

```sh
rg -n "_enc'" packages/db/src/schema/*.ts
rg -n "encrypt(Buffer)?\('|decrypt(Buffer)?\('" packages/core/src/services
rg -n "text\('[a-z_]+'\)|jsonb\('" packages/db/src/schema/*.ts | grep -v "_enc'"
```

- **AEAD.** AES-256-GCM, 12-byte IV, 16-byte tag, purpose bound as AAD. The format `v1.{kid}.{iv}.{tag}.{ct}` is in
  `packages/core/src/crypto/aead.ts:8-32`.
- **Keyring.** Versioned through `ENCRYPTION_KEYRING` / `ENCRYPTION_ACTIVE_KEY_ID`. Per-purpose HKDF-SHA256 subkeys
  (`mailbox-credentials`, `user-content`, `upload-staging`, `hub-files`; `KeyPurpose`,
  `packages/core/src/crypto/keyring.ts:4`) are derived in `packages/core/src/crypto/keyring.ts`.
  Decryption resolves the key by `kid`, which allows rotation.
- **Context Hub: `hub-files` key and binary envelope.** The `hub-files` subkey is used only for hub file blobs (the
  original uploaded files, FR-009). Blobs use a binary envelope, not the base64 string format:
  `v1` | kid length (1 byte) | kid | IV (12) | tag (16) | ciphertext, AES-256-GCM with the purpose as AAD
  (`encryptBinaryWith` / `decryptBinaryWith`, `packages/core/src/crypto/aead.ts:50-105`). `readBinaryKeyId` (`:87`)
  reads the kid from the header without a key. The blob store (`packages/core/src/hub/blob-store.ts`) writes
  `{HUB_FILES_DIR}/{userId}/{storageKey}.bin` (directory mode 0700, file mode 0600, write to a temp file then rename,
  `:50-65`). Both path parts must be UUIDs (`assertUuid`, `:29-47`), so no path can leave `HUB_FILES_DIR`. The kid used
  is stored in `hub_file.key_id`. Blobs are decrypted only for the owner's download
  (`packages/core/src/services/hub/files.ts:286-288`, response headers `attachment`, `nosniff`, `private, no-store` in
  `apps/web/app/api/hub/files/[id]/download/route.ts`) and for text extraction in `hub.file-extract`. Blobs never go to
  the AI service or the memory store. Tests: `packages/core/test/crypto-binary.test.ts`,
  `packages/core/test/hub-files.integration.test.ts`.
- **Context Hub content columns.** Every hub content value is in a `*_enc` column (`packages/db/src/schema/hub.ts`):
  record names, role, phone, website, industry, descriptions, email addresses, domains, link roles, note title and body,
  file name, description and extracted text, thread subject, participants and summary, the "open original" link, fact
  values and evidence, and ignore-rule values. Lookups use HMAC columns (`name_key`, `match_key`, `address_hash`,
  `match_hash`, `domain_hash`, `value_hash`, `key_hash`; `packages/core/src/hub/normalize.ts`). Plaintext hub columns
  hold ids, enums, counts, MIME type and extension, the unkeyed `hub_file.sha256` (OI-14) and
  `hub_message_source.folders`, as `content_item.folders` already does.
- **Mailbox tokens and IMAP password.** Stored in `mailbox_credential.access_token_enc` / `refresh_token_enc` /
  `imap_password_enc` (`packages/db/src/schema/mailboxes.ts:27-36`). Sealed and opened only in
  `packages/core/src/services/mail-access.ts:74-75`.
- **PKCE verifier.** `oauth_connect_state.code_verifier_enc` is written at `packages/core/src/services/sources.ts:305`.
- **Staged uploads.** Encrypted on disk with mode 0600 (`packages/core/src/services/uploads.ts:120`), decrypted at
  `:340`.
- **Draft content.** Only in `*_enc` columns: `topic_enc`, `brief_enc`, `feedback_enc`, `generated_text_enc`,
  `edited_text_enc`, `title_enc`, `notes_enc` (`packages/db/src/schema/drafts.ts:38-44`). Every read and write goes
  through `enc`/`dec` in `packages/core/src/services/drafts.ts:65-66`, `:150-151`, `:201`, `:359`.
- **Profiles.** `body_enc` and `feedback_enc` (`packages/db/src/schema/profiles.ts:82-83`, `:116`), handled in
  `packages/core/src/services/profiles.ts`.
- **Deletion notify email.** `notify_email_enc` (`packages/core/src/services/deletion.ts:95`).
- **Imported email and file bodies** are never stored in Postgres. `content_item` holds metadata only, and the text
  goes to the memory store.
- **Plaintext columns.** Plaintext columns hold ids, enums, counts, provider references and account metadata. **Two
  user-entered values are plaintext. See OI-8:** `upload.filename` and `exclusion_rule.value`.
- **Better Auth `account` tokens** use Better Auth's own `encryptOAuthTokens` (`apps/web/lib/auth.ts:96`), keyed from
  `BETTER_AUTH_SECRET` and not the versioned keyring. This is acceptable only because they are nulled (section 4). See
  OI-4 for the window where they are not.

## 4. Provider tokens nulled; `mailbox_credential` never serialized (FR-005)

- **`id_token`** is nulled on account create and update (`apps/web/lib/auth.ts:121`, `:157`).
- **Access and refresh tokens and expiries** (`NULLED_PROVIDER_TOKENS`, `auth.ts:20-25`) are nulled:
  - right after sign-up (`auth.ts:127-128`);
  - on every account update, which covers re-sign-in and re-link (`auth.ts:157`);
  - for a freshly linked identity, in `apps/web/app/api/identities/link/complete/route.ts:54-55`, after the provider
    email lookup, including when that lookup fails.
- Test: `apps/web/test/identities-routes.test.ts:137`. Residual window: OI-4.
- **`mailbox_credential`.** `rg -n "mailboxCredential|mailbox_credential" apps/web` finds no reference outside tests.
  The table is read only in `packages/core/src/services/mail-access.ts`, `sources.ts` and `deletion.ts`. Source
  responses are built by `toSourceView` (`packages/core/src/services/sources.ts:123-135`), which copies an explicit
  field list with no credential or address fields.

## 5. Test-only switches refused in production (constitution VII)

- **`assertProductionSafety`** (`packages/core/src/env.ts:115-124`) runs inside `parseEnv` (`:137`). Under
  `NODE_ENV=production` it rejects `AUTH_TEST_MODE`, `TEST_MEMORY_STORE_URL` and `TEST_IMAP_INSECURE_TLS`, and it
  requires `SUPERMEMORY_API_KEY` and `ANTHROPIC_API_KEY`. Tests: `packages/core/test/env.test.ts:51`, `:59`, `:72`.
- **Defence in depth at each use site:**
  - test mode is `AUTH_TEST_MODE && NODE_ENV !== 'production'` (`apps/web/lib/auth.ts:27`);
  - the mock OAuth server returns 404 unless the same condition holds (`apps/web/app/api/test-oauth/[step]/route.ts:18`,
    `:43`);
  - insecure IMAP TLS needs `NODE_ENV !== 'production'` too (`packages/core/src/services/mail-access.ts:46`);
  - the fake LLM is chosen only under `NODE_ENV=test` / `AUTH_TEST_MODE` (`packages/integrations/src/anthropic/client.ts`,
    `createLlm`).
- **Lint.** The test-only memory bridge `@voicespark/integrations/testing` is import-banned from application source
  (`eslint.config.js:10-13`, `:55-67`).
- **Worker.** Validates at start (`apps/worker/src/index.ts:80`).
- **Web.** Validates at start (`apps/web/instrumentation.ts`, OI-3 fixed). Previously it validated lazily on the first
  request that called `loadEnv()`.

## 6. OAuth state and CSRF

- **Sign-in and identity linking (Better Auth 1.7.12).** Better Auth creates a random state with a PKCE verifier and
  a 10-minute expiry. The state is stored server-side in `verification` and bound to a signed state cookie
  (`node_modules/better-auth/dist/state.mjs`), and the callback URL is origin-validated. Implicit linking is off
  (`auth.ts:99-104`), so a same-email sign-in gets `account_not_linked` and is not merged silently.
- **Mailbox connect.**
  - `startConnect` (`packages/core/src/services/sources.ts:284-312`) creates a random UUID state and an arctic PKCE
    (S256) verifier, and stores both in `oauth_connect_state` (verifier encrypted, `user_id` bound, 10-minute
    `expires_at`).
  - `completeConnect` (`sources.ts:315-345`) rejects a non-UUID state. It then deletes the row with `RETURNING`, so the
    state is single-use and consumed in every outcome. It requires the same user, the same provider and an unexpired
    row; otherwise it returns `oauth_failed`.
  - The verifier is sent on code exchange, and the granted scopes are checked (section 1).
  - Covered by `packages/core/test/connect-state.integration.test.ts` (OI-7).
- **First-party API routes.** There is no explicit CSRF token. They rely on Better Auth's session cookie, whose
  `SameSite=Lax` default `apps/web/lib/auth.ts` does not override. Lax keeps the cookie off cross-site POST, PATCH and
  DELETE. Bodies are parsed as JSON by `parseJson`. The only state-changing GETs are the two OAuth callbacks, which are
  protected by the state checks above.
- **Session gate.** `apps/web/proxy.ts` is an optimistic cookie check only. Authorization is enforced by
  `requireUser` / `requireAdmin` (`apps/web/lib/guards.ts:31`, `:44`) in every handler and layout.

## 7. Rate limits

Command: `rg -n "rateLimit\(" apps/web --glob '!**/test/**'`.

`rateLimit` (`apps/web/lib/http.ts:83-98`) is a sliding window on a Redis sorted set per key. It returns 429 with
`retryAfterSeconds`.

| Surface | Key / limit | Location |
|---|---|---|
| Draft create | `drafts:{user}` 20 / 60 s | `apps/web/app/api/drafts/route.ts:31` |
| Draft regenerate | same bucket | `apps/web/app/api/drafts/[id]/regenerate/route.ts:13` |
| Profile generate | `profile-gen:{user}` 10 / h | `apps/web/app/api/profiles/generate/route.ts:10` |
| Profile regenerate | same bucket | `apps/web/app/api/profiles/[id]/regenerate/route.ts:8` |
| Profile feedback (re-generation) | same bucket | `apps/web/app/api/profiles/[id]/feedback/route.ts:12` |
| File upload | `uploads:{user}` 60 / h | `apps/web/app/api/uploads/route.ts:17` |
| Note upload | same bucket | `apps/web/app/api/notes/route.ts:16` |
| IMAP connect (credential guessing) | `imap-connect:{user}` 10 / h | `apps/web/app/api/sources/imap/route.ts:19` |
| Better Auth endpoints | Better Auth built-in limiter, on by default when `NODE_ENV=production` (`better-auth/dist/context/create-context.mjs:172`), in-memory per process | not configured explicitly |
| Context Hub: record create, edit, delete, merge, email and domain add and remove | `hub-records:{user}` 120 / 60 s | `apps/web/app/api/hub/[kind]/route.ts:34`, `[kind]/[id]/route.ts:35`, `:51`, `[kind]/[id]/merge/route.ts:18`, `[kind]/[id]/emails/route.ts:17`, `emails/[emailId]/route.ts:13`, `[kind]/[id]/domains/route.ts:17`, `domains/[domainId]/route.ts:13` |
| Context Hub: note create, edit, delete | `hub-notes:{user}` 120 / 60 s | `apps/web/app/api/hub/[kind]/[id]/notes/route.ts:33`, `notes/[id]/route.ts:27`, `:41` |
| Context Hub: file upload | `uploads:{user}` 60 / h (shared with uploads and notes) | `apps/web/app/api/hub/[kind]/[id]/files/route.ts:39` |
| Context Hub: file rename, delete | `hub-files:{user}` 120 / 60 s | `apps/web/app/api/hub/files/[id]/route.ts:27`, `:41` |
| Context Hub: link create, role change, delete | `hub-links:{user}` 120 / 60 s | `apps/web/app/api/hub/links/route.ts:18`, `links/[id]/route.ts:15`, `:29` |
| Context Hub: search | `hub-search:{user}` 60 / 60 s | `apps/web/app/api/hub/search/route.ts:26` |
| Context Hub: suggestion decide (up to 200 ids per call) | `hub-suggestions-decide:{user}` 60 / 60 s | `apps/web/app/api/hub/suggestions/decide/route.ts:17` |
| Context Hub: mailbox enable, disable, thread retry | `hub-mailboxes:{user}` 30 / 60 s | `apps/web/app/api/hub/mailboxes/[sourceId]/enable/route.ts:15`, `disable/route.ts:15`, `threads/[threadId]/retry/route.ts:12` |
| Context Hub: ignore rule create, delete | `hub-ignore-rules:{user}` 60 / 60 s | `apps/web/app/api/hub/ignore-rules/route.ts:16`, `ignore-rules/[id]/route.ts:11` |
| Context Hub: sync retry, full re-sync | `hub-sync:{user}` 30 / 60 s | `apps/web/app/api/hub/sync/retry/route.ts:11`, `sync/resync/route.ts:9` |

Every exported `POST`, `PATCH`, `PUT` and `DELETE` under `apps/web/app/api/hub` calls `rateLimit` (checked with a
script over the route files). Hub `GET` routes other than search are not limited. A draft pinned to a record uses
the existing `drafts:{user}` bucket.

`POST /api/profiles/[id]/adjust` is not limited. It does not call the LLM (it stores a manual version after local
inspection), so this is accepted. OAuth connect start is gated by session and filter confirmation, not by a limit.

## 8. Admin isolation (constitution III, FR-045)

- **Lint ban.** `eslint.config.js:68-130` covers the admin files (`apps/web/app/api/admin/**`, `apps/web/app/(admin)/**`,
  `apps/web/components/admin/**`, `services/admin-users.ts`, `services/admin-system.ts`, `packages/db/src/repos/admin/**`).
  It bans:
  - `repos/user`, `integrations/supermemory` and `core/crypto`;
  - the content services (profiles, uploads, content-items, drafts, mail-access, inspection, sources, deletion,
    own-prompts);
  - Context Hub: `@voicespark/core/services/hub`, `services/hub/*`, `@voicespark/core/hub/*`, the relative forms
    (`./hub`, `./hub/*`, `../hub/*`, `**/services/hub/**`) and `@voicespark/db/repos/user/hub*` (`:102-121`);
  - the test bridge.
- **Context Hub: forbidden fields.** `ADMIN_FORBIDDEN_FIELDS` (`apps/web/lib/admin-schemas.ts:26-56`) adds the hub
  content keys `summary`, `evidence`, `participants`, `emails`, `phone`, `domains`, `roleTitle`, `industry`, `website`,
  `extractedText` and `fileName`; `ADMIN_FORBIDDEN_FIELD_PATTERN` (`:57`) still rejects any `_enc` / `Enc` key. Admins
  see the hub only as strict objects of numbers: `hubCounts` on the user detail (`recordCount`, `noteCount`,
  `fileCount`, `pendingSuggestionCount`, `syncFailedCount`, `hubMailboxCount`) and `hubAggregates` on system health
  (`llmCallsToday`, `inputTokensToday`, `outputTokensToday`, `threadsPending`, `threadsFailed`, `syncFailed`)
  (`admin-schemas.ts:70-86`). The token figures are estimates (OI-9).
- **Context Hub: isolation suite.** `apps/web/test/admin-isolation/admin-isolation.test.ts`, with hub rows seeded for
  user U whose every encrypted column carries `ZZ-SECRET-MARKER-H*` (`seed.ts`):
  - every admin response is checked for hub content, for user U's blind search token hashes (`hubTokenHashes`, `:222`)
    and for the forbidden keys (`:545`);
  - "(a') admin hub views are numbers only" (`:601-679`): the `hub` objects accept exactly their number keys, and
    `ADMIN_FORBIDDEN_FIELDS` names every hub content key (`:638`);
  - "(b)" has 28 hub probes (records, emails, domains, links, notes, files and download, mailbox enable, disable and
    retry, ignore rules, sources, merge preview, merge). Each must return 404 `not_found`, write exactly one denied
    audit entry and leave the target row unchanged (`:1128-1145`). Owner-scoped hub lists (records, sync, search,
    suggestions, suggestion count, decide) return only the admin's own rows, with no audit (`:1212-1290`);
  - "(c)" has a lint fixture, `lint-fixtures/admin-imports-hub-service.ts`, that must fail `pnpm lint` (`:1337`).
- **Context Hub: foreign-access audit.** Every hub by-id route that returns 404 for another user's id calls
  `auditForeignAccess` (`apps/web/lib/guards.ts:154`), which writes `admin.content_access_denied` when the actor is an
  admin. `FOREIGN_RESOURCE_TABLES` (`guards.ts:132-144`) adds `hub_person`, `hub_company`, `hub_project`, `hub_note`,
  `hub_file`, `hub_link`, `hub_suggestion`, `hub_thread` and `hub_ignore_rule`. `POST /api/hub/suggestions/decide`
  reports a foreign id as a per-id `not_found` and does not audit it.
- **Response schemas.** `adminJson` (`apps/web/lib/admin-schemas.ts:323-333`) parses every admin response through a
  declared schema after a JSON round-trip, and fails closed (500, logged as `admin_response_schema`) on an undeclared
  field or an unknown route key. `find apps/web/app/api/admin -name route.ts | xargs grep -L adminJson` returns nothing:
  every admin route uses it.
- **Isolation suite (T126).** `apps/web/test/admin-isolation/admin-isolation.test.ts`:
  - every admin (route, verb) pair is schema-valid and content-free (`:452`, `:468`);
  - a foreign-content probe returns 404 plus an audit entry (`:634`, `:651`, `:662`);
  - owner-scoped lists return only the admin's own rows (`:678-707`);
  - the lint ban is wired and has zero findings (`:723`, `:752`).
  It runs in CI (`.github/workflows/ci.yml:82`). Foreign access is audited by `auditForeignAccess`
  (`apps/web/lib/guards.ts:101`).
- **No `*_enc` in admin code.** `rg -n "Enc\b|Enc," packages/db/src/repos/admin apps/web/app/api/admin packages/core/src/services/admin-*.ts`
  finds nothing.
- **Residual gaps:** OI-5 (the ban is import-based). OI-6 (`--passWithNoTests`) is fixed.
- **Deleted admins.** `prompt_template.created_by`, `prompt_template_version.created_by`,
  `prompt_version_history.actor_user_id` and `definition*.created_by` (`packages/db/src/schema/prompts.ts:38`, `:65`,
  `:93`; `definitions.ts:53`, `:71`) are plain uuids with no FK, by design. They keep a deleted admin's uuid, which
  carries no PII once the `user` row is gone. `audit_log_entry.actor_user_id` is `ON DELETE SET NULL`, and `audit.pseudonymize`
  unlinks it (`packages/core/src/services/audit.ts`). Accepted and documented here.

## 9. Secrets absent from the repository

- **Ignored files.** `.env` and `.env.*` (except `.env.example`) and `*.pem` are ignored (`.gitignore`).
- **Scan.** The scan used the provider regexes of the api-keys detector (`packages/filters/src/detectors/api-keys.ts:17-35`)
  plus its `GENERIC_ASSIGNMENT` pattern, as a scratch script over
  `git ls-files --cached --others --exclude-standard` (excluding `specs/`, `.specify/`, `.claude/`, `.codegraph/` and
  the lockfile): 383 files.
- **Non-test hits (9 files).** All are env-variable references or identifiers (`env.BETTER_AUTH_SECRET`,
  `clientSecret: env.*`, `refreshTokenEnc: mailboxCredential.refreshTokenEnc`, `maxTokens`, ...). `.env.example`
  carries the placeholder `replace-with-openssl-rand-base64-32-output`.
- **Test hits.** These are the synthetic credential corpus (`packages/filters/test/corpus/fixtures/**`, research: "synthetic
  positive items") and fixtures reused in integration and e2e tests. They are fake by construction.
- **Result.** No real secret found. Re-run this scan on the first commit with plain `git ls-files`.

## 10. Context Hub: blind search index (constitution VII, FR-011)

Commands:

```sh
rg -n "hmacHex|MAX_PREFIX|MIN_PREFIX|slice\(0, 16\)" packages/core/src/hub/search-tokens.ts
rg -n "hub_search_doc" packages/db/src/schema/hub.ts packages/core/src/services/hub
```

- **What is stored.** `hub_search_doc` (`packages/db/src/schema/hub.ts:592-620`) holds one row per
  `(user_id, item_type, item_id)` with `tokens char(16)[]` (GIN index) and no plaintext. Each token is
  `hmacHex('hubsearch:{userId}:' + s)` cut to 16 hex chars (`hashToken`, `packages/core/src/hub/search-tokens.ts:29-31`),
  keyed with `DEDUP_HMAC_KEY`. Every 2 to 15 char prefix of each word is indexed, plus the full word (cut to 32) when it
  is longer than 15 (`indexTokens`, `:33-50`). The user id in the HMAC input means the same word hashes differently per
  user.
- **Query.** `packages/core/src/services/hub/search.ts` runs one `tokens @>` candidate query limited to the user and
  to 200 rows, decrypts only those candidates and drops hash collisions with `verifyCandidate` (`search-tokens.ts`).
  Snippets come from the user's own decrypted, already filtered text and are returned only to the owner. The query
  string is not logged or stored.
- **Documented leakage** (contracts/hub-search.md "Leakage"; accepted trade-off):
  - With database access but no `DEDUP_HMAC_KEY`: per user, how many distinct hashes each item has and which items
    share hashes. That shows token-frequency patterns and document lengths, not words.
  - With `DEDUP_HMAC_KEY` too: a dictionary attack on the hashes is possible. This is the same trust level as the
    existing `sender_hash` and `message_id_hash`, and as the hub lookup hashes (`address_hash`, `domain_hash`,
    `name_key`, ...). `address_hash` and `domain_hash` carry no user id (`packages/core/src/hub/normalize.ts:79-85`),
    so with the key the same address can be matched across users, as with `sender_hash`.
  - The 64-bit truncation gives collisions; the verify step drops them.
  - **Rotating `DEDUP_HMAC_KEY` needs a full reindex, and there is no reindex job in v1** (OI-13). The same rotation
    also breaks the hub lookup hashes, ignore rules and block markers.
  - Admins have no route to the index. The isolation suite asserts that no admin response contains user U's token
    hashes (section 8).

## 11. Context Hub: filter modes and the contact-details exception (constitution IV, VI, FR-028)

The one exception: emails and phone numbers may reach the extraction call and the email, phone and domain fields of
hub records, even when the user selected `third_party_contacts`. Hub mode skips only the deterministic `contacts`
detector and keeps the From address. Locked categories, the other selected categories, the postal-address sense of
`third_party_contacts`, the user's exclusion rules, credential-delivery exclusion and fail-closed behaviour all still
apply (contracts/filter-hub-mode.md).

| Place | Function | Policy | Code |
|---|---|---|---|
| Extraction call input (`hub.thread`) | `inspectForHubExtraction` | hub mode | `packages/filters/src/hub.ts:41`, called from `inspectThreadForExtraction` (`packages/core/src/services/hub/extraction.ts:301`) |
| Triage call input | `inspect` (normal) | full policy, contacts redacted | `triage`, `extraction.ts:418` |
| Thread subject (stored) | `inspectSegments` | full policy | `storeSubject`, `apps/worker/src/processors/hub-thread.ts:190` |
| Extraction outputs (summary, evidence, names, roles, industry, description, link role) | `inspectSegments` | full policy | `inspectExtractionOutputs`, `extraction.ts:565` |
| Contact values from the model, headers or the user | `validateContactValue` | validity plus the locked, card, bank and government-id detectors | `packages/filters/src/hub.ts:123`; user-typed values also go through `looksSecret` (`packages/core/src/services/hub/records.ts:251-271`), so a secret gives 422 `sensitive_content` |
| Note save and edit, record free-text fields | `inspectSegments` (through `inspectFields`) | full policy | `packages/core/src/services/hub/common.ts:41`, `notes.ts:119`, `records.ts:456` |
| File extracted text | `inspectForUser` (kind `file`) | full policy | `apps/worker/src/processors/hub-file.ts:69`; `hub-refilter.ts:348` on a policy change |
| Memory store documents | `inspectSegments` on every build, then `buildHubDocument` | full policy; contacts only while `third_party_contacts` is not selected, domains always | `packages/core/src/services/hub/doc-builder.ts:67-70`, `packages/filters/src/hub.ts:222`, `:319` |
| Draft record context | `inspectForUser` (kind `note`) of every segment | full policy | `apps/worker/src/processors/draft.ts:63`, `packages/core/src/services/hub/draft-context.ts:80` |

- **Type brands.** `inspectForHubExtraction` returns `HubLlmText`, which no `FilteredText` sink accepts. Only a
  `ContactValue` can be stored as an email, phone or domain. Compile-time test:
  `packages/filters/test/unit/hub-brands.types.test.ts`.
- **Lint.** `no-restricted-syntax` bans importing or re-exporting `inspectForHubExtraction` outside
  `packages/core/src/services/hub/extraction*.ts` and `packages/filters/src/**` (`eslint.config.js:131-145`).
- **Corpus gate.** `pnpm test:corpus` runs `packages/filters/test/corpus/hub-corpus.test.ts` first: 100% recall of
  locked values in hub mode and at least 99% item-level recall over locked and optional items. CI runs it
  (`.github/workflows/ci.yml:37`).

## 12. Context Hub: no mail bodies stored, no content in logs (constitution VI, VII)

- **Schema.** `hub_message` holds only hashes of the message ids, the date, direction and the automated flag
  (`packages/db/src/schema/hub.ts:317-345`). No hub table has a body column. The thread keeps the filtered subject,
  participants and the filtered AI summary, all in `*_enc` columns. The cleaned body exists only in memory during the
  `hub.thread` run and is sent to the AI service only after hub-mode inspection.
- **`hub_llm_call`** holds `purpose`, `model`, `prompt_version`, token counts and `stop_reason` only
  (`hub.ts:416-435`). The token counts are estimates (OI-9).
- **`BODY-SENTINEL` check.** `apps/worker/test/hub-thread.integration.test.ts:1159` ("BODY-SENTINEL appears in no hub
  table, no memory document and no log line; hub_llm_call holds counts only") runs a thread whose body carries
  `BODY-SENTINEL` and asserts that the cleaned body reached the model, and that the sentinel is in no hub table, no
  built summary or person document and no log line. It also asserts that the log has no name, address or subject, and
  that `hub_llm_call` rows have exactly the expected columns. `apps/worker/test/hub-ingest.integration.test.ts` checks
  the same for ingest. The e2e specs `hub-us3-email` and `hub-us4-suggestions-merge` check API responses for
  `BODY-SENTINEL-7f3a9c` (`apps/web/e2e/support/hub-mail.ts:129`).
- **Logs.** Hub processors log through `jobLogger` with ids, counts and codes (`SafeLogFields`, section 2). Hub errors
  carry codes only (`HubExtractionError`, `ThreadError`, `BlobStoreError`).

## 13. Context Hub: audit actions (FR-048)

Every hub action has a strict per-action metadata schema in `AUDIT_METADATA_SCHEMAS`
(`packages/core/src/services/audit.ts:49-58`): ids, slugs and counts only, never names or content.

| Action | Metadata |
|---|---|
| `hub.mailbox_enabled` | `{sourceId, consentTextVersion}` |
| `hub.mailbox_disabled` | `{sourceId, hubData: keep \| delete}` |
| `hub.mailbox_data_deleted` | `{sourceId, threads, records, links, values}` |
| `hub.record_deleted` | `{kind, notes, files, links}` |
| `hub.records_merged` | `{kind}` |
| `hub.suggestions_bulk_decided` | `{accepted, rejected, failed}` |
| `hub.ignore_rule_created`, `hub.ignore_rule_deleted` | `{kind}` |
| `hub.resync_requested` | `{items}` |
| `hub.file_excluded` | `{category}` |

Admin probes of hub ids write the existing `admin.content_access_denied` (section 8). Changes to
`hub.daily_thread_cap_per_user` write the existing `settings.changed` (`{key}`).

## Open issues

| ID | Severity | Finding | Where | Suggested fix |
|---|---|---|---|---|
| OI-1 | Medium (**Fixed**) | The worker logs `errorCode: err.message` for every failed job. drizzle-orm 0.45.4 `DrizzleQueryError` puts the SQL text **and its parameters** in `message` (`node_modules/drizzle-orm/errors.js`), so a failed query can write plaintext values to the log: `exclusion_rule.value`, `connected_source.account_address`, `sign_in_identity.provider_email`, upload filenames, and ciphertexts. BullMQ also persists the same message as `failedReason` in Redis for 7 days (`removeOnFail: { age: 604800 }`, `packages/core/src/queues/index.ts:94`). Provider SDK errors (imapflow server responses, Gmail/Graph bodies) are also free text. This breaks "logs MUST NOT contain content or excluded values". | `apps/worker/src/index.ts:57-62` | Log `err.name` or a mapped code (an `AppError` code / `UnrecoverableError` literal when it matches `^[a-z0-9_]+$`, otherwise `'internal_error'`). Throw sanitized errors from processors, or wrap the handler so the BullMQ `failedReason` is a code too. Narrow `SafeLogFields.errorCode` to a code-shaped template type. **Fixed:** `dispatch()` in `apps/worker/src/index.ts` logs `toErrorCode(err)` and rethrows `toSafeError(err)` (`apps/worker/src/error-code.ts`): an `AppError`/`DeletionError` code, a message that is already a safe code (`^[a-z][a-z0-9_]{0,63}$`), a known error class name, or `pg_<SQLSTATE>`, otherwise `'internal_error'`. BullMQ `failedReason` therefore carries only the code; `UnrecoverableError` semantics and BullMQ signals (`DelayedError` etc.) are kept. `toErrorCode` lives in `packages/core/src/error-code.ts` (`@voicespark/core/error-code`) and is also used by `packages/core/src/cli.ts`, which previously printed `err.message` to the operator's terminal. Tests: `apps/worker/test/error-code.test.ts`. |
| OI-2 | Low (**Fixed**) | pino redact paths `*_enc` / `*.*_enc` are no-ops (no partial-key wildcard in fast-redact), and camelCase `accessToken`, `refreshToken`, `imapPasswordEnc`, `codeVerifierEnc` are not listed. Typing is the real control, so this is defence in depth only. | `packages/core/src/logger.ts:42-57` | List the concrete keys (snake and camel case) or add a `formatters.log` that drops any key ending in `_enc`/`Enc`/`Token`. Add a unit test that logs such keys and asserts `[redacted]`. **Fixed:** `REDACT_PATHS` now lists every `*Enc`/`*_enc` column from `packages/db/src/schema` plus camelCase and snake_case token/password/secret/apiKey/authorization/cookie keys at top level, one and two levels deep, and a `formatters.log` / child-bindings scrubber (`scrubSecrets`, `SECRET_KEY_PATTERN`) censors any key ending in `_enc`/`Enc`/`token`/`password`/`secret`/`cookie`/`authorization`/`apiKey` at any depth (`packages/core/src/logger.ts`). Test: `packages/core/test/logger.redact.test.ts`. |
| OI-3 | Low (**Fixed**) | The web app checks production safety lazily (first `loadEnv()` call), not at startup. Requests fail closed, but the container reports healthy and the runbook statement is wrong for web. | `apps/web` (no `instrumentation.ts`), `docs/runbook.md` "Deploy and configuration" | Add `apps/web/instrumentation.ts` with `register()` calling `loadEnv()` under `NEXT_RUNTIME === 'nodejs'`. **Fixed:** `apps/web/instrumentation.ts` `register()` calls `loadEnv()` + `assertProductionSafety()` under `NEXT_RUNTIME === 'nodejs'` at server start (skipped during `next build`); runbook updated. |
| OI-4 | Low | A linked identity's access and refresh tokens stay in `account` (Better Auth encryption, not the keyring) if the browser never reaches `/api/identities/link/complete`, or if the account lookup there throws before the nulling update. Nothing sweeps them later. | `apps/web/lib/auth.ts:142-152`, `apps/web/app/api/identities/link/complete/route.ts:29-55` | Add a maintenance job that nulls `account` token columns older than ~15 minutes, or null them in the `account.create.after` hook once the email has been read from the provider profile. |
| OI-5 | Low | The admin import ban does not cover the `@voicespark/db` root, which exports every table, including content columns (`draft.briefEnc`, `profileVersion.bodyEnc`). `admin-users.ts` already imports tables from there. A `select` of a content column in admin code would pass lint and fail only at runtime (adminJson / isolation suite), and only if the value reached a response. The Context Hub count repo `packages/db/src/repos/admin/hub-counts.ts` imports hub tables (`hubPerson`, `hubFile`, ...) from the same root to count rows, so the same gap covers hub content columns. | `eslint.config.js:68-130` | Add `no-restricted-imports` `importNames` for the content tables (`draft`, `profileVersion`, `mailboxCredential`, `oauthConnectState`, `deletionRequest`, ...) from `@voicespark/db` in admin files, or a `no-restricted-syntax` rule on `MemberExpression[property.name=/Enc$/]`. |
| OI-6 | Low (**Fixed**) | `test:admin-isolation` runs `vitest ... --passWithNoTests`, so a moved or renamed suite turns the CI gate green silently. | `apps/web/package.json:13` | Drop `--passWithNoTests` for this project, or assert a minimum test count. **Fixed:** `--passWithNoTests` removed from `test:admin-isolation` (`apps/web/package.json`). |
| OI-7 | Low (test gap) — closed | `completeConnect`'s state checks (other user's state, provider mismatch, expired state, replay of a consumed state, plus unknown/malformed state) are covered by `packages/core/test/connect-state.integration.test.ts`, run against the test DB with the code exchange and Gmail profile lookup stubbed. Every case is refused with `oauth_failed`, writes no `connected_source` or `mailbox_credential` rows and consumes the state. No bug was found, so `sources.ts` is unchanged. | `packages/core/src/services/sources.ts:315-330` | Done: covered by `packages/core/test/connect-state.integration.test.ts`. |
| OI-8 | Decision needed | Two user-entered values are stored in plaintext: `upload.filename` (stored before inspection, so it may contain what the filter would exclude) and `exclusion_rule.value` (senders, domains and keywords the user wants excluded). Constitution VII requires "user content columns" to be encrypted. Neither is shown to admins (admin schemas). | `packages/db/src/schema/uploads.ts:25`, `rules.ts:23` | Product decision: either encrypt both (`exclusion_rule` needs an HMAC column for the unique index and matching), or record them as metadata in the constitution check. |
| OI-9 | Low (accuracy) | `hub_llm_call.input_tokens` / `output_tokens` are estimates from character counts (`estimateTokens`, `packages/core/src/services/hub/extraction.ts:44`, `:361`), because the LLM client does not return usage. The admin aggregates `inputTokensToday` / `outputTokensToday` and any cost estimate built on them are approximate. No security impact. | `extraction.ts:466-467`, `:501-502` | Return `usage` from `parseStructured` and store the real counts. |
| OI-10 | Low | The enum constraints of the extraction output are not enforced by the API: the SDK keeps them only in the field descriptions of the JSON schema sent with the call. They are enforced after the call by the zod `hubExtractionSchema` parse (`z.enum`, `packages/core/src/hub/extraction-schema.ts:95-159`); a failed parse gets one retry, then the thread fails with a code. Nothing invalid is applied. | `packages/core/src/hub/extraction-schema.ts` | Accepted. Keep the post-parse; revisit when the API enforces enums. |
| OI-11 | Low (functional) | Microsoft Graph `webLink` is not wired: `webLinkFor` returns a link only for Gmail (`apps/worker/src/hub-links.ts:4-6`), so Microsoft threads have no "open original" link. data-model.md expects Graph `webLink`. No security impact. | `apps/worker/src/hub-links.ts` | Read `webLink` from the Graph message (read-only, `Mail.Read` covers it) and pass it to `recordMessage`. |
| OI-12 | Low | Tombstone rows stay in `hub_sync_item` after the document delete is confirmed (`deleted = true`, `status = stored`; `completeStored`, `packages/db/src/repos/user/hub-sync.ts:107`). They hold ids and the doc id only, no content, and are excluded from the status view (`packages/core/src/services/hub/sync.ts:272-287`). They are removed with the account. contracts/memory-store-hub.md says a tombstone keeps the row "until the document delete is confirmed". | `packages/db/src/repos/user/hub-sync.ts` | Delete the row once a tombstone is stored, or add a sweep for confirmed tombstones. |
| OI-13 | Decision needed | Rotating `DEDUP_HMAC_KEY` needs a full reindex of `hub_search_doc` (and new lookup hashes, ignore rules and block markers). There is no reindex job in v1 (contracts/hub-search.md "Leakage"). | `packages/core/src/hub/search-tokens.ts`, `packages/core/src/hub/normalize.ts` | Do not rotate `DEDUP_HMAC_KEY` in v1 (runbook). Add a reindex job before any rotation. |
| OI-14 | Low | `hub_file.sha256` is an unkeyed SHA-256 of the plaintext file (`packages/core/src/services/hub/files.ts:200`). Someone with database access can confirm that a user holds a known file. | `packages/db/src/schema/hub.ts:248` | Use `hmacHex` (keyed) for the duplicate check, or drop the column if it is not needed. |
| OI-15 | Low (functional) | A draft pinned to a record that was later merged into another record shows the record as removed: the draft record context reads the pinned id only and does not follow `hub_merge_redirect` (`packages/core/src/services/hub/draft-context.ts:80`, status `missing`). No content leaks; the draft is generated without the context. | `packages/core/src/services/hub/draft-context.ts` | Resolve the pinned id through `hub_merge_redirect` before loading the record. |

Not issues, recorded for completeness:

- A Microsoft grant that fails `assertMinimalScopes` is discarded but not revoked, because Graph has no per-grant revoke
  endpoint for delegated tokens. Google grants are revoked.
- **Fixed.** The production mailer silently falls back to `jsonTransport` when `SMTP_URL` is unset
  (`packages/integrations/src/smtp/mailer.ts:15-21`). `assertProductionSafety` now requires `SMTP_URL` and a non-placeholder
  `MAIL_FROM` in production (`packages/core/src/env.ts`, test `packages/core/test/env.test.ts`), so that fallback can no
  longer be reached in production. Documented in `docs/runbook.md` and `README.md`.

## Re-running this review

Re-run every command above on each release, update the dates, results and line references, and move fixed open issues
into a "Resolved" list with the commit that fixed them.
