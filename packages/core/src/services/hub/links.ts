import { z } from 'zod';
import { getDb, withTransaction, type HubLink, type Tx } from '@voicespark/db';
import * as repo from '@voicespark/db/repos/user/hub-records';
import { insertBlockMarker } from '@voicespark/db/repos/user/hub-mail';
import { AppError, type ServiceContext } from '../../errors';
import { markerKey } from '../../hub/fingerprint';
import { decryptContent, encryptContent, hubNotFound, inspectFields, type HubKind } from './common';
import type { LinkView } from './records';
import { markRecordTree } from './sync';

// Links between people, companies and projects (US2; contracts/http-api.md "Links", data-model.md "hub_link";
// FR-007, FR-016, FR-017). One link per pair (three partial unique indexes). Every change marks both records, their
// notes and files and the summaries attached to either dirty in the same transaction.

export type { LinkView };
export type LinkKind = HubLink['kind'];

const LINK_ENDS: Record<LinkKind, readonly [HubKind, HubKind]> = {
  person_company: ['person', 'company'],
  person_project: ['person', 'project'],
  company_project: ['company', 'project'],
};

const ID_FIELD = { person: 'personId', company: 'companyId', project: 'projectId' } as const;

const ROLE_MAX = 100;
const roleSchema = z.string().max(ROLE_MAX);

const createSchema = z.object({
  kind: z.enum(['person_company', 'person_project', 'company_project']),
  personId: z.uuid().nullish(),
  companyId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  role: roleSchema.nullish(),
});

export type LinkCreateInput = z.input<typeof createSchema>;

export interface LinkWriteResult {
  link: LinkView;
  redactedValues?: number;
}

export interface LinkedRecord {
  link: LinkView;
  other: { kind: HubKind; id: string; name: string };
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
    throw new AppError('validation_failed', undefined, { fields });
  }
  return r.data;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

function view(l: HubLink): LinkView {
  return {
    id: l.id,
    kind: l.kind,
    personId: l.personId,
    companyId: l.companyId,
    projectId: l.projectId,
    role: l.roleEnc === null ? null : decryptContent(l.roleEnc),
    origin: l.origin,
    createdAt: l.createdAt.toISOString(),
  };
}

/** The two ends of a stored link in kind order (person, company, project). */
function endsOf(l: HubLink): [{ kind: HubKind; id: string }, { kind: HubKind; id: string }] {
  const [a, b] = LINK_ENDS[l.kind];
  return [
    { kind: a, id: l[ID_FIELD[a]]! },
    { kind: b, id: l[ID_FIELD[b]]! },
  ];
}

async function markBoth(tx: Tx, userId: string, l: HubLink): Promise<void> {
  for (const e of endsOf(l)) await markRecordTree(tx, userId, e.kind, e.id);
}

/** Trims; an empty role counts as none. Null/undefined stay null. */
function normaliseRole(role: string | null | undefined): string | null {
  const t = role?.trim();
  return t ? t : null;
}

async function inspectRole(ctx: ServiceContext, role: string | null): Promise<{ role: string | null; redacted: number }> {
  if (role === null) return { role: null, redacted: 0 };
  const inspected = await inspectFields(ctx, { role });
  return { role: inspected.values.role, redacted: inspected.redactedValues };
}

function result(l: HubLink, redacted: number): LinkWriteResult {
  return redacted > 0 ? { link: view(l), redactedValues: redacted } : { link: view(l) };
}

/**
 * Creates a link of `kind`. The two ids must match the kind (409 `invalid_link` otherwise, also for a same-kind pair)
 * and belong to the user (404). A second link for the same pair is 409 `link_exists` with `details.linkId`.
 */
export async function create(ctx: ServiceContext, input: LinkCreateInput): Promise<LinkWriteResult> {
  const data = parse(createSchema, input);
  const [kindA, kindB] = LINK_ENDS[data.kind];
  const given = (['person', 'company', 'project'] as const).filter((k) => data[ID_FIELD[k]] != null);
  if (given.length !== 2 || !given.includes(kindA) || !given.includes(kindB)) throw new AppError('invalid_link');
  const idA = data[ID_FIELD[kindA]]!;
  const idB = data[ID_FIELD[kindB]]!;

  // Ownership before inspection: a foreign id is 404 and nothing is inspected.
  for (const [kind, id] of [[kindA, idA], [kindB, idB]] as const) {
    if (await repo.getRecord(ctx, kind, id)) continue;
    // An id of the user's that belongs to another kind is a wrong id for this link kind, not a missing record.
    for (const other of ['person', 'company', 'project'] as const) {
      if (other !== kind && (await repo.getRecord(ctx, other, id))) throw new AppError('invalid_link');
    }
    throw hubNotFound();
  }
  const existing = await repo.findLinkBetween(ctx, { kind: kindA, id: idA }, { kind: kindB, id: idB });
  if (existing) throw new AppError('link_exists', undefined, { linkId: existing.id });

  const prepared = await inspectRole(ctx, normaliseRole(data.role));
  try {
    return await withTransaction(async (tx) => {
      // Lock in kind order so concurrent link writes cannot deadlock.
      if (!(await repo.lockRecord(ctx, kindA, idA, tx))) throw hubNotFound();
      if (!(await repo.lockRecord(ctx, kindB, idB, tx))) throw hubNotFound();
      const row = await repo.insertLink(
        ctx,
        {
          kind: data.kind,
          [ID_FIELD[kindA]]: idA,
          [ID_FIELD[kindB]]: idB,
          roleEnc: prepared.role === null ? null : encryptContent(prepared.role),
          roleOwnerSet: prepared.role !== null,
          origin: 'user',
        },
        tx,
      );
      await markBoth(tx, ctx.userId, row);
      return result(row, prepared.redacted);
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a race with another create of the same pair.
    const winner = await repo.findLinkBetween(ctx, { kind: kindA, id: idA }, { kind: kindB, id: idB });
    throw new AppError('link_exists', undefined, winner ? { linkId: winner.id } : undefined);
  }
}

/** Sets the role (null clears it). The link becomes owner-set, so email extraction no longer overwrites it (FR-016). */
export async function setRole(ctx: ServiceContext, id: string, role: string | null): Promise<LinkWriteResult> {
  const value = normaliseRole(parse(roleSchema.nullable(), role === undefined ? 'invalid' : role));
  if (!(await repo.getLink(ctx, id))) throw hubNotFound();
  const prepared = await inspectRole(ctx, value);
  return withTransaction(async (tx) => {
    if (!(await repo.lockLink(ctx, id, tx))) throw hubNotFound();
    const row = await repo.updateLink(
      ctx,
      id,
      { roleEnc: prepared.role === null ? null : encryptContent(prepared.role), roleOwnerSet: true },
      tx,
    );
    if (!row) throw hubNotFound();
    await markBoth(tx, ctx.userId, row);
    return result(row, prepared.redacted);
  });
}

/** Deletes the link. An email-origin link leaves the block marker `link:{kind}:{idA}:{idB}` (FR-017). */
export async function remove(ctx: ServiceContext, id: string): Promise<void> {
  await withTransaction(async (tx) => {
    const row = await repo.lockLink(ctx, id, tx);
    if (!row) throw hubNotFound();
    // Before the delete: the fan-out follows the links that still exist.
    await markBoth(tx, ctx.userId, row);
    if (row.origin === 'email') {
      const [a, b] = endsOf(row);
      await insertBlockMarker(ctx, markerKey.link(row.kind, a.id, b.id), 'deleted', tx);
    }
    if (!(await repo.deleteLink(ctx, id, tx))) throw hubNotFound();
  });
}

/** Links of a record with the record at the other end (either end order). 404 for a foreign record. */
export async function listForRecord(ctx: ServiceContext, kind: HubKind, id: string): Promise<LinkedRecord[]> {
  const db = getDb();
  if (!(await repo.getRecord(ctx, kind, id, db))) throw hubNotFound();
  const rows = await repo.listLinksForRecord(ctx, kind, id, db);
  const others = rows.map((l) => endsOf(l).find((e) => !(e.kind === kind && e.id === id))!);
  const names = new Map<string, string>();
  for (const k of ['person', 'company', 'project'] as const) {
    const ids = others.filter((o) => o.kind === k).map((o) => o.id);
    for (const r of await repo.getRecordsByIds(ctx, k, ids, db)) names.set(r.id, decryptContent(r.nameEnc));
  }
  return rows.flatMap((l, i) => {
    const other = others[i]!;
    const name = names.get(other.id);
    return name === undefined ? [] : [{ link: view(l), other: { ...other, name } }];
  });
}
