import { franc } from 'franc';
import { parseFromAddress } from './address';
import {
  CLASSIFIER_CATEGORIES,
  FILTER_CATEGORY_KEYS,
  LOCKED_CATEGORIES,
  type CategoryCount,
  type ClassifierCategory,
  type CountCategory,
  type DetectorContext,
  type FilterCategory,
  type InspectionInput,
  type InspectionResult,
  type LockedCategory,
  type Policy,
  type Span,
} from './categories';
import type { Classifier, ClassifierOutput } from './classifier';
import { scoreCredentialDelivery } from './credential-delivery';
import { detectAll, LOCKED_DETECTORS } from './detectors';
import { asFiltered } from './internal/brand';
import { applyRedactions, type RedactionCounts } from './redact';
import { matchRules } from './rules';

export interface InspectDeps {
  classifier: Classifier;
  /** Budget for the whole inspection; exceeding it fails closed. Default 30 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REGION = 'PL';

/** ISO 639-3 (franc) to 639-1 for the languages the product cares about; others keep the 639-3 code. */
const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  eng: 'en',
  pol: 'pl',
  deu: 'de',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  nld: 'nl',
  por: 'pt',
};

/** Redaction tokens as they appear in filtered text, and what the post-check sees instead. */
const REDACTION_TOKEN = /\[excluded: [^\]]*\]/g;
const PLACEHOLDER = '[redacted]';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The inspected texts: body plus the header fields, each filtered with the same policy. */
type PartKey = 'body' | 'subject' | 'title' | 'filename' | 'fromName' | 'fromAddress';
type Parts = Partial<Record<PartKey, string>> & { body: string };
const PART_KEYS: readonly PartKey[] = ['subject', 'title', 'filename', 'fromName', 'fromAddress', 'body'];

/** Thrown internally when the whole item must be excluded; carries only the reason key. */
class Excluded extends Error {
  constructor(readonly category: CountCategory) {
    super('excluded');
    this.name = 'Excluded';
  }
}

function excludedResult(category: CountCategory): InspectionResult {
  return { outcome: 'excluded', counts: [{ category, redactedValues: 0, wholeItem: true }] };
}

function addCounts(total: Map<FilterCategory, number>, counts: RedactionCounts): void {
  for (const [category, n] of Object.entries(counts) as [FilterCategory, number][]) {
    total.set(category, (total.get(category) ?? 0) + n);
  }
}

function definedParts(parts: Parts): [PartKey, string][] {
  return PART_KEYS.flatMap((key) => {
    const text = parts[key];
    return text === undefined ? [] : [[key, text] as [PartKey, string]];
  });
}

/**
 * Every non-overlapping occurrence of `needle` in `text` as a span of `category`. The match is
 * exact apart from letter case, so a span the model copied with a different capitalisation
 * ("my asthma" for "My asthma") still covers every occurrence.
 */
function occurrences(text: string, needle: string, category: FilterCategory): Span[] {
  const re = new RegExp(escapeRegExp(needle), 'giu');
  const spans: Span[] = [];
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    spans.push({ start: m.index, end: m.index + m[0].length, category });
  }
  return spans;
}

/** Category held by most spans; ties go to catalog order; none gives `special_category`. */
function dominantCategory(output: ClassifierOutput): ClassifierCategory {
  const tally = new Map<ClassifierCategory, number>();
  for (const span of output.spans) tally.set(span.category, (tally.get(span.category) ?? 0) + 1);
  let best: ClassifierCategory = 'special_category';
  let bestCount = 0;
  for (const category of CLASSIFIER_CATEGORIES) {
    const n = tally.get(category) ?? 0;
    if (n > bestCount) {
      best = category;
      bestCount = n;
    }
  }
  return best;
}

function languageHint(text: string): string | undefined {
  const code = franc(text);
  if (code === 'und') return undefined;
  return LANGUAGE_CODES[code] ?? code;
}

/**
 * Replaces every redaction token with a neutral placeholder and returns the placeholder
 * positions. Tokens carry no content but contain lexicon words ("codes", "Passwords"), so left
 * in place they would anchor detectors on the benign text around them.
 */
function neutraliseTokens(text: string): { text: string; masked: Array<[number, number]> } {
  const masked: Array<[number, number]> = [];
  let out = '';
  let cursor = 0;
  for (const m of text.matchAll(REDACTION_TOKEN)) {
    out += text.slice(cursor, m.index);
    masked.push([out.length, out.length + PLACEHOLDER.length]);
    out += PLACEHOLDER;
    cursor = m.index + m[0].length;
  }
  out += text.slice(cursor);
  return { text: out, masked };
}

/**
 * Re-runs the locked-category detectors on filtered text and returns the first locked category
 * (catalog order) that still hits, or null. A hit that overlaps a redaction token is not a leak:
 * the anchor ("password:") stays in the text by design and its value is already gone, so the
 * detector matches the placeholder standing in for the token. Any hit on content is a leak.
 */
export async function postCheck(
  text: string,
  ctx: DetectorContext = { ownAddresses: [] },
): Promise<LockedCategory | null> {
  const neutral = neutraliseTokens(text);
  const onToken = (s: Span) => neutral.masked.some(([start, end]) => s.start < end && s.end > start);
  for (const category of LOCKED_CATEGORIES) {
    const spans = await LOCKED_DETECTORS[category](neutral.text, ctx);
    if (spans.some((s) => !onToken(s))) return category;
  }
  return null;
}

async function run(input: InspectionInput, policy: Policy, classifier: Classifier): Promise<InspectionResult> {
  // Stage 1: user exclusion rules.
  if (matchRules(input, policy.rules).matched) throw new Excluded('user_rule');

  // Stage 2: deterministic credential-delivery score over the whole message.
  const delivery = scoreCredentialDelivery({
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    bodyText: input.bodyText,
    ...(input.headers.from !== undefined ? { from: input.headers.from } : {}),
  });
  if (delivery.excluded) throw new Excluded(delivery.category ?? 'otp_codes');

  // Locked categories are forced on; unknown keys in the policy are ignored.
  const selected = new Set<string>(policy.selectedCategories);
  const categories = FILTER_CATEGORY_KEYS.filter(
    (c) => (LOCKED_CATEGORIES as readonly string[]).includes(c) || selected.has(c),
  );
  const classifierCategories = CLASSIFIER_CATEGORIES.filter((c) => selected.has(c));
  const dropFromAddress = selected.has('third_party_contacts');
  const ctx: DetectorContext = { ownAddresses: input.ownAddresses, defaultRegion: DEFAULT_REGION };

  const sender = parseFromAddress(input.headers.from);
  const parts: Parts = { body: input.bodyText };
  if (input.subject !== undefined) parts.subject = input.subject;
  if (input.title !== undefined) parts.title = input.title;
  if (input.filename !== undefined) parts.filename = input.filename;
  if (sender.name !== undefined) parts.fromName = sender.name;
  // When third_party_contacts is selected the header address is dropped, not redacted (not counted).
  if (sender.address !== undefined && !dropFromAddress) parts.fromAddress = sender.address;

  const totals = new Map<FilterCategory, number>();

  // Stage 3: deterministic span redaction on the body and every header field.
  await Promise.all(
    definedParts(parts).map(async ([key, text]) => {
      const spans = await detectAll(text, categories, ctx);
      const redacted = applyRedactions(text, spans);
      parts[key] = redacted.text;
      addCounts(totals, redacted.counts);
    }),
  );

  // Stage 4: classifier on the stage-3 text (credentials already gone), one call per item.
  if (classifierCategories.length > 0) {
    const stage3 = definedParts(parts).filter(([key]) => key !== 'fromAddress');
    const output = await classifier.classify(stage3.map(([, text]) => text).join('\n\n'), {
      categories: classifierCategories,
    });
    if (output.mostlySensitive) throw new Excluded(dominantCategory(output));

    // Locate every span before redacting anything, so overlapping spans cannot hide each other.
    const located = new Map<PartKey, Span[]>();
    for (const span of output.spans) {
      let found = false;
      if (span.text.trim() !== '') {
        for (const [key, text] of stage3) {
          const spans = occurrences(text, span.text, span.category);
          if (spans.length === 0) continue;
          found = true;
          located.set(key, [...(located.get(key) ?? []), ...spans]);
        }
      }
      if (!found) throw new Excluded(span.category);
    }
    for (const [key, spans] of located) {
      const redacted = applyRedactions(parts[key] ?? '', spans);
      parts[key] = redacted.text;
      addCounts(totals, redacted.counts);
    }
  }

  // Stage 5: post-check; any locked hit on the final text excludes the item.
  for (const [, text] of definedParts(parts)) {
    const hit = await postCheck(text, ctx);
    if (hit) throw new Excluded(hit);
  }

  const counts: CategoryCount[] = FILTER_CATEGORY_KEYS.flatMap((category) => {
    const n = totals.get(category) ?? 0;
    return n > 0 ? [{ category, redactedValues: n, wholeItem: false }] : [];
  });
  const fields: NonNullable<InspectionResult['fields']> = {};
  if (parts.subject !== undefined) fields.subject = asFiltered(parts.subject);
  if (parts.fromName !== undefined) fields.fromName = asFiltered(parts.fromName);
  if (parts.fromAddress !== undefined) fields.fromAddress = asFiltered(parts.fromAddress);
  if (parts.title !== undefined) fields.title = asFiltered(parts.title);
  if (parts.filename !== undefined) fields.filename = asFiltered(parts.filename);
  const hint = languageHint(parts.body);

  return {
    outcome: 'accepted',
    text: asFiltered(parts.body),
    fields,
    counts,
    ...(hint !== undefined ? { languageHint: hint } : {}),
  };
}

/**
 * Runs the inspection stages (research R8) over the body and the header fields with the same
 * policy. Fails closed: any error or a run longer than `timeoutMs` yields `inspection_failed`.
 * The result carries counts only, never matched values.
 */
export async function inspect(
  input: InspectionInput,
  policy: Policy,
  deps: InspectDeps,
): Promise<InspectionResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('inspection timed out')), timeoutMs);
  });
  try {
    return await Promise.race([run(input, policy, deps.classifier), timeout]);
  } catch (err) {
    // Error details are dropped deliberately: they may echo document content.
    return excludedResult(err instanceof Excluded ? err.category : 'inspection_failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
