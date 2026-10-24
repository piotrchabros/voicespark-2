import type { Detector, Span } from '../categories';
import { findAllMatches, mergeSpans } from './util';

export const DETECTOR_CHECKSUM = 'otp-codes@1';

const WINDOW = 60;

// Lexicon words, matched inside a surrounding letter run so "Bestätigungscode" and "kodu" both hit.
// The lookbehind starts a match only at the start of a letter run: a match from inside a run implies one
// from its start, so this changes no result, but without it a long run is rescanned from every position
// (quadratic time on one long token).
const LEXICON = new RegExp(
  String.raw`(?<![\p{L}\p{N}])[\p{L}\p{N}]*(?:code|codes|kod|kody|kodu|otp|2fa|mfa|tan|pin|verif\p{L}*|bestätigung\p{L}*|weryfik\p{L}*|passcode|token|código|codigo|autoryzac\p{L}*|authentif\p{L}*)(?![\p{L}\p{N}])`,
  'giu',
);
// Prefixes that make "code" a different thing (postcode, barcode, ...).
const NOT_OTP_PREFIX =
  /(?:zip|post|area|country|bar|qr|dress|source|promo|discount|coupon|voucher|dial|bank|sort|branch|swift|color|colour|html|hex|unicode|de|en|pro|ge|mor|dec|trans|ency|ic|ci|ex|xcode)$/i;
const NOT_OTP_PREV_WORD =
  /(?:zip|post|postal|area|country|dress|source|promo|discount|coupon|voucher|dial|sort|branch|bank|colou?r|html|hex|street|tax|product|item|order|tracking|reference|invoice)\s*$/i;

// Candidates: 4-8 digits, 3+3 digits with a space or dash, or 6-10 mixed alphanumerics (digit and letter both present).
const CANDIDATE =
  /(?<![\p{L}\p{N}_.\-@/])(?:\d{4,8}|\d{3}[ -]\d{3}|(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,10})(?![\p{L}\p{N}_@/]|[.,]\d)/gu;

// Backup / recovery code lists: header line followed by code-shaped lines.
// Same test as /BACKUP_WORD\p{L}*[^\n]*CODE_WORD|CODE_WORD\p{L}*\s+(?:zapasow|...)/iu, in linear time: that regex
// rescans the rest of the line from every backup word, and the rest of the letter run from every code word.
const BACKUP_WORD =
  /backup|recovery|reserve|zapasow|odzyskiwan|ersatz|sicherung|wiederherstellung|secours|récupération|respaldo|recuperaci/iu;
const CODE_WORD = /code|kod|código|codigo/iu;
// A whole letter run (taken atomically, once per run) that contains a code word, then the trailing phrase.
const CODE_THEN_BACKUP =
  /(?<!\p{L})(?=(\p{L}*))\1(?<=(?:code|kod|código|codigo)\p{L}*)\s+(?:zapasow|de secours|de respaldo|de recuperaci)/iu;

function isBackupHeader(line: string): boolean {
  const word = BACKUP_WORD.exec(line);
  if (word && CODE_WORD.test(line.slice(word.index + word[0].length))) return true;
  return CODE_THEN_BACKUP.test(line);
}
// The blanks after the bullet belong to the optional bullet group, so two adjacent `[ \t]*` cannot split a
// long run of blanks between them (quadratic backtracking).
const CODE_LINE =
  /^[ \t]*(?:(?:[-*•]|\d{1,2}[.)])[ \t]*)?([A-Za-z0-9]{4,12}(?:-[A-Za-z0-9]{3,12}){0,2})[ \t]*$/;
const MAX_LIST = 40;

function lexiconHits(text: string): Array<{ start: number; end: number }> {
  const hits: Array<{ start: number; end: number }> = [];
  for (const m of findAllMatches(LEXICON, text)) {
    const word = m[0];
    const start = m.index;
    const lower = word.toLowerCase();
    // Reject "postcode", "barcode", "decode" style words and "zip code" style phrases.
    const core = /(code|codes|kod|kody|kodu)$/.exec(lower);
    if (
      core &&
      lower.length > core[0].length &&
      NOT_OTP_PREFIX.test(lower.slice(0, lower.length - core[0].length))
    )
      continue;
    if (
      NOT_OTP_PREV_WORD.test(text.slice(Math.max(0, start - 20), start)) &&
      /^(?:code|codes|kod|pin)$/i.test(word)
    )
      continue;
    // Bare "tan" / "pin" are words in many languages; only accept them in upper case ("TAN", "PIN").
    if (/^(?:tan|pin)$/i.test(word) && word !== word.toUpperCase()) continue;
    hits.push({ start, end: start + word.length });
  }
  return hits;
}

/** Index of the first hit with `end > pos` (hits sorted and disjoint), or `hits.length`. */
function firstHitEndingAfter(hits: ReadonlyArray<{ start: number; end: number }>, pos: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (hits[mid]!.end > pos) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Synchronous core of `detect`, for callers that cannot await (contact-value validation). */
export const detectSync = (text: string): Span[] => {
  const spans: Span[] = [];
  const hits = lexiconHits(text);

  if (hits.length > 0) {
    for (const c of findAllMatches(CANDIDATE, text)) {
      const start = c.index;
      const end = start + c[0].length;
      // Hits are sorted and disjoint, so only the hits either side of the candidate can overlap or be nearest.
      const i = firstHitEndingAfter(hits, start);
      const after = hits[i];
      const before = hits[i - 1];
      if (after && after.start < end) continue; // overlaps a lexicon word
      const near =
        (before !== undefined && start - before.end <= WINDOW) ||
        (after !== undefined && after.start - end <= WINDOW);
      if (near) spans.push({ start, end, category: 'otp_codes' });
    }
  }

  // Backup-code lists: every code-shaped line after a header that mentions backup/recovery codes.
  const lines = text.split('\n');
  let offset = 0;
  const starts: number[] = [];
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i] ?? '';
    if (!isBackupHeader(header)) continue;
    let taken = 0;
    for (let j = i + 1; j < lines.length && taken < MAX_LIST; j++) {
      const line = (lines[j] ?? '').replace(/\r$/, '');
      if (line.trim() === '') {
        if (taken === 0 && j === i + 1) continue; // tolerate one blank line after the header
        break;
      }
      const m = CODE_LINE.exec(line);
      if (!m || !/\d/.test(m[1] ?? '')) break;
      const valueStart = (starts[j] ?? 0) + line.indexOf(m[1] ?? '');
      spans.push({
        start: valueStart,
        end: valueStart + (m[1] ?? '').length,
        category: 'otp_codes',
      });
      taken++;
    }
  }

  return mergeSpans(spans);
};

export const detect: Detector = async (text) => detectSync(text);
