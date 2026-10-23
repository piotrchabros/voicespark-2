# Contract: Supermemory port (`@voicespark/integrations/supermemory`)

Supermemory v5 (namespaces) or the self-hosted v3 server (see "v3 adapter (self-hosted)" below). SDK: npm `supermemory`. Names below follow the canonical glossary.

## Port interface

- `addDocuments(ns, docs: MemoryDoc[]): Promise<{id, status}[]>`
- `getDocument(ns, id): Promise<{id, content, metadata} | null>`
- `listDocuments(ns, {filter?, page, limit}): Promise<{documents: {id, metadata}[], hasMore}>`
- `search(ns, {query, limit, filter?}): Promise<{id, content, score}[]>`
- `deleteDocuments(ns, ids: string[]): Promise<{count, errors}>` (chunks of 100 internally)
- `deleteNamespace(ns): Promise<void>`

Implementations: `SupermemoryV3Adapter` (default; plain REST against the self-hosted v3 server), `SupermemoryAdapter` (v5, on the `supermemory` SDK) and `InMemoryMemoryStore` (tests; selected only when `NODE_ENV=test` or `AUTH_TEST_MODE=1`, never in production).

## v3 adapter (self-hosted)

`SupermemoryV3Adapter` talks plain REST to the self-hosted server at `SUPERMEMORY_BASE_URL` (default `https://supermemory.voicespark.ai`) with `Authorization: Bearer <SUPERMEMORY_API_KEY>`. It never uses a loopback address. `SUPERMEMORY_API_VERSION` selects the adapter: `v3` (default) or `v5`. `v5` with the voicespark host is rejected at startup.

### Endpoints

| Port method | v3 endpoint | Notes |
|---|---|---|
| `addDocuments` | `POST /v3/documents` `{content, customId, containerTag, metadata, documentDate}` | Returns `{id, status: "queued"}`. |
| `addDocuments` (existing) | `PATCH /v3/documents/{customId}` | Content replaced, metadata merged per key. |
| `getDocument` | `GET /v3/documents/{customId}` | 404 maps to `null`. |
| `updateDocumentMetadata` | `PATCH /v3/documents/{customId}` `{metadata, containerTag}` | |
| `listDocuments` | `POST /v3/documents/list` `{containerTags, filters, page, limit, sort, order}` | `limit` up to 1100. |
| `search` | `POST /v3/search` `{q, containerTag, limit, onlyMatchingChunks, rerank, rewriteQuery, filters}` | `q` is required (`query` returns 400). `limit` is capped at 100. |
| `deleteDocuments` | `DELETE /v3/documents/{customId}` | One call per id. |
| `deleteNamespace` | `DELETE /v3/container-tags/{tag}` | Needs org owner or admin. |
| `listMemories` | `POST /v4/memories/list` `{containerTags, page, limit}` | Forgotten entries are dropped. |

Filters use `{AND: [...]}` or `{OR: [...]}` with leaves `{key, value, filterType, negate?, numericOperator?}`. Depth is at most 5. A single leaf at the root is wrapped as `{AND: [leaf]}`. `toV3Filter` maps the port operators: `eq`/`neq` to metadata (numbers use `numeric` with `=`), `gt/gte/lt/lte` to `numeric`, `contains` to `string_contains`, `arrayContains` to `array_contains`. The `not` variants set `negate`. Array values are rejected, as in v5.

### Custom id: `{ns}__{id}`

The server looks up `customId` across the whole account, not per container tag, and the account is shared with another app. The adapter therefore stores each document as `customId = {ns}__{id}` and strips the prefix on every read. A prefix mismatch is a hard stop: `listDocuments` throws on any item outside the namespace, `search` skips results without the prefix, and `getDocument` returns `null` when `containerTags` lacks the namespace. The custom id must match `^[A-Za-z0-9_.:-]{1,100}$`.

### Writes: GET before write

The server appends to an existing `customId` on a repeated `POST`, and silently drops writes while a document is processing. So the adapter never posts to an existing id:

1. `GET` the document. A document in another namespace throws.
2. Absent: `POST`. A 429 retries the same `POST`. A 5xx or transport error goes back to step 1, because the first `POST` may have landed.
3. Present with identical content and identical sent metadata: no write.
4. Present and different: wait while it is processing, then `PATCH`. A 404 goes back to step 1. A 409 waits and retries.

Each write step is retried up to 3 times, each restarting at the `GET`.

### Processing wait and `MemoryStoreBusyError`

Statuses `queued`, `extracting`, `chunking`, `embedding` and `indexing` mean the document is processing (30 to 60 seconds for small documents). The adapter polls every `processingPollMs` (default 5 s) for up to `processingWaitMs` (default 15 s). If the document is still processing, it throws `MemoryStoreBusyError` (`code: memory_store_busy`, retryable) without writing. The job retries on its own. `waitUntilProcessed(ns, ids, timeoutMs)` is not on the port; the contract test uses it and it returns the ids still processing.

### Metadata merge

`PATCH` merges metadata per key, and arrays are replaced whole. Callers must pass the full metadata they want, including the complete `vs_source_ids` array.

### Search mapping

One hit per result. `id` is the de-prefixed `documentId`. `content` is the relevant chunks sorted by position and joined with a blank line (all chunks if none is marked relevant). `score` is the result score. Hits are sorted by score, highest first. An empty query returns `[]` without a request. An unknown container tag returns an empty result.

### deleteNamespace fallback chain

1. `DELETE /v3/container-tags/{ns}`. A 2xx, 404 or 403 continues. 401 throws. Anything else throws.
2. Up to `purgeRounds` (default 10) rounds of `listDocuments` (limit 100) then `deleteDocuments`, until the list is empty.
3. Documents left after the last round throw `MemoryStoreBusyError('deleteNamespace')`.

The caller then checks that the namespace is empty. A not-found error counts as empty; every other error is rethrown.

### Errors

- 401: `MemoryStoreAuthError`, after exactly one request.
- 429, 5xx and transport errors (reset, timeout, truncated JSON): retried with back-off `[500, 1000, 2000, 4000]` ms. `Retry-After` is honoured, capped at 30 s. 5xx and transport errors are retried only for idempotent calls. When retries run out, a retryable `MemoryStoreHttpError` is thrown.
- Other 4xx: not retried. `MemoryStoreHttpError` with code `supermemory_http_<status>`; other codes are `supermemory_network`, `supermemory_timeout`, `supermemory_bad_response` and `supermemory_not_found`.
- Messages are at most 300 characters and never include document content or the response `data` echo (a 400 echoes the request).

### Known gap

If `addDocuments` fails part way through a batch, documents already written stay in the namespace as orphans. They are cleaned up by the next delete of the item, source or account. This is out of scope here.

## Upstream API facts (verified, v5)

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

Run against `InMemoryMemoryStore` and `SupermemoryV3Adapter` (on a fake `fetch` server) always. Live runs: v5 when `SUPERMEMORY_API_KEY` is set and `SUPERMEMORY_API_VERSION=v5`; v3 when `SUPERMEMORY_V3_TEST_URL` is set (with `SUPERMEMORY_V3_TEST_KEY`; use a dedicated test key and instance). The live v3 run waits for processing with `waitUntilProcessed` before the search and filter checks.

- namespace isolation
- idempotent re-add
- filter by metadata
- delete verification
- search response shape

## Verify in adapter contract test

- Exact `GET /ns/{namespace}/document/{id}` response shape, in particular which field carries the original document content (`content` vs. processed/summary text) and whether it is returned verbatim. `getDocument` must not be implemented from assumption; the contract test pins the mapping.
- Whether the SDK v5 `searchMode` option accepts the values above on the `/ns/` search path (the values were read from the general search docs, not the namespaced reference).
