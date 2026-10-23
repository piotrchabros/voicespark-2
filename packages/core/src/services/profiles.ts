import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  connectedSource,
  contentItem,
  getDb,
  ownAnalysisPromptVersion,
  ownAnalysisPrompt,
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
  type ProfileVersionFormat,
  type ProfileVersionOrigin,
  type PromptTemplateVersion,
  type ToneDefinition,
  type ToneDefinitionVersion,
  type ToneProfile,
  type Tx,
  type UserStatus,
} from '@voicespark/db';
import { lockOwnPrompt } from '@voicespark/db/repos/user/own-prompts';
import { getExcerptSources } from '@voicespark/db/repos/user/profiles';
import { decrypt, encrypt } from '../crypto';
import { AppError, type ServiceContext } from '../errors';
import {
  DOCUMENT_LIMITS,
  type ExcerptSource,
  type VersionBodyView,
  type VoiceDocument,
} from '../prompting/document-schema';
import type { ProfileBody } from '../prompting/profile-schema';
import { enqueue, jobIds } from '../queues';
import { audit } from './audit';
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

export interface ProfileVersionViewBase {
  id: string;
  versionNumber: number;
  origin: ProfileVersionOrigin;
  definitionVersion: { id: string; versionNumber: number };
  promptVersion: { id: string; versionNumber: number } | null;
  /** Null for legacy (001) versions. */
  promptSource: 'default' | 'own' | null;
  /** Null for legacy versions, and for `own` once the own version is gone. */
  analysisPrompt:
    | { kind: 'default'; definitionVersion: { id: string; versionNumber: number } }
    | { kind: 'own'; ownVersion: { id: string; versionNumber: number } }
    | null;
  /** Key = contentItemId of an excerpt; null = the item was deleted. */
  excerptSources: Record<string, ExcerptSource | null>;
  languages: string[];
  rating: ProfileRating | null;
  ratedAt: string | null;
  createdAt: string;
}

/** `format` narrows `body`: a 001 `ProfileBody` or a `VoiceDocument`. */
export type ProfileVersionView = ProfileVersionViewBase & VersionBodyView;

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
 * pinned to the definition's current active version (read inside the transaction, uncached), the wrapper prompt
 * version and the user's current own analysis prompt version when in use (data-model "Generation pin resolution").
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
      definitionId: toneProfile.definitionId,
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
    // A publish or rollback cannot move the active version under this pin; a save or reset waits for the row.
    await tx
      .select({ id: toneDefinitionVersion.id })
      .from(toneDefinitionVersion)
      .where(eq(toneDefinitionVersion.id, p.activeVersionId))
      .for('share');
    const own = await lockOwnPrompt({ userId }, p.definitionId, tx);
    const [inserted] = await tx
      .insert(profileGeneration)
      .values({
        userId,
        profileId: p.id,
        kind,
        status: 'queued',
        definitionVersionId: p.activeVersionId,
        promptVersionId,
        ownPromptVersionId: own?.inUse ? own.currentVersionId : null,
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
  // Documents are edited through `editDocument`.
  if (latest.version.format === 'document') throw new AppError('conflict', 'Latest version is a document');

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

  const decrypted = decryptVersionBody(latest.version);
  if (decrypted.format !== 'structured') throw new AppError('conflict', 'Latest version is a document');
  const previous = decrypted.body;
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

export interface DocumentEditInput {
  baseVersionId: string;
  summary: string;
  sections: { heading: string; markdown: string }[];
  doList: string[];
  dontList: string[];
  /** Indexes into the base version's excerpts; excerpts can be removed, not edited. */
  keepExcerpts: number[];
}

const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function validateDocumentEdit(input: DocumentEditInput, excerptCount: number): void {
  const L = DOCUMENT_LIMITS;
  const fail = (field: string): never => {
    throw new AppError('validation_failed', undefined, { field });
  };
  if (!isText(input.summary, L.summaryMax)) fail('summary');
  const sections: unknown = input.sections;
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > L.sectionsMax) fail('sections');
  input.sections.forEach((s, i) => {
    if (s === null || typeof s !== 'object') fail(`sections[${i}]`);
    if (!isText(s.heading, L.headingMax)) fail(`sections[${i}].heading`);
    if (typeof s.markdown !== 'string' || s.markdown.length > L.markdownMax) fail(`sections[${i}].markdown`);
  });
  for (const field of ['doList', 'dontList'] as const) {
    const list: unknown = input[field];
    if (
      !Array.isArray(list) ||
      list.length < L.listMin ||
      list.length > L.listMax ||
      !list.every((item) => isText(item, L.listItemMax))
    ) {
      fail(field);
    }
  }
  const keep: unknown = input.keepExcerpts;
  if (
    !Array.isArray(keep) ||
    keep.length < 1 ||
    new Set(keep).size !== keep.length ||
    !keep.every((i) => Number.isInteger(i) && i >= 0 && i < excerptCount)
  ) {
    fail('keepExcerpts');
  }
}

/**
 * Direct edit of the latest `document` version (FR-020): stores a `manual_edit` version that keeps the base's
 * prompt source and own prompt version. Every text field goes through `inspect()` under the user's current
 * preferences; an exclusion, a redaction or an inspection that cannot complete refuses with `sensitive_content`,
 * naming the fields only. Sections keep the base `aspectKey` at the same index; extra ones get `custom_{n}`.
 */
export async function editDocument(
  ctx: ServiceContext,
  profileId: string,
  input: DocumentEditInput,
): Promise<{
  version: { id: string; versionNumber: number; origin: 'manual_edit'; createdAt: string };
}> {
  const owned = await ownedProfile(ctx.userId, profileId);
  const latestId = owned.profile.latestVersionId;
  if (!latestId) throw new AppError('conflict', 'Profile has no version yet');
  if (input?.baseVersionId !== latestId) throw new AppError('conflict', 'Base version is not the latest');
  const [latest] = await getDb()
    .select()
    .from(profileVersion)
    .where(eq(profileVersion.id, latestId))
    .limit(1);
  if (!latest) throw new AppError('conflict', 'Profile has no version yet');
  const base = decryptVersionBody(latest);
  if (base.format !== 'document') throw new AppError('conflict', 'Latest version is not a document');
  validateDocumentEdit(input, base.body.excerpts.length);

  // Inspect with the user's current policy (loaded once, now).
  const { policy } = await loadPolicy(ctx.userId);
  const ownAddresses = await loadOwnAddresses(ctx.userId);
  const flagged = new Set<string>();
  const inspectField = async (field: string, text: string): Promise<string> => {
    if (text.trim() === '') return text;
    const result = await inspectForUser(
      ctx.userId,
      { kind: 'note', bodyText: text, headers: {}, folders: [] },
      { policy, ownAddresses },
    );
    // `inspection_failed` comes back as a whole-item exclusion, so an incomplete inspection refuses too.
    if (result.outcome === 'excluded' || result.counts.some((c) => c.redactedValues > 0)) {
      flagged.add(field);
      return '';
    }
    return result.text ?? text;
  };
  const summary = await inspectField('summary', input.summary);
  const sections: { heading: string; markdown: string }[] = [];
  for (const [i, s] of input.sections.entries()) {
    sections.push({
      heading: await inspectField(`sections[${i}].heading`, s.heading),
      markdown: await inspectField(`sections[${i}].markdown`, s.markdown),
    });
  }
  const doList: string[] = [];
  for (const [i, item] of input.doList.entries()) doList.push(await inspectField(`doList[${i}]`, item));
  const dontList: string[] = [];
  for (const [i, item] of input.dontList.entries()) {
    dontList.push(await inspectField(`dontList[${i}]`, item));
  }
  if (flagged.size > 0) {
    throw new AppError('sensitive_content', 'Edited document contains excluded content', {
      fields: [...flagged].sort(),
    });
  }

  // Aspect keys by index; extra sections get `custom_{n}` (n = 1-based position, bumped past taken keys).
  const taken = new Set<string>();
  const keys = sections.map((_, i) => {
    let key = base.body.sections[i]?.aspectKey;
    if (key === undefined || taken.has(key)) {
      let n = i + 1;
      while (taken.has(`custom_${n}`) || base.body.sections.some((b) => b.aspectKey === `custom_${n}`)) n += 1;
      key = `custom_${n}`;
    }
    taken.add(key);
    return key;
  });
  const body: VoiceDocument = {
    aspects: sections.map((s, i) => ({
      key: keys[i]!,
      name: s.heading.trim().slice(0, DOCUMENT_LIMITS.aspectNameMax),
    })),
    summary,
    sections: sections.map((s, i) => ({ aspectKey: keys[i]!, ...s })),
    doList,
    dontList,
    excerpts: [...input.keepExcerpts]
      .sort((a, b) => a - b)
      .map((i) => base.body.excerpts[i]!)
      .map((x) => ({ ...x, aspectKeys: x.aspectKeys.filter((k) => taken.has(k)) })),
    languages: base.body.languages,
  };

  const row = await withTransaction(async (tx) => {
    const [locked] = await tx
      .select({ latestVersionId: toneProfile.latestVersionId })
      .from(toneProfile)
      .where(eq(toneProfile.id, profileId))
      .for('update');
    if (!locked || locked.latestVersionId !== latestId) {
      throw new AppError('conflict', 'Profile changed meanwhile');
    }
    const versionNumber = await nextVersionNumber(tx, profileId);
    const [inserted] = await tx
      .insert(profileVersion)
      .values({
        profileId,
        versionNumber,
        origin: 'manual_edit',
        format: 'document',
        promptSource: latest.promptSource,
        ownPromptVersionId: latest.ownPromptVersionId,
        basedOnVersionId: latestId,
        definitionVersionId: latest.definitionVersionId,
        promptVersionId: null,
        bodyEnc: encrypt('user-content', JSON.stringify(body)),
        feedbackEnc: null,
        languages: latest.languages,
        contributingSourceIds: latest.contributingSourceIds,
        contributingItemCount: latest.contributingItemCount,
      })
      .returning({
        id: profileVersion.id,
        versionNumber: profileVersion.versionNumber,
        createdAt: profileVersion.createdAt,
      });
    if (!inserted) throw new Error('profile_version_insert_failed');
    await tx
      .update(toneProfile)
      .set({ latestVersionId: inserted.id, updatedAt: new Date() })
      .where(eq(toneProfile.id, profileId));
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'profile.document_edited',
        targetType: 'profile',
        targetId: profileId,
        metadata: {
          profileId,
          versionId: inserted.id,
          baseVersionId: latestId,
          sectionCount: body.sections.length,
          excerptCount: body.excerpts.length,
        },
      },
      tx,
    );
    return inserted;
  });
  return {
    version: {
      id: row.id,
      versionNumber: row.versionNumber,
      origin: 'manual_edit',
      createdAt: row.createdAt.toISOString(),
    },
  };
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
      ownVersionNumber: ownAnalysisPromptVersion.versionNumber,
    })
    .from(profileVersion)
    .innerJoin(toneProfile, eq(toneProfile.id, profileVersion.profileId))
    .innerJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, profileVersion.definitionVersionId))
    .leftJoin(promptTemplateVersion, eq(promptTemplateVersion.id, profileVersion.promptVersionId))
    .leftJoin(ownAnalysisPromptVersion, eq(ownAnalysisPromptVersion.id, profileVersion.ownPromptVersionId))
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
  const definitionVersion = { id: v.definitionVersionId, versionNumber: row.definitionVersionNumber };
  const analysisPrompt: ProfileVersionViewBase['analysisPrompt'] =
    v.promptSource === 'default'
      ? { kind: 'default', definitionVersion }
      : v.promptSource === 'own' && v.ownPromptVersionId && row.ownVersionNumber !== null
        ? { kind: 'own', ownVersion: { id: v.ownPromptVersionId, versionNumber: row.ownVersionNumber } }
        : null;
  const content = decryptVersionBody(v);
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    origin: v.origin,
    definitionVersion,
    promptVersion:
      v.promptVersionId && row.promptVersionNumber !== null
        ? { id: v.promptVersionId, versionNumber: row.promptVersionNumber }
        : null,
    promptSource: v.promptSource,
    analysisPrompt,
    excerptSources: await excerptSourcesOf(ctx.userId, content),
    ...content,
    languages: v.languages,
    rating: v.rating,
    ratedAt: v.ratedAt ? v.ratedAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
  };
}

/** Source facts per quoted content item; a deleted item maps to null (the UI shows "source deleted"). */
async function excerptSourcesOf(
  userId: string,
  content: VersionBodyView,
): Promise<Record<string, ExcerptSource | null>> {
  const ids = [
    ...new Set(
      content.body.excerpts
        .map((x) => x.contentItemId)
        .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)),
    ),
  ];
  const found = new Map((await getExcerptSources({ userId }, ids)).map((r) => [r.itemId, r]));
  const out: Record<string, ExcerptSource | null> = {};
  for (const id of ids) {
    const r = found.get(id);
    out[id] = r
      ? { kind: r.kind, itemDate: r.itemDate.toISOString().slice(0, 10), sourceLabels: r.sourceLabels }
      : null;
  }
  return out;
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
  /** The pinned own analysis prompt version (owner-checked); null for the default prompt or once it is gone. */
  ownPromptVersion: { id: string; versionNumber: number; promptTextEnc: string } | null;
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
  const ownPromptVersionId = row.generation.ownPromptVersionId;
  const [ownPromptVersion] = ownPromptVersionId
    ? await db
        .select({
          id: ownAnalysisPromptVersion.id,
          versionNumber: ownAnalysisPromptVersion.versionNumber,
          promptTextEnc: ownAnalysisPromptVersion.promptTextEnc,
        })
        .from(ownAnalysisPromptVersion)
        .innerJoin(ownAnalysisPrompt, eq(ownAnalysisPrompt.id, ownAnalysisPromptVersion.ownPromptId))
        .where(
          and(
            eq(ownAnalysisPromptVersion.id, ownPromptVersionId),
            eq(ownAnalysisPrompt.userId, row.generation.userId),
          ),
        )
        .limit(1)
    : [];
  return {
    ...row,
    latestVersion: latest,
    choiceActive: choice !== undefined,
    ownPromptVersion: ownPromptVersion ?? null,
  };
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

/** Format-aware: legacy rows hold a 001 `ProfileBody`, `document` rows a `VoiceDocument`. */
export function decryptVersionBody(v: Pick<ProfileVersion, 'bodyEnc' | 'format'>): VersionBodyView {
  const parsed: unknown = JSON.parse(decrypt('user-content', v.bodyEnc));
  return v.format === 'document'
    ? { format: 'document', body: parsed as VoiceDocument }
    : { format: 'structured', body: parsed as ProfileBody };
}

export function decryptOwnPromptText(v: { promptTextEnc: string }): string {
  return decrypt('user-content', v.promptTextEnc);
}

export function decryptGenerationFeedback(g: Pick<ProfileGeneration, 'feedbackEnc'>): string | null {
  return g.feedbackEnc ? decrypt('user-content', g.feedbackEnc) : null;
}

interface GeneratedVersionInput {
  languages: string[];
  contributingSourceIds: string[];
  contributingItemCount: number;
  authoredWordsNow: number;
}

/** Stores a legacy structured version (001 pipeline). */
export async function storeGeneratedVersion(
  generationId: string,
  input: GeneratedVersionInput & { body: ProfileBody },
): Promise<{ versionId: string }> {
  return storeGenerated(generationId, 'structured', input.body, input);
}

/**
 * Stores a `document` version with the generation's pins (`prompt_source` follows `own_prompt_version_id`), moves
 * the profile's latest pointer, completes the generation and notifies `profile_ready`. Idempotent per generation.
 */
export async function storeGeneratedDocument(
  generationId: string,
  input: GeneratedVersionInput & { document: VoiceDocument },
): Promise<{ versionId: string }> {
  return storeGenerated(generationId, 'document', input.document, input);
}

/** Stores the generated version, moves the profile's latest pointer and completes the generation. */
async function storeGenerated(
  generationId: string,
  format: ProfileVersionFormat,
  body: ProfileBody | VoiceDocument,
  input: GeneratedVersionInput,
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
        format,
        promptSource: format === 'document' ? (g.ownPromptVersionId ? 'own' : 'default') : null,
        ownPromptVersionId: format === 'document' ? g.ownPromptVersionId : null,
        basedOnVersionId: profile.latestVersionId,
        definitionVersionId: g.definitionVersionId,
        promptVersionId: g.promptVersionId,
        bodyEnc: encrypt('user-content', JSON.stringify(body)),
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

// ---------------------------------------------------------------------------------------------------------------
// Deletion hook (deletion.execute finalize and deleteSource, same transaction)

/**
 * Drops excerpts of deleted content items from every profile version of the user (both formats) and re-encrypts
 * the changed bodies with the active key. A profile whose latest version changed becomes outdated
 * (`sources_deleted`) and is notified once; earlier versions are scrubbed silently. Idempotent.
 */
export async function scrubDeletedExcerpts(
  tx: Tx,
  userId: string,
  itemIds: string[],
): Promise<{ versionsChanged: number; profilesOutdated: number }> {
  if (itemIds.length === 0) return { versionsChanged: 0, profilesOutdated: 0 };
  const deleted = new Set(itemIds);
  const rows = await tx
    .select({
      id: profileVersion.id,
      profileId: profileVersion.profileId,
      format: profileVersion.format,
      bodyEnc: profileVersion.bodyEnc,
      latestVersionId: toneProfile.latestVersionId,
      status: toneProfile.status,
      outdatedReason: toneProfile.outdatedReason,
    })
    .from(profileVersion)
    .innerJoin(toneProfile, eq(toneProfile.id, profileVersion.profileId))
    .where(eq(toneProfile.userId, userId))
    .orderBy(asc(profileVersion.profileId), asc(profileVersion.versionNumber))
    .for('update');

  let versionsChanged = 0;
  const latestChanged = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const content = decryptVersionBody(r);
    const kept = content.body.excerpts.filter(
      (x) => x.contentItemId === null || !deleted.has(x.contentItemId),
    );
    if (kept.length === content.body.excerpts.length) continue;
    const body = { ...content.body, excerpts: kept };
    await tx
      .update(profileVersion)
      .set({ bodyEnc: encrypt('user-content', JSON.stringify(body)) })
      .where(eq(profileVersion.id, r.id));
    versionsChanged += 1;
    if (r.id === r.latestVersionId) latestChanged.set(r.profileId, r);
  }

  let profilesOutdated = 0;
  for (const [profileId, r] of latestChanged) {
    // `recomputeOutdated` may already have marked it; never notify twice for the same reason.
    if (r.status !== 'active' || r.outdatedReason === 'sources_deleted') continue;
    await tx
      .update(toneProfile)
      .set({ outdatedReason: 'sources_deleted', updatedAt: new Date() })
      .where(eq(toneProfile.id, profileId));
    await notify(userId, 'profile_outdated', { profileId, reason: 'sources_deleted' }, tx);
    profilesOutdated += 1;
  }
  return { versionsChanged, profilesOutdated };
}
