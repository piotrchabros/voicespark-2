import type { Detector, Span } from '../categories';
import { ninoValid, peselValid, ssnValid, steuerIdValid } from './checksums';

export const DETECTOR_CHECKSUM = 'government-ids@1';

/** SSN written with dashes or spaces (unanchored). */
const SSN_SEPARATED = /(?<![\d-])\d{3}([- ])\d{2}\1\d{4}(?![\d-])/g;
/** Plain 9-digit SSN, only right after an SSN keyword. */
const SSN_ANCHORED = /\b(?:SSN|social security(?: number| no\.?)?)[^\d\n]{0,20}(\d{9})(?!\d)/gi;
const NINO = /(?<![A-Za-z0-9])[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/g;
/** 11 digits, plain (PESEL, Steuer-ID) or grouped 2-3-3-3 (Steuer-ID). */
const ELEVEN_DIGITS = /(?<![\d-])(?:\d{11}|\d{2} \d{3} \d{3} \d{3})(?![\d-])/g;

/**
 * Keyword-anchored document numbers: Polish ID card and passport, plus generic
 * "passport|ID number|dowód" anchors. The value must contain a digit.
 */
const ANCHORED_DOCUMENT =
  /(?:\bpassport|\bpaszport|\breisepass|\bpasseport|\bpasaporte|\bID[ -]?(?:number|no\.?|nr)|\bidentity card|\bID card|\bdowód|\bdowodu|\bpersonalausweis|\bausweisnummer|\bcarte d'identité)[^\d\n]{0,30}?(?<![A-Za-z0-9])((?=[A-Za-z]{0,4}\d)[A-Za-z]{0,4}\d[A-Za-z0-9]{4,11})(?![A-Za-z0-9])/gi;

function span(start: number, value: string): Span {
  return { start, end: start + value.length, category: 'government_ids' };
}

/** Synchronous core of `detect`, for callers that cannot await (contact-value validation). */
export const detectSync = (text: string): Span[] => {
  const spans: Span[] = [];

  for (const m of text.matchAll(SSN_SEPARATED)) {
    if (ssnValid(m[0])) spans.push(span(m.index, m[0]));
  }
  for (const m of text.matchAll(SSN_ANCHORED)) {
    const value = m[1]!;
    if (ssnValid(value)) spans.push(span(m.index + m[0].lastIndexOf(value), value));
  }
  for (const m of text.matchAll(NINO)) {
    if (ninoValid(m[0])) spans.push(span(m.index, m[0]));
  }
  for (const m of text.matchAll(ELEVEN_DIGITS)) {
    const plain = !m[0].includes(' ');
    if ((plain && peselValid(m[0])) || steuerIdValid(m[0])) spans.push(span(m.index, m[0]));
  }
  for (const m of text.matchAll(ANCHORED_DOCUMENT)) {
    const value = m[1]!;
    spans.push(span(m.index + m[0].lastIndexOf(value), value));
  }

  return dedupe(spans);
};

export const detect: Detector = async (text) => detectSync(text);

function dedupe(spans: Span[]): Span[] {
  const seen = new Set<string>();
  return spans
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((s) => {
      const key = `${s.start}:${s.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
