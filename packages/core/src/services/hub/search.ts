import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  getDb,
  hubCompanyDomain,
  hubPersonEmail,
  type DbOrTx,
  type HubCompany,
  type HubFile,
  type HubNote,
  type HubPerson,
  type HubProject,
} from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import * as repo from '@voicespark/db/repos/user/hub-records';
import { AppError, type ServiceContext } from '../../errors';
import { noteToPlainText, type HubNoteDoc } from '../../hub/content-schema';
import { buildSnippets, queryTokens, rankResults, verifyCandidate, type Snippet } from '../../hub/search-tokens';
import { decryptContent, type HubKind } from './common';
import { FILE_INDEX_TEXT_MAX } from './files';

// Keyword search over the blind token index (US5; contracts/hub-search.md; FR-011, SC-003). The `tokens @>` lookup is
// the only scan; at most 200 candidates are loaded in batches, decrypted and verified against their real text (hash
// collisions are dropped), ranked, paged with an opaque offset cursor and given snippets. Content never leaves the
// owner's scope: every read is filtered by `ctx.userId`.

export type SearchItemType = content.HubSearchItemType;

export interface SearchInput {
  q: string;
  types?: SearchItemType[];
  limit?: number;
  cursor?: string;
}

export interface SearchResultItem {
  type: SearchItemType;
  id: string;
  title: string;
  /** Owner record of a note or file; `null` for records. */
  owner: { kind: HubKind; id: string; name: string } | null;
  snippets: Snippet[];
  updatedAt: string;
}

export interface SearchResult {
  items: SearchResultItem[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const KINDS: HubKind[] = ['person', 'company', 'project'];
const TYPES = ['person', 'company', 'project', 'note', 'file'] as const;

const inputSchema = z
  .object({
    q: z.string().min(1).max(200),
    types: z.array(z.enum(TYPES)).max(TYPES.length).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    cursor: z.string().max(64).optional(),
  })
  .strict();

function parse(input: unknown): z.infer<typeof inputSchema> {
  const r = inputSchema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
    throw new AppError('validation_failed', undefined, { fields });
  }
  return r.data;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString('base64url');
}

function decodeCursor(cursor: string): number {
  const m = /^o:(\d{1,3})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const offset = m ? Number(m[1]) : Number.NaN;
  if (!Number.isInteger(offset) || offset < 1 || offset > content.SEARCH_CANDIDATE_LIMIT) {
    throw new AppError('validation_failed', undefined, { fields: ['cursor'] });
  }
  return offset;
}

/** A decrypted, verifiable candidate: the indexed texts and the texts snippets are taken from. */
interface Loaded {
  type: SearchItemType;
  id: string;
  title: string;
  owner: { kind: HubKind; id: string } | null;
  /** Everything the index row was built from (contracts/hub-search.md "Index"). */
  indexed: string[];
  /** Body, description or extracted text first; field values of a record. */
  snippetTexts: string[];
  updatedAt: Date;
}

const dec = (blob: string | null): string | null => (blob === null ? null : decryptContent(blob));
const present = (values: (string | null)[]): string[] => values.filter((s): s is string => !!s);

function ownerOf(row: HubNote | HubFile): { kind: HubKind; id: string } {
  if (row.personId) return { kind: 'person', id: row.personId };
  if (row.companyId) return { kind: 'company', id: row.companyId };
  return { kind: 'project', id: row.projectId! };
}

async function loadRecords(ctx: ServiceContext, kind: HubKind, ids: string[], db: DbOrTx): Promise<Loaded[]> {
  if (ids.length === 0) return [];
  const rows = await repo.getRecordsByIds(ctx, kind, ids, db);
  const extra = new Map<string, string[]>();
  if (kind === 'person') {
    const emails = await db
      .select({ ownerId: hubPersonEmail.personId, enc: hubPersonEmail.addressEnc })
      .from(hubPersonEmail)
      .where(and(eq(hubPersonEmail.userId, ctx.userId), inArray(hubPersonEmail.personId, ids)));
    for (const e of emails) extra.set(e.ownerId, [...(extra.get(e.ownerId) ?? []), decryptContent(e.enc)]);
  } else if (kind === 'company') {
    const domains = await db
      .select({ ownerId: hubCompanyDomain.companyId, enc: hubCompanyDomain.domainEnc })
      .from(hubCompanyDomain)
      .where(and(eq(hubCompanyDomain.userId, ctx.userId), inArray(hubCompanyDomain.companyId, ids)));
    for (const d of domains) extra.set(d.ownerId, [...(extra.get(d.ownerId) ?? []), decryptContent(d.enc)]);
  }
  return rows.map((row) => {
    const name = decryptContent(row.nameEnc);
    const description = dec(row.descriptionEnc);
    let fields: string[];
    if (kind === 'person') {
      const p = row as HubPerson;
      fields = present([dec(p.roleTitleEnc), dec(p.phoneEnc), ...(extra.get(p.id) ?? [])]);
    } else if (kind === 'company') {
      const c = row as HubCompany;
      fields = present([...(extra.get(c.id) ?? []), dec(c.websiteEnc), dec(c.industryEnc)]);
    } else {
      fields = [(row as HubProject).status];
    }
    return {
      type: kind,
      id: row.id,
      title: name,
      owner: null,
      indexed: present([name, description, ...fields]),
      snippetTexts: present([description, ...fields]),
      updatedAt: row.updatedAt,
    };
  });
}

async function loadNotes(ctx: ServiceContext, ids: string[], db: DbOrTx): Promise<Loaded[]> {
  const rows = await content.getNotesByIds(ctx, ids, db);
  return rows.map((row) => {
    const title = decryptContent(row.titleEnc);
    const text = noteToPlainText(JSON.parse(decryptContent(row.bodyJsonEnc)) as HubNoteDoc);
    return {
      type: 'note',
      id: row.id,
      title,
      owner: ownerOf(row),
      indexed: present([title, text]),
      snippetTexts: present([text]),
      updatedAt: row.updatedAt,
    };
  });
}

async function loadFiles(ctx: ServiceContext, ids: string[], db: DbOrTx): Promise<Loaded[]> {
  const rows = await content.getFilesByIds(ctx, ids, db);
  return rows.map((row) => {
    const name = decryptContent(row.nameEnc);
    const description = dec(row.descriptionEnc);
    // Same rule as `reindexFile`: only extracted text is indexed, cut to the indexed length.
    const text =
      row.extractionStatus === 'extracted' && row.extractedTextEnc !== null
        ? decryptContent(row.extractedTextEnc).slice(0, FILE_INDEX_TEXT_MAX)
        : null;
    return {
      type: 'file',
      id: row.id,
      title: name,
      owner: ownerOf(row),
      indexed: present([name, description, text]),
      snippetTexts: present([description, text]),
      updatedAt: row.updatedAt,
    };
  });
}

/** Names of the owner records of a page of notes and files, one batched read per kind. */
async function ownerNames(ctx: ServiceContext, page: Loaded[], db: DbOrTx): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const kind of KINDS) {
    const ids = [...new Set(page.filter((l) => l.owner?.kind === kind).map((l) => l.owner!.id))];
    for (const row of await repo.getRecordsByIds(ctx, kind, ids, db)) names.set(row.id, decryptContent(row.nameEnc));
  }
  return names;
}

/**
 * Searches the user's own hub. `q` is 1..200 chars (422 `validation_failed` otherwise); a query without a usable
 * token returns an empty list. Default 20 results, at most 100 per page, at most 200 in all.
 */
export async function search(ctx: ServiceContext, input: SearchInput): Promise<SearchResult> {
  const data = parse(input);
  const limit = data.limit ?? DEFAULT_LIMIT;
  const offset = data.cursor === undefined ? 0 : decodeCursor(data.cursor);
  const { terms, hashes } = queryTokens(ctx.userId, data.q);
  if (terms.length === 0) return { items: [], nextCursor: null };

  const db = getDb();
  const candidates = await content.searchCandidates(ctx, hashes, data.types, db);
  if (candidates.length === 0) return { items: [], nextCursor: null };
  const idsOf = (type: SearchItemType) => candidates.filter((c) => c.itemType === type).map((c) => c.itemId);

  const loaded = (
    await Promise.all([
      ...KINDS.map((kind) => loadRecords(ctx, kind, idsOf(kind), db)),
      loadNotes(ctx, idsOf('note'), db),
      loadFiles(ctx, idsOf('file'), db),
    ])
  ).flat();
  const verified = loaded.filter((l) => verifyCandidate(terms, l.indexed.join('\n')));
  const ranked = rankResults(verified, terms);

  const page = ranked.slice(offset, offset + limit);
  const names = await ownerNames(ctx, page, db);
  const items: SearchResultItem[] = page.map((l) => ({
    type: l.type,
    id: l.id,
    title: l.title,
    owner: l.owner ? { ...l.owner, name: names.get(l.owner.id) ?? '' } : null,
    snippets: buildSnippets(terms, l.snippetTexts),
    updatedAt: l.updatedAt.toISOString(),
  }));
  const next = offset + limit;
  return { items, nextCursor: next < ranked.length ? encodeCursor(next) : null };
}
