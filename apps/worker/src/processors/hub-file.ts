import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { getDb, user, withTransaction, type HubFile, type Tx } from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import type { ServiceContext } from '@voicespark/core/errors';
import { jobLogger, type SafeLogger } from '@voicespark/core/logger';
import type { JobPayload } from '@voicespark/core/queues';
import { audit } from '@voicespark/core/services/audit';
import { encryptContent } from '@voicespark/core/services/hub/common';
import { reindexFile } from '@voicespark/core/services/hub/files';
import { markDirty } from '@voicespark/core/services/hub/sync';
import { inspectForUser } from '@voicespark/core/services/inspection';
import type { InspectionResult } from '@voicespark/filters';
import { extractHubText, HUB_EXTRACT_TIMEOUT_MS, HUB_TEXT_MAX_CHARS } from '@voicespark/integrations/files';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';

// `hub.file-extract` (T063, contracts/jobs.md (14); data-model.md "hub_file"; FR-009, FR-010, FR-028). The blob is
// decrypted here only to derive text; the blob itself never reaches the classifier, the LLM or the memory store.
// Only the filtered text is stored (encrypted), indexed (first 90,000 chars) and, through the outbox, synced.

export type HubFileOutcome = 'extracted' | 'empty' | 'unsupported' | 'failed' | 'excluded' | 'skipped';

export interface HubFileResult {
  outcome: HubFileOutcome;
}

type HubFileJob = Job<JobPayload<'hub.file-extract'>, unknown, 'hub.file-extract'>;
type Settled = Exclude<HubFileOutcome, 'skipped'>;

const INSPECTION_FAILED = 'inspection_failed';

export function createHubFileHandler(overrides: Partial<WorkerDeps> = {}): Handler<'hub.file-extract'> {
  let deps: WorkerDeps | undefined;
  return async (job) => {
    deps ??= defaultDeps(overrides);
    return runFileExtract(job, deps);
  };
}

/** Category of a whole-item exclusion: the first whole-item count, else the first count. */
function excludedCategory(r: InspectionResult): string {
  return r.counts.find((c) => c.wholeItem)?.category ?? r.counts[0]?.category ?? INSPECTION_FAILED;
}

async function userActive(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ status: user.status }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.status === 'active';
}

async function runFileExtract(job: HubFileJob, deps: WorkerDeps): Promise<HubFileResult> {
  const { userId, fileId } = job.data;
  const log = jobLogger(job.id ?? fileId, { userId, entityId: fileId });
  const ctx: ServiceContext = { userId, role: 'user' };

  // Abort when the row is gone (deleted while pending), belongs to someone else or was already settled.
  const row = await content.getFile(ctx, fileId);
  if (!row || row.extractionStatus !== 'pending' || !(await userActive(userId))) {
    log.info({ status: 'skipped' });
    return { outcome: 'skipped' };
  }

  const bytes = await deps.blobStore.get(userId, row.storageKey);
  const extracted = await extractHubText(bytes, row.extension, { timeoutMs: HUB_EXTRACT_TIMEOUT_MS });
  if (extracted.status !== 'extracted' || extracted.text === undefined) {
    return settle(ctx, row, { status: extracted.status, reason: extracted.reason ?? null }, log);
  }

  const result = await inspectForUser(
    userId,
    { kind: 'file', bodyText: extracted.text, headers: {}, folders: [] },
    { classifier: deps.classifier },
  );
  const category = result.outcome === 'accepted' ? null : excludedCategory(result);

  // Fail closed: `inspection_failed` is a retryable failure, never an exclusion. Nothing is indexed or synced.
  if (category === INSPECTION_FAILED || (result.outcome === 'accepted' && result.text === undefined)) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (!finalAttempt) {
      log.warn({ status: 'retry', errorCode: INSPECTION_FAILED, attempt: job.attemptsMade + 1 });
      throw new Error(INSPECTION_FAILED);
    }
    return settle(ctx, row, { status: 'failed', reason: INSPECTION_FAILED }, log, { quiet: true });
  }

  if (category !== null) {
    // Whole-item exclusion: the derived text is discarded; the blob stays (constitution VI exception).
    return settle(ctx, row, { status: 'excluded', reason: category }, log, {
      onCommit: (tx) =>
        audit.record(
          {
            actorType: 'system',
            actorUserId: userId,
            action: 'hub.file_excluded',
            targetType: 'hub_file',
            targetId: fileId,
            metadata: { category },
          },
          tx,
        ),
    });
  }

  const redactedValues = result.counts.reduce((n, c) => n + c.redactedValues, 0);
  return settle(
    ctx,
    row,
    {
      status: 'extracted',
      reason: null,
      textEnc: encryptContent(result.text!.slice(0, HUB_TEXT_MAX_CHARS)),
      redactedValues,
    },
    log,
  );
}

/**
 * Writes the final status in one transaction with the search row (name, description and, when extracted, the first
 * 90,000 chars) and the file's outbox mark. `quiet` (inspection failure) touches neither the index nor the outbox.
 */
async function settle(
  ctx: ServiceContext,
  row: HubFile,
  out: { status: Settled; reason: string | null; textEnc?: string; redactedValues?: number },
  log: SafeLogger,
  opts: { quiet?: boolean; onCommit?: (tx: Tx) => Promise<void> } = {},
): Promise<HubFileResult> {
  const updated = await withTransaction(async (tx) => {
    const next = await content.updateFile(
      ctx,
      row.id,
      {
        extractionStatus: out.status,
        extractionReason: out.reason,
        extractedTextEnc: out.textEnc ?? null,
        redactedValues: out.redactedValues ?? 0,
        updatedAt: new Date(),
      },
      tx,
    );
    if (!next) return null;
    if (!opts.quiet) {
      await reindexFile(ctx, next, tx);
      await markDirty(tx, ctx.userId, 'file', next.id);
    }
    await opts.onCommit?.(tx);
    return next;
  });
  if (!updated) {
    log.info({ status: 'skipped' });
    return { outcome: 'skipped' };
  }
  log.info({ status: out.status, ...(out.reason ? { errorCode: out.reason } : {}) });
  return { outcome: out.status };
}

export const handlers: HandlerMap = {
  'hub.file-extract': createHubFileHandler(),
};
