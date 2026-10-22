# Quickstart validation record (T166)

Record of running `specs/001-personal-brand-voice/quickstart.md` against the finished feature.

- Date: 2026-10-22
- Result: all runnable steps pass on the re-run after fixes (section 3). Rows that need real third-party services are
  marked below with the substitute evidence, and their open items are listed in section 7.

Two runs were made. The first full checkpoint found three defects (section 4). The second run, after the fixes, is the
record of truth for the results below.

## 1. Environment

| Item | Value |
|---|---|
| Host runtime | Node 22.22 (pnpm workspace) |
| Docker images | `node:24-slim` (web, worker, migrate), `postgres:17`, `redis:7.4` |
| Test containers (`docker-compose.test.yml`) | `postgres:17` on 127.0.0.1:55432, `redis:7.4` on 127.0.0.1:56379, `greenmail/standalone:2.1.2` on 3025 (SMTP), 3143 (IMAP), 3993 (IMAPS) |
| E2E | Playwright, projects `chromium` and `mobile` (mobile runs only the `@ui` specs of sign-in and drafts), 1 worker, 180 s per-test timeout |
| Providers | OAuth providers, Supermemory and the LLM are the in-repo test doubles (mock OAuth endpoints behind `AUTH_TEST_MODE`, `RemoteMemoryStore` test server, stub generator) |

## 2. How the compose stack was run here

Ports 3000, 5432 and 6379 are already used by other services on this host, and production mode refuses to start
without real Supermemory, Anthropic and SMTP settings. The stack was therefore run with a throwaway override file that
is not part of the repo (`final/compose.vs-final.override.yml` in the checkpoint logs):

- Compose project name `vs-final`; web published on 127.0.0.1:3120 (the container listens on 3120 too, so `APP_URL`,
  which the mock OAuth token and userinfo URLs use, resolves from inside); postgres and redis ports not published.
- `NODE_ENV=development` and `AUTH_TEST_MODE=1`, with generated throwaway secrets (not recorded here), empty
  `SUPERMEMORY_API_KEY` and `ANTHROPIC_API_KEY`.
- Production refusal was verified separately: with `NODE_ENV=production` and no provider keys, `loadEnv()` throws
  `Unsafe production configuration: SUPERMEMORY_API_KEY is required in production; ANTHROPIC_API_KEY is required in
  production`, and `next start` exits with code 1 (`final/29-prod-refusal-loadenv.log`,
  `final/30-prod-refusal-start.log`).

Compose steps and results (`final2/`):

| Step | Result | Log |
|---|---|---|
| `docker compose config` | PASS | `12-vs-final-config.log` |
| Image build | PASS | `14-compose-build.log` |
| `up`: postgres, redis, migrate, web, worker | PASS | `15-vs-final-up.log`, `15b-vs-final-ps.log` |
| Migrations inside the stack | PASS ("migrations applied") | `07b-vs-final-migrate.log` |
| Seed | PASS ("seed applied") | `16-vs-final-seed.log` |
| Worker ready (`worker ready`, 9 queues/jobs registered) | PASS | `17-vs-final-worker-ready.log`, `25-vs-final-worker-state.log` |
| Web serving | PASS | `18-vs-final-web.log` |
| `admin:grant` | PASS ("admin role granted") | `22-vs-final-admin-grant.log` |
| HTTP smoke (`smoke-vs-final.sh`) | PASS, 16 passed / 0 failed | `20-vs-final-smoke.log` |
| Redirect origin probe (default Host, spoofed `Host`, spoofed `X-Forwarded-Host`) | PASS, all redirect to `APP_URL` | `20-vs-final-smoke.log` |
| `down` | PASS | `33-vs-final-down.log` |

The smoke script also covers: `/oauth-error` and the sources connect callback (signed out, and signed in with a
cancelled consent) redirecting to `APP_URL`, a non-admin getting 403 `admin_required` on `/api/admin/users`, and
`/admin` signed out redirecting to `/sign-in`.

## 3. Check results (re-run, `final2/`)

| Step | Result |
|---|---|
| Install | PASS |
| Lint | PASS |
| Typecheck (all packages) | PASS |
| Unit tests | PASS: filters 168, integrations 109 (+9 skipped), core 108, worker 6, web 237 |
| Corpus (`test:corpus`) | PASS: recall 100% (467/467 seeded values caught, 336/336 values, 0/240 benign false positives) |
| Test containers | up (postgres, redis, greenmail) |
| Migrate (test database) | PASS |
| Integration tests | PASS: integrations 7, core 143, worker 98 (db, filters and web have no integration files) |
| Admin isolation suite | PASS 23/23 |
| E2E | PASS 49/49 (chromium and mobile), 12.4 min |
| Compose stack | PASS, see section 2 |

Logs: `final2/02-lint.log` through `final2/10-e2e.log`, plus `final2/e2e.json` and `final2/sc-timings.json`.

## 4. Defects found by the first run and their fixes

| # | Defect (first run, `final/`) | Fix |
|---|---|---|
| 1 | The worker container crashed at start: the ESM bundle failed with `Dynamic require of "events" is not supported`, because dependencies were bundled into an ESM output that still contained CommonJS `require` calls. | `tsup` config marks the runtime dependencies as externals, and they are declared as runtime `dependencies` of the worker package so the image installs them. Confirmed by `worker ready` in `final2/17-vs-final-worker-ready.log`. |
| 2 | Redirects (OAuth error, connect callback) were built from the request origin, so a spoofed `Host` or `X-Forwarded-Host` (or the container's internal host) leaked into the `Location` header. | Redirect URLs are built from `APP_URL`. Confirmed by the three-way origin probe in `final2/20-vs-final-smoke.log` (also traced in `final/21-vs-final-redirect-trace.log`, `final/26-oauth-error-origin-probe.log`). |
| 3 | The mobile e2e test "link-account page offers the confirmation for the pending provider" was flaky (asserted before the navigation to `/link-account` finished). | The test waits with `waitForURL` before asserting. Passed on both projects in the re-run (tests 3 and 45). |

No contract discrepancy other than these was reported by the runner.

## 5. Quickstart section 6, row by row

Result legend: PASS = executed here and passed; PASS with stub = passed against a test double for a third party
(mock OAuth provider, in-memory Supermemory test server, stub LLM); NOT RUNNABLE HERE = needs the real service.
E2E names are `apps/web/e2e/<file>` tests; "int" means an integration test under `packages/core/test`,
`apps/web/test` or `packages/integrations/test`.

| Story / SC | Row | Result | Evidence |
|---|---|---|---|
| US1, SC-001 | Sign up with each of Google, Apple, Microsoft, Facebook; sign in again | PASS with stub (mock OAuth); real providers NOT RUNNABLE HERE | `us1-sign-in.spec.ts` "SC-001: sign-up with each provider under a minute; repeat sign-in reuses the account" |
| US1 | Second provider with same email goes to `/link-account`, links after confirmation | PASS with stub | `us1-sign-in.spec.ts` "same email on a second provider goes to /link-account and links only after confirmation"; UI: "link-account page offers the confirmation for the pending provider @ui" (chromium and mobile, both PASS after the `waitForURL` fix) |
| US1 | Apple private relay email, no link offer | PASS with stub | `us1-sign-in.spec.ts` "an Apple private-relay email gets no link offer", "relay identity is shown without its address @ui" |
| US1 | Google sign-in creates no Gmail source | PASS with stub | `us1-sign-in.spec.ts` "Google sign-in creates no Gmail source" |
| US1 | Cancel at consent screen redirects to `/sign-in?error=oauth_cancelled` | PASS (also against the compose stack) | `us1-sign-in.spec.ts` "cancelling at the provider redirects to /sign-in?error=oauth_cancelled", "sign-in page shows the providers and the cancel message @ui"; compose smoke origin probe |
| US1 | Suspended user refused (`account_suspended`) | PASS | `us1-sign-in.spec.ts` "a suspended account is refused with account_suspended" |
| US3, SC-014 | First connect shows checklist with 4 locked and 10 selected; endpoints 409 until confirmed | PASS | `us3-filters.spec.ts` "first connect: 4 locked + 10 selected, and source/upload endpoints are 409 until confirmed", "first upload or connect shows the onboarding checklist @ui" |
| US3 | Unchecking a locked category gives `category_locked` | PASS | `us3-filters.spec.ts` "unchecking a locked category is refused with category_locked" |
| US2, SC-002 | Connect Gmail, Microsoft and IMAP with a date range, progress updates | IMAP: PASS (GreenMail). Gmail and Microsoft: PASS with stub for the consent start and cancel only; real mailbox access NOT RUNNABLE HERE | `us2-mailboxes.spec.ts` "SC-002: an IMAP mailbox with a date range imports under 2 minutes with progress updating", "IMAP connect form shows the import progress @ui", "Gmail and Microsoft connect start a least-privilege consent flow; cancel returns to /sources/connect", "cancelled mailbox consent shows a message on the connect page @ui"; provider API clients covered by `packages/integrations` unit tests with recorded fixtures |
| US2 | Pause then resume, 0 duplicates | PASS | `us2-mailboxes.spec.ts` "pause then resume an import leaves no duplicate content items" |
| US2 | Revoked token gives `needs_reconnection` and `source_needs_reconnection` notification | PASS with stub (revocation simulated at the mock/IMAP side); real provider revocation NOT RUNNABLE HERE | `us2-mailboxes.spec.ts` "a revoked token marks the source needs_reconnection and notifies in-app and by email", "source page explains the lost access @ui" |
| US2 | New email imported within 5 minutes | PASS (within two poll intervals on GreenMail) | `us2-mailboxes.spec.ts` "new mail in a connected mailbox is imported within two poll intervals" |
| US2, SC-002 | Disconnect with "delete data", documents gone in under 2 minutes | PASS with stub (Supermemory test server) | `us2-mailboxes.spec.ts` "SC-002: disconnect with "delete data" removes the documents from the namespace under 2 minutes" |
| US3 seeded mailbox | GreenMail corpus: counts match `expected.json`, 0 seeded values in the store (SC-004/005) | PASS with stub (Supermemory test server list scan) | `us3-filters.spec.ts` "SC-004/005: the corpus mailbox summary matches expected.json and no seeded value reaches the namespace"; corpus suite 467/467, 336/336, 0/240 benign false positives |
| US3 | Keyword rule offers retroscan, confirming purges | PASS | `us3-filters.spec.ts` "a keyword rule offers a retroscan and confirming it purges the matches", "exclusion-rules page offers the retroscan dialog @ui" |
| US3 | Report imported item as sensitive, purged | PASS | `us3-filters.spec.ts` "reporting an imported item as sensitive purges it" |
| US3 | Unselect `payment_cards`, cards kept later, locked categories unchanged | PASS | `us3-filters.spec.ts` "unselecting payment_cards keeps cards in later imports; locked categories still apply" |
| US4 | Upload pdf, docx, txt, md and a note reach `stored` | PASS with stub (store) | `us4-uploads.spec.ts` "pdf, docx, txt and md files plus a note reach stored with a document in the namespace" |
| US4 | Scanned PDF `no_text`, encrypted PDF `encrypted` | PASS | `us4-uploads.spec.ts` "a scanned pdf is rejected with no_text and an encrypted pdf with encrypted" |
| US4 | File with an API key is excluded by `api_keys_tokens` | PASS. Note: the key is redacted and counted under `api_keys_tokens` (the file is stored with the value removed), which is the filter contract | `us4-uploads.spec.ts` "a txt file holding an API key is stored with the key redacted and counted under api_keys_tokens" |
| US4 | Delete upload removes the document | PASS with stub | `us4-uploads.spec.ts` "deleting an upload removes its document from the namespace" |
| US5, SC-006 | Below threshold blocked with `insufficient_content` | PASS | `us5-profiles.spec.ts` "below the threshold generation is refused; crossing it by upload auto-generates the first profile" |
| US5, SC-006 | 2 definitions give 2 complete profiles, 3+ authored excerpts, versions recorded, under 10 min | PASS with stub (stub LLM); real-model quality NOT RUNNABLE HERE | `us5-profiles.spec.ts` "two available definitions give two complete profiles; regenerate, feedback and adjust add versions; ratings reach admin aggregates only" |
| US5 | Regenerate, feedback, adjust each create a version; no received-mail quotes; rating saved on the version | PASS with stub | same test; received-mail exclusion also covered by core integration tests |
| US5, SC-007 | Rate a version, admin `GET /api/admin/metrics/ratings` shows aggregates only | PASS (mechanism only; the 80% target is measured in a beta cohort) | same `us5-profiles.spec.ts` test; admin-isolation suite 23/23 |
| US6 | `/admin` as non-admin gives 403 `admin_required` | PASS (also against the compose stack) | `us6-admin.spec.ts` "a non-admin gets the 403 page at /admin @ui", "admin APIs refuse a non-admin with 403 admin_required"; compose smoke |
| US6 | Prompt draft has no effect on generation | PASS | `us6-admin.spec.ts` "a prompt draft has no effect, publishing applies to the next generation" |
| US6, SC-008 | Publish applies to the next generation within 1 minute | PASS | same test (timing in section 6) |
| US6 | Roll back a prompt recorded in history | PASS (covered at integration level, not in e2e) | `apps/web` admin prompts route tests (`admin-prompts-routes.test.ts`) and core prompt integration tests |
| US6 | Retire last available definition blocked (`last_available_definition`) | PASS | `us6-admin.spec.ts` "retiring the last available definition is blocked and a second published definition becomes visible to users" |
| US6 | Second definition made available is visible to users | PASS | same test |
| US6 | Self-demote last admin blocked (`last_admin`) | PASS | `us6-admin.spec.ts` "the last active admin can neither demote themselves nor delete their account" |
| US6, SC-010 | Admin user detail shows no user content | PASS | `us6-admin.spec.ts` "admin user detail is metadata only and another user's resources are 404 for an admin", "the admin user detail page shows no user content @ui"; admin-isolation 23/23 |
| US7, SC-009 | Delete a source, then the account: namespace empty, email sent | PASS with stub (store, SMTP via GreenMail) | `us7-deletion.spec.ts` "source deletion outdates the profile; account deletion empties everything within 5 min"; `deletion-sla.integration.test.ts` |
| US7 | After source deletion the profile shows "may be outdated" | PASS | same `us7-deletion.spec.ts` test |
| US8, SC-012 | One draft of each type ready in under 60 s | PASS with stub (stub LLM; real model latency NOT RUNNABLE HERE) | `us8-drafts.spec.ts` "one draft of each type is ready under 60 s" |
| US8 | Edit, regenerate, feedback keep history; ratings saved | PASS (core and web integration tests for drafts) | draft route and core integration tests (`apps/web/test`, `packages/core/test`) |
| US8, SC-013 | Rate a draft, admin ratings aggregates only | PASS (mechanism only; the 70% target is measured in a beta cohort) | draft rating integration tests; admin-isolation 23/23 |
| US8 | Export md and txt, no publish option | PASS | `us8-drafts.spec.ts` "the draft page offers copy and export but no publish, post or share control @ui" (chromium and mobile) |
| US8 | Brief mentioning excluded data comes back redacted | PASS | `us8-drafts.spec.ts` "a brief with an API key comes back redacted; a password-reset brief fails brief_excluded"; empty state: "a user without a profile sees the "Generate a profile first" empty state @ui" |
| Compose | Stack builds, migrates, seeds, worker ready, admin grant | PASS | section 2 |

NOT RUNNABLE HERE, in summary: real Google, Microsoft, Apple and Facebook OAuth (consent, token revocation, private
relay email delivery), real Gmail and Microsoft Graph mailboxes, live Supermemory, and live Anthropic generation.
Substitute evidence is the mock OAuth providers, the GreenMail IMAP server, the Supermemory test server and the stub
generator listed above.

## 6. Success-criteria timings (`final2/sc-timings.json`)

| SC | Measurement | Measured | Limit |
|---|---|---|---|
| SC-001 | Sign-up and repeat sign-in (google) | 4.6 s | 60 s |
| SC-001 | Sign-up and repeat sign-in (apple) | 2.6 s | 60 s |
| SC-001 | Sign-up and repeat sign-in (microsoft) | 2.4 s | 60 s |
| SC-001 | Sign-up and repeat sign-in (facebook) | 3.0 s | 60 s |
| SC-002 | IMAP initial import (10 messages) | 4.8 s | 120 s |
| SC-002 | Source disconnect with delete (5 documents) | 6.0 s | 120 s |
| SC-006 | Upload crossing threshold to first profile version | 2.0 s | 600 s |
| SC-008 | Prompt publish to next generation uses it | 4.7 s | 60 s |
| SC-009 | Account deletion complete | 1.9 s | 300 s (local) |
| SC-012 | Draft ready (social_post) | 0.5 s | 60 s |
| SC-012 | Draft ready (bio) | 1.0 s | 60 s |
| SC-012 | Draft ready (short_article) | 0.9 s | 60 s |

These are local timings against test doubles. LLM and Supermemory latency, and the SC-007 (80%) and SC-013 (70%)
rating targets, must be measured with real providers and real users.

## 7. Outstanding before launch

Nothing in this record replaces these items:

- Public legal pages (privacy policy, terms, data deletion instructions): none exist yet and provider verification
  depends on them. See `docs/provider-verification.md` section 0.
- Real provider OAuth: register and verify the Google, Microsoft, Apple and Facebook apps and run the sign-in, link,
  cancel and revocation rows with real accounts. See `docs/provider-verification.md`.
- Live Supermemory check: run the namespace, list-scan and delete rows (seeded mailbox, disconnect, account deletion)
  against the real service.
- Live Anthropic check: run profile generation (SC-006) and draft generation (SC-012) against the real model and
  confirm timings and the verbatim-excerpt rule.
- Production start with real keys: only the refusal without keys was verified here.
- `docs/security-review.md` open items:
  - OI-4 (Low): linked-identity tokens stay in `account` if the browser never reaches
    `/api/identities/link/complete`; add a sweep or null them in the `account.create.after` hook.
  - OI-5 (Low): the admin import ban does not cover the `@voicespark/db` root, which exports content tables; add
    `importNames` restrictions.
  - OI-8 (decision needed): `upload.filename` and `exclusion_rule.value` are stored in plaintext; decide whether to
    encrypt them (Constitution VII).
  - Check the remaining items in that file and in the `docs/provider-verification.md` checklist before launch.
- Beta measurement of SC-007 and SC-013 rating shares over a real pilot cohort.
