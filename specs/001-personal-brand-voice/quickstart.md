# Quickstart: Personal Brand Voice (001-personal-brand-voice)

Run and validation guide. Contracts live in [contracts/](./contracts/) (`http-api.md`, `jobs.md`, `filter-categories.md`, `prompt-template-variables.md`, `supermemory.md`); entities, enums and state transitions live in [data-model.md](./data-model.md). This guide does not repeat them; it points at them and states the expected outcome of each scenario.

## 1. Prerequisites

- Node 24 LTS, pnpm 10 (via corepack), Docker 27+ with Compose v2.
- A public HTTPS domain fronted by Caddy for OAuth callbacks (Apple requires HTTPS). A tunnel works for development. Example config: `docker/Caddyfile.example`.
- Provider registrations:
  - Google sign-in client.
  - Google mail client (scope `gmail.readonly`; add test users; note the CASA assessment requirement for production).
  - Apple Services ID and key.
  - Microsoft sign-in and mail registrations (common tenant).
  - Facebook app.
- Supermemory API key, Anthropic API key, an SMTP account.
- Redirect URIs to register:
  - `{APP_URL}/api/auth/callback/{google|apple|microsoft|facebook}`
  - `{APP_URL}/api/sources/connect/gmail/callback`
  - `{APP_URL}/api/sources/connect/microsoft/callback`

## 2. Configure

```bash
cp .env.example .env
openssl rand -base64 32   # use for BETTER_AUTH_SECRET, DEDUP_HMAC_KEY and each keyring key
```

| Variable | Purpose | Example / default |
|---|---|---|
| `NODE_ENV` | Runtime mode | `production` |
| `APP_URL` | Public base URL | `https://voice.example.com` |
| `LOG_LEVEL` | Log verbosity | `info` |
| `DATABASE_URL` | Postgres connection | `postgres://voicespark:...@postgres:5432/voicespark` |
| `REDIS_URL` | Redis for BullMQ and rate limits | `redis://redis:6379` |
| `BETTER_AUTH_SECRET` | Session/signing secret | base64 32 bytes |
| `BETTER_AUTH_URL` | Better Auth base URL | same as `APP_URL` |
| `GOOGLE_SIGNIN_CLIENT_ID` / `GOOGLE_SIGNIN_CLIENT_SECRET` | Google sign-in | from Google console |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Sign in with Apple | Services ID, team, key id, PEM |
| `MICROSOFT_SIGNIN_CLIENT_ID` / `MICROSOFT_SIGNIN_CLIENT_SECRET` | Microsoft sign-in | from Entra |
| `MICROSOFT_SIGNIN_TENANT_ID` | Sign-in tenant | `common` |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` | Facebook sign-in | from Meta console |
| `GOOGLE_MAIL_CLIENT_ID` / `GOOGLE_MAIL_CLIENT_SECRET` | Gmail mailbox access (separate from sign-in) | from Google console |
| `MICROSOFT_MAIL_CLIENT_ID` / `MICROSOFT_MAIL_CLIENT_SECRET` | Microsoft mailbox access | from Entra |
| `MICROSOFT_MAIL_TENANT_ID` | Mail tenant | `common` |
| `ENCRYPTION_KEYRING` | JSON keyring for credential encryption | `{"k1":"<base64 32 bytes>"}` |
| `ENCRYPTION_ACTIVE_KEY_ID` | Active keyring entry | `k1` |
| `DEDUP_HMAC_KEY` | Content-hash HMAC key | base64 32 bytes |
| `SUPERMEMORY_API_KEY` | Supermemory auth (required in production) | from Supermemory |
| `SUPERMEMORY_API_VERSION` | Supermemory API generation: `v3` (self-hosted) or `v5` (hosted) | `v3` |
| `SUPERMEMORY_BASE_URL` | Supermemory API | `https://supermemory.voicespark.ai` (use `https://api.supermemory.ai` with `v5`) |
| `ANTHROPIC_API_KEY` | Claude API auth (required in production) | from Anthropic |
| `LLM_PROFILE_MODEL` | Tone profile model | `claude-sonnet-5-5` |
| `LLM_DRAFT_MODEL` | Draft model | `claude-sonnet-5-5` |
| `LLM_CLASSIFIER_MODEL` | Filter classifier model | `claude-haiku-5-5` |
| `LLM_ALLOWED_MODELS` | Models admins may select | `claude-sonnet-5-5,claude-opus-5-5` |
| `SMTP_URL` | Outbound mail transport | `smtp://user:pass@smtp.example.com:587` |
| `MAIL_FROM` | Sender address | `VoiceSpark <noreply@example.com>` |
| `UPLOAD_TMP_DIR` | Transient upload dir | `/data/uploads-tmp` |
| `UPLOAD_MAX_BYTES` | Max upload size | `10485760` |
| `WORKER_CONCURRENCY_IMPORT` | Import job concurrency | `8` |
| `WORKER_CONCURRENCY_LLM` | LLM job concurrency | `4` |
| `SYNC_POLL_INTERVAL_MINUTES` | Incremental sync poll interval | `5` |

## 3. Run

Production-like (runs `migrate`, then `web` and `worker`):

```bash
docker compose up -d --build
```

Development:

```bash
docker compose up -d postgres redis
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev        # web and worker in parallel
```

Seed contents (see [data-model.md](./data-model.md) for the tables):

- Definition `general_voice` / "General voice", `available`, version 1 `active`, dimensions: `formality` (scale 1-5), `warmth` (scale 1-5), `sentence_length` (enum short|medium|long|varied), `vocabulary` (enum plain|professional|technical|rich), `humour` (enum none|light|frequent), `signature_phrases` (list).
- The five system prompts (`tone_profile.generate`, `tone_profile.feedback`, `draft.social_post`, `draft.bio`, `draft.short_article`), version 1 `active`.
- Default `app_setting` rows.

## 4. First admin

Sign in once with any provider, then:

```bash
docker compose exec web pnpm --filter @voicespark/core cli admin:grant --email you@example.com
```

Expected: the user's `user_role` becomes `admin`; `/admin` is reachable after the next request. No env var is involved.

## 5. Automated checks

| Command | Covers |
|---|---|
| `pnpm lint` | Lint including the admin import bans |
| `pnpm typecheck` | Types across all workspace packages |
| `pnpm test` | Unit tests |
| `pnpm test:corpus` | SC-004 / SC-005 filter gates against the seeded corpus |
| `pnpm test:integration` | Integration tests (Postgres, Redis, Supermemory/Anthropic stubs) |
| `docker compose -f docker-compose.test.yml up -d` then `pnpm test:import-load` | SC-003, SC-011, dedup |
| `pnpm test:e2e` | Playwright; run with `AUTH_TEST_MODE=1` |
| `pnpm test:admin-isolation` | SC-010 |

## 6. Validation scenarios

Request/response shapes and error codes are defined in [contracts/http-api.md](./contracts/http-api.md); job behaviour in [contracts/jobs.md](./contracts/jobs.md); filter categories in [contracts/filter-categories.md](./contracts/filter-categories.md); Supermemory usage in [contracts/supermemory.md](./contracts/supermemory.md).

| Story / SC | Steps | Expected |
|---|---|---|
| US1, SC-001 | Sign up with each of Google, Apple, Microsoft, Facebook; sign in again with the same provider. | Account created once per provider; repeat sign-in reuses it; total under 1 minute. |
| US1 | Sign in with a second provider that has the same email as an existing account. | Redirect to `/link-account?provider=...`; accounts link only after explicit confirmation. |
| US1 | Sign in with Apple using a private relay email. | No link offer. |
| US1 | Sign in with Google only. | No Gmail source exists afterwards; mailbox access needs its own consent. |
| US1 | Cancel at the provider consent screen. | Redirect to `/sign-in?error=oauth_cancelled` with the error message. |
| US1 | Sign in as a user with `user_status` `suspended`. | Refused (`account_suspended`). |
| US3, SC-014 | First connect of a source. | Checklist shown with the 4 locked categories and 10 selected; source endpoints return 409 `filter_confirmation_required` until confirmed. |
| US3 | Try to uncheck a locked category. | 422/`category_locked`. |
| US2, SC-002 | Connect Gmail, Microsoft and IMAP, each with a date range. | Import progress fields update as the job runs. |
| US2 | Pause then resume an import. | Resumes without duplicates (0 duplicate content items). |
| US2 | Revoke the OAuth token at the provider. | Source becomes `needs_reconnection` and a `source_needs_reconnection` notification appears. |
| US2 | Send a new email to the connected mailbox. | Imported within 5 minutes. |
| US2, SC-002 | Disconnect the source with "delete data". | Documents removed from the Supermemory namespace in under 2 minutes. |
| US3 seeded mailbox | Import the GreenMail corpus mailbox. | Exclusion summary counts match `expected.json`; a Supermemory list scan finds 0 seeded sensitive values (SC-004/005). |
| US3 | Create a keyword exclusion rule. | A retroscan offer appears; confirming purges matches. |
| US3 | Report an imported item as sensitive. | The item is purged. |
| US3 | Unselect `payment_cards`, then import more mail. | Card data is kept in later imports; earlier behaviour unchanged for locked categories. |
| US4 | Upload pdf, docx, txt and md files plus a note. | All reach `stored`. |
| US4 | Upload a scanned PDF and an encrypted PDF. | Rejected with `no_text` and `encrypted` respectively. |
| US4 | Upload a file containing an API key. | Excluded by the `api_keys_tokens` filter. |
| US4 | Delete an upload. | Its Supermemory document is removed. |
| US5, SC-006 | Try to generate below the eligibility threshold. | Blocked with `insufficient_content`. |
| US5, SC-006 | Generate with 2 available definitions. | 2 profiles, each with all dimensions, 3+ verbatim authored excerpts, languages, and recorded prompt/definition version ids; completes in under 10 minutes. |
| US5 | Regenerate, give feedback, adjust manually. | Each creates a new profile version. No received-mail quotes appear. Rating a profile version (`PUT /api/profiles/{id}/versions/{versionId}/rating` with `sounds_like_me` or `not_like_me`) is saved against that version. |
| US5, SC-007 | Rate a profile version `sounds_like_me` via `PUT /api/profiles/{id}/versions/{versionId}/rating`, then as an admin call `GET /api/admin/metrics/ratings?from&to`. | The profile `rated` and `soundsLikeMe` counts and `share` reflect the rating. The response holds aggregates only: no profile content and no per-user rows. The 80% target is measured over real usage in a beta/pilot cohort, not in a single local run; a local run only verifies the mechanism. |
| US6 | Request `/admin` as a non-admin. | 403 `admin_required`. |
| US6 | Edit a prompt as draft. | No effect on generation. |
| US6, SC-008 | Publish the prompt. | Applied to the next generation within 1 minute. |
| US6 | Roll back a prompt. | Recorded in version history. |
| US6 | Retire the last available definition. | Blocked (`last_available_definition`). |
| US6 | Make a second definition available. | Visible to users. |
| US6 | Self-demote the last admin. | Blocked (`last_admin`). |
| US6, SC-010 | Open an admin user detail page. | No user content shown. |
| US7, SC-009 | Delete a source, then the account. | Supermemory namespace empty, email notification sent; within 24 h (minutes locally). |
| US7 | After source deletion, open the profile. | "Profile may be outdated" prompt shown. |
| US8, SC-012 | Generate one draft of each type (social post, bio, short article). | Each is `ready` in under 60 s. |
| US8 | Edit, regenerate, give feedback. | History retained; ratings saved. |
| US8, SC-013 | Rate a draft `sounds_like_me` via `PUT /api/drafts/{id}/rating`, then as an admin call `GET /api/admin/metrics/ratings?from&to`. | The draft `rated` and `soundsLikeMe` counts and `share` reflect the rating. The response holds aggregates only: no draft content and no per-user rows. The 70% target is measured over real usage in a beta/pilot cohort, not in a single local run; a local run only verifies the mechanism. |
| US8 | Export a draft. | md and txt export work; no publish option exists. |
| US8 | Submit a brief that mentions excluded data. | The draft comes back redacted. |

## 7. Operations notes

- Backups: `pg_dump` the Postgres database; Supermemory content is derived and can be re-imported from sources.
- Key rotation: add a new entry to `ENCRYPTION_KEYRING` and set `ENCRYPTION_ACTIVE_KEY_ID` to it; keep old keys until data is re-encrypted.
- Monitoring: check `/admin` system health for overdue deletions (SC-009) and failed jobs (see [contracts/jobs.md](./contracts/jobs.md)).
