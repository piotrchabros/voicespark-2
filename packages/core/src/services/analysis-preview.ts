import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { JOBS, QUEUES, enqueue, getQueue, jobIds } from '../queues';
import { adminGetVersion } from './definitions';

/** Status of an admin preview run (FR-004). The job result expires with the job (24 h). */
export interface PreviewRunStatus {
  status: 'queued' | 'running' | 'done' | 'failed';
  markdown: string | null;
  problems: string[];
}

const resultSchema = z.object({
  status: z.enum(['done', 'failed']),
  markdown: z.string().nullable(),
  problems: z.array(z.string()),
});

const FAILED: PreviewRunStatus = { status: 'failed', markdown: null, problems: ['preview_failed'] };

/** Enqueues a real model run of this definition version on the built-in synthetic samples. */
export async function startPreviewRun(
  adminId: string,
  definitionId: string,
  versionId: string,
): Promise<{ jobId: string }> {
  await adminGetVersion(definitionId, versionId);
  const jobId = jobIds.preview(randomUUID());
  await enqueue(JOBS.analysisPreview, { definitionVersionId: versionId, adminId }, { jobId });
  return { jobId };
}

/** A job that is missing, of another kind or of another version is `not_found`. */
export async function getPreviewRun(
  definitionId: string,
  versionId: string,
  jobId: string,
): Promise<PreviewRunStatus> {
  await adminGetVersion(definitionId, versionId);
  if (!/^preview-[0-9a-f-]{36}$/.test(jobId)) throw new AppError('not_found');
  const job = await getQueue(QUEUES.profile).getJob(jobId);
  if (!job || job.name !== JOBS.analysisPreview) throw new AppError('not_found');
  if ((job.data as { definitionVersionId?: unknown }).definitionVersionId !== versionId) {
    throw new AppError('not_found');
  }
  const state = await job.getState();
  switch (state) {
    case 'active':
      return { status: 'running', markdown: null, problems: [] };
    case 'completed': {
      const parsed = resultSchema.safeParse(job.returnvalue);
      return parsed.success ? parsed.data : FAILED;
    }
    case 'failed':
      return FAILED;
    case 'unknown':
      throw new AppError('not_found');
    default:
      // waiting, delayed, prioritized, waiting-children
      return { status: 'queued', markdown: null, problems: [] };
  }
}
