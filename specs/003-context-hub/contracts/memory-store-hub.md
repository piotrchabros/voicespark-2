# Contract: Memory store documents for the hub (delta against 001 `supermemory.md`)

This file is a delta against `specs/001-personal-brand-voice/contracts/supermemory.md`. The port interface, the v3 adapter, the custom id scheme `{ns}__{id}`, GET-before-write, `MemoryStoreBusyError`, metadata merge and error handling are unchanged. This file adds the hub document kinds, their ids, metadata, content templates, the sync outbox and the deletion rules.

## Namespace and ids

- Namespace is the user's existing `vs_user_{userId}` (44 chars). No second namespace. Account deletion (`deleteNamespace` plus verify) already covers hub documents.
- Document ids (before the `{ns}__` prefix):

| Kind | Id |
|---|---|
| person | `hub_person_{uuid}` |
| company | `hub_company_{uuid}` |
| project | `hub_project_{uuid}` |
| note | `hub_note_{uuid}` |
| file | `hub_file_{uuid}` |
| conversation summary | `hub_summary_{threadUuid}` |

- Longest id is 94 chars with the prefix, under the limit of 100 and the pattern `^[A-Za-z0-9_.:-]{1,100}$`.
- The ids are not UUIDs, so the content-items search (which keeps only UUID ids) ignores them. Profile sampling filters `vs_authorship = authored`, and hub documents have no `vs_authorship`. Source-deletion sweeps use `vs_source_ids`, and hub documents have none.

## Metadata

All keys are prefixed `vs_`. The full set is sent on every write, because `PATCH` merges per key and replaces arrays whole. New keys are added to `META` in `packages/integrations/src/supermemory/port.ts`.

| Key | Value | Present on |
|---|---|---|
| `vs_kind` | `hub_person`, `hub_company`, `hub_project`, `hub_note`, `hub_file`, `hub_summary` | all |
| `vs_hub_item_id` | uuid of the item (thread uuid for summaries) | all |
| `vs_hub_owner_kind` | `person`, `company` or `project` | notes, files |
| `vs_hub_owner_id` | uuid of the owning record | notes, files |
| `vs_hub_linked_keys` | string array `person:{uuid}`, `company:{uuid}`, `project:{uuid}` (records linked to or attached to the item) | all |
| `vs_item_ts` | last change as epoch ms (summaries: last message date) | all |
| `vs_hub_version` | outbox `version` that produced the document | all |
| `vs_lang` | `pl`, `en` or `other` | summaries |
| `vs_hub_email_hashes` | string array of per-user HMACs of addresses | person |
| `vs_hub_domain_hashes` | string array of per-user HMACs of domains | company |
| `vs_filter_policy_version` | filter preferences version used for the build | all |

- No names, addresses, domains, phones or message text appear in metadata. This keeps raw email addresses out of metadata.
- Hub documents never carry `vs_authorship`, `vs_source_ids`, `vs_content_item_id`, `vs_parent_item_id`, `vs_sender_hash` or `vs_folders`.

## Content shape

All content comes from `buildHubDocument(kind, parts)` in `packages/filters` (see contracts/filter-hub-mode.md). It takes `FilteredText` fields and `ContactValue[]` only. A `HubLlmText` value or a plain string is a compile error. Documents are Markdown.

### Person, company, project

```
# Person: {name}
Type: person
Role: {roleTitle}
Email: {a@b.c, ...}        <- only when the contact rule allows (below)
Phone: {phone}             <- only when the contact rule allows
Companies: {Name (role), ...}
Projects: {Name (role), ...}

## Description
{description}
```

- Company: `# Company: {name}`, `Website`, `Industry`, `Domains` (always included), `People`, `Projects`.
- Project: `# Project: {name}`, `Status`, `Start`, `End`, `People`, `Companies`.
- Empty fields are omitted. Linked names come from the hub as filtered text. Lists are capped at 20 entries.

### Note

```
# Note: {title}
Belongs to: {kind} {name}
Linked: {names}
Created: {iso}  Updated: {iso}
---
{note as Markdown}
```

The Markdown comes from our own ProseMirror walker (tasks render as `- [ ]` and `- [x]`), applied to the already filtered note.

### File

```
# File: {name}
Type: {extension}, {size}
Belongs to: {kind} {name}
Description: {description}
Text: {extracted | empty | not searchable ({reason}) | excluded}
---
{filtered extracted text}      <- only when extraction status is extracted
```

The original binary is never sent. Extracted text is capped at 1,000,000 chars stored. The document body may be cut to what the store accepts, in which case the line `[truncated]` ends it.

### Conversation summary

```
# Conversation: {subject}
Dates: {first} to {last}  Messages: {n}
Participants: {names; addresses only when the contact rule allows; the owner is shown as "me"}
Related: {records}
Attachments: {names}
---
{summary}
```

Never message text. Subject, participants and summary pass the user's full policy before they are used.

## Contact-value rule (FR-028, spec owner decision 2026-10-23)

- Contact values (email addresses, phone numbers) are written into memory documents only when the user's policy does not select `third_party_contacts`. This is decided at build time from the current policy.
- When the category is selected, contact lines are left out and the other content stays.
- Domains of companies are included either way.
- The hub-mode exception of the filter applies only to VoiceSpark's own record fields and the AI extraction call. The memory store is "everywhere else".
- A change of `filter_preferences` triggers `hub.refilter` and marks every item dirty, so the rule is re-applied (contracts/jobs.md, job 15).

## Outbox: `hub_sync_item`

One row per synced entity: `entity_type` (`person|company|project|note|file|summary`), `entity_id` (no foreign key, so it outlives deleted rows), `doc_id` (unique, as in the table above), `version`, `synced_version` (never above `version`), `deleted`, `status` (`pending|stored|failed`), `attempts`, `next_attempt_at`, `last_error_code`, `last_synced_at`.

- `markDirty` runs in the same transaction as the domain write: `version + 1`, `status = pending`, `next_attempt_at = now() + 2 s`, and ensures a `hub.sync` job for the user (jobId `hubsync-{userId}`, delay 2 s).
- Fan-out (which rows become dirty):

| Change | Marked dirty |
|---|---|
| Edit of a record's content fields | the record |
| Rename of a record | the record, its notes and files, every linked record, and summaries attached to it |
| Link created, changed or deleted | both records, their notes and files, and summaries attached to either |
| Note or file created, edited, renamed | the item and its owner record |
| New or updated conversation summary | the summary and every attached record |
| Merge | the kept record tree (record, notes and files, linked records, summaries); the merged-away record is tombstoned |
| Record deleted | the record, its notes and files are tombstoned (`deleted = true`); linked records and their trees are marked dirty |
| Note or file deleted | tombstone plus the owner record |
| Filter preference change | everything (via `hub.refilter`) |

- A tombstone keeps the row until the document delete is confirmed. A row for a deleted entity whose document never existed completes at once.

## Worker rules (job `hub.sync`)

- Claim due rows with `FOR UPDATE SKIP LOCKED`, batches of 10, 120 s lease.
- Rebuild the document from current Postgres state each time (re-decrypt, then `buildHubDocument` under the current policy). Never use a copy from an earlier run.
- Write with `addDocuments` or remove with `deleteDocuments`. A not-found on delete counts as success.
- After the write, set `synced_version = V` and `status = stored` only if `version` is still `V`. If it changed, leave the row `pending` for the next pass.
- Failures: `status = failed` from the first failure, `last_error_code` set (for example `supermemory_http_500`, `supermemory_network`, `memory_store_auth`). Backoff `min(5 s * 2^(n-1), 15 min)` plus or minus 20%, no maximum attempts. `MemoryStoreBusyError` retries in 10 s without counting.
- Content is never lost on failure: Postgres is the source of truth and the next success sends the current state.
- Partial batch failures leave earlier documents in place. This is the same known gap as in 001; the next run replaces them.

## Status and "stored" (SC-010)

- Status shown to the user: `stored` (accepted by the store), `pending` (waiting or in retry with no error yet), `failed` (an attempt failed and is retrying).
- "Stored" means the write was accepted by the store (the adapter call returned). Remote indexing on the v3 server takes 32 to 60 s or longer for large documents. It is not awaited and not shown.
- Target: 99% of saved items are `stored` within 1 minute while the store is available.
- `POST /api/hub/sync/retry` and `POST /api/hub/sync/resync` are in contracts/http-api.md. Resync back-fills missing rows with `ON CONFLICT DO NOTHING`, then bumps `version`, resets `attempts` and sets `pending` on every non-deleted row. It never deletes the namespace.

## Deletion

- **Single record, note or file**: row delete plus tombstone, handled by the outbox. Synchronous at the API, asynchronous at the store.
- **Mailbox data (`hub_source` scope)**: the purge job deletes the affected documents itself and verifies with `getDocument == null` (contracts/jobs.md, job 6). It does not rely on the outbox.
- **Account**: `deleteNamespace` plus verify, as in 001. Then the hub blob directory is removed (contracts/jobs.md, job 6).
- Summary documents of merged threads are tombstoned when the younger thread is merged into the older one.

## Existing scanners (changes)

- `retroscan` (`listAll`) and `credential-audit` (`sampleIds`) scan the whole namespace today. Both skip ids that start with `hub_` in their normal pass.
- When credential-audit finds a locked-category hit in a hub document, it does not purge the document. It marks that sync item and its source row for `hub.refilter`, which rebuilds the content under the policy.
- Draft memory `search()` may return hub documents. They are filtered text, so this is allowed and documented. The draft pipeline inspects the snippets as before.
- The e2e memory helper (`apps/web/e2e/support/memory.ts`) tolerates `hub_` ids.

## Test safety

Tests use `InMemoryMemoryStore` or the fake v3 server (`packages/integrations/test/helpers/fake-supermemory-v3.ts`). Tests never write to `supermemory.voicespark.ai` or `127.0.0.1:6770`.
