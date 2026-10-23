# Contract: Notifications (delta against 001)

Adds one notification type and one new use of an existing one. Everything else in 001 stays (storage in `notification`, `notify()`, payloads with ids, enums and counts only, `POST /api/notifications/{id}/read`).

## New type: `analysis_prompt_default_changed`

Tells a user with an own analysis prompt that the admin default changed.

| Item | Value |
|---|---|
| Type | `analysis_prompt_default_changed` |
| Recipients | Users with an `own_analysis_prompt` row for the definition where `in_use = true` |
| Not sent to | Users with no own prompt, users whose own prompt was reset (`in_use = false`), suspended or deleted users |
| Delivery | In-app only. Not in `EMAILED_NOTIFICATION_TYPES`, so no email is sent |
| Dedup | None. One notification per publish or rollback that changes the text |

### Payload

Ids only. No prompt text, no names, no diff.

```json
{
  "definitionId": "uuid",
  "ownPromptId": "uuid",
  "fromDefinitionVersionId": "uuid",
  "toDefinitionVersionId": "uuid"
}
```

- `fromDefinitionVersionId` is the definition version the user's current own prompt version is based on (`based_on_definition_version_id`). It is not the previously active version.
- `toDefinitionVersionId` is the newly active definition version.

### Trigger

- Fired inside `definitions.activate()`, in the same transaction, for both publish and rollback.
- Compare the trimmed `analysis_prompt` of the target version with that of the previously active version. If they are equal, nobody is notified. Changes to name, description or legacy dimensions alone do not notify.
- Select `own_analysis_prompt` rows with this `definition_id` and `in_use = true` through `packages/db/src/repos/system/own-prompts.ts`. The query returns metadata only and never the prompt text.
- Call `notify(userId, 'analysis_prompt_default_changed', payload)` for each row.
- Target: all notifications created within 1 minute of publish for 1,000 users (SC-005). Fan-out is inline. A fan-out job is the scale path if this is exceeded.

### Audit link

The audit entries `definition.version_published` and `definition.rolled_back` get metadata `{analysisPromptChanged: boolean, notifiedUsers: number}`. Counts only.

### UI

- `describe()` in `apps/web/app/(user)/notifications/page.tsx` gets a case for the type. Text is generic, for example "The default analysis prompt for {definition name} changed." The definition name is looked up for the owner at display time.
- Link target: `/profiles/{profileId}/analysis-prompt?from={fromDefinitionVersionId}&to={toDefinitionVersionId}`. `profileId` is resolved from `definitionId` for the owner. If the profile is gone, the link goes to `/profiles`.
- The page shows the default-changes diff (`GET /api/analysis-prompts/{definitionId}/default-changes`) and a "Use the default" button that calls `POST /api/analysis-prompts/{definitionId}/reset` (FR-013).
- A banner with the same link is shown on the profile page while the own prompt's `based_on` version is older than the active default (`defaultChangedSinceBase`).

### Schema changes

- Add the value to `NOTIFICATION_TYPES` in `packages/db/src/schema/notifications.ts`.
- Migration `0007_analysis_prompts.sql` replaces `notification_type_check` with the new list.

## Changed use: `profile_outdated`

- Type and payload are unchanged (`{profileId}` and ids as before).
- New cause: when a deleted source removed an excerpt from the latest version, `scrubDeletedExcerpts` sets `outdated_reason = 'sources_deleted'` and sends `profile_outdated`. The user can regenerate. Earlier versions are scrubbed without a notification.

## Changed use: `generation_failed`

- Payload is unchanged: ids and `errorCode`.
- New error codes in the payload: `invalid_output`, `analysis_prompt_excluded`, `analysis_prompt_missing`, `inspection_failed`, `output_excluded`, `feedback_excluded`, `llm_refused` (see contracts/analysis-prompt.md). The page maps each to a short generic message. It shows no content.
- `analysis_prompt_excluded` tells the user to edit their own prompt or use the default.

## Unchanged

- `profile_ready`, `draft_ready`, `draft_failed`, `import_completed`, `deletion_completed`, `source_needs_reconnection`.
- Email: only `source_needs_reconnection`, `deletion_completed`, `import_completed`.
