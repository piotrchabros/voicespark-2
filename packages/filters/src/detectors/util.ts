import type { FilterCategory, Span } from '../categories';

/** Shannon entropy of `s` in bits per character (0 for the empty string). */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let total = 0;
  let h = 0;
  for (const n of freq.values()) total += n;
  for (const n of freq.values()) {
    const p = n / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/** All matches of `re` in `text`, regardless of the regex's own `g` flag; never loops on empty matches. */
export function findAllMatches(re: RegExp, text: string): RegExpExecArray[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    out.push(m);
    if (m[0].length === 0) global.lastIndex++;
  }
  return out;
}

/** Sorts spans and merges overlapping or touching ones of the same category. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.category === s.category && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Span for capture group `group` of match `m`; requires the regex to have the `d` flag. */
export function groupSpan(
  m: RegExpExecArray,
  group: number,
  category: FilterCategory,
): Span | null {
  const indices = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> })
    .indices;
  const range = indices?.[group];
  if (!range || range[1] <= range[0]) return null;
  return { start: range[0], end: range[1], category };
}
