import type { FilteredText } from '../categories';

/**
 * The only cast to `FilteredText` in the package. It is module-private to `pipeline.ts` and
 * `document.ts` (not re-exported from the package index, and `internal/*` is not in the
 * package `exports` map), so other packages can only obtain a `FilteredText` from `inspect()`
 * or `buildDocument()` (constitution I).
 */
export function asFiltered(text: string): FilteredText {
  return text as FilteredText;
}
