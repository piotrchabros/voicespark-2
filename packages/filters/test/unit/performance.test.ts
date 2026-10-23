import { describe, expect, it } from 'vitest';
import { FILTER_CATEGORY_KEYS, type InspectionInput, type Policy } from '../../src/categories';
import { createRecordedClassifier } from '../../src/classifier/recorded';
import { inspect } from '../../src/pipeline';

/*
 * Inspection is synchronous CPU work, so its 30 s budget cannot interrupt it: a super-linear detector lets one
 * crafted upload, note or email block a worker. Each input here is 1,000,000 chars; before the fix several
 * single-token shapes took seconds at 16,000 chars and would have taken hours at this size.
 */
const SIZE = 1_000_000;
const BUDGET_MS = 5_000;

const fill = (unit: string, prefix = '', suffix = ''): string =>
  prefix + unit.repeat(Math.ceil((SIZE - prefix.length - suffix.length) / unit.length)) + suffix;

const PROSE =
  'Hi Anna, the quarterly report is attached. Call me on +48 601 234 567 or write to jan@acme.test. ' +
  'The wifi password: Hunter2xyz! and your verification code is 482913. Reset at ' +
  'https://acme.test/reset?token=aB3dE5gH7jK9mN1pQ3sT5 and api_key = aB3dE5gH7jK9mN1pQ3sT5vW7. ' +
  'Card 4111 1111 1111 1111, sort code 12-34-56 account 12345678. Lunch on Friday? ';

const SHAPES: Record<string, string> = {
  'one letter': fill('x'),
  'base64-like': fill('QWxhZGRpbjpvcGVuIHNlc2FtZQ+/='),
  digits: fill('7'),
  'a1 repeated': fill('a1'),
  'long URL without spaces': fill('a/b?c=d&', 'https://example.com/'),
  'URL then dots': fill('.', 'https://x.example/', 'a'),
  'password then dots': fill('.', 'password: ', 'a'),
  'word separators': fill('._-'),
  'scheme-like words': fill('a.'),
  'repeated lexicon word': fill('code'),
  'repeated key word': fill('secret'),
  'JWT-like headers': fill('eyJ-'),
  'URL userinfo colons': fill(':', 'https://'),
  'mixed prose with values': fill(PROSE),
};

const POLICY: Policy = { selectedCategories: FILTER_CATEGORY_KEYS, rules: [] };
const deps = { classifier: createRecordedClassifier() };

const note = (bodyText: string): InspectionInput => ({
  kind: 'note',
  bodyText,
  headers: {},
  folders: [],
  ownAddresses: [],
});

describe('inspect: linear time on 1,000,000-char inputs', () => {
  for (const [name, text] of Object.entries(SHAPES)) {
    it(`${name} (normal and hub mode)`, { timeout: 60_000 }, async () => {
      expect(text.length).toBeGreaterThanOrEqual(SIZE);
      for (const contactMode of ['normal', 'hub_extraction'] as const) {
        const started = performance.now();
        const result =
          contactMode === 'normal'
            ? await inspect(note(text), POLICY, deps)
            : await inspect(note(text), POLICY, deps, { contactMode });
        const elapsed = performance.now() - started;
        expect(result.outcome).toBeDefined();
        expect(elapsed, `${contactMode}: ${Math.round(elapsed)} ms`).toBeLessThan(BUDGET_MS);
      }
    });
  }
});
