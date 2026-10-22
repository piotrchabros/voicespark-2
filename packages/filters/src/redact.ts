import {
  FILTER_CATEGORY_KEYS,
  labelFor,
  redactionToken,
  type FilterCategory,
  type Span,
} from './categories';

/** Number of redacted occurrences per category; absent keys mean zero. */
export type RedactionCounts = Partial<Record<FilterCategory, number>>;

const PRIORITY: ReadonlyMap<FilterCategory, number> = new Map(
  FILTER_CATEGORY_KEYS.map((key, index) => [key, index]),
);

const priority = (category: FilterCategory): number =>
  PRIORITY.get(category) ?? Number.MAX_SAFE_INTEGER;

/**
 * Sorts spans and merges overlapping ones across categories. A merged span takes the
 * higher-priority category, i.e. the one that comes first in the catalog. Empty spans are
 * dropped. Touching spans stay separate (each is its own redacted value).
 */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (priority(s.category) < priority(last.category)) last.category = s.category;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/**
 * Replaces every span of `text` with `[excluded: {label}]` and counts one redacted value per
 * merged span under its category. Spans are clamped to the text before merging.
 */
export function applyRedactions(
  text: string,
  spans: readonly Span[],
): { text: string; counts: RedactionCounts } {
  const clamped = spans.map((s) => ({
    ...s,
    start: Math.max(0, Math.min(text.length, s.start)),
    end: Math.max(0, Math.min(text.length, s.end)),
  }));
  const counts: RedactionCounts = {};
  let out = '';
  let cursor = 0;
  for (const s of mergeSpans(clamped)) {
    out += text.slice(cursor, s.start) + redactionToken(labelFor(s.category));
    cursor = s.end;
    counts[s.category] = (counts[s.category] ?? 0) + 1;
  }
  out += text.slice(cursor);
  return { text: out, counts };
}
