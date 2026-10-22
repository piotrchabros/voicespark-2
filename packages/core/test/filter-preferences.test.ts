import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { diffSelection, validateSelection } from '../src/services/filter-preferences';

const LOCKED = ['passwords', 'otp_codes', 'reset_verification_links', 'api_keys_tokens'];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'not_app_error';
  }
  return undefined;
}

describe('validateSelection', () => {
  it('accepts the locked keys alone and returns catalog order without duplicates', () => {
    expect(validateSelection(['api_keys_tokens', 'health', 'passwords', 'otp_codes', 'reset_verification_links', 'health'])).toEqual([
      'passwords',
      'otp_codes',
      'reset_verification_links',
      'api_keys_tokens',
      'health',
    ]);
  });

  it('rejects any selection missing a locked key with category_locked', () => {
    for (const key of LOCKED) {
      const err = (() => {
        try {
          validateSelection(LOCKED.filter((k) => k !== key));
        } catch (e) {
          return e as AppError;
        }
      })();
      expect(err).toBeInstanceOf(AppError);
      expect(err?.code).toBe('category_locked');
      expect(err?.status).toBe(422);
    }
    expect(codeOf(() => validateSelection([]))).toBe('category_locked');
  });

  it('rejects unknown keys with validation_failed', () => {
    expect(codeOf(() => validateSelection([...LOCKED, 'user_rule']))).toBe('validation_failed');
    expect(codeOf(() => validateSelection([...LOCKED, 'nope']))).toBe('validation_failed');
  });
});

describe('diffSelection', () => {
  it('reports added and removed keys in catalog order', () => {
    expect(diffSelection(['passwords', 'health', 'bank_accounts'], ['passwords', 'third_party_contacts', 'payment_cards'])).toEqual({
      added: ['payment_cards', 'third_party_contacts'],
      removed: ['bank_accounts', 'health'],
    });
    expect(diffSelection(['passwords'], ['passwords'])).toEqual({ added: [], removed: [] });
  });
});
