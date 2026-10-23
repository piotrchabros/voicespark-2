# Quickstart: Voice Analysis Prompt (002-voice-analysis-prompt)

Validation and run guide. Entities, enums and state transitions live in [data-model.md](./data-model.md). Request/response shapes and error codes live in [contracts/](./contracts/). This guide does not repeat them. It points at them and states the expected outcome of each scenario.

Environment variables, provider registrations and the production-like run are unchanged from [001 quickstart](../001-personal-brand-voice/quickstart.md). Read that first.

## 1. Prerequisites

- Node 24 LTS, pnpm 10 (via corepack), Docker 27+ with Compose v2.
- Everything in 001 quickstart section 1 that your scenarios need. Scenarios here use test-mode sign-in, so no real provider registration is required.
- `flock` and `psql` on the host.
- Ports used on the shared host: web 3110, Postgres 55432, Redis 56379, memory bridge 4599.

## 2. Setup

```bash
docker compose -f docker-compose.test.yml up -d    # greenmail, postgres-test (:55432), redis-test (:56379)
pnpm install
export DATABASE_URL=postgres://voicespark:voicespark@127.0.0.1:55432/voicespark_test
pnpm db:migrate     # applies the 002 migration; the backfill runs inside it
pnpm db:seed        # v2 system prompt templates and analysis prompts for seeded definitions
```

Playwright browser, once: `pnpm --filter @voicespark/web exec playwright install chromium`. See [apps/web/e2e/README.md](../../apps/web/e2e/README.md) for what an e2e run starts and stops.

## 3. Migration and backfill check

Every definition version must carry analysis prompt text after migration:

```bash
psql "$DATABASE_URL" -c "select version_number, left(analysis_prompt,60) from tone_definition_version order by 1"
```

Expected:

- No row has a null or empty `analysis_prompt`.
- The seeded `general_voice` version shows the 6-dimension prompt (formality, warmth, sentence length, vocabulary, humour, signature phrases).
- Run `pnpm db:migrate` again. Expected: no change, no error (backfill is idempotent).
- Old profile versions are untouched and still readable (US5).

Note: the new v2 templates change behaviour on deploy. Rolling back to v1 templates is blocked by design. See the risks in [plan.md](./plan.md).

## 4. Automated gates

Run in this order. Each must pass.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:admin-isolation
```

| Command | Covers |
|---|---|
| `pnpm lint` | Lint, including the admin import bans |
| `pnpm typecheck` | Types across all workspace packages |
| `pnpm test` | Unit tests: document schema, guard and neutralise, template validation, prompt builder, text diff, document renderer, fake LLM |
| `pnpm test:integration` | Own-prompt limits, encryption at rest, audit without text, publish and rollback notifications, FR-019 pinning, excerpt scrub, hostile prompt cases, backfill idempotency. Needs Postgres :55432 and Redis :56379 |
| `pnpm test:admin-isolation` | SC-007 |

## 5. End-to-end

The host is shared. Hold the lock so only one e2e run is active:

```bash
flock /tmp/claude-0/-root-voicespark-2/c3b6530f-e16f-41b6-a6ca-5bd3eea0f3e2/scratchpad/e2e.lock \
  pnpm --filter @voicespark/web exec playwright test <spec> --project chromium
```

- Web runs on 3110 (`E2E_WEB_PORT` overrides it). 3100 is taken.
- The run recreates database `voicespark_e2e` unless `E2E_FRESH_DB=0`.
- Fallbacks: `PW_CHANNEL=chrome` for system Chrome; `E2E_API_ONLY=1` skips `@ui` tests.
- Never use `pkill` or kill by name. The harness stops its own worker by process group. Other projects run on this host.

## 6. Validation scenarios

Shapes and errors: [contracts/](./contracts/). Tables and enums: [data-model.md](./data-model.md). Sign in with `signInAs` (admin via `role: 'admin'`).

| Story / SC / edge | Steps | Expected |
|---|---|---|
| US1 | As admin, open a definition, edit its analysis prompt as a draft. | Saved as draft. Generation is unaffected. |
| US1 | Render the preview, then run the preview. | Rendered prompt is shown. The run uses built-in synthetic sample writing only. No effect on users before publish. Preview is rate-limited. |
| US1, SC-001 | Publish the draft. Generate as a user without an own prompt. | The new profile version records the new definition version within 1 minute. |
| US1 | Roll back in the version history. | Rollback is recorded. The next generation uses the rolled-back version. |
| US2, SC-003 | Generate with a 5-aspect prompt. | Document has 5 sections, a summary, a do/don't list and at least 3 excerpts, each with its source item. |
| US2 | Give feedback, then edit the document directly. | Each creates a new version. Earlier versions stay viewable. |
| US2, SC-004 | Import authored and received mail. Add an excluded category (for example payment cards). Generate. | No received text and no excluded-category text appears in the document or excerpts. Every excerpt traces to the user's own authored item. |
| US2, FR-019 | Start a generation, publish a new default (and separately, edit an own prompt) before it ends. | The running generation finishes on the version it started with. |
| US2 (edge) | Fake LLM returns a document missing summary, do/don't or excerpts. | Generation fails. No version is saved. The previous version stays current. User sees a retry message. |
| US3, SC-002 | As a user, customise a definition, edit, save. | Own prompt starts as a copy of the default. Each save is a new version. Takes under 3 minutes. |
| US3 | Compare with the default, then reset. | Diff shown. Reset switches to the default and keeps the own prompt and its versions. |
| US3 (edge) | Save an empty or whitespace-only prompt. Save one over the length limit. | Refused with an explanation. The limit is shown. |
| US3 | Sign in as a second user. | No extra section. Cannot see the first user's prompt. |
| US3, FR-010 | Save an own prompt that says "quote received emails" and "ignore the filters". Generate. | No effect. No received quotes. Excluded categories absent. |
| US3, FR-010 | Save an own prompt that contains a password. | Text is redacted. The classifier sees the redacted text. |
| US3, FR-009 | Look for a way to edit drafting prompts or feedback instructions as a user. | None exists. |
| US4, SC-005 | As admin, publish a new default while a user has an own prompt for that definition and another does not. | The own-prompt user is notified within 1 minute. The other user is not. Unchanged text notifies nobody. |
| US4 | Open the notification. | Diff between the base default and the new default is shown. One click switches to the default. |
| US4 | Roll back the default as admin. | Own-prompt users are notified as for any new default. |
| US4 | Generate after the switch. | The next generation records the new default version. |
| US5, SC-006 | Open a seeded legacy (old-format) profile. | Shown readably. |
| US5 | Write a draft from the legacy profile. | Draft is produced. |
| US5 | Regenerate. | New version is a document in the new format. The old version stays viewable. |
| SC-007 | Run `pnpm test:admin-isolation`. As admin, call the user prompt and document endpoints. | Refused. Admin sees only per-definition counts. No text. |
| Edge: retire | Retire a voice that users have own prompts for. | No new versions for that voice. Existing documents and own prompts stay viewable to owners. |
| Edge: source deleted | Delete the source of a quoted excerpt. | Excerpt is removed from all stored versions within the deletion deadline. Outdated banner and a regeneration offer appear. |
| Edge: account delete | Delete the account. | Own prompts, their versions and all documents are gone. |
| Privacy | Read the raw `own_analysis_prompt_version.prompt_text_enc` column and the audit log. | Column holds no plaintext. Audit records events without prompt text. |

## 7. Operations notes

- Output inspection adds classifier calls. Admin preview runs cost tokens.
- The section-per-aspect check (SC-003) relies on the model's declared aspect list. Treat live evals as the check for dropped aspects.
- Excerpt scrub decrypts a user's document versions during the deletion transaction.
