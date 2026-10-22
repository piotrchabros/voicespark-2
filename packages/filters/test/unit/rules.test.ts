import { describe, expect, it } from 'vitest';
import type { ExclusionRule } from '../../src/categories';
import { matchRules } from '../../src/rules';

const base = {
  subject: 'Quarterly update',
  bodyText: 'Hello team, the numbers look fine.',
  headers: { from: 'Alice Smith <Alice@Corp.Example.com>' },
  folders: ['Inbox', 'Work/Projects'],
};

const rule = (type: ExclusionRule['type'], value: string): ExclusionRule => ({ type, value });

describe('matchRules', () => {
  it('returns matched null when there are no rules', () => {
    expect(matchRules(base, [])).toEqual({ matched: null });
  });

  it('returns matched null when nothing matches', () => {
    const rules = [
      rule('sender', 'bob@other.test'),
      rule('domain', 'other.test'),
      rule('folder_label', 'Personal'),
      rule('keyword', 'confidential'),
    ];
    expect(matchRules(base, rules)).toEqual({ matched: null });
  });

  it('matches sender against the lowercased From address', () => {
    const r = rule('sender', 'alice@corp.example.com');
    expect(matchRules(base, [r]).matched).toBe(r);
    const upper = rule('sender', 'ALICE@Corp.Example.com');
    expect(matchRules(base, [upper]).matched).toBe(upper);
  });

  it('matches sender in a bare From header', () => {
    const r = rule('sender', 'alice@corp.example.com');
    expect(matchRules({ ...base, headers: { from: 'ALICE@corp.example.com' } }, [r]).matched).toBe(
      r,
    );
  });

  it('matches domain against the host of the sender', () => {
    const r = rule('domain', 'corp.example.com');
    expect(matchRules(base, [r]).matched).toBe(r);
    const upper = rule('domain', 'Corp.Example.COM');
    expect(matchRules(base, [upper]).matched).toBe(upper);
  });

  it('does not match a domain that is only part of the host', () => {
    expect(matchRules(base, [rule('domain', 'example.com')]).matched).toBeNull();
    expect(matchRules(base, [rule('domain', 'corp')]).matched).toBeNull();
  });

  it('does not match sender or domain when From is missing', () => {
    const input = { ...base, headers: {} };
    expect(
      matchRules(input, [
        rule('sender', 'alice@corp.example.com'),
        rule('domain', 'corp.example.com'),
      ]),
    ).toEqual({
      matched: null,
    });
  });

  it('matches folder_label case-insensitively', () => {
    const r = rule('folder_label', 'inbox');
    expect(matchRules(base, [r]).matched).toBe(r);
    const r2 = rule('folder_label', 'WORK/PROJECTS');
    expect(matchRules(base, [r2]).matched).toBe(r2);
  });

  it('matches a keyword in the subject, case-insensitively', () => {
    const r = rule('keyword', 'QUARTERLY');
    expect(matchRules(base, [r]).matched).toBe(r);
  });

  it('matches a keyword in the body, case-insensitively', () => {
    const r = rule('keyword', 'NUMBERS');
    expect(matchRules(base, [r]).matched).toBe(r);
  });

  it('matches keywords on word boundaries only', () => {
    expect(matchRules(base, [rule('keyword', 'num')]).matched).toBeNull();
    expect(matchRules(base, [rule('keyword', 'updat')]).matched).toBeNull();
    expect(
      matchRules({ ...base, bodyText: 'The numbers, fine.' }, [rule('keyword', 'numbers')]).matched,
    ).not.toBeNull();
  });

  it('handles a missing subject', () => {
    const { subject: _subject, ...rest } = base;
    expect(matchRules(rest, [rule('keyword', 'numbers')]).matched).not.toBeNull();
    expect(matchRules(rest, [rule('keyword', 'quarterly')]).matched).toBeNull();
  });

  it('returns the first matching rule in order', () => {
    const first = rule('keyword', 'numbers');
    const second = rule('folder_label', 'Inbox');
    expect(matchRules(base, [first, second]).matched).toBe(first);
    expect(matchRules(base, [second, first]).matched).toBe(second);
  });
});
