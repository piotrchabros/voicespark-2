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
  `maintenance.credential-audit` (04:00 Sundays).

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

## Pilot measurements

Local runs verify mechanisms only; these targets need real usage in a beta cohort.

- SC-007 (80% of tone profile ratings `sounds_like_me`) and SC-013 (70% of draft ratings): as an admin,
  `GET /api/admin/metrics/ratings?from=<date>&to=<date>`. The response is aggregates (`rated`, `soundsLikeMe`, `share`)
  with no content or per-user rows. Take the share over the pilot window.
- SC-012 (draft ready within 60 s): the automated test uses a fake LLM and only guards the pipeline. In the pilot, measure real
  model latency from draft creation to `ready` in the database and record p50/p95.
- SC-009 (deletion within 24 h): the share of `deletion_request` rows completed before `due_by`, plus the
  `deletion.sla_flagged` audit history.
