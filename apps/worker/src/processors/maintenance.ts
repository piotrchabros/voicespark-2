import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { loadEnv } from '@voicespark/core/env';
import { runCredentialAudit } from '@voicespark/core/services/credential-audit';
import { runDeletionSla } from '@voicespark/core/services/deletion-sla';
import { enqueue, jobIds } from '@voicespark/core/queues';
import * as imports from '@voicespark/core/services/imports';
import * as retroscans from '@voicespark/core/services/retroscans';
import { connectedSource, filterPreferences, getDb, hubSyncItem, importJob, upload, user } from '@voicespark/db';
import { dueSyncUsers, orphanBlobKeys } from '@voicespark/db/repos/system/hub';
import { createMemoryStore, type MemoryStore } from '@voicespark/integrations/supermemory';
import type { HandlerMap } from '../handlers';

/** A running job without page activity for this long lost its page job (worker crash, lost Redis entry; R12). */
export const STALE_IMPORT_MS = 15 * 60 * 1000;

/** `maintenance.stale-imports` (T076): re-enqueue `import.page` for stalled running jobs on connected sources. */
async function staleImports(): Promise<{ count: number }> {
  const cutoff = new Date(Date.now() - STALE_IMPORT_MS);
  const stale = await getDb()
    .select({ id: importJob.id, userId: importJob.userId, sourceId: importJob.sourceId })
    .from(importJob)
    .innerJoin(connectedSource, eq(connectedSource.id, importJob.sourceId))
    .where(
      and(
        eq(importJob.status, 'running'),
        // Upload jobs have no pages; a stuck upload is handled by the BullMQ retry and the tmp sweep (D-U8).
        ne(importJob.kind, 'upload'),
        eq(connectedSource.status, 'connected'),
        or(
          lt(importJob.lastActivityAt, cutoff),
          and(isNull(importJob.lastActivityAt), lt(importJob.startedAt, cutoff)),
        ),
      ),
    );
  // The per-source lock (D-C6) makes a duplicate page a no-op if the original page is in fact still alive.
  for (const j of stale) {
    await imports.enqueuePage({ userId: j.userId, sourceId: j.sourceId, importJobId: j.id });
  }
  return { count: stale.length };
}

/** Staged upload files older than this are deleted and their uploads failed (research R11). */
export const TMP_MAX_AGE_MS = 24 * 3600 * 1000;

const STAGED_NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.enc$/i;
const PENDING_UPLOAD = ['received', 'processing'] as const;

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Fails pending uploads (and their jobs) among `ids`; returns how many changed. */
async function failUploads(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const failed = await getDb()
    .update(upload)
    .set({ status: 'failed', stagingPath: null, updatedAt: new Date() })
    .where(and(inArray(upload.id, ids), inArray(upload.status, PENDING_UPLOAD)))
    .returning({ importJobId: upload.importJobId });
  for (const f of failed)
    if (f.importJobId) await imports.failJob(f.importJobId, 'staging_expired');
  return failed.length;
}

/**
 * `maintenance.tmp-sweep` (T111): deletes files in UPLOAD_TMP_DIR older than 24 h and fails their pending uploads;
 * pending uploads older than 24 h whose staged file is gone are failed as well.
 */
export async function tmpSweep(
  now: Date = new Date(),
): Promise<{ deletedFiles: number; failedUploads: number }> {
  const dir = loadEnv().UPLOAD_TMP_DIR;
  const cutoff = new Date(now.getTime() - TMP_MAX_AGE_MS);
  let deletedFiles = 0;
  let failedUploads = 0;

  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  const expiredUploads: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (!s.isFile() || s.mtime >= cutoff) continue;
      await unlink(path);
    } catch (e) {
      if (isMissing(e)) continue;
      throw e;
    }
    deletedFiles += 1;
    const id = STAGED_NAME_RE.exec(name)?.[1];
    if (id) expiredUploads.push(id.toLowerCase());
  }
  failedUploads += await failUploads(expiredUploads);

  const stale = await getDb()
    .select({ id: upload.id, stagingPath: upload.stagingPath })
    .from(upload)
    .where(and(inArray(upload.status, PENDING_UPLOAD), lt(upload.createdAt, cutoff)));
  const orphaned: string[] = [];
  for (const u of stale) {
    if (!u.stagingPath) {
      orphaned.push(u.id);
      continue;
    }
    try {
      await stat(u.stagingPath);
    } catch (e) {
      if (isMissing(e)) orphaned.push(u.id);
      else throw e;
    }
  }
  failedUploads += await failUploads(orphaned);
  return { deletedFiles, failedUploads };
}

/** `maintenance.retroscan-expiry` (T094): unconfirmed scan results past `expires_at` become `dismissed`. */
async function retroscanExpiry(): Promise<{ count: number }> {
  return { count: await retroscans.expireStale() };
}

/** Blobs younger than this are left alone: an upload writes the blob before its row commits. */
export const HUB_BLOB_MIN_AGE_MS = 3600 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOB_NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.bin$/i;

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
}

/**
 * `maintenance.hub-blob-sweep` (T063, daily; contracts/jobs.md (16)): deletes `{HUB_FILES_DIR}/{userId}/{key}.bin`
 * blobs older than 1 h that have no `hub_file` row (failed commits, deletes whose blob removal failed). Never touches
 * rows.
 */
export async function hubBlobSweep(now: Date = new Date()): Promise<{ deleted: number }> {
  const dir = loadEnv().HUB_FILES_DIR;
  const cutoff = new Date(now.getTime() - HUB_BLOB_MIN_AGE_MS);
  let deleted = 0;
  for (const userDir of await listDir(dir)) {
    if (!UUID_RE.test(userDir)) continue;
    const old = new Map<string, string>();
    for (const name of await listDir(join(dir, userDir))) {
      const key = BLOB_NAME_RE.exec(name)?.[1];
      if (!key) continue;
      const path = join(dir, userDir, name);
      try {
        const s = await stat(path);
        if (s.isFile() && s.mtime < cutoff) old.set(key.toLowerCase(), path);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    for (const key of await orphanBlobKeys([...old.keys()])) {
      try {
        await unlink(old.get(key)!);
        deleted += 1;
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
  }
  return { deleted };
}

/**
 * `maintenance.hub-sync-sweep` (T082, every minute; contracts/jobs.md (16)): enqueues `hub.sync` for every user with
 * due `hub_sync_item` rows (lost wake-ups, backoff due; never `refilter_pending` rows). The job id keeps one pending
 * wake-up per user.
 */
export async function hubSyncSweep(): Promise<{ count: number }> {
  const users = await dueSyncUsers();
  for (const userId of users) await enqueue('hub.sync', { userId }, { jobId: jobIds.hubSync(userId) });
  return { count: users.length };
}

/**
 * `maintenance.hub-refilter-retry` (T084, daily; contracts/jobs.md (15), (16)): re-enqueues `hub.refilter` under the
 * current policy version for every active user with rows held as `refilter_pending` (final refilter failure or a
 * credential-audit hit). Finished `hub.refilter` jobs are not kept, so the same job id enqueues again.
 */
export async function hubRefilterRetry(): Promise<{ count: number }> {
  const users = await getDb()
    .selectDistinct({ userId: hubSyncItem.userId, version: sql<number>`coalesce(${filterPreferences.version}, 0)::int` })
    .from(hubSyncItem)
    .innerJoin(user, and(eq(user.id, hubSyncItem.userId), eq(user.status, 'active')))
    .leftJoin(filterPreferences, eq(filterPreferences.userId, hubSyncItem.userId))
    .where(eq(hubSyncItem.lastErrorCode, 'refilter_pending'));
  for (const u of users) {
    await enqueue(
      'hub.refilter',
      { userId: u.userId, policyVersion: u.version },
      { jobId: jobIds.hubRefilter(u.userId, u.version) },
    );
  }
  return { count: users.length };
}

let store: MemoryStore | undefined;

/** `maintenance.credential-audit` (T167, weekly): locked-category re-scan of a sample of every active namespace. */
async function credentialAudit(): Promise<unknown> {
  store ??= createMemoryStore(loadEnv());
  return runCredentialAudit(store);
}

export const handlers: HandlerMap = {
  'maintenance.tmp-sweep': () => tmpSweep(),
  'maintenance.deletion-sla': () => runDeletionSla(),
  'maintenance.stale-imports': staleImports,
  'maintenance.retroscan-expiry': retroscanExpiry,
  'maintenance.credential-audit': credentialAudit,
  'maintenance.hub-blob-sweep': () => hubBlobSweep(),
  'maintenance.hub-sync-sweep': () => hubSyncSweep(),
  'maintenance.hub-refilter-retry': () => hubRefilterRetry(),
};
