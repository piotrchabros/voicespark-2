import { ZodError, type ZodType } from 'zod';
import { logger } from '@voicespark/core/logger';
import { AppError } from '@voicespark/core/errors';
import { getRedisConnection } from '@voicespark/core/queues';

export { AppError, ERROR_STATUS, type ErrorCode } from '@voicespark/core/errors';

export function errorResponse(err: AppError): Response {
  const error: { code: string; message: string; details?: Record<string, unknown> } = {
    code: err.code,
    message: err.message,
  };
  if (err.details !== undefined) error.details = err.details;
  return Response.json({ error }, { status: err.status });
}

// Issue paths and messages only: never echo submitted values (they may be content).
function validationError(err: ZodError): AppError {
  return new AppError('validation_failed', undefined, {
    issues: err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  });
}

export function handle<C = unknown>(
  fn: (req: Request, ctx: C) => Promise<Response | unknown>,
): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const result = await fn(req, ctx);
      if (result instanceof Response) return result;
      if (result === undefined) return new Response(null, { status: 204 });
      return Response.json(result);
    } catch (err) {
      if (err instanceof AppError) return errorResponse(err);
      if (err instanceof ZodError) return errorResponse(validationError(err));
      logger.error({ errorCode: 'internal_error' }, 'unhandled request error');
      return errorResponse(new AppError('internal_error'));
    }
  };
}

export async function parseJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError('validation_failed', 'Request body must be valid JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export function parsePagination(url: URL | string): { cursor?: string; limit: number } {
  const params = (typeof url === 'string' ? new URL(url, 'http://localhost') : url).searchParams;
  const raw = params.get('limit');
  let limit = DEFAULT_PAGE_LIMIT;
  if (raw !== null && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new AppError('validation_failed', 'limit must be a positive integer');
    }
    limit = Math.min(n, MAX_PAGE_LIMIT);
  }
  const cursor = params.get('cursor');
  return cursor ? { cursor, limit } : { limit };
}

// `rows` must have been fetched with `limit + 1`; the extra row signals another page.
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: items[items.length - 1]?.id ?? null };
}

// Sliding window over a Redis sorted set; the attempt is recorded before the check.
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const redis = getRedisConnection();
  const redisKey = `vs:ratelimit:${key}`;
  const now = Date.now();
  const results = await redis
    .multi()
    .zremrangebyscore(redisKey, 0, now - windowSeconds * 1000)
    .zadd(redisKey, now, `${now}-${crypto.randomUUID()}`)
    .zcard(redisKey)
    .pexpire(redisKey, windowSeconds * 1000)
    .exec();
  const count = Number(results?.[2]?.[1] ?? 0);
  if (count > limit) {
    throw new AppError('rate_limited', undefined, { retryAfterSeconds: windowSeconds });
  }
}
