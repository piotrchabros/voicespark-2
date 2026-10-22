import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  connectedSource,
  contentItem,
  getDb,
  profileGeneration,
  profileVersion,
  promptTemplateVersion,
  toneDefinition,
  toneDefinitionVersion,
  toneProfile,
  user,
  userDefinitionChoice,
  withTransaction,
  type Dimension,
  type GenerationBlockReason,
  type ProfileGeneration,
  type ProfileGenerationKind,
  type ProfileGenerationStatus,
  type ProfileOutdatedReason,
  type ProfileRating,
  type ProfileStatus,
  type ProfileVersion,
  type ProfileVersionOrigin,
  type PromptTemplateVersion,
  type ToneDefinition,
  type ToneDefinitionVersion,
  type ToneProfile,
  type Tx,
  type UserStatus,
} from '@voicespark/db';
import { decrypt, encrypt } from '../crypto';
import { AppError, type ServiceContext } from '../errors';
import type { ProfileBody } from '../prompting';
import { enqueue, jobIds } from '../queues';
import { autoChooseIfSingle } from './definitions';
import { inspectForUser, loadOwnAddresses, loadPolicy } from './inspection';
import { notify } from './notifications';
import { getActiveVersion } from './prompts';
import { getSetting } from './settings';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_GENERATION_STATUSES: ProfileGenerationStatus[] = ['queued', 'running'];

export const FEEDBACK_MAX_CHARS = 2000;
export const NOTE_MAX_CHARS = 2000;
const TEXT_VALUE_MAX = 600;
const LIST_ITEM_MAX = 200;
const LIST_MAX_ITEMS = 20;

export interface Eligibility {
  authoredWordCount: number;
  authoredItemCount: number;
  thresholdWords: number;
  eligible: boolean;
}

export interface ProfileListItem {
  id: string;
  definition: { id: string; name: string; retired: boolean };
  status: ProfileStatus;
  latestVersion: { id: string; versionNumber: number; createdAt: string } | null;
  outdatedReason: ProfileOutdatedReason | null;
  canRegenerate: boolean;
  activeGeneration: {
    id: string;
    kind: ProfileGenerationKind;
    status: ProfileGenerationStatus;
  } | null;
}

export interface ProfileVersionView {
  id: string;
  versionNumber: number;
  origin: ProfileVersionOrigin;
  definitionVersion: { id: string; versionNumber: number };
  promptVersion: { id: string; versionNumber: number } | null;
  body: ProfileBody;
  languages: string[];
  rating: ProfileRating | null;
  ratedAt: string | null;
  createdAt: string;
}

export interface ProfileVersionSummary {
  id: string;
  versionNumber: number;
  origin: ProfileVersionOrigin;
  rating: ProfileRating | null;
  createdAt: string;
}

export interface GenerationView {
  id: string;
  status: ProfileGenerationStatus;
  blockReason: GenerationBlockReason | null;
  errorCode: string | null;
  resultVersionId: string | null;
}

type GenerationRef = { id: string; profileId: string };

// ---------------------------------------------------------------------------------------------------------------
// Eligibility and generation requests

/** Active authored items against `profile.min_authored_words` (uncached, FR-029). */
export async function eligibility(ctx: { userId: string }): Promise<Eligibility> {
  const [row] = await getDb()
    .select({
      words: sql<number>`coalesce(sum(${contentItem.wordCount}), 0)::int`,
      items: sql<number>`count(*)::int`,
    })
    .from(contentItem)
    .where(
      and(
        eq(contentItem.userId, ctx.userId),
        eq(contentItem.authorship, 'authored'),
        eq(contentItem.status, 'active'),
      ),
    );
  const thresholdWords = await getSetting('profile.min_authored_words');
  const authoredWordCount = Number(row?.words ?? 0);
  return {
    authoredWordCount,
    authoredItemCount: Number(row?.items ?? 0),
    thresholdWords,
    eligible: authoredWordCount >= thresholdWords,
  };
}

/** Uncached active prompt version id for `key`; missing -> conflict. */
async function activePromptVersionId(key: string): Promise<string> {
  const version = await getActiveVersion(key);
  if (!version) throw new AppError('conflict', 'No active prompt version');
  return version.id;
}

async function enqueueGenerations(userId: string, ids: string[]): Promise<void> {
  for (const generationId of ids) {
    await enqueue('profile.generate', { userId, generationId }, { jobId: jobIds.profile(generationId) });
  }
}

/**
 * Locks the profiles, returns an existing queued/running generation per profile (D-P8) or inserts a new one
 * pinned to the definition's current active version (read inside the transaction, uncached).
 */
async function createGenerations(
  tx: Tx,
  userId: string,
  profileIds: string[],
  kind: ProfileGenerationKind,
  promptVersionId: string,
  opts: { feedbackEnc?: string; reuseActive: boolean; skipIfAnyGeneration?: boolean },
): Promise<{ generations: GenerationRef[]; created: string[] }> {
  const generations: GenerationRef[] = [];
  const created: string[] = [];
  if (profileIds.length === 0) return { generations, created };
  const rows = await tx
    .select({
      id: toneProfile.id,
      status: toneProfile.status,
      availability: toneDefinition.availability,
      activeVersionId: toneDefinition.activeVersionId,
    })
    .from(toneProfile)
    .innerJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
    .where(and(eq(toneProfile.userId, userId), inArray(toneProfile.id, profileIds)))
    .orderBy(asc(toneProfile.createdAt), asc(toneProfile.id))
    .for('update', { of: toneProfile });
  for (const p of rows) {
    if (p.status !== 'active') throw new AppError('conflict', 'Profile is not active');
    if (p.availability !== 'available' || !p.activeVersionId) {
      throw new AppError('definition_retired');
    }
    if (opts.skipIfAnyGeneration) {
      const [any] = await tx
        .select({ id: profileGeneration.id })
        .from(profileGeneration)
        .where(eq(profileGeneration.profileId, p.id))
        .limit(1);
      if (any) continue;
    }
    if (opts.reuseActive) {
      const [existing] = await tx
        .select({ id: profileGeneration.id })
        .from(profileGeneration)
        .where(
          and(
            eq(profileGeneration.profileId, p.id),
            inArray(profileGeneration.status, ACTIVE_GENERATION_STATUSES),
          ),
        )
        .orderBy(asc(profileGeneration.requestedAt), asc(profileGeneration.id))
        .limit(1);
      if (existing) {
        generations.push({ id: existing.id, profileId: p.id });
        continue;
      }
    }
    const [inserted] = await tx
      .insert(profileGeneration)
      .values({
        userId,
        profileId: p.id,
        kind,
        status: 'queued',
        definitionVersionId: p.activeVersionId,
        promptVersionId,
        feedbackEnc: opts.feedbackEnc ?? null,
      })
      .returning({ id: profileGeneration.id });
    if (!inserted) throw new Error('profile_generation_insert_failed');
    generations.push({ id: inserted.id, profileId: p.id });
    created.push(inserted.id);
  }
  return { generations, created };
}

/**
 * Requests generation for the given profiles (default: every active profile). `definitionIds` may name either
 * the chosen definitions (contract) or the profiles themselves; anything else is `not_found` (D-P10).
 * Rate limiting lives in the route (D-U9).
 */
export async function generate(
  ctx: ServiceContext,
  definitionIds?: string[],
): Promise<{ generations: GenerationRef[] }> {
  const active = await getDb()
    .select({
      id: toneProfile.id,
      definitionId: toneProfile.definitionId,
      availability: toneDefinition.availability,
      activeVersionId: toneDefinition.activeVersionId,
    })
    .from(toneProfile)
    .innerJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
    .where(and(eq(toneProfile.userId, ctx.userId), eq(toneProfile.status, 'active')));

  let selected = active;
  if (definitionIds !== undefined) {
    const wanted = [...new Set(definitionIds)];
    selected = [];
    for (const id of wanted) {
      const match = active.find((p) => p.id === id || p.definitionId === id);
      if (!match) throw new AppError('not_found');
      if (!selected.includes(match)) selected.push(match);
    }
  }
  if (selected.length === 0) throw new AppError('no_profile', 'No chosen definition');
  if (selected.some((p) => p.availability !== 'available' || !p.activeVersionId)) {
    throw new AppError('definition_retired');
  }
  if (!(await eligibility(ctx)).eligible) throw new AppError('insufficient_content');

  const promptVersionId = await activePromptVersionId('tone_profile.generate');
  const { generations, created } = await withTransaction((tx) =>
    createGenerations(
      tx,
      ctx.userId,
      selected.map((p) => p.id),
      'generate',
      promptVersionId,
      { reuseActive: true },
    ),
  );
  await enqueueGenerations(ctx.userId, created);
  return { generations };
}

interface OwnedProfile {
  profile: ToneProfile;
  availability: ToneDefinition['availability'];
  activeVersionId: string | null;
}

async function ownedProfile(userId: string, profileId: string): Promise<OwnedProfile> {
  if (!UUID_RE.test(profileId)) throw new AppError('not_found');
  const [row] = await getDb()
    .select({
      profile: toneProfile,
      availability: toneDefinition.availability,
      activeVersionId: toneDefinition.activeVersionId,
    })
    .from(toneProfile)
    .innerJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
    .where(and(eq(toneProfile.id, profileId), eq(toneProfile.userId, userId)))
    .limit(1);
  if (!row) throw new AppError('not_found');
  return row;
}

function assertRegenerable(p: OwnedProfile): void {
  if (p.profile.status !== 'active') throw new AppError('conflict', 'Profile is not active');
  if (p.availability !== 'available' || !p.activeVersionId) throw new AppError('definition_retired');
}

/** A fresh `regenerate` generation; an already queued/running one is returned instead (D-P8). */
export async function regenerate(
  ctx: ServiceContext,
  profileId: string,
): Promise<{ generationId: string }> {
  const owned = await ownedProfile(ctx.userId, profileId);
  assertRegenerable(owned);
  if (!(await eligibility(ctx)).eligible) throw new AppError('insufficient_content');
  const promptVersionId = await activePromptVersionId('tone_profile.generate');
  const { generations, created } = await withTransaction((tx) =>
    createGenerations(tx, ctx.userId, [profileId], 'regenerate', promptVersionId, {
      reuseActive: true,
    }),
  );
  await enqueueGenerations(ctx.userId, created);
  const [g] = generations;
  if (!g) throw new AppError('conflict');
  return { generationId: g.id };
}

const feedbackSchema = z
  .string()
  .max(FEEDBACK_MAX_CHARS)
  .refine((s) => s.trim().length > 0);

/** Feedback text is stored encrypted only; the worker inspects it before any LLM call. */
export async function feedback(
  ctx: ServiceContext,
  profileId: string,
  text: string,
): Promise<{ generationId: string }> {
  if (!feedbackSchema.safeParse(text).success) {
    throw new AppError('validation_failed', undefined, { field: 'feedback' });
  }
  const owned = await ownedProfile(ctx.userId, profileId);
  if (!owned.profile.latestVersionId) throw new AppError('conflict', 'Profile has no version yet');
  assertRegenerable(owned);
  const promptVersionId = await activePromptVersionId('tone_profile.feedback');
  const { generations, created } = await withTransaction((tx) =>
    createGenerations(tx, ctx.userId, [profileId], 'feedback', promptVersionId, {
      reuseActive: false,
      feedbackEnc: encrypt('user-content', text),
    }),
  );
  await enqueueGenerations(ctx.userId, created);
  const [g] = generations;
  if (!g) throw new AppError('conflict');
  return { generationId: g.id };
}

// ---------------------------------------------------------------------------------------------------------------
// Manual adjustment

function validateDimensionValue(d: Dimension, value: unknown): boolean {
  switch (d.valueType) {
    case 'scale':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (!d.scale || (value >= d.scale.min && value <= d.scale.max))
      );
    case 'enum':
      return typeof value === 'string' && (d.allowedValues ?? []).includes(value);
    case 'text':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= TEXT_VALUE_MAX;
    case 'list':
      return (
        Array.isArray(value) &&
        value.length <= LIST_MAX_ITEMS &&
        value.every((v) => typeof v === 'string' && v.trim().length > 0 && v.length <= LIST_ITEM_MAX)
      );
    default:
      return false;
  }
}

/**
 * Stores a `manual_edit` version. Every text value, list item and the note go through `inspect()` under the
 * user's current preferences (Principle I); any exclusion or redaction refuses with `sensitive_content`, naming
 * the fields only, never the values.
 */
export async function adjust(
  ctx: ServiceContext,
  profileId: string,
  input: { dimensions: Record<string, unknown>; note?: string },
): Promise<{ version: ProfileVersionView }> {
  const owned = await ownedProfile(ctx.userId, profileId);
  const latestId = owned.profile.latestVersionId;
  if (!latestId) throw new AppError('conflict', 'Profile has no version yet');
  const [latest] = await getDb()
    .select({ version: profileVersion, dimensions: toneDefinitionVersion.dimensions })
    .from(profileVersion)
    .innerJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, profileVersion.definitionVersionId))
    .where(eq(profileVersion.id, latestId))
    .limit(1);
  if (!latest) throw new AppError('conflict', 'Profile has no version yet');

  const dims = input?.dimensions;
  if (dims === null || typeof dims !== 'object' || Array.isArray(dims)) {
    throw new AppError('validation_failed', undefined, { field: 'dimensions' });
  }
  const specs = new Map(latest.dimensions.map((d) => [d.key, d]));
  const entries = Object.entries(dims);
  for (const [key, value] of entries) {
    const spec = specs.get(key);
    if (!spec || !validateDimensionValue(spec, value)) {
      throw new AppError('validation_failed', undefined, { field: key });
    }
  }
  const note = input.note;
  if (
    note !== undefined &&
    (typeof note !== 'string' || note.trim().length === 0 || note.length > NOTE_MAX_CHARS)
  ) {
    throw new AppError('validation_failed', undefined, { field: 'note' });
  }
  if (entries.length === 0 && note === undefined) {
    throw new AppError('validation_failed', undefined, { field: 'dimensions' });
  }

  // Inspect with the user's current policy (loaded once, now).
  const { policy } = await loadPolicy(ctx.userId);
  const ownAddresses = await loadOwnAddresses(ctx.userId);
  const flagged = new Set<string>();
  const inspectValue = async (field: string, text: string): Promise<string> => {
    const result = await inspectForUser(
      ctx.userId,
      { kind: 'note', bodyText: text, headers: {}, folders: [] },
      { policy, ownAddresses },
    );
    if (result.outcome === 'excluded' || result.counts.some((c) => c.redactedValues > 0)) {
      flagged.add(field);
      return '';
    }
    return result.text ?? text;
  };
  const adjusted = new Map<string, number | string | string[]>();
  for (const [key, value] of entries) {
    const spec = specs.get(key)!;
    if (spec.valueType === 'text') {
      adjusted.set(key, await inspectValue(key, value as string));
    } else if (spec.valueType === 'list') {
      const items: string[] = [];
      for (const item of value as string[]) items.push(await inspectValue(key, item));
      adjusted.set(key, items);
    } else {
      adjusted.set(key, value as number | string);
    }
  }
  const filteredNote = note !== undefined ? await inspectValue('note', note) : undefined;
  if (flagged.size > 0) {
    throw new AppError('sensitive_content', 'Adjusted values contain excluded content', {
      fields: [...flagged].sort(),
    });
  }

  const previous = decryptVersionBody(latest.version);
  // Values replaced, explanations kept (D-P9); a dimension missing from the old body is added when adjusted.
  const body: ProfileBody = { ...previous, dimensions: [] };
  for (const d of latest.dimensions) {
    const current = previous.dimensions.find((x) => x.key === d.key);
    const value = adjusted.get(d.key);
    if (current) body.dimensions.push(value === undefined ? current : { ...current, value });
    else if (value !== undefined) {
      body.dimensions.push({ key: d.key, value, explanation: '', evidenceRefs: [] });
    }
  }

  const versionId = await withTransaction(async (tx) => {
    const [locked] = await tx
      .select({ latestVersionId: toneProfile.latestVersionId })
      .from(toneProfile)
      .where(eq(toneProfile.id, profileId))
      .for('update');
    if (!locked || locked.latestVersionId !== latestId) {
      throw new AppError('conflict', 'Profile changed meanwhile');
    }
    const versionNumber = await nextVersionNumber(tx, profileId);
    const [row] = await tx
      .insert(profileVersion)
      .values({
        profileId,
        versionNumber,
        origin: 'manual_edit',
        basedOnVersionId: latestId,
        definitionVersionId: latest.version.definitionVersionId,
        promptVersionId: null,
        bodyEnc: encrypt('user-content', JSON.stringify(body)),
        feedbackEnc: filteredNote !== undefined ? encrypt('user-content', filteredNote) : null,
        languages: latest.version.languages,
        contributingSourceIds: latest.version.contributingSourceIds,
        contributingItemCount: latest.version.contributingItemCount,
      })
      .returning({ id: profileVersion.id });
    if (!row) throw new Error('profile_version_insert_failed');
    await tx
      .update(toneProfile)
      .set({ latestVersionId: row.id, updatedAt: new Date() })
      .where(eq(toneProfile.id, profileId));
    return row.id;
  });
  return { version: await version(ctx, profileId, versionId) };
}

async function nextVersionNumber(tx: Tx, profileId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${profileVersion.versionNumber}), 0)::int` })
    .from(profileVersion)
    .where(eq(profileVersion.profileId, profileId));
  return Number(row?.max ?? 0) + 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

const activeDefinitionVersion = alias(toneDefinitionVersion, 'active_definition_version');
const latestVersion = alias(profileVersion, 'latest_profile_version');

async function listItems(userId: string, profileId?: string): Promise<ProfileListItem[]> {
  const rows = await getDb()
    .select({
      id: toneProfile.id,
      status: toneProfile.status,
      outdatedReason: toneProfile.outdatedReason,
      definitionId: toneDefinition.id,
      definitionKey: toneDefinition.key,
      availability: toneDefinition.availability,
      activeVersionId: toneDefinition.activeVersionId,
      definitionName: activeDefinitionVersion.name,
      latestId: latestVersion.id,
      latestNumber: latestVersion.versionNumber,
      latestCreatedAt: latestVersion.createdAt,
    })
    .from(toneProfile)
    .innerJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
    .leftJoin(activeDefinitionVersion, eq(activeDefinitionVersion.id, toneDefinition.activeVersionId))
    .leftJoin(latestVersion, eq(latestVersion.id, toneProfile.latestVersionId))
    .where(
      and(eq(toneProfile.userId, userId), profileId ? eq(toneProfile.id, profileId) : undefined),
    )
    .orderBy(asc(toneProfile.createdAt), asc(toneProfile.id));
  if (rows.length === 0) return [];

  const gens = await getDb()
    .select({
      id: profileGeneration.id,
      profileId: profileGeneration.profileId,
      kind: profileGeneration.kind,
      status: profileGeneration.status,
    })
    .from(profileGeneration)
    .where(
      and(
        eq(profileGeneration.userId, userId),
        inArray(
          profileGeneration.profileId,
          rows.map((r) => r.id),
        ),
        inArray(profileGeneration.status, ACTIVE_GENERATION_STATUSES),
      ),
    )
    .orderBy(desc(profileGeneration.requestedAt), desc(profileGeneration.id));
  const activeByProfile = new Map<string, (typeof gens)[number]>();
  for (const g of gens) if (!activeByProfile.has(g.profileId)) activeByProfile.set(g.profileId, g);

  return rows.map((r) => {
    const retired = r.availability !== 'available' || !r.activeVersionId;
    const g = activeByProfile.get(r.id);
    return {
      id: r.id,
      definition: { id: r.definitionId, name: r.definitionName ?? r.definitionKey, retired },
      status: r.status,
      latestVersion:
        r.latestId && r.latestNumber !== null && r.latestCreatedAt
          ? { id: r.latestId, versionNumber: r.latestNumber, createdAt: r.latestCreatedAt.toISOString() }
          : null,
      outdatedReason: r.outdatedReason,
      canRegenerate: !retired && r.status === 'active',
      activeGeneration: g ? { id: g.id, kind: g.kind, status: g.status } : null,
    };
  });
}

/** All of the user's profiles, removed ones included. */
export async function list(ctx: ServiceContext): Promise<ProfileListItem[]> {
  return listItems(ctx.userId);
}

export async function get(
  ctx: ServiceContext,
  profileId: string,
): Promise<{ profile: ProfileListItem; latestVersion: ProfileVersionView | null }> {
  if (!UUID_RE.test(profileId)) throw new AppError('not_found');
  const [profile] = await listItems(ctx.userId, profileId);
  if (!profile) throw new AppError('not_found');
  const latest = profile.latestVersion ? await version(ctx, profileId, profile.latestVersion.id) : null;
  return { profile, latestVersion: latest };
}

/** Newest first. */
export async function versions(
  ctx: ServiceContext,
  profileId: string,
): Promise<ProfileVersionSummary[]> {
  await ownedProfile(ctx.userId, profileId);
  const rows = await getDb()
    .select({
      id: profileVersion.id,
      versionNumber: profileVersion.versionNumber,
      origin: profileVersion.origin,
      rating: profileVersion.rating,
      createdAt: profileVersion.createdAt,
    })
    .from(profileVersion)
    .where(eq(profileVersion.profileId, profileId))
    .orderBy(desc(profileVersion.versionNumber));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function version(
  ctx: ServiceContext,
  profileId: string,
  versionId: string,
): Promise<ProfileVersionView> {
  if (!UUID_RE.test(profileId) || !UUID_RE.test(versionId)) throw new AppError('not_found');
  const [row] = await getDb()
    .select({
      version: profileVersion,
      definitionVersionNumber: toneDefinitionVersion.versionNumber,
      promptVersionNumber: promptTemplateVersion.versionNumber,
    })
    .from(profileVersion)
    .innerJoin(toneProfile, eq(toneProfile.id, profileVersion.profileId))
    .innerJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, profileVersion.definitionVersionId))
    .leftJoin(promptTemplateVersion, eq(promptTemplateVersion.id, profileVersion.promptVersionId))
    .where(
      and(
        eq(profileVersion.id, versionId),
        eq(profileVersion.profileId, profileId),
        eq(toneProfile.userId, ctx.userId),
      ),
    )
    .limit(1);
  if (!row) throw new AppError('not_found');
  const v = row.version;
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    origin: v.origin,
    definitionVersion: { id: v.definitionVersionId, versionNumber: row.definitionVersionNumber },
    promptVersion:
      v.promptVersionId && row.promptVersionNumber !== null
        ? { id: v.promptVersionId, versionNumber: row.promptVersionNumber }
        : null,
    body: decryptVersionBody(v),
    languages: v.languages,
    rating: v.rating,
    ratedAt: v.ratedAt ? v.ratedAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
  };
}

/** Owner only; anything else is `not_found` (SC-007). */
export async function rate(
  ctx: ServiceContext,
  profileId: string,
  versionId: string,
  rating: ProfileRating,
): Promise<{
  profileVersion: { id: string; versionNumber: number; rating: ProfileRating; ratedAt: string };
}> {
  if (!UUID_RE.test(profileId) || !UUID_RE.test(versionId)) throw new AppError('not_found');
  const ratedAt = new Date();
  const [row] = await getDb()
    .update(profileVersion)
    .set({ rating, ratedAt })
    .where(
      and(
        eq(profileVersion.id, versionId),
        eq(profileVersion.profileId, profileId),
        inArray(
          profileVersion.profileId,
          getDb()
            .select({ id: toneProfile.id })
            .from(toneProfile)
            .where(and(eq(toneProfile.id, profileId), eq(toneProfile.userId, ctx.userId))),
        ),
      ),
    )
    .returning({ id: profileVersion.id, versionNumber: profileVersion.versionNumber });
  if (!row) throw new AppError('not_found');
  return { profileVersion: { ...row, rating, ratedAt: ratedAt.toISOString() } };
}

/** Deletes the profile with its versions and generations and removes the choice (D-P7). */
export async function remove(ctx: ServiceContext, profileId: string): Promise<void> {
  if (!UUID_RE.test(profileId)) throw new AppError('not_found');
  await withTransaction(async (tx) => {
    const [p] = await tx
      .select({ id: toneProfile.id, definitionId: toneProfile.definitionId })
      .from(toneProfile)
      .where(and(eq(toneProfile.id, profileId), eq(toneProfile.userId, ctx.userId)))
      .for('update');
    if (!p) throw new AppError('not_found');
    await tx.delete(profileGeneration).where(eq(profileGeneration.profileId, p.id));
    await tx.update(toneProfile).set({ latestVersionId: null }).where(eq(toneProfile.id, p.id));
    await tx.delete(profileVersion).where(eq(profileVersion.profileId, p.id));
    await tx.delete(toneProfile).where(eq(toneProfile.id, p.id));
    await tx
      .update(userDefinitionChoice)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(userDefinitionChoice.userId, ctx.userId),
          eq(userDefinitionChoice.definitionId, p.definitionId),
          isNull(userDefinitionChoice.removedAt),
        ),
      );
  });
}

export async function getGeneration(
  ctx: ServiceContext,
  generationId: string,
): Promise<GenerationView> {
  if (!UUID_RE.test(generationId)) throw new AppError('not_found');
  const [row] = await getDb()
    .select({
      id: profileGeneration.id,
      status: profileGeneration.status,
      blockReason: profileGeneration.blockReason,
      errorCode: profileGeneration.errorCode,
      resultVersionId: profileGeneration.resultVersionId,
    })
    .from(profileGeneration)
    .where(and(eq(profileGeneration.id, generationId), eq(profileGeneration.userId, ctx.userId)))
    .limit(1);
  if (!row) throw new AppError('not_found');
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Hooks (import / upload / deletion processors)

/**
 * Marks active, versioned, not-yet-outdated profiles outdated: a contributing source gone (or disconnected) ->
 * `sources_deleted`; authored words grown by more than the ratio -> `significant_new_content`. Notifies once.
 */
export async function recomputeOutdated(userId: string): Promise<{ updated: number }> {
  const candidates = await getDb()
    .select({
      id: toneProfile.id,
      authoredWordsAtLatest: toneProfile.authoredWordsAtLatest,
      sourceIds: profileVersion.contributingSourceIds,
    })
    .from(toneProfile)
    .innerJoin(profileVersion, eq(profileVersion.id, toneProfile.latestVersionId))
    .where(
      and(
        eq(toneProfile.userId, userId),
        eq(toneProfile.status, 'active'),
        isNull(toneProfile.outdatedReason),
      ),
    );
  if (candidates.length === 0) return { updated: 0 };

  const allSourceIds = [...new Set(candidates.flatMap((c) => c.sourceIds))];
  const present = new Set(
    allSourceIds.length === 0
      ? []
      : (
          await getDb()
            .select({ id: connectedSource.id })
            .from(connectedSource)
            .where(
              and(
                eq(connectedSource.userId, userId),
                inArray(connectedSource.id, allSourceIds),
                ne(connectedSource.status, 'disconnected'),
              ),
            )
        ).map((r) => r.id),
  );
  const { authoredWordCount } = await eligibility({ userId });
  const ratio = await getSetting('profile.significant_new_content_ratio');

  let updated = 0;
  for (const c of candidates) {
    let reason: ProfileOutdatedReason | null = null;
    if (c.sourceIds.some((id) => !present.has(id))) reason = 'sources_deleted';
    else if (authoredWordCount > c.authoredWordsAtLatest * (1 + ratio)) {
      reason = 'significant_new_content';
    }
    if (!reason) continue;
    const outdatedReason = reason;
    const changed = await withTransaction(async (tx) => {
      const rows = await tx
        .update(toneProfile)
        .set({ outdatedReason, updatedAt: new Date() })
        .where(and(eq(toneProfile.id, c.id), isNull(toneProfile.outdatedReason)))
        .returning({ id: toneProfile.id });
      if (rows.length === 0) return false;
      await notify(userId, 'profile_outdated', { profileId: c.id, reason: outdatedReason }, tx);
      return true;
    });
    if (changed) updated += 1;
  }
  return { updated };
}

/**
 * First-time automatic generation: auto-chooses a single available definition, then creates `generate`
 * generations for active profiles that never had a version nor any generation. Idempotent; never rate limited.
 */
export async function autoGenerateIfFirstEligible(
  userId: string,
): Promise<{ generations: GenerationRef[] }> {
  const ctx: ServiceContext = { userId, role: 'user' };
  await autoChooseIfSingle(ctx);
  if (!(await eligibility(ctx)).eligible) return { generations: [] };

  const candidates = await getDb()
    .select({ id: toneProfile.id })
    .from(toneProfile)
    .innerJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
    .where(
      and(
        eq(toneProfile.userId, userId),
        eq(toneProfile.status, 'active'),
        isNull(toneProfile.latestVersionId),
        eq(toneDefinition.availability, 'available'),
        sql`${toneDefinition.activeVersionId} is not null`,
        notInArray(
          toneProfile.id,
          getDb().select({ id: profileGeneration.profileId }).from(profileGeneration),
        ),
      ),
    );
  if (candidates.length === 0) return { generations: [] };

  // A background hook: without an active prompt there is nothing to pin, so it retries on the next hook call.
  const prompt = await getActiveVersion('tone_profile.generate');
  if (!prompt) return { generations: [] };
  const { generations, created } = await withTransaction((tx) =>
    createGenerations(
      tx,
      userId,
      candidates.map((c) => c.id),
      'generate',
      prompt.id,
      { reuseActive: false, skipIfAnyGeneration: true },
    ),
  );
  await enqueueGenerations(userId, created);
  return { generations };
}

// ---------------------------------------------------------------------------------------------------------------
// Worker-facing (profile.generate)

export async function loadGenerationForRun(id: string): Promise<{
  generation: ProfileGeneration;
  profile: ToneProfile;
  definition: ToneDefinition;
  definitionVersion: ToneDefinitionVersion;
  promptVersion: PromptTemplateVersion;
  user: { id: string; name: string; status: UserStatus };
  latestVersion: ProfileVersion | null;
  choiceActive: boolean;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      generation: profileGeneration,
      profile: toneProfile,
      definition: toneDefinition,
      definitionVersion: toneDefinitionVersion,
      promptVersion: promptTemplateVersion,
      user: { id: user.id, name: user.name, status: user.status },
    })
    .from(profileGeneration)
    .innerJoin(toneProfile, eq(toneProfile.id, profileGeneration.profileId))
    .innerJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
    .innerJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, profileGeneration.definitionVersionId))
    .innerJoin(promptTemplateVersion, eq(promptTemplateVersion.id, profileGeneration.promptVersionId))
    .innerJoin(user, eq(user.id, profileGeneration.userId))
    .where(eq(profileGeneration.id, id))
    .limit(1);
  if (!row) return null;
  const latest = row.profile.latestVersionId
    ? ((
        await db
          .select()
          .from(profileVersion)
          .where(eq(profileVersion.id, row.profile.latestVersionId))
          .limit(1)
      )[0] ?? null)
    : null;
  const [choice] = await db
    .select({ id: userDefinitionChoice.id })
    .from(userDefinitionChoice)
    .where(
      and(
        eq(userDefinitionChoice.userId, row.profile.userId),
        eq(userDefinitionChoice.definitionId, row.profile.definitionId),
        isNull(userDefinitionChoice.removedAt),
      ),
    )
    .limit(1);
  return { ...row, latestVersion: latest, choiceActive: choice !== undefined };
}

export async function markRunning(id: string): Promise<void> {
  await getDb()
    .update(profileGeneration)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(profileGeneration.id, id), inArray(profileGeneration.status, ACTIVE_GENERATION_STATUSES)));
}

export async function blockGeneration(id: string, reason: GenerationBlockReason): Promise<void> {
  await getDb()
    .update(profileGeneration)
    .set({ status: 'blocked', blockReason: reason, finishedAt: new Date() })
    .where(eq(profileGeneration.id, id));
}

export async function failGeneration(
  id: string,
  errorCode: string,
  opts: { notify?: boolean } = {},
): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(profileGeneration)
      .set({ status: 'failed', errorCode, finishedAt: new Date() })
      .where(eq(profileGeneration.id, id))
      .returning({ userId: profileGeneration.userId, profileId: profileGeneration.profileId });
    if (row && opts.notify) {
      await notify(
        row.userId,
        'generation_failed',
        { profileId: row.profileId, generationId: id, errorCode },
        tx,
      );
    }
  });
}

export function decryptVersionBody(v: Pick<ProfileVersion, 'bodyEnc'>): ProfileBody {
  return JSON.parse(decrypt('user-content', v.bodyEnc)) as ProfileBody;
}

export function decryptGenerationFeedback(g: Pick<ProfileGeneration, 'feedbackEnc'>): string | null {
  return g.feedbackEnc ? decrypt('user-content', g.feedbackEnc) : null;
}

/** Stores the generated version, moves the profile's latest pointer and completes the generation. */
export async function storeGeneratedVersion(
  generationId: string,
  input: {
    body: ProfileBody;
    languages: string[];
    contributingSourceIds: string[];
    contributingItemCount: number;
    authoredWordsNow: number;
  },
): Promise<{ versionId: string }> {
  return withTransaction(async (tx) => {
    const [g] = await tx
      .select()
      .from(profileGeneration)
      .where(eq(profileGeneration.id, generationId))
      .limit(1);
    if (!g) throw new AppError('not_found');
    const [profile] = await tx
      .select({ latestVersionId: toneProfile.latestVersionId })
      .from(toneProfile)
      .where(eq(toneProfile.id, g.profileId))
      .for('update');
    if (!profile) throw new AppError('not_found');
    // A retried job after a committed store: return the stored version.
    if (g.status === 'succeeded' && g.resultVersionId) return { versionId: g.resultVersionId };

    const origin: ProfileVersionOrigin = !profile.latestVersionId
      ? 'generated'
      : g.kind === 'feedback'
        ? 'feedback'
        : 'regenerated';
    const versionNumber = await nextVersionNumber(tx, g.profileId);
    const [row] = await tx
      .insert(profileVersion)
      .values({
        profileId: g.profileId,
        versionNumber,
        origin,
        basedOnVersionId: profile.latestVersionId,
        definitionVersionId: g.definitionVersionId,
        promptVersionId: g.promptVersionId,
        bodyEnc: encrypt('user-content', JSON.stringify(input.body)),
        feedbackEnc: g.feedbackEnc,
        languages: input.languages,
        contributingSourceIds: input.contributingSourceIds,
        contributingItemCount: input.contributingItemCount,
      })
      .returning({ id: profileVersion.id });
    if (!row) throw new Error('profile_version_insert_failed');
    const now = new Date();
    await tx
      .update(toneProfile)
      .set({
        latestVersionId: row.id,
        authoredWordsAtLatest: input.authoredWordsNow,
        outdatedReason: null,
        updatedAt: now,
      })
      .where(eq(toneProfile.id, g.profileId));
    await tx
      .update(profileGeneration)
      .set({ status: 'succeeded', resultVersionId: row.id, finishedAt: now })
      .where(eq(profileGeneration.id, generationId));
    await notify(g.userId, 'profile_ready', { profileId: g.profileId, versionId: row.id }, tx);
    return { versionId: row.id };
  });
}
