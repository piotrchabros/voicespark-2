# Contract: Supermemory port (`@voicespark/integrations/supermemory`)

Supermemory v5 (namespaces). SDK: npm `supermemory`. Names below follow the canonical glossary.

## Port interface

- `addDocuments(ns, docs: MemoryDoc[]): Promise<{id, status}[]>`
- `getDocument(ns, id): Promise<{id, content, metadata} | null>`
- `listDocuments(ns, {filter?, page, limit}): Promise<{documents: {id, metadata}[], hasMore}>`
- `search(ns, {query, limit, filter?}): Promise<{id, content, score}[]>`
- `deleteDocuments(ns, ids: string[]): Promise<{count, errors}>` (chunks of 100 internally)
- `deleteNamespace(ns): Promise<void>`

Implementations: `SupermemoryAdapter` (on the `supermemory` SDK) and `InMemoryMemoryStore` (tests; selected only when `NODE_ENV=test` or `AUTH_TEST_MODE=1`, never in production).

## Upstream API facts (verified)

- Path-scoped endpoints: `POST /ns/{namespace}/document`, `POST /ns/{namespace}/document/batch`, `DELETE /ns/{namespace}/document` (body `{ids: [...]}`, 1-100 ids), `POST /ns/{namespace}/list/{documents|chunks|memories}`, `GET /ns/{namespace}/document/{id}`, `DELETE /ns/{namespace}`.
- SDK: `new Supermemory({apiKey})`, `add(ns, {content, id, metadata})`, `search(ns, {query, filter, limit, searchMode})`, `documents.delete(ns, {ids})`, `list(ns, "documents", {...})`, `namespaces.delete(ns)`.
- v3 `customId` is now `id`. Re-using an `id` merges content into the existing document, which makes writes idempotent.
- Namespace pattern `^[a-zA-Z0-9_:-]+$`, max 100 characters.
- Metadata values: string, number, boolean or string[]. Keys use `a-zA-Z0-9_-.`.
- Filters: `{field, operator, value}` combined with `and`/`or` nodes. Operators: `eq, neq, gt, gte, lt, lte, contains, notContains, arrayContains, arrayNotContains`.
- Deleting a namespace keeps documents shared with other namespaces. VoiceSpark never shares documents across namespaces.
- `searchMode` values: `hybrid` (default), `memories`, `chunks`. The adapter passes `chunks` explicitly so results are document chunks (the profile pipeline needs source text, not extracted memories).
- Search response (verified from docs): `{results: [...], searchTime}`. Each result has `id`, `memory` (memory results) or `chunk` (chunk results), `similarity` (0-1), `metadata` (`{}` when none), `isLatest`, `isInference`, `system{createdAt, updatedAt}`, optional `included`. The adapter maps `chunk ?? memory` -> `content` and `similarity` -> `score`, and branches on which field is present.

## Namespace

`vs_user_{userId}`. Never shared between users. The `SUPERMEMORY_API_KEY` is used only in the worker and in owner-scoped web endpoints (`/api/content-items`). Admin code is banned from importing the port. Base URL from `SUPERMEMORY_BASE_URL` (default `https://api.supermemory.ai`).

## Document

- `id = content_item.id` (UUID string).
- `content` is built only by `buildDocument()` in `@voicespark/filters` from inspected fields: the subject, sender name and address, filename, title and body all pass `inspect()`. It is plain filtered text with a short header:
  - `email` / `attachment`: `Subject: ...\nDate: ...\nDirection: sent|received\nFrom: <display name only if third_party_contacts selected, else name + address>\n\n<body>`
  - `file`: `Title: {filename}`
  - `note`: `Title: {title}`
- `documentDate = item_date`.

## Metadata keys (all prefixed `vs_`)

- `vs_kind` (`content_kind`), `vs_authorship` (`authorship`), `vs_content_item_id`, `vs_parent_item_id?`
- `vs_source_ids` (string[]), `vs_item_ts` (number, epoch seconds)
- `vs_lang?`, `vs_word_count`, `vs_filter_policy_version`
- `vs_part?` (number, for split documents)
- Email only: `vs_folders` (string[]), `vs_sender_hash` (HMAC of the lowercased address, keyed by `DEDUP_HMAC_KEY`), `vs_sender_domain_hash`
- Raw addresses never appear in metadata.

## Write-path invariant

`inspect()` must return `accepted` before any `addDocuments` call. The adapter accepts only a branded `FilteredText` type that only `@voicespark/filters` produces, so the type system enforces constitution Principle I. Header fields are part of the inspected input, so the whole document, header included, is `FilteredText`.

## Delete flows

- Item and exclusion report: `deleteDocuments(ns, [id])`, then verify `getDocument` returns null.
- Source: collect content items whose only remaining occurrence is this source, delete them in chunks, and update `vs_source_ids` on shared documents by re-adding with the same id and new metadata. Verify with `listDocuments(filter: vs_source_ids arrayContains sourceId)`, which must return 0.
- Account: `deleteNamespace(ns)`, then `listDocuments(ns)` must be empty or 404.
- Retroscan purge: as for items.
- Extracted memories: deletion is assumed to cascade from documents. The contract test checks `list(ns, "memories")` after deletion and raises an alert if it is not empty.

## Errors and retries

- 429 or 5xx: exponential back-off with retry.
- 401: fatal, raises an admin alert, no retry.
- Partial `errors` from a delete: the failed ids are retried.

## Contract tests

Run against `InMemoryMemoryStore` always, and against the live API when `SUPERMEMORY_API_KEY` is set:

- namespace isolation
- idempotent re-add
- filter by metadata
- delete verification
- search response shape

## Verify in adapter contract test

- Exact `GET /ns/{namespace}/document/{id}` response shape, in particular which field carries the original document content (`content` vs. processed/summary text) and whether it is returned verbatim. `getDocument` must not be implemented from assumption; the contract test pins the mapping.
- Whether the SDK v5 `searchMode` option accepts the values above on the `/ns/` search path (the values were read from the general search docs, not the namespaced reference).
