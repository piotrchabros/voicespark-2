import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { imapAddress, toSourceView, validateDateRange, type SourceRow } from '../src/services/sources';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : 'other';
  }
}

describe('validateDateRange', () => {
  it('accepts open, partial and closed ranges', () => {
    expect(validateDateRange()).toEqual({ from: null, to: null });
    expect(validateDateRange({ from: '2024-01-31' })).toEqual({ from: '2024-01-31', to: null });
    expect(validateDateRange({ to: '2024-02-29' })).toEqual({ from: null, to: '2024-02-29' });
    expect(validateDateRange({ from: '2024-03-01', to: '2024-03-01' })).toEqual({ from: '2024-03-01', to: '2024-03-01' });
  });

  it('rejects malformed days, impossible dates and reversed ranges', () => {
    expect(codeOf(() => validateDateRange({ from: '2024-1-01' }))).toBe('validation_failed');
    expect(codeOf(() => validateDateRange({ to: '2023-02-29' }))).toBe('validation_failed');
    expect(codeOf(() => validateDateRange({ from: '2024-13-01' }))).toBe('validation_failed');
    expect(codeOf(() => validateDateRange({ from: '2024-05-02', to: '2024-05-01' }))).toBe('validation_failed');
  });
});

describe('imapAddress', () => {
  it('uses the username when it is an address, else username@host, lowercased', () => {
    expect(imapAddress({ host: 'imap.example.com', username: ' Me@Example.com ' })).toBe('me@example.com');
    expect(imapAddress({ host: 'IMAP.example.com', username: 'Me' })).toBe('me@imap.example.com');
  });
});

describe('toSourceView', () => {
  it('maps the row to the API shape without the address or credentials', () => {
    const row: SourceRow = {
      id: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      type: 'imap',
      accountLabel: 'me@example.com',
      accountAddress: 'me@example.com',
      status: 'paused',
      pauseReason: 'user',
      dateRangeFrom: '2024-01-01',
      dateRangeTo: null,
      lastSyncAt: new Date('2024-06-01T10:00:00.000Z'),
      lastErrorCode: 'mail_auth',
      itemCount: 42,
      connectedAt: new Date('2024-05-01T00:00:00.000Z'),
      disconnectedAt: null,
      consentTextVersion: 'imap-v1',
    };
    const view = toSourceView(row, null);
    expect(view).toEqual({
      id: row.id,
      type: 'imap',
      accountLabel: 'me@example.com',
      status: 'paused',
      pauseReason: 'user',
      itemCount: 42,
      lastSyncAt: '2024-06-01T10:00:00.000Z',
      dateRange: { from: '2024-01-01', to: null },
      currentImport: null,
    });
    expect(Object.keys(view)).not.toContain('userId');
    expect(Object.keys(view)).not.toContain('lastErrorCode');
  });
});
