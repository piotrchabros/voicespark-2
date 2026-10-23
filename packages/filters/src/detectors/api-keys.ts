import { lintSource } from '@secretlint/core';
import { creator as presetRecommend } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintCoreConfig } from '@secretlint/types';
import type { Detector, Span } from '../categories';
import { findAllMatches, groupSpan, mergeSpans, shannonEntropy } from './util';

export const DETECTOR_CHECKSUM = 'api-keys@1';

const MIN_ENTROPY = 3.5;
const MIN_GENERIC_LENGTH = 20;

const SECRETLINT_CONFIG: SecretLintCoreConfig = {
  rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: presetRecommend }],
};

// Ported from gitleaks (provider-specific formats); each match is a whole secret.
const PROVIDER_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, // GitHub fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PAT
  /\bxox[abprso]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bxapp-\d-[A-Za-z0-9-]{10,}/g, // Slack app token
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, // OpenAI
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe secret / restricted keys
  /\bwhsec_[A-Za-z0-9]{24,}\b/g, // Stripe webhook secret
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm token
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, // SendGrid
  /\bSK[0-9a-f]{32}\b/g, // Twilio API key
  /\b[0-9a-f]{32}-us\d{1,2}\b/g, // Mailchimp
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, // private keys
];

/*
 * JWT, /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\/g. Searched from the ".eyJ" with the
 * header checked by a lookbehind (capture 1 is the header): the forward form is retried from every "eyJ"
 * of an "eyJ-eyJ-..." run and scans to the end of the run each time (quadratic time).
 */
const JWT = /\.eyJ(?<=(\beyJ[A-Za-z0-9_-]{5,})\.eyJ)[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/dg;

function jwtSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = new RegExp(JWT.source, JWT.flags);
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.indices?.[1]?.[0] ?? m.index;
    if (start < lastEnd) {
      // The forward regex never starts a match inside the previous one; retry from the next ".eyJ".
      re.lastIndex = m.index + 1;
      continue;
    }
    lastEnd = m.index + m[0].length;
    spans.push({ start, end: lastEnd, category: 'api_keys_tokens' });
  }
  return spans;
}

const BEARER = /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{16,})/dg;

/*
 * Generic `name = value` assignment, where the name holds a key word. As one regex,
 *   /(?<![\p{L}\p{N}])[\w.-]*(?:KEY_WORD)[\w.-]*[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-+/=.]{20,})/giu,
 * it is quadratic on one long token: it is retried from every position of a "._-._-..." run, and the two
 * `[\w.-]*` around the key word rescan a "secretsecret..." run once per key word. `genericAssignments`
 * finds the same matches in linear time. The name always ends where its `[\w.-]` run ends (the next
 * character must be a blank, ":" or "="), and the leftmost allowed start in a run gives the longest name,
 * so a run has a match exactly when its leftmost allowed start does.
 */
const NAME_RUN = /[\w.-]+/giu;
const KEY_WORD = /api[_-]?key|apikey|secret|token|access[_-]?key|private[_-]?key/iu;
const ASSIGNED_VALUE = /[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-+/=.]{20,})/iuy;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/** Whether the code point that ends just before `pos` is a letter or digit (the old lookbehind). */
function letterOrDigitBefore(text: string, pos: number): boolean {
  if (pos === 0) return false;
  const low = text.charCodeAt(pos - 1);
  const from = low >= 0xdc00 && low <= 0xdfff && pos >= 2 ? pos - 2 : pos - 1;
  return LETTER_OR_DIGIT.test(String.fromCodePoint(text.codePointAt(from)!));
}

interface Assignment {
  /** Start of the name, as `m.index` of the old regex. */
  index: number;
  value: string;
  valueStart: number;
}

function genericAssignments(text: string): Assignment[] {
  const out: Assignment[] = [];
  let resume = 0;
  for (const run of text.matchAll(NAME_RUN)) {
    const runEnd = run.index + run[0].length;
    if (runEnd <= resume) continue;
    let start = Math.max(run.index, resume);
    while (start < runEnd && letterOrDigitBefore(text, start)) start++;
    if (start >= runEnd || !KEY_WORD.test(text.slice(start, runEnd))) continue;
    ASSIGNED_VALUE.lastIndex = runEnd;
    const m = ASSIGNED_VALUE.exec(text);
    if (!m) continue;
    const value = m[1] ?? '';
    const matchEnd = runEnd + m[0].length;
    out.push({ index: start, value, valueStart: matchEnd - value.length });
    resume = matchEnd;
  }
  return out;
}

async function secretlintSpans(text: string): Promise<Span[]> {
  const result = await lintSource({
    source: { content: text, filePath: 'message.txt', contentType: 'text' },
    options: { config: SECRETLINT_CONFIG, noPhysicFilePath: true },
  });
  return (
    result.messages
      // Credentials embedded in a URL (user:pass@) belong to the passwords category.
      .filter((m) => m.range[1] > m.range[0] && !/basic-?auth/i.test(m.ruleId))
      .map((m) => ({ start: m.range[0], end: m.range[1], category: 'api_keys_tokens' as const }))
  );
}

/**
 * The pattern-based part of `detect` (no secretlint, which is async), for callers that cannot await
 * (contact-value validation).
 */
export const detectSync = (text: string): Span[] => {
  const spans: Span[] = [];

  for (const re of PROVIDER_PATTERNS) {
    for (const m of findAllMatches(re, text)) {
      spans.push({ start: m.index, end: m.index + m[0].length, category: 'api_keys_tokens' });
    }
  }

  spans.push(...jwtSpans(text));

  for (const m of findAllMatches(BEARER, text)) {
    const s = groupSpan(m, 1, 'api_keys_tokens');
    if (s) spans.push(s);
  }

  for (const m of genericAssignments(text)) {
    // Query-string parameters are handled by the reset-links detector.
    if (m.index > 0 && /[?&]/.test(text[m.index - 1] ?? '')) continue;
    const value = m.value;
    if (value.length < MIN_GENERIC_LENGTH || shannonEntropy(value) < MIN_ENTROPY) continue;
    spans.push({ start: m.valueStart, end: m.valueStart + value.length, category: 'api_keys_tokens' });
  }

  return mergeSpans(spans);
};

export const detect: Detector = async (text) => mergeSpans([...detectSync(text), ...(await secretlintSpans(text))]);
