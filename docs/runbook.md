# Operations runbook

Commands assume the Compose deployment from the README. For a non-Compose install, run the same `pnpm` commands from
the repository root with the production environment loaded.

## Deploy and configuration

- `docker compose up -d --build` starts postgres, redis, the one-shot `migrate` service, `web` (port 3000) and `worker`.
  Add `--profile proxy` for Caddy (`docker/Caddyfile.example`; set `APP_DOMAIN` and `APP_URL`).
- Production (`NODE_ENV=production`) requires `SUPERMEMORY_API_KEY`, `ANTHROPIC_API_KEY`, `SMTP_URL` and `MAIL_FROM`
  (the `.env.example` placeholder sender is refused), and the process refuses to start if `AUTH_TEST_MODE`,
  `TEST_MEMORY_STORE_URL` or `TEST_IMAP_INSECURE_TLS` is set. Both `worker` and `web` check at start (web through
  `apps/web/instrumentation.ts`). A start failure with "Unsafe production configuration" names the offending variables.
- `SUPERMEMORY_API_VERSION` selects the Supermemory adapter: `v3` (default, the self-hosted server at
  `SUPERMEMORY_BASE_URL`, default `https://supermemory.voicespark.ai`) or `v5` (the hosted API). `v5` is refused with the
  self-hosted URL.
- `ENCRYPTION_ACTIVE_KEY_ID` must exist in `ENCRYPTION_KEYRING` (each key is base64 of 32 bytes).
- Migrations run on every `docker compose up` through `migrate`. Seed once: `docker compose run --rm migrate pnpm db:seed`.
- The worker registers its own schedulers at start: `maintenance.tmp-sweep` (hourly), `maintenance.deletion-sla` (every
  15 min), `maintenance.stale-imports` (every 10 min), `maintenance.retroscan-expiry` (03:00 daily),
  `maintenance.credential-audit` (04:00 Sundays), and for the Context Hub `maintenance.hub-sync-sweep` and
  `maintenance.hub-thread-sweep` (every minute), `maintenance.hub-refilter-retry` (04:00 daily) and
  `maintenance.hub-blob-sweep` (05:00 daily).
- `HUB_FILES_DIR` (default `/data/hub-files`) must be a persistent volume mounted in both `web` and `worker`. See
  [Context Hub](#context-hub).
- `SYNC_POLL_INTERVAL_MINUTES` (default 5) must be at most 10; a higher value is refused at start. See
  [Context Hub](#context-hub).

## Overdue deletions (SC-009, 24 h)

Detect:

- `/admin` system health shows the overdue-deletions count: requests not completed that are overdue or due within 2 h.
- The deletion SLA job writes one `deletion.sla_flagged` audit entry per run when anything is flagged, with counts
  `{flagged, overdue, requeued}` (ids and counts only, no content). Search the audit log for it, or alert on its presence.

Behaviour:

- A `failed` request is reset to `pending` and enqueued again under a fresh job id (`deletion-{id}-r{attempts}`), so it
  retries automatically every 15 minutes. `last_error_code` is kept for the admin view.
- Inside a job, retries back off 60 s doubling up to 2 h.

If requests stay overdue, there is no CLI command for deletions; investigate directly:

1. Worker running? `docker compose ps worker`, `docker compose logs --tail=200 worker` (logs hold ids and error codes only).
2. Failed jobs on the `deletion` queue (health view). Typical causes: Supermemory unreachable or returning 401 (below),
   Redis down.
3. Inspect the rows:
   `docker compose exec postgres psql -U voicespark voicespark -c "select id, scope, status, attempts, last_error_code, due_by from deletion_request where status <> 'completed' order by due_by;"`
4. Fix the cause. The next SLA run (within 15 min) re-enqueues `failed` rows. A row left in another state with no
   active job is not picked up by the SLA job; set it to `failed` with an `update` and the next run re-enqueues it.

## Credential-audit hits

The weekly `maintenance.credential-audit` job samples up to 200 stored documents per active user namespace and re-runs
the locked-category detectors (passwords, one-time codes, reset links, API keys and tokens). It never logs or stores
document content.

- A hit creates a system `content_item` deletion request for the item (the parent for attachments) and writes a
  `filter.audit_hit` audit entry per user per category with `{category, count}`.
- Any hit means the ingestion filter missed a locked category (SC-005 target is zero). Treat each as a filter bug: take
  the category from the audit entry, reproduce with a synthetic sample, add it to the corpus, fix the detector, and
  confirm `pnpm test:corpus` stays at 100% for locked categories.
- Confirm the generated deletion requests complete (see overdue deletions).

## Failed queues

`/admin` system health shows waiting, active, failed and delayed counts per queue. Failed jobs stay in Redis. Check
`docker compose logs worker` for the error code, fix the cause, then re-trigger the work through the product (resume the
import, regenerate the profile). Deletion jobs recover through the SLA job.

## Supermemory 401

A `MemoryStoreAuthError` in worker logs means the Supermemory key is rejected. Imports, sync, profile generation and
deletions all fail. Set a valid `SUPERMEMORY_API_KEY`, then `docker compose up -d web worker`. Failed deletions retry on the
SLA schedule; paused imports are resumed by users. Check overdue deletions afterwards.

With the self-hosted server (`v3`), the key is the one issued for that server, and the Caddy in front of it checks the
bearer token. A 401 can come from Caddy before the request reaches Supermemory. Check that the key and
`SUPERMEMORY_BASE_URL` belong to the same server.

## Supermemory busy

A `MemoryStoreBusyError` (`memory_store_busy`) means the server is still processing a document, which takes 30 to 60
seconds for small ones. The adapter waits a short time, then gives up so the job can retry. Jobs retry on their own, so
do nothing unless the same jobs keep failing. Then check the server: `systemctl status supermemory-voicespark`.

## SMTP failures

The account-deletion confirmation email is sent by the deletion job, which keeps the captured address until the send
succeeds and retries on failure. A failing `SMTP_URL` therefore shows up as a deletion job that does not finish; fix
`SMTP_URL`/`MAIL_FROM` and the job completes on retry. Other notifications are in-app.

## Backups and restore

- Back up Postgres: `docker compose exec -T postgres pg_dump -U voicespark -Fc voicespark > voicespark-$(date +%F).dump`.
- Restore into an empty database: `docker compose exec -T postgres pg_restore -U voicespark -d voicespark --clean --if-exists < file.dump`,
  then `docker compose up -d`.
- Redis holds queue state only (appendonly is on); losing it loses pending jobs, not data. Schedulers re-register at worker start.
- Supermemory content is derived. After restoring an older dump, users re-import from their sources.
- Back up `.env` (especially `ENCRYPTION_KEYRING`) separately and securely. Without the keyring, encrypted credentials
  and content fields in a restored database cannot be read.

## Encryption key rotation

1. Generate a key: `openssl rand -base64 32`.
2. Add it to `ENCRYPTION_KEYRING` as a new id (`{"k1":"...","k2":"..."}`), and set `ENCRYPTION_ACTIVE_KEY_ID=k2`.
3. Redeploy `web` and `worker` together: `docker compose up -d web worker`.
4. New writes use `k2`. Keep `k1` in the keyring: existing data stays encrypted under it and is decrypted by key id. This
   release has no bulk re-encryption command, so never remove an old key while data written with it exists.

`DEDUP_HMAC_KEY` is not part of the keyring; changing it breaks duplicate detection against already imported content.
It also breaks Context Hub search (the blind index holds keyed hashes) and the hub lookup hashes (record names, email
addresses, domains, ignore rules, block markers). This release has no reindex job, so do not change it.

The hub file blobs use the same keyring (purpose `hub-files`); each blob records its key id, so the rotation steps
above cover them. Keep old keys while blobs written with them exist.

## Tone-of-voice analysis prompt migration (0007)

Migration `0007_analysis_prompts.sql` adds the analysis prompt to tone definitions and the own-prompt tables. Right after
it, `pnpm db:migrate` runs a TypeScript backfill (`packages/db/src/data/analysis-prompts.ts`) in one transaction. It is
idempotent: a second run changes nothing.

- The backfill fills `analysis_prompt` for every `tone_definition_version`, active, superseded and draft, built from the
  existing dimensions.
- It activates v2 of the `tone_profile.generate` and `tone_profile.feedback` wrapper templates (effort `medium`,
  `maxTokens` 16000) when the active version lacks `{{analysisPrompt}}`. Each activation is recorded as a `publish`
  version activation.
- This changes generation behaviour at deploy. The next profile generation or feedback run uses the v2 templates, with no
  extra step. Plan the deploy with that in mind.
- Rolling those templates back to the dimension-based v1 is blocked on purpose. Template validation rejects v1 with
  `unknown_template_variable`, because the variable whitelist no longer includes the dimension variables.
- Existing structured profiles are not rewritten. They stay readable and usable for drafting.

Migrations run through the `migrate` service on `docker compose up`, so the same backfill runs there.

## Context Hub

### Hub file volume (`HUB_FILES_DIR`)

- Original hub files are stored encrypted at `{HUB_FILES_DIR}/{userId}/{storageKey}.bin` (default `/data/hub-files`).
  Compose mounts the `hub_files` volume at that path in both `web` (writes uploads, serves downloads) and `worker`
  (text extraction, account deletion). Both must see the same directory.
- Without a persistent volume, a container rebuild loses the original files. The rows, the extracted text (in
  `hub_file.extracted_text_enc`), search and the memory-store copies stay. A download of a lost file fails with an
  internal error (`blob_missing` in the code), and a file still waiting for extraction fails in `hub.file-extract`.
  Users must upload the file again.
- Back up the volume together with Postgres. A restored database with no blobs has the same effect as a lost volume.
  Blobs need `ENCRYPTION_KEYRING` to be read.
- Account deletion removes `{HUB_FILES_DIR}/{userId}` and checks that it is gone; a failure retries like other
  deletion steps (see overdue deletions).

### Blob sweep

`maintenance.hub-blob-sweep` (05:00 daily) deletes blobs older than 1 h that have no `hub_file` row: uploads whose
database write failed and deletes whose blob removal failed. It never touches rows or blobs that have a row, and it
skips directories whose names are not user ids. Nothing to do unless the volume keeps growing; then check that the
worker runs and that the worker and web mount the same volume.

### Mail-to-hub latency (`SYNC_POLL_INTERVAL_MINUTES`)

- Spec 003 SC-009 (a new email reaches the hub and the memory store within 15 min) needs the poll interval plus the
  60 s debounce plus queue time to stay under 15 min. The environment loader refuses `SYNC_POLL_INTERVAL_MINUTES`
  above 10 at start.
- Each source's poll scheduler is registered with the interval when the source is connected or reconnected
  (`packages/core/src/services/sources.ts`). Changing the variable does not change existing schedulers; they keep the
  old interval until the source is reconnected.
- Due threads and sync items that lost their job are picked up within a minute by `maintenance.hub-thread-sweep` and
  `maintenance.hub-sync-sweep`.

### Daily thread cap and backfill cost

- Turning the hub on for a mailbox starts `hub.backfill`, which feeds every already imported email of that mailbox to
  the hub, newest first, 100 messages per page. Each thread costs up to one extraction call (`LLM_HUB_EXTRACTION_MODEL`,
  default the profile model, effort `LLM_HUB_EXTRACTION_EFFORT`, at most 16,000 output tokens) plus one retry on an
  invalid answer, and for some threads one triage call on `LLM_CLASSIFIER_MODEL`. A large mailbox therefore costs many
  calls.
- The admin setting `hub.daily_thread_cap_per_user` (default 500) limits threads with an extraction call per user per
  24 h. Over the cap, threads wait until the next UTC midnight; the mailbox status shows the pause. Change it as an
  admin with `PUT /api/admin/settings` `{"key": "hub.daily_thread_cap_per_user", "value": <n>}` (audit
  `settings.changed`).
- Watch cost on `/admin` system health: `llmCallsToday`, `inputTokensToday`, `outputTokensToday`, `threadsPending`
  and `threadsFailed`. The token figures come from `hub_llm_call` and are estimates from character counts, not
  provider usage. Use the provider console for billing.

### Before changing the extraction prompt, schema or model

The extraction prompt (`HUB_EXTRACTION_PROMPT_V1` with `HUB_EXTRACTION_PROMPT_VERSION`,
`packages/core/src/hub/prompts.ts`) is a code constant, not an admin setting. A prompt change means a new constant and
a new version. Before changing the prompt, the output schema (`packages/core/src/hub/extraction-schema.ts`),
`LLM_HUB_EXTRACTION_MODEL` or `LLM_HUB_EXTRACTION_EFFORT`, run the live eval: `HUB_EVAL_LIVE=1 pnpm hub:eval --model
<model>` with `ANTHROPIC_API_KEY` set. Compare the held-out line against SC-004 to SC-006. The eval writes only to the
test database and an in-memory store, never to production. Note: the runner (`apps/worker/eval/hub/run.ts`) is not in
the tree yet; until it is, there is no gate for these changes.

### Scanners and `hub_` documents

Hub documents share the user's memory namespace and have ids starting with `hub_` (`hub_person_<id>`,
`hub_note_<id>`, ...).

- Retroscan skips `hub_` ids; a filter change re-inspects hub items through `hub.refilter` instead.
- The weekly credential audit samples hub documents separately. A hit on a hub document is never purged directly: it
  marks the sync item `refilter_pending` and enqueues `hub.refilter`, which rebuilds the document from Postgres under
  the current policy. `maintenance.hub-refilter-retry` (04:00 daily) re-enqueues users whose items stay
  `refilter_pending`. Treat a hit as a filter bug, as in [Credential-audit hits](#credential-audit-hits).
- Any new scanner or script that walks a namespace must tolerate `hub_` documents.
- Draft memory search can return hub documents. They are filtered text, so this is accepted.

### Hub sync failures

`/admin` system health shows `syncFailed`. Users see per-item sync status on the hub settings screen and can retry
failed items or run a full re-sync (`POST /api/hub/sync/retry`, `POST /api/hub/sync/resync`). Content stays in
Postgres while the store is down; items are written again once it is back. For a Supermemory 401 or busy error, see
the sections above. Rows of deleted items stay in `hub_sync_item` as tombstones (ids only) after the store delete is
confirmed.

## Pilot measurements

Local runs verify mechanisms only; these targets need real usage in a beta cohort.

- SC-007 (80% of tone profile ratings `sounds_like_me`) and SC-013 (70% of draft ratings): as an admin,
  `GET /api/admin/metrics/ratings?from=<date>&to=<date>`. The response is aggregates (`rated`, `soundsLikeMe`, `share`)
  with no content or per-user rows. Take the share over the pilot window.
- SC-012 (draft ready within 60 s): the automated test uses a fake LLM and only guards the pipeline. In the pilot, measure real
  model latency from draft creation to `ready` in the database and record p50/p95.
- SC-009 (deletion within 24 h): the share of `deletion_request` rows completed before `due_by`, plus the
  `deletion.sla_flagged` audit history.
