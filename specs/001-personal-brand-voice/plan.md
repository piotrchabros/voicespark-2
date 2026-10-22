# Implementation Plan: Personal Brand Voice

**Branch**: `001-personal-brand-voice` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-personal-brand-voice/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Users sign in with Google, Apple, Microsoft or Facebook through Better Auth; there are no passwords. They separately connect Gmail (`gmail.readonly`), Microsoft 365/Outlook (Graph `Mail.Read`) and IMAP mailboxes, upload files and notes, and import them into Supermemory. Every item first passes a fail-closed, test-first sensitive-content pipeline in `@voicespark/filters`: deterministic detectors with checksums, credential-delivery whole-message exclusion, and an optional Claude Haiku 5.5 second pass on text that has already had credentials redacted, used for health, special-category data and postal addresses. Claude Sonnet 5.5 builds one versioned tone-of-voice profile per chosen admin-defined definition, from authored content only, and drafts social posts, bios and short articles using admin-managed, versioned prompt templates. Admins manage definitions, prompts, users and settings in a role-gated `/admin` area and never see content. Deployment is one pnpm monorepo: a Next.js web app and a BullMQ worker on Postgres and Redis, run with docker-compose behind Caddy.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict) on Node.js 24 LTS; pnpm 10 workspaces

**Primary Dependencies**:
- Web and auth: Next.js 16 App Router (15.x acceptable); React 19; Better Auth 1.x with the Drizzle adapter
- Data and queue: Drizzle ORM and drizzle-kit; `pg`; BullMQ 5; ioredis; zod 4
- LLM and memory: `@anthropic-ai/sdk`; `supermemory`
- Mail and OAuth: `arctic` (mailbox OAuth with PKCE); `@googleapis/gmail`; fetch-based Microsoft Graph client; `imapflow`; `mailparser`; `email-reply-parser`; `html-to-text`
- Files: `unpdf`; `mammoth`; `file-type`
- Detection and language: `franc`; `libphonenumber-js`; `@secretlint/core` with `@secretlint/secretlint-rule-preset-recommend`
- Templating and output: `mustache`; `nodemailer`; `pino`
- UI: Tailwind CSS 4 with shadcn/ui

**Storage**:
- PostgreSQL 17 holds metadata, configuration, profiles and drafts, with column-level AES-256-GCM on content-class columns
- Redis 7.4 holds BullMQ queues and rate limiting
- Supermemory, an external SaaS, is the only store of filtered source content
- A transient encrypted upload staging directory on a Docker volume (`UPLOAD_TMP_DIR`) is deleted after processing or within 24 h

**Testing**:
- Vitest 3 workspace for unit and integration tests, using Testcontainers or compose Postgres/Redis and in-memory fakes for Supermemory and Anthropic
- Seeded sensitive-content corpus suite (`pnpm test:corpus`) for SC-004
- Playwright for e2e, using a mock OAuth provider in test mode
- GreenMail IMAP container for import load, pause/resume and dedup tests (SC-003, SC-011)

**Target Platform**: A Linux server (x86_64, recommended 4 vCPU / 8 GB) running Docker Engine 27+ with Compose v2, behind Caddy 2 for TLS. Users use evergreen desktop and mobile browsers.

**Project Type**: Web application (full-stack monorepo) plus a background worker

**Performance Goals**:
- A 10,000-email mailbox fully imported within 1 h; target at least 4 items/s sustained per mailbox and 3 mailboxes importing concurrently (SC-003)
- Draft ready in under 60 s at p95 (SC-012)
- First profile within 10 min of import completion (SC-006)
- A published definition or prompt applies to new generations in under 1 min, because the active pointer is read at job creation with no caching (SC-008)
- Source and account deletion complete in under 24 h (SC-009)
- Sign-up in under 1 min (SC-001); mailbox connect in under 2 min (SC-002)

**Constraints**:
- Excluded values and raw content are never logged or stored in Postgres (FR-020)
- Fail-closed inspection (FR-023)
- Least-privilege scopes; IMAP mailboxes are opened read-only
- Provider quotas: Gmail allows 15,000 quota units per user per minute and `messages.get` costs 5 units; Microsoft Graph allows 10,000 requests per 10 min and 4 concurrent requests per mailbox
- Gmail restricted-scope verification and the CASA security assessment are an external launch dependency
- Apple sign-in requires a public HTTPS domain, including in development (use a tunnel)
- Admins never read content (FR-045, FR-060)

**Scale/Scope**:
- v1 targets 1,000 users, up to 10 sources per user and up to 200k emails per mailbox
- About 30 screens: about 20 for users and about 10 for admins
- 8 user stories and 69 functional requirements

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against constitution v1.0.0 (`.specify/memory/constitution.md`, ratified 2026-10-19). Gates G1–G7 map one-to-one to Principles I–VII. Re-checked on 2026-10-19 after `/speckit-analyze`: feedback, previous-draft and document-header filtering added (C2, C3) and the Caddy proxy justified in Complexity Tracking (C4).

| Gate | Source | Pre-design | Post-design | Evidence |
|------|--------|------------|-------------|----------|
| G1 / I. Privacy by Design: sensitive filtering runs before every external write (Supermemory, and Anthropic for generation); the classifier receives only text that has already had credentials redacted; briefs, feedback, previous drafts, profiles (and manual profile adjustments), memory snippets and Supermemory document header fields (subject, sender, title, filename) are all inspected, and documents are assembled only by `buildDocument()` | FR-017, FR-023, FR-059 | PASS | PASS | research R8, R9; contracts/filter-categories.md; contracts/supermemory.md "Write path"; tasks T048, T119, T120, T152 |
| G2 / II. Least-Privilege Access: sign-in uses `openid email profile` only; Gmail uses `gmail.readonly`; Graph uses `Mail.Read offline_access User.Read`; IMAP uses `EXAMINE`/readOnly and `BODY.PEEK` | FR-005, FR-008 | PASS | PASS | research R4, R5, R6 |
| G3 / III. Admins Never See Content: content lives in Supermemory and encrypted columns; admin repositories select metadata only; lint import bans keep admin code away from content modules; SC-010 tests cover it | FR-045, FR-060, SC-010 | PASS | PASS | research R13; data-model "Content-class columns"; contracts/http-api.md "Admin" |
| G4 / IV. Test-First Filtering: the corpus and detector unit tests come before detector code; CI requires 100% recall on locked categories and at least 99% overall | SC-004, SC-005 | PASS | PASS | research R8; quickstart.md |
| G5 / V. Simplicity: one repo, 2 apps, 4 packages and 4 runtime services, plus an optional Caddy edge proxy, justified in Complexity Tracking; no Presidio sidecar, no Pub/Sub or webhooks, no microservices | Plan scope | PASS | PASS | research R1, R10 |
| G6 / VI. Fail-Closed and Audited: inspection failure means the item is not stored; every governance event writes an audit entry | FR-023, FR-048, FR-064 | PASS | PASS | research R8, R14 |
| G7 / VII. Secrets Encrypted at Rest: mailbox tokens and IMAP passwords use AES-256-GCM with a keyring | FR-008 | PASS | PASS | research R7 |

## Project Structure

### Documentation (this feature)

```text
specs/001-personal-brand-voice/
├── plan.md                          # This file (/speckit-plan command output)
├── research.md                      # Phase 0 output (/speckit-plan command)
├── data-model.md                    # Phase 1 output (/speckit-plan command)
├── quickstart.md                    # Phase 1 output (/speckit-plan command)
├── contracts/                       # Phase 1 output (/speckit-plan command)
│   ├── http-api.md
│   ├── jobs.md
│   ├── filter-categories.md
│   ├── prompt-template-variables.md
│   └── supermemory.md
├── checklists/
│   └── requirements.md              # Existing spec quality checklist
└── tasks.md                         # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/
  web/                          # @voicespark/web — Next.js App Router (user app + /admin)
    app/
      (auth)/sign-in/  (auth)/link-account/
      (user)/dashboard/  onboarding/filters/  sources/  sources/connect/  sources/[sourceId]/
             uploads/  content/  filters/  exclusion-rules/  profiles/  profiles/[profileId]/
             drafts/  drafts/new/  drafts/[draftId]/  notifications/  settings/identities/  settings/account/
      (admin)/admin/  admin/users/  admin/users/[userId]/  admin/definitions/  admin/definitions/[definitionId]/
             admin/prompts/  admin/prompts/[promptId]/  admin/settings/  admin/audit/
      api/auth/[...all]/route.ts            # Better Auth handler
      api/**/route.ts                       # per contracts/http-api.md
    lib/auth.ts  lib/auth-client.ts  lib/guards.ts  lib/http.ts
    components/
    middleware.ts
    e2e/                                    # Playwright specs, one per user story + SC specs
    playwright.config.ts
  worker/                       # @voicespark/worker — BullMQ processors
    src/index.ts
    src/processors/{import,sync-poll,upload,profile,draft,deletion,retroscan,notify,maintenance}.ts
    test/
packages/
  db/                           # @voicespark/db — Drizzle schema, migrations, repositories, seed
    src/schema/*.ts  src/repos/user/*.ts  src/repos/admin/*.ts  src/repos/system/*.ts
    src/seed.ts  drizzle/  drizzle.config.ts
  core/                         # @voicespark/core — env, crypto, queue contracts, domain services, prompting, CLI
    src/env.ts  src/crypto/  src/queues/  src/prompting/  src/cli.ts
    src/services/{identities,sources,imports,uploads,filter-preferences,exclusion-rules,retroscans,
                  content-items,definitions,prompts,profiles,drafts,deletion,audit,notifications,settings,admin-users}.ts
  filters/                      # @voicespark/filters — sensitive-content pipeline (pure, test-first)
    src/categories.ts  src/detectors/*.ts  src/credential-delivery.ts  src/classifier/  src/pipeline.ts  src/document.ts
    test/unit/  test/corpus/fixtures/  test/corpus/corpus.test.ts
  integrations/                 # @voicespark/integrations — external adapters
    src/oauth/  src/gmail/  src/microsoft/  src/imap/  src/mime/  src/files/  src/supermemory/  src/anthropic/
docker/Dockerfile.web  docker/Dockerfile.worker  docker/Caddyfile.example
docker-compose.yml  docker-compose.test.yml  .env.example
package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js  vitest.workspace.ts
```

**Structure Decision**: A single pnpm monorepo with two deployables (`apps/web`, `apps/worker`) built from one repo. Both share `@voicespark/core`, `@voicespark/db`, `@voicespark/filters` and `@voicespark/integrations`. `@voicespark/filters` is isolated as a pure package so it can be tested first and hold the corpus. The admin UI lives in the same Next.js app under the `(admin)` route group at `/admin`, gated by `requireAdmin()` in the layout and in every `/api/admin/*` handler. Compose runtime services are `web`, `worker`, `postgres` and `redis`, plus a one-shot `migrate`. Caddy runs on the host or in an optional compose profile `proxy`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Fifth runtime service: Caddy 2 reverse proxy (optional compose profile `proxy`, Principle V) | Automatic TLS certificates (ACME) and HTTP/2 in front of `web`; OAuth redirect URIs require HTTPS | Terminating TLS inside Next.js needs custom certificate issuance and renewal; operators who already run a host proxy skip the `proxy` profile. The one-shot `migrate` container exits after migrations and is not a long-running service. |
