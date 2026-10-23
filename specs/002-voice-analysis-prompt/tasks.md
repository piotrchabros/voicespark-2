---

description: "Task list for 002-voice-analysis-prompt"
---

# Tasks: Tone-of-Voice Analysis Prompt with Per-User Override

**Input**: Design documents from `/specs/002-voice-analysis-prompt/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (analysis-prompt.md, http-api.md, jobs.md, notifications.md), quickstart.md

**Tests**: Included. Constitution Principle IV (Test-First Filtering) and plan.md "Testing" require tests for each new inspection site (own prompt, direct edit, output) to be written first and to fail first. quickstart.md section 4 lists the unit and integration coverage.

**Organization**: Tasks are grouped by user story (spec.md US1–US5) so each story can be implemented and tested on its own after the Foundational phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md
- Paths are relative to the repository root (`/root/voicespark-2`)

## Path Conventions

pnpm monorepo: `packages/db` (`@voicespark/db`), `packages/core` (`@voicespark/core`), `apps/worker` (`@voicespark/worker`), `apps/web` (`@voicespark/web`). Unit tests: `packages/core/test/*.test.ts`, `apps/web/test/*.test.ts`. Integration tests: `*.integration.test.ts` (Postgres 127.0.0.1:55432, Redis 56379). Admin isolation: `apps/web/test/admin-isolation/`. E2E: `apps/web/e2e/*.spec.ts`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependency and shared constants

- [X] T001 Add dependency `diff` pinned to exactly `8.0.4` to `packages/core/package.json` (research R10; do not take 9.x) and run `pnpm install` to update `pnpm-lock.yaml`
- [X] T002 [P] Add the enum constants `PROFILE_VERSION_FORMATS = ['structured','document']` and `ANALYSIS_PROMPT_SOURCES = ['default','own']` with `pgEnum` wrappers `profile_version_format` and `analysis_prompt_source` in `packages/db/src/schema/enums.ts`
- [X] T003 [P] Add `analysis_prompt_default_changed` to `NOTIFICATION_TYPES` in `packages/db/src/schema/notifications.ts` (in-app only; do NOT add it to `EMAILED_NOTIFICATION_TYPES` in `packages/integrations/src/smtp/mailer.ts`)
- [X] T004 [P] Add audit actions `analysis_prompt.customised`, `analysis_prompt.saved`, `analysis_prompt.reset`, `profile.document_edited` to `AUDIT_ACTIONS` in `packages/db/src/schema/audit.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, migration, backfill, shared prompting and document code that every story needs

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Schema and migration

- [X] T005 Add column `analysisPrompt` (`analysis_prompt text`, nullable, CHECK `tone_definition_version_analysis_prompt_len`: `analysis_prompt is null or char_length(analysis_prompt) <= 20000`) and set `dimensions` default `'[]'::jsonb` (still `not null`) in `packages/db/src/schema/definitions.ts`
- [X] T006 Create `packages/db/src/schema/own-prompts.ts` with tables `own_analysis_prompt` (`id` uuid pk default random; `user_id` not null fk `user` ON DELETE CASCADE; `definition_id` not null fk `tone_definition` no cascade; `in_use` bool not null default true; `current_version_id` uuid nullable fk `own_analysis_prompt_version` ON DELETE SET NULL; `created_at`, `updated_at` timestamptz not null default now; unique `own_analysis_prompt_user_definition_uq (user_id, definition_id)`; partial index `own_analysis_prompt_definition_in_use_idx (definition_id) where in_use`; CHECK `own_analysis_prompt_in_use_has_version`: `not in_use or current_version_id is not null`) and `own_analysis_prompt_version` (`id` uuid pk; `own_prompt_id` not null fk ON DELETE CASCADE; `version_number` int not null starting at 1; `prompt_text_enc` text not null; `char_count` int not null CHECK `char_count between 1 and 20000`; `based_on_definition_version_id` uuid not null fk `tone_definition_version` no cascade; `created_at` timestamptz not null default now; unique `own_analysis_prompt_version_number_uq (own_prompt_id, version_number)`; index on `own_prompt_id`), and export it from `packages/db/src/schema/index.ts`
- [X] T007 Add to `profile_version` in `packages/db/src/schema/profiles.ts`: `format` (`profile_version_format`, not null, default `'structured'`), `promptSource` (`analysis_prompt_source`, nullable), `ownPromptVersionId` (uuid nullable fk `own_analysis_prompt_version` ON DELETE SET NULL), CHECK `profile_version_prompt_source_consistent` (`own_prompt_version_id is null or prompt_source = 'own'`); add `ownPromptVersionId` (uuid nullable fk ON DELETE SET NULL) to `profile_generation` in the same file
- [X] T008 Generate and hand-edit `packages/db/drizzle/0007_analysis_prompts.sql` plus the journal/snapshot in `packages/db/drizzle/meta/`, in the order of data-model.md "Migration 0007": (1) create both enum types, (2) alter `tone_definition_version` (column, CHECK, dimensions default), (3) create both own-prompt tables and indexes, then add the circular `current_version_id` FK last, (4) alter `profile_version` (+ FK and consistency CHECK), (5) alter `profile_generation`, (6) drop and recreate `notification_type_check` with `analysis_prompt_default_changed` added to the 001 list (depends on T002–T007)

### Backfill (FR-025)

- [X] T009 [P] Write failing unit tests in `packages/db/src/data/analysis-prompts.test.ts` for `buildAnalysisPromptFromDimensions`: exact template text from contracts/analysis-prompt.md "buildAnalysisPromptFromDimensions"; empty description omitted; one line per dimension in stored order; empty parts skipped; spaces collapsed; value guidance for scale (`Rate it on a scale {min}-{max} ({min}={minLabel}, {max}={maxLabel}).`), enum (`Pick one of: ...`), text (`Describe it in free text.`), list (`Give a list of short phrases.`); the seeded Formality example line; result trimmed and ≤ 20,000 chars; uses "the author"
- [X] T010 Create `packages/db/src/data/analysis-prompts.ts` exporting pure `buildAnalysisPromptFromDimensions({name, description, dimensions})` (move or duplicate `valueSpec` here so core can re-export it) and `backfillAnalysisPrompts(db)`: one transaction; (1) `UPDATE tone_definition_version SET analysis_prompt = build(...) WHERE analysis_prompt IS NULL` for all statuses (draft, active, superseded); (2) for `tone_profile.generate` and `tone_profile.feedback`, if the active version's templates lack `{{analysisPrompt}}`, insert v2 active with the document-oriented wrapper templates (contracts/analysis-prompt.md "Wrapper v2 templates"), model and effort copied from the previous version, `max_tokens` 16000, actor nil uuid, supersede the old version and insert a `version_activation` row with action `publish`; idempotent (depends on T005, T009)
- [X] T011 Call `backfillAnalysisPrompts(db)` right after the drizzle `migrate()` call in `packages/db/src/migrate.ts`, and in `packages/db/src/seed.ts` seed the v2 wrapper templates as v1 for fresh installs and set `analysis_prompt` on seeded definition versions through `buildAnalysisPromptFromDimensions` (depends on T010)
- [X] T012 [P] Write integration test `packages/core/test/analysis-prompts-backfill.integration.test.ts`: after migrate + backfill every `tone_definition_version` has a non-empty `analysis_prompt`; v2 of both wrapper keys is active and contains `{{analysisPrompt}}`; a second `backfillAnalysisPrompts` run changes nothing; existing `profile_version` rows keep `format = 'structured'` and `prompt_source` null (depends on T011)

### Prompting core: guard, neutralise, document schema, diff

- [X] T013 [P] Write failing unit tests in `packages/core/test/analysis-guard.test.ts` for `packages/core/src/prompting/analysis.ts`: `ANALYSIS_GUARD` and `ANALYSIS_GUARD_REMINDER` exact text with `{labels}` substitution (`none` when empty); `neutralizeTags` breaks `</analysis_prompt`, `<analysis_prompt`, `</sample`, `<sample`, `</item`, `<item`, `<received_context`, `</received_context`, `<feedback`, `</feedback` case-insensitive with optional spaces by inserting U+200B after `<`/`</`; `wrapAnalysisPrompt(text, source)` produces `<analysis_prompt source="default|own">\n{trimmed, neutralised}\n</analysis_prompt>`; `stripNeutralizer` removes U+200B; `buildMessages(system, user, labels)` yields `ANALYSIS_GUARD + "\n\n" + system` and `user + "\n\n" + ANALYSIS_GUARD_REMINDER`
- [X] T014 Implement `packages/core/src/prompting/analysis.ts` (guard texts verbatim from contracts/analysis-prompt.md, `neutralizeTags`, `stripNeutralizer`, `wrapAnalysisPrompt`, `buildMessages`) until T013 passes (depends on T013)
- [X] T015 [P] Write failing unit tests in `packages/core/test/document-schema.test.ts` for `packages/core/src/prompting/document-schema.ts`: `buildDocumentOutputSchema()` matches the JSON schema in contracts/analysis-prompt.md "Output schema" (aspects 1–20, key `^[a-z][a-z0-9_]{1,40}$`, name ≤ 80; summary ≤ 1200; heading ≤ 120; markdown ≤ 4000; doList/dontList 1–10 items ≤ 200; excerpts 3–12, text ≤ 300, sampleRef `^A[0-9]+$`; strict); every `postValidateDocument` problem code (`aspect_missing:{key}`, `aspect_duplicate`, `section_unknown`, `summary_missing`, `do_list_empty`, `dont_list_empty`, `too_few_excerpts`, `excerpt_dropped:{i}`, `received_quote`) with whitespace-normalised verbatim excerpt matching after U+200B stripping, 8-word lowercased punctuation-stripped shingles allowed when also present in authored samples; `mapExcerptsToItems` maps `A{n}` → `contentItemId` server-side; `structuredToDocument(body, dimensions)`; `documentToMarkdown`; `toPromptDocumentJson` (no `contentItemId`)
- [X] T016 Implement `packages/core/src/prompting/document-schema.ts` with the `VoiceDocument`, `DocumentOutput`, `VersionBodyView`, `ExcerptSource`, `VersionView` types from data-model.md "TypeScript shapes", `buildDocumentOutputSchema`, `postValidateDocument`, `receivedOverlap`, `mapExcerptsToItems`, `structuredToDocument`, `documentToMarkdown`, `toPromptDocumentJson`, `MAX_LLM_CALLS = 2` until T015 passes (depends on T014, T015)
- [X] T017 [P] Write failing unit tests in `packages/core/test/text-diff.test.ts`: `textDiff(a, b): DiffOp[]` (`{op:'equal'|'insert'|'delete', value}`), line-based with word-level ops inside changed lines; identical input → only `equal`; diff of two 20,000-char prompts under 100 ms
- [X] T018 Implement `packages/core/src/text-diff.ts` with jsdiff `diffLines` + `diffWords` until T017 passes and export it from the core package entry points (depends on T001, T017)
- [X] T019 Update `packages/core/src/prompting/variables.ts`: for `tone_profile.generate` required `definition.name`, `analysisPrompt`, `authoredSamples`; optional `definition.description`, `receivedContext`, `authoredStats.itemCount`, `authoredStats.wordCount`, `authoredStats.languages`, `previousDocumentJson`, `user.firstName`, `excludedCategoryLabels`; for `tone_profile.feedback` additionally required `feedback`, `previousDocumentJson`; remove `definition.dimensionsJson`, `definition.dimensions` (and list item fields), `previousProfileJson`; add optional `voiceDocument` to `draft.social_post`, `draft.bio`, `draft.short_article`; make `formatAuthoredSamples` and `formatReceivedContext` in `packages/core/src/prompting/samples.ts` call `neutralizeTags` on every text (depends on T014)
- [X] T020 [P] Update `packages/core/src/prompting/preview-fixture.json` (replace dimension fields with `analysisPrompt` and `previousDocumentJson`) and create `packages/core/src/prompting/preview-samples.json` (about 8 synthetic authored samples and 3 received items, every one marked `SAMPLE TEXT`)
- [X] T021 Update `packages/core/src/prompting/fake-llm.ts` to return a valid `DocumentOutput` for document schema calls (one section per aspect declared from a parseable `<analysis_prompt>` list, verbatim excerpts from the `A{n}` samples), with test switches for: missing summary, empty do/don't, too few excerpts, received quote, refusal; export new modules from `packages/core/src/prompting/index.ts` (depends on T016)
- [X] T022 Update `packages/core/test/prompting.test.ts` for the new whitelist: v2 templates validate; v1 dimension-based templates are rejected with `unknown_template_variable` listing `definition.dimensionsJson`/`previousProfileJson`; samples and received items are neutralised (depends on T019, T020)

### Shared service/repo plumbing

- [X] T023 Add `decryptVersionBody(v)` returning `{format:'structured', body: ProfileBody} | {format:'document', body: VoiceDocument}` and make version reads/writes carry `format`, `promptSource`, `ownPromptVersionId` in `packages/core/src/services/profiles.ts` and `packages/db/src/repos/user/profiles.ts` (depends on T007, T016)
- [X] T024 [P] Create system repo `packages/db/src/repos/system/own-prompts.ts` with `listInUseForDefinition(tx, definitionId)` returning `{userId, ownPromptId, basedOnDefinitionVersionId}` only (joins the current version's `based_on_definition_version_id`; never selects `prompt_text_enc`) and `countInUseByDefinition(db)` (depends on T006)
- [X] T025 Add `@voicespark/core/services/own-prompts`, `@voicespark/db/repos/user/own-prompts` and relative `./own-prompts` imports to the admin import ban list in `eslint.config.js` (research R17)

**Checkpoint**: Migration, backfill, guard, document schema, diff and shared plumbing ready. `pnpm lint && pnpm typecheck && pnpm test` pass.

---

## Phase 3: User Story 1 - Admin defines the default analysis prompt (Priority: P1) 🎯 MVP

**Goal**: Admins edit, preview, publish and roll back a versioned analysis prompt per definition; the active version is every user's default.

**Independent Test**: Admin adds an aspect to a draft analysis prompt and publishes it; the next generation for a user without an own prompt records that definition version (and, with US2, has a section for the new aspect).

### Tests for User Story 1 (write first, must fail)

- [X] T026 [P] [US1] Extend `packages/core/test/definitions-admin.integration.test.ts`: a non-empty prompt that tells the model to drop the summary or excerpts still publishes (spec US1 AS5; the required parts are enforced by code, see T043); create definition with `{key, name, description, analysisPrompt}` stores `dimensions = []`; `dimensions` in create/update-draft body → 422 `validation_failed` `field: 'dimensions'`; `analysisPrompt` over 20,000 chars on save → 422 `{field:'analysisPrompt', reason:'too_long', maxChars:20000}`; publish and rollback with empty-after-trim or too-long prompt → 422 `{field:'analysisPrompt', reason:'empty'|'too_long'}`; `createDraft` copies `analysisPrompt` and `dimensions` from source; `diff()` has an `analysisPrompt` entry; draft is never used by generation pins
- [X] T027 [P] [US1] Extend `apps/web/test/admin-definitions-routes.test.ts` for the changed bodies and responses (`analysisPrompt` on versions, `ownPromptCount` on list items, `dimensions` read-only) and the new routes `POST .../versions/{versionId}/preview` (render only, returns `{system, user}` with guard, fixture samples and reminder), `POST .../preview-run` (202 `{jobId:'preview-{uuid}'}`, 429 `rate_limited`), `GET .../preview-run/{jobId}` (`{status, markdown, problems}`; 404 for a job of another version)
- [X] T028 [P] [US1] Extend `apps/web/test/admin-prompts-routes.test.ts`: publish and rollback run publish-mode `validateTemplate`; rolling back `tone_profile.generate`/`tone_profile.feedback` to the dimension-based v1 returns 422 `unknown_template_variable` with `details.unknownVariables`
- [X] T029 [P] [US1] Write `apps/worker/test/analysis-preview.integration.test.ts`: `analysis.preview` job with fake LLM returns `{status:'done', markdown, problems:[]}`, reads only `preview-samples.json`, makes no Supermemory call and writes no DB rows; missing version or non-admin → `failed`; invalid output twice → `{status:'failed', markdown:null, problems:['invalid_output', ...]}`

### Implementation for User Story 1

- [X] T030 [US1] Update `packages/core/src/services/definitions.ts`: `analysisPrompt` on create/updateDraft (draft may be null/empty/partial; ≤ 20,000 chars), reject `dimensions`, `createDraft` copies both fields, publish/rollback validation (`trim` non-empty, ≤ 20,000), `diff()` adds `analysisPrompt` (depends on T005)
- [X] T031 [P] [US1] Update `packages/db/src/repos/admin/definitions.ts` and `packages/db/src/repos/admin/types.ts`: version view adds `analysisPrompt: string | null`, list item adds `ownPromptCount` (count of `own_analysis_prompt` where `in_use`, per definition; no text selected) (depends on T006)
- [X] T032 [US1] Update `packages/core/src/services/prompts.ts`: rollback and publish run publish-mode `validateTemplate`; `preview` for `tone_profile.*` uses the new fixture, `wrapAnalysisPrompt` and `buildMessages`; add `previewDefinitionVersion(definitionVersionId, kind)` that renders guard + active wrapper with that version's `analysisPrompt` against the fixture (no LLM call) (depends on T014, T019, T020)
- [X] T033 [US1] Add job name `analysis.preview` with zod payload `{definitionVersionId: uuid, adminId: uuid}`, attempts 1, job id `preview-{uuid}`, on the existing `profile` queue in `packages/core/src/queues/index.ts`, and extend `packages/core/test/queues.test.ts`
- [X] T034 [US1] Extract the shared document pipeline (neutralise, wrap, render pinned/active wrapper, guard + reminder, model call with `buildDocumentOutputSchema()`, `postValidateDocument` with one retry carrying the problem codes, `llm_refused` on refusal) into `apps/worker/src/document-pipeline.ts` for use by both `analysis.preview` and `profile.generate` (depends on T016, T019, T021)
- [X] T035 [US1] Create `apps/worker/src/processors/analysis-preview.ts` (handler for `analysis.preview`: verify active admin and version exist, use `preview-samples.json` only, run `document-pipeline`, return `{status, markdown: documentToMarkdown(doc)|null, problems}`; no DB writes; logs ids and problem codes only) and register it in `apps/worker/src/index.ts` (depends on T033, T034)
- [X] T036 [US1] Update admin definition routes in `apps/web/app/api/admin/definitions/route.ts`, `apps/web/app/api/admin/definitions/[id]/route.ts`, `apps/web/app/api/admin/definitions/[id]/versions/route.ts`, `apps/web/app/api/admin/definitions/[id]/versions/[versionId]/route.ts` for `analysisPrompt`, read-only `dimensions` and `ownPromptCount` (depends on T030, T031)
- [X] T037 [P] [US1] Create `apps/web/app/api/admin/definitions/[id]/versions/[versionId]/preview/route.ts` (render only, existing admin limiter) (depends on T032)
- [X] T038 [P] [US1] Create `apps/web/app/api/admin/definitions/[id]/versions/[versionId]/preview-run/route.ts` (enqueue, 202, rate-limited) and `apps/web/app/api/admin/definitions/[id]/versions/[versionId]/preview-run/[jobId]/route.ts` (read job return value; 404 if the job's `definitionVersionId` differs) (depends on T033)
- [X] T039 [P] [US1] Update `apps/web/lib/admin-schemas.ts`: allow `analysisPrompt`, `ownPromptCount` and preview `{system, user}` / `{status, markdown, problems}`; add `promptText` and `sections` to the forbidden keys; register the new schemas in `ADMIN_RESPONSE_SCHEMAS`
- [X] T040 [US1] Update `apps/web/components/admin/definition-forms.tsx` (an "Analysis prompt" textarea with a live 20,000-char counter replaces the dimension inputs on create/edit draft) and make `apps/web/components/admin/dimension-editor.tsx` read-only for legacy versions
- [X] T041 [P] [US1] Create `apps/web/components/admin/analysis-preview.tsx` (render preview panel and run preview with polling of `preview-run/{jobId}`, shows `markdown` via the safe renderer and `problems`)
- [X] T042 [US1] Update `apps/web/app/(admin)/admin/definitions/[definitionId]/page.tsx` and `apps/web/app/(admin)/admin/definitions/page.tsx` to show the analysis prompt per version, history/diff including `analysisPrompt`, the preview panel and `ownPromptCount` (depends on T036, T040, T041)

**Checkpoint**: Admin can draft, preview, publish and roll back analysis prompts; isolation schemas updated.

---

## Phase 4: User Story 2 - Tone-of-voice document generated from the prompt (Priority: P1)

**Goal**: Generation produces a validated sectioned `VoiceDocument` from the applicable prompt with privacy and format enforced in code; users view, give feedback on and directly edit it; drafting uses it.

**Independent Test**: With a 5-aspect prompt, generate a document and confirm 5 sections, a summary, do/don't lists and ≥ 3 excerpts that link only to the user's authored items.

### Tests for User Story 2 (write first, must fail)

- [X] T043 [P] [US2] Rewrite `apps/worker/test/profile-generate.integration.test.ts` for documents: stored version has `format = 'document'`, `prompt_source = 'default'`, pinned `definition_version_id` and `prompt_version_id`; one section per declared aspect; `contentItemId` mapped from `sampleRef`; missing summary / empty do-don't / too few excerpts twice → `failed` `invalid_output`, no version, previous version stays current, `generation_failed` notified; refusal → `llm_refused`; prompt text asking to drop the summary/excerpts still yields a document with all required parts (US1 AS5); eligibility re-check and `blocked` status, authored/received sample loading and `languages` behave as in 001 (FR-023); output `inspect()` throwing (classifier error) stores no version and ends `inspection_failed` after the last attempt (Principle VI); received-quote output → `invalid_output`; excluded category (e.g. payment card) never appears in output; output inspection: wholly excluded summary → `output_excluded`; feedback wholly excluded → `feedback_excluded` with no LLM call; feedback on a legacy structured latest produces a document; FR-019: publishing a new default after the generation row was created does not change the pinned version used
- [X] T044 [P] [US2] Extend `packages/core/test/profiles.integration.test.ts`: `createGenerations` pins `definition_version_id` (active), wrapper `prompt_version_id` and `own_prompt_version_id = null` (default case) in one transaction; `POST /document` service: base must be latest and `document` (else 409 `conflict`), limits (summary 1–1200; sections 1–20, heading 1–120, markdown ≤ 4000; do/dont 1–10 items ≤ 200; `keepExcerpts` ≥ 1 valid indexes), any exclusion or redaction in summary/heading/markdown/do/don't → 422 `sensitive_content` `details.fields` and nothing stored (test-first inspection site), new version `origin = 'manual_edit'` keeps base `prompt_source` and `own_prompt_version_id`, base `aspectKey` kept by index and `custom_{n}` for extra sections, audit `profile.document_edited`; `adjust` on a document latest → 409 `conflict`
- [X] T045 [P] [US2] Extend `packages/core/test/us7-deletion.integration.test.ts`: `scrubDeletedExcerpts` drops excerpts of deleted items from every version (document and legacy structured), re-encrypts with the active key, sets `outdated_reason = 'sources_deleted'` and notifies `profile_outdated` only when the latest version changed, and is idempotent; covers `purgeItems` finalize and `deleteSource`
- [X] T046 [P] [US2] Extend `apps/worker/test/draft-generate.integration.test.ts`: draft from a document version passes `profileJson = {format:'document', summary, sections:[{heading, markdown}], doList, dontList, excerpts:[{text}], languages}` without `contentItemId` and the optional `voiceDocument` Markdown
- [X] T047 [P] [US2] Extend `apps/web/test/profiles-routes-a.test.ts` / `apps/web/test/profiles-routes-b.test.ts`: version view returns `format`, `promptSource`, `analysisPrompt` (`{kind:'default', definitionVersion}` | `{kind:'own', ownVersion}` | null), `excerptSources` (deleted item → `null`); `POST /api/profiles/{id}/document` status codes per contracts/http-api.md
- [X] T048 [P] [US2] Write unit tests `apps/web/test/doc-markdown.test.tsx` for the safe renderer: paragraphs, flat `-`/`1.` lists, `**bold**`, `*italic*`, `###` headings; `#`/`##`, raw HTML (`<b>x</b>`), links, images, tables, code fences render as literal text; never uses `dangerouslySetInnerHTML`

### Implementation for User Story 2

- [X] T049 [US2] Update `packages/core/src/services/profiles.ts` `createGenerations`: lock `tone_profile` and the active `tone_definition_version`, select the user's `own_analysis_prompt` `FOR UPDATE`, pin `own_prompt_version_id = current_version_id` when `in_use` else null, pin the wrapper version (data-model.md "Generation pin resolution") (depends on T023)
- [X] T050 [US2] Add `storeGeneratedDocument` in `packages/core/src/services/profiles.ts`: write `format = 'document'`, `prompt_source`, `own_prompt_version_id`, `definition_version_id`, `prompt_version_id`, encrypted `body_enc`; notify `profile_ready` (depends on T049)
- [X] T051 [US2] Add `editDocument(userId, profileId, input)` in `packages/core/src/services/profiles.ts` per contracts/http-api.md `POST /api/profiles/{id}/document` (optimistic lock as `adjust`, inspection of each text field → 422 `sensitive_content {fields}`, `manual_edit`, aspect key mapping, audit `profile.document_edited` with ids/counts only); make `adjust` return 409 `conflict` when the latest version is a document (depends on T023)
- [X] T052 [US2] Add `scrubDeletedExcerpts(tx, userId, itemIds)` in `packages/core/src/services/profiles.ts` and call it from `purgeItems` finalize and `deleteSource` in `packages/core/src/services/deletion.ts` (same transaction) (depends on T023)
- [X] T053 [US2] Add the version view builder in `packages/core/src/services/profiles.ts` and `packages/db/src/repos/user/profiles.ts`: `format`, `promptSource`, `analysisPrompt` kind/version lookup, `excerptSources` resolved through `content_item`, `content_item_occurrence`, `connected_source` (`{kind, itemDate, sourceLabels}` or null) (depends on T023)
- [X] T054 [US2] Rewrite `apps/worker/src/processors/profile.ts` per contracts/jobs.md (4): keep steps 1–2 from 001 unchanged (eligibility and definition status re-check → `blocked`, authored `A{n}` samples, up to 20 received items, languages; FR-023); re-inspect samples, received context and previous version (legacy converted by `structuredToDocument`; wholly excluded → empty `previousDocumentJson`); resolve the analysis prompt from pins (own: decrypt + `inspect()`, wholly excluded → `analysis_prompt_excluded` with no LLM call, redacted text used; else the pinned version's `analysis_prompt`; pinned own version missing → `analysis_prompt_missing`); feedback inspected first (`feedback_excluded`); any `inspect()` that cannot complete (own prompt, feedback, output) is fail-closed: throw a retryable error, store nothing, final code `inspection_failed`; run `document-pipeline`; inspect output (joined once, per field on hit; `output_excluded`); map excerpts; `storeGeneratedDocument`; logs ids, counts, problem codes only (depends on T034, T050)
- [X] T055 [US2] Update `apps/worker/src/processors/draft.ts`: use `decryptVersionBody`; document → new `profileJson` shape; structured → exactly the 001 `toPromptProfileJson` output; `profileSummary` and `languageHint` from both formats; optional `voiceDocument` via `documentToMarkdown` (depends on T023)
- [X] T056 [P] [US2] In `packages/core/src/services/drafts.ts`, make draft creation accept a profile whose latest version has `format = 'document'` (remove any structured-only body read; keep pinning `profileVersionId` and `promptVersionId`) and add a case to `packages/core/test/drafts.integration.test.ts` creating a draft from a document version (depends on T023)
- [X] T057 [US2] Update `apps/web/app/api/profiles/[id]/route.ts` and `apps/web/app/api/profiles/[id]/versions/[versionId]/route.ts` to return the new version view; make `apps/web/app/api/profiles/[id]/adjust/route.ts` map the document case to 409 (depends on T051, T053)
- [X] T058 [P] [US2] Create `apps/web/app/api/profiles/[id]/document/route.ts` (`requireUser`, zod body per contract, 201 `{version}`) (depends on T051)
- [X] T059 [P] [US2] Create `apps/web/components/profiles/doc-markdown.tsx` (safe in-house renderer, React elements only) until T048 passes
- [X] T060 [P] [US2] Create `apps/web/components/profiles/excerpt-source.tsx` (kind, date, source labels; links to `/content?item={id}`; "source deleted" without link when null)
- [X] T061 [US2] Create `apps/web/components/profiles/document-view.tsx` (summary, sections via `doc-markdown`, do/don't lists, excerpts with `excerpt-source`, "prompt used" line) (depends on T059, T060)
- [X] T062 [P] [US2] Create `apps/web/components/profiles/document-editor.tsx` and `apps/web/app/(user)/profiles/[profileId]/edit/page.tsx` (edit summary, section headings/markdown, do/don't; remove-only excerpts; shows `sensitive_content` field errors) (depends on T058)
- [X] T063 [US2] Update `apps/web/app/(user)/profiles/[profileId]/page.tsx`, `apps/web/components/profiles/version-history.tsx` and `apps/web/components/profiles/feedback-form.tsx` to render documents with `document-view`, link to the editor, hide `adjust-form` for documents; map new generation `errorCode`s (`invalid_output`, `analysis_prompt_excluded`, `output_excluded`, `feedback_excluded`, `llm_refused`, `analysis_prompt_missing`, `inspection_failed`) to short generic messages in `apps/web/components/profiles/generation-status.tsx` (depends on T057, T061, T062)

**Checkpoint**: US1 + US2 = MVP. Documents are generated, validated, viewed, edited and used for drafting.

---

## Phase 5: User Story 3 - User tailors their own analysis prompt (Priority: P2)

**Goal**: Users customise, save (versioned, encrypted), compare and reset their own analysis prompt per definition; generation uses it; hostile prompt text has no effect.

**Independent Test**: User copies the default, adds "how I sign off emails", saves, regenerates and the document has that section; another user does not.

### Tests for User Story 3 (write first, must fail)

- [X] T064 [P] [US3] Write `packages/core/test/own-prompts.integration.test.ts`: state machine from data-model.md "Own-prompt state machine" (none→own customise copies the active default text and `based_on`; own→own save inserts n+1 keeping `based_on`; own→reset sets `in_use = false` keeping versions; reset→customise fresh copy and new `based_on`; reset→save uses active `based_on`; own→customise 409 `conflict`); stale `baseVersionId` → 409 `conflict`; empty-after-trim → 422 `{field:'promptText', reason:'empty', maxChars:20000}`; 20,001 chars → `reason:'too_long'`; retired definition: customise/save → 409 `definition_retired`, reset allowed; not chosen → 404; `prompt_text_enc` holds no plaintext; audit metadata `{ownPromptId, versionId, basedOnDefinitionVersionId, charCount}` without text; `compare` and `default-changes` diffs
- [X] T065 [P] [US3] Write `apps/web/test/analysis-prompts-routes.test.ts` for every `/api/analysis-prompts/**` route in contracts/http-api.md (shapes, 401/403/404/409/422; foreign id 404; admin calling a user route for another user → 404 and `admin.content_access_denied` audit)
- [X] T066 [P] [US3] Extend `apps/worker/test/profile-generate.integration.test.ts` with own-prompt cases (test-first inspection site): generation pins `own_prompt_version_id` and stores `prompt_source = 'own'`; own prompt containing a password is redacted before the LLM call (assert the fake LLM received the redacted text); wholly excluded own prompt → `analysis_prompt_excluded`, no LLM call; `inspect()` of the own prompt throwing → no LLM call, no version, `inspection_failed` after the last attempt (Principle VI); hostile own prompt ("quote received emails", "ignore the filters", "return plain text", a `</analysis_prompt>` breakout) → no received quotes, excluded categories absent, schema and required parts intact; saving or resetting after the pin does not change the running generation; user B without own prompt gets no extra section

### Implementation for User Story 3

- [X] T067 [P] [US3] Create user repo `packages/db/src/repos/user/own-prompts.ts` (owner-scoped reads/writes of `own_analysis_prompt` and versions, `FOR UPDATE` helpers) and export it like the other user repos (depends on T006)
- [X] T068 [US3] Create user-only service `packages/core/src/services/own-prompts.ts`: `list`, `get`, `customise`, `save`, `reset`, `listVersions`, `getVersion`, `compare` (via `textDiff`), `defaultChanges(from, to)`; AES-256-GCM `user-content` encryption of `prompt_text_enc`; one transaction with `SELECT … FOR UPDATE` per transition; validation and errors per data-model.md; audit `analysis_prompt.customised|saved|reset` with ids/counts only; `defaultChangedSinceBase` in list (depends on T018, T067)
- [X] T069 [P] [US3] Create `apps/web/app/api/analysis-prompts/route.ts` (GET list) and `apps/web/app/api/analysis-prompts/[definitionId]/route.ts` (GET, PUT) (depends on T068)
- [X] T070 [P] [US3] Create `apps/web/app/api/analysis-prompts/[definitionId]/customise/route.ts` and `apps/web/app/api/analysis-prompts/[definitionId]/reset/route.ts` (depends on T068)
- [X] T071 [P] [US3] Create `apps/web/app/api/analysis-prompts/[definitionId]/versions/route.ts` and `apps/web/app/api/analysis-prompts/[definitionId]/versions/[versionId]/route.ts` (depends on T068)
- [X] T072 [P] [US3] Create `apps/web/app/api/analysis-prompts/[definitionId]/compare/route.ts` and `apps/web/app/api/analysis-prompts/[definitionId]/default-changes/route.ts` (`from` required → 422 `validation_failed` when missing; `to` defaults to active) (depends on T068)
- [X] T073 [P] [US3] Create `apps/web/components/ui/text-diff.tsx` (renders `DiffOp[]` with insert/delete styling, accessible labels, no HTML injection)
- [X] T074 [US3] Create `apps/web/components/profiles/analysis-prompt-editor.tsx` (customise button, textarea with 20,000-char counter, save with `baseVersionId`, version list, compare view with `text-diff`, reset button; shows empty/too_long/conflict errors) and `apps/web/app/(user)/profiles/[profileId]/analysis-prompt/page.tsx` (depends on T069–T073)
- [X] T075 [US3] Link the analysis prompt page from `apps/web/app/(user)/profiles/[profileId]/page.tsx` showing "default" or "own" mode; confirm no user UI exposes drafting or feedback prompts (FR-009) (depends on T074)

**Checkpoint**: Own prompts work end to end; generation honours them without weakening privacy or format.

---

## Phase 6: User Story 4 - Default changes while a user has their own prompt (Priority: P2)

**Goal**: Publishing or rolling back a changed default notifies in-use own-prompt users (in-app), who can see the diff and switch to the default in one step.

**Independent Test**: User with own prompt sees a notice after admin publishes a new default, opens the diff, switches to default; next generation records the new default version.

### Tests for User Story 4 (write first, must fail)

- [X] T076 [P] [US4] Extend `packages/core/test/definitions.integration.test.ts`: publish and rollback with changed trimmed `analysis_prompt` notify exactly the `in_use` own-prompt users with payload `{definitionId, ownPromptId, fromDefinitionVersionId (= based_on of current own version), toDefinitionVersionId}`; reset users, default users, suspended and deleted users get nothing; unchanged text (name/description/dimensions only) notifies nobody; audit `definition.version_published` / rollback metadata `{analysisPromptChanged, notifiedUsers}`; 1,000 users fan out in under 1 s; not emailed
- [X] T077 [P] [US4] Extend `apps/web/test/notifications-routes.test.ts` for the new type (payload holds ids only)

### Implementation for User Story 4

- [X] T078 [US4] In `definitions.activate()` in `packages/core/src/services/definitions.ts`, compare trimmed `analysis_prompt` of the target and previously active version; if different, in the same transaction call `listInUseForDefinition` and `notify(userId, 'analysis_prompt_default_changed', payload)` for each non-suspended user; add `{analysisPromptChanged, notifiedUsers}` to the publish/rollback audit metadata (depends on T024, T030)
- [X] T079 [P] [US4] Add the `analysis_prompt_default_changed` case to `describe()` in `apps/web/app/(user)/notifications/page.tsx` ("The default analysis prompt for {definition name} changed.", name looked up for the owner at display time) linking to `/profiles/{profileId}/analysis-prompt?from=…&to=…` (`profileId` resolved from `definitionId`; fallback `/profiles`)
- [X] T080 [P] [US4] Create `apps/web/components/profiles/default-changed-banner.tsx` (shown while `defaultChangedSinceBase`; links to the diff and offers "Use the default")
- [X] T081 [US4] Make `apps/web/app/(user)/profiles/[profileId]/analysis-prompt/page.tsx` honour `from`/`to` query params: show the default-changes diff from `GET .../default-changes` and a one-click "Use the default" (`POST .../reset`); show `default-changed-banner` on `apps/web/app/(user)/profiles/[profileId]/page.tsx` (depends on T074, T080)

**Checkpoint**: Default changes reach own-prompt users within 1 minute with a one-step reset.

---

## Phase 7: User Story 5 - Existing profiles keep working (Priority: P3)

**Goal**: Legacy structured versions remain viewable and usable for drafting; the next generation produces a document as a new version.

**Independent Test**: User with a legacy profile opens it, drafts with it, regenerates and gets a document as the next version while the old one stays viewable.

### Tests for User Story 5 (write first, must fail)

- [X] T082 [P] [US5] Extend `packages/core/test/profile-schema.test.ts` and `packages/core/test/document-schema.test.ts`: `structuredToDocument` turns each dimension into a section (heading = dimension name, markdown = value plus explanation) and keeps summary, do/don't, excerpts, languages
- [X] T083 [P] [US5] Extend `apps/worker/test/draft-generate.integration.test.ts` and `apps/worker/test/profile-generate.integration.test.ts`: draft from a legacy structured version passes `profileJson` byte-identical to 001 output (SC-006); regenerate on a legacy latest stores a `document` as the next version and the structured version stays readable via the version route

### Implementation for User Story 5

- [X] T084 [US5] Keep `apps/web/components/profiles/profile-body.tsx` rendering legacy `structured` bodies and branch on `format` in `apps/web/app/(user)/profiles/[profileId]/page.tsx` and `apps/web/components/profiles/version-history.tsx` so legacy versions stay viewable next to documents; keep `adjust-form.tsx` for a legacy latest (depends on T063)

**Checkpoint**: All five stories work independently.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T085 [P] Extend `apps/web/test/admin-isolation/seed.ts` to seed an own prompt and a document version containing `SECRET_MARKER`, and `apps/web/test/admin-isolation/admin-isolation.test.ts` to add the new admin routes (`preview`, `preview-run`, `preview-run/{jobId}`) to `EXPECTED_ADMIN_ROUTES` and assert no admin response contains the marker, `promptText` or `sections` (SC-007)
- [X] T086 [P] Extend `apps/worker/test/account-deletion.integration.test.ts`: account deletion removes `own_analysis_prompt`, its versions and all document versions by cascade; `analysis_prompt.*` audit rows remain with null actor and no text
- [X] T087 [P] Extend `apps/web/e2e/us6-admin.spec.ts`: admin edits the analysis prompt draft, renders and runs the preview (fake LLM), publishes, rolls back; list shows `ownPromptCount`
- [X] T088 [P] Extend `apps/web/e2e/us5-profiles.spec.ts`: generate a document (sections, summary, do/don't, excerpts with source), give feedback, edit directly; customise own prompt, compare, reset; default-change notification → diff → "Use the default"; legacy profile view and draft
- [X] T089 [P] Extend `apps/web/e2e/us7-deletion.spec.ts`: deleting the source of a quoted excerpt removes it from stored versions and shows the outdated banner
- [X] T090 Add an ops note to `apps/web/e2e/README.md` or `docs/` about the v2 template behaviour change on deploy and the blocked rollback to v1 (research Risks)
- [X] T091 Run quickstart.md sections 3–5 gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:admin-isolation`, then e2e under `flock /tmp/voicespark-e2e.lock` on port 3110

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: after Setup; blocks all stories
- **US1 (Phase 3)** and **US2 (Phase 4)**: after Foundational; US2's `profile.generate` reuses `apps/worker/src/document-pipeline.ts` from T034, so T054 depends on T034
- **US3 (Phase 5)**: after Foundational; the generation half (T066) needs US2's T049/T054
- **US4 (Phase 6)**: after US1 (T030) and US3 (T068, T074)
- **US5 (Phase 7)**: after US2 (T063)
- **Polish (Phase 8)**: after the stories it covers

### Story graph

```text
Setup → Foundational → US1 ─┬─────────────→ US4
                      └→ US2 ─┬→ US3 ───────┘
                              └→ US5
```

### Within each story

- Tests first; they must fail before implementation
- Schema/repo → service → worker → routes → UI

---

## Parallel Examples

### Foundational

```text
T009 (backfill tests) | T013 (guard tests) | T015 (document schema tests) | T017 (diff tests) | T020 (fixtures)
T024 (system repo) | T025 (eslint ban)
```

### User Story 1

```text
T026 | T027 | T028 | T029   # tests
T031 | T037 | T038 | T039 | T041
```

### User Story 2

```text
T043 | T044 | T045 | T046 | T047 | T048   # tests
T058 | T059 | T060 | T062
```

### User Story 3

```text
T064 | T065 | T066   # tests
T069 | T070 | T071 | T072 | T073
```

---

## Implementation Strategy

### MVP (US1 + US2)

1. Phase 1 and Phase 2
2. Phase 3 (US1): admin sets the default prompt
3. Phase 4 (US2): documents generated from it
4. Stop and validate with the quickstart scenarios for US1/US2; the MVP needs both P1 stories, since a prompt without a document has no visible effect

### Incremental delivery

1. MVP (US1 + US2)
2. US3: own prompts
3. US4: default-change notifications
4. US5: legacy checks (most behaviour already arrives with US2's `decryptVersionBody`)
5. Polish: isolation, e2e, gates
