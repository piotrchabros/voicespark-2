import { describe, expect, it } from 'vitest';
import { FILTER_CATEGORY_KEYS, type Policy } from '../../src/categories';
import { createRecordedClassifier } from '../../src/classifier/recorded';
import { inspectSegments } from '../../src/hub';

const ALL: Policy = { selectedCategories: FILTER_CATEGORY_KEYS, rules: [] };
const deps = { classifier: createRecordedClassifier() };

async function ok(segments: string[], policy: Policy = ALL, d: Parameters<typeof inspectSegments>[2] = deps) {
  const r = await inspectSegments(segments, policy, d);
  if (r.excluded) throw new Error(`unexpected exclusion: ${r.category}`);
  return r;
}

describe('inspectSegments', () => {
  it('returns one result per segment under the full policy (contacts redacted)', async () => {
    const r = await ok(['Plain title', 'Mail jan@acme.example', 'token: ghp_8hJuQoN86WVSTAZKtlDIlSNJuELijmlyWdyU']);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]).toBe('Plain title');
    expect(r.segments[1]).not.toContain('jan@acme.example');
    expect(r.segments[2]).not.toContain('ghp_8hJuQoN86WVSTAZKtlDIlSNJuELijmlyWdyU');
    expect(r.redactedValues).toBe(2);
  });

  it('joins segments with a separator no detector spans', async () => {
    const seen: string[] = [];
    const classifier = {
      classify: async (text: string) => {
        seen.push(text);
        return { spans: [], mostlySensitive: false };
      },
    };
    await ok(['first', 'second', 'third'], ALL, { classifier });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('first\n \nsecond\n \nthird');
  });

  it('does not let a detector span a boundary', async () => {
    // "password:" at the end of one segment must not take the next segment as its value.
    const r = await ok(['my password:', 'Xk9mQ2vLp7']);
    expect(r.segments[0]).toBe('my password:');
    expect(r.segments[1]).toBe('Xk9mQ2vLp7');
  });

  it('maps a classifier span back to the right segment', async () => {
    const classifier = createRecordedClassifier({
      spans: [{ category: 'health', text: 'diabetes' }],
      mostlySensitive: false,
    });
    const r = await ok(['Meeting on Monday', 'He has diabetes', 'Invoice 42'], ALL, { classifier });
    expect(r.segments[0]).toBe('Meeting on Monday');
    expect(r.segments[1]).not.toContain('diabetes');
    expect(r.segments[2]).toBe('Invoice 42');
  });

  it('handles a classifier span that crosses a boundary', async () => {
    const classifier = createRecordedClassifier({
      spans: [{ category: 'health', text: 'diabetes\n \nand asthma' }],
      mostlySensitive: false,
    });
    const r = await inspectSegments(['He has diabetes', 'and asthma', 'Invoice 42'], ALL, { classifier });
    // Either both segments are redacted or the call fails closed; the text must never survive.
    if (r.excluded) {
      expect(['health', 'inspection_failed']).toContain(r.category);
    } else {
      expect(r.segments).toHaveLength(3);
      expect(r.segments.join(' ')).not.toMatch(/diabetes|asthma/);
      expect(r.segments[2]).toBe('Invoice 42');
    }
  });

  it('lets a segment come back empty after redaction', async () => {
    const r = await ok(['ok', 'jan@acme.example']);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[1].replace(/\[excluded: [^\]]*\]/g, '').trim()).toBe('');
  });

  it('returns a whole-item exclusion for the call', async () => {
    const r = await inspectSegments(
      ['fine', 'secret stuff'],
      { selectedCategories: [], rules: [{ type: 'keyword', value: 'secret' }] },
      deps,
    );
    expect(r).toEqual({ excluded: true, category: 'user_rule' });
  });

  it('fails closed when the classifier throws', async () => {
    const classifier = {
      classify: async () => {
        throw new Error('boom');
      },
    };
    const r = await inspectSegments(['a', 'b'], ALL, { classifier });
    expect(r).toEqual({ excluded: true, category: 'inspection_failed' });
  });

  it('inspects link hrefs and note text nodes as segments', async () => {
    const r = await ok([
      'Release notes',
      'https://accounts.acme.example/reset-password?token=GGXXvg2SRXJUCkKIUDrEZ00BDS4kpD4O',
      'call +48 601 234 567',
    ]);
    expect(r.segments[1]).not.toContain('GGXXvg2SRXJUCkKIUDrEZ00BDS4kpD4O');
    expect(r.segments[2]).not.toContain('601 234 567');
    expect(r.redactedValues).toBe(2);
  });

  it('counts redacted values across all segments', async () => {
    const r = await ok(['jan@acme.example', 'anna@acme.example', '+48 601 234 567', 'clean']);
    expect(r.redactedValues).toBe(3);
  });
});
