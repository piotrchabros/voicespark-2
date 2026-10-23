# Provider verification and launch checklist

External approvals and live checks that must be finished before public launch (T168; plan.md Technical Context;
research R4, R5). None of them blocks building or testing: development and CI use the mock OAuth server, GreenMail, the
in-memory or RPC memory store and a fake LLM.

**No real provider credentials exist in this environment.** Nothing below has been started or run against a live
service. Every status is `not started` and every owner is `TBD - product owner` until assigned.

## Summary

| # | Item | Owner | Lead time (estimate) | Blocks | Status |
|---|---|---|---|---|---|
| 0 | Public legal pages: privacy policy, terms, data deletion instructions | TBD - product owner | 1-2 weeks (legal review) | 1, 2, 4, 5 | not started |
| 1 | Google OAuth verification for `gmail.readonly` (restricted scope) | TBD - product owner | 4-8 weeks after submission | Gmail beyond 100 test users | not started |
| 1a | CASA Tier 2 security assessment (part of 1), renewed every 12 months | TBD - product owner | 2-6 weeks, paid assessor | 1 | not started |
| 2 | Google sign-in client brand verification (non-sensitive scopes) | TBD - product owner | 2-5 business days | Google sign-in consent screen branding | not started |
| 3 | Microsoft publisher verification and admin-consent guidance for `Mail.Read` | TBD - product owner | 1-2 weeks (Partner Program enrolment first) | Outlook / Microsoft 365 mailboxes in other tenants | not started |
| 4 | Apple Services ID, domain and return URL, Private Email Relay | TBD - product owner | 1-3 days | Sign in with Apple; mail to relay addresses | not started |
| 5 | Facebook app review / Live mode for `email` | TBD - product owner | 1-2 weeks (business verification may add more) | Facebook sign-in for the public | not started |
| 6 | Supermemory live contract run (self-hosted v3; v5 legacy) | TBD - product owner | 1 day once a key exists | Real imports and deletion verification | not started |
| 7 | Anthropic live smoke | TBD - product owner | 1 day once a key exists | Profiles, drafts, classifier | not started |
| 8 | Production configuration checks (SMTP, domain, keys) | TBD - product owner | 1 day | Deletion confirmations and notifications | not started |

Lead times are planning estimates from the providers' published guidance as understood at the time of writing. Re-check
them when each item is started.

## 0. Legal pages (prerequisite)

`find apps/web/app -type d | rg -i "privacy|terms|legal"` finds nothing: the app has no privacy policy, terms or
data-deletion page yet. Google, Facebook and Apple all require these URLs on the verified production domain.

- [ ] Privacy policy at `https://<APP_DOMAIN>/privacy`. It must name the Gmail and Graph data used, the purpose
  (building the user's writing-style profile), storage, filtering, retention, deletion (24 h SLA) and the Google API
  Services User Data Policy "Limited Use" commitments.
- [ ] Terms of service at `https://<APP_DOMAIN>/terms`.
- [ ] Data deletion instructions at `https://<APP_DOMAIN>/privacy#deletion` (Facebook requires a URL or a callback).
- [ ] Home page on the same domain that describes the app and links to all of the above.

## 1. Google: `gmail.readonly` restricted-scope verification

Mailbox access uses its own OAuth client (`GOOGLE_MAIL_CLIENT_ID`), separate from sign-in, and requests only
`https://www.googleapis.com/auth/gmail.readonly` (`packages/integrations/src/oauth/mail-oauth.ts:19-20`).

- **Testing mode.** Until verification is approved, the app stays in Testing mode: at most **100 test users**, each
  added by hand in the consent screen settings. Refresh tokens expire after 7 days in Testing mode, so test mailboxes
  go to `needs_reconnection` weekly. This is expected.
- **Restricted scope.** Verification for a restricted scope needs brand verification plus a security assessment
  (**CASA Tier 2**) by an authorised lab. The assessment must be **renewed every 12 months**, or Gmail access is
  revoked.

Checklist:

- [ ] Production domain verified in Google Search Console and added as an authorised domain.
- [ ] Consent screen: app name, logo, support email, home, privacy and terms URLs (section 0).
- [ ] Redirect URI `https://<APP_DOMAIN>/api/sources/connect/gmail/callback` (`mailRedirectUri`, `mail-oauth.ts:27-29`).
- [ ] Scope justification submitted (text below).
- [ ] Demo video uploaded (unlisted YouTube; script below).
- [ ] CASA Tier 2:
  - choose an assessor from the App Defense Alliance list;
  - scope it to the web app and worker;
  - provide `docs/security-review.md` and the CI evidence;
  - fix findings;
  - record the letter of validation date and **diary the renewal 11 months later**.
- [ ] After approval, switch the publishing status to In production.

**Scope justification (draft):**

> VoiceSpark builds a private model of how the user writes so it can draft new posts in their voice. With the user's
> explicit consent, and for a date range the user chooses, it reads the user's messages (excluding Spam, Trash and
> Drafts) and the messages the user sent. Every message is screened for credentials and sensitive data before anything
> is stored, and excluded content is never stored. `gmail.readonly` is the narrowest scope that provides message bodies:
> `gmail.metadata` has no body text, and the app never sends, modifies, labels or deletes mail. The data is used only to
> provide this feature to the same user. It is not used for advertising, not sold, and not used to train generalised
> models. The user can disconnect, delete imported content or delete their account at any time, and deletion completes
> within 24 hours.

**Demo video script (about 3 minutes, production build, English UI):**

1. Show the browser address bar with the production domain. Sign in with Google and show the sign-in consent screen
   (`openid email profile` only).
2. Open Sources and choose Gmail. Show the in-app consent summary (`CONSENT_SUMMARY.gmail`, `mail-oauth.ts:143-153`) and
   the date range picker.
3. Continue to Google. Show the OAuth consent screen with the app name, the client id visible in the URL, and the single
   "Read your email messages and settings" permission. Approve it.
4. Back in the app, show the import progress and the exclusion summary (categories and counts only).
5. Generate a writing-style profile and a draft to show the use of the data.
6. Show Disconnect and "Delete imported content", then account deletion and the deletion confirmation.
7. Show revoking access at myaccount.google.com.

## 2. Google sign-in client

The sign-in client (`GOOGLE_SIGNIN_CLIENT_ID`) requests only `openid email profile` (`apps/web/lib/auth.ts:17`, `:62-63`).
These are non-sensitive scopes, so only brand verification is needed. It is a separate project or client from item 1,
so sign-in never waits on CASA.

- [ ] Consent screen branding and the legal URLs from section 0.
- [ ] Redirect URI `https://<APP_DOMAIN>/api/auth/callback/google`.

## 3. Microsoft: publisher verification and `Mail.Read` consent

Mailbox access uses a separate app registration (`MICROSOFT_MAIL_*`, tenant `common`) with the delegated scopes
`Mail.Read offline_access User.Read` (`mail-oauth.ts:21`). Sign-in uses a different registration with
`openid email profile` (`auth.ts:73-82`).

- **Publisher verification.** Without it, a multi-tenant app shows as "unverified" on the consent prompt, and many
  organisations block user consent to unverified apps. The registration has to be tied to a Microsoft AI Cloud
  Partner Program (formerly MPN) account whose domain matches the publisher domain.
- **Admin consent.** `Mail.Read` is a delegated permission that users can normally consent to. Tenants with the
  "user consent disabled" or "verified publishers only" policy need an administrator to grant it. The connect error page
  and the help text should tell work and school users to ask their admin, and include the admin-consent URL
  `https://login.microsoftonline.com/{tenant}/adminconsent?client_id=<MICROSOFT_MAIL_CLIENT_ID>`.

Checklist:

- [ ] Partner Program enrolment complete; Partner ID available.
- [ ] Publisher domain verified (`.well-known/microsoft-identity-association.json` on the production domain).
- [ ] Publisher verification completed on **both** registrations (mail and sign-in).
- [ ] Redirect URIs:
  - `https://<APP_DOMAIN>/api/sources/connect/microsoft/callback`;
  - `https://<APP_DOMAIN>/api/auth/callback/microsoft`.
- [ ] Branding: logo, home, privacy and terms URLs from section 0.
- [ ] Admin-consent guidance added to the user docs (and to the UI if needed).
- [ ] Live check on a personal Microsoft account and on a work tenant that has the user-consent restriction enabled.

## 4. Apple: Services ID and domain

Sign in with Apple needs a public HTTPS domain even in development (plan.md: use a tunnel). It requests `name email`
(`auth.ts:65-72`). The client secret is a JWT generated and refreshed from `APPLE_TEAM_ID`, `APPLE_KEY_ID` and
`APPLE_PRIVATE_KEY` (`apps/web/lib/apple-secret.ts`).

- [ ] App ID with Sign in with Apple enabled; a Services ID whose identifier is `APPLE_CLIENT_ID`.
- [ ] Domain `<APP_DOMAIN>` and return URL `https://<APP_DOMAIN>/api/auth/callback/apple` registered on the Services ID.
  Complete any domain verification the developer portal asks for.
- [ ] Sign in with Apple key created; `.p8` stored only in the production secret store as `APPLE_PRIVATE_KEY`.
- [ ] **Private Email Relay.** Users who hide their email get an `@privaterelay.appleid.com` address. The app sends mail
  (deletion confirmations, notifications) through `SMTP_URL` / `MAIL_FROM`, so register the sending domain or `MAIL_FROM`
  address under "Sign in with Apple for Email Communication" and make sure SPF passes. Otherwise Apple drops these emails.
- [ ] Live check: sign in, hide-my-email sign in, and receive a deletion confirmation on a relay address.

## 5. Facebook: `email`

Facebook sign-in requests `email public_profile` (`auth.ts:83-90`). At the time of writing both are standard-access
permissions. Confirm in the App Dashboard whether App Review is required for `email`, and complete it if it is. Going
Live is required in any case.

- [ ] Business verification (if the dashboard asks for it).
- [ ] App settings:
  - privacy policy URL;
  - terms URL;
  - **data deletion instructions URL** (section 0);
  - app icon and category.
- [ ] Valid OAuth redirect URI `https://<APP_DOMAIN>/api/auth/callback/facebook`.
- [ ] App Review submission for `email` if required, with a screencast of the sign-in flow.
- [ ] Switch the app to Live mode.
- [ ] Live check:
  - an account with a verified email;
  - an account without one. Linking must work for Facebook's unverified email, as implemented in D-C2
    (`trustedProviders`, `auth.ts:99-104`).

## 6. Supermemory: live contract checklist

The adapter (`packages/integrations/src/supermemory/adapter.ts`) is written against the published SDK v5 docs and **has
never run against the live API**. The contract suite runs the same cases against the in-memory store, the RPC store
and, only when a key is set, the live adapter (`packages/integrations/test/supermemory.contract.test.ts:182-187`).
Until a key is available, all behaviours below are unverified assumptions. This is a follow-up.

The default adapter is now the self-hosted v3 REST adapter (`packages/integrations/src/supermemory/adapter-v3.ts`),
selected by `SUPERMEMORY_API_VERSION=v3`. Its contract run is always on against a fake server. The live run is gated on
`SUPERMEMORY_V3_TEST_URL`. The v5 checklist below applies only to `SUPERMEMORY_API_VERSION=v5`. The v5 live run now also
needs `SUPERMEMORY_API_VERSION=v5`.

Run the v3 suite against a dedicated test key or instance, never the production one, because it creates and deletes
namespaces:

```sh
SUPERMEMORY_V3_TEST_URL=https://supermemory.voicespark.ai SUPERMEMORY_V3_TEST_KEY=<key> \
  pnpm --filter @voicespark/integrations exec vitest run --project unit test/supermemory.contract.test.ts
```

v3 assumptions to check and record:

- [ ] **Content.** `GET /v3/documents/{customId}` returns the original text verbatim in `content`.
- [ ] **Metadata-only PATCH.** `PATCH` with only `metadata` is accepted. Keys merge, arrays are replaced.
- [ ] **Scoping.** `POST /v3/documents/list` with `containerTags` returns only that namespace.
- [ ] **Search ids.** `documentId` in search results equals the `customId`.
- [ ] **Memories cascade.** Deleting a document also removes its memories (`/v4/memories/list` is empty afterwards).
- [ ] **Namespace delete.** `DELETE /v3/container-tags/{tag}` returns 200, or 403 when the key is not an org owner or
  admin. On 403 the adapter falls back to list and delete.
- [ ] **Boolean filters.** Boolean metadata values work in filters.

The v5 checklist follows.

Run against a dedicated test project key, never the production one, because the suite creates and deletes namespaces:

```sh
SUPERMEMORY_API_KEY=<test key> [SUPERMEMORY_BASE_URL=...] \
  pnpm --filter @voicespark/integrations exec vitest run --project unit test/supermemory.contract.test.ts
```

Check each assumption and record the result here. If one is wrong, fix the adapter and the contract
(`specs/001-personal-brand-voice/contracts/supermemory.md`) together.

- [ ] **Content field.**
  - Assumption: `documents.get` returns the original text in `content`, verbatim (adapter `:79-80`; test "returns
    verbatim content from getDocument").
  - Check: whether `content` is empty while the document is `queued`/`processing`. Ingestion is asynchronous, so the
    test may need to poll until status `done`.
  - Check: that `summary` or `title` never stand in for `content`.
- [ ] **`searchMode: 'chunks'`.**
  - Assumption: the namespaced search accepts `searchMode: 'chunks'` (adapter `:6`, `:113`) and returns results with a
    `chunk` field.
  - If it returns `memory` results instead, the adapter falls back to `r.memory` (`:121`), which is extracted text, not
    source text, and the profile pipeline would quietly degrade. Make the test assert that `chunk` is present.
- [ ] **Metadata update: merge or replace.**
  - The adapter calls `documents.update(ns, id, { metadata })` (`:146-148`). The contract text says "re-add with the same
    id". Confirm which one the code relies on.
  - Confirm whether `update` replaces the metadata object or merges it key by key.
  - Confirm that an array value (`vs_source_ids`) is replaced, not unioned. Source deletion depends on removing one
    source id from a shared document (test "updates document metadata in place").
  - Also confirm that re-adding with the same `id` (test "re-adding the same id is idempotent") does not duplicate
    chunks.
- [ ] **Async delete.**
  - Check whether `documents.delete` is immediately consistent for `documents.get` and for `list` with an
    `arrayContains` filter (test "verifies deletion" checks straight after the call).
  - If deletion is eventual, the worker's verification step must poll with a bound, and the SLA job's re-queue covers
    the rest. Record the observed delay.
  - Check partial `errors` handling with a deliberately unknown id.
- [ ] **Namespace delete.**
  - Check `namespaces.delete` (`:150-157`): is it synchronous or queued, does a missing namespace return 404, and does
    `list` on the deleted namespace return 404 or an empty list (both are treated as empty)?
  - Record the delay for account deletion.
- [ ] **Memories after delete.**
  - Check that extracted memories cascade from document deletion: `list(ns, 'memories')` must be empty after deleting
    every document (`listMemories`, `:159-167`).
  - If memories survive, account and source deletion must also delete memories explicitly. This is a FR deletion
    requirement, so treat it as a blocker.
- [ ] **Filters and pagination.**
  - Check the `eq` and `arrayContains` filter shapes (`toFilter`, `:35-42`).
  - Check `pagination.currentPage` / `totalPages` (`:100-103`).
- [ ] **Errors.** 401 maps to `MemoryStoreAuthError` (no retry). 429/5xx are retried by the SDK (`maxRetries: 4`).
- [ ] **Namespace isolation.** Test "isolates namespaces". Also confirm that the API key cannot enumerate namespaces the
  app did not create.

## 7. Anthropic: live smoke

Default models come from env: `LLM_PROFILE_MODEL` and `LLM_DRAFT_MODEL` default to `claude-sonnet-5-5`,
`LLM_CLASSIFIER_MODEL` defaults to `claude-haiku-5-5` (`packages/core/src/env.ts:73-78`). The seed uses the same values
(`packages/db/src/seed.ts:242-243`). The client uses structured outputs (`messages.parse`), with streaming for long
outputs, and maps `stop_reason: 'refusal'` to `LlmRefusedError`
(`packages/integrations/src/anthropic/client.ts`).

- [ ] Key created under the production organisation; spend limits and alerts set; `ANTHROPIC_API_KEY` stored only in
  the production secret store.
- [ ] Model ids exist and are enabled for the organisation (a 404 on a model id fails every job).
- [ ] Live classifier corpus run:
  ```sh
  CORPUS_LIVE=1 ANTHROPIC_API_KEY=<key> pnpm --filter @voicespark/filters exec vitest run test/corpus/corpus.test.ts
  ```
  The recall gates must hold with the live model as they do with the recorded fixtures.
- [ ] One profile generation and one draft generation on a staging deploy:
  - structured output parses;
  - the streaming path completes within the job timeout;
  - `drafts:{user}` and `profile-gen:{user}` rate limits behave.
- [ ] Confirm that only filtered or redacted text is sent: spot-check one request body in a staging proxy log. Never
  enable request logging in production.
- [ ] Retention: confirm the organisation's API data retention setting matches the privacy policy.

## 8. Production configuration

- [ ] `NODE_ENV=production`, with `AUTH_TEST_MODE`, `TEST_MEMORY_STORE_URL` and `TEST_IMAP_INSECURE_TLS` unset. Web
  checks this on first request only; see `docs/security-review.md` OI-3.
- [ ] **`SMTP_URL` set.** If it is unset, the mailer silently uses `jsonTransport`, and deletion confirmations and
  notifications are never delivered (`packages/integrations/src/smtp/mailer.ts:15-21`). `assertProductionSafety` does
  not check this.
- [ ] `MAIL_FROM` on a domain with SPF, DKIM and DMARC (and registered with Apple, section 4).
- [ ] `ENCRYPTION_KEYRING` / `ENCRYPTION_ACTIVE_KEY_ID`, `DEDUP_HMAC_KEY` and `BETTER_AUTH_SECRET` generated fresh for
  production and stored outside the repository.
- [ ] `APP_URL` / `BETTER_AUTH_URL` set to the HTTPS production origin. Every redirect URI above matches it exactly.
- [ ] Open issues in `docs/security-review.md` resolved or explicitly accepted (OI-1 before launch).
