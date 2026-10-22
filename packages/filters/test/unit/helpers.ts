import type { DetectorContext, Span } from '../../src/categories';

/** True when every character of the first occurrence of `value` lies inside some span. */
export function covers(text: string, spans: Span[], value: string): boolean {
  const start = text.indexOf(value);
  if (start < 0) throw new Error(`value not found in text: ${value}`);
  for (let i = start; i < start + value.length; i++) {
    if (!spans.some((s) => s.start <= i && i < s.end)) return false;
  }
  return true;
}

/** Text of each span, in span order. */
export function coveredText(text: string, spans: Span[]): string[] {
  return spans.map((s) => text.slice(s.start, s.end));
}

export function ctx(over: Partial<DetectorContext> = {}): DetectorContext {
  return { ownAddresses: ['me@voicespark.test'], defaultRegion: 'PL', ...over };
}
