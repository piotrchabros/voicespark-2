import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  getDb,
  hubCompany,
  hubFact,
  hubFile,
  hubMergeRedirect,
  hubNote,
  hubPerson,
  hubProject,
  withTransaction,
  type DbOrTx,
  type HubCompany,
  type HubCompanyDomain,
  type HubLink,
  type HubPerson,
  type HubPersonEmail,
  type HubProject,
  type Tx,
} from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import { insertBlockMarker } from '@voicespark/db/repos/user/hub-mail';
import * as repo from '@voicespark/db/repos/user/hub-records';
import { recordTree } from '@voicespark/db/repos/user/hub-sync';
import { inspectSegments, validateContactValue, type Policy } from '@voicespark/filters';
import { hmacHex } from '../../crypto';
import { AppError, type ServiceContext } from '../../errors';
import { createFsBlobStore } from '../../hub/blob-store';
import { markerKey } from '../../hub/fingerprint';
import { addressHash, matchHash, matchKey, nameKey, normalizeWebsite } from '../../hub/normalize';
import { indexTokens } from '../../hub/search-tokens';
import { logger } from '../../logger';
import { audit } from '../audit';
import { getClassifier } from '../inspection';
import { decryptContent, encryptContent, hubNotFound, inspectFields, type HubKind } from './common';
import { markDirty, markRecordTree, syncFieldFor, type SyncField } from './sync';

// People, companies and projects of the Context Hub (US1; contracts/http-api.md "Records", data-model.md
// "hub_person" .. "hub_project", "Provenance and owner_fields", "Deletion behaviour"; FR-001..FR-004, FR-006,
// FR-016, FR-017). Every write marks the outbox and rewrites the blind search row in its own transaction.

export type { HubKind };
export type Origin = 'user' | 'email';
export type ProjectStatus = 'planned' | 'active' | 'on_hold' | 'completed';

export interface EmailView {
  id: string;
  address: string;
  isPrimary: boolean;
  origin: Origin;
}

export interface DomainView {
  id: string;
  domain: string;
  origin: Origin;
}

interface RecordBase {
  id: string;
  name: string;
  description: string | null;
  ownerFields: string[];
  createdFrom: Origin;
  createdAt: string;
  updatedAt: string;
}

export interface PersonView extends RecordBase {
  roleTitle: string | null;
  phone: string | null;
  emails: EmailView[];
}

export interface CompanyView extends RecordBase {
  website: string | null;
  industry: string | null;
  domains: DomainView[];
}

export interface ProjectView extends RecordBase {
  status: ProjectStatus;
  startDate: string | null;
  endDate: string | null;
}

export type RecordView = PersonView | CompanyView | ProjectView;

export interface LinkView {
  id: string;
  kind: HubLink['kind'];
  personId: string | null;
  companyId: string | null;
  projectId: string | null;
  role: string | null;
  origin: Origin;
  createdAt: string;
}

export interface SimilarRecord {
  id: string;
  name: string;
}

export interface WriteResult {
  record: RecordView;
  similar: SimilarRecord[];
  /** Present when above zero. */
  redactedValues?: number;
}

export type LinkCounts = Partial<Record<HubKind, number>>;

export type ListItem = RecordView & { linkCounts: LinkCounts; noteCount: number; fileCount: number };

export interface DeletePreview {
  notes: number;
  files: number;
  links: number;
}

export interface PersonInput {
  name: string;
  roleTitle?: string | null;
  phone?: string | null;
  description?: string | null;
  emails?: string[];
}

export interface CompanyInput {
  name: string;
  website?: string | null;
  industry?: string | null;
  description?: string | null;
  domains?: string[];
}

export interface ProjectInput {
  name: string;
  status?: ProjectStatus;
  startDate?: string | null;
  endDate?: string | null;
  description?: string | null;
}

export interface CreateInput {
  person: PersonInput;
  company: CompanyInput;
  project: ProjectInput;
}

export interface PatchInput {
  person: Partial<Omit<PersonInput, 'emails'>>;
  company: Partial<Omit<CompanyInput, 'domains'>>;
  project: Partial<ProjectInput>;
}

export interface ListQuery {
  sort?: 'name' | 'updated';
  order?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
const MAX_VALUES = 50;
const PHONE_RE = /^[0-9+()\-.\s/x]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: HubKind[] = ['person', 'company', 'project'];
const PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'completed'] as const;

const TABLES = { person: hubPerson, company: hubCompany, project: hubProject } as const;
const NOTE_OWNER = { person: hubNote.personId, company: hubNote.companyId, project: hubNote.projectId };
const FILE_OWNER = { person: hubFile.personId, company: hubFile.companyId, project: hubFile.projectId };
const FACT_TARGET = { person: hubFact.personId, company: hubFact.companyId, project: hubFact.projectId };

// ---------------------------------------------------------------------------------------------------------------
// Input schemas (limits of contracts/http-api.md "Conventions added")

const nameField = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const dateField = z
  .string()
  .regex(DATE_RE)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  })
  .nullable()
  .optional();

const personFields = {
  name: nameField,
  roleTitle: text(200),
  phone: z.string().trim().max(50).regex(PHONE_RE).nullable().optional(),
  description: text(2000),
};
const companyFields = {
  name: nameField,
  website: text(2048),
  industry: text(200),
  description: text(2000),
};
const projectFields = {
  name: nameField,
  status: z.enum(PROJECT_STATUSES).optional(),
  startDate: dateField,
  endDate: dateField,
  description: text(2000),
};

const emailRaw = z.string().max(320);
const domainRaw = z.string().max(253);

const CREATE_SCHEMAS = {
  person: z.object({ ...personFields, emails: z.array(emailRaw).max(MAX_VALUES).optional() }).strict(),
  company: z.object({ ...companyFields, domains: z.array(domainRaw).max(MAX_VALUES).optional() }).strict(),
  project: z.object(projectFields).strict(),
};

const PATCH_SCHEMAS = {
  person: z.object(personFields).partial().strict(),
  company: z.object(companyFields).partial().strict(),
  project: z.object(projectFields).partial().strict(),
};

const listSchema = z
  .object({
    sort: z.enum(['name', 'updated']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
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

// ---------------------------------------------------------------------------------------------------------------
// Contact values

/** The detector set `validateContactValue` runs, used to tell a secret from a malformed value. */
const CONTACT_SECRET_POLICY: Policy = {
  selectedCategories: [
    'passwords',
    'otp_codes',
    'reset_verification_links',
    'api_keys_tokens',
    'payment_cards',
    'bank_accounts',
    'government_ids',
  ],
  rules: [],
};

async function looksSecret(raw: string): Promise<boolean> {
  try {
    const r = await inspectSegments([raw], CONTACT_SECRET_POLICY, { classifier: getClassifier() });
    return r.excluded || r.redactedValues > 0;
  } catch {
    throw new AppError('inspection_unavailable');
  }
}

/**
 * `validateContactValue` or throw: 422 `sensitive_content` with `details.fields` when a detector hits the raw
 * value, 422 `validation_failed` when the format is wrong. The value never appears in the error.
 */
async function contactValue(kind: 'email' | 'phone' | 'domain', raw: string, field: string): Promise<string> {
  const value = validateContactValue(kind, raw);
  if (value !== null) return value;
  if (await looksSecret(raw)) throw new AppError('sensitive_content', undefined, { fields: [field] });
  throw new AppError('validation_failed', undefined, { fields: [field] });
}

/** HMAC of the lower-cased domain (`hub_company_domain.domain_hash`). */
export function domainHash(domain: string): string {
  return hmacHex(`domain:${domain.trim().toLowerCase()}`);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

// ---------------------------------------------------------------------------------------------------------------
// Views

const decOpt = (blob: string | null): string | null => (blob === null ? null : decryptContent(blob));

function emailView(e: HubPersonEmail): EmailView {
  return { id: e.id, address: decryptContent(e.addressEnc), isPrimary: e.isPrimary, origin: e.origin };
}

function domainView(d: HubCompanyDomain): DomainView {
  return { id: d.id, domain: decryptContent(d.domainEnc), origin: d.origin };
}

function baseView(row: repo.HubRecordRow): RecordBase {
  return {
    id: row.id,
    name: decryptContent(row.nameEnc),
    description: decOpt(row.descriptionEnc),
    ownerFields: [...row.ownerFields],
    createdFrom: row.createdFrom,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toView(
  kind: HubKind,
  row: repo.HubRecordRow,
  emails: HubPersonEmail[] = [],
  domains: HubCompanyDomain[] = [],
): RecordView {
  if (kind === 'person') {
    const p = row as HubPerson;
    return { ...baseView(p), roleTitle: decOpt(p.roleTitleEnc), phone: decOpt(p.phoneEnc), emails: emails.map(emailView) };
  }
  if (kind === 'company') {
    const c = row as HubCompany;
    return {
      ...baseView(c),
      website: decOpt(c.websiteEnc),
      industry: decOpt(c.industryEnc),
      domains: domains.map(domainView),
    };
  }
  const p = row as HubProject;
  return { ...baseView(p), status: p.status, startDate: p.startDate, endDate: p.endDate };
}

async function loadView(ctx: ServiceContext, kind: HubKind, row: repo.HubRecordRow, db: DbOrTx): Promise<RecordView> {
  const emails = kind === 'person' ? await repo.listEmails(ctx, row.id, db) : [];
  const domains = kind === 'company' ? await repo.listDomains(ctx, row.id, db) : [];
  return toView(kind, row, emails, domains);
}

function linkView(l: HubLink): LinkView {
  return {
    id: l.id,
    kind: l.kind,
    personId: l.personId,
    companyId: l.companyId,
    projectId: l.projectId,
    role: decOpt(l.roleEnc),
    origin: l.origin,
    createdAt: l.createdAt.toISOString(),
  };
}

/** The other end of a link seen from `kind`. */
function otherEnd(kind: HubKind, l: HubLink): { kind: HubKind; id: string } | null {
  for (const k of KINDS) {
    if (k === kind) continue;
    const id = k === 'person' ? l.personId : k === 'company' ? l.companyId : l.projectId;
    if (id) return { kind: k, id };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Search index (contracts/hub-search.md: the stored, filtered text of the record)

function indexedText(view: RecordView, kind: HubKind): string[] {
  const out: (string | null)[] = [view.name, view.description];
  if (kind === 'person') {
    const p = view as PersonView;
    out.push(p.roleTitle, p.phone, ...p.emails.map((e) => e.address));
  } else if (kind === 'company') {
    const c = view as CompanyView;
    out.push(...c.domains.map((d) => d.domain), c.website, c.industry);
  } else {
    out.push((view as ProjectView).status);
  }
  return out.filter((s): s is string => !!s);
}

/** Rewrites the record's blind search row from its stored, filtered fields. Same transaction as the write. */
export async function reindex(ctx: ServiceContext, kind: HubKind, row: repo.HubRecordRow, tx: Tx): Promise<RecordView> {
  const view = await loadView(ctx, kind, row, tx);
  await content.upsertSearchDoc(
    ctx,
    {
      itemType: kind,
      itemId: row.id,
      ownerKind: null,
      ownerId: null,
      tokens: indexTokens(ctx.userId, indexedText(view, kind)),
      updatedAt: row.updatedAt,
    },
    tx,
  );
  return view;
}

async function similarTo(
  ctx: ServiceContext,
  kind: HubKind,
  name: string,
  selfId: string,
  db: DbOrTx = getDb(),
): Promise<SimilarRecord[]> {
  const rows = await repo.findByNameKey(ctx, kind, nameKey(ctx.userId, kind, name), db);
  return rows.filter((r) => r.id !== selfId).map((r) => ({ id: r.id, name: decryptContent(r.nameEnc) }));
}

function withRedacted(result: Omit<WriteResult, 'redactedValues'>, redacted: number): WriteResult {
  return redacted > 0 ? { ...result, redactedValues: redacted } : result;
}

async function mustLock(ctx: ServiceContext, kind: HubKind, id: string, tx: Tx): Promise<repo.HubRecordRow> {
  const row = await repo.lockRecord(ctx, kind, id, tx);
  if (!row) throw hubNotFound();
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Field preparation shared by create and patch

type FieldValues = Record<string, string | null | undefined>;

const FREE_TEXT_FIELDS = ['name', 'roleTitle', 'description', 'industry', 'website'] as const;

/** Column values (encrypted) for the given API fields after normalising, contact checks and inspection. */
async function prepareFields(
  ctx: ServiceContext,
  kind: HubKind,
  fields: FieldValues,
): Promise<{ columns: Record<string, unknown>; redactedValues: number; name?: string }> {
  const values: FieldValues = { ...fields };
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v === '' && k !== 'name') values[k] = null;
  }
  if (typeof values.website === 'string') {
    const w = normalizeWebsite(values.website);
    if (!w) throw new AppError('validation_failed', undefined, { fields: ['website'] });
    values.website = w;
  }
  if (typeof values.phone === 'string') values.phone = await contactValue('phone', values.phone, 'phone');

  const toInspect: Record<string, string> = {};
  for (const f of FREE_TEXT_FIELDS) {
    const v = values[f];
    if (typeof v === 'string') toInspect[f] = v;
  }
  const inspected = await inspectFields(ctx, toInspect);
  const final: FieldValues = { ...values, ...inspected.values };

  const columns: Record<string, unknown> = {};
  const enc = (v: string | null | undefined) => (v === null ? null : encryptContent(v!));
  for (const [k, v] of Object.entries(final)) {
    if (v === undefined) continue;
    switch (k) {
      case 'name':
        columns.nameEnc = encryptContent(v!);
        columns.nameKey = nameKey(ctx.userId, kind, v!);
        columns.matchKey = matchKey(ctx.userId, kind, v!);
        break;
      case 'roleTitle':
        columns.roleTitleEnc = enc(v);
        break;
      case 'phone':
        columns.phoneEnc = enc(v);
        break;
      case 'description':
        columns.descriptionEnc = enc(v);
        break;
      case 'website':
        columns.websiteEnc = enc(v);
        break;
      case 'industry':
        columns.industryEnc = enc(v);
        break;
      case 'status':
        columns.status = v;
        break;
      case 'startDate':
        columns.startDate = v;
        break;
      case 'endDate':
        columns.endDate = v;
        break;
    }
  }
  return { columns, redactedValues: inspected.redactedValues, name: final.name ?? undefined };
}

function assertDateOrder(start: string | null | undefined, end: string | null | undefined): void {
  if (start && end && end < start) throw new AppError('validation_failed', undefined, { fields: ['endDate'] });
}

async function insertEmailRow(
  ctx: ServiceContext,
  personId: string,
  address: string,
  isPrimary: boolean,
  tx: Tx,
  createdAt?: Date,
): Promise<HubPersonEmail> {
  if (await repo.findEmailByHash(ctx, addressHash(address), tx)) {
    throw new AppError('conflict', undefined, { fields: ['emails'] });
  }
  return repo.insertEmail(
    ctx,
    {
      personId,
      addressEnc: encryptContent(address),
      addressHash: addressHash(address),
      matchHash: matchHash(address),
      isPrimary,
      origin: 'user',
      ...(createdAt ? { createdAt } : {}),
    },
    tx,
  );
}

async function insertDomainRow(
  ctx: ServiceContext,
  companyId: string,
  domain: string,
  tx: Tx,
  createdAt?: Date,
): Promise<HubCompanyDomain> {
  if (await repo.findDomainByHash(ctx, domainHash(domain), tx)) {
    throw new AppError('conflict', undefined, { fields: ['domains'] });
  }
  return repo.insertDomain(
    ctx,
    {
      companyId,
      domainEnc: encryptContent(domain),
      domainHash: domainHash(domain),
      origin: 'user',
      ...(createdAt ? { createdAt } : {}),
    },
    tx,
  );
}

/** Runs `fn` in a transaction; a unique violation (concurrent duplicate email or domain) becomes 409 `conflict`. */
async function writeTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(fn);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict');
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Service

/** Validates and stores a record. Returns `similar` (same name, same kind, ignoring case; never blocks). FR-002, FR-003. */
export async function create<K extends HubKind>(
  ctx: ServiceContext,
  kind: K,
  input: CreateInput[K],
): Promise<WriteResult> {
  const data = parse(CREATE_SCHEMAS[kind], input) as Record<string, unknown>;
  const { emails: rawEmails, domains: rawDomains, ...fields } = data as FieldValues & {
    emails?: string[];
    domains?: string[];
  };
  if (kind === 'project') assertDateOrder(fields.startDate, fields.endDate);

  const emails: string[] = [];
  for (const raw of rawEmails ?? []) emails.push(await contactValue('email', raw, 'emails'));
  const domains: string[] = [];
  for (const raw of rawDomains ?? []) domains.push(await contactValue('domain', raw, 'domains'));
  if (new Set(emails).size !== emails.length) throw new AppError('conflict', undefined, { fields: ['emails'] });
  if (new Set(domains).size !== domains.length) throw new AppError('conflict', undefined, { fields: ['domains'] });

  const prepared = await prepareFields(ctx, kind, fields);
  // Create stores every non-null submitted field as owner-set (FR-016).
  const ownerFields = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k]) => k);

  return writeTx(async (tx) => {
    const row = await repo.insertRecord(
      ctx,
      kind,
      { ...(prepared.columns as object), ownerFields, createdFrom: 'user' } as never,
      tx,
    );
    // Distinct creation times keep the submitted order stable.
    const base = Date.now();
    for (const [i, address] of emails.entries()) {
      await insertEmailRow(ctx, row.id, address, i === 0, tx, new Date(base + i));
    }
    for (const [i, domain] of domains.entries()) await insertDomainRow(ctx, row.id, domain, tx, new Date(base + i));
    const record = await reindex(ctx, kind, row, tx);
    await markDirty(tx, ctx.userId, kind, row.id);
    const similar = await similarTo(ctx, kind, record.name, row.id, tx);
    return withRedacted({ record, similar }, prepared.redactedValues);
  });
}

/**
 * Patches the given fields. A field set to null counts as user-cleared. Every patched field joins `ownerFields` and
 * applied email facts on those fields become `overridden` (FR-016). A rename marks the linked records dirty too.
 */
export async function patch<K extends HubKind>(
  ctx: ServiceContext,
  kind: K,
  id: string,
  input: PatchInput[K],
): Promise<WriteResult> {
  const fields = parse(PATCH_SCHEMAS[kind], input) as FieldValues;
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (keys.length === 0) throw new AppError('validation_failed', undefined, { fields: [] });
  // Ownership first: a foreign id is 404 before any inspection runs.
  const current = await repo.getRecord(ctx, kind, id);
  if (!current) throw hubNotFound();
  const prepared = await prepareFields(ctx, kind, fields);

  return writeTx(async (tx) => {
    const row = await mustLock(ctx, kind, id, tx);
    if (kind === 'project') {
      const p = row as HubProject;
      assertDateOrder(
        fields.startDate === undefined ? p.startDate : fields.startDate,
        fields.endDate === undefined ? p.endDate : fields.endDate,
      );
    }
    const ownerFields = [...new Set([...row.ownerFields, ...keys])];
    const updated = await repo.updateRecord(
      ctx,
      kind,
      id,
      { ...(prepared.columns as object), ownerFields } as never,
      tx,
    );
    if (!updated) throw hubNotFound();
    await tx
      .update(hubFact)
      .set({ state: 'overridden' })
      .where(
        and(
          eq(hubFact.userId, ctx.userId),
          eq(FACT_TARGET[kind], id),
          eq(hubFact.state, 'applied'),
          inArray(hubFact.field, keys),
        ),
      );
    const record = await reindex(ctx, kind, updated, tx);
    if (fields.name !== undefined) await markRecordTree(tx, ctx.userId, kind, id);
    else await markDirty(tx, ctx.userId, kind, id);
    const similar = await similarTo(ctx, kind, record.name, id, tx);
    return withRedacted({ record, similar }, prepared.redactedValues);
  });
}

/** The record with its links (either end) and the sync field. */
export async function get(
  ctx: ServiceContext,
  kind: HubKind,
  id: string,
): Promise<{
  record: RecordView;
  links: { link: LinkView; other: { kind: HubKind; id: string; name: string } }[];
  sync: SyncField;
}> {
  const db = getDb();
  const row = await repo.getRecord(ctx, kind, id, db);
  if (!row) throw hubNotFound();
  const record = await loadView(ctx, kind, row, db);
  const links = await repo.listLinksForRecord(ctx, kind, id, db);
  const ends = links.map((l) => otherEnd(kind, l));
  const names = new Map<string, string>();
  for (const k of KINDS) {
    const ids = ends.filter((e) => e?.kind === k).map((e) => e!.id);
    for (const r of await repo.getRecordsByIds(ctx, k, ids, db)) names.set(r.id, decryptContent(r.nameEnc));
  }
  const items = links.flatMap((l, i) => {
    const end = ends[i];
    const name = end ? names.get(end.id) : undefined;
    return end && name !== undefined ? [{ link: linkView(l), other: { ...end, name } }] : [];
  });
  return { record, links: items, sync: await syncFieldFor(ctx.userId, kind, id, db) };
}

/** Counts shown before a delete (FR-004). */
export async function deletePreview(ctx: ServiceContext, kind: HubKind, id: string): Promise<DeletePreview> {
  const row = await repo.getRecord(ctx, kind, id);
  if (!row) throw hubNotFound();
  const tree = await recordTree(ctx, kind, id);
  return { notes: tree.noteIds.length, files: tree.fileIds.length, links: tree.linked.length };
}

/**
 * Deletes the record with its emails or domains, links, notes, files and thread attachments; linked records stay
 * and are marked dirty. Block markers for email-origin values (FR-017), sync tombstones, search rows, the merge
 * redirects pointing at the record and audit `hub.record_deleted` in one transaction. File blobs are removed after commit (the daily sweep catches misses).
 */
export async function remove(ctx: ServiceContext, kind: HubKind, id: string): Promise<void> {
  const storageKeys = await withTransaction(async (tx) => {
    const row = await mustLock(ctx, kind, id, tx);
    const tree = await recordTree(ctx, kind, id, tx);
    const files = await content.getFilesByIds(ctx, tree.fileIds, tx);

    const markers: string[] = [];
    if (kind === 'person') {
      for (const e of await repo.listEmails(ctx, id, tx)) {
        if (e.origin === 'email') markers.push(markerKey.personEmail(decryptContent(e.addressEnc)));
      }
    } else if (kind === 'company') {
      if (row.createdFrom === 'email') markers.push(markerKey.companyName(decryptContent(row.nameEnc)));
      for (const d of await repo.listDomains(ctx, id, tx)) {
        if (d.origin === 'email') markers.push(markerKey.companyDomain(decryptContent(d.domainEnc)));
      }
    } else if (row.createdFrom === 'email') {
      markers.push(markerKey.projectName(decryptContent(row.nameEnc)));
    }
    for (const m of markers) await insertBlockMarker(ctx, m, 'deleted', tx);

    // Before the row delete: the notes and files are still there to be tombstoned.
    await markRecordTree(tx, ctx.userId, kind, id, { deleted: true });
    await content.deleteSearchDocsForOwner(ctx, kind, id, tx);
    await content.deleteSearchDoc(ctx, kind, id, tx);
    if (!(await repo.deleteRecord(ctx, kind, id, tx))) throw hubNotFound();
    // Redirects of records merged into this one would point at a deleted id (data-model.md "hub_merge_redirect").
    await tx
      .delete(hubMergeRedirect)
      .where(
        and(eq(hubMergeRedirect.userId, ctx.userId), eq(hubMergeRedirect.kind, kind), eq(hubMergeRedirect.toId, id)),
      );
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'hub.record_deleted',
        targetType: 'hub',
        targetId: id,
        metadata: { kind, notes: tree.noteIds.length, files: tree.fileIds.length, links: tree.linked.length },
      },
      tx,
    );
    return files.map((f) => f.storageKey);
  });
  if (storageKeys.length === 0) return;
  try {
    const store = createFsBlobStore();
    for (const key of storageKeys) await store.delete(ctx.userId, key);
  } catch {
    logger.warn({ userId: ctx.userId, errorCode: 'hub_blob_delete_failed' }, 'hub blob delete failed; sweep will retry');
  }
}

function encodeCursor(parts: string[]): string {
  return Buffer.from(parts.join('|')).toString('base64url');
}

function decodeCursor(cursor: string, sort: 'name' | 'updated'): string[] {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const ok =
    sort === 'name'
      ? parts.length === 2 && parts[0] === 'n' && /^\d{1,5}$/.test(parts[1]!)
      : parts.length === 3 &&
        parts[0] === 'u' &&
        !Number.isNaN(new Date(parts[1]!).getTime()) &&
        z.uuid().safeParse(parts[2]).success;
  if (!ok) throw new AppError('validation_failed', 'Invalid cursor', { fields: ['cursor'] });
  return parts;
}

/** Page ids sorted by decrypted name in the app (at most 10,000 rows per kind). */
async function pageByName(
  ctx: ServiceContext,
  kind: HubKind,
  order: 'asc' | 'desc',
  limit: number,
  cursor: string | undefined,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  const offset = cursor ? Number(decodeCursor(cursor, 'name')[1]) : 0;
  const rows = (await repo.listForSort(ctx, kind)).map((r) => ({ id: r.id, name: decryptContent(r.nameEnc) }));
  const dir = order === 'asc' ? 1 : -1;
  rows.sort(
    (a, b) =>
      dir * (a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const page = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? encodeCursor(['n', String(offset + limit)]) : null;
  return { ids: page.map((r) => r.id), nextCursor: next };
}

/** Page ids sorted by last change in SQL (keyset on `(updated_at, id)`). */
async function pageByUpdated(
  ctx: ServiceContext,
  kind: HubKind,
  order: 'asc' | 'desc',
  limit: number,
  cursor: string | undefined,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  const t = TABLES[kind];
  const conds = [eq(t.userId, ctx.userId)];
  if (cursor) {
    const [, ts, id] = decodeCursor(cursor, 'updated');
    conds.push(
      order === 'desc'
        ? sql`(${t.updatedAt}, ${t.id}) < (${ts}::timestamptz, ${id}::uuid)`
        : sql`(${t.updatedAt}, ${t.id}) > (${ts}::timestamptz, ${id}::uuid)`,
    );
  }
  const dir = order === 'desc' ? desc : asc;
  const rows = await getDb()
    .select({ id: t.id, ts: sql<string>`${t.updatedAt}::text` })
    .from(t)
    .where(and(...conds))
    .orderBy(dir(t.updatedAt), dir(t.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    ids: page.map((r) => r.id),
    nextCursor: rows.length > limit && last ? encodeCursor(['u', last.ts, last.id]) : null,
  };
}

async function countByOwner(
  ctx: ServiceContext,
  table: typeof hubNote | typeof hubFile,
  col: (typeof NOTE_OWNER)[HubKind] | (typeof FILE_OWNER)[HubKind],
  ids: string[],
): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ ownerId: col, n: count() })
    .from(table)
    .where(and(eq(table.userId, ctx.userId), inArray(col, ids)))
    .groupBy(col);
  return new Map(rows.map((r) => [r.ownerId!, r.n]));
}

/**
 * Lists the user's records of one kind with link, note and file counts. Default `sort=name` (ascending) and limit
 * 25, at most 100; `sort=updated` defaults to newest first (FR-006).
 */
export async function list(
  ctx: ServiceContext,
  kind: HubKind,
  query: ListQuery,
): Promise<{ items: ListItem[]; nextCursor: string | null }> {
  const q = parse(listSchema, query);
  const sort = q.sort ?? 'name';
  const order = q.order ?? (sort === 'name' ? 'asc' : 'desc');
  const limit = q.limit ?? LIST_DEFAULT_LIMIT;
  const { ids, nextCursor } =
    sort === 'name'
      ? await pageByName(ctx, kind, order, limit, q.cursor)
      : await pageByUpdated(ctx, kind, order, limit, q.cursor);
  if (ids.length === 0) return { items: [], nextCursor: null };

  const db = getDb();
  const rows = new Map((await repo.getRecordsByIds(ctx, kind, ids, db)).map((r) => [r.id, r]));
  const links = await repo.listLinksForRecords(ctx, kind, ids, db);
  const notes = await countByOwner(ctx, hubNote, NOTE_OWNER[kind], ids);
  const files = await countByOwner(ctx, hubFile, FILE_OWNER[kind], ids);

  const items: ListItem[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) continue;
    const linkCounts: LinkCounts = Object.fromEntries(KINDS.filter((k) => k !== kind).map((k) => [k, 0]));
    for (const l of links) {
      const own = kind === 'person' ? l.personId : kind === 'company' ? l.companyId : l.projectId;
      const other = own === id ? otherEnd(kind, l) : null;
      if (other) linkCounts[other.kind] = (linkCounts[other.kind] ?? 0) + 1;
    }
    items.push({
      ...(await loadView(ctx, kind, row, db)),
      linkCounts,
      noteCount: notes.get(id) ?? 0,
      fileCount: files.get(id) ?? 0,
    });
  }
  return { items, nextCursor };
}

/** Adds an address to a person (the first one becomes primary). 409 `conflict` when any record of the user has it. */
export async function addEmail(
  ctx: ServiceContext,
  kind: HubKind,
  id: string,
  input: { address: string },
): Promise<EmailView> {
  if (kind !== 'person') throw hubNotFound();
  const { address: raw } = parse(z.object({ address: emailRaw }).strict(), input);
  if (!(await repo.getRecord(ctx, kind, id))) throw hubNotFound();
  const address = await contactValue('email', raw, 'address');
  return writeTx(async (tx) => {
    await mustLock(ctx, kind, id, tx);
    const hasPrimary = (await repo.listEmails(ctx, id, tx)).some((e) => e.isPrimary);
    const email = await insertEmailRow(ctx, id, address, !hasPrimary, tx);
    await touchAndReindex(ctx, kind, id, tx);
    return emailView(email);
  });
}

/** Removes an address; an email-origin address gets a block marker (FR-017). A removed primary passes to the oldest. */
export async function removeEmail(ctx: ServiceContext, kind: HubKind, id: string, emailId: string): Promise<void> {
  if (kind !== 'person') throw hubNotFound();
  await withTransaction(async (tx) => {
    await mustLock(ctx, kind, id, tx);
    const email = await repo.getEmail(ctx, id, emailId, tx);
    if (!email) throw hubNotFound();
    if (email.origin === 'email') {
      await insertBlockMarker(ctx, markerKey.personEmail(decryptContent(email.addressEnc)), 'deleted', tx);
    }
    await repo.deleteEmail(ctx, emailId, tx);
    if (email.isPrimary) {
      const [next] = await repo.listEmails(ctx, id, tx);
      if (next) await repo.updateEmail(ctx, next.id, { isPrimary: true }, tx);
    }
    await touchAndReindex(ctx, kind, id, tx);
  });
}

/** Adds a domain to a company. 409 `conflict` when any company of the user has it. */
export async function addDomain(
  ctx: ServiceContext,
  kind: HubKind,
  id: string,
  input: { domain: string },
): Promise<DomainView> {
  if (kind !== 'company') throw hubNotFound();
  const { domain: raw } = parse(z.object({ domain: domainRaw }).strict(), input);
  if (!(await repo.getRecord(ctx, kind, id))) throw hubNotFound();
  const domain = await contactValue('domain', raw, 'domain');
  return writeTx(async (tx) => {
    await mustLock(ctx, kind, id, tx);
    const row = await insertDomainRow(ctx, id, domain, tx);
    await touchAndReindex(ctx, kind, id, tx);
    return domainView(row);
  });
}

/** Removes a domain; an email-origin domain gets a block marker (FR-017). */
export async function removeDomain(ctx: ServiceContext, kind: HubKind, id: string, domainId: string): Promise<void> {
  if (kind !== 'company') throw hubNotFound();
  await withTransaction(async (tx) => {
    await mustLock(ctx, kind, id, tx);
    const domain = await repo.getDomain(ctx, id, domainId, tx);
    if (!domain) throw hubNotFound();
    if (domain.origin === 'email') {
      await insertBlockMarker(ctx, markerKey.companyDomain(decryptContent(domain.domainEnc)), 'deleted', tx);
    }
    await repo.deleteDomain(ctx, domainId, tx);
    await touchAndReindex(ctx, kind, id, tx);
  });
}

async function touchAndReindex(ctx: ServiceContext, kind: HubKind, id: string, tx: Tx): Promise<void> {
  const row = await repo.updateRecord(ctx, kind, id, {}, tx);
  if (!row) throw hubNotFound();
  await reindex(ctx, kind, row, tx);
  await markDirty(tx, ctx.userId, kind, id);
}

/** Record counts of the hub home page; the pending suggestions come from `suggestions.count` (the badge query). */
export async function counts(ctx: ServiceContext): Promise<{ people: number; companies: number; projects: number }> {
  const [people, companies, projects] = await Promise.all([
    repo.countRecords(ctx, 'person'),
    repo.countRecords(ctx, 'company'),
    repo.countRecords(ctx, 'project'),
  ]);
  return { people, companies, projects };
}
