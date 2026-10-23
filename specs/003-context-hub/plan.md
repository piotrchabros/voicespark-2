# Implementation Plan: Context Hub

**Branch**: `003-context-hub` | **Date**: 2026-10-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-context-hub/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Every user gets a private Context Hub of people, companies and projects. Records have links (person–company, person–project, company–project; one per pair; optional role), Tiptap rich-text notes and encrypted files. Every content column is AES-256-GCM.

Keyword search uses a per-user keyed blind token index. It never uses plaintext full-text search.

For mailboxes where the user opts in, an import hook records message metadata (no bodies) into a thread work queue. A `hub.thread` job then re-fetches the thread through the existing `MailFetcher`, cleans the bodies and inspects them in a new hub mode of the filter. That mode keeps emails and phones for the AI call but always applies locked categories, postal addresses, rules and the other user categories. The job calls Claude Sonnet 5.5 with a code-versioned extraction prompt, applies the ECH POLICY_V1 confidence policy under a per-user advisory lock, re-inspects every free-text output under the user's full policy, and validates contact values into a separate branded type.

Uncertain and conflicting findings go to a suggestions queue. User-entered or cleared values (`owner_fields`) are never overwritten, and block markers stop items from being re-added.

An outbox (`hub_sync_item`) syncs records, notes, files and summaries to the user's existing `vs_user_{id}` namespace with ids `hub_*`. Account deletion is covered by the existing namespace delete. Mailbox data deletion adds a hub purge step and a new `hub_source` deletion scope.

Drafts can pin a record and get a code-appended, inspected `<record_context>` block.

Two spec decisions shape the design. Files: the derived text is filtered, and the original blob stays local and encrypted, with owner-only download; it is never sent to the AI service or the memory store. Contacts: contact values go to memory documents only when `third_party_contacts` is not selected.

No new service, package or queue technology is added. There is one new BullMQ queue name (`hub`) and one persistent volume (`HUB_FILES_DIR`). New npm dependencies are Tiptap 3.31.4 and fflate 0.8.3.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict) on Node.js 24 LTS; pnpm 10 workspaces. Unchanged from spec 001.

**Primary Dependencies**:
- Same as specs 001 and 002
- New dependencies, verified with `npm view` on 2026-10-23; each is at least 14 days old:
  - `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-list` and `@tiptap/core`, all pinned to 3.31.4 (published 2026-09-30). Version 3.32.0 (2026-10-13) is too new
  - The web app needs the first four. `@voicespark/core` needs `@tiptap/core`, `@tiptap/pm` and `@tiptap/starter-kit` for server-side schema validation, with no DOM
  - `fflate` 0.8.3 (2026-05-16) in `@voicespark/integrations`, for Office files
- Rejected: `officeparser` 8.1.1 (pulls in tesseract.js and pdfjs-dist), `exceljs` 4.4.0 (heavy and stale), `@tiptap/static-renderer` and `@tiptap/html` (not needed)

**Storage**:
- PostgreSQL 17 with migration `0008_context_hub.sql` (or 0008 to 0010 if delivered in phases)
- Redis 7.4, with a new BullMQ queue name `hub`
- Supermemory, in the same `vs_user_{id}` namespace
- New persistent volume `HUB_FILES_DIR` for encrypted blobs (AES-256-GCM, new key purpose `hub-files`)
- New env: `HUB_FILES_DIR`, `HUB_FILE_MAX_BYTES` (26214400), `LLM_HUB_EXTRACTION_MODEL`, `LLM_HUB_EXTRACTION_EFFORT`
- New setting: `hub.daily_thread_cap_per_user`

**Testing**:
- Vitest unit and integration tests (Postgres 127.0.0.1:55432, Redis 56379)
- GreenMail IMAP 3993 and SMTP 3025 for ingest and backfill
- Fake LLM with recorded extraction fixtures; in-memory or fake v3 memory store
- The admin-isolation project
- Playwright e2e on web port 3110, serialised with `flock`
- Filter corpus gates with a hub-mode extension. Tests for `inspectForHubExtraction`, `validateContactValue`, `inspectSegments` and `buildHubDocument` are written first and must fail first

**Target Platform**: Unchanged from spec 001 (Linux server, Docker Compose, Caddy).

**Project Type**: Web application (full-stack monorepo) plus a background worker. Unchanged.

**Performance Goals**:
- Record page with 100 notes and files in under 2 s
- Search p95 under 2 s at 10k items (SC-003)
- An email is reflected in the hub in 15 min or less
- Memory-store sync accepted in 1 min or less at 99%
- Note save p95 under 3 s, with synchronous inspection including the classifier
- File text extraction under 30 s

**Constraints**:
- No message bodies are stored
- Contacts live only in record fields
- Inspection is fail-closed
- Admins see counts only, never hub content
- The 24 h deletion SLA covers hub data, blobs and memory documents (SC-012)
- The Next.js body limit must be raised to 26 MB
- No hub text, content or contact values in logs, audit entries or job payloads

**Scale/Scope**:
- 1,000 users; up to 10k records, notes and files per user
- About 4k threads per 10k-message backfill
- About 12 new screens
- 8 user stories and 32 functional requirements

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against constitution v1.0.0 (`.specify/memory/constitution.md`, ratified 2026-10-19). Gates G1–G7 map one-to-one to Principles I–VII.

| Gate | Source | Pre-design | Post-design | Evidence |
|------|--------|------------|-------------|----------|
| G1 / I. Privacy by Design: every hub write to the memory store goes through `buildHubDocument` (`FilteredText` plus `ContactValue`); extraction input is `HubLlmText` from hub-mode inspect (locked categories, rules and the classifier on credential-redacted text); extraction outputs, notes, file text and fields are inspected; draft record context is inspected; triage receives redacted text only | FR-019, FR-025, FR-027, FR-028 | PASS | PASS | contracts/filter-hub-mode.md; contracts/hub-extraction.md; contracts/memory-store-hub.md; research (hub-mode filter, contact exception) |
| G2 / II. Least-Privilege Access: no new scopes; thread re-fetch uses the existing read-only `fetchMessages` (IMAP `BODY.PEEK`) | Plan scope | PASS | PASS | research (email ingestion); no change to sign-in or mailbox adapters |
| G3 / III. Admins Never See Content: all hub content is in `*_enc` columns read only by user and system services; admins get a counts repository only; lint import bans, forbidden response fields, an isolation suite with sentinels, and foreign-access 404 with audit | FR-001, FR-029, SC-011 | PASS | PASS | data-model "Content-class columns"; contracts/http-api.md "Admin"; research (admin isolation) |
| G4 / IV. Test-First Filtering: hub-mode corpus and unit tests are written failing first; locked-category recall stays at 100% in hub mode | FR-028 | PASS | PASS | contracts/filter-hub-mode.md "Corpus gates"; quickstart.md |
| G5 / V. Simplicity: no new package, service or queue technology; one new queue name and one volume (Docker volumes are not services); new dependencies justified in research | Plan scope | PASS | PASS | research (dependencies, queue); contracts/jobs.md |
| G6 / VI. Fail-Closed and Audited: an inspection failure drops the message or field, a thread with nothing left is skipped as `excluded`, a note save is refused, a file is marked `excluded`; governance events write audit entries; typed loggers carry ids and codes only | FR-026, FR-028, FR-032 | PASS | PASS | contracts/hub-extraction.md "Error codes"; data-model "Audit"; contracts/jobs.md |
| G7 / VII. Secrets Encrypted at Rest: all content columns are `_enc`; blobs use AES-256-GCM with key purpose `hub-files`; the search index uses keyed HMAC tokens, and its leakage is documented (note) | FR-009, FR-011 | PASS (note) | PASS (note) | data-model "Content-class columns"; contracts/hub-search.md "Leakage"; research (search under Principle VII) |

## Project Structure

### Documentation (this feature)

```text
specs/003-context-hub/
├── plan.md                          # This file (/speckit-plan command output)
├── research.md                      # Phase 0 output (/speckit-plan command)
├── data-model.md                    # Phase 1 output (/speckit-plan command)
├── quickstart.md                    # Phase 1 output (/speckit-plan command)
├── contracts/                       # Phase 1 output (/speckit-plan command)
│   ├── hub-extraction.md
│   ├── http-api.md
│   ├── jobs.md
│   ├── memory-store-hub.md
│   ├── filter-hub-mode.md
│   └── hub-search.md
├── checklists/
│   └── requirements.md              # Existing spec quality checklist
└── tasks.md                         # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

This lists only what this feature adds or changes. The rest of the tree is as in specs 001 and 002.

```text
packages/
  db/                           # @voicespark/db
    src/schema/hub.ts                           # new
    src/schema/enums.ts  audit.ts  drafts.ts  index.ts   # changed: audit actions, deletion scope, 3 draft columns
    drizzle/0008_context_hub.sql  drizzle/meta/  # new migration and journal
    src/repos/user/hub-records.ts  hub-content.ts  hub-mail.ts  hub-sync.ts   # new
    src/repos/system/hub.ts                     # new
    src/repos/admin/hub-counts.ts  src/repos/admin/types.ts   # new, changed
  filters/                      # @voicespark/filters
    src/hub.ts                  # new: inspectForHubExtraction, HubLlmText, validateContactValue,
                                #      ContactValue, inspectSegments, buildHubDocument
    src/pipeline.ts  categories.ts  index.ts    # changed: contactMode option, brands, exports
    test/unit/hub-*.test.ts  test/corpus/hub/   # new
  integrations/                 # @voicespark/integrations
    src/mime/parse.ts                           # changed: threading and automated-mail headers, HTML body
    src/mime/hub-body.ts  mime/automated.ts     # new
    src/files/office.ts                         # new
    src/files/extract.ts  files/sniff.ts        # changed: hub allowlist
    src/supermemory/port.ts                     # changed: hub metadata keys
  core/                         # @voicespark/core
    src/crypto/keyring.ts  aead.ts              # changed: hub-files purpose, binary envelope
    src/env.ts                                  # changed: new variables
    src/queues/index.ts                         # changed: queue hub; jobs hub.thread, hub.backfill, hub.sync,
                                                #   hub.file-extract, hub.refilter, maintenance.hub-thread-sweep,
                                                #   maintenance.hub-sync-sweep, maintenance.hub-blob-sweep
    src/hub/                                    # new: content-schema, normalize, lists, thread-key, fingerprint,
                                                #   policy, prompts, extraction-schema, search-tokens, blob-store, doc-builder
    src/services/hub/                           # new: records, links, notes, files, search, merge, suggestions,
                                                #   ignore-rules, mailboxes, ingest, extraction, apply, sync, purge,
                                                #   draft-context, counts
    src/services/deletion.ts  sources.ts  drafts.ts  credential-audit.ts
      filter-preferences.ts  audit.ts  settings.ts   # changed
    src/prompting/fake-llm.ts                   # changed: hub fixtures
apps/
  worker/                       # @voicespark/worker
    src/import/process-item.ts  processors/import.ts   # changed: ingest hook, PageContext.hub
    src/processors/hub-thread.ts  hub-backfill.ts  hub-sync.ts  hub-file.ts  hub-refilter.ts   # new
    src/processors/draft.ts  retroscan.ts  maintenance.ts   # changed: record context, skip hub_, sweeps
    src/index.ts  handlers.ts  deps.ts          # changed
    test/hub-*.integration.test.ts  test/fixtures/hub/*.eml   # new
  web/                          # @voicespark/web
    app/(user)/hub/**  app/api/hub/**           # new
    app/(user)/sources/[sourceId]  drafts/new  drafts/[draftId]   # changed
    components/hub/*                            # new
    components/sources/source-actions.tsx  components/drafts/draft-form.tsx   # changed
    lib/admin-schemas.ts  next.config.ts  user-nav.tsx   # changed: forbidden keys, body limit, nav
    test/hub-*-routes.test.ts  test/admin-isolation/*  e2e/hub-*.spec.ts   # new
eval/hub/                       # new: conversations/*.json, runner script, README (or apps/worker/eval/hub)
eslint.config.js                # changed: ban hub content modules for admin code
docker-compose*.yml  .env.example   # changed: HUB_FILES_DIR volume, new variables
```

**Structure Decision**: The feature fits the existing monorepo. No package is added. Hub content sits in new `_enc` tables, and the memory store reuses the user's existing namespace with `hub_*` ids. Hub-mode filtering lives in `@voicespark/filters` so `FilteredText` and `ContactValue` can only be minted there. Pure hub logic lives in `@voicespark/core/src/hub`, services in `core/src/services/hub`, and the worker runs the jobs on the new `hub` queue. Thread text is re-fetched on demand and never stored. Admin code never imports hub content modules, and lint enforces it.

**Delivery increments** (detail for `tasks.md`):
- Setup and Foundational first: dependencies, env, volume, migration, filter hub APIs with corpus (test-first), owner-scoped repos, search tokens, outbox library, Tiptap schema, blob store, admin lint and isolation scaffolding.
- Increment 1 (MVP): US1 records, US2 links, notes and files with extraction, and US8a account deletion with admin counts, isolation and audit. The manual hub is fully usable and private.
- Increment 2: US7 memory-store sync. It ships before any email ingestion so summaries sync and deletion covers them.
- Increment 3: US5 search UI and API.
- Increment 4: US3 email in steps (a) to (g), then US8b mailbox data deletion.
- Increment 5: US4 suggestions review and merge.
- Increment 6: US6 drafts with record context.
- Final phase: eval set port and held-out set, live eval run, SC timing checks, security review.

## Complexity Tracking

No violations. Every Constitution Check gate passes without a justified exception. The G7 note records the blind search index: it uses keyed HMAC tokens, and its leakage is accepted and documented in `contracts/hub-search.md`.
