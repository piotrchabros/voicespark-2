# HTTP API Contract: 001-personal-brand-voice

Markdown contract (not OpenAPI). Names of enums, tables and env vars follow the canonical glossary in plan.md and data-model.md.

## Conventions

- JSON over Next.js route handlers under `/api`.
- Auth comes from the Better Auth session cookie. Guards:
  - `requireUser()` returns 401 `unauthenticated`, and 403 `account_suspended` if the account is not active.
  - `requireAdmin()` returns 403 `admin_required`.
  - `requireFiltersConfirmed()` returns 409 `filter_confirmation_required`.
- Request and response bodies are validated with zod.
- Error envelope: `{ "error": { "code": string, "message": string, "details"?: object } }`.
- Pagination is cursor-based: `?cursor=&limit=` (default 25, max 100) returns `{items, nextCursor}`.
- Timestamps are ISO 8601.
- Rate limits (Redis) return 429 `rate_limited`: drafts 20/min/user, generations 10/hour/user, uploads 60/hour/user.
- Accessing another user's resource always returns 404 `not_found`.

Common error codes: `validation_failed` (422), `not_found`, `conflict`, `filter_confirmation_required`, `category_locked`, `imap_auth_failed`, `imap_connection_failed`, `oauth_cancelled`, `oauth_failed`, `insufficient_content`, `definition_retired`, `no_profile`, `last_admin`, `last_available_definition`, `version_not_draft`, `unknown_template_variable`, `model_not_allowed`, `unsupported_type`, `too_large`, `last_identity`.

## Auth and identities (US1)

- `GET|POST /api/auth/[...all]`: Better Auth (social sign-in, callback, `link-social`, `list-accounts`, `unlink-account`, sign-out). If the provider consent is cancelled, redirect to `/sign-in?error=oauth_cancelled` (US1-6). `account_not_linked` redirects to `/link-account?provider=`. FR-001..006.
- `GET /api/me` returns `{id, name, email, role, status, filtersConfirmed: bool, createdAt}`.
- `GET /api/identities` returns `[{id, provider, providerEmail, emailVerified, isRelayEmail, linkedAt, linkedVia}]`.
- `POST /api/identities/link` with `{provider}` returns `{redirectUrl}` (wraps linkSocial). FR-004.
- `DELETE /api/identities/{id}` returns 204. Errors: `last_identity`.

## Filter preferences and rules (US3)

- `GET /api/filter-categories` returns the catalog `[{key, label, description, locked, defaultSelected}]` from contracts/filter-categories.md.
- `GET /api/filter-preferences` returns `{selectedCategories, lockedCategories, confirmedAt, version, updatedAt}`.
- `PUT /api/filter-preferences` with `{selectedCategories: filter_category[]}` returns `{preferences, retroscanId|null}`. It sets `confirmedAt` on first save. Errors: `category_locked`. FR-018/061..064.
- `GET /api/exclusion-rules`.
- `POST /api/exclusion-rules` with `{type, value}` returns `{rule, retroscanId}`.
- `PATCH /api/exclusion-rules/{id}` with `{value}` returns `{rule, retroscanId}`.
- `DELETE /api/exclusion-rules/{id}` returns 204. FR-021.
- `GET /api/retroscans/{id}` returns `{id, status, trigger, matchedCount, createdAt, expiresAt}`.
- `POST /api/retroscans/{id}/confirm` returns 202 `{deletionRequestId}`.
- `POST /api/retroscans/{id}/dismiss` returns 204.

## Sources and imports (US2, US7)

- `GET /api/sources` returns `[{id, type, accountLabel, status, pauseReason, itemCount, lastSyncAt, dateRange: {from, to}, currentImport: ImportProgress|null}]`. FR-046, US7-1.
- `GET /api/sources/{id}` returns the same with `recentImports`.
- `POST /api/sources/connect/{provider}`, where `provider` is `gmail|microsoft`. Body `{dateRange?: {from?, to?}}`. Returns `{authorizeUrl, consentSummary}`. Requires confirmed filters. FR-008/009.
- `GET /api/sources/connect/{provider}/callback?code&state` redirects to `/sources/{id}` and creates the source plus an initial import job. Cancel or error redirects to `/sources/connect?error=oauth_cancelled|oauth_failed`.
- `POST /api/sources/imap` with `{host, port, tlsMode, username, password, dateRange?}` returns 201 `{source}`. Errors: `imap_auth_failed`, `imap_connection_failed` (nothing stored). Requires confirmed filters.
- `POST /api/sources/{id}/reconnect` returns `{authorizeUrl}` for OAuth; IMAP takes body `{password}` and returns 200.
- `POST /api/sources/{id}/pause` and `POST /api/sources/{id}/resume` return `{source}`. FR-011.
- `POST /api/sources/{id}/disconnect` with `{deleteContent: boolean}` returns `{source, deletionRequestId|null}`. FR-015.
- `DELETE /api/sources/{id}` returns 202 `{deletionRequestId}`. FR-046.
- `GET /api/sources/{id}/imports` returns `[ImportProgress]`.
- `GET /api/imports/{id}` returns `ImportProgress`:
  - fields: `{id, kind, status, pauseReason, itemsDiscovered, itemsProcessed, itemsImported, itemsDuplicate, itemsExcluded, itemsSkipped, itemsFailed, totalEstimate, remainingEstimate, startedAt, finishedAt, lastActivityAt}`;
  - FR-010.
- `GET /api/imports/{id}/exclusion-summary` returns `{importJobId, categories: [{key, label, excludedItems, redactedValues}], skipped: [{reason, count}]}`. Never contains values. FR-020.

## Content items (US3-5, US4-5)

- `GET /api/content-items?sourceId&query&cursor` returns `[{id, kind, authorship, itemDate, sourceIds, title?, snippet?}]`. Title and snippet are fetched live from Supermemory for the owner only.
- `POST /api/content-items/{id}/report` with `{category?}` returns 202 `{reportId, deletionRequestId}`. FR-022.
- `DELETE /api/content-items/{id}` returns 202 `{deletionRequestId}`.

## Uploads and notes (US4)

- `POST /api/uploads`, multipart `file` plus `authorship?`, returns 202 `{uploadId}`. Synchronous errors: `unsupported_type` (415), `too_large` (413). Requires confirmed filters.
- `POST /api/notes` with `{text (1-100000), title?, authorship?}` returns 202 `{uploadId}`. Requires confirmed filters.
- `GET /api/uploads` and `GET /api/uploads/{id}` return `{id, kind, filename, status, rejectReason, importJobId, contentItemId, createdAt}`.
- `DELETE /api/uploads/{id}` returns 202 `{deletionRequestId}`. FR-024..027.

## Definitions and profiles (US5)

- `GET /api/definitions` returns available definitions `[{id, name, description, chosen}]`. FR-065.
- `PUT /api/definition-choices` with `{definitionIds: uuid[] (min 1)}` returns the list. FR-066.
- `GET /api/profiles/eligibility` returns `{authoredWordCount, authoredItemCount, thresholdWords, eligible}`. FR-029.
- `GET /api/profiles` returns `[{id, definition: {id, name, retired}, status, latestVersion: {id, versionNumber, createdAt}|null, outdatedReason, canRegenerate, activeGeneration|null}]`.
- `POST /api/profiles/generate` with `{definitionIds?: uuid[]}` (default: all chosen) returns 202 `{generations: [{id, profileId}]}`. Errors: `insufficient_content`, `definition_retired`.
- `GET /api/profile-generations/{id}` returns `{id, status, blockReason, errorCode, resultVersionId}`.
- `GET /api/profiles/{id}` returns the profile plus the latest version body.
- `GET /api/profiles/{id}/versions` returns a list.
- `GET /api/profiles/{id}/versions/{versionId}` returns `{id, versionNumber, origin, definitionVersion: {id, versionNumber}, promptVersion: {id, versionNumber}|null, body, languages, createdAt}`. FR-031/032.
- `PUT /api/profiles/{id}/versions/{versionId}/rating` with `{rating: "sounds_like_me" | "not_like_me"}` returns `{profileVersion}`. A user may rate only their own profiles; errors: 404 `not_found` if not the owner. SC-007.
- `POST /api/profiles/{id}/regenerate` returns 202 `{generationId}`.
- `POST /api/profiles/{id}/feedback` with `{feedback (1-2000)}` returns 202 `{generationId}`.
- `POST /api/profiles/{id}/adjust` with `{dimensions: {[key]: value}, note?}` returns 201 `{version}` (origin `manual_edit`, validated against the dimension specs). Error: 422 `sensitive_content` when a `text` or `list` value or the `note` contains an excluded value.
- `DELETE /api/profiles/{id}` returns 202 (deletes versions; removes the choice).

## Drafts (US8)

- `GET /api/drafts?contentType&profileId&cursor` returns `[{id, contentType, topic, profile: {id, definitionName}, profileVersionNumber, status, rating, createdAt}]`. FR-054.
- `POST /api/drafts` with `{contentType, profileId, brief (1-2000)}` returns 202 `{draftId}`. Error: `no_profile`. FR-049..052.
- `GET /api/drafts/{id}` returns `{..., title, text (edited ?? generated), generatedText, editedText, feedback, redactionsApplied, profileVersionId, promptVersionId, parentDraftId}`.
- `PATCH /api/drafts/{id}` with `{editedText}` returns `{draft}`.
- `POST /api/drafts/{id}/regenerate` with `{feedback?}` returns 202 `{draftId}` (a new row). FR-053.
- `PUT /api/drafts/{id}/rating` with `{rating: "sounds_like_me" | "not_like_me"}` returns `{draft}`. SC-013.
- `GET /api/drafts/{id}/export?format=md|txt` returns a file download.
- `DELETE /api/drafts/{id}` returns 204. FR-055.
- There is no publish endpoint (FR-056).

## Notifications, account and deletions (US7)

- `GET /api/notifications` and `POST /api/notifications/{id}/read`.
- `POST /api/account/delete` with `{confirm: "DELETE"}` returns 202 `{deletionRequestId}`. It signs the user out. Errors: `last_admin` (the last active admin cannot delete their account). FR-044, FR-047.
- `GET /api/deletions/{id}` returns `{id, scope, status, requestedAt, dueBy, completedAt}`.

## Admin (`requireAdmin`; responses are metadata-only schemas; SC-010)

### Users

- `GET /api/admin/users?query&role&status&cursor` returns `[{id, name, email, role, status, providers, sourceCount, createdAt, lastSignInAt}]`.
- `GET /api/admin/users/{id}` returns `{account metadata, identities: [{provider, providerEmail, verified}], sources: [{id, type, accountLabel, status, itemCount, lastSyncAt, currentImport: {status, itemsProcessed, totalEstimate}}], profiles: [{definitionName, status, versionCount, lastGeneratedAt}]}`. No drafts, no excerpts, no bodies. FR-043/045/060.
- `POST /api/admin/users/{id}/suspend` with `{reason?}`, and `POST /api/admin/users/{id}/reinstate`. Errors: `last_admin`, including self-suspension of the last admin. FR-006/044.
- `PUT /api/admin/users/{id}/role` with `{role}`. Errors: `last_admin`.

### Definitions

- `GET /api/admin/definitions` returns `[{id, key, availability, activeVersion: {id, versionNumber, name}, draftVersionId, userChoiceCount}]`.
- `POST /api/admin/definitions` with `{key, name, description, dimensions}` creates the definition and its v1 draft.
- `GET /api/admin/definitions/{id}` returns versions.
- `POST /api/admin/definitions/{id}/versions` with `{fromVersionId?}` returns a draft. Error: `conflict` if a draft exists.
- `PATCH /api/admin/definitions/{id}/versions/{versionId}` (draft only; `version_not_draft`).
- `DELETE /api/admin/definitions/{id}/versions/{versionId}` (discard draft).
- `POST /api/admin/definitions/{id}/versions/{versionId}/publish`.
- `POST /api/admin/definitions/{id}/rollback` with `{versionId}`.
- `PUT /api/admin/definitions/{id}/availability` with `{availability}`. Errors: `last_available_definition`, and `conflict` with no active version.
- `GET /api/admin/definitions/{id}/history` returns `[{action, fromVersion, toVersion, actor: {id, name}, occurredAt}]`.
- `GET /api/admin/definitions/{id}/versions/{versionId}/diff?against={versionId}`.
- FR-038/040..042/068.

### Prompts

The same route set under `/api/admin/prompts`. Additions:

- `POST /api/admin/prompts` with `{key (custom.*), description, systemTemplate, userTemplate, model, effort, maxTokens}`.
- `POST /api/admin/prompts/{id}/versions/{versionId}/validate` returns `{valid, unknownVariables: [], missingRequired: []}`.
- `POST /api/admin/prompts/{id}/versions/{versionId}/preview` returns a render using a **synthetic fixture only**, never user data.
- There is no availability endpoint. System prompts can't be deleted.
- FR-039/041/042/057.

### Settings and audit

- `GET /api/admin/settings` and `PUT /api/admin/settings` with `{key, value}`.
- `GET /api/admin/audit?action&actorUserId&targetType&targetId&from&to&cursor`.
- `GET /api/admin/system/health` returns `{queues: {name: {waiting, active, failed, delayed}}, overdueDeletions: int, credentialAuditHits: int}`.
- `GET /api/admin/metrics/ratings?from&to` (admin only) returns `{profiles: {rated, soundsLikeMe, share}, drafts: {rated, soundsLikeMe, share, byContentType: {...}}}`. Aggregates only; never content or per-user rows. FR-045/060, SC-007, SC-013.

## FR to endpoint table

| FR | Endpoints |
|----|-----------|
| FR-001..006 | `/api/auth/[...all]`, `/api/me` |
| FR-004 | `POST /api/identities/link`, `GET /api/identities`, `DELETE /api/identities/{id}` |
| FR-006, FR-044 | `POST /api/admin/users/{id}/suspend`, `POST /api/admin/users/{id}/reinstate` |
| FR-008, FR-009 | `POST /api/sources/connect/{provider}`, `GET /api/sources/connect/{provider}/callback`, `POST /api/sources/imap` |
| FR-010 | `GET /api/imports/{id}`, `GET /api/sources/{id}/imports` |
| FR-011 | `POST /api/sources/{id}/pause`, `POST /api/sources/{id}/resume` |
| FR-015 | `POST /api/sources/{id}/disconnect` |
| FR-018, FR-061..064 | `GET|PUT /api/filter-preferences`, `GET /api/filter-categories` |
| FR-020 | `GET /api/imports/{id}/exclusion-summary` |
| FR-021 | `/api/exclusion-rules`, `/api/retroscans/{id}` (+ `confirm`, `dismiss`) |
| FR-022 | `POST /api/content-items/{id}/report` |
| FR-024..027 | `POST /api/uploads`, `POST /api/notes`, `GET /api/uploads`, `GET /api/uploads/{id}`, `DELETE /api/uploads/{id}` |
| FR-029 | `GET /api/profiles/eligibility` |
| FR-031, FR-032 | `GET /api/profiles/{id}/versions`, `GET /api/profiles/{id}/versions/{versionId}` |
| FR-038, FR-040..042, FR-068 | `/api/admin/definitions/**` |
| FR-039, FR-041, FR-042, FR-057 | `/api/admin/prompts/**` |
| FR-043, FR-045, FR-060 | `GET /api/admin/users`, `GET /api/admin/users/{id}` |
| FR-046 | `GET /api/sources`, `GET /api/sources/{id}`, `DELETE /api/sources/{id}` |
| FR-047 | `POST /api/account/delete`, `GET /api/deletions/{id}` |
| FR-049..052 | `POST /api/drafts` |
| FR-053 | `POST /api/drafts/{id}/regenerate` |
| FR-054 | `GET /api/drafts` |
| FR-055 | `GET /api/drafts/{id}/export`, `DELETE /api/drafts/{id}` |
| FR-056 | No publish endpoint (intentionally absent) |
| FR-065 | `GET /api/definitions` |
| FR-066 | `PUT /api/definition-choices` |
| SC-007 | `PUT /api/profiles/{id}/versions/{versionId}/rating`, `GET /api/admin/metrics/ratings` |
| SC-013 | `PUT /api/drafts/{id}/rating`, `GET /api/admin/metrics/ratings` |
| FR-045, FR-060 (aggregates) | `GET /api/admin/metrics/ratings` |
