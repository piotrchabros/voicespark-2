import { DelayedError, UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { toErrorCode, toSafeError } from '../src/error-code';

const SECRET = 'secret@example.com';

/** Shape of drizzle-orm's DrizzleQueryError wrapping a pg DatabaseError. */
function drizzleLikeError(): Error {
  const cause = Object.assign(new Error(`duplicate key value violates unique constraint`), {
    code: '23505',
    detail: `Key (value)=(${SECRET}) already exists.`,
  });
  const err = new Error(
    `Failed query: insert into "excluded_senders" ("value") values ($1)\nparams: ${SECRET}`,
    { cause },
  );
  err.name = 'DrizzleQueryError';
  return err;
}

describe('toErrorCode', () => {
  it('reduces a drizzle query error to a safe code without its parameters', () => {
    const code = toErrorCode(drizzleLikeError());
    expect(code).toBe('pg_23505');
    expect(code).not.toContain(SECRET);
  });

  it('falls back to internal_error for unknown errors with unsafe messages', () => {
    expect(toErrorCode(new Error(`params: ${SECRET}`))).toBe('internal_error');
    expect(toErrorCode('raw string')).toBe('internal_error');
  });

  it('keeps safe codes, AppError/DeletionError codes and known class names', () => {
    expect(toErrorCode(new UnrecoverableError('llm_refused'))).toBe('llm_refused');
    expect(
      toErrorCode(Object.assign(new Error('Human text'), { name: 'AppError', code: 'not_found' })),
    ).toBe('not_found');
    const rl = new Error('Mailbox provider rate limit, retry after 10 ms');
    rl.name = 'RateLimitedError';
    expect(toErrorCode(rl)).toBe('RateLimitedError');
  });
});

describe('toSafeError', () => {
  it('rethrows a drizzle query error as a plain Error carrying only the code', () => {
    const out = toSafeError(drizzleLikeError()) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('pg_23505');
    expect(out.stack ?? '').not.toContain(SECRET);
    expect((out as { cause?: unknown }).cause).toBeUndefined();
    expect(out).not.toBeInstanceOf(UnrecoverableError);
  });

  it('preserves UnrecoverableError semantics while stripping the message', () => {
    const out = toSafeError(new UnrecoverableError(`params: ${SECRET}`));
    expect(out).toBeInstanceOf(UnrecoverableError);
    expect((out as Error).message).toBe('internal_error');
  });

  it('passes safe errors and DelayedError through untouched', () => {
    const safe = new UnrecoverableError('mail_auth');
    expect(toSafeError(safe)).toBe(safe);
    const delayed = new DelayedError();
    expect(toSafeError(delayed)).toBe(delayed);
  });
});
