import type { JobsOptions } from 'bullmq';
import { z } from 'zod';

// Shared queue/job definitions (contracts/jobs.md). Payloads carry ids only, never content.

export const QUEUE_PREFIX = 'vs';

export const QUEUES = {
  import: 'import',
  syncPoll: 'sync-poll',
  upload: 'upload',
  profile: 'profile',
  draft: 'draft',
  deletion: 'deletion',
  retroscan: 'retroscan',
  notify: 'notify',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  importPage: 'import.page',
  syncPoll: 'sync.poll',
  uploadProcess: 'upload.process',
  profileGenerate: 'profile.generate',
  analysisPreview: 'analysis.preview',
  draftGenerate: 'draft.generate',
  deletionExecute: 'deletion.execute',
  retroscanScan: 'retroscan.scan',
  notifySend: 'notify.send',
  maintenanceTmpSweep: 'maintenance.tmp-sweep',
  maintenanceDeletionSla: 'maintenance.deletion-sla',
  maintenanceStaleImports: 'maintenance.stale-imports',
  maintenanceRetroscanExpiry: 'maintenance.retroscan-expiry',
  maintenanceCredentialAudit: 'maintenance.credential-audit',
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export const JOB_QUEUE: Record<JobName, QueueName> = {
  'import.page': QUEUES.import,
  'sync.poll': QUEUES.syncPoll,
  'upload.process': QUEUES.upload,
  'profile.generate': QUEUES.profile,
  'analysis.preview': QUEUES.profile,
  'draft.generate': QUEUES.draft,
  'deletion.execute': QUEUES.deletion,
  'retroscan.scan': QUEUES.retroscan,
  'notify.send': QUEUES.notify,
  'maintenance.tmp-sweep': QUEUES.maintenance,
  'maintenance.deletion-sla': QUEUES.maintenance,
  'maintenance.stale-imports': QUEUES.maintenance,
  'maintenance.retroscan-expiry': QUEUES.maintenance,
  'maintenance.credential-audit': QUEUES.maintenance,
};

const id = z.string().uuid();
const emptyPayload = z.object({}).strict();

export const PAYLOAD_SCHEMAS = {
  'import.page': z.object({ userId: id, sourceId: id, importJobId: id }).strict(),
  'sync.poll': z.object({ userId: id, sourceId: id }).strict(),
  'upload.process': z.object({ userId: id, uploadId: id, importJobId: id }).strict(),
  'profile.generate': z.object({ userId: id, generationId: id }).strict(),
  'analysis.preview': z.object({ definitionVersionId: id, adminId: id }).strict(),
  'draft.generate': z.object({ userId: id, draftId: id }).strict(),
  'deletion.execute': z
    .object({ deletionRequestId: id, waitCount: z.number().int().min(0).optional() })
    .strict(),
  'retroscan.scan': z.object({ retroscanId: id }).strict(),
  'notify.send': z.object({ notificationId: id }).strict(),
  'maintenance.tmp-sweep': emptyPayload,
  'maintenance.deletion-sla': emptyPayload,
  'maintenance.stale-imports': emptyPayload,
  'maintenance.retroscan-expiry': emptyPayload,
  'maintenance.credential-audit': emptyPayload,
} satisfies { [N in JobName]: z.ZodType };

export type JobPayload<N extends JobName> = z.infer<(typeof PAYLOAD_SCHEMAS)[N]>;

// Job ids use '-' separators and never ':' (BullMQ reserves it).
export const jobIds = {
  import: (sourceId: string) => `import-${sourceId}`,
  importPage: (sourceId: string, seq: number | string) => `import-${sourceId}-${seq}`,
  poll: (sourceId: string) => `poll-${sourceId}`,
  upload: (uploadId: string) => `upload-${uploadId}`,
  profile: (generationId: string) => `profile-${generationId}`,
  preview: (previewId: string) => `preview-${previewId}`,
  draft: (draftId: string) => `draft-${draftId}`,
  deletion: (deletionRequestId: string) => `deletion-${deletionRequestId}`,
  deletionVerify: (deletionRequestId: string) => `deletion-${deletionRequestId}-verify`,
  /** SLA re-enqueue of a `failed` request: the failed `deletion-{id}` job is still kept, so a fresh id (D-U7d). */
  deletionRetry: (deletionRequestId: string, attempt: number) => `deletion-${deletionRequestId}-r${attempt}`,
  retroscan: (retroscanId: string) => `retroscan-${retroscanId}`,
};

export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 86400 },
  removeOnFail: { age: 604800 },
} as const;

const DELETION_BACKOFF_BASE_MS = 60_000;
const DELETION_BACKOFF_CAP_MS = 2 * 60 * 60 * 1000;
export const CAPPED_EXPONENTIAL = 'cappedExponential';

// 60 s * 2^(n-1), capped at 2 h. The worker registers this as settings.backoffStrategy.
export function cappedExponentialBackoff(attemptsMade: number, _type?: string): number {
  const n = Math.max(1, attemptsMade);
  return Math.min(DELETION_BACKOFF_BASE_MS * 2 ** (n - 1), DELETION_BACKOFF_CAP_MS);
}

const exponential = (delay: number) => ({ type: 'exponential', delay });

export const JOB_OPTIONS: Record<JobName, JobsOptions> = {
  'import.page': { ...DEFAULT_JOB_OPTIONS, attempts: 5, backoff: exponential(30_000) },
  'sync.poll': { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
  'upload.process': { ...DEFAULT_JOB_OPTIONS, attempts: 3, backoff: exponential(10_000) },
  'profile.generate': { ...DEFAULT_JOB_OPTIONS, attempts: 3, backoff: exponential(20_000) },
  'analysis.preview': { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
  'draft.generate': { ...DEFAULT_JOB_OPTIONS, attempts: 2, backoff: { type: 'fixed', delay: 5_000 } },
  'deletion.execute': {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 12,
    backoff: { type: CAPPED_EXPONENTIAL, delay: DELETION_BACKOFF_BASE_MS },
  },
  'retroscan.scan': { ...DEFAULT_JOB_OPTIONS, attempts: 3, backoff: exponential(10_000) },
  'notify.send': { ...DEFAULT_JOB_OPTIONS, attempts: 5, backoff: exponential(10_000) },
  'maintenance.tmp-sweep': { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
  'maintenance.deletion-sla': { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
  'maintenance.stale-imports': { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
  'maintenance.retroscan-expiry': { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
  'maintenance.credential-audit': { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
};

export * from './client';
