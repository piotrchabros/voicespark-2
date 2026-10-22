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
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
];

const BEARER = /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{16,})/dg;
const GENERIC_ASSIGNMENT =
  /(?<![\p{L}\p{N}])[\w.-]*(?:api[_-]?key|apikey|secret|token|access[_-]?key|private[_-]?key)[\w.-]*[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-+/=.]{20,})/dgiu;

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

export const detect: Detector = async (text) => {
  const spans: Span[] = [];

  for (const re of PROVIDER_PATTERNS) {
    for (const m of findAllMatches(re, text)) {
      spans.push({ start: m.index, end: m.index + m[0].length, category: 'api_keys_tokens' });
    }
  }

  for (const m of findAllMatches(BEARER, text)) {
    const s = groupSpan(m, 1, 'api_keys_tokens');
    if (s) spans.push(s);
  }

  for (const m of findAllMatches(GENERIC_ASSIGNMENT, text)) {
    // Query-string parameters are handled by the reset-links detector.
    if (m.index > 0 && /[?&]/.test(text[m.index - 1] ?? '')) continue;
    const value = m[1] ?? '';
    if (value.length < MIN_GENERIC_LENGTH || shannonEntropy(value) < MIN_ENTROPY) continue;
    const s = groupSpan(m, 1, 'api_keys_tokens');
    if (s) spans.push(s);
  }

  spans.push(...(await secretlintSpans(text)));
  return mergeSpans(spans);
};
