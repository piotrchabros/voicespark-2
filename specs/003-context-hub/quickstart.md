# Quickstart: Context Hub (003-context-hub)

Validation and run guide. Entities, enums and state transitions live in [data-model.md](./data-model.md). Routes, job shapes, extraction rules and error codes live in [contracts/](./contracts/):

- [http-api.md](./contracts/http-api.md)
- [jobs.md](./contracts/jobs.md)
- [hub-extraction.md](./contracts/hub-extraction.md)
- [memory-store-hub.md](./contracts/memory-store-hub.md)
- [filter-hub-mode.md](./contracts/filter-hub-mode.md)
- [hub-search.md](./contracts/hub-search.md)

This guide does not repeat them. It points at them and states the expected outcome of each scenario.

Environment variables, provider registrations and the production-like run are unchanged from [001 quickstart](../001-personal-brand-voice/quickstart.md). The test environment is the same as in [002 quickstart](../002-voice-analysis-prompt/quickstart.md). Read both first.

## 1. Prerequisites

- Node 24 LTS, pnpm 10 (via corepack), Docker 27+ with Compose v2.
- `flock`, `psql`, `strings` and `file` on the host.
- Ports used on the shared host: web 3110, Postgres 55432, Redis 56379, GreenMail SMTP 3025 and IMAPS 3993, memory bridge 4599.
- A writable directory for the hub file volume (`HUB_FILES_DIR`). In tests it is `./.data/hub-files`. In Docker it is a persistent volume mounted in web and worker (default `/data/hub-files`).
- Scenarios use test-mode sign-in and the fake LLM. No real provider registration and no API key are needed, except for the gated live eval in section 6.

Safety rules for the shared host:

- Never run `pkill`, `killall` or any kill by name. Other projects run here. The e2e harness stops its own worker by process group.
- Never point a test at the production memory store (`supermemory.voicespark.ai`) or at `127.0.0.1:6770`. Tests use the in-memory store and the memory bridge on 4599.
- Never write to the production memory store from any scenario in this guide.

## 2. Setup

```bash
docker compose -f docker-compose.test.yml up -d    # greenmail, postgres-test (:55432), redis-test (:56379)
pnpm install
export DATABASE_URL=postgres://voicespark:voicespark@127.0.0.1:55432/voicespark_test
export HUB_FILES_DIR="$PWD/.data/hub-files"
mkdir -p "$HUB_FILES_DIR"
pnpm db:migrate     # applies migration 0008 (hub tables and indexes)
pnpm db:seed
```

Other hub variables (defaults are fine for tests): `HUB_FILE_MAX_BYTES` (26214400), `LLM_HUB_EXTRACTION_MODEL`, `LLM_HUB_EXTRACTION_EFFORT`. See [plan.md](./plan.md).

Playwright browser, once: `pnpm --filter @voicespark/web exec playwright install chromium`. See [apps/web/e2e/README.md](../../apps/web/e2e/README.md) for what an e2e run starts and stops.

## 3. Migration check

```bash
psql "$DATABASE_URL" -c "\dt hub_*"
pnpm db:migrate     # second run
```

Expected:

- All hub tables from [data-model.md](./data-model.md) exist.
- The second `pnpm db:migrate` changes nothing and does not error.
- Existing tables from 001 and 002 are untouched.
- Hub setting rows exist only for mailboxes the user enabled. After migration no mailbox has the hub on (FR-012).

## 4. Automated gates

Run in this order. Each must pass.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:corpus
pnpm test:integration
pnpm test:admin-isolation
```

| Command | Covers |
|---|---|
| `pnpm lint` | Lint, including the admin import bans and the ban on the testing module in app source |
| `pnpm typecheck` | Types across all packages. Includes the compile-time test that hub LLM text cannot be passed as a memory document |
| `pnpm test` | Unit tests: contact value validation, segment inspection, hub document builder, thread key, automated-mail classifier, hub body cleaning, normalisation and fingerprints, POLICY_V1 decision table, search tokeniser, ranking and snippets, Tiptap schema validator, office extractors, blob envelope |
| `pnpm test:corpus` | Filter corpus, including the hub mode (contact exception, brands). Runs first among the filter checks so failures show before anything else |
| `pnpm test:integration` | CRUD and owner scoping, merge, link uniqueness, delete preview, outbox fan-out and backoff, ingest hook with the hub on and off, cross-mailbox dedupe, thread pipeline with recorded LLM output (US3 scenarios), owner-wins (SC-007), block markers, ignore rules, purge matrix (FR-031), account deletion including the blob directory and namespace, deletion deadline job, draft context, refilter, `BODY-SENTINEL` leak test (SC-008). Needs Postgres :55432, Redis :56379 and GreenMail |
| `pnpm test:admin-isolation` | SC-011. Seeds sentinel names, notes, summaries and file text. Every admin route must return none of them. Foreign access returns 404 and an audit entry |

## 5. End-to-end

The host is shared. Hold the lock so only one e2e run is active. Run all specs, hub specs included:

```bash
flock /tmp/voicespark-e2e.lock pnpm test:e2e
```

Or one spec:

```bash
flock /tmp/voicespark-e2e.lock \
  pnpm --filter @voicespark/web exec playwright test <spec> --project chromium
```

- Web runs on 3110 (`E2E_WEB_PORT` overrides it). 3100 is taken.
- The run recreates database `voicespark_e2e` unless `E2E_FRESH_DB=0`.
- The e2e run needs `HUB_FILES_DIR` to point at a writable test directory. The harness sets it for web and worker. Check `support/env.ts` if a file scenario fails with a storage error.
- Hub specs use the fake LLM and a failing fake store. They never call a real model or the production memory store.
- Fallbacks: `PW_CHANNEL=chrome` for system Chrome; `E2E_API_ONLY=1` skips `@ui` tests.
- Never use `pkill` or kill by name.

Specs cover US1 to US8: create, edit, delete and warn; link, note checklist, PDF attach and search; hub on a GreenMail mailbox; accept, reject, bulk and merge; search filter; draft with a record; sync status with retry; disconnect with delete.

## 6. Evaluation set (SC-004 to SC-006)

The set is synthetic. All people are invented and all domains end in `.example`. It holds no real mail. It has the 53 ported conversations and at least 15 new held-out conversations. See [hub-extraction.md](./contracts/hub-extraction.md) for the policy and grader rules.

Recorded run (fake LLM replaying stored outputs). Runs in CI:

```bash
pnpm hub:eval
```

Expected:

- Scores computed through the real policy and apply code.
- SC-004: at least 95% correct people, 90% correct person-company links, 80% correct project names and links.
- SC-005: at most 2% duplicate people. No newsletter or automated sender becomes a person.
- SC-006: at most 1 in 5 findings in the queue. At least 90% of auto-applied findings correct.
- The held-out subset is reported on its own line. Do not claim a criterion from the in-sample figure alone.

Live run (gated). Manual or nightly. Never in PR CI.

```bash
export ANTHROPIC_API_KEY=...        # your own key; never commit it
HUB_EVAL_LIVE=1 pnpm hub:eval --model <model-id>
```

- It calls a real model and costs tokens. It writes to the test database and the in-memory store only.
- Expected: same thresholds on the held-out subset. Record the run and update the stored fixtures only on purpose.
- Check the extraction schema stays within the model's nullable-parameter limit (see risks in [plan.md](./plan.md)).

## 7. Encryption and leak checks

```bash
psql "$DATABASE_URL" -c "select * from hub_person limit 3"
ls -R "$HUB_FILES_DIR" | head
file "$HUB_FILES_DIR"/<userId>/*.bin
strings "$HUB_FILES_DIR"/<userId>/*.bin | head
```

Expected:

- Sensitive columns hold only `v1.` envelopes. No plaintext names, notes or summaries.
- Blob files are not plaintext and not a recognised PDF or Office type.
- The `BODY-SENTINEL` string does not appear in a `pg_dump` of hub tables, in memory documents or in logs.

## 8. Validation scenarios

Shapes and errors: [contracts/](./contracts/). Tables and enums: [data-model.md](./data-model.md). Sign in with `signInAs`. Use `signInAs` with `role: 'admin'` for admin steps. Use a GreenMail mailbox from `support/greenmail.ts` for mail steps.

### Records, links, notes, files (US1, US2)

| Story / SC / edge | Steps | Expected |
|---|---|---|
| US1.1 | Create a person with two email addresses. | Person is in the list. Page shows both addresses. |
| US1.2, FR-002 | Create a project. Set the end date before the start date. | Refused with an explanation. |
| US1.3, FR-003 | Create "Anna Nowak", then "anna nowak". | Warning with a link to the first. Save is still possible. Same for rename. |
| US1.4, FR-004 | Delete a record with notes, files and links. | Counts shown first. After confirm, the record, its notes, files and links are gone. Linked records remain. |
| US1.5, FR-001 | Create records as two users. Open, list and search from the other. | Nothing of the other user is visible. Direct URLs give 404. |
| FR-006 | Sort lists by name, then by last change. | Order is correct for both. |
| SC-001 | Time: create a record and add a first note. Then open a record and attach a file. | Under 1 minute. File attach in 3 or fewer steps. |
| SC-002 | Open a record with 100 notes and files. | Everything on one screen in under 2 seconds. Timing in `test-results/sc-timings.json`. |
| US2.1 | Link a person to a company as "CTO". | Both records show the link and role. |
| US2.2, FR-007 | Add a second link for the same pair. | Told the link exists. Can edit the role. Role over 100 characters is refused. |
| US2.3 | Try to link two people. | Option is not offered. API refuses. |
| US2.4, FR-008 | Write a note with heading, checklist and link. Reopen. | Formatting kept. A note with a script node or `javascript:` link is refused. |
| US2.5, FR-010 | Attach a PDF with text, then a PNG. | PDF text is searchable. The PNG is kept and marked not searchable, with the reason. |
| US2.6, FR-009 | Attach a file over 25 MB, then a disallowed type. | Each refused with the reason. |
| US2.7, FR-028 | Save a note with a password. Attach a file whose text has a password. | The excluded part is removed from the note and from the extracted text. User sees what was excluded. Original file stays encrypted. Only the owner can download it. Another user and admin get 404 or refusal. |
| Edge: extraction | Attach a file that makes extraction fail or time out. | File kept. Marked not searchable with the reason. |
| Edge: all excluded | Attach a file whose whole text is excluded. | Marked not searchable. Never sent to the AI service or memory store. |
| Edge: merge on edit | Edit a record while its mail is being processed. | The user's edit wins. |

### Hub from email (US3, SC-004 to SC-009)

| Story / SC / edge | Steps | Expected |
|---|---|---|
| US3.9, FR-012 | Connect a GreenMail mailbox. Import mail for tone of voice. Do not turn the hub on. | Nothing reaches the hub. Hub is off by default. |
| FR-012 | Turn the hub on for the mailbox. | A notice says conversation content is sent to the AI service. User must confirm. Audit entry written without content. |
| US3.1 | Import mail with "Jan Kowalski <jan@acme.com>". | Person "Jan Kowalski" with that address. Linked to a company for acme.com. |
| US3.2, SC-005 | Import a newsletter and a no-reply notification. | No person, company or summary. |
| FR-014 edge | Import mail from a gmail.com correspondent. Import from the user's own address and `info@` role address. | Person from the free-mail sender is allowed. No company from gmail.com. No person from own or role addresses. |
| US3.3, SC-007 | Enter a phone number by hand. Import a later mail with a different number. | User value kept. Suggestion marked as a conflict, both values shown. Zero overwrites. |
| US3.4, FR-017 | Delete a value and a link. Reject a suggestion. Import mail pointing at them again. | Not re-added. At most suggested again from new evidence. |
| US3.5, FR-019 | Open a record after processing. | Summary shows subject, date, participants and a link to the original in the provider. No full message text anywhere. |
| US3.6, FR-018, SC-008 | Open an email-derived field and link. | Source conversations are listed. Every derived item has at least one. |
| US3.7, FR-020 | Put the same conversation in two mailboxes. Import both. | Processed once. |
| Edge: thread update | Add a new message to a summarised thread. | Summary updated. Thread not counted twice. |
| US3.8, FR-021 | Ignore a sender, then a domain. Import mail. Undo. | Ignored senders create and update nothing. Undo restores processing. |
| Edge: footer | Import a real reply with a newsletter footer and quoted history. | Reply processed. Footer and quotes create no records. |
| Edge: multiple addresses | Import mail from one person with two addresses, strong then weak evidence. | Strong: one person. Weak: a merge suggestion. |
| Edge: failure | Make the fake LLM fail for one conversation. | That conversation retries later. The rest continue. Repeated failures are shown. |
| FR-022 | Open the mailbox hub status. | Counts for processed, skipped, failed and the last run time. |
| SC-004 to SC-006 | Run the eval (section 6). | Thresholds met. |
| SC-009 | Import a new mail in an enabled mailbox. | Reflected in the hub within 15 minutes of VoiceSpark reading it. |
| SC-008 | Run the `BODY-SENTINEL` check (section 7). | Sentinel not found in hub tables, memory documents or logs. |

### Suggestions and merge (US4)

| Story / SC / edge | Steps | Expected |
|---|---|---|
| US4.1, FR-023 | Open a queued suggestion. | Shows the change, current value, conflict flag and source conversations. |
| US4.1 | Accept one, reject another. | Only the accepted one changes records. |
| US4.2 | Bulk-accept suggestions including a link to a project not yet created. | All applied in the right order. Bulk accept is audited without content. |
| US4.3, FR-005 | Merge two person records. | One record remains with addresses, notes, files, links and summaries of both. Kept record's value wins on conflict. |
| US4.4 | Import mail referring to the merged-away record. | Updates the kept record. Chained merges resolve to the final record. |
| US4.5, FR-024 | Move around the hub. | The waiting count is visible everywhere. |
| Edge: record deleted | Delete a record with a queued suggestion. | The suggestion is dropped. |

### Search (US5)

| Story / SC / edge | Steps | Expected |
|---|---|---|
| US5.1, FR-011 | Search for a word in a note. | Note found with a highlighted snippet and its record name. |
| US5.2 | Search for a word only inside an attached PDF. | The file is found. |
| US5.3 | Filter to "people". | Only people shown. |
| US5.4 | Search as another user for a word in the first user's hub. | No results from the first user. |
| SC-003 | Seed 10,000 items. Search. | Under 2 seconds. See [hub-search.md](./contracts/hub-search.md). |
| Search rules | Search a word prefix. Search with an accent difference. | Prefix matches. Accents are not folded in v1. |

### Drafts (US6)

| Story / SC / edge | Steps | Expected |
|---|---|---|
| US6.1, FR-027 | Request a draft with a selected person whose record says "CTO at Acme, discussed the Q3 rollout". | Draft reflects role, company and topic. Still in the chosen voice. |
| US6.2 | Request a draft with no record. | Behaves as before. |
| US6.3 | Save the draft. | Draft records the record used. Draft list shows it. |
| US6.4, FR-028 | Select a record whose hub data contains an excluded category. | That content is absent from the draft. |
| Edge: deleted record | Delete the record after a draft used it. | Draft stays. The record link shows as removed. |

### Memory store sync (US7, SC-010)

Use the in-memory store through the bridge. Never the production store.

| Story / SC / edge | Steps | Expected |
|---|---|---|
| US7.1, SC-010 | Create a record with a note. | Both show "stored" within 1 minute. |
| US7.2, FR-026 | Make the fake store fail. Edit the note. | Item shows "failed" or "waiting". Content is intact in VoiceSpark. Retry works once the store is back. |
| US7.2 | Request a full re-sync. | All items return to "stored". |
| US7.3, FR-025 | Rename a record. Link it to another. | Stored copies of its notes, files and linked records show the new name and link. |
| US7.4 | Delete an item. | Removed from the store. |
| FR-028, memory | With "other people's contact details" not selected, then selected. Inspect stored documents with `support/memory.ts`. | Not selected: contact values are in memory documents. Selected: names, roles, companies and topics only. See [memory-store-hub.md](./contracts/memory-store-hub.md). |
| Edge: rejected item | Make the store reject one item. | Item stays saved, shows "failed", can be retried. |

### Privacy, admin and deletion (US8, SC-011, SC-012)

| Story / SC / edge | Steps | Expected |
|---|---|---|
| US8.1, FR-029, SC-011 | As admin, open every admin screen and route. Run `pnpm test:admin-isolation`. | At most per-user counts. Never names, fields, notes, files, summaries, suggestions or links. |
| US8.2, FR-031, SC-012 | Disconnect a mailbox and choose delete. Wait for the job. | Summaries only from that mailbox are gone. Values and links only from it are gone. Records left with nothing user-made and no other source are deleted, also from the store. User-entered data stays. |
| US8.3 | Disconnect a mailbox and choose keep. | Derived data stays. Nothing new comes from the mailbox. |
| Edge: hub off | Turn the hub off for a mailbox. | Processing stops. User is asked to keep or delete derived data. |
| US8.4, FR-030, SC-012 | Delete the account. Wait for the job or run the deadline job. | All hub rows, notes, files and the `HUB_FILES_DIR/<userId>` directory are gone. The store namespace holds no `hub_` documents for the user. Within 24 hours. |
| US8.5, FR-028 | Save notes, summaries and files with excluded content. | Filtered before storage, search and sync. Same filter as other content. |
| FR-032 | Read the audit log after the steps above. | Entries for hub on and off, bulk accepts, merges, ignore rules and deletions. No names or content. |
| Edge: two users | Two users mail each other. | Each has a person for the other in their own hub. Nothing shared. |

Account deletion verification queries:

```bash
psql "$DATABASE_URL" -c "select count(*) from hub_person where user_id = '<userId>'"
ls "$HUB_FILES_DIR/<userId>" 2>&1
```

Expected: count 0 for every hub table. The directory does not exist.

## 9. Operations notes

- The hub reads mail through the existing mailbox connection. A thread is re-fetched from the provider, so a connected hub-enabled mailbox is required for updates. Re-downloading counts against provider quota.
- Extraction calls cost tokens. The daily cap limits the cost of a backfill. See the risks in [plan.md](./plan.md).
- The live eval is the check for model drift. Run it before changing the extraction prompt, schema or model.
- `HUB_FILES_DIR` must be a persistent volume in production. Losing it loses original files, not their extracted text.
- Existing scanners must tolerate `hub_` documents in the shared namespace (see the risks in [plan.md](./plan.md)).
