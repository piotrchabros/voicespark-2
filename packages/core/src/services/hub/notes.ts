import { z } from 'zod';
import { getDb, withTransaction, type DbOrTx, type HubNote, type Tx } from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import * as repo from '@voicespark/db/repos/user/hub-records';
import { AppError, type ServiceContext } from '../../errors';
import {
  noteTextSegments,
  noteToPlainText,
  rebuildNoteDoc,
  validateNoteDoc,
  type HubNode,
  type HubNoteDoc,
} from '../../hub/content-schema';
import { indexTokens } from '../../hub/search-tokens';
import { decryptContent, encryptContent, hubNotFound, inspectFields, type HubKind } from './common';
import { markDirty, syncFieldFor, syncFieldsFor, tombstone, type SyncField } from './sync';

// Notes on people, companies and projects (US2; contracts/http-api.md "Notes", data-model.md "hub_note"; FR-008,
// FR-028). Text nodes, link hrefs and the title pass `inspectSegments` under the user's full policy before anything
// is stored; only the latest version is kept. Every write marks the note and its owner dirty and rewrites the blind
// search row in its own transaction.

export interface NoteView {
  id: string;
  owner: { kind: HubKind; id: string };
  title: string;
  body: HubNoteDoc;
  redactedValues: number;
  createdAt: string;
  updatedAt: string;
  sync: SyncField;
}

export interface NoteInput {
  title: string;
  body: unknown;
}

export interface NotePatchInput {
  title?: string;
  body?: unknown;
}

export interface NoteListQuery {
  cursor?: string;
  limit?: number;
}

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
const TITLE_MAX = 300;
const HREF_RE = /^(https?|mailto):/i;

const titleField = z.string().max(TITLE_MAX);
const createSchema = z.object({ title: titleField, body: z.unknown() }).strict();
const patchSchema = z.object({ title: titleField.optional(), body: z.unknown().optional() }).strict();
const listSchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
  })
  .strict();

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
    throw new AppError('validation_failed', undefined, { fields });
  }
  return r.data;
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;

function validBody(body: unknown): HubNoteDoc {
  const v = validateNoteDoc(body);
  if (!v.ok) throw new AppError('validation_failed', undefined, { fields: ['body'], reason: v.reason });
  return v.doc;
}

function ownerOf(row: HubNote): { kind: HubKind; id: string } {
  if (row.personId) return { kind: 'person', id: row.personId };
  if (row.companyId) return { kind: 'company', id: row.companyId };
  return { kind: 'project', id: row.projectId! };
}

/** A link whose href was redacted away is no longer a link: the text keeps the marker, the mark is dropped. */
function dropBrokenLinks(doc: HubNoteDoc): HubNoteDoc {
  const visit = (n: HubNode) => {
    if (n.marks) {
      n.marks = n.marks.filter((m) => m.type !== 'link' || HREF_RE.test(m.attrs?.href ?? ''));
      if (n.marks.length === 0) delete n.marks;
    }
    for (const c of n.content ?? []) visit(c);
  };
  for (const c of doc.content) visit(c);
  return doc;
}

interface Inspected {
  title?: string;
  body?: HubNoteDoc;
  redactedValues: number;
}

/**
 * One inspection call over the title and every text node and href of the body. A wholly excluded note throws 422
 * `note_excluded` with `details.category`; an inspection failure throws 503 `inspection_unavailable` (fail-closed).
 */
async function inspectNote(ctx: ServiceContext, title: string | undefined, body: HubNoteDoc | undefined): Promise<Inspected> {
  const segments = body ? noteTextSegments(body) : [];
  const fields: Record<string, string> = {};
  if (title !== undefined) fields.title = title;
  segments.forEach((s, i) => {
    fields[`s${i}`] = s.value;
  });
  let inspected: Awaited<ReturnType<typeof inspectFields<string>>>;
  try {
    inspected = await inspectFields(ctx, fields);
  } catch (err) {
    if (err instanceof AppError && err.code === 'sensitive_content') {
      throw new AppError('note_excluded', undefined, { category: err.details?.category });
    }
    throw err;
  }
  return {
    title: title === undefined ? undefined : inspected.values.title,
    body: body ? dropBrokenLinks(rebuildNoteDoc(body, segments.map((_, i) => inspected.values[`s${i}`]!))) : undefined,
    redactedValues: inspected.redactedValues,
  };
}

async function toView(ctx: ServiceContext, row: HubNote, db: DbOrTx): Promise<NoteView> {
  return viewOf(row, await syncFieldFor(ctx.userId, 'note', row.id, db));
}

function viewOf(row: HubNote, sync: SyncField): NoteView {
  return {
    id: row.id,
    owner: ownerOf(row),
    title: decryptContent(row.titleEnc),
    body: JSON.parse(decryptContent(row.bodyJsonEnc)) as HubNoteDoc,
    redactedValues: row.redactedValues,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sync,
  };
}

/** Search row (title and plain text), dirty marks of the note and its owner; same transaction as the write. */
async function afterWrite(ctx: ServiceContext, row: HubNote, title: string, body: HubNoteDoc, tx: Tx): Promise<void> {
  const owner = ownerOf(row);
  await content.upsertSearchDoc(
    ctx,
    {
      itemType: 'note',
      itemId: row.id,
      ownerKind: owner.kind,
      ownerId: owner.id,
      tokens: indexTokens(ctx.userId, [title, noteToPlainText(body)].filter(Boolean)),
      updatedAt: row.updatedAt,
    },
    tx,
  );
  await markDirty(tx, ctx.userId, 'note', row.id);
  await markDirty(tx, ctx.userId, owner.kind, owner.id);
}

async function mustOwnRecord(ctx: ServiceContext, kind: HubKind, id: string, db: DbOrTx): Promise<void> {
  if (!isUuid(id) || !(await repo.getRecord(ctx, kind, id, db))) throw hubNotFound();
}

async function mustGetNote(ctx: ServiceContext, id: string, db: DbOrTx = getDb()): Promise<HubNote> {
  const row = isUuid(id) ? await content.getNote(ctx, id, db) : null;
  if (!row) throw hubNotFound();
  return row;
}

function encodeCursor(row: HubNote): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { t: number; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const t = ts ? Date.parse(ts) : Number.NaN;
  if (Number.isNaN(t) || !id || !isUuid(id)) throw new AppError('validation_failed', undefined, { fields: ['cursor'] });
  return { t, id };
}

// ---------------------------------------------------------------------------------------------------------------
// Service

/** Notes of a record, newest change first. Default 25, at most 100. */
export async function list(
  ctx: ServiceContext,
  kind: HubKind,
  recordId: string,
  query: NoteListQuery,
): Promise<{ items: NoteView[]; nextCursor: string | null }> {
  const q = parse(listSchema, query);
  const limit = q.limit ?? LIST_DEFAULT_LIMIT;
  const db = getDb();
  await mustOwnRecord(ctx, kind, recordId, db);
  let rows = await content.listNotesForOwner(ctx, { kind, id: recordId }, db);
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    rows = rows.filter((r) => r.updatedAt.getTime() < c.t || (r.updatedAt.getTime() === c.t && r.id > c.id));
  }
  const page = rows.slice(0, limit);
  // One sync-status query for the page, not one per note (SC-002).
  const syncs = await syncFieldsFor(ctx.userId, 'note', page.map((r) => r.id), db);
  const items = page.map((row) => viewOf(row, syncs.get(row.id)!));
  return { items, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
}

/** Validates, inspects and stores a note on the record. */
export async function create(ctx: ServiceContext, kind: HubKind, recordId: string, input: NoteInput): Promise<NoteView> {
  const data = parse(createSchema, input);
  const body = validBody(data.body);
  // Ownership first: a foreign id is 404 before any inspection runs.
  await mustOwnRecord(ctx, kind, recordId, getDb());
  const inspected = await inspectNote(ctx, data.title, body);
  const title = inspected.title!;
  const doc = inspected.body!;

  return withTransaction(async (tx) => {
    if (!(await repo.lockRecord(ctx, kind, recordId, tx))) throw hubNotFound();
    const row = await content.insertNote(
      ctx,
      { kind, id: recordId },
      {
        titleEnc: encryptContent(title),
        bodyJsonEnc: encryptContent(JSON.stringify(doc)),
        redactedValues: inspected.redactedValues,
      },
      tx,
    );
    await afterWrite(ctx, row, title, doc, tx);
    return toView(ctx, row, tx);
  });
}

export async function get(ctx: ServiceContext, id: string): Promise<NoteView> {
  const db = getDb();
  return toView(ctx, await mustGetNote(ctx, id, db), db);
}

/**
 * Replaces the title and/or body (only the latest version is kept). With a new body `redactedValues` is the count of
 * this write; a title-only patch adds the title's redactions to the stored count.
 */
export async function patch(ctx: ServiceContext, id: string, input: NotePatchInput): Promise<NoteView> {
  const data = parse(patchSchema, input);
  if (data.title === undefined && data.body === undefined) {
    throw new AppError('validation_failed', undefined, { fields: [] });
  }
  const body = data.body === undefined ? undefined : validBody(data.body);
  const current = await mustGetNote(ctx, id);
  const inspected = await inspectNote(ctx, data.title, body);

  return withTransaction(async (tx) => {
    const set: content.HubNotePatch = { updatedAt: new Date() };
    if (inspected.title !== undefined) set.titleEnc = encryptContent(inspected.title);
    if (inspected.body !== undefined) {
      set.bodyJsonEnc = encryptContent(JSON.stringify(inspected.body));
      set.redactedValues = inspected.redactedValues;
    } else {
      set.redactedValues = current.redactedValues + inspected.redactedValues;
    }
    const row = await content.updateNote(ctx, id, set, tx);
    if (!row) throw hubNotFound();
    const title = inspected.title ?? decryptContent(row.titleEnc);
    const doc = inspected.body ?? (JSON.parse(decryptContent(row.bodyJsonEnc)) as HubNoteDoc);
    await afterWrite(ctx, row, title, doc, tx);
    return toView(ctx, row, tx);
  });
}

/** Deletes the note and its search row, tombstones its memory copy and marks the owner dirty. */
export async function remove(ctx: ServiceContext, id: string): Promise<void> {
  if (!isUuid(id)) throw hubNotFound();
  await withTransaction(async (tx) => {
    const row = await content.getNote(ctx, id, tx);
    if (!row) throw hubNotFound();
    const owner = ownerOf(row);
    await tombstone(tx, ctx.userId, 'note', id);
    await markDirty(tx, ctx.userId, owner.kind, owner.id);
    await content.deleteSearchDoc(ctx, 'note', id, tx);
    if (!(await content.deleteNote(ctx, id, tx))) throw hubNotFound();
  });
}
