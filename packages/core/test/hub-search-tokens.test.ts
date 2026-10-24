import { describe, expect, it } from 'vitest';
import { hmacHex } from '../src/crypto';
import {
  buildSnippets,
  indexTokens,
  queryTokens,
  rankResults,
  tokenize,
  verifyCandidate,
} from '../src/hub/search-tokens';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const h = (userId: string, s: string) => hmacHex(`hubsearch:${userId}:${s}`).slice(0, 16);

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';

describe('tokenize', () => {
  it('lower-cases and splits on non letters/digits', () => {
    expect(tokenize('Hello, World! 42-x')).toEqual(['hello', 'world', '42', 'x']);
  });

  it('keeps Polish letters', () => {
    expect(tokenize('Zażółć GĘŚLĄ jaźń')).toEqual(['zażółć', 'gęślą', 'jaźń']);
  });

  it('cuts tokens to 32 chars', () => {
    expect(tokenize('a'.repeat(40))).toEqual(['a'.repeat(32)]);
  });

  it('returns nothing for punctuation only', () => {
    expect(tokenize('-- ... !!')).toEqual([]);
  });
});

describe('indexTokens', () => {
  it('emits prefixes of length 2..len and nothing for 1-char tokens', () => {
    expect(new Set(indexTokens(U1, ['abc x']))).toEqual(new Set(['ab', 'abc'].map((s) => h(U1, s))));
  });

  it('caps prefixes at 15 and adds the full token when longer', () => {
    const word = 'abcdefghijklmnopqrst'; // 20 chars
    const out = new Set(indexTokens(U1, [word]));
    const expected = new Set<string>();
    for (let n = 2; n <= 15; n++) expected.add(h(U1, word.slice(0, n)));
    expected.add(h(U1, word));
    expect(out).toEqual(expected);
    expect(out.has(h(U1, word.slice(0, 16)))).toBe(false);
  });

  it('cuts the full token to 32 chars', () => {
    const out = indexTokens(U1, ['b'.repeat(40)]);
    expect(out).toContain(h(U1, 'b'.repeat(32)));
    expect(out).not.toContain(h(U1, 'b'.repeat(40)));
  });

  it('hashes to 16 hex chars and deduplicates across texts', () => {
    const out = indexTokens(U1, ['Alpha alpha', 'ALPHA']);
    expect(out.every((t) => /^[0-9a-f]{16}$/.test(t))).toBe(true);
    expect(out.length).toBe(new Set(out).size);
    expect(out.length).toBe(4); // al, alp, alph, alpha
  });

  it('indexes Polish letters and digits', () => {
    const out = new Set(indexTokens(U1, ['Łódź 2024']));
    expect(out.has(h(U1, 'łó'))).toBe(true);
    expect(out.has(h(U1, 'łódź'))).toBe(true);
    expect(out.has(h(U1, '20'))).toBe(true);
    expect(out.has(h(U1, '2024'))).toBe(true);
  });

  it('hashes the same word differently for two users', () => {
    const a = new Set(indexTokens(U1, ['sekret']));
    const b = indexTokens(U2, ['sekret']);
    expect(b.some((t) => a.has(t))).toBe(false);
  });
});

describe('queryTokens', () => {
  it('ignores tokens shorter than 2 and returns empty when none remain', () => {
    expect(queryTokens(U1, 'a - 1 !').hashes).toEqual([]);
    expect(queryTokens(U1, 'a - 1 !').terms).toEqual([]);
  });

  it('hashes the prefix form, cut to 15 chars', () => {
    const q = queryTokens(U1, 'Abcdefghijklmnopqrst');
    expect(q.terms).toEqual(['abcdefghijklmno']);
    expect(q.hashes).toEqual([h(U1, 'abcdefghijklmno')]);
  });

  it('keeps at most 32 tokens', () => {
    const q = queryTokens(U1, Array.from({ length: 50 }, (_, i) => `word${i}`).join(' '));
    expect(q.terms).toHaveLength(32);
    expect(q.hashes).toHaveLength(32);
  });

  it('matches index tokens of a longer word by prefix', () => {
    const idx = new Set(indexTokens(U1, ['Kowalski']));
    expect(queryTokens(U1, 'kowal').hashes.every((x) => idx.has(x))).toBe(true);
  });
});

describe('verifyCandidate', () => {
  it('requires every term to prefix a real token', () => {
    expect(verifyCandidate(['kowal', 'ann'], 'Anna Kowalski')).toBe(true);
    expect(verifyCandidate(['kowal', 'zzz'], 'Anna Kowalski')).toBe(false);
  });

  it('does not match mid-word', () => {
    expect(verifyCandidate(['walski'], 'Kowalski')).toBe(false);
  });

  it('matches long terms (cut to 15) against longer words', () => {
    expect(verifyCandidate(['abcdefghijklmno'], 'abcdefghijklmnopqrst')).toBe(true);
  });

  it('is case-insensitive and Polish-aware', () => {
    expect(verifyCandidate(['łódź'], 'Miasto ŁÓDŹ')).toBe(true);
  });
});

describe('rankResults', () => {
  const d = (s: string) => new Date(s);
  it('puts title hits first, then matched-term count, then newest', () => {
    const items = [
      { id: 'body-new', title: 'Other', updatedAt: d('2026-03-01') },
      { id: 'title-1-old', title: 'Anna notes', updatedAt: d('2026-01-01') },
      { id: 'title-2', title: 'Anna Kowalski', updatedAt: d('2026-01-01') },
      { id: 'title-1-new', title: 'Anna things', updatedAt: d('2026-02-01') },
    ];
    const out = rankResults(items, ['anna', 'kowal']).map((x) => x.id);
    expect(out).toEqual(['title-2', 'title-1-new', 'title-1-old', 'body-new']);
  });

  it('does not mutate its input', () => {
    const items = [
      { id: 'a', title: 'x', updatedAt: d('2026-01-01') },
      { id: 'b', title: 'x', updatedAt: d('2026-02-01') },
    ];
    rankResults(items, ['zz']);
    expect(items.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('buildSnippets', () => {
  const filler = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');

  it('returns no more than 2 fragments of about 20 words', () => {
    const text = `${filler(60, 'a')} needle ${filler(60, 'b')} needle ${filler(60, 'c')} needle`;
    const out = buildSnippets(['needle'], [text]);
    expect(out).toHaveLength(2);
    for (const s of out) expect(s.text.split(/\s+/).length).toBeLessThanOrEqual(24);
  });

  it('gives UTF-16 highlight offsets into the fragment text', () => {
    const out = buildSnippets(['kowal'], ['😀 Anna Kowalski wrote']);
    expect(out).toHaveLength(1);
    const { text, highlights } = out[0]!;
    expect(highlights).toHaveLength(1);
    const [s, e] = highlights[0]!;
    expect(text.slice(s, e)).toBe('Kowal');
  });

  it('highlights multiple terms in one fragment', () => {
    const { text, highlights } = buildSnippets(['anna', 'wrote'], ['Anna Kowalski wrote'])[0]!;
    expect(highlights.map(([s, e]) => text.slice(s, e))).toEqual(['Anna', 'wrote']);
  });

  it('returns plain text without HTML markup added', () => {
    const out = buildSnippets(['anna'], ['Anna said hi']);
    expect(out[0]!.text).toBe('Anna said hi');
    expect(JSON.stringify(out)).not.toMatch(/<mark>|<\/mark>/);
  });

  it('returns nothing when no text matches', () => {
    expect(buildSnippets(['zzz'], ['Anna said hi'])).toEqual([]);
  });
});
