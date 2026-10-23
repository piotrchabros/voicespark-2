import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { contentItem, deletionRequest, filterPreferences, getDb, hubSyncItem, user } from '@voicespark/db';
import { detectLocked, type LockedCategory } from '@voicespark/filters';
import { META, namespaceFor, type MemoryStore } from '@voicespark/integrations/supermemory';
import { subjectRef } from '../crypto';
import { logger } from '../logger';
import { enqueue, jobIds } from '../queues';
import { requestDeletion } from './deletion';
import { audit } from './audit';
import { loadOwnAddresses } from './inspection';

// Weekly credential audit (T167, SC-005): samples stored documents and re-runs only the locked detectors (no classifier,
// no LLM). Document content is held in memory for the detector call only: never logged, stored or audited.
// Context hub documents (`hub_` ids) are sampled separately: a hit there is never purged, it marks the sync item for
// `hub.refilter`, which rebuilds the content from Postgres under the policy (contracts/memory-store-hub.md).

/** Documents read per namespace per run. */
export const CREDENTIAL_AUDIT_SAMPLE = 200;
const LIST_PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUB_ID_PREFIX = 'hub_';
const REFILTER_PENDING = 'refilter_pending';

export interface CredentialAuditResult {
  /** Namespaces (active users with active content) examined. */
  namespaces: number;
  /** Documents read and checked. */
  scanned: number;
  /** Documents with at least one locked-category hit. */
  hits: number;
  /** `content_item` deletion requests created. */
  deletionRequests: number;
  /** Hub sync items marked for `hub.refilter`. */
  hubRefilterMarks: number;
}

/**
 * First `sample` content document ids and first `sample` hub document ids of a namespace, paged at 100. Hub ids never
 * count against the content sample.
 */
async function sampleIds(
  store: MemoryStore,
  ns: string,
  sample: number,
): Promise<{ content: string[]; hub: string[] }> {
  const content: string[] = [];
  const hub: string[] = [];
  for (let page = 1; content.length < sample || hub.length < sample; page++) {
    const { documents, hasMore } = await store.listDocuments(ns, { page, limit: LIST_PAGE_SIZE });
    for (const { id } of documents) (id.startsWith(HUB_ID_PREFIX) ? hub : content).push(id);
    if (!hasMore || documents.length === 0) break;
  }
  return { content: content.slice(0, sample), hub: hub.slice(0, sample) };
}

/**
 * Marks the hit hub documents' sync items for `hub.refilter` (dirty, `refilter_pending`; the daily
 * `maintenance.hub-refilter-retry` picks them up if the enqueue is lost) and enqueues the job for the user's current
 * policy version. Returns the number of rows marked.
 */
async function markForRefilter(userId: string, docIds: string[]): Promise<number> {
  if (docIds.length === 0) return 0;
  const marked = await getDb()
    .update(hubSyncItem)
    .set({
      version: sql`${hubSyncItem.version} + 1`,
      status: 'pending',
      attempts: 0,
      lastErrorCode: REFILTER_PENDING,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(hubSyncItem.userId, userId), inArray(hubSyncItem.docId, docIds), eq(hubSyncItem.deleted, false)),
    )
    .returning({ id: hubSyncItem.id });
  const [prefs] = await getDb()
    .select({ version: filterPreferences.version })
    .from(filterPreferences)
    .where(eq(filterPreferences.userId, userId))
    .limit(1);
  const policyVersion = prefs?.version ?? 0;
  try {
    await enqueue('hub.refilter', { userId, policyVersion }, { jobId: jobIds.hubRefilter(userId, policyVersion) });
  } catch {
    logger.warn({ userId, errorCode: 'hub_refilter_enqueue_failed' }, 'hub.refilter not enqueued; daily retry will');
  }
  return marked.length;
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
 * Scans up to `sample` documents of every active user's namespace (suspended and pending-deletion users are skipped),
 * plus up to `sample` hub documents. A content hit requests a system `content_item` deletion of its item (the parent
 * item for an attachment); a hub hit marks the sync item for `hub.refilter`. Writes one `filter.audit_hit`
 * {category, count} per user per category.
 */
export async function runCredentialAudit(
  store: MemoryStore,
  opts: { sample?: number } = {},
): Promise<CredentialAuditResult> {
  const sample = opts.sample ?? CREDENTIAL_AUDIT_SAMPLE;
  const withContent = await getDb()
    .selectDistinct({ id: user.id })
    .from(user)
    .innerJoin(contentItem, eq(contentItem.userId, user.id))
    .where(and(eq(user.status, 'active'), eq(contentItem.status, 'active')));
  const withHub = await getDb()
    .selectDistinct({ id: user.id })
    .from(user)
    .innerJoin(hubSyncItem, eq(hubSyncItem.userId, user.id))
    .where(and(eq(user.status, 'active'), eq(hubSyncItem.deleted, false)));
  const users = [...new Set([...withContent, ...withHub].map((u) => u.id))];

  const result: CredentialAuditResult = {
    namespaces: 0,
    scanned: 0,
    hits: 0,
    deletionRequests: 0,
    hubRefilterMarks: 0,
  };
  for (const userId of users) {
    result.namespaces++;
    const ns = namespaceFor(userId);
    const ids = await sampleIds(store, ns, sample);
    if (ids.content.length === 0 && ids.hub.length === 0) continue;
    const ownAddresses = await loadOwnAddresses(userId);
    const perCategory = new Map<LockedCategory, number>();
    const hitItemIds = new Set<string>();
    const hitHubDocIds: string[] = [];
    for (const docId of [...ids.content, ...ids.hub]) {
      const doc = await store.getDocument(ns, docId);
      if (!doc) continue;
      result.scanned++;
      const found = await detectLocked(doc.content, { ownAddresses });
      if (found.length === 0) continue;
      result.hits++;
      for (const { category, count } of found) perCategory.set(category, (perCategory.get(category) ?? 0) + count);
      if (docId.startsWith(HUB_ID_PREFIX)) {
        hitHubDocIds.push(docId);
        continue;
      }
      const itemId = doc.metadata[META.contentItemId];
      const target = typeof itemId === 'string' ? itemId : doc.id;
      if (UUID_RE.test(target)) hitItemIds.add(target);
    }
    if (perCategory.size === 0) continue;

    for (const targetId of await deletionTargets(userId, [...hitItemIds])) {
      await requestDeletion({ userId, scope: 'content_item', targetId, requestedBy: 'system' });
      result.deletionRequests++;
    }
    result.hubRefilterMarks += await markForRefilter(userId, hitHubDocIds);
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
