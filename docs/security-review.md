# Security review

The per-release security review that the constitution requires (Development Workflow & Quality Gates: scopes, logging,
encryption, admin isolation, rate limits and OAuth state handling), plus the T164 checks. Each section names what was
checked, how, and the result, with file and line references. Anything that does not fully hold is listed under
[Open issues](#open-issues). It is not glossed over in the sections.

- Reviewed: 2026-10-22, against the working tree (the repository has no commits yet, so the file list below comes from
  `git ls-files --cached --others --exclude-standard`, not `git ls-files`).
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
  (`mailbox-credentials`, `user-content`, `upload-staging`) are derived in `packages/core/src/crypto/keyring.ts`.
  Decryption resolves the key by `kid`, which allows rotation.
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

`POST /api/profiles/[id]/adjust` is not limited. It does not call the LLM (it stores a manual version after local
inspection), so this is accepted. OAuth connect start is gated by session and filter confirmation, not by a limit.

## 8. Admin isolation (constitution III, FR-045)

- **Lint ban.** `eslint.config.js:68-115` covers the admin files (`apps/web/app/api/admin/**`, `apps/web/app/(admin)/**`,
  `apps/web/components/admin/**`, `services/admin-users.ts`, `services/admin-system.ts`, `packages/db/src/repos/admin/**`).
  It bans:
  - `repos/user`, `integrations/supermemory` and `core/crypto`;
  - the content services (profiles, uploads, content-items, drafts, mail-access, inspection, sources, deletion);
  - the test bridge.
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

## Open issues

| ID | Severity | Finding | Where | Suggested fix |
|---|---|---|---|---|
| OI-1 | Medium (**Fixed**) | The worker logs `errorCode: err.message` for every failed job. drizzle-orm 0.45.4 `DrizzleQueryError` puts the SQL text **and its parameters** in `message` (`node_modules/drizzle-orm/errors.js`), so a failed query can write plaintext values to the log: `exclusion_rule.value`, `connected_source.account_address`, `sign_in_identity.provider_email`, upload filenames, and ciphertexts. BullMQ also persists the same message as `failedReason` in Redis for 7 days (`removeOnFail: { age: 604800 }`, `packages/core/src/queues/index.ts:94`). Provider SDK errors (imapflow server responses, Gmail/Graph bodies) are also free text. This breaks "logs MUST NOT contain content or excluded values". | `apps/worker/src/index.ts:57-62` | Log `err.name` or a mapped code (an `AppError` code / `UnrecoverableError` literal when it matches `^[a-z0-9_]+$`, otherwise `'internal_error'`). Throw sanitized errors from processors, or wrap the handler so the BullMQ `failedReason` is a code too. Narrow `SafeLogFields.errorCode` to a code-shaped template type. **Fixed:** `dispatch()` in `apps/worker/src/index.ts` logs `toErrorCode(err)` and rethrows `toSafeError(err)` (`apps/worker/src/error-code.ts`): an `AppError`/`DeletionError` code, a message that is already a safe code (`^[a-z][a-z0-9_]{0,63}$`), a known error class name, or `pg_<SQLSTATE>`, otherwise `'internal_error'`. BullMQ `failedReason` therefore carries only the code; `UnrecoverableError` semantics and BullMQ signals (`DelayedError` etc.) are kept. `toErrorCode` lives in `packages/core/src/error-code.ts` (`@voicespark/core/error-code`) and is also used by `packages/core/src/cli.ts`, which previously printed `err.message` to the operator's terminal. Tests: `apps/worker/test/error-code.test.ts`. |
| OI-2 | Low (**Fixed**) | pino redact paths `*_enc` / `*.*_enc` are no-ops (no partial-key wildcard in fast-redact), and camelCase `accessToken`, `refreshToken`, `imapPasswordEnc`, `codeVerifierEnc` are not listed. Typing is the real control, so this is defence in depth only. | `packages/core/src/logger.ts:42-57` | List the concrete keys (snake and camel case) or add a `formatters.log` that drops any key ending in `_enc`/`Enc`/`Token`. Add a unit test that logs such keys and asserts `[redacted]`. **Fixed:** `REDACT_PATHS` now lists every `*Enc`/`*_enc` column from `packages/db/src/schema` plus camelCase and snake_case token/password/secret/apiKey/authorization/cookie keys at top level, one and two levels deep, and a `formatters.log` / child-bindings scrubber (`scrubSecrets`, `SECRET_KEY_PATTERN`) censors any key ending in `_enc`/`Enc`/`token`/`password`/`secret`/`cookie`/`authorization`/`apiKey` at any depth (`packages/core/src/logger.ts`). Test: `packages/core/test/logger.redact.test.ts`. |
| OI-3 | Low (**Fixed**) | The web app checks production safety lazily (first `loadEnv()` call), not at startup. Requests fail closed, but the container reports healthy and the runbook statement is wrong for web. | `apps/web` (no `instrumentation.ts`), `docs/runbook.md` "Deploy and configuration" | Add `apps/web/instrumentation.ts` with `register()` calling `loadEnv()` under `NEXT_RUNTIME === 'nodejs'`. **Fixed:** `apps/web/instrumentation.ts` `register()` calls `loadEnv()` + `assertProductionSafety()` under `NEXT_RUNTIME === 'nodejs'` at server start (skipped during `next build`); runbook updated. |
| OI-4 | Low | A linked identity's access and refresh tokens stay in `account` (Better Auth encryption, not the keyring) if the browser never reaches `/api/identities/link/complete`, or if the account lookup there throws before the nulling update. Nothing sweeps them later. | `apps/web/lib/auth.ts:142-152`, `apps/web/app/api/identities/link/complete/route.ts:29-55` | Add a maintenance job that nulls `account` token columns older than ~15 minutes, or null them in the `account.create.after` hook once the email has been read from the provider profile. |
| OI-5 | Low | The admin import ban does not cover the `@voicespark/db` root, which exports every table, including content columns (`draft.briefEnc`, `profileVersion.bodyEnc`). `admin-users.ts` already imports tables from there. A `select` of a content column in admin code would pass lint and fail only at runtime (adminJson / isolation suite), and only if the value reached a response. | `eslint.config.js:68-115` | Add `no-restricted-imports` `importNames` for the content tables (`draft`, `profileVersion`, `mailboxCredential`, `oauthConnectState`, `deletionRequest`, ...) from `@voicespark/db` in admin files, or a `no-restricted-syntax` rule on `MemberExpression[property.name=/Enc$/]`. |
| OI-6 | Low (**Fixed**) | `test:admin-isolation` runs `vitest ... --passWithNoTests`, so a moved or renamed suite turns the CI gate green silently. | `apps/web/package.json:13` | Drop `--passWithNoTests` for this project, or assert a minimum test count. **Fixed:** `--passWithNoTests` removed from `test:admin-isolation` (`apps/web/package.json`). |
| OI-7 | Low (test gap) — closed | `completeConnect`'s state checks (other user's state, provider mismatch, expired state, replay of a consumed state, plus unknown/malformed state) are covered by `packages/core/test/connect-state.integration.test.ts`, run against the test DB with the code exchange and Gmail profile lookup stubbed. Every case is refused with `oauth_failed`, writes no `connected_source` or `mailbox_credential` rows and consumes the state. No bug was found, so `sources.ts` is unchanged. | `packages/core/src/services/sources.ts:315-330` | Done: covered by `packages/core/test/connect-state.integration.test.ts`. |
| OI-8 | Decision needed | Two user-entered values are stored in plaintext: `upload.filename` (stored before inspection, so it may contain what the filter would exclude) and `exclusion_rule.value` (senders, domains and keywords the user wants excluded). Constitution VII requires "user content columns" to be encrypted. Neither is shown to admins (admin schemas). | `packages/db/src/schema/uploads.ts:25`, `rules.ts:23` | Product decision: either encrypt both (`exclusion_rule` needs an HMAC column for the unique index and matching), or record them as metadata in the constitution check. |

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
