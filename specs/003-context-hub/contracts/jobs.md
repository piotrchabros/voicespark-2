# Contract: Background Jobs (BullMQ) - delta against 001 and 002

This file is a delta against `specs/001-personal-brand-voice/contracts/jobs.md` and `specs/002-voice-analysis-prompt/contracts/jobs.md`. Everything not listed here is unchanged: the prefix `vs`, the existing queues, default options (`removeOnComplete {age: 86400}`, `removeOnFail {age: 604800}`), the cross-cutting rules and the logging rule (job id, counts and error codes only, never content).

## Table changes

One new queue name, `hub`. No new queue technology. Payloads carry ids only. Job ids use `-` separators and never `:`.

| Queue | Job name | Payload | Job id / dedup | Attempts and backoff | Concurrency | Behavior |
|---|---|---|---|---|---|---|
| hub | `hub.thread` (new) | `{userId, threadId, version}` | `hubthread-{threadId}-{version}`, delay 60 s | 1 (the row owns retries) | 4 | (11) |
| hub | `hub.backfill` (new) | `{userId, sourceId}` | `hubbackfill-{sourceId}` | 5, exponential from 30 s | 1 | (12) |
| hub | `hub.sync` (new) | `{userId}` | `hubsync-{userId}`, delay 2 s | 1 (the rows own retries) | 4 | (13) |
| hub | `hub.file-extract` (new) | `{userId, fileId}` | `hubfile-{fileId}` | 3, exponential from 10 s | 2 | (14) |
| hub | `hub.refilter` (new) | `{userId, policyVersion}` | `hubrefilter-{userId}-{policyVersion}` | 3, exponential from 30 s | 1 | (15) |
| maintenance | `maintenance.hub-thread-sweep` (new) | `{}` | scheduler, every minute | 1 | — | (16) |
| maintenance | `maintenance.hub-sync-sweep` (new) | `{}` | scheduler, every minute | 1 | — | (16) |
| maintenance | `maintenance.hub-blob-sweep` (new) | `{}` | scheduler, daily | 1 | — | (16) |
| import | `import.page` | unchanged | unchanged | unchanged | unchanged | (1) extended |
| draft | `draft.generate` | unchanged | unchanged | unchanged | unchanged | (5) extended |
| deletion | `deletion.execute` | unchanged | unchanged | unchanged | — | (6) extended |

- Add the names to `QUEUES`, `JOBS`, `JOB_QUEUE`, `PAYLOAD_SCHEMAS` (strict zod objects) and `JOB_OPTIONS` in `@voicespark/core/src/queues`, plus `jobIds.hubThread`, `hubBackfill`, `hubSync`, `hubFile`, `hubRefilter`.
- The `version` in a `hub.thread` payload is only a dedup key. The job always works from the row, so a duplicate or late job is harmless.
- The single `hub` Worker runs with concurrency 12 (the sum of the Concurrency column); an in-process per-job-name semaphore (`HUB_CONCURRENCY`) enforces 4/1/4/2/1. LLM calls inside `hub.thread` also respect `WORKER_CONCURRENCY_LLM` through a process-local limiter.
- `SYNC_POLL_INTERVAL_MINUTES` must stay at or below 10 to meet SC-009 (poll plus 60 s debounce plus queue latency at most 15 min).

## Behaviors

### (1) `import.page` (extended: ingest hook)

- `PageContext` gains `hub: {enabled: boolean}`, loaded once per page for the source from `hub_mailbox_setting`.
- After `processMessage` ends in `imported` or `duplicate` (never `excluded` or `failed`) and `hub.enabled` is true, it calls `hubIngest.recordMessage(ctx, ref, parsed)`:
  - computes the thread key (contracts/hub-extraction.md section 1);
  - upserts `hub_thread`, `hub_message` and `hub_message_source` (metadata only, hashes are per-user HMACs, no body);
  - increments `hub_thread.version` only when the `message_id_hash` is new;
  - sets `status = pending`, `next_attempt_at = now() + 60 s` and enqueues `hub.thread` with the job id and delay above.
- A mailbox with the hub off never reaches `recordMessage` (AS3.9). A failure in `recordMessage` is logged by code and does not fail the import page.
- Ignore rules are applied at thread processing, not at ingest.

### (11) `hub.thread`

Full pipeline in contracts/hub-extraction.md. Job-level rules:

1. Abort if the user is not `active` or the thread row is gone.
2. Claim: in one statement, select the row `WHERE status = 'pending' AND version > processed_version AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())`, set `locked_until = now() + 600 s`, and read `version`. No row: finish quietly.
3. Run fetch, classify, select participants, clean, inspect, optional triage, extract, inspect outputs. These steps hold no database lock.
4. Apply under `pg_advisory_xact_lock(hashtext('hub-apply:' || userId))` in one transaction. Idempotent: the `(thread_id, fingerprint)` unique key and owner-field checks make a re-run a no-op.
5. Complete: only if `locked_until` is still ours, set `processed_version = claimed version` and `status = CASE WHEN version = claimed THEN 'done' (or 'skipped') ELSE 'pending' END`, and clear the lease. When `version` grew meanwhile the row stays `pending` with `next_attempt_at = now()`, so the sweep (16) enqueues the next run and no version bumped during the run is lost.
6. On an error code that retries: store `last_error_code`, increment `attempts`, set `next_attempt_at` by `min(5 s * 2^(n-1), 15 min)` with plus or minus 20% jitter, clear the lease. At 8 attempts: `status = failed`. `llm_refused` is final at once. `fetch_unavailable` and `source_auth` retry in 15 min and leave `attempts` unchanged.
7. The daily cap `hub.daily_thread_cap_per_user` is checked at claim time against `hub_llm_call` rows of the last 24 h with purpose `extract`. Over the cap: release, `next_attempt_at` to the next UTC midnight, no attempt counted.
8. Every model call writes one `hub_llm_call` row (purpose, model, prompt version, token counts, stop reason). No content.
- Logs: thread id, version, counts, skip reason, error code. No subject, names, addresses or text.
- Fail-closed: if any `inspect*` call cannot complete, the message or field is not used. A thread with nothing left is skipped as `excluded`. A failure that cannot be classified retries as `inspection_failed`.
- `inspectForUser` (`packages/core/src/services/inspection.ts`) never throws. When inspection cannot complete it returns `{outcome: 'excluded', counts: [{category: 'inspection_failed'}]}`. The category `inspection_failed` is a retryable failure, not an exclusion: only real filter categories give `excluded`.

### (12) `hub.backfill`

- Runs after `enable`. Takes the per-source lock `imports.acquireSourceLock` so it does not run alongside `import.page`.
- Pages through `content_item_occurrence` of the source (status `active`, kind email, parents only), 100 at a time, ordered by item date descending (new mail first). For each page: `fetcher.fetchMessages(refs)`, parse, then `recordMessage`.
- Keeps `hub_mailbox_setting.backfill_cursor` after each page and `backfill_state = running`. At the end: `done`.
- If the source is `paused` or `needs_reconnection`, or the hub was disabled: reschedule in 15 min, or stop when disabled.
- Covers only mail VoiceSpark already imported (same date range and filters).
- Enqueued threads respect the daily cap (11, rule 7). The UI shows "paused until tomorrow".
- Idempotent: re-running over the same refs only adds `hub_message_source` rows or finds the existing ones.

### (13) `hub.sync`

Outbox worker for the memory store (contracts/memory-store-hub.md).

- Claims due `hub_sync_item` rows with `WHERE user_id=$1 AND (status <> 'stored' OR synced_version < version) AND (next_attempt_at IS NULL OR next_attempt_at <= now()) AND (lease_until IS NULL OR lease_until < now()) ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED` (matches `hub_sync_item_due_idx`), and sets `lease_until = now() + 120 s`.
- Builds each document from current state, writes or deletes, then sets `synced_version = V` and `status = stored` only if `version` is still `V`.
- Backoff `min(5 s * 2^(n-1), 15 min)` plus or minus 20%, no maximum attempts. `MemoryStoreBusyError` retries in 10 s without counting an attempt.
- Re-enqueues itself with delay 2 s while due rows remain.

### (14) `hub.file-extract`

- Loads the file row, decrypts the blob (`hub-files` key purpose), extracts text with a 30 s timeout, then inspects it under the user's full policy (kind `file`).
- Result: `extracted`, `empty`, `unsupported` (reason `no_text_extraction_for_type` or `image_not_searchable`), `failed` (reason `timeout` or `corrupt`), `excluded` (whole-item exclusion; reason is the category key; text discarded; audit `hub.file_excluded`).
- Stores extracted text encrypted (at most 1,000,000 chars). In the same transaction updates `hub_search_doc` (first 90,000 chars) and marks the file's sync item dirty.
- Inspection failure is fail-closed: `inspectForUser` returns category `inspection_failed`, which is a retryable failure, not an exclusion. Retry per the job attempts, then `extraction_status = 'failed'` with reason `inspection_failed`. Nothing is indexed or synced. Only real categories give `excluded`.
- Abort if the file row no longer exists (deleted while pending).

### (15) `hub.refilter`

- Enqueued when `filter_preferences.version` increases and the user has any hub data.
- Re-inspects stored summaries, note bodies, file extracted text and record free-text fields under the new policy, re-encrypts, re-indexes, and marks every sync item dirty. Contact fields in the memory documents follow the new policy at the next build.
- A note or file that becomes wholly excluded keeps the row with its content cleared and `extraction_status = excluded` for files. Notes are never deleted by the job; their body becomes a placeholder paragraph and `redacted_values` is updated.
- Idempotent: keyed by the policy version.
- Final failure (fail-closed, Principle VI): after the last attempt fails, the hub items it could not re-inspect have their memory-store documents deleted (sync status `pending`, `last_error_code = refilter_pending`), so nothing filtered under the old policy stays in the memory store. The items stay in the app and are excluded from search indexing updates until refiltered. The daily `maintenance.hub-refilter-retry` (registered in `SCHEDULERS` of `apps/worker/src/index.ts`) re-enqueues `hub.refilter` for users with `refilter_pending` items, and the user gets an in-app notification.

### (16) Maintenance jobs

- `maintenance.hub-thread-sweep` (every minute): enqueues `hub.thread` for threads with `status = 'pending'`, `version > processed_version` and `next_attempt_at <= now()` and no live lease (lost jobs, backoff due, debounce due). Expires leases (`locked_until < now()`).
- `maintenance.hub-sync-sweep` (every minute): enqueues `hub.sync` for every user with due `hub_sync_item` rows.
- `maintenance.hub-refilter-retry` (daily): enqueues `hub.refilter` for every user with `hub_sync_item` rows whose `last_error_code = 'refilter_pending'`.
- `maintenance.hub-blob-sweep` (daily): deletes blob files in `HUB_FILES_DIR` that have no `hub_file` row and are older than 1 h. It never touches rows.
- Extend the existing `maintenance.credential-audit` and `retroscan.scan` to skip ids that start with `hub_` (see contracts/memory-store-hub.md, "Existing scanners").

### (5) `draft.generate` (extended: record context)

- When `draft.hub_record_kind` is set, assemble the context in `core/services/hub/draft-context.ts` within an 8,000-char budget:
  - name, role or title, industry or status and dates;
  - up to 10 links ("CTO at Acme", projects with roles);
  - up to 5 most recent notes (title plus the first 1,500 chars of plain text);
  - up to 5 most recent conversation summaries (date, subject, summary).
- Every segment passes the draft `inspect` under the full policy. Contact values are included only as filtered text, so they drop under the default policy (AS6.4).
- After `render()`, code appends `<record_context kind="person|company|project">...</record_context>` with a fixed instruction to treat it as background data and not to quote private details. It is not a template variable. `neutralizeTags` runs on all of it.
- If the record is gone, the draft runs without context and sets `draft.hub_context_status = 'missing'`. It is not an error.
- Inspection failure of the context drops the context and sets `draft.hub_context_status = 'inspection_failed'`; the draft still runs. When the context is used, the column is set to `used`.
- Everything else (brief, profile, output inspection, SLA, failures) is unchanged.

### (6) `deletion.execute` (extended)

- New scope `hub_source` (enum `deletion_scope` gains the value). Target is the `sourceId`. SLA 24 h under the existing `maintenance.deletion-sla`. Retries: 12, capped exponential, as for other scopes.
- `hub_source` runs `hubPurge.purgeSource(userId, sourceId)`:
  1. Exclusive threads are those whose only `hub_thread_source` rows point at this source. Delete their summaries and thread rows (messages and thread records cascade). Mark facts whose only evidence threads were exclusive.
  2. For those facts: clear email-origin field values not in `owner_fields` unless another surviving applied fact supports them. Delete `origin = email` emails, domains and links with no surviving evidence and no `role_owner_set`.
  3. Delete records with `created_from = email`, empty `owner_fields`, no notes, no files, no user-origin links and no surviving applied facts.
  4. Delete the `hub_message_source` and `hub_thread_source` rows for the source.
  5. Tombstone the affected sync items and mark the rest dirty.
  6. Delete the memory documents synchronously in the job (not through the outbox) and verify with `getDocument == null` for each deleted id. A failure throws `verify_failed` and the job retries.
  7. Write the audit entry `hub.mailbox_data_deleted` with `{sourceId, threads, records, links, values}` (values = cleared fields plus deleted emails and domains).
  - Runs in transactions under the apply lock. User-entered data stays (AS8.2). Idempotent: running again finds nothing to delete.
- `deleteSource` (scope `source` with `deleteContent`) calls `purgeSource` first when `data_choice != keep`, before the `connected_source` row is deleted.
- Account deletion: before the user row is deleted, run `blobStore.deleteUser(userId)` (removes `{HUB_FILES_DIR}/{userId}`) and verify the directory is gone. Failure throws `verify_failed` (retryable). `deleteNamespace` already removes hub documents. Hub tables cascade from `user`. Pending `hub` jobs for the user are removed on a best-effort basis; every hub job re-checks that the user is active and the rows exist.
- `scrubDeletedExcerpts` is unchanged. Hub data holds no profile excerpts.

## Cross-cutting rules (additions)

- **Row-owned retries**: `hub_thread` and `hub_sync_item` carry `attempts`, `next_attempt_at` and a lease. BullMQ jobs only wake the row. Lost jobs are recovered by the sweeps (16).
- **No bodies**: job payloads, logs, `hub_llm_call`, audit metadata and `last_error_code` never hold message text, names, addresses or summaries (SC-008).
- **Suspension**: pause hub jobs for the user like other work. The jobs abort when the user is not `active`.
- **Source removal**: `hub_message_source.source_id` and `hub_thread_source.source_id` are `ON DELETE SET NULL`, so derived data survives after `keep`. A thread with no usable source cannot be refetched and is not updated further.
- **Migration**: `0008_context_hub.sql` creates the tables and enums, adds `hub_source` to `deletion_scope`, adds the four `draft` columns, and needs no data backfill.
