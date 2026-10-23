# Contract: Hub search (blind token index)

New contract for 003. It defines how keyword search over encrypted hub content works (FR-011, SC-003). The route is in contracts/http-api.md. Code lives in `packages/core/src/hub/search-tokens.ts` and `packages/core/src/services/hub/search.ts`.

## Principle

Content columns stay encrypted (Principle VII). The database holds only truncated keyed hashes of tokens. There is no plaintext full-text search, no decrypt-everything scan and no memory-store search.

## Index: `hub_search_doc`

One row per `(user_id, item_type, item_id)`: `item_type` (`person|company|project|note|file`), `item_id`, `owner_kind`, `owner_id` (for notes and files), `tokens char(16)[]` with a GIN index, `updated_at`. Unique on `(user_id, item_type, item_id)`.

- Index writes happen in the same transaction as the domain write. A delete removes the row in that transaction. Deleting a record removes the rows of its notes and files.
- Text per item type:

| Type | Indexed text |
|---|---|
| person | name, role or title, email addresses, phone |
| company | name, domains, website, industry |
| project | name, status word |
| note | title and plain text of the body |
| file | name, description, and the first 90,000 chars of filtered extracted text |

- Descriptions of records are indexed with the record. All text is the already filtered text that is stored.
- A file that is `excluded`, `unsupported`, `failed` or `empty` is indexed by name and description only.

## Tokenisation

1. Lower-case the text.
2. Split with `/[\p{L}\p{N}]+/gu`. Keep tokens up to 32 chars (longer tokens are cut to 32).
3. For each token `t`, emit every prefix of length 2 to `min(len, 15)`. If `len > 15`, also emit the full token (cut to 32).
4. Hash each emitted string: `hmacHex('hubsearch:{userId}:' + s)` using `DEDUP_HMAC_KEY`, first 16 hex chars.
5. Deduplicate and store the set in `tokens`.

- Accents are not folded in v1. Matching is by word and word prefix only.
- The user id in the HMAC input means the same word hashes differently per user. No cross-user correlation is possible.

## Query

1. Tokenise `q` with the same split. At most 32 tokens. Tokens shorter than 2 chars are ignored. If no token remains, return an empty list.
2. For each query token, hash the prefix form: the token cut to 15 chars (a token of 16 or more chars is matched on its first 15).
3. Candidate query, one statement:

```sql
SELECT item_type, item_id, owner_kind, owner_id, updated_at
FROM hub_search_doc
WHERE user_id = $1 AND tokens @> $2          -- all query tokens (AND)
  AND ($3::text[] IS NULL OR item_type = ANY($3))
ORDER BY updated_at DESC
LIMIT 200
```

4. The service loads and decrypts the candidates (batched), then verifies each one: every query token must be a prefix of at least one real token of the decrypted indexed text. Candidates that fail are hash collisions and are dropped.
5. Rank, in this order:
   1. a query token matches a word in the title or name (records: name; notes: title; files: name);
   2. number of query tokens that match in the title or name;
   3. `updated_at`, newest first.
6. Page: default 20, max 100. The cursor is an opaque offset into the verified, ranked candidate list (at most 200 candidates, so at most 200 results).

- The user-supplied `types` filter limits `item_type`.
- A user who has more than 200 candidates for a very common prefix sees the 200 most recently changed. Adding words narrows it.

## Results and snippets

- Each result: type, id, title, owner record (id, kind and name for notes and files), snippets, `updatedAt`.
- Snippets: up to 2 fragments of about 20 words each, taken around the first matches in the body, description or extracted text. A record without body text returns the matching field values.
- Highlights are `[[start, end]]` offsets into the fragment text (UTF-16 code units). The server sends no HTML. The client renders `<mark>`.
- Snippet text is already filtered content from the user's own hub. It is returned only to the owner.

## Performance

- p95 under 2 s at 10,000 items including file text (SC-003). The GIN `@>` lookup is the only scan. Decryption is limited to at most 200 candidates.

## Leakage (documented trade-off)

- Someone with database access but no `DEDUP_HMAC_KEY` sees, per user, how many distinct token hashes each item has and which items share hashes. That reveals token-frequency patterns and document lengths, not words.
- Someone who also holds `DEDUP_HMAC_KEY` can run a dictionary attack against the hashes. This is the same trust level as the existing `sender_hash` and `message_id_hash`.
- Hashes are truncated to 16 hex chars (64 bits), so collisions exist and the verify step in the query handles them.
- Rotating `DEDUP_HMAC_KEY` needs a full reindex. A reindex job is out of scope for v1.
- Admins have no route to the index. Isolation tests seed sentinel words and assert that no admin route returns them or their hashes.

## Tests

- Tokeniser: prefixes, 15-char cut, long tokens, Polish letters, digits, punctuation.
- Query: AND semantics, prefix match, no-token queries, collision drop (a forced collision fixture), type filter, 200-candidate cap.
- Ranking: title hit before body hit, more matched terms first, then newest first.
- Snippets: two fragments at most, highlight offsets, no HTML in output.
- Index writes: create, edit, rename, delete, owner delete, merge and file text arrival all update the row in the same transaction.
- Performance: seeded 10,000 items, p95 under 2 s.
