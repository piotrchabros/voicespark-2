import type { Detector, Span } from '../categories';
import { findAllMatches, groupSpan, mergeSpans } from './util';

export const DETECTOR_CHECKSUM = 'passwords@1';

const ANCHORS =
  'password|passcode|passphrase|pwd|hasło|haslo|passwort|mot de passe|contraseña|contrasena';
const COPULAS = 'is|to|jest|ist|lautet|est|es';
// Up to a few qualifier words ("temporary", "du disque partagé") may sit between the anchor and the separator.
// Then a separator (":" or "=") or a copula, optionally one line break, and the value up to whitespace.
const FILLER = String.raw`(?:[ \t]+[\p{L}'-]+)`;
const SEP = String.raw`(?:${FILLER}{0,4}[ \t]*[:=][ \t]*|${FILLER}{0,4}[ \t]+(?:${COPULAS})[ \t]*:?[ \t]*)`;
const VALUE = String.raw`(?:\r?\n[ \t]*)?(\S+)`;
const ANCHORED = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${ANCHORS})${SEP}${VALUE}`, 'giud');
// Bare "pass" is too common a word to accept a copula; require an explicit separator.
const BARE_PASS = new RegExp(String.raw`(?<![\p{L}\p{N}_])pass[ \t]*[:=][ \t]*(\S+)`, 'giud');
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/dgiu;

// Words that follow "password is ..." in prose rather than being a password.
const PROSE_WORDS = new Set([
  'required',
  'incorrect',
  'invalid',
  'wrong',
  'expired',
  'valid',
  'correct',
  'weak',
  'strong',
  'missing',
  'empty',
  'case-sensitive',
  'not',
  'the',
  'a',
  'an',
  'your',
  'now',
  'set',
  'changed',
  'reset',
  'updated',
  'secure',
  'safe',
  'wymagane',
  'niepoprawne',
  'ważne',
  'erforderlich',
  'ungültig',
  'requis',
  'invalide',
  'obligatoria',
  'and',
  'or',
  'must',
  'should',
  'will',
  'can',
  'has',
  'have',
  'was',
  'were',
  'be',
  'been',
  'being',
  'in',
  'on',
  'for',
  'to',
  'of',
]);

const LEADING_JUNK = /^["'`(<[]+/;
const TRAILING_JUNK = /[.,;)\]>"'`]+$/;

function trimmed(m: RegExpExecArray, requireNonProse: boolean): Span | null {
  const raw = groupSpan(m, 1, 'passwords');
  if (!raw) return null;
  const value = m[1] ?? '';
  const lead = LEADING_JUNK.exec(value)?.[0].length ?? 0;
  const core = value.slice(lead).replace(TRAILING_JUNK, '');
  if (core.length === 0) return null;
  if (requireNonProse && PROSE_WORDS.has(core.toLowerCase())) return null;
  return { start: raw.start + lead, end: raw.start + lead + core.length, category: 'passwords' };
}

/** Synchronous core of `detect`, for callers that cannot await (contact-value validation). */
export const detectSync = (text: string): Span[] => {
  const spans: Span[] = [];
  for (const m of findAllMatches(ANCHORED, text)) {
    // A bare separator is explicit enough; a copula needs the prose-word guard.
    const viaCopula = !/[:=]/.test(m[0].slice(0, m[0].length - (m[1]?.length ?? 0)));
    const s = trimmed(m, viaCopula);
    if (s) spans.push(s);
  }
  for (const m of findAllMatches(BARE_PASS, text)) {
    const s = trimmed(m, false);
    if (s) spans.push(s);
  }
  for (const m of findAllMatches(URL_CREDENTIALS, text)) {
    const s = groupSpan(m, 1, 'passwords');
    if (s) spans.push(s);
  }
  return mergeSpans(spans);
};

export const detect: Detector = async (text) => detectSync(text);
