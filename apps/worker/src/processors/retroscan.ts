import { and, eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { JobPayload } from '@voicespark/core/queues';
import { senderDomainHash, senderHash } from '@voicespark/core/services/imports';
import * as inspection from '@voicespark/core/services/inspection';
import * as retroscans from '@voicespark/core/services/retroscans';
import { exclusionRule, getDb, type Retroscan } from '@voicespark/db';
import { matchRules, type ContentKind, type ExclusionRule } from '@voicespark/filters';
import {
  META,
  memoryFilter,
  namespaceFor,
  type FilterNode,
  type MemoryMetadata,
  type MemoryStore,
} from '@voicespark/integrations/supermemory';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';

/** Supermemory list page size while walking a namespace. */
export const SCAN_PAGE_SIZE = 100;

export type RetroscanOutcome = 'awaiting_confirmation' | 'no_matches' | 'not_scanning';

type RetroscanDeps = Pick<WorkerDeps, 'store' | 'classifier'>;
type RetroscanJob = Job<JobPayload<'retroscan.scan'>, unknown, 'retroscan.scan'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly ContentKind[] = ['email', 'attachment', 'file', 'note'];
const HEADER_LINE = /^(Subject|Title|Date|Direction|From): ?(.*)$/;

/** The content item a document belongs to (document id = content item id; metadata wins when present). */
function itemIdOf(doc: { id: string; metadata: MemoryMetadata }): string | null {
  const fromMeta = doc.metadata[META.contentItemId];
  const id = typeof fromMeta === 'string' ? fromMeta : doc.id;
  return UUID_RE.test(id) ? id : null;
}

/** Splits a `buildDocument` output into its subject/title header and the filtered body. */
function splitDocument(content: string): { subject?: string; body: string } {
  const split = content.indexOf('\n\n');
  if (split === -1) return { body: content };
  const header = content.slice(0, split).split('\n');
  if (!header.every((line) => HEADER_LINE.test(line))) return { body: content };
  let subject: string | undefined;
  for (const line of header) {
    const m = HEADER_LINE.exec(line);
    if (m && (m[1] === 'Subject' || m[1] === 'Title')) subject = m[2];
  }
  return { ...(subject !== undefined ? { subject } : {}), body: content.slice(split + 2) };
}

/** Context hub documents (`hub_{type}_{uuid}`) are re-filtered by `hub.refilter`, never retro-scanned. */
const HUB_ID_PREFIX = 'hub_';

async function* listAll(
  store: MemoryStore,
  ns: string,
  filter?: FilterNode,
): AsyncGenerator<{ id: string; metadata: MemoryMetadata }> {
  for (let page = 1; ; page++) {
    const res = await store.listDocuments(ns, {
      ...(filter ? { filter } : {}),
      page,
      limit: SCAN_PAGE_SIZE,
    });
    for (const doc of res.documents) if (!doc.id.startsWith(HUB_ID_PREFIX)) yield doc;
    if (!res.hasMore || res.documents.length === 0) return;
  }
}

async function collect(
  store: MemoryStore,
  ns: string,
  filter: FilterNode | undefined,
  matches: (
    doc: { id: string; metadata: MemoryMetadata },
    content: string,
  ) => Promise<boolean> | boolean,
  needsContent: boolean,
): Promise<string[]> {
  const ids = new Set<string>();
  for await (const doc of listAll(store, ns, filter)) {
    const itemId = itemIdOf(doc);
    if (!itemId) continue;
    let content = '';
    if (needsContent) {
      const full = await store.getDocument(ns, doc.id);
      if (!full) continue;
      content = full.content;
    }
    if (await matches(doc, content)) ids.add(itemId);
  }
  return [...ids];
}

/** Rule trigger: metadata filters for sender/domain/folder, content match for keywords (R20). */
async function scanRule(store: MemoryStore, ns: string, rule: ExclusionRule): Promise<string[]> {
  const value = rule.value.trim().toLowerCase();
  switch (rule.type) {
    case 'sender':
      return collect(
        store,
        ns,
        memoryFilter.eq(META.senderHash, senderHash(value)),
        () => true,
        false,
      );
    case 'domain':
      return collect(
        store,
        ns,
        memoryFilter.eq(META.senderDomainHash, senderDomainHash(value)),
        () => true,
        false,
      );
    case 'folder_label':
      return collect(store, ns, memoryFilter.arrayContains(META.folders, value), () => true, false);
    case 'keyword':
      return collect(
        store,
        ns,
        undefined,
        (_doc, content) => {
          const { subject, body } = splitDocument(content);
          return (
            matchRules(
              {
                ...(subject !== undefined ? { subject } : {}),
                bodyText: body,
                headers: {},
                folders: [],
              },
              [rule],
            ).matched !== null
          );
        },
        true,
      );
  }
}

/**
 * Category trigger: re-inspects every document with only the newly selected categories (locked ones are forced on
 * by inspect). Fails closed: an inspection error excludes the item as `inspection_failed`, which counts as a match.
 */
async function scanCategories(deps: RetroscanDeps, scan: Retroscan, ns: string): Promise<string[]> {
  const selected = new Set<string>(scan.categories);
  const ownAddresses = await inspection.loadOwnAddresses(scan.userId);
  const policy = { selectedCategories: scan.categories, rules: [] };
  return collect(
    deps.store,
    ns,
    undefined,
    async (doc, content) => {
      const rawKind = doc.metadata[META.kind];
      const kind = KINDS.find((k) => k === rawKind) ?? 'email';
      const { subject, body } = splitDocument(content);
      const result = await inspection.inspectForUser(
        scan.userId,
        {
          kind,
          ...(subject !== undefined ? { subject } : {}),
          bodyText: body,
          headers: {},
          folders: [],
        },
        { policy, ownAddresses, classifier: deps.classifier },
      );
      return result.outcome === 'excluded' || result.counts.some((c) => selected.has(c.category));
    },
    true,
  );
}

async function loadRule(scan: Retroscan): Promise<ExclusionRule | null> {
  if (!scan.exclusionRuleId) return null;
  const [rule] = await getDb()
    .select({ id: exclusionRule.id, type: exclusionRule.type, value: exclusionRule.value })
    .from(exclusionRule)
    .where(and(eq(exclusionRule.id, scan.exclusionRuleId), eq(exclusionRule.userId, scan.userId)))
    .limit(1);
  return rule ?? null;
}

/**
 * `retroscan.scan` (jobs contract 7, R20, FR-021/FR-062). Stores matched content item ids only, never content.
 * The confirmation step (retroscans.confirm) turns them into a `retroscan_purge` deletion.
 */
export function createRetroscanHandler(
  overrides: Partial<RetroscanDeps> = {},
): Handler<'retroscan.scan'> {
  let deps: RetroscanDeps | undefined;
  const resolve = (): RetroscanDeps => (deps ??= defaultDeps(overrides));

  return async (
    job: RetroscanJob,
  ): Promise<{ outcome: RetroscanOutcome; matchedCount?: number }> => {
    const { retroscanId } = job.data;
    try {
      const scan = await retroscans.loadForScan(retroscanId);
      // Retryable: the row is committed before the enqueue, so a miss is a replica/visibility race.
      if (!scan) throw new Error('retroscan_not_found');
      if (scan.status !== 'scanning') return { outcome: 'not_scanning' };

      const d = resolve();
      const ns = namespaceFor(scan.userId);
      let matched: string[];
      if (scan.trigger === 'categories_selected') {
        matched = await scanCategories(d, scan, ns);
      } else {
        const rule = await loadRule(scan);
        matched = rule ? await scanRule(d.store, ns, rule) : [];
      }

      const status = matched.length > 0 ? 'awaiting_confirmation' : 'no_matches';
      await retroscans.recordResult(retroscanId, { status, matchedItemIds: matched });
      return { outcome: status, matchedCount: matched.length };
    } catch (err) {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt) await retroscans.recordResult(retroscanId, { status: 'failed' });
      // Rethrow without the original message: provider errors may echo document content.
      throw new Error(
        err instanceof Error && /^[a-z_]+$/.test(err.message) ? err.message : 'retroscan_failed',
      );
    }
  };
}

export const handlers: HandlerMap = {
  'retroscan.scan': createRetroscanHandler(),
};
