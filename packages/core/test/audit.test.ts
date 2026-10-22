import { describe, expect, it } from 'vitest';
import { validateAuditMetadata } from '../src/services/audit';

describe('validateAuditMetadata', () => {
  it('accepts filter.preferences_changed with categories', () => {
    const m = { added: ['passwords'], removed: [] };
    expect(validateAuditMetadata('filter.preferences_changed', m)).toEqual(m);
  });

  it('rejects unknown categories and extra keys', () => {
    expect(() => validateAuditMetadata('filter.preferences_changed', { added: ['nope'], removed: [] })).toThrow();
    expect(() => validateAuditMetadata('filter.preferences_changed', { added: [], removed: [], x: 1 })).toThrow();
  });

  it('accepts ids, counts and keys under the default whitelist', () => {
    const m = { count: 3, versionId: '3f2b8c1e-9d4a-4c1b-8e7a-1a2b3c4d5e6f', category: 'passwords' };
    expect(validateAuditMetadata('content.purged', m)).toEqual(m);
  });

  it('rejects free text and nested objects under the default whitelist', () => {
    expect(() => validateAuditMetadata('content.purged', { note: 'Hello World, secret!' })).toThrow();
    expect(() => validateAuditMetadata('content.purged', { a: { b: 1 } })).toThrow();
  });

  it('requires {category,count} for filter.audit_hit', () => {
    expect(validateAuditMetadata('filter.audit_hit', { category: 'passwords', count: 2 })).toEqual({
      category: 'passwords',
      count: 2,
    });
    expect(() => validateAuditMetadata('filter.audit_hit', { category: 'passwords' })).toThrow();
  });
});
