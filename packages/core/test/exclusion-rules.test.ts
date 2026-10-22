import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { normalizeRuleValue, RULE_LIMIT } from '../src/services/exclusion-rules';

function rejects(fn: () => unknown): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe('validation_failed');
  expect((err as AppError).details).toEqual({ field: 'value' });
}

describe('normalizeRuleValue', () => {
  it('sender: valid email, trimmed and lowercased', () => {
    expect(normalizeRuleValue('sender', '  Boss@Example.COM ')).toBe('boss@example.com');
    rejects(() => normalizeRuleValue('sender', 'not-an-email'));
    rejects(() => normalizeRuleValue('sender', ''));
  });

  it('domain: hostname, lowercased, without @', () => {
    expect(normalizeRuleValue('domain', 'Example.COM')).toBe('example.com');
    expect(normalizeRuleValue('domain', '@mail.example.co.uk')).toBe('mail.example.co.uk');
    rejects(() => normalizeRuleValue('domain', 'user@example.com'));
    rejects(() => normalizeRuleValue('domain', 'localhost'));
    rejects(() => normalizeRuleValue('domain', 'exa mple.com'));
  });

  it('folder_label: 1-200 characters', () => {
    expect(normalizeRuleValue('folder_label', ' Newsletters ')).toBe('Newsletters');
    expect(normalizeRuleValue('folder_label', 'x'.repeat(200))).toHaveLength(200);
    rejects(() => normalizeRuleValue('folder_label', '   '));
    rejects(() => normalizeRuleValue('folder_label', 'x'.repeat(201)));
  });

  it('keyword: 3-100 characters', () => {
    expect(normalizeRuleValue('keyword', ' divorce ')).toBe('divorce');
    rejects(() => normalizeRuleValue('keyword', 'ab'));
    rejects(() => normalizeRuleValue('keyword', 'x'.repeat(101)));
  });

  it('caps rules at 200 per user', () => {
    expect(RULE_LIMIT).toBe(200);
  });
});
