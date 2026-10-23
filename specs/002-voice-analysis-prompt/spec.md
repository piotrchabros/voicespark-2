# Feature Specification: Tone-of-Voice Analysis Prompt with Per-User Override

**Feature Branch**: `002-voice-analysis-prompt`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Tone-of-voice analysis prompt with per-user override, producing a tone-of-voice document. Change to the existing tone-of-voice feature (spec 001). Today an admin edits a versioned generation prompt plus 'definitions' with fixed dimensions (formality, warmth, sentence length, vocabulary, humour, signature phrases), and generation returns a rigid structured profile with a value per dimension. New behaviour: the admin defines the tone-of-voice analysis prompt (which aspects of the user's emails, notes and files to analyse and how to describe them), versioned, and its active version is the default for every user. Each user can override it with their own version, starting from a copy of the default, edit it, preview the difference and reset to the default. Only the tone-of-voice analysis prompt can be overridden, not the drafting prompts. When the admin publishes a new default, users with their own prompt keep it, are notified, can see what changed and switch back in one step. The result is a sectioned tone-of-voice document whose sections follow the aspects named in the prompt, plus a small fixed part needed for drafting (summary, do / don't list, excerpts pointing to the user's own content). Each document records which prompt was used. Existing privacy rules still apply and a user's prompt cannot switch them off or break the format drafting needs. Existing named definitions become named analysis prompts, each with its own admin default and user override. Existing structured profiles stay viewable and usable for drafting until regenerated."

## Context

This feature changes the tone-of-voice part of spec 001 (User Stories 5 and 6; FR-028 to FR-035, FR-039 to FR-042, FR-065 to FR-069). Everything in spec 001 not mentioned here stays as it is, including content filtering, the authored-content rules, versioning of admin templates, drafting, and admin isolation from user content.

The main shift: what to analyse is no longer a fixed list of dimensions set in a definition. It is described in words in an **analysis prompt**, and the output is a **tone-of-voice document** shaped by that prompt.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin defines the default analysis prompt (Priority: P1)

An admin writes the analysis prompt for a voice, such as "LinkedIn voice". The prompt lists which aspects of the user's writing to analyse (for example vocabulary, sentence rhythm, how emails open and close, use of humour, recurring phrases, formality towards different audiences) and how to describe each one. The admin works on a draft, previews it, and publishes it. The published version becomes the default for every user of that voice. Earlier versions stay in the history and the admin can roll back.

**Why this priority**: Every user's tone of voice depends on this prompt. Without it nothing else in this feature works.

**Independent Test**: An admin edits a draft analysis prompt to add a new aspect, publishes it, and the next generated document for a user without their own prompt contains a section for that aspect.

**Acceptance Scenarios**:

1. **Given** an admin editing a draft analysis prompt, **When** they have not published it, **Then** no user's generation uses it.
2. **Given** an admin who publishes a new version, **When** a user without their own prompt generates their tone of voice, **Then** the new version is used and the document records that version.
3. **Given** an admin, **When** they open the analysis prompt, **Then** they see its version history (who, when, what changed) and can roll back to any version.
4. **Given** an admin, **When** they preview a draft analysis prompt, **Then** they see it run against built-in sample writing, never against any real user's content.
5. **Given** a draft analysis prompt that would remove the parts drafting needs, **When** the admin tries to publish, **Then** publishing is still allowed because the fixed parts are added by the system, not by the prompt text (see FR-010).

---

### User Story 2 - Tone-of-voice document generated from the prompt (Priority: P1)

A user generates their tone of voice. The system analyses their own authored, filtered content following the analysis prompt that applies to them, and produces a readable document. Its sections follow the aspects the prompt names. It also always contains a short summary, a "do / don't" list and short example excerpts, each pointing back to the user's own source content. The user reads it, regenerates it, gives written feedback, or edits the text directly; every change is a new version.

**Why this priority**: The document is the product's core output and is what drafting uses.

**Independent Test**: With a prompt naming five aspects, generate a document and confirm it has a section per aspect, a summary, a do / don't list and excerpts that link only to the user's authored content.

**Acceptance Scenarios**:

1. **Given** a user with enough authored content, **When** they generate, **Then** they get a document with one section per aspect named in the applicable prompt, plus the summary, do / don't list and excerpts.
2. **Given** a generated document, **When** the user opens an excerpt, **Then** they can see which of their own items it came from.
3. **Given** a document, **When** the user gives written feedback (for example "I am less formal with clients than this says"), **Then** a revised version is created and the previous one stays viewable.
4. **Given** a document, **When** the user edits its text directly and saves, **Then** a new version is created and is used for later drafts.
5. **Given** a mailbox with received emails, **When** a document is generated, **Then** received-only content is never quoted or described as the user's own writing.
6. **Given** a content category the user has excluded, **When** a document is generated, **Then** no excerpt or description contains content from that category.
7. **Given** a draft request, **When** the user picks a voice, **Then** the draft follows that voice's current document.

---

### User Story 3 - User tailors their own analysis prompt (Priority: P2)

A user who wants their tone of voice analysed differently opens the analysis prompt for one of their voices. They start from a copy of the admin default and change it: add aspects that matter to them, remove ones that do not, or change how aspects should be described. They can compare their version with the default at any time and reset to the default in one step. Their next generation uses their own prompt.

**Why this priority**: This is the new capability the business asked for, but it builds on stories 1 and 2.

**Independent Test**: A user copies the default, adds the aspect "how I sign off emails", saves, regenerates, and the document has a section for it; another user without their own prompt does not get that section.

**Acceptance Scenarios**:

1. **Given** a user without their own prompt, **When** they choose to customise, **Then** the editor opens with a copy of the current admin default for that voice.
2. **Given** a user editing their own prompt, **When** they save, **Then** it is stored as a new version of their own prompt and is used for their next generation of that voice.
3. **Given** a user with their own prompt, **When** they open the comparison, **Then** they see the differences between their prompt and the current admin default.
4. **Given** a user with their own prompt, **When** they reset to the default, **Then** their next generation uses the admin default and their own prompt's history stays available to them.
5. **Given** a user with their own prompt for "LinkedIn voice", **When** they generate "Email voice", **Then** "Email voice" uses its own applicable prompt, not the LinkedIn one.
6. **Given** a user's own prompt that asks to quote received emails, ignore filters, or return a different format, **When** a document is generated, **Then** those instructions have no effect: privacy rules and the required document parts still apply.
7. **Given** a user, **When** they look for a way to change the drafting prompts, **Then** none is offered.

---

### User Story 4 - Default changes while a user has their own prompt (Priority: P2)

An admin publishes a new default analysis prompt. Users who use the default get it automatically. Users who have their own prompt keep using it, but they are told the default changed, can see what changed in the default, and can switch back to the default in one step.

**Why this priority**: Without it, tailored users silently miss improvements the business makes.

**Independent Test**: A user with their own prompt sees a notice after the admin publishes a new default, opens the change view, and switches to the default; the next generation records the new default version.

**Acceptance Scenarios**:

1. **Given** a user with their own prompt, **When** the admin publishes a new default for that voice, **Then** the user's own prompt stays in use and the user gets a notification.
2. **Given** that notification, **When** the user opens it, **Then** they see what changed between the default version they started from and the new default.
3. **Given** that notification, **When** the user switches to the default, **Then** their next generation uses the new default.
4. **Given** a user who uses the default, **When** the admin publishes a new default, **Then** they get no notification and their next generation uses the new default.

---

### User Story 5 - Existing profiles keep working (Priority: P3)

Users who already have profiles in the old format (a value per fixed dimension) can still see them and use them for drafting. The next time they generate, they get a document in the new format.

**Why this priority**: It protects existing users during the change but adds no new value.

**Independent Test**: A user with an old-format profile opens it, writes a draft with it, then regenerates and receives a new-format document as the next version.

**Acceptance Scenarios**:

1. **Given** an old-format profile, **When** the user opens it, **Then** it is shown readably.
2. **Given** an old-format profile, **When** the user requests a draft with it, **Then** the draft is produced.
3. **Given** an old-format profile, **When** the user regenerates, **Then** the new version is a document in the new format and the old version stays viewable.

### Edge Cases

- The admin retires a voice while users have their own prompts for it: no new versions are generated for that voice; existing documents and the users' own prompts stay viewable to their owners.
- A user's own prompt is empty or only whitespace: saving is refused with an explanation.
- A user's own prompt exceeds the length limit: saving is refused and the limit is shown.
- The generated document is missing a required part (summary, do / don't list or excerpts) or cannot be read: the generation fails, no version is saved, and the user is told to try again; the previous version stays current.
- The admin publishes a new default while a generation is running: the generation finishes on the prompt version it started with.
- A user edits their own prompt while a generation is running: the generation finishes on the version it started with.
- An admin rolls the default back to an older version: users on the default get the rolled-back version; users with their own prompt are notified as for any new default.
- A user deletes their account: their own prompts, their versions and all documents are deleted with the rest of their data.
- An excerpt's source item is deleted later: the excerpt is removed from current and stored document versions within the deletion deadline from spec 001, and the user is offered regeneration.

## Requirements *(mandatory)*

### Functional Requirements

**Analysis prompts (admin)**

- **FR-001**: Each tone-of-voice definition MUST have an analysis prompt written by admins that states which aspects of the user's writing to analyse and how to describe them. This replaces the fixed list of dimensions as the description of what is analysed.
- **FR-002**: Analysis prompts MUST keep the versioning rules for admin templates from spec 001: draft and active versions, one active version at a time, publish without a product release, rollback, and history of who changed what and when.
- **FR-003**: The active version of a definition's analysis prompt MUST be the default for every user of that definition who has no own prompt for it.
- **FR-004**: Admins MUST be able to preview a draft analysis prompt against built-in sample writing only, never against real user content.
- **FR-005**: Admins MUST NOT be able to read users' own prompts or the documents generated from them. Admins MAY see, per definition, how many users have their own prompt.

**Own prompts (user)**

- **FR-006**: Users MUST be able to create their own analysis prompt for any definition they have chosen, starting from a copy of the current default for that definition.
- **FR-007**: Users MUST be able to edit and save their own prompt; each save MUST create a new version, and users MUST be able to view their earlier versions.
- **FR-008**: Users MUST be able to compare their own prompt with the current default and reset to the default in one step. Resetting MUST NOT delete their own prompt's history.
- **FR-009**: Only the analysis prompt MUST be customisable by users. Drafting prompts and the feedback-revision instructions MUST NOT be.
- **FR-010**: The system MUST apply privacy rules and the required document parts independently of any prompt text. Whatever a prompt says, admin or user, generation MUST NOT quote received content, use content from excluded categories, drop the summary, do / don't list or excerpts, or change the document format.
- **FR-011**: Own prompts MUST be refused when empty or longer than the length limit (see Assumptions), with an explanation.

**Default changes**

- **FR-012**: When an admin publishes or rolls back a definition's analysis prompt, users with their own prompt for that definition MUST keep using it and MUST receive an in-app notification.
- **FR-013**: The notification MUST let the user see what changed between the default version their own prompt was based on and the new default, and switch to the default in one step.
- **FR-014**: Users without their own prompt MUST use the new default for their next generation without being notified.

**Tone-of-voice document**

- **FR-015**: Generation MUST produce a readable, sectioned tone-of-voice document, with one section for each aspect named in the prompt used.
- **FR-016**: Every document MUST also contain a short summary, a "do / don't" list, and short example excerpts; each excerpt MUST identify the user's own source item it came from.
- **FR-017**: Generation MUST use only the user's own authored, filtered content as evidence of their voice (spec 001, FR-028). Received content MAY be used as context and MUST NOT be quoted or described as the user's writing. Excluded categories MUST NOT appear (spec 001, FR-059).
- **FR-018**: Each document version MUST record which prompt was used (the default version, or the user's own prompt version), the definition it belongs to, and its creation time.
- **FR-019**: A generation in progress MUST finish with the prompt version that was current when it started.
- **FR-020**: Users MUST be able to view, regenerate, give written feedback on and directly edit each document. Each change MUST create a new version; earlier versions MUST stay viewable.
- **FR-021**: A generated document missing a required part MUST be rejected: no version is saved and the user is told the generation failed.
- **FR-022**: Drafting MUST use the selected voice's current document in place of the old structured profile.
- **FR-023**: Existing rules for content threshold, languages noted, suggested regeneration, automatic first generation, choosing several definitions, retiring definitions and deletion (spec 001, FR-029, FR-034, FR-035, FR-065 to FR-069, FR-047) MUST apply to documents in the same way as to profiles.

**Existing profiles**

- **FR-024**: Profiles created in the old format MUST remain viewable and usable for drafting. The next generation for that definition MUST produce a new-format document as a new version, keeping the old version viewable.
- **FR-025**: The default analysis prompt for each existing definition MUST be created from its current prompt and dimensions, so the first new-format documents cover the same aspects as before.

**Audit**

- **FR-026**: The system MUST record audit entries for admin changes to analysis prompts and for users creating, changing or resetting their own prompt, without storing prompt text from users or any content.

### Key Entities

- **Tone-of-Voice Definition**: A named voice such as "LinkedIn voice", with a user-facing description and an availability state (available or retired). It now owns an analysis prompt instead of a fixed list of dimensions.
- **Analysis Prompt (default)**: The admin-written instructions for a definition; versioned with draft and active states, author and timestamps.
- **Own Analysis Prompt**: A user's own version of the analysis prompt for one definition; versioned; records which default version it was copied from; belongs to one user; whether it is in use or the user has reset to the default.
- **Tone-of-Voice Document**: A versioned document for one user and one definition: sections per aspect, summary, do / don't list, excerpts with links to source items, the prompt used, how it was made (generated, feedback, direct edit), and creation time. Old-format profiles are earlier versions of the same thing.
- **Default-Change Notification**: An in-app notice to a user with an own prompt that the default for that definition changed, linking to the comparison and the reset action.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A published change to a default analysis prompt applies to the next generation of every user without their own prompt within 1 minute, without a product release.
- **SC-002**: A user can go from "customise" to a saved own prompt in under 3 minutes.
- **SC-003**: In 100% of generated documents, every aspect named in the prompt used has its own section, and the summary, do / don't list and at least one excerpt are present.
- **SC-004**: In 100% of generated documents, every excerpt traces to an authored item of the same user; 0 excerpts come from received-only content or excluded categories, including when the user's own prompt asks otherwise.
- **SC-005**: Users with their own prompt are notified of a new default within 1 minute of publishing, and can switch to the default in one action.
- **SC-006**: 100% of existing old-format profiles stay viewable and usable for drafting after the change.
- **SC-007**: Admins cannot open any user's own prompt or tone-of-voice document; checked by the same admin-isolation tests as in spec 001.

## Assumptions

- An own prompt is limited to 20,000 characters. A default analysis prompt has the same limit.
- Own prompts are per user and per definition; a user can have at most one own prompt in use per definition.
- The document is shown as formatted text; users edit it as plain text with simple formatting (headings, lists, bold).
- Direct edits to the document are not re-checked against the user's content; they are the user's own words about their voice.
- Previewing a draft prompt as an admin uses a fixed set of sample writing kept with the product.
- The "dimensions" fields of existing definitions are kept only to build the first default analysis prompt (FR-025) and to show old-format profiles; they are no longer edited.
- Users are not shown a preview run of their own prompt before saving; they see its effect on their next generation.
- The feedback-revision step and the drafting prompts stay admin-only, as in spec 001.
