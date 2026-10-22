import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from '../env';
import {
  JOB_OPTIONS,
  JOB_QUEUE,
  PAYLOAD_SCHEMAS,
  QUEUE_PREFIX,
  type JobName,
  type JobPayload,
  type QueueName,
} from './index';

// Everything is lazy: nothing connects to Redis at import time.
let connection: Redis | undefined;
const queues = new Map<QueueName, Queue>();

export function getRedisConnection(): Redis {
  connection ??= new Redis(loadEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: getRedisConnection(), prefix: QUEUE_PREFIX });
    queues.set(name, queue);
  }
  return queue;
}

export async function enqueue<N extends JobName>(
  name: N,
  payload: JobPayload<N>,
  opts: { jobId?: string; delay?: number } = {},
): Promise<Job> {
  const data = PAYLOAD_SCHEMAS[name].parse(payload);
  return getQueue(JOB_QUEUE[name]).add(name, data, {
    ...JOB_OPTIONS[name],
    ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
    ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
  });
}

export async function upsertScheduler(
  queue: QueueName,
  schedulerId: string,
  repeat: { every?: number; pattern?: string },
  job: { name: JobName; data: object },
): Promise<void> {
  await getQueue(queue).upsertJobScheduler(schedulerId, repeat, {
    name: job.name,
    data: job.data,
    opts: JOB_OPTIONS[job.name],
  });
}

export async function removeScheduler(queue: QueueName, schedulerId: string): Promise<void> {
  await getQueue(queue).removeJobScheduler(schedulerId);
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    await connection.quit();
    connection = undefined;
  }
}
