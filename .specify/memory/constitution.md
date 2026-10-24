# VoiceSpark Constitution

## Core Principles

### I. Privacy by Design

- All user content (email bodies, subjects, text-bearing attachments, uploads, notes, briefs,
  memory snippets and LLM output) MUST pass the sensitive-content pipeline (`inspect()`) before
  any external write, including the memory store (Supermemory) and any LLM call for generation.
- The four credential categories (passwords and passphrases, one-time and verification codes,
  password-reset and verification links, API keys and access tokens) MUST always be excluded and
  MUST NOT be user-deselectable.
- The memory store adapter MUST accept only filtered text (the branded `FilteredText` type), so
  unfiltered writes fail at compile time.
- Any LLM classifier MUST receive only text that already has credentials redacted.

Rationale: the product's core promise is that unauthorised content never reaches the memory store.

### II. Least-Privilege Access

- Sign-in MUST request only `openid email profile`; signing in MUST NOT grant mailbox access.
- Mailbox access MUST be read-only with the minimum scopes: Gmail `gmail.readonly`, Microsoft
  Graph `Mail.Read offline_access User.Read`, IMAP read-only (`EXAMINE`/`BODY.PEEK`, never
  setting `\Seen`).
- Adding a scope MUST be justified in the feature plan and reviewed against this principle.

Rationale: narrower scopes shrink breach impact and the provider-verification burden.

### III. Admins Never See Content

- Admin code paths MUST NOT read encrypted content columns (`*_enc`) or call the memory store.
- Admin responses MUST contain metadata, counts and aggregates only, never raw email, file, note,
  profile excerpt or draft content.
- This MUST be enforced mechanically: import bans in lint, owner-scoped user repositories, and an
  admin content-isolation test suite that runs in CI and fails the build on any leak.
- An admin attempt to reach another user's content MUST return not-found and write an audit entry.

Rationale: governance power over prompts and users must not imply access to anyone's writing.

### IV. Test-First Filtering (NON-NEGOTIABLE)

- The sensitive-content test corpus and detector unit tests MUST be written, and MUST fail, before
  the detector code they cover.
- CI MUST block a merge when recall on the four locked credential categories is below 100% or
  overall item-level recall is below 99% on the corpus.
- Every new detector or filter category MUST arrive with corpus fixtures, including hard negatives.

Rationale: the filter is the product's highest-risk component; only measured recall earns trust.

### V. Simplicity

- The system MUST stay one repository with two apps (web, worker) and four packages (db, core,
  filters, integrations) on four runtime services (web, worker, Postgres, Redis).
- A new service, sidecar, queue technology or package MUST be justified in the plan's Complexity
  Tracking table with the simpler alternative it replaces and why that alternative is
  insufficient.

Rationale: a small team operates this on its own server; every moving part is an operational cost.

## Security & Data Handling Constraints

- **VI. Fail-Closed and Audited**: an item whose inspection cannot complete (error, timeout,
  classifier failure) MUST NOT be stored. Every security- and governance-relevant event (sign-ins,
  source connect and disconnect, deletions, exclusion reports, filter preference changes, admin
  changes to definitions, prompts, users, roles and settings) MUST write an audit entry. Audit
  entries, logs and summaries MUST NOT contain content or excluded values; loggers MUST be typed
  to accept only safe fields.
  Exception: an original file a user uploads to their Context Hub MAY be retained as an
  AES-256-GCM encrypted blob (VII) when inspection of its derived text excludes it or cannot
  complete, provided the blob is downloadable only by its owner and is never sent to an LLM, the
  memory store or any other external service; its derived text follows the rule above and is not
  stored, indexed or synced.
- **VII. Secrets Encrypted at Rest**: mailbox tokens, IMAP passwords, staged uploads and user
  content columns MUST be encrypted with AES-256-GCM under a versioned keyring that supports
  rotation. Secrets MUST NOT appear in logs, API responses, audit metadata or the repository.
  Test-only switches (such as `AUTH_TEST_MODE`) MUST be rejected at startup in production.
- User deletion requests (single source or whole account) MUST remove the data from the memory
  store and the database within 24 hours, verified after deletion.

## Development Workflow & Quality Gates

- Every feature plan MUST include a Constitution Check that evaluates each principle (I–VII)
  before research and again after design, with PASS or a justified entry in Complexity Tracking.
- `/speckit-analyze` MUST report no CRITICAL issues before `/speckit-implement` starts.
- CI MUST run lint, typecheck, unit tests, the filter corpus gates, integration tests and the
  admin content-isolation suite on every change; end-to-end tests MUST run at least nightly.
- Each release MUST pass a documented security review covering scopes, logging, encryption,
  admin isolation, rate limits and OAuth state handling.

## Governance

- This constitution supersedes conflicting practices, plans and task lists. A conflict with a MUST
  is resolved by changing the spec, plan or tasks, not by reinterpreting the principle.
- Amendments are made through `/speckit-constitution`, recorded with a Sync Impact Report, and
  approved by the project owner before merge; dependent feature plans MUST be re-checked after an
  amendment.
- Versioning follows semantic versioning: MAJOR for removing or redefining a principle, MINOR for
  adding a principle or section or materially expanding guidance, PATCH for clarifications.
- Compliance is reviewed in every plan's Constitution Check, in `/speckit-analyze`, in code review
  and in the per-release security review.

**Version**: 1.1.0 | **Ratified**: 2026-10-19 | **Last Amended**: 2026-10-23
