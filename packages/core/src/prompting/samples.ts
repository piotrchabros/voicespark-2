/** Authored-sample budget for one profile generation: ~150k tokens at ~4 chars/token. */
export const SAMPLE_CHAR_BUDGET = 600_000;

/** Received items passed as background context (never quotable). */
export const RECEIVED_CONTEXT_LIMIT = 20;

const HEADER_LINE = /^(Subject|Date|Direction|From|Title): /;

/** Strips the `buildDocument` header block (Subject/Date/Direction/From/Title lines + blank line), if present. */
export function documentBody(content: string): string {
  const end = content.indexOf('\n\n');
  if (end === -1) return content;
  const lines = content.slice(0, end).split('\n');
  if (!lines.every((line) => HEADER_LINE.test(line))) return content;
  return content.slice(end + 2);
}

/** First whitespace-separated token of a display name, or ''. */
export function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? '';
}
