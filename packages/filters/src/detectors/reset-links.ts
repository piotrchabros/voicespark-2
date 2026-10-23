import type { Detector, Span } from '../categories';
import { findAllMatches, mergeSpans, shannonEntropy } from './util';

export const DETECTOR_CHECKSUM = 'reset-links@1';

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}>]+$/;

const SENSITIVE_PATH =
  /(?:^|[/_.-])(?:reset|recover|verif|confirm|magic|login|signin|sign-in|activate|unsubscribe-token)/i;
const TOKEN_PARAM = /^(?:[\w.]*[_-])?(?:token|code|key|sig|signature|otp|auth|t)$/i;

const MIN_ENTROPY = 3.5;
const MIN_LENGTH = 16;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isSensitive(url: string): boolean {
  const afterScheme = url.slice(url.indexOf('//') + 2);
  const pathStart = afterScheme.search(/[/?#]/);
  if (pathStart < 0) return false;
  const rest = afterScheme.slice(pathStart);
  const q = rest.indexOf('?');
  const hashAt = rest.indexOf('#');
  const pathEnd = [q, hashAt].filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), rest.length);
  if (SENSITIVE_PATH.test(rest.slice(0, pathEnd))) return true;

  // Query string and fragment parameters (fragments carry tokens in some flows).
  const params = rest.slice(pathEnd).replace(/^[?#]/, '').split(/[&?#]/);
  for (const p of params) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const name = safeDecode(p.slice(0, eq));
    const value = safeDecode(p.slice(eq + 1));
    if (
      TOKEN_PARAM.test(name) &&
      value.length >= MIN_LENGTH &&
      shannonEntropy(value) >= MIN_ENTROPY
    )
      return true;
  }
  return false;
}

/** Synchronous core of `detect`, for callers that cannot await (contact-value validation). */
export const detectSync = (text: string): Span[] => {
  const spans: Span[] = [];
  for (const m of findAllMatches(URL_RE, text)) {
    const url = m[0].replace(TRAILING_PUNCT, '');
    if (isSensitive(url)) {
      spans.push({
        start: m.index,
        end: m.index + url.length,
        category: 'reset_verification_links',
      });
    }
  }
  return mergeSpans(spans);
};

export const detect: Detector = async (text) => detectSync(text);
