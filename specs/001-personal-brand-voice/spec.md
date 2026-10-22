# Feature Specification: Personal Brand Voice

**Feature Branch**: `001-personal-brand-voice`

**Created**: 2026-10-19

**Status**: Draft

**Input**: User description: "I want to build an app that will be used to build personal brand for it's users. it should be able to be fed email history (multiple google/microsoft/IMAP accounts) and feed supermemory. supermemory should not be fed unauthorised content like passwords and stuff. the registration should be done via google/apple/microsoft/facebook. once email history, notes, files with content and anything related is loaded, it should create a tone of voice for the user. tone of voice definition should be stored in a database, by an admin. there should be a normal user and admin panel. admin should be able to define prompts like for the tone of voice and others."

## Clarifications

### Session 2026-10-19

- Q: Is content generation (drafting social posts, bios or articles in the user's voice) in scope, or does the feature end at the tone-of-voice profile? → A: Basic drafting is in scope: social posts, bios and short articles written in the voice of a profile the user selects. Publishing to social networks is out of scope; users copy or export drafts.
- Q: Beyond credentials, which kinds of sensitive content are kept out of the memory store (for example financial and ID numbers, health and other special-category data, other people's contact details)? → A: The user decides, using a checklist of filter categories shown before their first import and editable at any time in settings. The credential categories (passwords and passphrases, one-time and verification codes, password-reset and verification links, API keys and access tokens) are always excluded and shown as selected and locked, because the original request says passwords must never reach the memory store. All other categories are selected by default and can be changed.
- Q: Is there one global tone-of-voice definition, or can admins create several? → A: Admins create multiple named definitions (for example "LinkedIn voice" and "Email voice"). Each user chooses one or more, and each chosen definition produces a separate profile for that user.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign up and sign in with an existing account (Priority: P1)

A person registers and signs in using their existing Google, Apple, Microsoft or Facebook account. There are no passwords to create or remember. The account used to sign in is separate from any mailboxes the person later connects to import their email history.

**Why this priority**: Signing in is the entry point for everything else, and relying on existing accounts means the product never has to hold user passwords.

**Independent Test**: Sign up with each of the four providers, sign out, then sign back in and confirm the same account and its data are reached.

**Acceptance Scenarios**:

1. **Given** a first-time visitor, **When** they pick a provider and give consent, **Then** an account is created and they see an empty dashboard.
2. **Given** a returning user, **When** they sign in with the provider they registered with, **Then** they reach their existing account.
3. **Given** a user who registered with one provider, **When** they sign in with a second provider that shares the same verified email address, **Then** the system offers to link the two identities and links them only after the user confirms, instead of creating a duplicate account.
4. **Given** a provider that supplies no verified email address or only a private relay address (as Apple may), **When** the user signs in, **Then** an account is created without automatic linking, and the user can link identities manually from settings.
5. **Given** a user who signed in with Google, **When** they look at their connected sources, **Then** no Gmail mailbox is connected until they take a separate, explicit connect step.
6. **Given** a visitor on a provider's consent screen, **When** they cancel, **Then** they return to the sign-in page with a clear message and no account is created.

---

### User Story 2 - Connect mailboxes and import email history (Priority: P1)

A user connects several mailboxes from Google, Microsoft or any standard IMAP provider, and the system imports their email history into the memory store (Supermemory). The user can see progress for each mailbox, pause and resume an import, and disconnect a mailbox at any time.

**Why this priority**: Email is the main source of both the user's voice and the memory content the product relies on.

**Independent Test**: Connect two mailboxes from different providers, let the import complete, and confirm the items appear in the memory store under that user only.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they connect a Google mailbox (and, if it is their first import, confirm their filter choices), **Then** the import starts and the progress view shows items processed, total or estimated remaining, and status.
2. **Given** a user with one connected mailbox, **When** they connect a Microsoft mailbox and an IMAP mailbox to the same account, **Then** each mailbox is listed separately with its own progress.
3. **Given** a running import, **When** the user pauses it and later resumes it, **Then** the import continues from where it stopped without creating duplicates.
4. **Given** a user connecting a mailbox, **When** they choose a date range, **Then** only emails within that range are imported; without a choice the full history is imported.
5. **Given** a connected mailbox, **When** the user disconnects it, **Then** syncing stops and the user is asked whether to delete that source's content from the memory store; if they confirm, it is deleted.
6. **Given** a mailbox whose access has been revoked or has expired, **When** the system detects it, **Then** the source shows "needs reconnection", its import pauses and the user is notified.
7. **Given** a mailbox whose initial import has finished, **When** new emails arrive, **Then** they are picked up on an ongoing basis while the mailbox stays connected.

---

### User Story 3 - Keep sensitive content out of the memory store (Priority: P1)

Before their first import, and at any time in settings, the user chooses from a checklist which kinds of sensitive content are kept out of the memory store. Credentials (passwords and passphrases, one-time and verification codes, password-reset and verification links, API keys and access tokens) are always excluded and cannot be unselected. The other categories (payment card numbers, bank account numbers, government ID numbers, health information, other special-category data, and other people's contact details) are selected by default and can be changed. Before anything reaches the memory store, the system detects content in the excluded categories and either excludes or redacts it. After each import the user sees a summary of what was excluded, by category, and can add their own exclusion rules.

**Why this priority**: This is an explicit user requirement and the basis of trust in the product, as well as a source of legal exposure if it fails.

**Independent Test**: With every filter category selected, import a seeded mailbox containing known passwords, one-time codes, reset links, API keys, card and bank numbers, ID numbers, health information, other special-category data and other people's contact details, then confirm none of them reach the memory store and the summary counts match what was seeded.

**Acceptance Scenarios**:

1. **Given** an email containing a password, **When** it is imported, **Then** the password does not reach the memory store and the summary counts one item under "passwords and passphrases".
2. **Given** an email that is essentially a one-time code or password-reset message, **When** it is imported, **Then** the whole message is excluded.
3. **Given** a completed import, **When** the user opens the summary, **Then** it shows counts by category and never shows the sensitive value itself.
4. **Given** a user who adds an exclusion rule by sender, domain, label or folder, or keyword, **When** future items match the rule, **Then** they are excluded, and the user is offered removal of matching content already stored.
5. **Given** an item that should have been excluded but was not, **When** the user reports it, **Then** it is removed from the memory store and the report is recorded.
6. **Given** a file or note uploaded by the user, **When** it is processed, **Then** the same filtering applies (see User Story 4).
7. **Given** a user starting their first import (a first mailbox connection or a first upload or note), **When** the filter step is shown, **Then** every filter category is listed, the four credential categories are selected and locked, every other category is selected by default, and nothing is imported until the user confirms.
8. **Given** the filter checklist, **When** the user tries to unselect a credential category, **Then** it stays selected and the user is told that credentials are always excluded.
9. **Given** a user who unselects "payment card numbers", **When** a later import contains a card number, **Then** the card number is kept in the memory store, credentials are still excluded, and content excluded before the change is not re-imported.
10. **Given** a user who newly selects a category such as "health information" in settings, **When** they save, **Then** future imports exclude that category and the user is offered removal of matching content already stored.

---

### User Story 4 - Upload notes and files (Priority: P2)

A user uploads documents, PDFs and plain-text files, or pastes notes, so the memory store holds their writing beyond email. The same sensitive-content filtering applies.

**Why this priority**: Uploads add authored content beyond email, which improves the quality of the tone-of-voice profile.

**Independent Test**: Upload one file of each supported kind plus a pasted note, and confirm each is stored, filtered and listed as a source.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they upload a text-bearing document, **Then** it is stored and listed among their sources.
2. **Given** a user who pastes a note, **When** they save it, **Then** it is stored as the user's own authored content.
3. **Given** an unreadable, image-only or unsupported file, **When** the user uploads it, **Then** it is rejected with a clear reason and nothing is stored.
4. **Given** an uploaded file containing an API key, **When** it is processed, **Then** the key is excluded and the exclusion summary is shown.
5. **Given** an uploaded item, **When** the user deletes it, **Then** it is removed from the memory store.

---

### User Story 5 - Generate and refine my tone-of-voice profile (Priority: P2)

The user chooses one or more of the available tone-of-voice definitions (for example "LinkedIn voice" and "Email voice"), and the system builds a separate tone-of-voice profile for each one from the user's own authored content: sent emails, their notes and their files. Received emails are context only and never evidence of how the user writes. The user can view each profile, regenerate it, give feedback and adjust it, and every version is kept.

**Why this priority**: The profile is the core value of the product.

**Independent Test**: With enough authored content, generate a profile and confirm it describes every dimension of its definition and cites only authored content; choose two definitions and confirm two separate profiles are produced.

**Acceptance Scenarios**:

1. **Given** a user with enough authored content, **When** they click generate, **Then** a profile is produced for each definition they have chosen, describing each dimension of that definition, with short example excerpts from their own writing.
2. **Given** a user below the content threshold, **When** they open the profile page, **Then** they are told how much more content is needed and generation is not offered.
3. **Given** an existing profile, **When** the user regenerates it, **Then** a new version is created and older versions remain viewable.
4. **Given** an existing profile, **When** the user gives feedback or edits a dimension (for example "less formal"), **Then** a new adjusted version is saved.
5. **Given** a mailbox with received emails, **When** a profile is generated, **Then** received-only content is never quoted as the user's voice.
6. **Given** a generation, **When** it completes, **Then** it records which definition version and which prompt version it used.
7. **Given** two available definitions, "LinkedIn voice" and "Email voice", **When** the user chooses both and generates, **Then** two separate profiles are created, one per definition, each viewable and versioned on its own.
8. **Given** a user with one chosen definition, **When** they add another definition later, **Then** they can generate a profile for it without changing the existing profile; **When** they remove a definition, **Then** no new versions are generated for it and its existing versions stay viewable.
9. **Given** a user who has chosen definitions and has no profile yet, **When** an import completes and they first cross the authored-content threshold, **Then** a profile is generated automatically for each chosen definition and they are notified.

---

### User Story 6 - Administer tone-of-voice definitions, prompts and users (Priority: P2)

Administrators have a separate panel. In it they manage tone-of-voice definitions and named prompt templates (the tone-of-voice generation prompt, one prompt for each draft content type, and others), with versioning, draft and active states, rollback and change history. They can create several definitions, such as "LinkedIn voice" and "Email voice". Each has a name, a user-facing description and dimensions such as formality, warmth, sentence length, vocabulary, humour and signature phrases, and each can be marked as available to users or retired. They also manage users: view, suspend, and grant or revoke the admin role. Admins cannot read users' raw content.

**Why this priority**: It lets the business tune quality without a product release and provides governance over users and prompts.

**Independent Test**: An admin edits a draft prompt, publishes it, and the next generation uses the new version; an admin creates a second definition and a user can choose it; a non-admin cannot open the admin panel.

**Acceptance Scenarios**:

1. **Given** a regular user, **When** they try to open the admin panel, **Then** access is denied.
2. **Given** a draft definition or prompt version, **When** it has not been published, **Then** it does not affect any user's generations.
3. **Given** an admin who publishes a new version, **When** a new generation starts, **Then** it uses the published version, while generations already in progress finish on the version they started with.
4. **Given** an admin who rolls back, **When** they choose a previous version, **Then** it becomes active and the history records who did it and when.
5. **Given** a suspended user, **When** they try to sign in, **Then** sign-in is refused and their syncing pauses.
6. **Given** an admin, **When** they grant or revoke the admin role for another user, **Then** the change takes effect; the last remaining admin cannot remove their own admin role or suspend themselves.
7. **Given** an admin viewing a user, **When** they open the user's details, **Then** they see account metadata and source and import status only, never email or file content.
8. **Given** an admin, **When** they create a second definition named "Email voice" with a description and mark it available, **Then** users see it, with its name and description, among the definitions they can choose.
9. **Given** an available definition that some users have chosen, **When** an admin retires it, **Then** it is no longer offered to users and no new profile versions are generated from it, while existing profiles based on it stay viewable to their owners.
10. **Given** only one available definition, **When** an admin tries to retire it, **Then** the action is blocked with an explanation.
11. **Given** the prompt for a content type such as "social post", **When** an admin publishes a new version, **Then** the next draft of that type uses it.

---

### User Story 7 - Control and delete my data (Priority: P3)

A user can view all their connected sources, delete the data of any single source, or delete the whole account. Deletion also removes the content from the memory store.

**Why this priority**: It supports privacy rights and trust; it ranks lower because disconnecting a source (User Story 2) already gives partial control.

**Independent Test**: Delete one source, then the whole account, and confirm nothing remains in the memory store for that user.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they open their sources, **Then** they see a list with type, account, item count and last sync.
2. **Given** a source, **When** the user deletes it, **Then** its items and derived data are removed from the memory store.
3. **Given** a user who requests account deletion, **When** they confirm, **Then** they are signed out and all their data, including profiles, is removed within the deadline set in the success criteria.
4. **Given** a deletion in progress, **When** it completes, **Then** the user is notified.
5. **Given** a deleted source, **When** the deletion finishes, **Then** the user is told their profile may be outdated and is offered regeneration.

---

### User Story 8 - Draft content in my voice (Priority: P3)

A user picks a content type (social post, bio or short article), picks which of their tone-of-voice profiles to use, and gives a topic or short brief. The system drafts the content in that voice, drawing on the profile and relevant content from the user's memory store. The user can edit the draft, regenerate it, give feedback and rate it, and every draft is saved and listed so they can copy or export it. The product does not publish anything to social networks.

**Why this priority**: Drafting turns the profile into everyday value, but it depends on a profile existing, so it follows the profile and data-control stories.

**Independent Test**: With at least one generated profile, request one draft of each content type, edit and regenerate one, then confirm all drafts are listed with the profile used and can be copied and exported.

**Acceptance Scenarios**:

1. **Given** a user with at least one generated profile, **When** they choose a content type, a profile and a topic or brief, **Then** a draft written in that voice is produced and saved to their drafts.
2. **Given** a user with no generated profile, **When** they open drafting, **Then** drafting is not offered and they are guided to generate a profile first.
3. **Given** a draft, **When** the user edits it, **Then** their edited text is saved.
4. **Given** a draft, **When** the user regenerates it or gives feedback (for example "shorter and more upbeat"), **Then** a new draft is produced and the previous one remains available.
5. **Given** a user with "LinkedIn voice" and "Email voice" profiles, **When** they draft the same brief with each, **Then** each draft reflects the chosen profile and records which profile was used.
6. **Given** saved drafts, **When** the user opens their drafts list, **Then** they see each draft's content type, topic, profile used and date, and can copy, export or delete any draft; no option to publish to a social network is offered.
7. **Given** a draft, **When** the user rates it, **Then** the rating ("sounds like me" or not) is saved with the draft.
8. **Given** a draft request, **When** the draft is produced, **Then** it never includes content from a filter category excluded for that user, and it records the profile version and prompt version used.

### Edge Cases

- What happens when a mailbox is very large (100,000+ emails)? The import runs in the background, shows accurate progress, resumes after any interruption, and does not affect other users.
- What happens when access is revoked or authorisation expires? The source is marked as needing reconnection, nothing already imported is lost, and the import resumes where it stopped after reconnection.
- What happens when IMAP authentication fails or the server details are wrong? The user sees a clear error, nothing is stored, and they can retry.
- What happens when the same email exists in several connected accounts (for example cc'd or forwarded)? It is stored once and counted once.
- What happens with attachments? Text-bearing attachments are filtered the same way as other content; non-text attachments are skipped and counted.
- What happens with non-text or unreadable files (scanned images, encrypted PDFs, corrupt files)? They are rejected or skipped with a stated reason.
- What happens when content is in several languages? It is accepted, and the profile notes the languages detected.
- What happens when the user has too little authored content (for example only received mail)? Generation is blocked and the user is guided to add sent mail or notes.
- What happens when the active prompt or definition changes during a running generation? The generation completes on the versions it started with, and the profile records them.
- What happens when the last admin tries to demote or suspend themselves? The action is blocked with an explanation.
- What happens when a provider gives no verified email or an Apple private relay address? The account is created without automatic linking, and manual linking is available.
- What happens when the filter misses something (a false negative)? The user can report and purge the item, and the report is recorded in the audit trail.
- What happens when a user disconnects or deletes a source mid-import? The import stops, and partial content follows the user's delete choice.
- What happens to a suspended user's sources? Syncing pauses and nothing new is sent to the memory store.
- What happens when a user unselects every optional filter category? Credentials are still always excluded; other content is imported unfiltered.
- What happens when a definition is retired while a user has a profile based on it? The profile stays viewable and can still be used for drafting, but it cannot be regenerated; the user is told the definition is retired and is offered the available definitions.
- What happens when a user asks for a draft without any generated profile? Drafting is blocked and the user is guided to generate a profile first.
- What happens when a brief or the memory content touches on an excluded filter category? The draft never includes content from that category.

## Requirements *(mandatory)*

### Functional Requirements

**Sign-in & accounts**

- **FR-001**: System MUST let users register and sign in using Google, Apple, Microsoft or Facebook accounts only.
- **FR-002**: System MUST NOT offer password-based sign-in or store sign-in passwords.
- **FR-003**: System MUST link identities from different providers to one user when they share the same verified email, after the user confirms.
- **FR-004**: System MUST create accounts when the provider supplies no verified email or a relay address, MUST NOT auto-link such accounts, and users MUST be able to link identities manually from settings.
- **FR-005**: System MUST keep sign-in identities separate from connected mailboxes; signing in MUST NOT by itself grant access to any mailbox.
- **FR-006**: System MUST prevent suspended users from signing in.

**Mailbox connection & import**

- **FR-007**: Users MUST be able to connect multiple mailboxes per account from Google, Microsoft and any standard IMAP provider.
- **FR-008**: System MUST request only the access needed to read the user's mail and MUST tell the user what will be read before they connect.
- **FR-009**: System MUST import full email history by default and MUST let the user choose a date range before import starts.
- **FR-010**: System MUST show per-source import progress (status, items processed, items remaining or estimated, last activity).
- **FR-011**: Users MUST be able to pause and resume an import; resuming MUST NOT create duplicates.
- **FR-012**: System MUST continue importing new email for connected sources until disconnected.
- **FR-013**: System MUST detect revoked or expired access and authentication failures, mark the source as needing reconnection, and notify the user.
- **FR-014**: System MUST de-duplicate the same message across sources.
- **FR-015**: Users MUST be able to disconnect a source; disconnecting MUST stop syncing and ask whether to delete that source's content from the memory store.
- **FR-016**: System MUST mark each imported email as authored by the user (sent) or received.

**Sensitive-content protection**

- **FR-017**: System MUST inspect all content (email bodies, subjects, text-bearing attachments, uploads, notes) before it reaches the memory store, and MUST exclude or redact the always-excluded credential categories (passwords and passphrases, one-time and verification codes, password-reset and verification links, API keys and access tokens) plus every other category the user has selected under FR-018.
- **FR-018**: Before a user's first import starts (first mailbox connection, or first upload or note) and at any time in settings, users MUST be able to choose from a checklist which filter categories are excluded from the memory store. The categories are: passwords and passphrases; one-time and verification codes; password-reset and verification links; API keys and access tokens; payment card numbers; bank account numbers; government ID numbers; health information; other special-category data (such as religion, political views or sexual orientation); and third parties' contact details (other people's phone numbers, addresses and email addresses). The four credential categories MUST always be excluded and shown as selected and locked; all other categories MUST be selected by default and can be changed by the user.
- **FR-019**: System MUST exclude entire messages whose main purpose is delivering a credential or code (e.g. sign-in codes, reset emails).
- **FR-020**: System MUST produce a per-import exclusion summary with counts per category, and MUST NOT display, log or store excluded values anywhere.
- **FR-021**: Users MUST be able to create, edit and remove exclusion rules by sender, domain, label or folder, and keyword; rules apply to all future imports, and the user MUST be offered removal of matching content already stored.
- **FR-022**: Users MUST be able to report an item that should have been excluded; the system MUST remove it from the memory store and record the report.
- **FR-023**: If inspection cannot be completed for an item, the system MUST NOT send it to the memory store.

**Notes & files**

- **FR-024**: Users MUST be able to upload text-bearing documents, PDFs and plain-text files, and paste notes.
- **FR-025**: System MUST apply the same protection as email (FR-017 to FR-023) to uploads and notes.
- **FR-026**: System MUST reject unreadable, unsupported or text-less files with a reason and store nothing from them.
- **FR-027**: System MUST treat uploads and notes as authored content unless the user marks them otherwise.

**Tone-of-voice profile**

- **FR-028**: System MUST generate a tone-of-voice profile using only the user's authored content as evidence of their voice; received content MAY be used as context but MUST NOT be quoted or treated as the user's own writing.
- **FR-029**: System MUST require a minimum amount of authored content before allowing generation and show progress toward it; admins can configure the threshold (default in Assumptions).
- **FR-030**: Each profile MUST describe every dimension in the active version of the tone-of-voice definition it was generated for and include short illustrative excerpts from the user's authored content.
- **FR-031**: Users MUST be able to view, regenerate, give feedback on and manually adjust each of their profiles; each change creates a new version; previous versions stay viewable.
- **FR-032**: Each profile version MUST record the definition version and prompt version used and its creation time.
- **FR-033**: A generation in progress MUST complete with the definition and prompt versions active when it started.
- **FR-034**: The profile MUST note languages detected in the user's authored content.
- **FR-035**: System MUST suggest regeneration when contributing sources are deleted or significant new content arrives.
- **FR-036**: Users MUST be able to request drafts of social posts, bios and short articles written in the voice of a selected profile (see FR-049 to FR-060).

**Admin panel**

- **FR-037**: System MUST provide a separate admin panel available only to users with the admin role.
- **FR-038**: Admins MUST be able to define and edit each tone-of-voice definition: its dimensions and each dimension's name, description and allowed values or scale.
- **FR-039**: Admins MUST be able to create and edit named prompt templates, including at least the tone-of-voice generation prompt, plus additional named prompts.
- **FR-040**: Admins MUST be able to create multiple named tone-of-voice definitions, each with a name and a user-facing description, and mark each as available to users or retired.
- **FR-041**: Each definition and each prompt template MUST be versioned with draft and active states; only one version of each definition and of each prompt template is active at a time; publishing MUST take effect for new generations without a product release.
- **FR-042**: Admins MUST be able to roll back to any previous version and see change history (who, when, what changed) for definitions and prompts.
- **FR-043**: Admins MUST be able to view users (account details, sign-in providers, sources, import status, profile status), suspend and reinstate users, and grant or revoke the admin role.
- **FR-044**: System MUST prevent removing or suspending the last remaining admin.
- **FR-045**: Admins MUST NOT be able to view users' raw email, file or note content, or profile source excerpts, through the admin panel.

**Data control & audit**

- **FR-046**: Users MUST be able to view all connected sources and delete the data of any single source.
- **FR-047**: Users MUST be able to delete their entire account; deletion MUST remove all their content, exclusion records, profiles and memory store content, and notify the user on completion.
- **FR-048**: System MUST record an audit entry for security- and governance-relevant events (sign-ins, source connect and disconnect, deletions, exclusion reports, admin changes to definitions, prompts, users and roles), never including sensitive values or raw content.

**Content drafting**

- **FR-049**: Users MUST be able to request drafts of three content types: social posts, bios and short articles.
- **FR-050**: For each draft request, users MUST give a topic or short brief and MUST choose which of their generated tone-of-voice profiles to use.
- **FR-051**: System MUST write each draft in the voice of the selected profile, using that profile and relevant content from the user's memory store.
- **FR-052**: Drafting MUST NOT be available to users without at least one generated profile; the system MUST guide such users to generate a profile first.
- **FR-053**: Users MUST be able to edit a draft, regenerate it, give written feedback to get a revised draft, and rate whether it sounds like them; earlier drafts MUST stay available.
- **FR-054**: System MUST save every draft and show the user a list of their drafts with content type, topic, profile used and creation date.
- **FR-055**: Users MUST be able to copy, export and delete any draft; deleting the account MUST also delete all of the user's drafts.
- **FR-056**: System MUST NOT publish or post drafts to social networks or any other outside service; users share drafts by copying or exporting them.
- **FR-057**: Admins MUST manage one named prompt template for each content type (social post, bio, short article), with the same versioning, draft and active states, rollback and history as other prompts (FR-039, FR-041, FR-042).
- **FR-058**: Each draft MUST record the profile version and the content-type prompt version used, and its creation time; a draft in progress MUST complete with the prompt version active when it started.
- **FR-059**: Drafts MUST NOT include content from any filter category excluded for that user.
- **FR-060**: Admins MUST NOT be able to view users' drafts through the admin panel.

**Filter preferences**

- **FR-061**: Filter preferences MUST be held per user and apply to all of that user's sources, including mailboxes, uploads and notes; the user's first import MUST NOT start until they have confirmed their filter choices.
- **FR-062**: Changes to filter preferences MUST apply to all future imports, ongoing syncing and new uploads; when a user newly selects a category, the system MUST offer removal of matching content already in the memory store.
- **FR-063**: Unselecting a category MUST NOT re-import content that was excluded earlier.
- **FR-064**: System MUST record an audit entry for each change to a user's filter preferences, naming the categories changed and never including content.

**Tone-of-voice definitions**

- **FR-065**: Users MUST be able to choose one or more available definitions, seeing each one's name and description; the system MUST create and maintain a separate profile for each chosen definition. When only one definition is available, it MUST be chosen by default.
- **FR-066**: Users MUST be able to add or remove chosen definitions at any time; removing a definition MUST stop new profile versions for it, while its existing versions stay viewable until the user deletes them.
- **FR-067**: Retired definitions MUST NOT be offered to users and MUST NOT be used to generate new profile versions; existing profiles based on them MUST stay viewable to their owners and can still be used for drafting.
- **FR-068**: System MUST keep at least one definition available to users at all times and MUST block retiring the last available definition.
- **FR-069**: System MUST automatically start generating the first profile for each chosen definition when the user first becomes eligible; later generations and regenerations are user-initiated.

### Key Entities *(include if feature involves data)*

- **User**: A person using the product; has a role (user or admin) and a status (active or suspended); has many Sign-in Identities, Connected Sources, Tone of Voice Profiles and Drafts, and one set of Filter Preferences.
- **Sign-in Identity**: One way a user signs in; provider, provider email and a verified flag; belongs to one User.
- **Connected Source**: A mailbox (Google, Microsoft or IMAP) or a collection of uploads and notes; type, account label, status (connected, paused, needs reconnection, disconnected), chosen date range and last sync; belongs to one User.
- **Import Job**: One import run for a source; status, progress counts, start and end times; produces Exclusion Records.
- **Content Item**: One email, attachment, file or note accepted into the memory store; source, authored or received, date and language; de-duplicated across sources.
- **Exclusion Record**: The category and count of items excluded during an Import Job; never holds the excluded value itself.
- **Exclusion Rule**: A user-defined rule; type (sender, domain, label or folder, keyword), value and created date; belongs to one User.
- **Filter Preferences**: One set per user; the filter categories the user has selected, the locked credential categories that are always excluded, and when the preferences were last changed; applies to all of the user's sources.
- **Tone of Voice Definition**: An admin-owned, named set of dimensions with a user-facing description and an availability state (available to users or retired); versioned with draft and active states, author and timestamps; several can exist, and users choose one or more.
- **Prompt Template**: An admin-owned named instruction, such as the tone-of-voice generation prompt or the prompt for each draft content type; versioned with draft and active states, author and timestamps.
- **Tone of Voice Profile**: A versioned description of a user's voice across one definition's dimensions; one per user for each chosen definition; references the definition version and prompt version used, user feedback and adjustments, and creation time.
- **Draft**: A piece of content written for a user in the voice of one of their profiles; content type (social post, bio, short article), topic or brief, text, the user's edits, feedback and rating, the profile version and prompt version used, and creation time; belongs to one User.
- **Audit Log Entry**: A record of who did what, when and to which target; never contains sensitive values or raw content.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: New users complete sign-up with any supported provider in under 1 minute.
- **SC-002**: Users connect a mailbox (from start to import beginning) in under 2 minutes.
- **SC-003**: A mailbox of 10,000 emails is fully imported within 1 hour of connection.
- **SC-004**: At least 99% of items in a seeded test set of sensitive content (covering every filter category in FR-018, with all categories selected) are excluded before reaching the memory store.
- **SC-005**: Periodic audits find 0 passwords in the memory store.
- **SC-006**: For users with enough authored content, the first profile is available within 10 minutes of import completion.
- **SC-007**: At least 80% of users who rate their profile choose "sounds like me".
- **SC-008**: A published definition or prompt change applies to new generations within 1 minute, with no product release.
- **SC-009**: Source and account deletions, including removal from the memory store, complete within 24 hours.
- **SC-010**: 100% of admin attempts to access raw user content are denied (verified by testing).
- **SC-011**: Pause and resume produce 0 duplicate items in a verification test.
- **SC-012**: For users with a generated profile, a draft is ready within 1 minute of the request.
- **SC-013**: At least 70% of rated drafts are rated "sounds like me".
- **SC-014**: In testing, 100% of first imports show the filter step and import nothing before the user confirms their choices.

## Assumptions

- Web application first; native mobile apps are out of scope.
- The interface is English first; content in other languages is accepted and processed.
- The default import window is full history unless the user picks a range.
- The first admin is provisioned outside the product; later admins are granted in the admin panel.
- The default minimum authored-content threshold is about 50 sent emails or equivalent text, adjustable by admins.
- Processing user content requires explicit consent at connection time and follows GDPR-style principles (purpose limitation, access, erasure).
- The memory store is an external service chosen by the business; its availability and deletion behaviour affect SC-009.
- App verification or security review required by Google and Microsoft for mailbox access is an external dependency that may affect launch timing.
- Sign-in providers' availability and policies (for example Apple private relay) are external dependencies.
- Publishing to social networks is out of scope; users copy or export drafts.
- The four credential filter categories (passwords and passphrases, one-time and verification codes, password-reset and verification links, API keys and access tokens) are always excluded and cannot be unselected, because the original request says passwords must never reach the memory store; all other filter categories are selected by default and each user can change them.
- One default tone-of-voice definition is provided at launch, so users always have at least one to choose from.
- Calendar, chat and social-network imports are out of scope.
