# VoiceSpark

VoiceSpark builds a personal brand voice profile from a user's own writing. Users connect mailboxes (Gmail, Microsoft,
IMAP) or upload documents; a sensitive-content pipeline filters everything before it reaches the memory store
(Supermemory) or an LLM (Anthropic); tone profiles are generated from the stored content and used to draft social posts,
bios and short articles. Admins manage prompts and tone definitions but never see user content.

Spec, plan, contracts and tasks: `specs/001-personal-brand-voice/`. Project rules: `.specify/memory/constitution.md`.

Monorepo (pnpm workspaces): `apps/web` (Next.js), `apps/worker` (BullMQ workers and schedulers), `packages/core`
(services, env, CLI), `packages/db` (Drizzle schema, migrations, seed), `packages/filters` (sensitive-content pipeline),
`packages/integrations` (mailboxes, Supermemory, Anthropic).

## Prerequisites

- Node 24 (`.node-version`), pnpm 10 (`corepack enable`), Docker 27+ with Compose v2.
- For real sign-in and mailbox access: a public HTTPS domain and provider registrations (Google, Apple, Microsoft,
  Facebook), plus Supermemory and Anthropic API keys and an SMTP account. See
  `specs/001-personal-brand-voice/quickstart.md` section 1.

## Setup

```bash
cp .env.example .env
openssl rand -base64 32   # BETTER_AUTH_SECRET, DEDUP_HMAC_KEY and each ENCRYPTION_KEYRING key
```

Environment variables are documented in `.env.example` and in quickstart section 2. Required at startup:
`BETTER_AUTH_SECRET` (min 32 chars), `ENCRYPTION_KEYRING`, `ENCRYPTION_ACTIVE_KEY_ID`, `DEDUP_HMAC_KEY`. With
`NODE_ENV=production` the process also refuses to start unless `SUPERMEMORY_API_KEY`, `ANTHROPIC_API_KEY`, `SMTP_URL` and
`MAIL_FROM` are set, or
if `AUTH_TEST_MODE`, `TEST_MEMORY_STORE_URL` or `TEST_IMAP_INSECURE_TLS` is set.

### Production-like (Docker Compose)

```bash
docker compose up -d --build        # postgres, redis, migrate (one-shot), web :3000, worker
docker compose --profile proxy up -d   # optional: Caddy with automatic HTTPS (set APP_DOMAIN and APP_URL in .env)
```

`migrate` runs `pnpm db:migrate` before `web` and `worker` start. Seed the default tone definition, system prompts and
settings once on a new database:

```bash
docker compose run --rm migrate pnpm db:seed
```

### Development

```bash
docker compose up -d postgres redis
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev        # web and worker in parallel
```

### First admin

Sign in once with any provider, then:

```bash
docker compose exec web pnpm cli admin:grant --email you@example.com
# development: pnpm cli admin:grant --email you@example.com
```

No environment variable grants admin.

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Web and worker in watch mode |
| `pnpm build` | Build all packages |
| `pnpm lint` | ESLint (includes the admin import bans) |
| `pnpm typecheck` | Types across the workspace |
| `pnpm test` | Unit tests |
| `pnpm test:corpus` | Filter corpus gates: 100% locked-category recall, 99% overall (SC-004 / SC-005) |
| `pnpm test:integration` | Integration tests; need the test containers (below) |
| `pnpm test:admin-isolation` | Admin content-isolation suite (SC-010) |
| `pnpm test:e2e` | Playwright end-to-end; see `apps/web/e2e/README.md` |
| `pnpm test:import-load` | Import throughput and dedup (SC-003 / SC-011); up to an hour |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / seed definitions, prompts and settings |
| `pnpm cli admin:grant --email <email>` | Grant the admin role |

### Test containers

```bash
docker compose -f docker-compose.test.yml up -d
```

Starts GreenMail (SMTP 3025, IMAP 3143, IMAPS 3993), Postgres 17 on `localhost:55432` (database `voicespark_test`) and
Redis 7.4 on `localhost:56379`. The e2e run uses its own database `voicespark_e2e` on the same server and serves the web
app on `http://localhost:3110`.

## CI

`.github/workflows/ci.yml`: on every push and pull request, `checks` (lint, typecheck, unit, corpus) and `integration`
(integration plus admin-isolation against Postgres, Redis and GreenMail service containers). `e2e` runs nightly (02:00
UTC) and on manual dispatch; `import-load` runs on manual dispatch only.

## Operations

Day-to-day procedures are in [docs/runbook.md](docs/runbook.md): overdue deletions, credential-audit hits, failed
queues, backups and restore, encryption key rotation, SMTP and Supermemory failures, pilot measurements.

In short:

- Backups: `pg_dump` the Postgres database. Supermemory content is derived and can be re-imported from sources.
- Key rotation: add a key to `ENCRYPTION_KEYRING`, point `ENCRYPTION_ACTIVE_KEY_ID` at it, keep old keys.
- Monitoring: `/admin` system health shows queue counts and overdue deletions (SC-009).

## Further documents

- [docs/runbook.md](docs/runbook.md)
- [docs/security-review.md](docs/security-review.md)
- [docs/provider-verification.md](docs/provider-verification.md)
- [docs/quickstart-validation.md](docs/quickstart-validation.md)
- `specs/001-personal-brand-voice/quickstart.md`, `contracts/`, `data-model.md`
