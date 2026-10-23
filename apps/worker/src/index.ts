import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { closeDb } from '@voicespark/db/client';
import { loadEnv } from '@voicespark/core/env';
import { jobLogger, logger } from '@voicespark/core/logger';
import {
  HUB_CONCURRENCY,
  JOBS,
  PAYLOAD_SCHEMAS,
  QUEUES,
  QUEUE_PREFIX,
  cappedExponentialBackoff,
  closeQueues,
  getRedisConnection,
  upsertScheduler,
  type JobName,
  type QueueName,
} from '@voicespark/core/queues';
import { toErrorCode, toSafeError } from './error-code';
import { perJobNameSemaphore, type HandlerMap } from './handlers';
import { handlers as analysisPreview } from './processors/analysis-preview';
import { handlers as deletion } from './processors/deletion';
import { handlers as draft } from './processors/draft';
import { handlers as hubFile } from './processors/hub-file';
import { handlers as hubRefilter } from './processors/hub-refilter';
import { handlers as hubSync } from './processors/hub-sync';
import { handlers as importHandlers } from './processors/import';
import { handlers as maintenance } from './processors/maintenance';
import { handlers as notify } from './processors/notify';
import { handlers as profile } from './processors/profile';
import { handlers as retroscan } from './processors/retroscan';
import { handlers as syncPoll } from './processors/sync-poll';
import { handlers as upload } from './processors/upload';

const HANDLERS: HandlerMap = {
  ...importHandlers,
  ...syncPoll,
  ...upload,
  ...profile,
  ...analysisPreview,
  ...draft,
  ...deletion,
  ...retroscan,
  ...notify,
  ...maintenance,
  ...hubFile,
  ...hubRefilter,
  ...hubSync,
};

// Per-job-name limits inside the single `hub` Worker (contracts/jobs.md; sum = its concurrency of 12).
const hubLimit = perJobNameSemaphore({
  [JOBS.hubThread]: HUB_CONCURRENCY.thread,
  [JOBS.hubBackfill]: HUB_CONCURRENCY.backfill,
  [JOBS.hubSync]: HUB_CONCURRENCY.sync,
  [JOBS.hubFileExtract]: HUB_CONCURRENCY.fileExtract,
  [JOBS.hubRefilter]: HUB_CONCURRENCY.refilter,
});

function dispatchHub(job: Job, token?: string): Promise<unknown> {
  return hubLimit(job.name, () => dispatch(job, token));
}

type AnyHandler = (job: Job, token?: string) => Promise<unknown>;

async function dispatch(job: Job, token?: string): Promise<unknown> {
  const name = job.name as JobName;
  const handler = (HANDLERS as Record<string, AnyHandler | undefined>)[name];
  const schema = (PAYLOAD_SCHEMAS as Record<string, (typeof PAYLOAD_SCHEMAS)[JobName] | undefined>)[
    name
  ];
  if (!handler || !schema) throw new UnrecoverableError('unknown_job');
  if (!schema.safeParse(job.data).success) throw new UnrecoverableError('invalid_payload');

  const log = jobLogger(job.id ?? 'unknown', { jobName: name, queue: job.queueName });
  const started = Date.now();
  try {
    const result = await handler(job, token);
    log.info({ status: 'completed', durationMs: Date.now() - started });
    return result;
  } catch (err) {
    log.error({
      status: 'failed',
      attempt: job.attemptsMade + 1,
      durationMs: Date.now() - started,
      errorCode: toErrorCode(err),
    });
    throw toSafeError(err);
  }
}

const HOUR_MS = 3_600_000;
const SCHEDULERS: ReadonlyArray<{
  id: JobName;
  repeat: { every?: number; pattern?: string };
}> = [
  { id: 'maintenance.tmp-sweep', repeat: { every: HOUR_MS } },
  { id: 'maintenance.deletion-sla', repeat: { every: 900_000 } },
  { id: 'maintenance.stale-imports', repeat: { every: 600_000 } },
  { id: 'maintenance.retroscan-expiry', repeat: { pattern: '0 3 * * *' } },
  { id: 'maintenance.credential-audit', repeat: { pattern: '0 4 * * 0' } },
  { id: 'maintenance.hub-blob-sweep', repeat: { pattern: '0 5 * * *' } },
  { id: 'maintenance.hub-refilter-retry', repeat: { pattern: '0 4 * * *' } },
  { id: 'maintenance.hub-sync-sweep', repeat: { every: 60_000 } },
];

async function main(): Promise<void> {
  const env = loadEnv();
  const connection = getRedisConnection();
  const concurrency: Partial<Record<QueueName, number>> = {
    [QUEUES.import]: env.WORKER_CONCURRENCY_IMPORT,
    [QUEUES.profile]: env.WORKER_CONCURRENCY_LLM,
    [QUEUES.draft]: env.WORKER_CONCURRENCY_LLM,
    [QUEUES.hub]: 12,
  };

  const workers = Object.values(QUEUES).map((queue) => {
    const worker = new Worker(queue, queue === QUEUES.hub ? dispatchHub : dispatch, {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: concurrency[queue] ?? 1,
      settings: {
        // Only the deletion job uses the custom CAPPED_EXPONENTIAL type; built-in types never reach here.
        backoffStrategy: (attemptsMade, type) => cappedExponentialBackoff(attemptsMade, type),
      },
    });
    worker.on('error', (err) => {
      logger.error({ queue, errorCode: err.name });
    });
    return worker;
  });

  for (const { id, repeat } of SCHEDULERS) {
    await upsertScheduler(QUEUES.maintenance, id, repeat, { name: id, data: {} });
  }

  await Promise.all(workers.map((w) => w.waitUntilReady()));
  logger.info({ status: 'ready', count: workers.length }, 'worker ready');

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ status: 'shutting_down' }, signal);
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal(
    { errorCode: err instanceof Error ? err.name : 'unknown' },
    'worker failed to start',
  );
  process.exit(1);
});
