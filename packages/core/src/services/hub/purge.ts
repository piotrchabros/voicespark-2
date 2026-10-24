import { and, eq, sql } from 'drizzle-orm';
import {
  getDb,
  hubFact,
  hubMessageSource,
  hubSyncItem,
  hubThreadSource,
  withTransaction,
  type DeletionRequestedBy,
  type HubFact,
  type Tx,
} from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import * as repo from '@voicespark/db/repos/user/hub-records';
import * as outbox from '@voicespark/db/repos/user/hub-sync';
import { validateContactValue } from '@voicespark/filters';
import { namespaceFor, type MemoryStore } from '@voicespark/integrations/supermemory';
import { subjectRef } from '../../crypto';
import { addressHash } from '../../hub/normalize';
import { audit } from '../audit';
import { DeletionError } from '../deletion';
import { decryptContent, type HubKind } from './common';
import { domainHash, reindex } from './records';
import { completeStored, docIdFor, markRecordTree } from './sync';

// Mailbox purge of the hub (contracts/jobs.md (6) `hub_source`, data-model.md "Mailbox scope"; FR-031, AS8.2).
// Steps 1-5 and the audit run in one transaction under the per-user apply lock, so no extraction applies meanwhile.
// The exclusive threads and the facts they alone support are marked in temp tables (`on commit drop`).
// User-entered data stays: owner fields, user-origin emails, domains and links, notes and files. No block markers are
// written: the user did not reject this data. Step 6 deletes the documents of every pending tombstone of the user,
// so a retry after a store failure still finds the ids the committed transaction tombstoned.

export interface PurgeCounts {
  sourceId: string;
  threads: number;
  records: number;
  links: number;
  /** Cleared field values plus deleted emails and domains. */
  values: number;
}

export interface PurgeResult extends PurgeCounts {
  /** Memory-store documents deleted in step 6. */
  documents: number;
}

/** Email-set columns a `field` fact writes (apply.ts FIELD_COLUMN). */
const FIELD_COLUMN: Record<string, string> = {
  roleTitle: 'roleTitleEnc',
  phone: 'phoneEnc',
  industry: 'industryEnc',
};
const DELETE_CHUNK = 100;

type Rows<T> = T[] | { rows: T[] };
const rowsOf = <T>(res: unknown): T[] => {
  const r = res as Rows<T>;
  return Array.isArray(r) ? r : r.rows;
};

const recordOf = (f: HubFact): { kind: HubKind; id: string } | null =>
  f.personId ? { kind: 'person', id: f.personId } : f.companyId ? { kind: 'company', id: f.companyId } : f.projectId ? { kind: 'project', id: f.projectId } : null;

function factValue(f: HubFact): Record<string, unknown> {
  if (!f.valueEnc) return {};
  try {
    const v = JSON.parse(decryptContent(f.valueEnc)) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function emailHashOf(f: HubFact): string | null {
  const v = factValue(f);
  const raw = f.type === 'person' ? v.email : f.type === 'person_email' ? v.address : null;
  const address = typeof raw === 'string' ? validateContactValue('email', raw) : null;
  return address === null ? null : addressHash(address);
}

function domainHashOf(f: HubFact): string | null {
  const raw = factValue(f).domain;
  const domain = typeof raw === 'string' ? validateContactValue('domain', raw) : null;
  return domain === null ? null : domainHash(domain);
}

const recordColumn = (kind: HubKind) => (kind === 'person' ? sql`person_id` : kind === 'company' ? sql`company_id` : sql`project_id`);

/** Applied facts that are not marked for removal, matching `where` (a raw condition on `hub_fact`). */
async function survivingFacts(tx: Tx, userId: string, where: ReturnType<typeof sql>): Promise<HubFact[]> {
  return tx
    .select()
    .from(hubFact)
    .where(
      and(
        eq(hubFact.userId, userId),
        eq(hubFact.state, 'applied'),
        sql`${hubFact.id} not in (select id from purge_fact)`,
        where,
      ),
    );
}

/**
 * Removes the hub data of one mailbox (steps 1-7 of contracts/jobs.md (6)). Idempotent: a second run finds nothing,
 * writes no audit entry and only finishes pending document deletes. A document still present after its delete throws
 * `verify_failed` (retryable; the deletion job owns retries and the SLA).
 */
export async function purgeSource(
  store: MemoryStore,
  userId: string,
  sourceId: string,
  opts: { requestedBy?: DeletionRequestedBy } = {},
): Promise<PurgeResult> {
  const ctx = { userId, role: 'user' as const };
  const counts = await withTransaction(async (tx): Promise<PurgeCounts> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hub-apply:' || ${userId}))`);
    const c: PurgeCounts = { sourceId, threads: 0, records: 0, links: 0, values: 0 };

    // 1. Exclusive threads: every `hub_thread_source` row points at this source (a kept mailbox's null row does not).
    await tx.execute(sql`create temp table purge_thread (id uuid primary key) on commit drop`);
    await tx.execute(sql`
      insert into purge_thread
      select distinct s.thread_id from hub_thread_source s
      where s.user_id = ${userId} and s.source_id = ${sourceId}
        and not exists (
          select 1 from hub_thread_source o
          where o.thread_id = s.thread_id and o.source_id is distinct from ${sourceId})`);
    // Facts whose evidence threads (own thread plus extra evidence) are all exclusive.
    await tx.execute(sql`create temp table purge_fact (id uuid primary key) on commit drop`);
    await tx.execute(sql`
      insert into purge_fact
      select f.id from hub_fact f
      where f.user_id = ${userId}
        and (f.thread_id is null or f.thread_id in (select id from purge_thread))
        and (f.thread_id is not null or exists (select 1 from hub_fact_evidence e where e.fact_id = f.id))
        and not exists (
          select 1 from hub_fact_evidence e
          where e.fact_id = f.id and e.thread_id not in (select id from purge_thread))`);

    const marked = await tx
      .select()
      .from(hubFact)
      .where(and(eq(hubFact.userId, userId), sql`${hubFact.id} in (select id from purge_fact)`));
    const applied = marked.filter((f) => f.state === 'applied');

    // Records the purge may change or remove: fact targets and records attached to the exclusive threads.
    const candidates = new Map<string, { kind: HubKind; id: string }>();
    const addCandidate = (kind: HubKind, id: string | null) => {
      if (id) candidates.set(`${kind}:${id}`, { kind, id });
    };
    for (const f of marked) {
      addCandidate('person', f.personId);
      addCandidate('company', f.companyId);
      addCandidate('project', f.projectId);
    }
    for (const r of rowsOf<{ person_id: string | null; company_id: string | null; project_id: string | null }>(
      await tx.execute(sql`
        select person_id, company_id, project_id from hub_thread_record
        where user_id = ${userId} and thread_id in (select id from purge_thread)`),
    )) {
      addCandidate('person', r.person_id);
      addCandidate('company', r.company_id);
      addCandidate('project', r.project_id);
    }
    const changed = new Map<string, { kind: HubKind; id: string }>();
    const markChanged = (kind: HubKind, id: string) => changed.set(`${kind}:${id}`, { kind, id });

    // Summaries of the exclusive threads become tombstones; the thread delete cascades messages, message and thread
    // sources, thread records and evidence (facts keep a null thread until step 3 removes them).
    const summaries = rowsOf<{ id: string }>(
      await tx.execute(sql`
        select id from hub_thread
        where user_id = ${userId} and id in (select id from purge_thread) and summary_enc is not null`),
    );
    await outbox.upsertDirty(
      ctx,
      summaries.map((s) => ({ entityType: 'summary' as const, entityId: s.id, docId: docIdFor('summary', s.id) })),
      tx,
      { deleted: true },
    );
    c.threads = rowsOf<{ id: string }>(
      await tx.execute(sql`
        delete from hub_thread where user_id = ${userId} and id in (select id from purge_thread) returning id`),
    ).length;

    // 2. Field values the marked facts set, unless the user owns the field or a surviving fact supports it.
    const fieldKeys = new Set<string>();
    for (const f of applied) {
      const target = recordOf(f);
      if (f.type !== 'field' || !target || !f.field || !FIELD_COLUMN[f.field]) continue;
      const key = `${target.kind}:${target.id}:${f.field}`;
      if (fieldKeys.has(key)) continue;
      fieldKeys.add(key);
      const row = await repo.lockRecord(ctx, target.kind, target.id, tx);
      if (!row || row.ownerFields.includes(f.field)) continue;
      const support = await survivingFacts(
        tx,
        userId,
        sql`type = 'field' and field = ${f.field} and ${recordColumn(target.kind)} = ${target.id}`,
      );
      if (support.length > 0) continue;
      const column = FIELD_COLUMN[f.field]!;
      if ((row as unknown as Record<string, unknown>)[column] == null) continue;
      await repo.updateRecord(ctx, target.kind, target.id, { [column]: null } as never, tx);
      c.values += 1;
      markChanged(target.kind, target.id);
    }

    // Link roles set from the marked facts (FR-016: never a role the user set).
    for (const f of applied) {
      if (f.type !== 'link_role' || !f.linkId) continue;
      const link = await repo.lockLink(ctx, f.linkId, tx);
      if (!link || link.roleOwnerSet || link.roleEnc === null) continue;
      const support = await survivingFacts(tx, userId, sql`type = 'link_role' and link_id = ${f.linkId}`);
      if (support.length > 0) continue;
      await repo.updateLink(ctx, f.linkId, { roleEnc: null }, tx);
      c.values += 1;
      if (link.personId) markChanged('person', link.personId);
      if (link.companyId) markChanged('company', link.companyId);
      if (link.projectId) markChanged('project', link.projectId);
    }

    // Email-origin addresses with no surviving fact behind them. A removed primary passes to the oldest address.
    for (const f of applied) {
      if ((f.type !== 'person' && f.type !== 'person_email') || !f.personId) continue;
      const hash = emailHashOf(f);
      if (hash === null) continue;
      const email = (await repo.listEmails(ctx, f.personId, tx)).find((e) => e.addressHash === hash);
      if (!email || email.origin !== 'email') continue;
      const support = await survivingFacts(
        tx,
        userId,
        sql`type in ('person', 'person_email') and person_id = ${f.personId}`,
      );
      if (support.some((s) => emailHashOf(s) === hash)) continue;
      await repo.deleteEmail(ctx, email.id, tx);
      if (email.isPrimary) {
        const [next] = await repo.listEmails(ctx, f.personId, tx);
        if (next) await repo.updateEmail(ctx, next.id, { isPrimary: true }, tx);
      }
      c.values += 1;
      markChanged('person', f.personId);
    }

    // Email-origin domains, the same way.
    for (const f of applied) {
      if (f.type !== 'company_domain' || !f.companyId) continue;
      const hash = domainHashOf(f);
      if (hash === null) continue;
      const domain = (await repo.listDomains(ctx, f.companyId, tx)).find((d) => d.domainHash === hash);
      if (!domain || domain.origin !== 'email') continue;
      const support = await survivingFacts(tx, userId, sql`type = 'company_domain' and company_id = ${f.companyId}`);
      if (support.some((s) => domainHashOf(s) === hash)) continue;
      await repo.deleteDomain(ctx, domain.id, tx);
      c.values += 1;
      markChanged('company', f.companyId);
    }

    // Email-origin links with no surviving fact and no role the user set.
    const removedLinks = new Set<string>();
    for (const f of applied) {
      if (f.type !== 'link' || !f.linkId || removedLinks.has(f.linkId)) continue;
      const link = await repo.lockLink(ctx, f.linkId, tx);
      if (!link || link.origin !== 'email' || link.roleOwnerSet) continue;
      const support = await survivingFacts(tx, userId, sql`link_id = ${f.linkId}`);
      if (support.length > 0) continue;
      await repo.deleteLink(ctx, f.linkId, tx);
      removedLinks.add(f.linkId);
      if (link.personId) markChanged('person', link.personId);
      if (link.companyId) markChanged('company', link.companyId);
      if (link.projectId) markChanged('project', link.projectId);
    }

    // 3. Orphan records: created by email, nothing user-made and nothing else (fact or thread) behind them.
    const deleted = new Set<string>();
    for (const { kind, id } of candidates.values()) {
      const row = await repo.lockRecord(ctx, kind, id, tx);
      if (!row || row.createdFrom !== 'email' || row.ownerFields.length > 0) continue;
      const col = recordColumn(kind);
      const [userMade] = rowsOf<{ n: number }>(
        await tx.execute(sql`
          select (
            (select count(*) from hub_note where user_id = ${userId} and ${col} = ${id})
            + (select count(*) from hub_file where user_id = ${userId} and ${col} = ${id})
            + (select count(*) from hub_link where user_id = ${userId} and ${col} = ${id} and origin = 'user')
            + (select count(*) from hub_person_email where user_id = ${userId} and person_id = ${id} and origin = 'user')
            + (select count(*) from hub_company_domain where user_id = ${userId} and company_id = ${id} and origin = 'user')
            + (select count(*) from hub_thread_record where user_id = ${userId} and ${col} = ${id})
          )::int as n`),
      );
      if ((userMade?.n ?? 0) > 0) continue;
      if ((await survivingFacts(tx, userId, sql`${col} = ${id}`)).length > 0) continue;
      for (const l of await repo.listLinksForRecord(ctx, kind, id, tx)) removedLinks.add(l.id);
      // Before the row delete, so the tree is still there to tombstone.
      await markRecordTree(tx, userId, kind, id, { deleted: true });
      await content.deleteSearchDocsForOwner(ctx, kind, id, tx);
      await content.deleteSearchDoc(ctx, kind, id, tx);
      if (await repo.deleteRecord(ctx, kind, id, tx)) {
        c.records += 1;
        deleted.add(`${kind}:${id}`);
      }
    }
    c.links = removedLinks.size;

    // The marked findings go too (their threads are gone); a surviving fact that depended on one is kept.
    await tx.execute(sql`
      update hub_fact set depends_on_fact_id = null
      where user_id = ${userId} and depends_on_fact_id in (select id from purge_fact)
        and id not in (select id from purge_fact)`);
    await tx.execute(sql`delete from hub_fact where user_id = ${userId} and id in (select id from purge_fact)`);

    // 4. The source rows of the threads that stay.
    const sourceRows =
      (await tx
        .delete(hubMessageSource)
        .where(and(eq(hubMessageSource.userId, userId), eq(hubMessageSource.sourceId, sourceId)))
        .returning({ id: hubMessageSource.id })).length +
      (await tx
        .delete(hubThreadSource)
        .where(and(eq(hubThreadSource.userId, userId), eq(hubThreadSource.sourceId, sourceId)))
        .returning({ id: hubThreadSource.id })).length;

    // 5. Records that stay are re-indexed and marked dirty with their tree.
    for (const key of deleted) {
      changed.delete(key);
      candidates.delete(key);
    }
    for (const { kind, id } of changed.values()) {
      const row = await repo.updateRecord(ctx, kind, id, {}, tx);
      if (row) await reindex(ctx, kind, row, tx);
    }
    for (const r of new Map([...candidates, ...changed]).values()) {
      if (await repo.getRecord(ctx, r.kind, r.id, tx)) await markRecordTree(tx, userId, r.kind, r.id);
    }

    // 7. Audit, in the same transaction as the deletes. A run that changed nothing (a retry) writes none.
    const anything = c.threads + c.records + c.links + c.values + sourceRows + marked.length > 0;
    if (anything) {
      const requestedBy = opts.requestedBy ?? 'user';
      await audit.record(
        {
          actorType: requestedBy,
          actorUserId: requestedBy === 'user' ? userId : null,
          action: 'hub.mailbox_data_deleted',
          targetType: 'source',
          targetId: sourceId,
          subjectRef: subjectRef(userId),
          metadata: { ...c },
        },
        tx,
      );
    }
    return c;
  });

  // 6. Memory-store deletes in the job, not through the outbox: every pending tombstone of the user, verified.
  const documents = await deleteTombstones(store, userId);
  return { ...counts, documents };
}

async function deleteTombstones(store: MemoryStore, userId: string): Promise<number> {
  const ns = namespaceFor(userId);
  const rows = await getDb()
    .select({ id: hubSyncItem.id, docId: hubSyncItem.docId, version: hubSyncItem.version })
    .from(hubSyncItem)
    .where(
      and(
        eq(hubSyncItem.userId, userId),
        eq(hubSyncItem.deleted, true),
        sql`(${hubSyncItem.status} <> 'stored' or ${hubSyncItem.syncedVersion} < ${hubSyncItem.version})`,
      ),
    );
  let count = 0;
  for (let i = 0; i < rows.length; i += DELETE_CHUNK) {
    const chunk = rows.slice(i, i + DELETE_CHUNK);
    const res = await store.deleteDocuments(
      ns,
      chunk.map((r) => r.docId),
    );
    count += res.count;
    if (res.errors.some((e) => e.error !== 'supermemory_not_found')) throw new DeletionError('verify_failed', true);
    for (const r of chunk) {
      if (await store.getDocument(ns, r.docId)) throw new DeletionError('verify_failed', true);
    }
    // The tombstones are settled; a version bumped meanwhile stays pending for `hub.sync`.
    for (const r of chunk) await completeStored(userId, r.id, r.version);
  }
  return count;
}
