import { and, eq, inArray, ne } from 'drizzle-orm';
import { contentItem, deletionRequest, getDb, user } from '@voicespark/db';
import { detectLocked, type LockedCategory } from '@voicespark/filters';
import { META, namespaceFor, type MemoryStore } from '@voicespark/integrations/supermemory';
import { subjectRef } from '../crypto';
import { requestDeletion } from './deletion';
import { audit } from './audit';
import { loadOwnAddresses } from './inspection';

// Weekly credential audit (T167, SC-005): samples stored documents and re-runs only the locked detectors (no classifier,
// no LLM). Document content is held in memory for the detector call only: never logged, stored or audited.

/** Documents read per namespace per run. */
export const CREDENTIAL_AUDIT_SAMPLE = 200;
const LIST_PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CredentialAuditResult {
  /** Namespaces (active users with active content) examined. */
  namespaces: number;
  /** Documents read and checked. */
  scanned: number;
  /** Documents with at least one locked-category hit. */
  hits: number;
  /** `content_item` deletion requests created. */
  deletionRequests: number;
}

/** First `sample` document ids of a namespace, paged at 100. */
async function sampleIds(store: MemoryStore, ns: string, sample: number): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ids.length < sample; page++) {
    const { documents, hasMore } = await store.listDocuments(ns, { page, limit: LIST_PAGE_SIZE });
    ids.push(...documents.map((d) => d.id));
    if (!hasMore || documents.length === 0) break;
  }
  return ids.slice(0, sample);
}

/** Maps hit content item ids to the item a deletion targets: the parent for attachments, active items only. */
async function deletionTargets(userId: string, itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const rows = await getDb()
    .select({ id: contentItem.id, parentItemId: contentItem.parentItemId })
    .from(contentItem)
    .where(and(eq(contentItem.userId, userId), inArray(contentItem.id, itemIds)));
  const candidates = [...new Set(rows.map((r) => r.parentItemId ?? r.id))];
  if (candidates.length === 0) return [];
  const active = await getDb()
    .select({ id: contentItem.id })
    .from(contentItem)
    .where(and(eq(contentItem.userId, userId), inArray(contentItem.id, candidates), eq(contentItem.status, 'active')));
  // An item with an open content_item request is already on its way out.
  const open = await getDb()
    .select({ targetId: deletionRequest.targetId })
    .from(deletionRequest)
    .where(
      and(
        eq(deletionRequest.userId, userId),
        eq(deletionRequest.scope, 'content_item'),
        inArray(deletionRequest.targetId, candidates),
        ne(deletionRequest.status, 'completed'),
      ),
    );
  const pending = new Set(open.map((r) => r.targetId));
  return active.map((r) => r.id).filter((id) => !pending.has(id));
}

/**
 * Scans up to `sample` documents of every active user's namespace (suspended and pending-deletion users are skipped).
 * A hit requests a system `content_item` deletion of its item (the parent item for an attachment) and writes one
 * `filter.audit_hit` {category, count} per user per category.
 */
export async function runCredentialAudit(
  store: MemoryStore,
  opts: { sample?: number } = {},
): Promise<CredentialAuditResult> {
  const sample = opts.sample ?? CREDENTIAL_AUDIT_SAMPLE;
  const users = await getDb()
    .selectDistinct({ id: user.id })
    .from(user)
    .innerJoin(contentItem, eq(contentItem.userId, user.id))
    .where(and(eq(user.status, 'active'), eq(contentItem.status, 'active')));

  const result: CredentialAuditResult = { namespaces: 0, scanned: 0, hits: 0, deletionRequests: 0 };
  for (const { id: userId } of users) {
    result.namespaces++;
    const ns = namespaceFor(userId);
    const ids = await sampleIds(store, ns, sample);
    if (ids.length === 0) continue;
    const ownAddresses = await loadOwnAddresses(userId);
    const perCategory = new Map<LockedCategory, number>();
    const hitItemIds = new Set<string>();
    for (const docId of ids) {
      const doc = await store.getDocument(ns, docId);
      if (!doc) continue;
      result.scanned++;
      const found = await detectLocked(doc.content, { ownAddresses });
      if (found.length === 0) continue;
      result.hits++;
      for (const { category, count } of found) perCategory.set(category, (perCategory.get(category) ?? 0) + count);
      const itemId = doc.metadata[META.contentItemId];
      const target = typeof itemId === 'string' ? itemId : doc.id;
      if (UUID_RE.test(target)) hitItemIds.add(target);
    }
    if (perCategory.size === 0) continue;

    for (const targetId of await deletionTargets(userId, [...hitItemIds])) {
      await requestDeletion({ userId, scope: 'content_item', targetId, requestedBy: 'system' });
      result.deletionRequests++;
    }
    for (const [category, count] of perCategory) {
      await audit.record({
        actorType: 'system',
        action: 'filter.audit_hit',
        targetType: 'user',
        targetId: userId,
        subjectRef: subjectRef(userId),
        metadata: { category, count },
      });
    }
  }
  return result;
}
