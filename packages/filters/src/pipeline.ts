import { franc } from 'franc';
import { parseFromAddress } from './address';
import {
  CLASSIFIER_CATEGORIES,
  FILTER_CATEGORY_KEYS,
  LOCKED_CATEGORIES,
  type CategoryCount,
  type ClassifierCategory,
  type ContactMode,
  type CountCategory,
  type DetectorContext,
  type FilterCategory,
  type HubLlmText,
  type InspectionInput,
  type InspectionResult,
  type LockedCategory,
  type Policy,
  type Span,
} from './categories';
import type { Classifier, ClassifierOutput } from './classifier';
import { scoreCredentialDelivery } from './credential-delivery';
import { detectAll, LOCKED_DETECTORS } from './detectors';
import { asFiltered, asHubLlmText } from './internal/brand';
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

interface FilterTextsOptions {
  categories: readonly FilterCategory[];
  classifierCategories: readonly ClassifierCategory[];
  ctx: DetectorContext;
  classifier: Classifier;
  /** Per text: whether it goes to the classifier (the From address does not). */
  classify: readonly boolean[];
  /** Joins the classified texts into the one classifier call. */
  separator: string;
  /** Extra stage-3 spans per text (hub mode: URL userinfo). */
  extraSpans?: (text: string) => Span[];
}

/**
 * Stages 3 to 5 over texts that share one policy. Detectors run per text, so no span crosses a text
 * boundary. Classifier spans are located per text, so a span that crosses a boundary is not found and
 * excludes the item (fail closed). Throws `Excluded`.
 */
async function filterTexts(
  texts: readonly string[],
  opts: FilterTextsOptions,
): Promise<{ texts: string[]; totals: Map<FilterCategory, number> }> {
  const out = [...texts];
  const totals = new Map<FilterCategory, number>();

  // Stage 3: deterministic span redaction on every text.
  await Promise.all(
    out.map(async (text, i) => {
      const spans = await detectAll(text, opts.categories, opts.ctx);
      if (opts.extraSpans) spans.push(...opts.extraSpans(text));
      const redacted = applyRedactions(text, spans);
      out[i] = redacted.text;
      addCounts(totals, redacted.counts);
    }),
  );

  // Stage 4: classifier on the stage-3 text (credentials already gone), one call per item.
  if (opts.classifierCategories.length > 0) {
    const stage3 = out.flatMap((text, i) => (opts.classify[i] ? [[i, text] as [number, string]] : []));
    const output = await opts.classifier.classify(stage3.map(([, text]) => text).join(opts.separator), {
      categories: opts.classifierCategories,
    });
    if (output.mostlySensitive) throw new Excluded(dominantCategory(output));

    // Locate every span before redacting anything, so overlapping spans cannot hide each other.
    const located = new Map<number, Span[]>();
    for (const span of output.spans) {
      let found = false;
      if (span.text.trim() !== '') {
        for (const [i, text] of stage3) {
          const spans = occurrences(text, span.text, span.category);
          if (spans.length === 0) continue;
          found = true;
          located.set(i, [...(located.get(i) ?? []), ...spans]);
        }
      }
      if (!found) throw new Excluded(span.category);
    }
    for (const [i, spans] of located) {
      const redacted = applyRedactions(out[i] ?? '', spans);
      out[i] = redacted.text;
      addCounts(totals, redacted.counts);
    }
  }

  // Stage 5: post-check; any locked hit on the final text excludes the item.
  for (const text of out) {
    const hit = await postCheck(text, opts.ctx);
    if (hit) throw new Excluded(hit);
  }

  return { texts: out, totals };
}

/**
 * The whole userinfo of a URL that carries `user:pass@`. The passwords detector needs a user part without
 * `@`; in normal mode the contacts detector covers `https://jan@acme.example:secret@host` as an email, but
 * hub mode skips that detector, so the userinfo is redacted here as a password instead.
 */
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#]*:[^\s/?#]*)@[^\s/?#@]+/giu;

function urlUserinfoSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(URL_USERINFO)) {
    const start = m.index + m[0].indexOf('://') + 3;
    spans.push({ start, end: start + (m[1] ?? '').length, category: 'passwords' });
  }
  return spans;
}

function countsOf(totals: Map<FilterCategory, number>): CategoryCount[] {
  return FILTER_CATEGORY_KEYS.flatMap((category) => {
    const n = totals.get(category) ?? 0;
    return n > 0 ? [{ category, redactedValues: n, wholeItem: false }] : [];
  });
}

/** Locked categories are forced on; unknown keys in the policy are ignored. */
function policyCategories(selected: ReadonlySet<string>): FilterCategory[] {
  return FILTER_CATEGORY_KEYS.filter((c) => (LOCKED_CATEGORIES as readonly string[]).includes(c) || selected.has(c));
}

/** Header fields of an accepted item; unbranded until `inspect()` brands them by contact mode. */
type FieldKey = Exclude<PartKey, 'body'>;

interface RawResult {
  body: string;
  fields: Partial<Record<FieldKey, string>>;
  counts: CategoryCount[];
  languageHint?: string;
}

async function run(
  input: InspectionInput,
  policy: Policy,
  classifier: Classifier,
  contactMode: ContactMode,
): Promise<RawResult> {
  // Stage 1: user exclusion rules.
  if (matchRules(input, policy.rules).matched) throw new Excluded('user_rule');

  // Stage 2: deterministic credential-delivery score over the whole message.
  const delivery = scoreCredentialDelivery({
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    bodyText: input.bodyText,
    ...(input.headers.from !== undefined ? { from: input.headers.from } : {}),
  });
  if (delivery.excluded) throw new Excluded(delivery.category ?? 'otp_codes');

  const selected = new Set<string>(policy.selectedCategories);
  // Hub mode skips only the deterministic contacts detector (emails, phones) and keeps the From address;
  // the classifier's postal-address sense of third_party_contacts stays.
  const hub = contactMode === 'hub_extraction';
  const categories = policyCategories(selected).filter((c) => !(hub && c === 'third_party_contacts'));
  const classifierCategories = CLASSIFIER_CATEGORIES.filter((c) => selected.has(c));
  const dropFromAddress = selected.has('third_party_contacts') && !hub;
  const ctx: DetectorContext = { ownAddresses: input.ownAddresses, defaultRegion: DEFAULT_REGION };

  const sender = parseFromAddress(input.headers.from);
  const parts: Parts = { body: input.bodyText };
  if (input.subject !== undefined) parts.subject = input.subject;
  if (input.title !== undefined) parts.title = input.title;
  if (input.filename !== undefined) parts.filename = input.filename;
  if (sender.name !== undefined) parts.fromName = sender.name;
  // When third_party_contacts is selected the header address is dropped, not redacted (not counted).
  if (sender.address !== undefined && !dropFromAddress) parts.fromAddress = sender.address;

  const entries = definedParts(parts);
  const filtered = await filterTexts(
    entries.map(([, text]) => text),
    {
      categories,
      classifierCategories,
      ctx,
      classifier,
      classify: entries.map(([key]) => key !== 'fromAddress'),
      separator: '\n\n',
      ...(hub ? { extraSpans: urlUserinfoSpans } : {}),
    },
  );
  entries.forEach(([key], i) => {
    parts[key] = filtered.texts[i] ?? '';
  });

  const fields: RawResult['fields'] = {};
  for (const key of ['subject', 'fromName', 'fromAddress', 'title', 'filename'] as const) {
    const text = parts[key];
    if (text !== undefined) fields[key] = text;
  }
  const hint = languageHint(parts.body);

  return {
    body: parts.body,
    fields,
    counts: countsOf(filtered.totals),
    ...(hint !== undefined ? { languageHint: hint } : {}),
  };
}

/**
 * Runs `work` under the inspection budget. Fails closed: any error or a run longer than `timeoutMs`
 * yields `inspection_failed`; an `Excluded` yields its category.
 */
async function guarded<T>(
  work: () => Promise<T>,
  deps: InspectDeps,
  excluded: (category: CountCategory) => T,
): Promise<T> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('inspection timed out')), timeoutMs);
  });
  try {
    return await Promise.race([work(), timeout]);
  } catch (err) {
    // Error details are dropped deliberately: they may echo document content.
    return excluded(err instanceof Excluded ? err.category : 'inspection_failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface InspectOptions {
  /** Default `normal`. `hub_extraction` is used only through `inspectForHubExtraction` (hub.ts). */
  contactMode?: ContactMode;
}

/** A hub-mode result: the same shape, but the kept texts carry the `HubLlmText` brand, never `FilteredText`. */
export type HubModeInspectionResult = Omit<InspectionResult, 'text' | 'fields'> & {
  text?: HubLlmText;
  fields?: Partial<Record<FieldKey, HubLlmText>>;
};

function branded<T extends string>(raw: RawResult, brand: (text: string) => T) {
  const fields: Partial<Record<FieldKey, T>> = {};
  for (const [key, text] of Object.entries(raw.fields) as [FieldKey, string][]) fields[key] = brand(text);
  return {
    outcome: 'accepted' as const,
    text: brand(raw.body),
    fields,
    counts: raw.counts,
    ...(raw.languageHint !== undefined ? { languageHint: raw.languageHint } : {}),
  };
}

/**
 * Runs the inspection stages (research R8) over the body and the header fields with the same
 * policy. Fails closed: any error or a run longer than `timeoutMs` yields `inspection_failed`.
 * The result carries counts only, never matched values. With `contactMode: 'hub_extraction'` the
 * contacts detector is skipped, the From address is kept and the texts are `HubLlmText`. The normal
 * overload is declared last so `ReturnType<typeof inspect>` stays `Promise<InspectionResult>`.
 */
export function inspect(
  input: InspectionInput,
  policy: Policy,
  deps: InspectDeps,
  options: { contactMode: 'hub_extraction' },
): Promise<HubModeInspectionResult>;
export function inspect(
  input: InspectionInput,
  policy: Policy,
  deps: InspectDeps,
  options?: InspectOptions & { contactMode?: 'normal' },
): Promise<InspectionResult>;
export async function inspect(
  input: InspectionInput,
  policy: Policy,
  deps: InspectDeps,
  options: InspectOptions = {},
): Promise<InspectionResult | HubModeInspectionResult> {
  const contactMode = options.contactMode ?? 'normal';
  return guarded<InspectionResult | HubModeInspectionResult>(
    async () => {
      const raw = await run(input, policy, deps.classifier, contactMode);
      return contactMode === 'hub_extraction' ? branded(raw, asHubLlmText) : branded(raw, asFiltered);
    },
    deps,
    excludedResult,
  );
}

export type TextsResult =
  | { outcome: 'accepted'; texts: string[]; counts: CategoryCount[] }
  | { outcome: 'excluded'; category: CountCategory };

/**
 * Package-internal (not exported from the index): the full user policy over a list of texts in one
 * pass, for `inspectSegments`. Rules and the credential-delivery score see the texts joined by
 * `separator`; detectors run per text; the classifier gets one call over the joined texts and its
 * spans are located per text. Whole-item exclusion applies to the call. Fails closed like `inspect`.
 */
export async function inspectTexts(
  texts: readonly string[],
  policy: Policy,
  deps: InspectDeps,
  separator: string,
): Promise<TextsResult> {
  return guarded<TextsResult>(
    async () => {
      const joined = texts.join(separator);
      const input: InspectionInput = { kind: 'note', bodyText: joined, headers: {}, folders: [], ownAddresses: [] };
      if (matchRules(input, policy.rules).matched) throw new Excluded('user_rule');
      const delivery = scoreCredentialDelivery({ bodyText: joined });
      if (delivery.excluded) throw new Excluded(delivery.category ?? 'otp_codes');

      const selected = new Set<string>(policy.selectedCategories);
      const filtered = await filterTexts(texts, {
        categories: policyCategories(selected),
        classifierCategories: CLASSIFIER_CATEGORIES.filter((c) => selected.has(c)),
        ctx: { ownAddresses: [], defaultRegion: DEFAULT_REGION },
        classifier: deps.classifier,
        classify: texts.map(() => true),
        separator,
      });
      return { outcome: 'accepted', texts: filtered.texts, counts: countsOf(filtered.totals) };
    },
    deps,
    (category) => ({ outcome: 'excluded', category }),
  );
}
