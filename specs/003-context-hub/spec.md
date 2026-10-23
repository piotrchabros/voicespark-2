# Feature Specification: Context Hub

**Feature Branch**: `003-context-hub`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Context Hub in VoiceSpark: bring the Entity Context Hub (a single-owner app) into VoiceSpark as a multi-user feature where every user has their own private hub. Entities: people, companies and projects with their fields; create, edit, delete, merge duplicates, warning on similar names. Links person–company, person–project and company–project, at most one per pair, with an optional role label. Notes with formatting and files attached to a record, with text extracted from PDF and Office documents; search across records, notes and files. From email, using VoiceSpark's existing mailbox connections (Gmail, Microsoft, IMAP), Claude recognises people, companies, projects and links; confident findings are applied automatically, uncertain or conflicting ones go to a suggestions queue; user-entered or cleared values are never overwritten and rejected or deleted items are not re-added; automated mail and own and role addresses are skipped; each relevant conversation gets a short summary attached to the records involved, with the source visible; users can ignore a sender or domain. Everything is synchronised to the user's own Supermemory space with visible sync status and retry; the password and sensitive-data filter also covers facts, summaries, notes and files. Tone-of-voice drafts can be written for a specific person, company or project with context from the hub. Admins cannot see hub content. Deleting the account, or a mailbox with its data, removes the related hub data, including from the memory store, within 24 hours. Rebuild on VoiceSpark's stack; do not copy."

## Clarifications

### Session 2026-10-23

- Q: VoiceSpark excludes other people's contact details by default, but the hub needs them for people and companies. How do they fit together? → A: The hub has an exception. Email addresses and phone numbers of people and companies in the hub are allowed in the record fields (the user's own address book). They are still removed from summaries, notes taken from mail and tone-of-voice content according to the user's filter choices. All other categories (passwords, codes, cards, bank accounts, ID numbers, health, special-category data) are always removed as today.
- Q: A file's original bytes cannot be redacted. What happens to a file in which the filter finds excluded content? → A: The text extracted from the file is filtered before it is searched or synced; if all of it is excluded, the file is marked not searchable. The original file is kept encrypted, only its owner can download it, and it is never sent to the AI service or the memory store.
- Q: Do email addresses and phone numbers of hub people go to the memory store? → A: Only when the user has not selected the "other people's contact details" filter. By default the memory store gets names, roles, companies and topics, not contact values.
- Q: Is the hub on by default for connected mailboxes? → A: No. It is off until the user turns it on for a mailbox, and the user is told then that conversation content is sent to the AI service.

## Context

VoiceSpark today (specs 001 and 002) imports a user's mail, notes and files, filters out passwords and sensitive data, stores the result in the user's memory store, builds tone-of-voice documents and writes drafts. The Context Hub adds a second layer on top of the same sources: a private address book of the **people, companies and projects** the user works with, how they relate, what was discussed, and the user's own notes and files about them.

The hub reuses VoiceSpark's sign-in, mailbox connections, filtering, memory store, deletion and admin rules. It does not add a second way to connect a mailbox.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep people, companies and projects (Priority: P1)

A user opens the Context Hub and adds a person, a company or a project. A person has a name, role or title, one or more email addresses, a phone number and a description. A company has a name, one or more web domains, a website, an industry and a description. A project has a name, a status (planned, active, on hold or completed), start and end dates and a description. The user can edit and delete any record. Lists of each kind can be sorted by name or by last change.

**Why this priority**: Every other part of the hub hangs off these records.

**Independent Test**: Create one record of each kind, edit a field on each, delete one, and confirm the lists and detail pages reflect each change.

**Acceptance Scenarios**:

1. **Given** an empty hub, **When** the user creates a person with a name and two email addresses, **Then** the person appears in the people list and their page shows both addresses.
2. **Given** a project with a start date, **When** the user sets an end date before the start date, **Then** saving is refused with an explanation.
3. **Given** a person named "Anna Nowak", **When** the user creates another person named "anna nowak", **Then** they see a warning that a similar record exists, with a link to it, and can still save.
4. **Given** a record with notes, files and links, **When** the user deletes it, **Then** they first see how many notes, files and links will be removed, and after confirming the record, its notes and files, and its links are gone while the linked records remain.
5. **Given** two users, **When** each creates records, **Then** neither can see, find or open the other's records.

---

### User Story 2 - Link records and attach notes and files (Priority: P1)

The user links a person to a company, a person to a project, or a company to a project, with an optional role such as "CTO" or "client". Links show on both records. The user writes notes on a record with simple formatting (headings, bold and italic, lists, checklists, links, quotes) and attaches files. Text inside PDF and Office documents and plain-text files is made searchable.

**Why this priority**: Links, notes and files are what turn a contact list into useful context.

**Independent Test**: Link a person to a company as "CTO", add a note with a checklist to the company, attach a PDF to the person, and confirm all three show on the right records.

**Acceptance Scenarios**:

1. **Given** a person and a company, **When** the user links them with the role "CTO", **Then** both records show the link with that role.
2. **Given** an existing link between two records, **When** the user tries to add a second link between the same pair, **Then** they are told the link exists and can edit its role instead.
3. **Given** two people, **When** the user tries to link them to each other, **Then** the option is not offered, because only person–company, person–project and company–project links exist.
4. **Given** a record, **When** the user writes a note with a heading, a checklist and a link, **Then** the note keeps that formatting when reopened.
5. **Given** a PDF or Office document with text, **When** the user attaches it, **Then** its text becomes searchable; **Given** an image or a format whose text cannot be read, **Then** the file is kept and marked as not searchable, with the reason.
6. **Given** a file over the size limit or of a type not allowed, **When** the user attaches it, **Then** it is refused with the reason.
7. **Given** a note or file that contains a password or another excluded category, **When** it is saved, **Then** the excluded part is removed from the note, and from the file's extracted text, before it is stored, searched or synced, as for any other VoiceSpark content; the original file stays encrypted and only its owner can download it; the user sees what was excluded.

---

### User Story 3 - Hub filled in from email (Priority: P1)

Once the user turns the hub on for a connected mailbox, VoiceSpark reads that mailbox's conversations and recognises the people, companies and projects in them and how they relate. Confident findings are added automatically. Uncertain findings, and anything that would change a value the user entered, go to a suggestions queue. Each relevant conversation gets a short summary attached to the records involved. Newsletters, notifications and no-reply senders are skipped, and the user's own addresses and generic role addresses (such as info@ or office@) never become people.

**Why this priority**: Filling the hub by hand does not scale; this is what makes the hub worth having.

**Independent Test**: With a test mailbox of known business conversations, turn the hub on and confirm the expected people, companies, links and summaries appear, newsletters create nothing, and uncertain items are in the queue.

**Acceptance Scenarios**:

1. **Given** a mailbox where the user exchanged mail with "Jan Kowalski <jan@acme.com>", **When** the hub processes it, **Then** a person "Jan Kowalski" with that address exists and is linked to a company for the acme.com domain.
2. **Given** a newsletter or an automated notification, **When** the hub processes it, **Then** no person, company or summary is created from it.
3. **Given** a person whose phone number the user typed in, **When** a later email shows a different number, **Then** the user's value is kept and the new number is offered as a suggestion marked as a conflict, showing both values.
4. **Given** a value or link the user deleted or a suggestion they rejected, **When** later mail points to it again, **Then** it is not re-added automatically; at most it is suggested again from new evidence.
5. **Given** a relevant conversation, **When** it is processed, **Then** each record involved shows a short summary of it with its subject, date, participants and a way to open the original in the mail provider.
6. **Given** a record field or link that came from email, **When** the user looks at it, **Then** they can see which conversations it came from.
7. **Given** the same conversation in two of the user's mailboxes, **When** both are processed, **Then** it is processed once.
8. **Given** a sender or domain the user marks as ignored, **When** later mail arrives from it, **Then** it creates nothing and updates nothing.
9. **Given** a mailbox the user has not turned the hub on for, **When** its mail is imported for tone of voice, **Then** nothing from it reaches the hub.

---

### User Story 4 - Review suggestions and merge duplicates (Priority: P2)

The user opens the suggestions queue, sees each proposed record, value or link with the evidence behind it, and accepts or rejects items one by one or in bulk. When two records of the same kind turn out to be the same person, company or project, the user merges them into one.

**Why this priority**: Keeps the hub correct without forcing the user to check everything.

**Independent Test**: With queued suggestions, accept one and reject one and confirm the records change only for the accepted one; merge two duplicate people and confirm one record remains with everything from both.

**Acceptance Scenarios**:

1. **Given** a queued suggestion, **When** the user opens it, **Then** they see what would change, the current value if any, and the conversations it came from.
2. **Given** several suggestions, **When** the user accepts them in bulk, **Then** all are applied, and a suggestion that depends on another (such as a link to a project not yet created) is applied in the right order.
3. **Given** two people records for the same person, **When** the user merges them, **Then** one record remains with the email addresses, notes, files, links and conversation summaries of both; where both have a value for the same field, the kept record's value wins.
4. **Given** a merged-away record, **When** later mail refers to it, **Then** it updates the kept record.
5. **Given** a pending suggestion count, **When** the user is anywhere in the hub, **Then** they can see how many suggestions are waiting.

---

### User Story 5 - Search the hub (Priority: P2)

The user searches by keyword and finds matching records, notes and files, each result showing its type, the record it belongs to and a highlighted snippet. They can narrow results by type.

**Why this priority**: The hub becomes hard to use without search once it holds hundreds of records.

**Independent Test**: Search for a word that appears in a person's name, a note on a company and the text of an attached PDF, and confirm all three are found and labelled.

**Acceptance Scenarios**:

1. **Given** a word that appears in a note, **When** the user searches for it, **Then** the note is found with a snippet and the name of its record.
2. **Given** a word that appears only inside an attached PDF, **When** the user searches for it, **Then** the file is found.
3. **Given** results of several types, **When** the user filters to "people", **Then** only people are shown.
4. **Given** another user's hub contains the word, **When** this user searches, **Then** none of the other user's items appear.

---

### User Story 6 - Drafts with context from the hub (Priority: P2)

When asking for a draft, the user can pick a person, company or project. The draft is written in the user's chosen voice and uses what the hub knows about that record: role, how the user is related to it, linked records, notes and recent conversation summaries.

**Why this priority**: Connects the hub to VoiceSpark's core value, writing in the user's voice.

**Independent Test**: Request a short message for a person whose hub record says "CTO at Acme, discussed the Q3 rollout" and confirm the draft reflects that context and is still in the chosen voice.

**Acceptance Scenarios**:

1. **Given** a draft request with a selected person, **When** the draft is produced, **Then** it reflects the person's role, company and recent topics from the hub.
2. **Given** a draft request without a selected record, **When** the draft is produced, **Then** it behaves as drafts do today.
3. **Given** a selected record, **When** the draft is saved, **Then** it records which record was used, and the draft list shows it.
4. **Given** hub context that includes an excluded category, **When** a draft is produced, **Then** that content does not appear in the draft.

---

### User Story 7 - Memory store sync and status (Priority: P2)

Every record, note, file and conversation summary is copied to the user's own space in the memory store, so assistants using that store can answer questions about the user's contacts and projects. The user can see what is stored, what is waiting and what failed, retry failed items and request a full re-sync.

**Why this priority**: The memory store is how VoiceSpark and outside assistants use the hub's knowledge.

**Independent Test**: Create a record with a note, confirm both reach "stored"; make the store unavailable, edit the note, confirm it shows "failed" with a retry, restore the store and retry.

**Acceptance Scenarios**:

1. **Given** a new or edited item, **When** the memory store is available, **Then** the item shows "stored" shortly after saving.
2. **Given** the store is unavailable, **When** items cannot be stored, **Then** they show "failed" or "waiting", the user can retry, and no content is lost.
3. **Given** a record that is renamed or linked to another, **When** sync runs, **Then** the stored copies of its notes, files and linked records reflect the new name or link.
4. **Given** a deleted item, **When** sync runs, **Then** it is removed from the memory store.

---

### User Story 8 - Privacy, admin and deletion (Priority: P1)

The hub follows VoiceSpark's privacy rules. Admins see no hub content. When the user deletes their account, or disconnects a mailbox and chooses to delete its data, the related hub data is removed everywhere, including the memory store, within the same deadline as other VoiceSpark data.

**Why this priority**: The hub holds data about other people; mistakes here are the most harmful.

**Independent Test**: As an admin, try every admin screen and route and confirm no hub content is reachable; delete a test account and confirm its hub data is gone from the app and the memory store within the deadline.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they use the admin panel, **Then** they see at most counts about a user's hub (such as number of records), never names, notes, files, summaries or suggestions.
2. **Given** a user who disconnects a mailbox and chooses to delete its data, **When** deletion completes, **Then** conversation summaries only from that mailbox are deleted, values and links that came only from it are removed, records left with nothing the user created and no other source are deleted, and user-entered data stays.
3. **Given** a user who disconnects a mailbox and chooses to keep its data, **When** they do so, **Then** the hub keeps what was already derived, and nothing new comes from that mailbox.
4. **Given** a user who deletes their account, **When** deletion completes, **Then** all hub data, including notes, files and memory store copies, is gone within 24 hours.
5. **Given** extracted facts, summaries, notes and files, **When** they are stored, **Then** they have passed the same password and sensitive-data filter as other VoiceSpark content.

### Edge Cases

- Two users exchange mail with each other: each gets a person record for the other in their own hub; nothing is shared between hubs.
- A conversation mixes a newsletter footer with a real reply: the real reply is processed; footers and quoted history do not create records.
- A person uses a free-mail address (for example gmail.com): no company is created from that domain.
- A sender writes from several addresses: the addresses are attached to one person when the evidence is strong; otherwise a merge is suggested.
- A message arrives in a thread that was already summarised: the summary is updated; the thread is not counted twice.
- Mail processing fails for one conversation: that conversation is retried later and the rest continue; repeated failures are shown to the user.
- The memory store rejects an item: the item stays saved in VoiceSpark, shows "failed", and can be retried.
- The user edits a record while its mail is being processed: the user's edit wins.
- A file's text extraction takes too long or fails: the file is kept and marked not searchable with the reason.
- A record is deleted while a suggestion about it is queued: the suggestion is dropped.
- The user turns the hub off for a mailbox: processing of that mailbox stops; the user chooses whether derived data is kept or deleted.

## Requirements *(mandatory)*

### Functional Requirements

**Records**

- **FR-001**: Each user MUST have their own private hub; no record, note, file, link, summary or suggestion is visible to any other user.
- **FR-002**: Users MUST be able to create, view, edit and delete people (name required; role or title, several email addresses, phone, description), companies (name required; several web domains, website, industry, description) and projects (name required; status planned, active, on hold or completed, default planned; start and end dates, end not before start; description).
- **FR-003**: System MUST warn, without blocking, when a new or renamed record has the same name as an existing record of the same kind, ignoring letter case.
- **FR-004**: Deleting a record MUST first show how many notes, files and links will be removed; after confirmation it MUST delete the record with its notes, files and links and keep linked records.
- **FR-005**: Users MUST be able to merge two records of the same kind: kept-record values win where both have one; addresses, domains, notes, files, links, summaries and email-derived facts move to the kept record; later references to the merged-away record resolve to the kept one.
- **FR-006**: Record lists MUST be sortable by name and by last change.

**Links**

- **FR-007**: Users MUST be able to link person–company, person–project and company–project, at most one link per pair, each with an optional role label of up to 100 characters; links MUST show on both records. Other link kinds MUST NOT be offered.

**Notes and files**

- **FR-008**: Users MUST be able to write, edit and delete notes on a record with headings, bold, italic, underline, strikethrough, inline code, bulleted and numbered lists, checklists, links, quotes, code blocks and dividers; formatting MUST be preserved.
- **FR-009**: Users MUST be able to attach, rename, describe, download and delete files on a record, within an allowed list of document, spreadsheet, presentation, text and image types and a size limit (see Assumptions); other files MUST be refused with the reason. The original file MUST be stored encrypted, MUST be downloadable only by its owner, and MUST NOT be sent to the AI service or the memory store; only its filtered extracted text is searched and synced.
- **FR-010**: System MUST extract searchable text from PDF, Office and OpenDocument documents and text files; files whose text cannot be extracted MUST be kept and marked not searchable with a reason.

**Search**

- **FR-011**: Users MUST be able to search their own records, notes and files by keyword, see the type, owning record and a highlighted snippet of each result, and filter by type.

**From email**

- **FR-012**: The hub MUST be off for every mailbox until the user turns it on; when turning it on, the user MUST be told that conversation content is sent to the AI service. Users MUST be able to turn it off again. Only mailboxes with the hub turned on are processed for the hub.
- **FR-013**: System MUST recognise people, companies, projects and links between them in the conversations of hub-enabled mailboxes, using the conversations VoiceSpark already reads, not a second mailbox connection.
- **FR-014**: System MUST skip automated mail (newsletters, notifications, no-reply and bulk senders), spam and deleted mail, and MUST NOT create people from the user's own addresses or generic role addresses, or companies from free-mail domains.
- **FR-015**: System MUST apply confident findings automatically and MUST put uncertain findings, and any finding that would change a value the user entered or cleared, into a suggestions queue.
- **FR-016**: Values and links the user entered, edited or cleared MUST never be overwritten by findings from email.
- **FR-017**: Items the user deleted, and suggestions they rejected, MUST NOT be re-added automatically; they MAY be suggested again only from new evidence.
- **FR-018**: Each value and link that came from email MUST show the conversations it came from.
- **FR-019**: For each relevant conversation, the system MUST keep a short summary (with subject, dates, participants and a link to open it in the mail provider) and attach it to every record involved. Full message text MUST NOT be stored by the hub or sent to the memory store.
- **FR-020**: A conversation present in several of the user's mailboxes MUST be processed once; a new message in a known conversation MUST update its summary and findings.
- **FR-021**: Users MUST be able to mark a sender address or domain as ignored; ignored senders MUST create and update nothing, and users MUST be able to undo this.
- **FR-022**: For each hub-enabled mailbox, users MUST see how many conversations were processed, skipped and failed, and when processing last ran.

**Suggestions**

- **FR-023**: Users MUST be able to see each suggestion with its proposed change, the current value if any, whether it is a conflict, and its source conversations, and accept or reject suggestions one by one or in bulk; dependent suggestions MUST be applied in order.
- **FR-024**: Users MUST be able to see the number of waiting suggestions from anywhere in the hub.

**Memory store**

- **FR-025**: System MUST copy every record, note, file (with its extracted text) and conversation summary to the user's own space in the memory store, labelled with its type and the records it belongs to, and keep the copies current after edits, renames, link changes, merges and deletions.
- **FR-026**: Users MUST see each item's sync status (stored, waiting, failed) and be able to retry failed items and request a full re-sync; a failed sync MUST NOT lose content.

**Drafts**

- **FR-027**: Users MUST be able to select a person, company or project when requesting a draft; the draft MUST use that record's role, relationships, linked records, notes and recent conversation summaries as context, and MUST record which record was used.

**Privacy, admin and deletion**

- **FR-028**: Extracted facts, conversation summaries, notes and file text MUST pass the same filter as other VoiceSpark content before they are stored or sent to the memory store or to the AI service, and MUST follow the user's filter choices, with one exception: email addresses and phone numbers MAY be kept in the email-address and phone fields of people and the domain field of companies in the hub, even when the user excludes other people's contact details. Everywhere else (summaries, notes, file text, findings evidence, tone-of-voice content) the user's choice applies. Contact values from hub records MUST be sent to the memory store only when the user has not selected the other-people's-contact-details category. Locked categories and all other categories are always applied.
- **FR-029**: Admins MUST NOT be able to see any hub content (names, fields, notes, files, summaries, suggestions or links); they MAY see per-user counts.
- **FR-030**: Deleting the account MUST delete all hub data, including memory store copies, within the account-deletion deadline of spec 001 (24 hours).
- **FR-031**: When a user disconnects a mailbox or turns the hub off for it, they MUST choose to keep or delete its hub data; deleting MUST remove summaries only from that mailbox, values and links only from that mailbox, and records left with nothing user-made and no other source, including from the memory store, within 24 hours; user-entered data MUST stay.
- **FR-032**: System MUST record audit entries for hub-relevant events (turning the hub on or off for a mailbox, bulk accepts, merges, ignore rules, deletions) without names or content.

### Key Entities

- **Person**: someone the user works with; name, role or title, email addresses, phone, description; where each value came from (user or email) and whether the user set or cleared it.
- **Company**: an organisation; name, web domains, website, industry, description; same provenance as a person.
- **Project**: a piece of work; name, status, start and end dates, description; same provenance.
- **Link**: a relationship between a person and a company, a person and a project, or a company and a project; optional role; source (user or email) and source conversations.
- **Note**: formatted text on one record; title, body, dates.
- **File**: a document on one record; name, description, type, size, extracted text status and reason, dates.
- **Conversation Summary**: a short summary of one email conversation; subject, dates, participants, message count, language, link to the original; attached to the records involved; tied to the mailboxes it came from.
- **Finding / Suggestion**: a fact proposed from email (new record, value or link); confidence, whether it conflicts with user data, evidence, source conversations, state (applied, waiting, accepted, rejected, overridden).
- **Block Marker**: a record that the user deleted or rejected a specific item, so it is not re-added automatically.
- **Ignore Rule**: a sender address or domain the user does not want in the hub.
- **Hub Mailbox Setting**: per connected mailbox, whether the hub is on, and its processing counters and last run.
- **Sync Item**: the memory-store status of one hub item (stored, waiting, failed) and its last error code.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can create a record and add a first note to it in under 1 minute, and attach a file to any record in 3 or fewer steps after opening it.
- **SC-002**: A record with up to 100 notes and files opens, showing all its notes, files, links and summaries on one screen, in under 2 seconds.
- **SC-003**: Keyword search returns results in under 2 seconds for a hub with up to 10,000 records, notes and files.
- **SC-004**: On a labelled test set of at least 50 business conversations: at least 95% of human correspondents become the correct person, at least 90% of person–company links are correct, and at least 80% of project names and project links are correct.
- **SC-005**: On the same set, no more than 2% of created people are duplicates, and no newsletter or automated sender becomes a person.
- **SC-006**: On the same set, at most 1 in 5 findings goes to the suggestions queue, and at least 90% of automatically applied findings are correct.
- **SC-007**: 0 user-entered values are overwritten by findings from email in testing.
- **SC-008**: 100% of email-derived values and links show at least one source conversation; 100% of relevant processed conversations have a summary, and no full message text is stored by the hub or sent to the memory store.
- **SC-009**: New mail in a hub-enabled mailbox is reflected in the hub within 15 minutes of VoiceSpark reading it.
- **SC-010**: 99% of saved hub items are stored in the memory store within 1 minute while it is available; 100% of failures are visible to the user and none lose content.
- **SC-011**: 0 hub items are reachable by admins or by other users in automated isolation tests.
- **SC-012**: Account deletion and mailbox data deletion remove all affected hub data, including memory store copies, within 24 hours in 100% of tests.

## Assumptions

- The hub is part of the existing VoiceSpark account; there is no separate sign-in, plan or sharing between users.
- The contact-details exception (FR-028) covers only the structured contact fields of hub records; postal addresses are not kept in record fields.
- The hub uses the mail VoiceSpark already reads for each mailbox (same date range, folders and filtering). Reading mail for the hub sends conversation content to the same AI service VoiceSpark already uses; users are told this when they turn the hub on for a mailbox.
- Only conversations are read for the hub; email attachments are not added to the hub as files.
- File size limit: 25 MB per file; allowed types follow the Context Hub list (PDF, Word, OpenDocument text, RTF, Excel, OpenDocument spreadsheet, CSV, PowerPoint, OpenDocument presentation, plain text, Markdown, PNG, JPEG, GIF, WebP). Images are stored but not searchable (no OCR).
- Notes keep only the latest version; there is no history or recycle bin for records, notes or files.
- A conversation is "relevant" when at least one human correspondent other than the user takes part and it is not automated mail.
- Conversation summaries are written in the conversation's language and are at most a few sentences.
- Search matches words and word prefixes; it does not need to ignore accents in the first version.
- The confidence levels for automatic versus suggested findings follow the Context Hub's tested policy and may be tuned later without changing this specification.
- Hub data counts toward the existing account-deletion deadline of 24 hours.
- Existing VoiceSpark tone-of-voice evidence rules are unchanged: received mail still never counts as the user's own writing.
