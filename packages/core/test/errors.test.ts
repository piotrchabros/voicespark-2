import { describe, expect, it } from 'vitest';
import { AppError, ERROR_STATUS, isAppError } from '../src/errors';
import { jobIds } from '../src/queues';

describe('AppError', () => {
  it('maps code to status and default message', () => {
    const err = new AppError('not_found');
    expect(err.status).toBe(ERROR_STATUS.not_found);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('AppError');
  });

  it('keeps details and status override', () => {
    const err = new AppError('conflict', 'dup', { a: 1 }, 410);
    expect(err.status).toBe(410);
    expect(err.details).toEqual({ a: 1 });
  });

  it('isAppError narrows', () => {
    expect(isAppError(new AppError('internal_error'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });
});

describe('jobIds.importPage', () => {
  it('builds per-page ids distinct from the lock id', () => {
    expect(jobIds.importPage('s1', 5)).toBe('import-s1-5');
    expect(jobIds.importPage('s1', 5)).not.toBe(jobIds.import('s1'));
  });
});
