import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, like } from 'drizzle-orm';
import {
  FILTER_CATEGORIES,
  connectedSource,
  contentItem,
  contentItemOccurrence,
  deletionRequest,
  draft,
  filterPreferences,
  getDb,
  hubCompany,
  hubCompanyDomain,
  hubFact,
  hubFile,
  hubIgnoreRule,
  hubLink,
  hubMailboxSetting,
  hubNote,
  hubPerson,
  hubPersonEmail,
  hubProject,
  hubSearchDoc,
  hubSyncItem,
  hubThread,
  ownAnalysisPrompt,
  ownAnalysisPromptVersion,
  profileGeneration,
  profileVersion,
  promptTemplate,
  promptTemplateVersion,
  toneDefinition,
  toneDefinitionVersion,
  toneProfile,
  upload,
  user,
} from '@voicespark/db';
import { encrypt, hmacHex, subjectRef } from '@voicespark/core/crypto';
// The hub modules are not package exports; the seed reaches them by path.
import { createFsBlobStore } from '@voicespark/core/hub/blob-store';
import {
  addressHash,
  matchHash,
  matchKey,
  nameKey,
  type HubNameKind,
} from '@voicespark/core/hub/normalize';
import { indexTokens } from '@voicespark/core/hub/search-tokens';

/** Planted inside every encrypted column; no admin response may ever contain it. */
export const SECRET_MARKER = 'ZZ-SECRET-MARKER';

/** Ids of the Context Hub rows seeded for one user; every encrypted column carries `${SECRET_MARKER}-H*`. */
export interface HubSeed {
  personId: string;
  companyId: string;
  projectId: string;
  linkId: string;
  noteId: string;
  fileId: string;
  threadId: string;
  factId: string;
  ignoreRuleId: string;
  syncItemId: string;
  mailboxSourceId: string;
}

export interface IsolationSeed {
  runId: string;
  /** Temp `HUB_FILES_DIR` holding the seeded hub file blobs; removed by cleanup. */
  hubFilesDir: string;
  adminA: string;
  adminB: string;
  userU: string;
  definitionId: string;
  definitionVersionId: string;
  promptId: string;
  promptVersionId: string;
  u: {
    gmailSourceId: string;
    uploadsSourceId: string;
    contentItemId: string;
    uploadId: string;
    profileId: string;
    profileVersionId: string;
    generationId: string;
    deletionRequestId: string;
    draftId: string;
    ownPromptId: string;
    ownPromptVersionId: string;
    documentVersionId: string;
    hub: HubSeed;
  };
  a: { sourceId: string; contentItemId: string; profileId: string; hub: HubSeed };
}

async function createUser(runId: string, label: string, role: 'user' | 'admin'): Promise<string> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: `Isolation ${label}`, email: `iso-${label}-${runId}@example.test`, role })
    .returning({ id: user.id });
  return row!.id;
}

async function createSource(userId: string, type: 'gmail' | 'uploads'): Promise<string> {
  const [row] = await getDb()
    .insert(connectedSource)
    .values({
      userId,
      type,
      accountLabel: type === 'uploads' ? 'Uploads & notes' : 'Isolation mailbox',
      accountAddress: type === 'uploads' ? null : `${randomUUID()}@example.test`,
      status: 'connected',
      itemCount: 1,
      consentTextVersion: 'v1',
    })
    .returning({ id: connectedSource.id });
  return row!.id;
}

async function createItem(userId: string, sourceId: string): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(contentItem)
    .values({
      id,
      userId,
      kind: 'email',
      authorship: 'authored',
      itemDate: new Date(),
      wordCount: 42,
      contentHash: randomBytes(32).toString('hex'),
      filterPolicyVersion: 1,
      status: 'active',
    });
  await getDb()
    .insert(contentItemOccurrence)
    .values({ contentItemId: id, sourceId, providerRef: randomUUID(), isSent: true });
  return id;
}

async function createProfile(
  seed: Pick<IsolationSeed, 'definitionId' | 'definitionVersionId' | 'promptVersionId'>,
  userId: string,
  sourceId: string,
  marker: string,
): Promise<{ profileId: string; versionId: string }> {
  const db = getDb();
  const [profile] = await db
    .insert(toneProfile)
    .values({ userId, definitionId: seed.definitionId, authoredWordsAtLatest: 42 })
    .returning({ id: toneProfile.id });
  const [version] = await db
    .insert(profileVersion)
    .values({
      profileId: profile!.id,
      versionNumber: 1,
      origin: 'generated',
      definitionVersionId: seed.definitionVersionId,
      promptVersionId: seed.promptVersionId,
      bodyEnc: encrypt(
        'user-content',
        JSON.stringify({ summary: `${marker} summary`, excerpts: [`${marker} excerpt`] }),
      ),
      feedbackEnc: encrypt('user-content', `${marker} adjustment note`),
      languages: ['en'],
      contributingSourceIds: [sourceId],
      contributingItemCount: 1,
      rating: 'sounds_like_me',
      ratedAt: new Date(),
    })
    .returning({ id: profileVersion.id });
  await db
    .update(toneProfile)
    .set({ latestVersionId: version!.id })
    .where(eq(toneProfile.id, profile!.id));
  return { profileId: profile!.id, versionId: version!.id };
}

/** An own analysis prompt in use, with one version whose text carries `marker`. */
async function createOwnPrompt(
  seed: Pick<IsolationSeed, 'definitionId' | 'definitionVersionId'>,
  userId: string,
  marker: string,
): Promise<{ ownPromptId: string; versionId: string }> {
  const db = getDb();
  const text = `${marker} my own analysis prompt: describe my voice.`;
  const [own] = await db
    .insert(ownAnalysisPrompt)
    .values({ userId, definitionId: seed.definitionId, inUse: false })
    .returning({ id: ownAnalysisPrompt.id });
  const [version] = await db
    .insert(ownAnalysisPromptVersion)
    .values({
      ownPromptId: own!.id,
      versionNumber: 1,
      promptTextEnc: encrypt('user-content', text),
      charCount: text.length,
      basedOnDefinitionVersionId: seed.definitionVersionId,
    })
    .returning({ id: ownAnalysisPromptVersion.id });
  await db
    .update(ownAnalysisPrompt)
    .set({ inUse: true, currentVersionId: version!.id })
    .where(eq(ownAnalysisPrompt.id, own!.id));
  return { ownPromptId: own!.id, versionId: version!.id };
}

/** A tone-of-voice document (format 'document') made with the own prompt, now the latest version. */
async function createDocumentVersion(
  seed: Pick<IsolationSeed, 'definitionVersionId' | 'promptVersionId'>,
  profileId: string,
  ownPromptVersionId: string,
  sourceId: string,
  contentItemId: string,
  marker: string,
): Promise<string> {
  const db = getDb();
  const document = {
    aspects: [{ key: 'tone', name: 'Tone' }],
    summary: `${marker} document summary`,
    sections: [{ aspectKey: 'tone', heading: 'Tone', markdown: `${marker} section body` }],
    doList: [`${marker} do`],
    dontList: [`${marker} dont`],
    excerpts: [1, 2, 3].map((n) => ({
      text: `${marker} excerpt ${n}`,
      sampleRef: `A${n}`,
      contentItemId,
      aspectKeys: ['tone'],
    })),
    languages: [{ code: 'en', share: 1 }],
  };
  const [version] = await db
    .insert(profileVersion)
    .values({
      profileId,
      versionNumber: 2,
      origin: 'generated',
      definitionVersionId: seed.definitionVersionId,
      promptVersionId: seed.promptVersionId,
      bodyEnc: encrypt('user-content', JSON.stringify(document)),
      languages: ['en'],
      contributingSourceIds: [sourceId],
      contributingItemCount: 1,
      format: 'document',
      promptSource: 'own',
      ownPromptVersionId,
    })
    .returning({ id: profileVersion.id });
  await db
    .update(toneProfile)
    .set({ latestVersionId: version!.id })
    .where(eq(toneProfile.id, profileId));
  return version!.id;
}

const enc = (value: string) => encrypt('user-content', value);

/**
 * One person, company and project (`-H1..3`) with an email and a domain, a person-company link
 * (role `-H4`), a note (`-H5`), a file with a blob (`-H6`), a summarised thread (`-H7`), a
 * suggested fact (`-H8`), an ignore rule (`-H9`), a search doc, a sync item and a hub-enabled
 * mailbox on `sourceId`. Encrypted as the hub services do; keys and tokens are the real HMACs.
 */
async function createHubData(userId: string, sourceId: string, filesDir: string): Promise<HubSeed> {
  const db = getDb();
  const m = SECRET_MARKER;
  const keys = (kind: HubNameKind, name: string) => ({
    nameEnc: enc(name),
    nameKey: nameKey(userId, kind, name),
    matchKey: matchKey(userId, kind, name),
  });

  const personName = `${m}-H1`;
  const [person] = await db
    .insert(hubPerson)
    .values({
      userId,
      ...keys('person', personName),
      roleTitleEnc: enc(`${m}-H1 role title`),
      phoneEnc: enc(`${m}-H1 +48 600 000 000`),
      descriptionEnc: enc(`${m}-H1 description`),
    })
    .returning({ id: hubPerson.id });
  const email = `${m}-H1@example.test`;
  await db.insert(hubPersonEmail).values({
    userId,
    personId: person!.id,
    addressEnc: enc(email),
    addressHash: addressHash(email),
    matchHash: matchHash(email),
    isPrimary: true,
    origin: 'user',
  });

  const [company] = await db
    .insert(hubCompany)
    .values({
      userId,
      ...keys('company', `${m}-H2`),
      websiteEnc: enc(`https://${m}-h2.example.test/`),
      industryEnc: enc(`${m}-H2 industry`),
      descriptionEnc: enc(`${m}-H2 description`),
    })
    .returning({ id: hubCompany.id });
  const domain = `${m}-h2.example.test`.toLowerCase();
  await db.insert(hubCompanyDomain).values({
    userId,
    companyId: company!.id,
    domainEnc: enc(domain),
    domainHash: hmacHex(domain),
    origin: 'user',
  });

  const [project] = await db
    .insert(hubProject)
    .values({
      userId,
      ...keys('project', `${m}-H3`),
      status: 'active',
      descriptionEnc: enc(`${m}-H3 description`),
    })
    .returning({ id: hubProject.id });

  const [link] = await db
    .insert(hubLink)
    .values({
      userId,
      kind: 'person_company',
      personId: person!.id,
      companyId: company!.id,
      roleEnc: enc(`${m}-H4`),
      roleOwnerSet: true,
      origin: 'user',
    })
    .returning({ id: hubLink.id });

  const noteText = `${m}-H5`;
  const [note] = await db
    .insert(hubNote)
    .values({
      userId,
      personId: person!.id,
      titleEnc: enc(noteText),
      bodyJsonEnc: enc(
        JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: noteText }] }],
        }),
      ),
    })
    .returning({ id: hubNote.id });

  const fileText = `${m}-H6`;
  const bytes = new TextEncoder().encode(`${fileText} file body`);
  const storageKey = randomUUID();
  const { keyId } = await createFsBlobStore(filesDir).put(userId, storageKey, bytes);
  const [file] = await db
    .insert(hubFile)
    .values({
      userId,
      companyId: company!.id,
      nameEnc: enc(`${fileText}.txt`),
      descriptionEnc: enc(fileText),
      mimeType: 'text/plain',
      extension: 'txt',
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storageKey,
      keyId,
      extractionStatus: 'extracted',
      extractedTextEnc: enc(fileText),
    })
    .returning({ id: hubFile.id });

  const threadText = `${m}-H7`;
  const [thread] = await db
    .insert(hubThread)
    .values({
      userId,
      threadKey: hmacHex(`hubthread:${userId}:${randomUUID()}`),
      subjectEnc: enc(threadText),
      participantsEnc: enc(JSON.stringify([`${threadText}@example.test`])),
      firstMessageAt: new Date(),
      lastMessageAt: new Date(),
      messageCount: 1,
      language: 'en',
      summaryEnc: enc(threadText),
      summaryVersion: 1,
      summaryUpdatedAt: new Date(),
      status: 'done',
      processedVersion: 1,
      processedAt: new Date(),
    })
    .returning({ id: hubThread.id });

  const [fact] = await db
    .insert(hubFact)
    .values({
      userId,
      threadId: thread!.id,
      type: 'field',
      state: 'suggested',
      basis: 'signature',
      personId: person!.id,
      field: 'roleTitle',
      valueEnc: enc(`${m}-H8`),
      previousValueEnc: enc(`${m}-H8 previous`),
      conflict: true,
      confidence: 0.6,
      evidenceEnc: enc(`${m}-H8`),
      fingerprint: hmacHex(`hubfact:${userId}:${randomUUID()}`),
      reason: 'conflict',
      policyVersion: '1',
      promptVersion: 'iso-seed',
    })
    .returning({ id: hubFact.id });

  const ignored = `${m}-H9@example.test`;
  const [ignoreRule] = await db
    .insert(hubIgnoreRule)
    .values({ userId, kind: 'address', valueEnc: enc(ignored), valueHash: addressHash(ignored) })
    .returning({ id: hubIgnoreRule.id });

  await db.insert(hubSearchDoc).values({
    userId,
    itemType: 'note',
    itemId: note!.id,
    ownerKind: 'person',
    ownerId: person!.id,
    tokens: indexTokens(userId, [noteText]),
    updatedAt: new Date(),
  });

  const [syncItem] = await db
    .insert(hubSyncItem)
    .values({
      userId,
      entityType: 'person',
      entityId: person!.id,
      docId: `hub_person_${person!.id}`,
      status: 'failed',
      attempts: 1,
      lastErrorCode: 'memory_unavailable',
    })
    .returning({ id: hubSyncItem.id });

  await db.insert(hubMailboxSetting).values({
    sourceId,
    userId,
    enabled: true,
    consentTextVersion: 'v1',
    enabledAt: new Date(),
    backfillState: 'done',
    threadsProcessed: 1,
    lastRunAt: new Date(),
  });

  return {
    personId: person!.id,
    companyId: company!.id,
    projectId: project!.id,
    linkId: link!.id,
    noteId: note!.id,
    fileId: file!.id,
    threadId: thread!.id,
    factId: fact!.id,
    ignoreRuleId: ignoreRule!.id,
    syncItemId: syncItem!.id,
    mailboxSourceId: sourceId,
  };
}

async function ensureDraftPromptVersion(createdBy: string): Promise<string> {
  const db = getDb();
  const key = 'draft.social_post';
  const [existing] = await db
    .select({ activeVersionId: promptTemplate.activeVersionId })
    .from(promptTemplate)
    .where(eq(promptTemplate.key, key))
    .limit(1);
  if (existing?.activeVersionId) return existing.activeVersionId;
  await db
    .insert(promptTemplate)
    .values({ key, isSystem: true, description: 'Draft a social post', createdBy })
    .onConflictDoNothing();
  const [template] = await db
    .select({ id: promptTemplate.id })
    .from(promptTemplate)
    .where(eq(promptTemplate.key, key));
  const [version] = await db
    .insert(promptTemplateVersion)
    .values({
      promptTemplateId: template!.id,
      versionNumber: 1,
      status: 'active',
      systemTemplate: 'You write social posts.',
      userTemplate: 'Write the post.',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      maxTokens: 1024,
      createdBy,
      publishedBy: createdBy,
      publishedAt: new Date(),
    })
    .returning({ id: promptTemplateVersion.id });
  await db
    .update(promptTemplate)
    .set({ activeVersionId: version!.id })
    .where(eq(promptTemplate.id, template!.id));
  return version!.id;
}

/**
 * Admins A and B (two, so `last_admin` never trips), user U with content in every encrypted
 * column (including an own analysis prompt and a tone-of-voice document), and an admin-owned source/item/profile so list endpoints can be checked for leakage.
 */
export async function seedIsolation(): Promise<IsolationSeed> {
  const db = getDb();
  const runId = randomUUID().slice(0, 8);
  // Hub file blobs go to a temp HUB_FILES_DIR; the env is set too so code under test reads the same dir.
  const hubFilesDir = await mkdtemp(join(tmpdir(), 'voicespark-iso-hub-'));
  process.env.HUB_FILES_DIR = hubFilesDir;
  const adminA = await createUser(runId, 'admin-a', 'admin');
  const adminB = await createUser(runId, 'admin-b', 'admin');
  const userU = await createUser(runId, 'user-u', 'user');

  for (const userId of [adminA, userU]) {
    await db
      .insert(filterPreferences)
      .values({ userId, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: new Date() });
  }

  const [definition] = await db
    .insert(toneDefinition)
    .values({ key: `iso_seed_${runId}`, availability: 'retired', createdBy: adminA })
    .returning({ id: toneDefinition.id });
  const [definitionVersion] = await db
    .insert(toneDefinitionVersion)
    .values({
      definitionId: definition!.id,
      versionNumber: 1,
      status: 'active',
      name: 'Isolation seed',
      description: 'Seeded by the admin isolation suite',
      analysisPrompt: 'Describe how this person writes: tone, rhythm and word choice.',
      createdBy: adminA,
      publishedBy: adminA,
      publishedAt: new Date(),
    })
    .returning({ id: toneDefinitionVersion.id });
  await db
    .update(toneDefinition)
    .set({ activeVersionId: definitionVersion!.id })
    .where(eq(toneDefinition.id, definition!.id));

  const [prompt] = await db
    .insert(promptTemplate)
    .values({
      key: `custom.iso_seed_${runId}`,
      isSystem: false,
      description: 'Seeded by the admin isolation suite',
      createdBy: adminA,
    })
    .returning({ id: promptTemplate.id });
  const [promptVersion] = await db
    .insert(promptTemplateVersion)
    .values({
      promptTemplateId: prompt!.id,
      versionNumber: 1,
      status: 'active',
      systemTemplate: 'You describe a writing voice.',
      userTemplate: 'Describe the voice.',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      maxTokens: 1024,
      createdBy: adminA,
      publishedBy: adminA,
      publishedAt: new Date(),
    })
    .returning({ id: promptTemplateVersion.id });
  await db
    .update(promptTemplate)
    .set({ activeVersionId: promptVersion!.id })
    .where(eq(promptTemplate.id, prompt!.id));

  const refs = {
    definitionId: definition!.id,
    definitionVersionId: definitionVersion!.id,
    promptVersionId: promptVersion!.id,
  };

  // User U
  const gmailSourceId = await createSource(userU, 'gmail');
  const uploadsSourceId = await createSource(userU, 'uploads');
  const contentItemId = await createItem(userU, gmailSourceId);
  const uploadItemId = await createItem(userU, uploadsSourceId);
  const [uploadRow] = await db
    .insert(upload)
    .values({
      userId: userU,
      sourceId: uploadsSourceId,
      kind: 'file',
      filename: 'iso-notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 120,
      status: 'stored',
      contentItemId: uploadItemId,
    })
    .returning({ id: upload.id });
  const uProfile = await createProfile(refs, userU, gmailSourceId, `${SECRET_MARKER}-1`);
  const [generation] = await db
    .insert(profileGeneration)
    .values({
      userId: userU,
      profileId: uProfile.profileId,
      kind: 'feedback',
      status: 'succeeded',
      definitionVersionId: refs.definitionVersionId,
      promptVersionId: refs.promptVersionId,
      feedbackEnc: encrypt('user-content', `${SECRET_MARKER}-2 feedback`),
      resultVersionId: uProfile.versionId,
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning({ id: profileGeneration.id });
  const [deletion] = await db
    .insert(deletionRequest)
    .values({
      userId: userU,
      subjectRef: subjectRef(userU),
      scope: 'content_item',
      targetId: contentItemId,
      requestedBy: 'user',
      dueBy: new Date(Date.now() + 24 * 3600 * 1000),
      notifyEmailEnc: encrypt('user-content', `${SECRET_MARKER}-3@example.test`),
    })
    .returning({ id: deletionRequest.id });
  const ownPrompt = await createOwnPrompt(refs, userU, `${SECRET_MARKER}-6`);
  const documentVersionId = await createDocumentVersion(
    refs,
    uProfile.profileId,
    ownPrompt.versionId,
    gmailSourceId,
    contentItemId,
    `${SECRET_MARKER}-7`,
  );

  // The system prompt for social posts: drafts pin its active version. Created when the test DB
  // was migrated but never seeded; the row is global and shared, so cleanup leaves it in place.
  const draftPromptVersionId = await ensureDraftPromptVersion(adminA);
  const [draftRow] = await db
    .insert(draft)
    .values({
      userId: userU,
      contentType: 'social_post',
      profileId: uProfile.profileId,
      profileVersionId: uProfile.versionId,
      promptVersionId: draftPromptVersionId,
      topicEnc: encrypt('user-content', `${SECRET_MARKER}-4 topic`),
      briefEnc: encrypt('user-content', `${SECRET_MARKER}-4 brief`),
      generatedTextEnc: encrypt('user-content', `${SECRET_MARKER}-5 generated text`),
      status: 'ready',
      rating: 'sounds_like_me',
      ratedAt: new Date(),
      completedAt: new Date(),
    })
    .returning({ id: draft.id });

  const uHub = await createHubData(userU, gmailSourceId, hubFilesDir);

  // Admin A's own data
  const aSourceId = await createSource(adminA, 'gmail');
  const aItemId = await createItem(adminA, aSourceId);
  const aProfile = await createProfile(refs, adminA, aSourceId, `${SECRET_MARKER}-A`);
  const aHub = await createHubData(adminA, aSourceId, hubFilesDir);

  return {
    runId,
    hubFilesDir,
    adminA,
    adminB,
    userU,
    definitionId: refs.definitionId,
    definitionVersionId: refs.definitionVersionId,
    promptId: prompt!.id,
    promptVersionId: refs.promptVersionId,
    u: {
      gmailSourceId,
      uploadsSourceId,
      contentItemId,
      uploadId: uploadRow!.id,
      profileId: uProfile.profileId,
      profileVersionId: uProfile.versionId,
      generationId: generation!.id,
      deletionRequestId: deletion!.id,
      draftId: draftRow!.id,
      ownPromptId: ownPrompt.ownPromptId,
      ownPromptVersionId: ownPrompt.versionId,
      documentVersionId,
      hub: uHub,
    },
    a: { sourceId: aSourceId, contentItemId: aItemId, profileId: aProfile.profileId, hub: aHub },
  };
}

/** Removes everything the run created, including definitions/prompts made by the scenario. */
export async function cleanupIsolation(seed: IsolationSeed): Promise<void> {
  const db = getDb();
  const userIds = [seed.adminA, seed.adminB, seed.userU];
  await db.delete(deletionRequest).where(inArray(deletionRequest.userId, userIds));
  await db.delete(user).where(inArray(user.id, userIds));
  const definitionIds = (
    await db
      .select({ id: toneDefinition.id })
      .from(toneDefinition)
      .where(like(toneDefinition.key, `iso_%${seed.runId}`))
  ).map((r) => r.id);
  if (definitionIds.length > 0) {
    await db
      .update(toneDefinition)
      .set({ activeVersionId: null })
      .where(inArray(toneDefinition.id, definitionIds));
    await db.delete(toneDefinition).where(inArray(toneDefinition.id, definitionIds));
  }
  await db.delete(promptTemplate).where(like(promptTemplate.key, `custom.iso_%${seed.runId}`));
  // Hub rows cascade with the users; the blobs live in the run's temp dir.
  await rm(seed.hubFilesDir, { recursive: true, force: true });
}
