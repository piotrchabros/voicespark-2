import type { Detector, Span } from '../categories';
import { findAllMatches, mergeSpans } from './util';

export const DETECTOR_CHECKSUM = 'otp-codes@1';

const WINDOW = 60;

// Lexicon words, matched inside a surrounding letter run so "Bestätigungscode" and "kodu" both hit.
const LEXICON = new RegExp(
  String.raw`[\p{L}\p{N}]*(?:code|codes|kod|kody|kodu|otp|2fa|mfa|tan|pin|verif\p{L}*|bestätigung\p{L}*|weryfik\p{L}*|passcode|token|código|codigo|autoryzac\p{L}*|authentif\p{L}*)(?![\p{L}\p{N}])`,
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
const BACKUP_HEADER =
  /(?:backup|recovery|reserve|zapasow|odzyskiwan|ersatz|sicherung|wiederherstellung|secours|récupération|respaldo|recuperaci)\p{L}*[^\n]*(?:code|kod|code|código|codigo)|(?:code|kod|código|codigo)\p{L}*\s+(?:zapasow|de secours|de respaldo|de recuperaci)/iu;
const CODE_LINE =
  /^[ \t]*(?:[-*•]|\d{1,2}[.)])?[ \t]*([A-Za-z0-9]{4,12}(?:-[A-Za-z0-9]{3,12}){0,2})[ \t]*$/;
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

export const detect: Detector = async (text) => {
  const spans: Span[] = [];
  const hits = lexiconHits(text);

  if (hits.length > 0) {
    for (const c of findAllMatches(CANDIDATE, text)) {
      const start = c.index;
      const end = start + c[0].length;
      const overlapsLexicon = hits.some((h) => start < h.end && end > h.start);
      if (overlapsLexicon) continue;
      const near = hits.some((h) => (h.end <= start ? start - h.end : h.start - end) <= WINDOW);
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
    if (!BACKUP_HEADER.test(header)) continue;
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
