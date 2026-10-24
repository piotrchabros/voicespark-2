# Hub extraction eval set

Labelled synthetic email conversations for the Context Hub extraction eval (spec 003, research R14; SC-004 to SC-006). Every person, company, address and domain is invented: company domains end in `.example`, the owner is Marek Wiśniewski (`owner@example.com`, Gmail; the cross-mailbox files add `owner@outlook.com`, Microsoft), and free-mail senders use consumer domains from `FREE_MAIL_DOMAINS` because the pipeline treats those by name. No real mail, no real people.

The port script, the runner (T150) and the vitest check all go through `format.ts` (`loadConversations`, `evalConversationSchema`, `disallowedDomains`, `buildMime`).

## Files

| Path                              | Content                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversations/{pl,en,x}-NN.json` | 53 conversations ported from the reference app's set with `port-reference-set.ts` (`set: "reference"`): 25 Polish, 26 English, 2 cross-mailbox (`x-*`: the same message as a thread of each owner mailbox, so a run sees it twice and must store one conversation and one person). The reference figure of 100% on this set is in-sample and is not evidence for the success criteria. |
| `conversations/holdout-NN.json`   | 20 held-out conversations (`set: "holdout"`), authored and labelled before any model output was read. Reported on their own line by the runner.                                                                                                                                                                                                                                        |
| `format.ts`                       | File format (zod schema and types), loader, the synthetic-domain rule and the MIME builder.                                                                                                                                                                                                                                                                                            |
| `port-reference-set.ts`           | One-off port of the reference set (below).                                                                                                                                                                                                                                                                                                                                             |
| `recorded/{id}.json`              | Recorded extraction outputs written by `run.ts --record` (T151); the default replay input of the runner.                                                                                                                                                                                                                                                                               |

## Conversation format

```jsonc
{
  "id": "en-01",                       // file stem; pl-NN, en-NN, x-NN or holdout-NN
  "set": "reference" | "holdout",
  "language": "pl" | "en" | "mixed",
  "categories": ["named-project", "signature-ltd"],
  "mailboxes": [{ "address": "owner@example.com", "provider": "gmail" }],   // every owner mailbox the file uses
  "threads": [
    {
      "ref": "thr-en-01",              // provider thread id; unique in the file
      "mailbox": "owner@example.com",  // entry of `mailboxes` that holds this thread
      "subject": "Project Beacon - kickoff next week",
      "messages": [
        {
          "ref": "thr-en-01/1",        // provider ref the runner records the message under
          "direction": "inbound",      // outbound = sent by the owner
          "folders": ["INBOX"],        // labels as the fetcher reports them (INBOX, SENT, CATEGORY_PROMOTIONS, ...)
          "raw": "Message-ID: <en-01@harbourline.example>\r\nDate: ...\r\n\r\nHi Marek, ..."
        }
      ]
    }
  ],
  "seed": { "people": [...], "companies": [...], "projects": [...] },   // optional
  "expected": { "people": [...], "companies": [...], "projects": [...], "links": [...],
                "automated": false, "suggestions": [...], "summaryMentions": [...] }
}
```

- `raw` is the complete RFC 5322 message with CRLF line endings, 8bit UTF-8 headers and bodies (like `test/fixtures/hub/*.eml`), optional `In-Reply-To`/`References`, the whitelisted automation headers (`List-Unsubscribe`, `List-Id`, `Precedence`, `Auto-Submitted`, `X-Auto-Response-Suppress`, `Return-Path`, ESP headers), `multipart/alternative` when a message has HTML, and a small `application/octet-stream` part per attachment name. It is what `parseMessage` of `@voicespark/integrations/mime` gets.
- The runner loads a file by creating one hub-enabled source per `mailboxes` entry (its `provider` is the `source_type`), recording every message through `recordMessage({ sourceId, providerRef: message.ref, folders, parsed, direction })`, and running `hub.thread` for the resulting threads. Two threads with the same `Message-ID` in two mailboxes (the `x-*` and cross-mailbox held-out files) must end as one `hub_thread` with two `hub_message_source` rows (FR-020).
- `provider` is `gmail`, `microsoft` or `imap`.

### `seed`: records that exist before the thread runs

| Field         | Shape                                                       | Notes                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `people[]`    | `{ email, name, roleTitle?, phone?, roleSource?: "owner" }` | `roleSource: "owner"` means the owner typed the role (`owner_fields` contains `roleTitle`), so a signature that states another title must become a conflict suggestion and `expected.people[].roleTitle` keeps the seeded value |
| `companies[]` | `{ name, domain? }`                                         |                                                                                                                                                                                                                                 |
| `projects[]`  | `{ name, companyDomains? }`                                 | `companyDomains` links the project to seeded companies                                                                                                                                                                          |

Seeds are per file (each file runs against its own empty database plus its seed) and never repeat an entity that another file seeds.

### `expected`: labels

| Field               | Shape                                                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `people[]`          | `{ email, name, roleTitle?, companyDomain? }`           | every person the thread should produce or match, keyed by the address they wrote from; `roleTitle` is the value the record should end with (the owner-typed one on an owner conflict); `companyDomain` refers to an entry of `companies` (or a seeded company)                                                                                                                                                                                                                                                                                                     |
| `companies[]`       | `{ domain, name? }` or `{ name }`                       | companies the thread should produce or match; a free-mail or tenant domain is never a company; a role address (`sales@`, `sekretariat@`, ...) yields the company but no person, even when a named agent signs                                                                                                                                                                                                                                                                                                                                                      |
| `projects[]`        | `{ name }`                                              | explicitly named projects only; generic wording ("the project", "wdrożenie", "the proposal") yields none unless the project is seeded                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `links[]`           | `{ kind, a, b, role? }`                                 | `kind` is `person_company`, `person_project` or `company_project`; `a`/`b` reference people by email, companies by domain and projects by name; `role` when the thread states it (on owner-conflict files it is the owner-typed title and is documentation only: the policy queues the signature role as a conflict, so no `link_role` is applied)                                                                                                                                                                                                                 |
| `automated`         | `boolean`                                               | the thread must be skipped as `automated` (header rules, `classifyAutomated`) or `automated_llm` (triage); every other label is then empty and the sender must not become a person                                                                                                                                                                                                                                                                                                                                                                                 |
| `suggestions[]`     | `{ type, reason, person?, address?, field?, project? }` | findings the policy must queue (state `suggested`) rather than apply or drop. `person_email` + `name_only_match`: `person` (seeded, by email) gets `address` attached only as a suggestion. `person` + `low_confidence`: the person at `address` was only addressed and is created only as a suggestion. `field` + `conflict`: the `field` of `person` is owner-set and the thread states a different value. A pending suggestion that names the right record counts as a hit for SC-004 (R14); the list is a required subset, not the full set of queued findings |
| `summaryMentions[]` | `string[]`                                              | substrings the stored summary must contain, compared after `foldText` (diacritics and case folded); Polish entries are stems that survive inflection (`kotłown`, `pełnomocnictw`); empty for automated threads                                                                                                                                                                                                                                                                                                                                                     |

The ported files carry the reference labels unchanged; their `suggestions` were derived from the labels and seeds by `deriveSuggestions` in the port script (4 `name_only_match`, 1 `low_confidence`, 5 `conflict`).

## Categories

Tags per file, so coverage can be counted. Reference set tags: `newsletter`, `notification`, `freemail`, `role-address`, `large-cc`, `generic-project`, `multi-address`, `owner-conflict`, `cross-mailbox`, `two-company-project`, `named-project`, `seeded-person`, `seeded-project`, `quoted-reply`, `outgoing`, `forwarded`, `disclaimer`, `phone-formats`, `signature-*`.

Held-out set (`holdout-01` to `holdout-20`):

| Id  | Language | What it tests                                                                                                   |
| --- | -------- | --------------------------------------------------------------------------------------------------------------- |
| 01  | pl       | newsletter, HTML-only body, Mailgun ESP header                                                                  |
| 02  | en       | bounce: null `Return-Path`, `mailer-daemon@`, `auto-replied`                                                    |
| 03  | pl       | role address `sekretariat@`: company only                                                                       |
| 04  | en       | role address `support@` signed by a named agent: still no person                                                |
| 05  | en       | free-mail independent consultant: person, no company                                                            |
| 06  | pl       | free-mail sender whose signature names the employer and website: company from the signature domain              |
| 07  | pl       | multi-address: seeded person writes from a sister company's domain (`name_only_match`)                          |
| 08  | en       | multi-address through a personal `outlook.com` address (`name_only_match`)                                      |
| 09  | pl       | generic project words only (`projekt`, `wdrożenie`, `oferta`)                                                   |
| 10  | en       | generic words (`the proposal`, `the implementation`), quoted owner reply                                        |
| 11  | pl       | owner-set role vs. a different signature title (`conflict`)                                                     |
| 12  | en       | owner-set role vs. a different signature title (`conflict`)                                                     |
| 13  | mixed    | two-company project `Sokół`, Polish client and Italian supplier, owner reply in both languages                  |
| 14  | en       | 25 CC recipients; project `Tideline` shares its name with the company                                           |
| 15  | mixed    | seeded project `Granit` named explicitly; owner-set role restated by the signature (no conflict)                |
| 16  | pl       | owner writes first to one new contact, who replies with a sole-trader signature                                 |
| 17  | en       | owner writes to two new people, nobody replies: names from the `To` header only                                 |
| 18  | pl       | notification recognised by the sender pattern alone (`nie-odpowiadaj@`)                                         |
| 19  | en       | cross-mailbox duplicate under the Gmail and the Microsoft mailbox                                               |
| 20  | en       | sender on a `*.onmicrosoft.com` tenant domain, `multipart/alternative`; company only from the signature website |

## Porting the reference set

```
pnpm --filter @voicespark/worker exec tsx eval/hub/port-reference-set.ts --from /path/to/reference/eval/conversations
```

Run once; the output under `conversations/` is committed. The script builds `raw` from the `FetchedMessage` fields, maps `labels` to `folders` and `SENT` (or an owner `From`) to `direction: "outbound"`, maps providers `google` to `gmail` and `microsoft` to `microsoft`, carries over `seed`, `expected` and `summaryMentions`, honours the per-thread `mailbox`/`provider` override of the `x-*` files, derives `expected.suggestions`, and exits 1 if any domain in the headers, bodies, labels or seeds is not `*.example`, `example.com` or a `FREE_MAIL_DOMAINS` entry.

## Adding a held-out conversation

Write `conversations/holdout-NN.json` in the format above (build `raw` with `buildMime` from `format.ts`), label it before running any model on it, keep to synthetic people and the allowed domains, and run the check:

```
pnpm --filter @voicespark/worker exec vitest run --project unit test/hub-eval-conversations.test.ts
```

It validates every file against the schema, enforces the domain rule, checks that links and suggestions reference records the file defines, parses every `raw` message, and checks the `automated` label against the header classifier (`classifyAutomated` + `threadIsAutomated`); a label the headers do not justify must be reachable through triage (one non-owner sender, no owner message).

## Scoring (runner, T150)

Grader rules of research R14: pending policy-correct suggestions count as hits for SC-004; project names match when normalised-equal or by whole-word containment ("Atlas" and "Atlas migration", "Orkiestra" and "Wdrożenie Orkiestra"). Thresholds: SC-004 people >= 95%, person-company links >= 90%, project names and links >= 80%; SC-005 duplicate people <= 2%, automated senders as people = 0; SC-006 at most 1 in 5 findings queued, auto-applied correct >= 90%. The in-sample set and the held-out subset are printed on separate lines.
