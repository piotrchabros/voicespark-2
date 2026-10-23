# HTTP API Contract: 002-voice-analysis-prompt (delta against 001)

This file is a delta against `specs/001-personal-brand-voice/contracts/http-api.md`. Everything not listed here is unchanged. Conventions, the error envelope, pagination, rate limits and the common error codes of 001 apply.

## Conventions added

- All `/api/analysis-prompts/**` routes are user routes. They use `requireUser()`: 401 `unauthenticated`, 403 `account_suspended`. They are owner-scoped. A foreign or unknown id returns 404 `not_found`.
- `{definitionId}` must be a definition the user has chosen or has a profile for. Otherwise 404 `not_found`.
- An admin calling a user route for another user's data gets 404 `not_found` and an `admin.content_access_denied` audit entry.
- Admin routes use `requireAdmin()`: 403 `admin_required`. Admin responses never contain own prompt text or document bodies (SC-007).
- `DiffOp = {op: "equal" | "insert" | "delete", value: string}`. Diffs are line-based, with word-level ops inside changed lines. They are computed on the server, per request.
- Limit constant: `maxChars = 20000` for default and own prompts.

New error codes: `analysis_prompt_excluded`, `output_excluded`, `invalid_output`, `llm_refused` (generation errors, not HTTP codes; see contracts/analysis-prompt.md), and the existing `sensitive_content` with `details.fields`.

## Own analysis prompts (US3, US4)

### `GET /api/analysis-prompts`

List for the user's chosen definitions and definitions with a profile.

- Response 200:
  ```json
  [{
    "definition": {"id": "uuid", "name": "string", "retired": false},
    "profileId": "uuid|null",
    "mode": "default|own",
    "default": {"definitionVersionId": "uuid", "versionNumber": 3},
    "own": {"id": "uuid", "inUse": true,
            "currentVersion": {"id": "uuid", "versionNumber": 2, "basedOnDefinitionVersionId": "uuid", "createdAt": "iso"}} ,
    "defaultChangedSinceBase": false
  }]
  ```
  `own` is `null` when the user never customised. `mode` is `own` only when `own.inUse` is true. No prompt text in the list.
- Errors: 401, 403.

### `GET /api/analysis-prompts/{definitionId}`

- Response 200:
  ```json
  {
    "definition": {"id": "uuid", "name": "string", "retired": false},
    "default": {"definitionVersionId": "uuid", "versionNumber": 3, "promptText": "string"},
    "own": {"id": "uuid", "inUse": true,
            "currentVersion": {"id": "uuid", "versionNumber": 2, "promptText": "string",
                               "basedOnDefinitionVersion": {"id": "uuid", "versionNumber": 2}, "createdAt": "iso"}},
    "limits": {"maxChars": 20000}
  }
  ```
  `own` is `null` if none exists. After a reset, `own` is present with `inUse: false` and the last version.
- Errors: 401, 403, 404 `not_found` (unknown, not chosen, foreign).

### `POST /api/analysis-prompts/{definitionId}/customise`

Creates the user's own prompt as a copy of the current default (version 1, `in_use = true`). After a reset it creates a new version from a fresh copy of the current default and sets `in_use = true`.

- Body: none.
- Response 201: `{own: {id, inUse: true, currentVersion: {id, versionNumber, basedOnDefinitionVersionId, createdAt}}}`.
- Errors: 401, 403, 404 `not_found` (not chosen), 409 `conflict` (own prompt already in use), 409 `definition_retired`.
- Audit: `analysis_prompt.customised`.

### `PUT /api/analysis-prompts/{definitionId}`

Saves the own prompt as a new version. The new version keeps the `based_on` definition version of the version it was saved from and sets `in_use = true`.

- Body: `{"promptText": "string", "baseVersionId": "uuid"}`. `baseVersionId` is the own version the editor started from.
- Response 201: `{own: {id, inUse: true, currentVersion: {id, versionNumber, basedOnDefinitionVersionId, createdAt}}}`.
- Errors:
  - 401, 403, 404 `not_found` (no own prompt, not chosen).
  - 422 `validation_failed` with `details: {field: "promptText", reason: "empty" | "too_long", maxChars: 20000}`. "Empty" means empty after trimming.
  - 409 `conflict` when `baseVersionId` is not the current version (stale editor).
  - 409 `definition_retired`.
- The text is encrypted at rest. It is not inspected on save. It is inspected under the current preferences at each generation (`analysis_prompt_excluded` if wholly excluded).
- Audit: `analysis_prompt.saved`.

### `POST /api/analysis-prompts/{definitionId}/reset`

Switches back to the default. History is kept.

- Body: none.
- Response 200: `{own: {id, inUse: false}}`. Calling it when already reset is idempotent and returns the same 200 response. Calling it when the user has no own prompt for that definition returns 404 `not_found`.
- Errors: 401, 403, 404 `not_found` (not chosen).
- Audit: `analysis_prompt.reset`.

### `GET /api/analysis-prompts/{definitionId}/versions`

- Response 200: `[{id, versionNumber, basedOnDefinitionVersion: {id, versionNumber}, createdAt, inUseNow}]`, newest first. `inUseNow` is true for the current version while the own prompt is in use.
- Errors: 401, 403, 404.

### `GET /api/analysis-prompts/{definitionId}/versions/{versionId}`

- Response 200: the list item plus `promptText`.
- Errors: 401, 403, 404 (unknown version, foreign).

### `GET /api/analysis-prompts/{definitionId}/compare`

Compares the current own version with the current default.

- Response 200:
  ```json
  {"own": {"versionId": "uuid", "versionNumber": 2},
   "default": {"definitionVersionId": "uuid", "versionNumber": 3},
   "diff": [{"op": "equal", "value": "..."}]}
  ```
- Errors: 401, 403, 404 `not_found` (no own prompt).

### `GET /api/analysis-prompts/{definitionId}/default-changes?from={definitionVersionId}&to={definitionVersionId}`

Shows what changed between two default versions of this definition (FR-013). `to` defaults to the active version. `from` is required.

- Response 200: `{"from": {"id": "uuid", "versionNumber": 2}, "to": {"id": "uuid", "versionNumber": 3}, "diff": DiffOp[]}`.
- Errors: 401, 403, 404 `not_found` (version not of this definition, or definition not chosen), 422 `validation_failed` (missing `from`).
- Both versions are admin config, so the response carries no user content.

## Profiles and documents (US2, US5) - changes

### `GET /api/profiles/{id}/versions/{versionId}` (changed)

Response 200 adds fields. Existing fields stay.

```json
{
  "id": "uuid", "versionNumber": 4, "origin": "generated|regenerated|feedback|manual_edit",
  "format": "structured|document",
  "definitionVersion": {"id": "uuid", "versionNumber": 3},
  "promptVersion": {"id": "uuid", "versionNumber": 2},
  "promptSource": "default|own|null",
  "analysisPrompt": {"kind": "default", "definitionVersion": {"id": "uuid", "versionNumber": 3}}
                  | {"kind": "own", "ownVersion": {"id": "uuid", "versionNumber": 2}}
                  | null,
  "body": "VoiceDocument | ProfileBody",
  "excerptSources": {"<contentItemId>": {"kind": "email|attachment|file|note", "itemDate": "YYYY-MM-DD", "sourceLabels": ["string"]} | null},
  "languages": [], "createdAt": "iso"
}
```

- `body` is a `VoiceDocument` (contracts/analysis-prompt.md) when `format = 'document'`, otherwise the 001 `ProfileBody`.
- `promptSource` and `analysisPrompt` are `null` for legacy structured versions.
- `excerptSources` maps each `contentItemId` in the body to its source facts. A value of `null` means the item was deleted. The UI links live ones to `/content?item={id}`.
- `GET /api/profiles/{id}` returns the latest version in the same shape.
- Errors: unchanged (404 for foreign or unknown).

### `POST /api/profiles/{id}/document` (new)

Direct edit of the latest document (FR-020). Creates a new version with `origin = 'manual_edit'`.

- Body:
  ```json
  {"baseVersionId": "uuid",
   "summary": "string",
   "sections": [{"heading": "string", "markdown": "string"}],
   "doList": ["string"],
   "dontList": ["string"],
   "keepExcerpts": [0, 2, 3]}
  ```
  - `sections`: 1 to 20; `heading` up to 120 chars, non-empty; `markdown` up to 4,000 chars.
  - `summary`: non-empty, up to 1,200 chars.
  - `doList`, `dontList`: 1 to 10 items each, up to 200 chars.
  - `keepExcerpts`: indexes into the base version's excerpts, at least 1. Excerpts can be removed but not edited.
- Response 201: `{version: {id, versionNumber, origin: "manual_edit", createdAt}}`.
- Errors:
  - 401, 403, 404 `not_found`.
  - 409 `conflict` when `baseVersionId` is not the latest version (stale), or the latest version is a legacy `structured` one.
  - 422 `validation_failed` (limits and minimums above; `details.field`).
  - 422 `sensitive_content` with `details: {fields: ["summary", "sections[1].markdown", ...]}` when any text field has an exclusion or a redaction. Nothing is stored. Heading and markdown are inspected; no other content check is made.
- The version keeps `prompt_source` and `own_prompt_version_id` of the base. Audit: `profile.document_edited`.

### `POST /api/profiles/{id}/adjust` (changed)

- Still works for a latest `structured` version.
- If the latest version is a `document`: 409 `conflict`. Use `/document`.

### `POST /api/profiles/generate`, `POST /api/profiles/{id}/regenerate`, `POST /api/profiles/{id}/feedback` (behaviour)

Request and response shapes are unchanged. What changes:

- The generation row pins `definitionVersionId` (the active version), the wrapper `promptVersionId` and `ownPromptVersionId` (the current own version if `in_use`, else null) at request time, in the same transaction that locks the own prompt row (FR-019).
- A feedback generation on a legacy structured profile produces a `document` (FR-024).
- Possible `errorCode` values on `GET /api/profile-generations/{id}`: `invalid_output`, `analysis_prompt_excluded`, `analysis_prompt_missing`, `inspection_failed`, `output_excluded`, `feedback_excluded`, `llm_refused`, plus the 001 codes.
- Existing errors, rate limits and guards are unchanged.

### `GET /api/drafts/{id}` (unchanged shape)

Drafts keep `profileVersionId` and `promptVersionId`. Drafting reads either format (D8 in the plan).

## Admin - changes

All routes below require `requireAdmin()`.

### Definitions

- `GET /api/admin/definitions`: each item adds `ownPromptCount` (number of users with an own prompt in use for this definition). Count only.
- `POST /api/admin/definitions` with `{key, name, description, analysisPrompt}` (replaces `dimensions`). The v1 draft is created with `dimensions = []`.
- `GET /api/admin/definitions/{id}`: each version adds `analysisPrompt` (string|null). `dimensions` stays in the response as read-only legacy data.
- `PATCH /api/admin/definitions/{id}/versions/{versionId}` accepts `{name?, description?, analysisPrompt?}`. Draft only (`version_not_draft`).
- `POST /api/admin/definitions/{id}/versions` with `{fromVersionId?}`: the new draft copies `analysisPrompt` and `dimensions` from its source.
- `dimensions` in a create or patch body: 422 `validation_failed` with `details.field = "dimensions"`.
- `analysisPrompt` over 20,000 characters on save: 422 `validation_failed` with `details: {field: "analysisPrompt", reason: "too_long", maxChars: 20000}`.
- `POST /api/admin/definitions/{id}/versions/{versionId}/publish`: also 422 `validation_failed` with `details: {field: "analysisPrompt", reason: "empty" | "too_long"}` when the trimmed text is empty or over the limit.
- `POST /api/admin/definitions/{id}/rollback` with `{versionId}`: same validation as publish applies to the target version.
- Publish and rollback response is unchanged. Side effect: notifications to users with an own prompt (contracts/notifications.md).
- `GET /api/admin/definitions/{id}/versions/{versionId}/diff?against={versionId}`: the diff gains an `analysisPrompt` entry next to `name` and `description`.
- Admin response schemas allow `analysisPrompt` and `ownPromptCount`. The forbidden keys list adds `promptText` and `sections`.

### Preview (FR-004)

#### `POST /api/admin/definitions/{id}/versions/{versionId}/preview`

Render only. No model call. Uses the guard, the active wrapper templates and the static fixture. Never user data.

- Body: `{"kind"?: "generate" | "feedback"}` (default `generate`).
- Response 200: `{"system": "string", "user": "string"}`. Contains the guard, the wrapper text with `analysisPrompt` from this version, the fixture samples and the reminder.
- Errors: 403 `admin_required`, 404 `not_found`.
- Rate limit: existing admin limiter, 429 `rate_limited`.

#### `POST /api/admin/definitions/{id}/versions/{versionId}/preview-run`

Starts a real model run on built-in synthetic samples only. Works on draft, active and superseded versions. Writes nothing to the database.

- Body: none.
- Response 202: `{"jobId": "preview-{uuid}"}`.
- Errors: 403, 404, 429 `rate_limited`.
- Queue: `profile`, job `analysis.preview` (contracts/jobs.md).

#### `GET /api/admin/definitions/{id}/versions/{versionId}/preview-run/{jobId}`

- Response 200:
  ```json
  {"status": "queued|running|done|failed",
   "markdown": "string|null",
   "problems": ["aspect_missing:tone"]}
  ```
  `markdown` is the document rendered as Markdown (`documentToMarkdown`). It is set when `status = done`. `problems` holds post-validation codes and is empty on success. When `failed`, `markdown` is `null` and `problems` has the codes (for example `invalid_output`).
- The key is `markdown`, not `body`, `text` or `excerpts`, so the admin isolation validator passes.
- Errors: 403, 404 `not_found` (unknown job or job of another version).
- The result expires with the job (24 h).

### Prompts

- `POST /api/admin/prompts/{id}/rollback` and publish now run publish-mode template validation. A target version that uses a removed variable returns 422 `unknown_template_variable` with `details.unknownVariables`. This blocks reactivating the dimension-based v1 of `tone_profile.generate` and `tone_profile.feedback`.
- `POST /api/admin/prompts/{id}/versions/{versionId}/validate` and `.../preview` for these two keys use the new whitelist and fixture (contracts/analysis-prompt.md). The fixture now has `analysisPrompt` and `previousDocumentJson` instead of the dimension fields.
- No route reads own prompts or document bodies.

## Unchanged routes that matter

- `GET /api/definitions`, `PUT /api/definition-choices`: unchanged. Dimensions are no longer part of the user-facing description.
- `DELETE /api/profiles/{id}`, `DELETE /api/content-items/{id}`, sources and account deletion: unchanged in shape. Deleting a source or an item now also scrubs excerpts from document versions (contracts/jobs.md).
- `POST /api/account/delete`: own prompts, their versions and documents are removed by foreign key cascade.

## FR to endpoint table

| FR | Endpoints |
|----|-----------|
| FR-001..003 | `/api/admin/definitions/**` (`analysisPrompt`) |
| FR-004 | `.../preview`, `.../preview-run`, `.../preview-run/{jobId}` |
| FR-005 | `GET /api/admin/definitions` (`ownPromptCount`) |
| FR-006, FR-007 | `POST .../customise`, `PUT /api/analysis-prompts/{definitionId}`, `GET .../versions`, `GET .../versions/{versionId}` |
| FR-008 | `GET .../compare`, `POST .../reset` |
| FR-011 | `PUT /api/analysis-prompts/{definitionId}` (422) |
| FR-012..014 | notifications, `GET .../default-changes`, `POST .../reset` |
| FR-015, FR-016, FR-018 | `GET /api/profiles/{id}/versions/{versionId}` |
| FR-019 | `POST /api/profiles/generate`, `/regenerate`, `/feedback` |
| FR-020 | `POST /api/profiles/{id}/document`, `/feedback`, `/regenerate` |
| FR-021 | `GET /api/profile-generations/{id}` (`errorCode`) |
| FR-022 | `POST /api/drafts` |
| FR-024 | `GET /api/profiles/{id}/versions/{versionId}` (`format`), `POST /api/profiles/{id}/adjust` (409 on documents) |
