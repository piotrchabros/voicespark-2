import { randomBytes, randomUUID } from 'node:crypto';
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
import { encrypt, subjectRef } from '@voicespark/core/crypto';

/** Planted inside every encrypted column; no admin response may ever contain it. */
export const SECRET_MARKER = 'ZZ-SECRET-MARKER';

export interface IsolationSeed {
  runId: string;
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
  };
  a: { sourceId: string; contentItemId: string; profileId: string };
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
 * column, and an admin-owned source/item/profile so list endpoints can be checked for leakage.
 */
export async function seedIsolation(): Promise<IsolationSeed> {
  const db = getDb();
  const runId = randomUUID().slice(0, 8);
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
      dimensions: [
        {
          key: 'formality',
          name: 'Formality',
          description: 'How formal the writing is',
          valueType: 'scale',
          scale: { min: 1, max: 5, minLabel: 'casual', maxLabel: 'formal' },
        },
      ],
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

  // Admin A's own data
  const aSourceId = await createSource(adminA, 'gmail');
  const aItemId = await createItem(adminA, aSourceId);
  const aProfile = await createProfile(refs, adminA, aSourceId, `${SECRET_MARKER}-A`);

  return {
    runId,
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
    },
    a: { sourceId: aSourceId, contentItemId: aItemId, profileId: aProfile.profileId },
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
}
