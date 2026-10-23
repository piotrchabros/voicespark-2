# Contract: Background Jobs (BullMQ) - delta against 001

This file is a delta against `specs/001-personal-brand-voice/contracts/jobs.md`. Everything not listed here is unchanged: the prefix, the queues, default options, the other behaviours, the cross-cutting rules and the logging rule (job id, counts and error codes only, never content or prompt text).

## Table changes

| Queue | Job name | Payload | Job id / dedup | Attempts and backoff | Concurrency | Behavior |
|---|---|---|---|---|---|---|
| profile | `profile.generate` | `{userId, generationId}` (unchanged) | `profile-{generationId}` | 3, exponential from 20 s | `WORKER_CONCURRENCY_LLM` | (4) rewritten |
| profile | `analysis.preview` (new) | `{definitionVersionId, adminId}` | `preview-{uuid}` | 1 | `WORKER_CONCURRENCY_LLM` | (10) |
| draft | `draft.generate` | `{userId, draftId}` (unchanged) | `draft-{draftId}` | 2, fixed 5 s | `WORKER_CONCURRENCY_LLM` | (5) changed |
| deletion | `deletion.execute` | unchanged | unchanged | unchanged | — | (6) extended |

- No new queue. `analysis.preview` shares the `profile` queue. Its payload has ids only.
- Add `analysis.preview` to the job constants and zod payload schemas in `@voicespark/core/src/queues`.

## Behaviors

### (4) `profile.generate` (rewritten for documents)

1. Re-check eligibility and definition status, otherwise mark `blocked`. (Unchanged.)
2. Load authored samples (`A{n}`) and up to 20 received context items. (Unchanged.)
3. Re-inspect samples, received context and the previous version used as `previousDocumentJson` with the current preferences. A legacy structured latest is converted by `structuredToDocument` first. A wholly excluded previous version gives an empty string.
4. Resolve the analysis prompt from the pins on the generation row:
   - `own_prompt_version_id` set: decrypt the own prompt, `inspect()` it under the current preferences. Wholly excluded: set `failed` with `error_code = 'analysis_prompt_excluded'`, no LLM call, notify `generation_failed`. Redactions are used as the text.
   - Else: use `analysis_prompt` of the pinned `definition_version_id`.
5. For a `feedback` generation, inspect the decrypted feedback first. Wholly excluded: `failed` with `feedback_excluded`, no LLM call.
6. Build the `analysisPrompt` block, run `neutralizeTags` on all untrusted text, render the pinned wrapper prompt version, add `ANALYSIS_GUARD` and `ANALYSIS_GUARD_REMINDER` (contracts/analysis-prompt.md).
7. Call the model with `buildDocumentOutputSchema()`. The model, effort and max tokens come from the pinned wrapper version (new versions: `maxTokens 16000`, effort `medium`). A refusal gives `llm_refused`.
8. Run `postValidateDocument`. On any problem, retry once with the problem codes in the user turn (`MAX_LLM_CALLS = 2`). If the second output still has problems: `failed` with `invalid_output`, notify `generation_failed`, no version stored, the previous version stays current (FR-021).
9. Inspect the output (joined once, per field on a hit). Wholly excluded summary or required part: `failed` with `output_excluded`.
- Fail-closed (Principle VI): if `inspect()` of the own prompt (step 4), the feedback (step 5) or the output (step 9) cannot complete, nothing is stored and no LLM call is made for a failed input inspection. The job throws a retryable error; after the last attempt the generation is `failed` with `inspection_failed`.
10. Map `sampleRef` to `contentItemId`. Store `profile_version` with `format = 'document'`, `prompt_source`, `own_prompt_version_id`, `definition_version_id` and `prompt_version_id`. Encrypt `body_enc`. Notify `profile_ready`.
- SLA: under 10 min (001 SC-006).
- Logs: generation id, counts, problem codes. No prompt text, no output.

### (5) `draft.generate` (format-aware)

- Decrypt the profile version with `decryptVersionBody`. The result is `{format:'structured', body}` or `{format:'document', body}`.
- `profileJson` for a document: `{format:'document', summary, sections:[{heading, markdown}], doList, dontList, excerpts:[{text}], languages}`. No `contentItemId`. For a structured profile it is exactly what 001 produced (SC-006: no regression).
- `profileSummary` and `languageHint` are derived from both formats.
- Optional variable `voiceDocument`: Markdown of the voice, for either format.
- Inspection, `brief_excluded`, `profile_excluded`, memory search, output inspection, SLA and failure handling are unchanged.
- The draft keeps pinning `profileVersionId` and `promptVersionId`.

### (6) `deletion.execute` (extended)

- When a scope removes content items (item, source with `deleteContent`, upload, account scopes except full account deletion), call `scrubDeletedExcerpts(tx, userId, itemIds)` in the same transaction as finalize:
  - for every version of the user's profiles, decrypt `body_enc`, drop excerpts whose `contentItemId` is deleted, re-encrypt with the active key;
  - covers `document` and legacy `structured` versions. A stored version may end up with fewer than 3 excerpts;
  - if the latest version changed: set `outdated_reason = 'sources_deleted'` and notify `profile_outdated`.
- `deleteSource` calls the same function.
- Idempotent: running again finds nothing to drop.
- Full account deletion removes `own_analysis_prompt`, `own_analysis_prompt_version` and all profile data by cascade. No scrub is needed.

### (10) `analysis.preview` (new)

- Payload `{definitionVersionId, adminId}`. Job id `preview-{uuid}`. Attempts 1, so a failure is final.
- Loads `analysis_prompt` of the definition version. Rejects with `failed` if the version is missing or the admin is not an active admin.
- Uses built-in samples only: `packages/core/src/prompting/preview-samples.json`, about 8 synthetic authored samples and 3 received items, all marked `SAMPLE TEXT`. No real user content is read. No Supermemory call. No `inspect()` of user data is needed.
- Runs the same pipeline as `profile.generate` steps 6 to 8: neutralise, wrap, guard, active wrapper version, model call, `postValidateDocument` with the single retry.
- Writes nothing to the database. No `profile_version`, no notification, no audit entry beyond the request route.
- Result in the job return value:
  ```json
  {"status": "done|failed", "markdown": "string|null", "problems": ["string"]}
  ```
  `markdown` is `documentToMarkdown` of the validated document. `problems` are post-validation codes.
- Read by `GET /api/admin/definitions/{id}/versions/{versionId}/preview-run/{jobId}`. The job is kept with the default 24 h `removeOnComplete`.
- Cost control: the web route is rate-limited with the existing limiter. The run uses the same model as production generation.

## Cross-cutting rules (additions)

- **Prompt pinning**: `definition_version_id`, `prompt_version_id` and `own_prompt_version_id` are stored on `profile_generation` when it is created. A job that starts after a publish still uses the pinned values (FR-019). The own prompt row is locked in that transaction.
- **Own prompt retention**: deleting a generation or a version never deletes own prompt versions. `own_prompt_version_id` on `profile_version` is `ON DELETE SET NULL`.
- **Migration**: `migrate.ts` runs the SQL migration `0007_analysis_prompts.sql`, then `backfillAnalysisPrompts(db)`, which fills `analysis_prompt` for all definition versions and inserts v2 of `tone_profile.generate` and `tone_profile.feedback` when the active version lacks `{{analysisPrompt}}`. It is idempotent.
