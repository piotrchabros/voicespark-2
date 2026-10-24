# End-to-end tests

Run with `pnpm test:e2e` from the repo root (or `pnpm --filter @voicespark/web exec playwright test <spec> --project chromium`).

## Prerequisites

```
docker compose -f docker-compose.test.yml up -d   # greenmail, postgres-test (:55432), redis-test (:56379)
pnpm --filter @voicespark/web exec playwright install chromium   # once; skipped if ~/.cache/ms-playwright has it
```

## What a run starts (and stops)

| Piece | Where | Owner |
|---|---|---|
| Web app (`next dev`) | http://localhost:3110 (override `E2E_WEB_PORT`; 3100 is taken on the shared host) | Playwright `webServer` |
| Memory RPC bridge | http://127.0.0.1:4599 (`E2E_MEMORY_PORT`) | `support/global-setup.ts` |
| Worker (`tsx src/index.ts` in apps/worker) | child process group, log in `test-results/e2e-worker.log` | `support/global-setup.ts` |
| Database `voicespark_e2e` | postgres-test :55432 | dropped and recreated each run unless `E2E_FRESH_DB=0`, then migrated and seeded |
| Redis db 3 | redis-test :56379 | flushed at setup |
| GreenMail | SMTP 3025, IMAP 3143, IMAPS 3993 | docker-compose.test.yml |
| Hub file blobs (`HUB_FILES_DIR`) | `<os tmp>/vs-e2e-hub-files`, shared by web and worker | not cleared between runs; specs only look under their own user ids |

The worker is spawned detached and stopped by its own process-group id (SIGTERM, then SIGKILL after 10 s). Its pid is
kept in `<os tmp>/vs-e2e/worker.pid`; a run left behind by a crash is killed at the next setup only if that pid still
carries the `VS_E2E_WORKER=1` marker in its environment. Nothing is ever killed by name, and no other service is touched.

All settings live in `support/env.ts` (`E2E_ENV`). `playwright.config.ts` copies them into `process.env`, so global
setup, fixtures and every CLI they spawn (`pnpm cli admin:grant`, `support/scripts.ts`) hit the e2e stack.
`workers: 1`: specs share one database and global admin settings.

## Shared memory store (test-only bridge, D-E1)

The in-memory Supermemory fake lives per process, but web, worker and specs must see the same documents. Global setup
hosts `startMemoryRpcServer` from `@voicespark/integrations/testing`; web and worker get `TEST_MEMORY_STORE_URL` and
use `RemoteMemoryStore` instead of the in-process store. Specs read it through `support/memory.ts`
(`scanNamespace(userId)`, `expectNamespaceEmpty(userId)`). The bridge serves a `FailableMemoryStore`:
`failMemoryStoreFor(userId)` makes every write and delete in that user's namespace fail, `rejectMemoryDocs(ids)` rejects
single documents, `restoreMemoryStore()` clears both (a flag file in `<os tmp>/vs-e2e`; setup and teardown clear it).
The variable is honoured only under `NODE_ENV=test` /
`AUTH_TEST_MODE` and refused in production; ESLint bans the testing module from application source.

Hub documents (`hub_person_<id>`, `hub_note_<id>`, ...) share the user's namespace with content items;
`scanNamespace` returns both, with `vs_kind` telling them apart. The hub US7 sync spec uses `failMemoryStoreFor` for
"store down" and `rejectMemoryDocs` for a single rejected item, and always calls `restoreMemoryStore` afterwards.

Never point a run at the production memory store (`supermemory.voicespark.ai`) or at `127.0.0.1:6770`.
`support/env.ts` blanks `SUPERMEMORY_API_KEY` and `ANTHROPIC_API_KEY`, so keys from the host shell never reach the
e2e stack, and everything goes through the bridge on 4599.

## Fake LLM

`AUTH_TEST_MODE=1` makes `createLlm` return the deterministic fake (`packages/core/src/prompting/fake-llm.ts`); no
API key is used. Hub extraction output is chosen by `hubfx:<name>` markers in the seeded mail text:
`FAKE_HUB_FIXTURES` pick a recorded extraction output (`acme-offer`, `acme-project`, `acme-inferred-project`,
`freemail-person`, `irrelevant`), and `FAKE_HUB_SWITCHES` force edge cases (an invalid answer once or twice, a
refusal, a planted password, an excluded summary). `support/hub-mail.ts` exports the markers as `MARK`, the sample
people and companies, and `BODY_SENTINEL`, which specs assert never comes back from an API response.

## Test-mode sign-in

`AUTH_TEST_MODE=1` registers a mock OAuth server (`/api/test-oauth/*`) under the four real provider ids (google,
apple, microsoft, facebook), so tests sign in as any user without a real identity provider. `signInAs` in
`fixtures/auth.ts` drives it and returns `{ userId, email }`; options: `provider`, `role: 'admin'` (granted through the
core CLI), `relay` (Apple private-relay address), `cancel` (cancels at the provider; returns `userId: null`).

`AUTH_TEST_MODE` is test-only. The environment loader rejects it at startup when `NODE_ENV=production`.

## Support modules

- `support/api.ts`: `api.get/post/put/patch/delete(page, path, body?)` (throw `ApiError` with `status` and `code`),
  `poll`, `me`, `userIdOf`, `confirmFilters`, `setAdminSetting`.
- `support/greenmail.ts`: `uniqueMailbox`, `appendMessages` (IMAP APPEND), `waitForMail(to, subjectIncludes)` (SMTP
  mail lands in the recipient's GreenMail INBOX; auth is disabled, so any password works).
- `support/scripts.ts`: `runCore(snippet, args)` (tsx snippet under E2E_ENV), `sql`, `markNeedsReconnection`
  (simulated token revocation), `demoteOtherAdmins` / `restoreAdmins`, `setUserStatus`.
- `support/hub-mail.ts`: hub-from-email helpers for the hub US3, US4 and US8 mailbox specs: seed GreenMail messages
  with `hubfx:` markers, connect the mailbox, turn the hub on in `/hub/settings`, read status, records and threads.
- `support/drafts.ts`: profile and draft helpers shared by `us7-deletion`, `us8-drafts` and `hub-us6-drafts`.
- `support/timing.ts`: `measure(name, sc, limitMs, fn)` records success-criterion timings in
  `test-results/sc-timings.json` and asserts the limit.

## Fallbacks

- No Playwright Chromium: `PW_CHANNEL=chrome pnpm test:e2e` uses the system Chrome.
- No browser at all: `E2E_API_ONLY=1 pnpm test:e2e` skips every test tagged `@ui` (API assertions are untagged).

## Tags and projects

UI assertions carry `@ui` in the title. Project `chromium` runs every spec; project `mobile` (Pixel 7) runs only the
`@ui` tests of `us1-sign-in` and `us8-drafts`.

## Context Hub specs

| Spec | Covers |
|---|---|
| `hub-us1-records` | people, companies, projects: create, validation, same-name warning, delete with counts, isolation, sorting |
| `hub-us2-links-notes-files` | links with roles, rich-text notes, files (extraction, size and type limits, exclusion, owner-only download, blobs under `HUB_FILES_DIR`) |
| `hub-us3-email` | hub from email: consent, records, summaries, sources, status, ignore rules, retry |
| `hub-us4-suggestions-merge` | suggestion queue, accept and reject, bulk accept, merge |
| `hub-us5-search` | keyword search, snippets, type filter, isolation, prefix and accent rules |
| `hub-us6-drafts` | drafts pinned to a record, a deleted record, a foreign record |
| `hub-us7-sync` | memory-store sync status, store down and retry, rejected item, full re-sync, rename and delete propagation, contact rule |
| `hub-us8-account` | admin hub counts only; account deletion removes hub rows, the user's blob directory and `hub_` documents |
| `hub-us8-mailbox` | mailbox disconnect with keep or delete, hub off |
| `hub-sc-timings` | SC-001 and SC-002 timings into `test-results/sc-timings.json` |

The email specs wait up to `HUB_PROCESSING_TIMEOUT_MS` (240 s) for the worker. Run e2e on the shared host only under
`flock /tmp/voicespark-e2e.lock pnpm test:e2e`.
