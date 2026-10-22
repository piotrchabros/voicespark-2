import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const exec = vi.hoisted(() => vi.fn());
vi.mock('@voicespark/core/queues', () => {
  const chain = {
    zremrangebyscore: () => chain,
    zadd: () => chain,
    zcard: () => chain,
    pexpire: () => chain,
    exec,
  };
  return { getRedisConnection: () => ({ multi: () => chain }) };
});
vi.mock('@voicespark/core/logger', () => ({ logger: { error: vi.fn() } }));

import {
  AppError,
  ERROR_STATUS,
  errorResponse,
  handle,
  paginate,
  parseJson,
  parsePagination,
  rateLimit,
} from '../lib/http';

const json = (body: unknown) =>
  new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });

describe('errors', () => {
  it('maps codes to statuses', () => {
    expect(ERROR_STATUS.unauthenticated).toBe(401);
    expect(ERROR_STATUS.admin_required).toBe(403);
    expect(ERROR_STATUS.filter_confirmation_required).toBe(409);
    expect(ERROR_STATUS.sensitive_content).toBe(422);
    expect(ERROR_STATUS.too_large).toBe(413);
    expect(ERROR_STATUS.rate_limited).toBe(429);
  });

  it('produces the envelope', async () => {
    const res = errorResponse(new AppError('conflict', 'draft exists', { id: '1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: 'conflict', message: 'draft exists', details: { id: '1' } },
    });
  });

  it('allows a status override', () => {
    expect(new AppError('unsupported_type', 'x', undefined, 415).status).toBe(415);
  });
});

describe('handle', () => {
  it('wraps plain values, Responses and undefined', async () => {
    expect(
      await (await handle(async () => ({ a: 1 }))(new Request('http://x'), {})).json(),
    ).toEqual({
      a: 1,
    });
    expect((await handle(async () => undefined)(new Request('http://x'), {})).status).toBe(204);
    expect(
      (await handle(async () => new Response('x', { status: 202 }))(new Request('http://x'), {}))
        .status,
    ).toBe(202);
  });

  it('maps zod errors to 422 without echoing values', async () => {
    const res = await handle(async (req) => parseJson(req, z.object({ n: z.number() })))(
      json({ n: 'secret-value' }),
      {},
    );
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain('validation_failed');
    expect(text).not.toContain('secret-value');
  });

  it('maps unknown errors to a generic 500', async () => {
    const res = await handle(async () => {
      throw new Error('boom with stack');
    })(new Request('http://x'), {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });

  it('rejects invalid JSON', async () => {
    await expect(
      parseJson(new Request('http://x', { method: 'POST', body: '{' }), z.any()),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('pagination', () => {
  it('applies defaults and caps', () => {
    expect(parsePagination('http://x/a')).toEqual({ limit: 25 });
    expect(parsePagination('http://x/a?limit=500&cursor=abc')).toEqual({
      limit: 100,
      cursor: 'abc',
    });
    expect(() => parsePagination('http://x/a?limit=0')).toThrow(AppError);
  });

  it('paginates limit+1 rows', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(paginate(rows, 2)).toEqual({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' });
    expect(paginate(rows, 3)).toEqual({ items: rows, nextCursor: null });
  });
});

describe('rateLimit', () => {
  it('allows up to the limit then throws rate_limited', async () => {
    exec.mockResolvedValueOnce([
      [null, 0],
      [null, 1],
      [null, 3],
      [null, 1],
    ]);
    await expect(rateLimit('k', 3, 60)).resolves.toBeUndefined();
    exec.mockResolvedValueOnce([
      [null, 0],
      [null, 1],
      [null, 4],
      [null, 1],
    ]);
    await expect(rateLimit('k', 3, 60)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });
});
