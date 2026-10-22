# Contract: Background Jobs (BullMQ)

- Shared definitions live in `@voicespark/core/src/queues`: queue name constants plus zod payload schemas. Payloads carry ids only and never content.
- BullMQ prefix is `vs`. Queues: `import`, `sync-poll`, `upload`, `profile`, `draft`, `deletion`, `retroscan`, `notify`, `maintenance`. Custom job ids use `-` separators and never contain `:`.
- Default options: `removeOnComplete: {age: 86400}`, `removeOnFail: {age: 604800}`.

| Queue | Job name | Payload | Job id / dedup | Attempts and backoff | Concurrency | Behavior |
|---|---|---|---|---|---|---|
| import | `import.page` | `{userId, sourceId, importJobId}` | `import-{sourceId}` (one in flight) | 5, exponential from 30 s | `WORKER_CONCURRENCY_IMPORT` | (1) |
| sync-poll | `sync.poll` | `{userId, sourceId}` | scheduler `poll-{sourceId}`, every `SYNC_POLL_INTERVAL_MINUTES` | 1 | — | (2) |
| upload | `upload.process` | `{userId, uploadId, importJobId}` | `upload-{uploadId}` | 3 | — | (3) |
| profile | `profile.generate` | `{userId, generationId}` | `profile-{generationId}` | 3, exponential from 20 s | `WORKER_CONCURRENCY_LLM` | (4) |
| draft | `draft.generate` | `{userId, draftId}` | `draft-{draftId}` | 2, fixed 5 s | `WORKER_CONCURRENCY_LLM` | (5) |
| deletion | `deletion.execute` | `{deletionRequestId}` | `deletion-{deletionRequestId}` | 12, exponential from 60 s, capped at 2 h | — | (6) |
| retroscan | `retroscan.scan` | `{retroscanId}` | `retroscan-{retroscanId}` | 3 | — | (7) |
| notify | `notify.send` | `{notificationId}` | — | 5 | — | (8) |
| maintenance | (9) | `{}` | scheduler ids as named | 1 | — | (9) |

## Behaviors

1. **`import.page`**
   - Abort if the source isn't `connected`, the user isn't `active`, or the job isn't `queued|running`.
   - Load the cursor or checkpoint, fetch up to 100 refs, and process each item: skip if an occurrence exists; fetch raw; parse; compute hashes; if a duplicate, add an occurrence; otherwise `inspect()`, insert `content_item(pending_write)`, batch write to Supermemory, mark `active`.
   - Update counters, `exclusion_record` and `skip_record`. Persist the checkpoint.
   - Enqueue the next page or complete the job: completion sets `initial_complete` and the cursor, sends a notification on the first completion, recomputes `profile.outdated_reason`, and calls `autoGenerateIfFirstEligible` (FR-069).
   - Auth errors throw `UnrecoverableError`, set the source to `needs_reconnection` and the job to `paused` (reason `auth`), and notify.
   - 429 or Retry-After uses `moveToDelayed`.
2. **`sync.poll`**: if no non-terminal job exists and the date range is open, create an `incremental` import job (or a `resync` one if the cursor has expired) and enqueue `import.page`.
3. **`upload.process`**: decrypt the staged file, extract text, run `inspect()`, write, delete the staged file, and set upload `stored`, `rejected` (`sensitive_content` when inspection excludes the whole item) or `failed`; after storing an item, call `autoGenerateIfFirstEligible` (FR-069).
4. **`profile.generate`**:
   - Re-check eligibility and definition status, otherwise mark `blocked`.
   - Load authored samples from Supermemory (list filter `vs_authorship eq authored`, newest first, up to about 150k tokens) and up to 20 received context items.
   - Re-inspect samples and the previous profile version used as `previousProfileJson` with the current preferences; `previousProfileJson` is empty if that version is wholly excluded. For a `feedback` generation, also inspect the decrypted feedback text; if the whole feedback is excluded, set `failed` with `error_code = 'feedback_excluded'` and make no LLM call.
   - Render the pinned prompt version and call Sonnet with the structured schema.
   - Validate dimensions against the definition version and verify excerpts verbatim, retrying once if fewer than 3 are valid.
   - Store `profile_version` and notify.
   - SLA: under 10 min (SC-006).
5. **`draft.generate`**: inspect the brief, the profile (`profileJson`, `profileSummary`), the feedback and the previous draft (an excluded feedback or previous draft is omitted from the prompt; if the whole brief is excluded, set `failed` with `error_code = 'brief_excluded'`, and if the whole profile is excluded, set `failed` with `error_code = 'profile_excluded'`, in both cases making no LLM call and notifying `draft_failed`); Supermemory search with `limit = draft.memory_context_limit`; inspect the snippets; render the pinned prompt; call Sonnet; inspect the output and redact any hit; save as `ready`. SLA p95 under 60 s (SC-012). On final failure, set `failed` and notify.
6. **`deletion.execute`**: per scope (R19). Idempotent: deleting already-deleted ids is a success. Verify with list.
7. **`retroscan.scan`**: R20.
8. **`notify.send`**: send email if the type requires it.
9. **maintenance schedulers**: `maintenance.tmp-sweep` (hourly; deletes staged files older than 24 h), `maintenance.deletion-sla` (every 15 min), `maintenance.stale-imports` (every 10 min), `maintenance.retroscan-expiry` (daily), `maintenance.credential-audit` (weekly, `{}` payload; samples up to 200 documents per active namespace and runs only the four locked detectors, purging hits; SC-005).

## Cross-cutting rules

- **Pause and resume semantics (SC-011)**: pause sets the source and job to `paused`; the in-flight page finishes and checkpoints. Resume sets both to `connected`/`running` and enqueues `import.page`.
- **Disconnect and delete**: the in-flight page re-checks source and job status before writing to Supermemory; source deletion waits until no import job is running.
- **Suspension**: pause all of the user's sources (reason `suspended`) and remove their schedulers.
- **Version pinning**: pinned ids are stored on the row at enqueue time.
- **Logging rule**: log job id, counts and error codes only.
