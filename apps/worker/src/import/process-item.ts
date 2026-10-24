import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  connectedSource,
  contentItem,
  getDb,
  importJob,
  withTransaction,
  type Authorship,
  type ContentKind,
  type SkipReason,
  type Tx,
} from '@voicespark/db';
import { logger } from '@voicespark/core/logger';
import * as hubIngest from '@voicespark/core/services/hub/ingest';
import * as imports from '@voicespark/core/services/imports';
import { inspectForUser } from '@voicespark/core/services/inspection';
import {
  buildDocument,
  parseFromAddress,
  type Classifier,
  type CountCategory,
  type InspectionInput,
  type InspectionResult,
  type Policy,
} from '@voicespark/filters';
import { ATTACHMENT_SKIP_FOR, extractText } from '@voicespark/integrations/files';
import type { FetchedMessage, MailRef } from '@voicespark/integrations/mail';
import { parseMessage, type ParsedMessage } from '@voicespark/integrations/mime';
import { META, type MemoryDoc, type MemoryStore } from '@voicespark/integrations/supermemory';
import { buildMetadata } from './metadata';

const DAY_MS = 86_400_000;

/** Everything a page shares across its messages; loaded once per page. */
export interface PageContext {
  userId: string;
  sourceId: string;
  importJobId: string;
  filterPolicyVersion: number;
  ns: string;
  dateRange: { from: string | null; to: string | null };
  policy: Policy;
  ownAddresses: string[];
  store: MemoryStore;
  classifier: Classifier;
  /** The hub switch of this mailbox (`hub_mailbox_setting`); off means `recordMessage` is never called (AS3.9). */
  hub: { enabled: boolean };
}

/** Set when a write transaction finds the source no longer `connected` or the job no longer `running` (D-C9). */
export interface PageSignal {
  aborted: boolean;
}

export type CountedCounter = 'itemsImported' | 'itemsDuplicate' | 'itemsExcluded' | 'itemsRedacted' | 'itemsFailed';

export interface Tally {
  counters: Record<CountedCounter, number>;
  exclusions: Partial<Record<CountCategory, { excludedItems: number; redactedValues: number }>>;
  skips: Partial<Record<SkipReason, number>>;
}

export type MessageOutcome = 'imported' | 'duplicate' | 'excluded' | 'failed' | 'out_of_range' | 'aborted';

export function newTally(): Tally {
  return {
    counters: { itemsImported: 0, itemsDuplicate: 0, itemsExcluded: 0, itemsRedacted: 0, itemsFailed: 0 },
    exclusions: {},
    skips: {},
  };
}

export function mergeTally(into: Tally, from: Tally): void {
  for (const k of Object.keys(from.counters) as CountedCounter[]) into.counters[k] += from.counters[k];
  for (const [category, c] of Object.entries(from.exclusions) as [CountCategory, { excludedItems: number; redactedValues: number }][]) {
    addExclusion(into, category, c.excludedItems, c.redactedValues);
  }
  for (const [reason, n] of Object.entries(from.skips) as [SkipReason, number][]) {
    into.skips[reason] = (into.skips[reason] ?? 0) + n;
  }
}

function addExclusion(t: Tally, category: CountCategory, excludedItems: number, redactedValues: number): void {
  const cur = t.exclusions[category] ?? { excludedItems: 0, redactedValues: 0 };
  t.exclusions[category] = {
    excludedItems: cur.excludedItems + excludedItems,
    redactedValues: cur.redactedValues + redactedValues,
  };
}

/** Category of a whole-item exclusion: the first whole-item count, else the first count. */
function excludedCategory(r: InspectionResult): CountCategory {
  return r.counts.find((c) => c.wholeItem)?.category ?? r.counts[0]?.category ?? 'inspection_failed';
}

function redactedTotal(r: InspectionResult): number {
  return r.counts.reduce((n, c) => n + c.redactedValues, 0);
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Inclusive YYYY-MM-DD bounds; providers only filter coarsely (Graph delta has no upper bound). */
function inRange(d: Date, range: PageContext['dateRange']): boolean {
  const t = d.getTime();
  if (range.from && t < Date.parse(`${range.from}T00:00:00Z`)) return false;
  if (range.to && t >= Date.parse(`${range.to}T00:00:00Z`) + DAY_MS) return false;
  return true;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * Locks the source row (`FOR UPDATE`: occurrence inserts bump its `item_count`, and concurrent share locks would
 * deadlock on that upgrade) and the job row (`FOR SHARE`). Same order as pause/disconnect.
 */
async function stillRunning(tx: Tx, ctx: PageContext): Promise<boolean> {
  const [source] = await tx
    .select({ status: connectedSource.status })
    .from(connectedSource)
    .where(eq(connectedSource.id, ctx.sourceId))
    .for('update');
  const [job] = await tx
    .select({ status: importJob.status })
    .from(importJob)
    .where(eq(importJob.id, ctx.importJobId))
    .for('share');
  return source?.status === 'connected' && job?.status === 'running';
}

interface PreparedItem {
  id: string;
  kind: ContentKind;
  parentItemId: string | null;
  part?: number;
  result: InspectionResult;
  messageIdHash: string | null;
  contentHash: string;
}

type Inspected =
  | { status: 'excluded'; tally: Tally }
  | { status: 'accepted'; items: PreparedItem[]; tally: Tally };

/**
 * `import.page` per-message pipeline (T074): parse, range check, cross-source dedup, inspection of every body part
 * and attachment, then `content_item(pending_write)` -> `addDocuments` -> `active`. Content reaches the store only as
 * `buildDocument()` output of an accepted inspection (constitution I).
 */
export async function processMessage(
  ctx: PageContext,
  ref: MailRef,
  fetched: FetchedMessage,
  signal: PageSignal,
): Promise<{ outcome: MessageOutcome; tally: Tally }> {
  const tally = newTally();
  const own = new Set(ctx.ownAddresses);
  const isOwn = (from: string) => {
    const address = parseFromAddress(from).address;
    return address !== undefined && own.has(address);
  };

  let parsed: ParsedMessage;
  let authored = fetched.isSent;
  try {
    parsed = await parseMessage(fetched.raw, { authored, folders: fetched.folders });
    // Clients set isSent from the folder only; "From equals an own address" is applied here.
    if (!authored && isOwn(parsed.from)) {
      authored = true;
      parsed = await parseMessage(fetched.raw, { authored, folders: fetched.folders });
    }
  } catch {
    await imports.recordItemFailure({
      importJobId: ctx.importJobId,
      sourceId: ctx.sourceId,
      providerRef: ref.providerRef,
      reason: 'parse_failed',
    });
    tally.counters.itemsFailed += 1;
    return { outcome: 'failed', tally };
  }

  const itemDate = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : new Date();
  if (!inRange(itemDate, ctx.dateRange)) return { outcome: 'out_of_range', tally };

  const { messageIdHash, contentHash } = imports.hashes({
    messageId: parsed.messageId,
    from: parsed.from,
    date: parsed.date,
    subject: parsed.subject,
    bodyText: parsed.bodyText,
  });
  const authorship: Authorship = authored ? 'authored' : 'received';
  const occurrence = {
    userId: ctx.userId,
    sourceId: ctx.sourceId,
    providerRef: ref.providerRef,
    folders: parsed.folders,
    isSent: authored,
    importJobId: ctx.importJobId,
  };

  let inspected: Inspected | undefined;
  // A concurrent writer of the same Message-ID makes the insert hit the unique index: retry once as a duplicate.
  for (let attempt = 0; ; attempt++) {
    const dup = await withTransaction(async (tx) => {
      if (!(await stillRunning(tx, ctx))) return 'aborted' as const;
      const r = await imports.upsertOccurrence(tx, { ...occurrence, messageIdHash, contentHash });
      if (r.status === 'new') return r;
      await mergeDuplicate(tx, ctx, r.contentItemId, r.promoted);
      return r;
    });
    if (dup === 'aborted') {
      signal.aborted = true;
      return { outcome: 'aborted', tally: newTally() };
    }
    if (dup.status === 'duplicate') {
      tally.counters.itemsDuplicate += 1;
      await recordForHub(ctx, ref, parsed, authored);
      return { outcome: 'duplicate', tally };
    }

    inspected ??= await inspectMessage(ctx, ref, parsed, messageIdHash, contentHash);
    if (inspected.status === 'excluded') {
      mergeTally(tally, inspected.tally);
      return { outcome: 'excluded', tally };
    }

    const items = inspected.items;
    const docs: MemoryDoc[] = items.map((it) => ({
      id: it.id,
      content: buildDocument(it.result, {
        kind: it.kind,
        date: itemDate.toISOString(),
        direction: authored ? 'sent' : 'received',
        ...it.result.fields,
      }),
      documentDate: itemDate.toISOString(),
      metadata: buildMetadata({
        kind: it.kind,
        authorship,
        contentItemId: it.id,
        ...(it.parentItemId !== null ? { parentItemId: it.parentItemId } : {}),
        sourceId: ctx.sourceId,
        itemDate,
        ...(it.result.languageHint ? { lang: it.result.languageHint } : {}),
        wordCount: wordCount(it.result.text ?? ''),
        filterPolicyVersion: ctx.filterPolicyVersion,
        ...(it.part !== undefined ? { part: it.part } : {}),
        folders: parsed.folders,
        fromAddress: parsed.from,
      }),
    }));

    let written: boolean;
    try {
      written = await withTransaction(async (tx) => {
        if (!(await stillRunning(tx, ctx))) return false;
        await tx.insert(contentItem).values(
          items.map((it) => ({
            id: it.id,
            userId: ctx.userId,
            kind: it.kind,
            parentItemId: it.parentItemId,
            authorship,
            itemDate,
            languageCode: it.result.languageHint?.slice(0, 8) ?? null,
            wordCount: wordCount(it.result.text ?? ''),
            messageIdHash: it.messageIdHash,
            contentHash: it.contentHash,
            filterPolicyVersion: ctx.filterPolicyVersion,
            redactedValues: redactedTotal(it.result),
            status: 'pending_write' as const,
          })),
        );
        await imports.insertOccurrence(tx, { ...occurrence, contentItemId: items[0]!.id });
        return true;
      });
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
    if (!written) {
      signal.aborted = true;
      return { outcome: 'aborted', tally: newTally() };
    }

    const ids = items.map((it) => it.id);
    try {
      await ctx.store.addDocuments(ctx.ns, docs);
    } catch (err) {
      // Nothing half-written survives: the occurrence cascades, and the job retries the page.
      await getDb().delete(contentItem).where(inArray(contentItem.id, ids));
      throw err;
    }
    await getDb()
      .update(contentItem)
      .set({ status: 'active' })
      .where(and(inArray(contentItem.id, ids), eq(contentItem.status, 'pending_write')));
    tally.counters.itemsImported += 1;
    mergeTally(tally, inspected.tally);
    await recordForHub(ctx, ref, parsed, authored);
    return { outcome: 'imported', tally };
  }
}

/**
 * Hub ingest hook (contracts/jobs.md (1)): only for an `imported` or `duplicate` message of a hub-enabled mailbox.
 * Metadata only. A failure is logged by code and never fails the page.
 */
async function recordForHub(ctx: PageContext, ref: MailRef, parsed: ParsedMessage, authored: boolean): Promise<void> {
  if (!ctx.hub.enabled) return;
  try {
    await hubIngest.recordMessage({
      userId: ctx.userId,
      sourceId: ctx.sourceId,
      providerRef: ref.providerRef,
      folders: parsed.folders,
      parsed,
      direction: authored ? 'outbound' : 'inbound',
      webLink: null,
    });
  } catch {
    logger.warn(
      { userId: ctx.userId, sourceId: ctx.sourceId, importJobId: ctx.importJobId, errorCode: 'hub_ingest_failed' },
      'hub ingest failed; message not recorded',
    );
  }
}

/**
 * Inspects every body part and text-bearing attachment. Any excluded body part excludes the whole message (counted
 * once, under that part's category); an excluded attachment is counted and dropped.
 */
async function inspectMessage(
  ctx: PageContext,
  ref: MailRef,
  parsed: ParsedMessage,
  messageIdHash: string | null,
  contentHash: string,
): Promise<Inspected> {
  const tally = newTally();
  const opts = { policy: ctx.policy, ownAddresses: ctx.ownAddresses, classifier: ctx.classifier };
  const headers: InspectionInput['headers'] = { from: parsed.from, to: parsed.to, cc: parsed.cc };
  const parts = parsed.bodyParts.length > 0 ? parsed.bodyParts : [parsed.bodyText];
  const parentId = randomUUID();
  const items: PreparedItem[] = [];

  for (const [i, part] of parts.entries()) {
    const result = await inspectForUser(
      ctx.userId,
      { kind: 'email', subject: parsed.subject, bodyText: part, headers, folders: parsed.folders },
      opts,
    );
    if (result.outcome !== 'accepted') {
      const category = excludedCategory(result);
      if (category === 'inspection_failed') {
        await imports.recordItemFailure({
          importJobId: ctx.importJobId,
          sourceId: ctx.sourceId,
          providerRef: ref.providerRef,
          reason: 'inspection_failed',
        });
      }
      const excluded = newTally();
      excluded.counters.itemsExcluded = 1;
      addExclusion(excluded, category, 1, 0);
      return { status: 'excluded', tally: excluded };
    }
    items.push({
      id: i === 0 ? parentId : randomUUID(),
      kind: 'email',
      parentItemId: i === 0 ? null : parentId,
      ...(parts.length > 1 ? { part: i + 1 } : {}),
      result,
      messageIdHash: i === 0 ? messageIdHash : null,
      contentHash:
        i === 0
          ? contentHash
          : imports.hashes({ from: parsed.from, date: parsed.date, subject: parsed.subject, bodyText: part }).contentHash,
    });
  }

  for (const a of parsed.attachments) {
    let extracted: Awaited<ReturnType<typeof extractText>>;
    try {
      extracted = await extractText({ buffer: a.buffer, mime: a.mime, filename: a.filename });
    } catch {
      extracted = { failure: 'corrupt' };
    }
    if ('failure' in extracted) {
      const reason = ATTACHMENT_SKIP_FOR[extracted.failure];
      tally.skips[reason] = (tally.skips[reason] ?? 0) + 1;
      continue;
    }
    const result = await inspectForUser(
      ctx.userId,
      {
        kind: 'attachment',
        subject: parsed.subject,
        filename: a.filename,
        bodyText: extracted.text,
        headers,
        folders: parsed.folders,
      },
      opts,
    );
    if (result.outcome !== 'accepted') {
      addExclusion(tally, excludedCategory(result), 1, 0);
      continue;
    }
    items.push({
      id: randomUUID(),
      kind: 'attachment',
      parentItemId: parentId,
      result,
      messageIdHash: null,
      contentHash: imports.hashes({
        from: parsed.from,
        date: parsed.date,
        subject: a.filename,
        bodyText: extracted.text,
      }).contentHash,
    });
  }

  let redacted = false;
  for (const it of items) {
    for (const c of it.result.counts) {
      if (c.redactedValues > 0) {
        addExclusion(tally, c.category, 0, c.redactedValues);
        redacted = true;
      }
    }
  }
  if (redacted) tally.counters.itemsRedacted += 1;
  return { status: 'accepted', items, tally };
}

/**
 * Duplicate occurrence (FR-014): adds this source to `vs_source_ids` of the item and its children, and promotes
 * `vs_authorship` when the occurrence made the item authored. Runs inside the occurrence transaction, so a store
 * failure rolls the occurrence back and the page retry repeats it.
 */
async function mergeDuplicate(tx: Tx, ctx: PageContext, contentItemId: string, promoted: boolean): Promise<void> {
  const children = await tx
    .select({ id: contentItem.id })
    .from(contentItem)
    .where(eq(contentItem.parentItemId, contentItemId));
  if (promoted && children.length > 0) {
    await tx.update(contentItem).set({ authorship: 'authored' }).where(eq(contentItem.parentItemId, contentItemId));
  }
  for (const id of [contentItemId, ...children.map((c) => c.id)]) {
    const doc = await ctx.store.getDocument(ctx.ns, id);
    if (!doc) continue;
    const current = doc.metadata[META.sourceIds];
    const sourceIds = Array.isArray(current) ? current : [];
    if (sourceIds.includes(ctx.sourceId) && !promoted) continue;
    await ctx.store.updateDocumentMetadata(ctx.ns, id, {
      ...doc.metadata,
      [META.sourceIds]: [...new Set([...sourceIds, ctx.sourceId])],
      ...(promoted ? { [META.authorship]: 'authored' } : {}),
    });
  }
}
