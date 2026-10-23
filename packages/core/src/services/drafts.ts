import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  draft,
  getDb,
  profileVersion,
  promptTemplateVersion,
  toneDefinitionVersion,
  user,
  withTransaction,
  type Draft,
  type DraftContentType,
  type DraftRating,
  type DraftStatus,
  type Dimension,
  type ProfileVersion,
  type PromptTemplateVersion,
  type UserStatus,
} from '@voicespark/db';
import { getDraft, listDrafts, type DraftListRow } from '@voicespark/db/repos/user/drafts';
import { getProfile } from '@voicespark/db/repos/user/profiles';
import { decrypt, encrypt } from '../crypto';
import { AppError, type ServiceContext } from '../errors';
import { DRAFT_PROMPT_KEY, type VersionBodyView } from '../prompting';
import { enqueue, jobIds } from '../queues';
import { audit } from './audit';
import { notify } from './notifications';
import { decryptVersionBody } from './profiles';
import { getActiveVersion } from './prompts';

export const BRIEF_MAX = 2000;
export const FEEDBACK_MAX = 2000;
export const EDITED_TEXT_MAX = 20000;
export const TOPIC_CHARS = 120;
const LIST_MAX_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DraftListItem {
  id: string;
  contentType: DraftContentType;
  topic: string;
  profile: { id: string; definitionName: string | null } | null;
  profileVersionNumber: number | null;
  status: DraftStatus;
  rating: DraftRating | null;
  createdAt: string;
}

export interface DraftView extends DraftListItem {
  brief: string;
  title: string | null;
  text: string | null;
  generatedText: string | null;
  editedText: string | null;
  feedback: string | null;
  notes: string | null;
  truncated: boolean;
  redactionsApplied: number;
  errorCode: string | null;
  completedAt: string | null;
  profileVersionId: string;
  promptVersionId: string;
  parentDraftId: string | null;
}

const dec = (v: string | null): string | null => (v === null ? null : decrypt('user-content', v));
const enc = (v: string | null): string | null => (v === null ? null : encrypt('user-content', v));

function toListItem(row: DraftListRow): DraftListItem {
  const d = row.draft;
  return {
    id: d.id,
    contentType: d.contentType,
    topic: decrypt('user-content', d.topicEnc),
    profile: d.profileId ? { id: d.profileId, definitionName: row.definitionName } : null,
    profileVersionNumber: row.profileVersionNumber,
    status: d.status,
    rating: d.rating,
    createdAt: d.createdAt.toISOString(),
  };
}

function toView(row: DraftListRow): DraftView {
  const d = row.draft;
  const generatedText = dec(d.generatedTextEnc);
  const editedText = dec(d.editedTextEnc);
  return {
    ...toListItem(row),
    brief: decrypt('user-content', d.briefEnc),
    title: dec(d.titleEnc),
    text: editedText ?? generatedText,
    generatedText,
    editedText,
    feedback: dec(d.feedbackEnc),
    notes: dec(d.notesEnc),
    truncated: d.truncated,
    redactionsApplied: d.redactionsApplied,
    errorCode: d.errorCode,
    completedAt: d.completedAt ? d.completedAt.toISOString() : null,
    profileVersionId: d.profileVersionId,
    promptVersionId: d.promptVersionId,
    parentDraftId: d.parentDraftId,
  };
}

/** The caller's draft; foreign, missing and malformed ids are all `not_found`. */
async function owned(ctx: ServiceContext, id: string): Promise<DraftListRow> {
  const row = await getDraft(ctx, id);
  if (!row) throw new AppError('not_found');
  return row;
}

/** The pinned pair for a new draft: the profile's latest version and the uncached active prompt (D-D2, D-D4). */
async function pins(
  ctx: ServiceContext,
  profileId: string | null,
  contentType: DraftContentType,
): Promise<{ profileId: string; profileVersionId: string; promptVersionId: string }> {
  const profile = profileId && UUID_RE.test(profileId) ? await getProfile(ctx, profileId) : null;
  if (!profile || profile.status !== 'active' || !profile.latestVersionId) {
    throw new AppError('no_profile', 'No profile with a version');
  }
  const prompt = await getActiveVersion(DRAFT_PROMPT_KEY[contentType]);
  if (!prompt) throw new AppError('conflict', 'No active prompt version');
  return { profileId: profile.id, profileVersionId: profile.latestVersionId, promptVersionId: prompt.id };
}

async function insertQueued(values: typeof draft.$inferInsert): Promise<{ draftId: string }> {
  const [row] = await getDb().insert(draft).values(values).returning({ id: draft.id });
  if (!row) throw new Error('draft_insert_failed');
  await enqueue('draft.generate', { userId: values.userId, draftId: row.id }, { jobId: jobIds.draft(row.id) });
  return { draftId: row.id };
}

const briefSchema = z
  .string()
  .max(BRIEF_MAX)
  .refine((s) => s.trim().length > 0);

/** Creates a queued draft pinned to the profile's latest version (T151). Rate limiting lives in the route (D-D7). */
export async function create(
  ctx: ServiceContext,
  input: { contentType: DraftContentType; profileId: string; brief: string },
): Promise<{ draftId: string }> {
  if (!briefSchema.safeParse(input.brief).success) throw new AppError('validation_failed');
  const pinned = await pins(ctx, input.profileId, input.contentType);
  return insertQueued({
    userId: ctx.userId,
    contentType: input.contentType,
    ...pinned,
    topicEnc: encrypt('user-content', input.brief.trim().slice(0, TOPIC_CHARS)),
    briefEnc: encrypt('user-content', input.brief),
    status: 'queued',
  });
}

// Cursor is `<createdAt ISO>|<id>` base64url-encoded; newest first.
function encodeCursor(d: Draft): string {
  return Buffer.from(`${d.createdAt.toISOString()}|${d.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!iso || !id || !UUID_RE.test(id) || Number.isNaN(createdAt.getTime())) {
    throw new AppError('validation_failed', 'Invalid cursor');
  }
  return { createdAt, id };
}

export async function list(
  ctx: ServiceContext,
  q: { contentType?: DraftContentType; profileId?: string; cursor?: string; limit: number },
): Promise<{ items: DraftListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit)), LIST_MAX_LIMIT);
  if (q.profileId !== undefined && !UUID_RE.test(q.profileId)) return { items: [], nextCursor: null };
  const rows = await listDrafts(ctx, {
    contentType: q.contentType,
    profileId: q.profileId,
    before: q.cursor ? decodeCursor(q.cursor) : undefined,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toListItem),
    nextCursor: rows.length > limit && last ? encodeCursor(last.draft) : null,
  };
}

export async function get(ctx: ServiceContext, id: string): Promise<DraftView> {
  return toView(await owned(ctx, id));
}

/** Stores the user's edit next to the generated text; only a ready draft can be edited. */
export async function edit(ctx: ServiceContext, id: string, editedText: string): Promise<DraftView> {
  const row = await owned(ctx, id);
  if (editedText.length > EDITED_TEXT_MAX) throw new AppError('validation_failed');
  if (row.draft.status !== 'ready') throw new AppError('conflict', 'Draft is not ready');
  await getDb()
    .update(draft)
    .set({ editedTextEnc: encrypt('user-content', editedText) })
    .where(and(eq(draft.id, row.draft.id), eq(draft.userId, ctx.userId)));
  return get(ctx, id);
}

/**
 * A new draft with `parent_draft_id` and the feedback, pinning the profile's CURRENT latest version and the
 * CURRENT active prompt (D-D2); the parent is untouched (FR-053, FR-058).
 */
export async function regenerate(ctx: ServiceContext, id: string, feedback?: string): Promise<{ draftId: string }> {
  const parent = (await owned(ctx, id)).draft;
  if (feedback !== undefined && feedback.length > FEEDBACK_MAX) throw new AppError('validation_failed');
  const pinned = await pins(ctx, parent.profileId, parent.contentType);
  const text = feedback?.trim() ? feedback : null;
  return insertQueued({
    userId: ctx.userId,
    contentType: parent.contentType,
    ...pinned,
    parentDraftId: parent.id,
    topicEnc: parent.topicEnc,
    briefEnc: parent.briefEnc,
    feedbackEnc: enc(text),
    status: 'queued',
  });
}

export async function rate(ctx: ServiceContext, id: string, rating: DraftRating): Promise<DraftView> {
  const row = await owned(ctx, id);
  if (row.draft.status !== 'ready') throw new AppError('conflict', 'Draft is not ready');
  await getDb()
    .update(draft)
    .set({ rating, ratedAt: new Date() })
    .where(and(eq(draft.id, row.draft.id), eq(draft.userId, ctx.userId)));
  return get(ctx, id);
}

const EXPORT_TYPES = { md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8' } as const;

/** A downloadable file of the current text (edited ?? generated). There is no publishing (FR-056). */
export async function exportDraft(
  ctx: ServiceContext,
  id: string,
  format: 'md' | 'txt',
): Promise<{ filename: string; contentType: string; body: string }> {
  const view = toView(await owned(ctx, id));
  if (view.text === null) throw new AppError('conflict', 'Draft is not ready');
  const heading = view.title ? (format === 'md' ? `# ${view.title}\n\n` : `${view.title}\n\n`) : '';
  return {
    filename: `draft-${view.createdAt.slice(0, 10)}-${view.contentType}.${format}`,
    contentType: EXPORT_TYPES[format],
    body: `${heading}${view.text}\n`,
  };
}

/** Hard delete (FR-055); a regenerated child keeps its row with `parent_draft_id` null. */
export async function remove(ctx: ServiceContext, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  await withTransaction(async (tx) => {
    const [row] = await tx
      .delete(draft)
      .where(and(eq(draft.id, id), eq(draft.userId, ctx.userId)))
      .returning({ contentType: draft.contentType });
    if (!row) throw new AppError('not_found');
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'draft.deleted',
        targetType: 'draft',
        targetId: id,
        metadata: { contentType: row.contentType },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Worker-facing (draft.generate)

export interface DraftRun {
  draft: Draft;
  user: { name: string | null; status: UserStatus };
  /** Null when the pinned version went with its deleted profile (D-D1). */
  profileVersion: ProfileVersion | null;
  /** Name of the definition version the pinned profile version was built with. */
  definitionName: string | null;
  /** Dimensions of that definition version; names the sections when a legacy body is shown as a document. */
  definitionDimensions: Dimension[];
  promptVersion: PromptTemplateVersion;
  parent: Draft | null;
}

export async function loadDraftForRun(id: string): Promise<DraftRun | null> {
  if (!UUID_RE.test(id)) return null;
  const db = getDb();
  const [row] = await db
    .select({
      draft,
      user: { name: user.name, status: user.status },
      profileVersion,
      definitionName: toneDefinitionVersion.name,
      definitionDimensions: toneDefinitionVersion.dimensions,
      promptVersion: promptTemplateVersion,
    })
    .from(draft)
    .innerJoin(user, eq(user.id, draft.userId))
    .innerJoin(promptTemplateVersion, eq(promptTemplateVersion.id, draft.promptVersionId))
    .leftJoin(profileVersion, eq(profileVersion.id, draft.profileVersionId))
    .leftJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, profileVersion.definitionVersionId))
    .where(eq(draft.id, id))
    .limit(1);
  if (!row) return null;
  const parent = row.draft.parentDraftId
    ? ((
        await db
          .select()
          .from(draft)
          .where(and(eq(draft.id, row.draft.parentDraftId), eq(draft.userId, row.draft.userId)))
          .limit(1)
      )[0] ?? null)
    : null;
  return { ...row, definitionDimensions: row.definitionDimensions ?? [], parent };
}

/** Raw (decrypted, NOT yet inspected) inputs: the processor inspects each one before any use (Principle I). */
export function decryptDraftInputs(run: DraftRun): {
  brief: string;
  feedback: string | null;
  previousDraft: string | null;
  profileBody: VersionBodyView | null;
} {
  return {
    brief: decrypt('user-content', run.draft.briefEnc),
    feedback: dec(run.draft.feedbackEnc),
    previousDraft: run.parent ? dec(run.parent.editedTextEnc ?? run.parent.generatedTextEnc) : null,
    profileBody: run.profileVersion ? decryptVersionBody(run.profileVersion) : null,
  };
}

const RUNNABLE: DraftStatus[] = ['queued', 'generating'];

/** queued -> generating; false when the draft is gone or already finished. */
export async function markGenerating(id: string): Promise<boolean> {
  const rows = await getDb()
    .update(draft)
    .set({ status: 'generating' })
    .where(and(eq(draft.id, id), inArray(draft.status, RUNNABLE)))
    .returning({ id: draft.id });
  return rows.length > 0;
}

/** Stores the inspected output encrypted, sets `ready` and notifies `draft_ready` once. */
export async function completeDraft(
  id: string,
  out: { title: string | null; body: string; notes: string | null; truncated: boolean; redactionsApplied: number },
): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(draft)
      .set({
        generatedTextEnc: encrypt('user-content', out.body),
        titleEnc: enc(out.title),
        notesEnc: enc(out.notes),
        truncated: out.truncated,
        redactionsApplied: out.redactionsApplied,
        status: 'ready',
        errorCode: null,
        completedAt: new Date(),
      })
      .where(and(eq(draft.id, id), inArray(draft.status, RUNNABLE)))
      .returning({ userId: draft.userId });
    if (row) await notify(row.userId, 'draft_ready', { draftId: id }, tx);
  });
}

/** Sets `failed` with an error code (never content); notifies `draft_failed` when asked. */
export async function failDraft(
  id: string,
  errorCode: string,
  opts: { notify?: boolean; redactionsApplied?: number } = {},
): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(draft)
      .set({
        status: 'failed',
        errorCode,
        ...(opts.redactionsApplied === undefined ? {} : { redactionsApplied: opts.redactionsApplied }),
      })
      .where(and(eq(draft.id, id), inArray(draft.status, RUNNABLE)))
      .returning({ userId: draft.userId });
    if (row && opts.notify) await notify(row.userId, 'draft_failed', { draftId: id }, tx);
  });
}
