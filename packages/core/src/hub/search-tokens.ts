import { hmacHex } from '../crypto';

/**
 * Blind token index for hub search (contracts/hub-search.md). Content stays encrypted; the database
 * holds only truncated keyed hashes of word prefixes.
 */

const MAX_TOKEN = 32;
const MAX_PREFIX = 15;
const MIN_PREFIX = 2;
const MAX_QUERY_TOKENS = 32;
const MAX_SNIPPETS = 2;
const SNIPPET_WORDS = 20;
const WORD_RE = /[\p{L}\p{N}]+/gu;

export type Highlight = [number, number];
export interface Snippet {
  text: string;
  /** UTF-16 offsets into `text`. */
  highlights: Highlight[];
}

/** Lower-case words, each cut to 32 chars. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).map((t) => t.slice(0, MAX_TOKEN));
}

function hashToken(userId: string, s: string): string {
  return hmacHex(`hubsearch:${userId}:${s}`).slice(0, 16);
}

/** Deduplicated hashes of every 2..15 char prefix of each token, plus the full token when longer than 15. */
export function indexTokens(userId: string, texts: string[]): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const add = (s: string) => {
    if (seen.has(s)) return;
    seen.add(s);
    out.add(hashToken(userId, s));
  };
  for (const text of texts) {
    for (const t of tokenize(text)) {
      const max = Math.min(t.length, MAX_PREFIX);
      for (let n = MIN_PREFIX; n <= max; n++) add(t.slice(0, n));
      if (t.length > MAX_PREFIX) add(t);
    }
  }
  return [...out];
}

/**
 * Query terms (plain, for `verifyCandidate`/`rankResults`/`buildSnippets`) and their hashes (for the
 * `tokens @>` candidate query). Max 32 terms, shorter than 2 ignored, cut to 15, deduplicated.
 */
export function queryTokens(userId: string, q: string): { terms: string[]; hashes: string[] } {
  const terms: string[] = [];
  for (const t of tokenize(q)) {
    if (t.length < MIN_PREFIX) continue;
    const term = t.slice(0, MAX_PREFIX);
    if (!terms.includes(term)) terms.push(term);
    if (terms.length >= MAX_QUERY_TOKENS) break;
  }
  return { terms, hashes: terms.map((t) => hashToken(userId, t)) };
}

function hasPrefixMatch(words: string[], term: string): boolean {
  return words.some((w) => w.startsWith(term));
}

/** Every term must be a prefix of at least one real token of the decrypted text (drops hash collisions). */
export function verifyCandidate(terms: string[], decryptedText: string): boolean {
  const words = tokenize(decryptedText);
  return terms.every((t) => hasPrefixMatch(words, t));
}

/** Title/name hit first, then number of terms matching the title, then `updatedAt` newest first. */
export function rankResults<T extends { title: string; updatedAt: Date | string | number }>(
  items: T[],
  terms: string[],
): T[] {
  const scored = items.map((item) => {
    const words = tokenize(item.title);
    const matched = terms.filter((t) => hasPrefixMatch(words, t)).length;
    return { item, matched, time: new Date(item.updatedAt).getTime() };
  });
  scored.sort((a, b) => Number(b.matched > 0) - Number(a.matched > 0) || b.matched - a.matched || b.time - a.time);
  return scored.map((s) => s.item);
}

/**
 * Up to 2 fragments of about 20 words around the first matches, taken from `texts` in order. No HTML;
 * highlight offsets are UTF-16 offsets into the fragment text.
 */
export function buildSnippets(terms: string[], texts: string[]): Snippet[] {
  const out: Snippet[] = [];
  for (const text of texts) {
    if (out.length >= MAX_SNIPPETS) break;
    const words = [...text.matchAll(WORD_RE)].map((m) => ({
      start: m.index!,
      end: m.index! + m[0].length,
      // length of the longest matching term, 0 when the word is not a hit (highlights cover the matched prefix)
      hit: Math.max(0, ...terms.filter((t) => m[0].toLowerCase().slice(0, MAX_TOKEN).startsWith(t)).map((t) => t.length)),
    }));
    let next = 0; // first word index not yet covered by a fragment
    for (let i = 0; i < words.length && out.length < MAX_SNIPPETS; i++) {
      if (words[i]!.hit === 0 || i < next) continue;
      const from = Math.max(next, i - Math.floor(SNIPPET_WORDS / 2));
      const to = Math.min(words.length, from + SNIPPET_WORDS);
      const start = from === 0 ? 0 : words[from]!.start;
      const end = to === words.length ? text.length : words[to - 1]!.end;
      const fragment = text.slice(start, end);
      const highlights: Highlight[] = words
        .slice(from, to)
        .filter((w) => w.hit > 0)
        .map((w) => [w.start - start, w.start - start + w.hit]);
      out.push({ text: fragment, highlights });
      next = to;
    }
  }
  return out;
}
