# HTTP API Contract: 003-context-hub (delta against 001 and 002)

This file is a delta against `specs/001-personal-brand-voice/contracts/http-api.md` and `specs/002-voice-analysis-prompt/contracts/http-api.md`. Everything not listed here is unchanged. Conventions, the error envelope, pagination, rate limits and common error codes of 001 apply.

## Conventions added

- All `/api/hub/**` routes are user routes. They use `requireUser()`: 401 `unauthenticated`, 403 `account_suspended`. They are owner-scoped. A foreign or unknown id returns 404 `not_found`. Admin routes never return hub content (SC-011).
- An admin calling a hub route for another user's data gets 404 `not_found` and an `admin.content_access_denied` audit entry.
- Mutating routes use the existing `rateLimit()`. Limits: file upload 60/hour/user (shared with uploads), notes and records 120/min/user, search 60/min/user.
- `{kind}` is `people`, `companies` or `projects`. Anything else returns 404.
- Record shapes, with `source` fields explained in "Provenance":

```json
Person   {"id","name","roleTitle","phone","description","emails":[{"id","address","isPrimary","origin"}],
          "ownerFields":["name","phone"],"createdFrom":"user|email","createdAt","updatedAt"}
Company  {"id","name","website","industry","description","domains":[{"id","domain","origin"}],
          "ownerFields":[],"createdFrom":"user|email","createdAt","updatedAt"}
Project  {"id","name","status":"planned|active|on_hold|completed","startDate","endDate","description",
          "ownerFields":[],"createdFrom":"user|email","createdAt","updatedAt"}
Link     {"id","kind":"person_company|person_project|company_project","personId","companyId","projectId",
          "role","origin":"user|email","createdAt"}
```

- Limits: name 1..200; role/title 200; phone 50 matching `^[0-9+()\-.\s/x]*$`; email at most 320 chars, lower-cased; domain per `^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$`, no `www.`; website `http(s)`, a bare domain becomes `https://`; description 2000; link role 100; project `endDate >= startDate`.
- Contact values (email, phone, domain) pass `validateContactValue`. A rejected value returns 422 `sensitive_content` with `details.fields`.
- Free text (name, role, description, industry, website, link role) passes `inspectSegments` under the user's full policy. Redacted values are stored redacted. The response includes `redactedValues` (a count) when it is above zero.

New error codes: `link_exists` (409, `details.linkId`), `invalid_link` (409), `inspection_unavailable` (503), `note_excluded` (422, `details.category`), `suggestion_not_pending` (409), `merge_invalid` (409), `hub_not_enabled` (409), `hub_data_choice_required` (422). Existing codes `validation_failed`, `not_found`, `conflict`, `sensitive_content`, `rate_limited`, `too_large` (413) and `unsupported_type` (415, `details.allowed`) also apply. Codes are registered in `ERROR_STATUS` of `packages/core/src/errors.ts`.

## Records (US1)

- `GET /api/hub/{kind}?sort=name|updated&order=asc|desc&cursor&limit` returns `{items: [Record + {linkCounts, noteCount, fileCount}], nextCursor}`. Sorting by name happens in the app after decrypting (at most 10,000 per kind). Default `sort=name`, limit 25, max 100. FR-006.
- `POST /api/hub/{kind}` creates a record. Body is the record fields without `id`. Person may include `emails: string[]`, company `domains: string[]`. Returns 201 `{record, similar: [{id, name}]}`. `similar` lists same-kind records with the same name ignoring case. It never blocks. FR-002, FR-003.
- `GET /api/hub/{kind}/{id}` returns `{record, links: [{link, other: {kind, id, name}}], sync: {status, lastSyncedAt}}`.
  - `?deletePreview=1` returns `{notes, files, links}` counts instead. FR-004.
- `PATCH /api/hub/{kind}/{id}` patches the given fields. A field set to null counts as user-cleared. Returns `{record, similar}`. Every patched field is added to `ownerFields`. Email facts on those fields become `overridden`.
- `DELETE /api/hub/{kind}/{id}` returns 204. It deletes the record with its notes, files and links, and keeps linked records. It writes block markers for email-origin values and a sync tombstone. Audit `hub.record_deleted`.
- `GET /api/hub/{kind}/{id}/merge-preview?sourceId=` returns `{moves: {emails, domains, notes, files, links, linkDuplicates, summaries, facts}, keptValues: [field], filledValues: [field]}`.
- `POST /api/hub/{kind}/{id}/merge` with `{sourceId}` merges `sourceId` into `{id}`. Returns `{record}`. Kept values win and empty fields take the source value. Errors: 404, 409 `merge_invalid` (same id or different kind). Audit `hub.records_merged`. FR-005.
- `POST /api/hub/{kind}/{id}/emails` with `{address}` (person) and `POST /api/hub/{kind}/{id}/domains` with `{domain}` (company) return 201. `DELETE /api/hub/{kind}/{id}/emails/{emailId}` and `DELETE .../domains/{domainId}` return 204. Errors: 409 `conflict` when another record of the user already has the address or domain.

## Links (US2)

- `POST /api/hub/links` with `{kind, personId?, companyId?, projectId?, role?}`. The two ids must match the kind. Returns 201 `{link}`. Errors: 409 `link_exists` (one link per pair), 409 `invalid_link` (same-kind pair or wrong ids), 404. FR-007.
- `PATCH /api/hub/links/{id}` with `{role}` (null clears it) returns `{link}`. Sets `role_owner_set`.
- `DELETE /api/hub/links/{id}` returns 204.
- Links appear on both records in `GET /api/hub/{kind}/{id}`.

## Notes (US2)

- `GET /api/hub/{kind}/{id}/notes?cursor&limit` returns `{items: [{id, title, body, createdAt, updatedAt, redactedValues}], nextCursor}` newest change first. `body` is ProseMirror JSON.
- `POST /api/hub/{kind}/{id}/notes` with `{title, body}` returns 201 `{note}`. `title` 0..300, `body` ProseMirror JSON, at most 1 MB serialised and 100,000 text chars.
- `GET|PATCH|DELETE /api/hub/notes/{id}`. `PATCH` takes `{title?, body?}`. `DELETE` returns 204.
- Validation: `Node.fromJSON(...).check()`, then an allowlist. Nodes: doc, paragraph, heading (1 to 3), text, bulletList, orderedList, listItem, taskList, taskItem, hardBreak, horizontalRule, blockquote, codeBlock. Marks: bold, italic, underline, strike, code, link. Link `href` must match `^(https?|mailto):`. Anything else returns 422 `validation_failed`.
- Filtering: text nodes and link hrefs pass `inspectSegments` and the JSON is rebuilt. Redacted spans are replaced and `redactedValues` is set. A wholly excluded note returns 422 `note_excluded` with `details.category` and is not saved. An inspection failure returns 503 `inspection_unavailable` and nothing is saved (fail-closed). FR-008, FR-028.

## Files (US2)

- `GET /api/hub/{kind}/{id}/files` returns `{items: [File]}`.
- `POST /api/hub/{kind}/{id}/files` is `multipart/form-data` with part `file` and optional `description`. Returns 202 `{file}` with `extractionStatus: "pending"`. Limit 25 MB (`HUB_FILE_MAX_BYTES`). Errors: 413 `too_large`, 415 `unsupported_type` with `details.allowed`.
- Allowed extensions: pdf, docx, odt, doc, rtf, xlsx, ods, csv, xls, pptx, odp, ppt, txt, md, markdown, png, jpg, jpeg, gif, webp. Magic bytes are checked (doc, xls and ppt must sniff as `cfb`; txt, md and csv must be strict UTF-8 with no NUL). SVG is refused.
- `File = {id, ownerKind, ownerId, name, description, mimeType, extension, sizeBytes, extractionStatus, extractionReason, redactedValues, createdAt, updatedAt}`.
  - `extractionStatus`: `pending`, `extracted`, `empty`, `unsupported`, `failed`, `excluded`.
  - `extractionReason` codes: `no_text_extraction_for_type`, `image_not_searchable`, `empty`, `timeout`, `corrupt`, `inspection_failed` (status `failed`), or the filter category key for `excluded`.
- `GET /api/hub/files/{id}` returns `{file}`. `PATCH` takes `{name?, description?}`. `name` is 1..255 with no `/`, `\` or control chars. `DELETE` returns 204 and removes the blob after commit.
- `GET /api/hub/files/{id}/download` streams the decrypted original. Headers: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. Owner only. The original is never sent to the AI service or the memory store.
- A whole-file exclusion sets `extractionStatus = excluded`, discards the extracted text and keeps the blob. Audit `hub.file_excluded` (`{category}`).

## Search (US5)

See contracts/hub-search.md for the index and ranking.

- `GET /api/hub/search?q&types&limit&cursor`. `q` is 1..200 chars. `types` is a comma list of `person,company,project,note,file`. Default limit 20, max 100.
- Response 200:

```json
{"items": [{
  "type": "person|company|project|note|file",
  "id": "uuid",
  "title": "string",
  "owner": {"kind": "person|company|project", "id": "uuid", "name": "string"} | null,
  "snippets": [{"text": "string", "highlights": [[0, 5]]}],
  "updatedAt": "iso"
}], "nextCursor": "string|null"}
```

- The server sends no HTML. The client renders highlights. A query with no usable token returns an empty list.

## Suggestions (US4)

- `GET /api/hub/suggestions?state=suggested&cursor&limit` returns:

```json
{"items": [{
  "id": "uuid",
  "type": "person|person_email|company|company_domain|project|field|link|link_role",
  "target": {"kind": "person|company|project|link", "id": "uuid|null", "label": "string|null"},
  "field": "string|null",
  "proposed": "value or object",
  "current": "value or null",
  "conflict": false,
  "reason": "low_confidence|conflict|tombstoned|name_only_match|inferred_project",
  "confidence": 0.74,
  "dependsOn": "uuid|null",
  "sources": [{"threadId": "uuid", "subject": "string", "firstMessageAt": "iso", "lastMessageAt": "iso", "evidence": "string"}],
  "createdAt": "iso"
}], "nextCursor": "string|null"}
```

  FR-023.
- `GET /api/hub/suggestions/count` returns `{pending: number}`. Used by the hub badge. FR-024.
- `POST /api/hub/suggestions/decide` with `{ids: uuid[] (1..200), action: "accept" | "reject"}` returns `{results: [{id, status: "accepted"|"rejected"|"failed", errorCode?}]}`. Each id runs in its own transaction, in dependency order (a dependent is applied after what it depends on; rejecting a parent rejects its dependents). A fact that is no longer `suggested` gives `errorCode: "suggestion_not_pending"` for that id and does not fail the call. Accepting a conflict value sets the field and adds it to `ownerFields`. Audit `hub.suggestions_bulk_decided` (`{accepted, rejected, failed}`).

## Sources of facts (US3)

- `GET /api/hub/{kind}/{id}/sources` returns `{items: [{threadId, subject, firstMessageAt, lastMessageAt, messageCount, participants: [{name, address, owner}], summary, openUrl|null, supports: [{field|link|email|domain}]}]}`. `openUrl` is the provider "open original" link when one exists (none for IMAP). It shows the conversations that support applied or overridden email facts of the record, and the summaries attached to it. FR-018, FR-019.

## Mailboxes and ignore rules (US3, US8)

- `GET /api/hub/mailboxes` returns `{items: [{sourceId, accountLabel, status, enabled, enabledAt, backfillState: "none|pending|running|done", pausedUntil|null, threadsProcessed, threadsSkipped, threadsFailed, lastRunAt|null, dataChoice: "keep|delete|null", failedThreads: [{id, subjectAvailable: false, errorCode, attempts, lastAttemptAt}]}]}`. FR-022. `pausedUntil` is set when the daily cap is reached.
- `POST /api/hub/mailboxes/{sourceId}/enable` with `{acknowledgeAi: true}` returns `{mailbox}`. Without `acknowledgeAi: true`: 422 `validation_failed`. Records the consent text version, sets `backfillState = pending` and enqueues `hub.backfill`. 409 `conflict` if already enabled. Audit `hub.mailbox_enabled` (`{sourceId, consentTextVersion}`). FR-012.
- `POST /api/hub/mailboxes/{sourceId}/disable` with `{hubData: "keep" | "delete"}` returns `{mailbox, deletionRequestId|null}`. `delete` creates a `deletion_request` with scope `hub_source`. 409 `hub_not_enabled` if not enabled. Audit `hub.mailbox_disabled` (`{sourceId, hubData}`). FR-031.
- `POST /api/hub/mailboxes/{sourceId}/threads/{threadId}/retry` returns 202. The thread must be `failed`. It resets `attempts` and enqueues `hub.thread`. 409 `conflict` otherwise.
- `GET /api/hub/ignore-rules` returns `{items: [{id, kind: "address"|"domain", value, createdAt}]}`.
- `POST /api/hub/ignore-rules` with `{kind, value}` returns 201 `{rule}`. A domain rule covers subdomains. Address lower-cased; domain normalised as for company domains. 409 `conflict` if it exists. Audit `hub.ignore_rule_created` (`{kind}`). FR-021.
- `DELETE /api/hub/ignore-rules/{id}` returns 204. Audit `hub.ignore_rule_deleted` (`{kind}`).

## Memory store sync (US7)

See contracts/memory-store-hub.md.

- `GET /api/hub/sync?status=pending|stored|failed&cursor&limit` returns `{counts: {stored, pending, failed}, items: [{id, entityType, entityId, label, status, attempts, lastErrorCode, lastSyncedAt}]}`. `label` is the decrypted item name. FR-026.
- `POST /api/hub/sync/retry` with `{ids?: uuid[]}` returns 202 `{requeued: number}`. Without ids it retries every `failed` row.
- `POST /api/hub/sync/resync` returns 202 `{requeued: number}`. It back-fills missing rows and marks every non-deleted row dirty. It never deletes the namespace. Audit `hub.resync_requested` (`{items}`).
- Every record, note and file response carries `sync: {status: "stored"|"pending"|"failed", lastSyncedAt|null}`.

## Delta: disconnect and delete a source (FR-031)

- `POST /api/sources/{id}/disconnect` body becomes `{deleteContent: boolean, hubData?: "keep" | "delete"}`. `hubData` is required when the hub is enabled for the source, otherwise 422 `hub_data_choice_required`. It is ignored when the hub is not enabled. Response is unchanged: `{source, deletionRequestId|null}`.
  - `hubData = "delete"` and `deleteContent = false`: a separate `hub_source` deletion request is created and its id is returned.
  - `hubData = "delete"` and `deleteContent = true`: `deleteSource` runs the hub purge first, within the same deletion request.
  - `hubData = "keep"`: `data_choice = keep`. Derived data survives (source references are set to null).
- `DELETE /api/sources/{id}` uses the stored `data_choice`. With the hub enabled and no choice recorded it deletes hub data. Response is unchanged.
- `GET /api/sources` and `GET /api/sources/{id}` gain `hub: {enabled: boolean}`.

## Delta: drafts with a record (FR-027)

- `POST /api/drafts` gains the optional field `hubRecord: {kind: "person" | "company" | "project", id: uuid}`. The record must belong to the user, otherwise 404 `not_found`. The response is unchanged: 202 `{draftId}`.
- `POST /api/drafts/{id}/regenerate` inherits the pin. The body is unchanged.
- `GET /api/drafts` items and `GET /api/drafts/{id}` gain `hubRecord: {kind, id|null, label} | null`. `label` is the name at creation and survives record deletion. `id` is null when the record was deleted.
- The draft detail carries `hubContextStatus` (`used`, `missing` or `inspection_failed`, or null), read from `draft.hub_context_status`. `missing` means the record was deleted before the run. It is not an error.

## Delta: admin (FR-029)

- `GET /api/admin/users/{id}` gains `hub: {recordCount, noteCount, fileCount, pendingSuggestionCount, syncFailedCount, hubMailboxCount}`. Numbers only. The repo uses `count(*)` and selects no `_enc` columns.
- `GET /api/admin/system/health` gains aggregate `hub: {llmCallsToday, inputTokensToday, outputTokensToday, threadsPending, threadsFailed, syncFailed}`. Numbers only.
- The admin schema is a strict object. `ADMIN_FORBIDDEN_FIELDS` gains `summary`, `evidence`, `participants`, `emails`, `phone`, `domains`, `roleTitle`, `industry`, `website`, `extractedText`, `fileName`. The words `description` and `role` are not listed (they collide with other admin fields); the sentinel scan plus strict numeric hub schemas cover them.
- New setting `hub.daily_thread_cap_per_user` (integer, default 500) via the existing settings route.
- No admin route reads or lists hub records, notes, files, summaries, suggestions or links.

## Delta: audit actions

`hub.mailbox_enabled` (`{sourceId, consentTextVersion}`), `hub.mailbox_disabled` (`{sourceId, hubData}`), `hub.mailbox_data_deleted` (`{sourceId, threads, records, links, values}`; values = cleared fields plus deleted emails and domains), `hub.record_deleted` (`{kind, notes, files, links}`), `hub.records_merged` (`{kind}`), `hub.suggestions_bulk_decided` (`{accepted, rejected, failed}`), `hub.ignore_rule_created` and `hub.ignore_rule_deleted` (`{kind}`), `hub.resync_requested` (`{items}`), `hub.file_excluded` (`{category}`). Metadata holds ids and counts only, never names or content.

## Requirement to route map

| Requirement | Routes |
|---|---|
| FR-002, FR-003, FR-004, FR-006 | `/api/hub/{kind}`, `/api/hub/{kind}/{id}` |
| FR-005 | `/api/hub/{kind}/{id}/merge-preview`, `/merge` |
| FR-007 | `/api/hub/links` |
| FR-008 | `/api/hub/{kind}/{id}/notes`, `/api/hub/notes/{id}` |
| FR-009, FR-010 | `/api/hub/{kind}/{id}/files`, `/api/hub/files/{id}`, `/download` |
| FR-011 | `/api/hub/search` |
| FR-012, FR-022 | `/api/hub/mailboxes`, `/enable`, `/disable` |
| FR-018, FR-019 | `/api/hub/{kind}/{id}/sources` |
| FR-021 | `/api/hub/ignore-rules` |
| FR-023, FR-024 | `/api/hub/suggestions`, `/decide`, `/count` |
| FR-025, FR-026 | `/api/hub/sync`, `/retry`, `/resync` |
| FR-027 | `POST /api/drafts` (`hubRecord`) |
| FR-029 | `GET /api/admin/users/{id}` (`hub` counts) |
| FR-031 | `POST /api/sources/{id}/disconnect`, `DELETE /api/sources/{id}` |
