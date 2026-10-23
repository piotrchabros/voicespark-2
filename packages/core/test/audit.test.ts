import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@voicespark/db';
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

  describe('hub actions (FR-032)', () => {
    const id = '3f2b8c1e-9d4a-4c1b-8e7a-1a2b3c4d5e6f';
    const valid: Record<string, Record<string, unknown>> = {
      'hub.mailbox_enabled': { sourceId: id, consentTextVersion: 'v1' },
      'hub.mailbox_disabled': { sourceId: id, hubData: 'keep' },
      'hub.mailbox_data_deleted': { sourceId: id, threads: 1, records: 2, links: 3, values: 4 },
      'hub.record_deleted': { kind: 'person', notes: 1, files: 0, links: 2 },
      'hub.records_merged': { kind: 'company' },
      'hub.suggestions_bulk_decided': { accepted: 1, rejected: 2, failed: 0 },
      'hub.ignore_rule_created': { kind: 'domain' },
      'hub.ignore_rule_deleted': { kind: 'address' },
      'hub.resync_requested': { items: 5 },
      'hub.file_excluded': { category: 'passwords' },
    };
    const hubActions = AUDIT_ACTIONS.filter((a) => a.startsWith('hub.'));

    it('covers every hub action', () => {
      expect(hubActions.sort()).toEqual(Object.keys(valid).sort());
    });

    for (const action of Object.keys(valid)) {
      it(`${action} accepts its whitelist`, () => {
        expect(validateAuditMetadata(action as never, valid[action])).toEqual(valid[action]);
      });

      it(`${action} rejects name, summary, address and free text`, () => {
        for (const extra of [{ name: 'Jan Kowalski' }, { summary: 'Meeting about the deal.' }, { address: 'jan@acme.example' }, { note: 'Hello World!' }]) {
          expect(() => validateAuditMetadata(action as never, { ...valid[action], ...extra })).toThrow();
        }
      });
    }
  });
});
