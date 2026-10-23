# Implementation Plan: Tone-of-Voice Analysis Prompt with Per-User Override

**Branch**: `002-voice-analysis-prompt` | **Date**: 2026-10-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-voice-analysis-prompt/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

This feature changes the tone-of-voice part of spec 001. Today an admin edits fixed dimensions in a definition, and generation returns a rigid profile with one value per dimension. After this change, the admin writes an analysis prompt in words. It is stored as a new `analysis_prompt` field on each definition version, so draft, publish, rollback and history are reused. The active version is the default for every user.

A user can copy the default into an own prompt, edit it, compare it with the default and reset to it. Own prompts are stored encrypted, one per user and definition, with their own versions. When an admin publishes or rolls back a default, users with an own prompt keep it and get an in-app notification with a diff and a one-step reset.

Generation produces a sectioned tone-of-voice document with one section per aspect named in the prompt. The document always has a summary, a do / don't list and excerpts that link to the user's own authored items. Privacy and format are enforced by code, not by prompt text. A fixed guard is added around the prompt, the prompt is delimited and neutralised, the own prompt is inspected like any user content, and the output is validated structurally and inspected again. A failed validation saves no version.

Documents reuse `profile_version` with a new `format` column, so old structured profiles stay viewable and usable for drafting until regenerated. Drafting reads either format. A TypeScript step after the SQL migration builds the first default prompt from each existing definition's dimensions. No new service, package or queue is added.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict) on Node.js 24 LTS; pnpm 10 workspaces. Unchanged from spec 001.

**Primary Dependencies**:
- Same as spec 001
- One new dependency: `diff` (jsdiff, pinned to 8.0.4; see research R10) in `@voicespark/core`, for server-side prompt diffs
- No Markdown library. The web app gets a small in-house safe renderer (`apps/web/components/profiles/doc-markdown.tsx`): paragraphs, lists, bold, italic and `###` headings; everything else is literal text; no `dangerouslySetInnerHTML`

**Storage**:
- PostgreSQL 17 with migration `0007_analysis_prompts.sql` plus a TypeScript post-migration backfill
- `tone_definition_version.analysis_prompt` holds the admin default as plain admin configuration, limited to 20,000 characters
- `own_analysis_prompt` and `own_analysis_prompt_version` hold user prompts; `prompt_text_enc` uses AES-256-GCM (`user-content`)
- Documents reuse `profile_version.body_enc` (AES-256-GCM) with a new `format` column
- Redis 7.4 and Supermemory are unchanged

**Testing**:
- Vitest unit and integration tests (Postgres 127.0.0.1:55432, Redis 56379) and the admin-isolation project
- Playwright e2e with the fake LLM
- Tests for each new inspection site (own prompt, direct edit, output) are written first and must fail first
- The filter corpus gates are unchanged

**Target Platform**: Unchanged from spec 001 (Linux server, Docker Compose, Caddy).

**Project Type**: Web application (full-stack monorepo) plus a background worker. Unchanged.

**Performance Goals**:
- A published default applies to the next generation in under 1 min (SC-001); active versions are read without caching
- Default-change notifications arrive in under 1 min (SC-005); fan-out runs inline, under 1 s for 1,000 users
- Own prompt save p95 under 500 ms; a diff of two 20,000-character prompts under 100 ms
- Generation stays within the 10-minute first-profile target of spec 001 (SC-006)
- Customise to saved own prompt in under 3 min (SC-002)

**Constraints**:
- 20,000-character limit for own and default prompts (FR-011)
- Privacy rules and the document format are structural and never depend on prompt text (FR-010)
- A document missing a required part is rejected and no version is saved (FR-021)
- Admins see counts only, never own prompts or documents (FR-005)
- No prompt text, content or excluded values in logs, audit entries or notification payloads
- Rolling back the generation templates to their dimension-based v1 is blocked on purpose (see research)

**Scale/Scope**:
- 1,000 users, up to 10 definitions, up to 20 aspects per document
- About 5 new user screens or sections and 2 admin sections
- 5 user stories and 26 functional requirements

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against constitution v1.0.0 (`.specify/memory/constitution.md`, ratified 2026-10-19). Gates G1–G7 map one-to-one to Principles I–VII.

| Gate | Source | Pre-design | Post-design | Evidence |
|------|--------|------------|-------------|----------|
| G1 / I. Privacy by Design: the own prompt, feedback, direct edits, authored samples, received context and previous document are inspected before any LLM call; the output is inspected after; admin preview uses synthetic samples only; Supermemory writes are unchanged | FR-010, FR-017, FR-004 | PASS | PASS | research (layering, input and output inspection); contracts/analysis-prompt.md; tasks to follow |
| G2 / II. Least-Privilege Access: no new scopes, no new provider access | Plan scope | PASS | PASS | Plan scope: no change to sign-in or mailbox adapters |
| G3 / III. Admins Never See Content: own prompts and documents sit in `*_enc` columns read only by user and system services; admins get `ownPromptCount`; lint import ban, forbidden response fields, isolation tests and foreign-access 404 with audit are extended | FR-005, SC-007 | PASS | PASS | data-model "Content-class columns"; contracts/http-api.md "Admin"; research (admin isolation) |
| G4 / IV. Test-First Filtering: no new detector or category; tests for the new inspection sites are written failing first; corpus gates unchanged | SC-004 | PASS | PASS | research (testing strategy); quickstart.md |
| G5 / V. Simplicity: no new service, package or queue technology; one npm dependency and one new job name (`analysis.preview`) on the existing `profile` queue | Plan scope | PASS | PASS | research (diff library, preview mode); contracts/jobs.md |
| G6 / VI. Fail-Closed and Audited: failed inspection of the own prompt or output fails generation with no version; invalid output stores nothing; admin publish, rollback and draft changes and user customise, save and reset write audit entries with ids and counts only | FR-021, FR-026 | PASS | PASS | contracts/analysis-prompt.md "Error codes"; data-model "Audit"; contracts/jobs.md |
| G7 / VII. Secrets Encrypted at Rest: own prompt text and document bodies use AES-256-GCM with the keyring; the excerpt scrub re-encrypts with the active key | FR-005, FR-018 | PASS | PASS | data-model "Content-class columns"; research (excerpt scrub) |

## Project Structure

### Documentation (this feature)

```text
specs/002-voice-analysis-prompt/
├── plan.md                          # This file (/speckit-plan command output)
├── research.md                      # Phase 0 output (/speckit-plan command)
├── data-model.md                    # Phase 1 output (/speckit-plan command)
├── quickstart.md                    # Phase 1 output (/speckit-plan command)
├── contracts/                       # Phase 1 output (/speckit-plan command)
│   ├── analysis-prompt.md
│   ├── http-api.md
│   ├── notifications.md
│   └── jobs.md
├── checklists/
│   └── requirements.md              # Existing spec quality checklist
└── tasks.md                         # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

This lists only what this feature adds or changes. The rest of the tree is as in spec 001.

```text
packages/
  db/                           # @voicespark/db
    src/schema/definitions.ts  profiles.ts  enums.ts  notifications.ts  audit.ts   # changed
    src/schema/own-prompts.ts                                                      # new; exported from index.ts
    drizzle/0007_analysis_prompts.sql  drizzle/meta/                               # new migration and journal
    src/data/analysis-prompts.ts          # new: buildAnalysisPromptFromDimensions, backfillAnalysisPrompts
    src/migrate.ts  src/seed.ts           # backfill hook; seed uses the new templates
    src/repos/admin/definitions.ts  src/repos/admin/types.ts   # analysisPrompt, ownPromptCount
    src/repos/user/own-prompts.ts  src/repos/system/own-prompts.ts   # new
  core/                         # @voicespark/core
    src/prompting/analysis.ts             # new: guard, wrap, neutralizeTags
    src/prompting/document-schema.ts      # new: schema, postValidateDocument, adapters
    src/prompting/variables.ts  fake-llm.ts  preview-fixture.json  index.ts   # changed
    src/prompting/preview-samples.json    # new: built-in sample writing
    src/text-diff.ts                      # new: textDiff()
    src/services/own-prompts.ts           # new (user-only)
    src/services/definitions.ts  profiles.ts  prompts.ts  drafts.ts  deletion.ts  audit.ts   # changed
    src/queues/index.ts                   # analysis.preview
apps/
  worker/                       # @voicespark/worker
    src/processors/profile.ts  draft.ts             # document pipeline; format-aware draft input
    src/processors/analysis-preview.ts              # new
  web/                          # @voicespark/web
    app/api/analysis-prompts/**                     # new user routes
    app/api/profiles/[id]/document/route.ts         # new; version route changed
    app/api/admin/definitions/[id]/versions/[versionId]/{preview,preview-run}/   # new admin routes
    app/(user)/profiles/[profileId]/page.tsx        # document view, legacy fallback, banner
    app/(user)/profiles/[profileId]/{analysis-prompt,edit}/page.tsx   # new
    app/(user)/notifications/page.tsx               # describe() case
    app/(admin)/admin/definitions/[definitionId]/page.tsx   # ownPromptCount
    components/profiles/{document-view,doc-markdown,document-editor,analysis-prompt-editor,
                         default-changed-banner,excerpt-source}.tsx   # new
    components/ui/text-diff.tsx                     # new
    components/admin/{definition-forms,dimension-editor}.tsx   # changed
    components/admin/analysis-preview.tsx           # new
    lib/admin-schemas.ts                            # new fields and forbidden keys
    e2e/                                            # changed and new specs
eslint.config.js                                    # ban own-prompts for admin code
```

**Structure Decision**: The feature fits the existing monorepo. `@voicespark/integrations` does not change. Default prompts live on `tone_definition_version`, so versioning, publish, rollback and history are reused. Own prompts are the only new tables, and documents reuse `profile_version`, so numbering, ratings and draft pins keep working. Prompt guarding and output validation live in `@voicespark/core/src/prompting`, and the worker runs them. The admin preview run is a new job on the existing `profile` queue. Admin code never imports the own-prompts service, and lint enforces it.

## Complexity Tracking

No violations. Every Constitution Check gate passes without a justified exception.
