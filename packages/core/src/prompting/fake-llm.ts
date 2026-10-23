import { createFakeLlm, LlmRefusedError, type LlmClient } from '@voicespark/integrations/anthropic';
import type { Dimension, DraftContentType } from '@voicespark/db';
import { stripNeutralizer } from './analysis';
import { isDocumentOutputSchema, type DocumentOutput } from './document-schema';
import { CONTENT_TYPE_LABEL, draftSchemaContentType, type DraftOutput } from './draft-schema';
import { profileSchemaDimensions, type ProfileOutput } from './profile-schema';

const SAMPLE_BLOCK = /<sample ref="(A[0-9]+)"[^>]*>([\s\S]*?)<\/sample>/g;
const EXCERPT_MAX_CHARS = 120;
const EXCERPT_COUNT = 3;
const BRIEF_LINE = /Brief: ([^\n]*)/;
/** Test hook: a brief line containing this marker makes the fake refuse. */
const REFUSE_MARKER = 'FAKE_LLM_REFUSE';

/** Test switches for document calls: a marker anywhere in the user prompt selects the matching failure. */
export const FAKE_DOC_MARKERS = {
  refuse: 'FAKE_DOC_REFUSE',
  noSummary: 'FAKE_DOC_NO_SUMMARY',
  emptyLists: 'FAKE_DOC_EMPTY_LISTS',
  fewExcerpts: 'FAKE_DOC_FEW_EXCERPTS',
  receivedQuote: 'FAKE_DOC_RECEIVED_QUOTE',
  missingAspect: 'FAKE_DOC_MISSING_ASPECT',
} as const;

const ANALYSIS_PROMPT_BLOCK = /<analysis_prompt[^>]*>([\s\S]*?)<\/analysis_prompt>/;
const ASPECT_LINE = /^\s*-\s+([^:\n]{1,80}):/gm;
const ITEM_BLOCK = /<item [^>]*>([\s\S]*?)<\/item>/;
const MAX_ASPECTS = 20;
const QUOTE_WORDS = 12;

/** Word-aligned prefix of the sample (<= EXCERPT_MAX_CHARS); a verbatim whitespace-normalized substring. */
function excerptOf(text: string): string {
  const words = text.trim().split(/\s+/);
  let out = words[0]!.slice(0, EXCERPT_MAX_CHARS);
  for (const word of words.slice(1)) {
    if (out.length + 1 + word.length > EXCERPT_MAX_CHARS) break;
    out += ` ${word}`;
  }
  return out;
}

function fakeValue(d: Dimension): number | string | string[] {
  switch (d.valueType) {
    case 'scale':
      return d.scale?.min ?? 1;
    case 'enum':
      return d.allowedValues?.[0] ?? 'Fake value';
    case 'text':
      return 'Fake value';
    case 'list':
      return ['fake'];
  }
}

function fakeProfile(dimensions: Dimension[], user: string): ProfileOutput {
  const samples = [...user.matchAll(SAMPLE_BLOCK)]
    .map((m) => ({ ref: m[1]!, text: m[2]! }))
    .filter((s) => s.text.trim() !== '');
  const [first] = samples;
  if (first === undefined) throw new Error('fake_llm_no_samples');
  const firstKey = dimensions[0]?.key;
  return {
    summary: 'Fake profile summary.',
    languages: [{ code: 'en', share: 1 }],
    dimensions: dimensions.map((d) => ({
      key: d.key,
      value: fakeValue(d),
      explanation: 'Fake explanation.',
      evidenceRefs: [first.ref],
    })),
    excerpts: Array.from({ length: EXCERPT_COUNT }, (_, i) => {
      const sample = samples[i % samples.length]!;
      return { text: excerptOf(sample.text), sampleRef: sample.ref, dimensionKeys: firstKey ? [firstKey] : [] };
    }),
    doList: ['Fake do.'],
    dontList: ['Fake dont.'],
  };
}

function slugify(name: string): string {
  let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(key)) key = `a_${key}`;
  return key.slice(0, 41);
}

/** One aspect per `- Name:` line of the analysis prompt block; a single `voice` aspect when there is none. */
function fakeAspects(user: string): { key: string; name: string }[] {
  const block = ANALYSIS_PROMPT_BLOCK.exec(stripNeutralizer(user))?.[1] ?? '';
  const aspects: { key: string; name: string }[] = [];
  const used = new Set<string>();
  for (const m of block.matchAll(ASPECT_LINE)) {
    if (aspects.length >= MAX_ASPECTS) break;
    const name = m[1]!.trim();
    const base = slugify(name);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 41 - `_${n}`.length)}_${n}`;
    used.add(key);
    aspects.push({ key, name });
  }
  return aspects.length > 0 ? aspects : [{ key: 'voice', name: 'Voice' }];
}

function fakeDocument(user: string): DocumentOutput {
  const has = (marker: string) => user.includes(marker);
  if (has(FAKE_DOC_MARKERS.refuse)) throw new LlmRefusedError();
  const aspects = fakeAspects(user);
  const samples = [...user.matchAll(SAMPLE_BLOCK)]
    .map((m) => ({ ref: m[1]!, text: m[2]! }))
    .filter((s) => s.text.trim() !== '');
  if (samples.length === 0) throw new Error('fake_llm_no_samples');
  const firstKey = aspects[0]!.key;
  let sections = aspects.map((a) => ({
    aspectKey: a.key,
    heading: a.name,
    markdown: `Fake description of ${a.name}.`,
  }));
  if (has(FAKE_DOC_MARKERS.missingAspect)) sections = sections.slice(0, -1);
  let summary = 'Fake document summary.';
  if (has(FAKE_DOC_MARKERS.noSummary)) summary = '';
  if (has(FAKE_DOC_MARKERS.receivedQuote)) {
    const item = ITEM_BLOCK.exec(stripNeutralizer(user))?.[1] ?? '';
    summary = item.trim().split(/\s+/).slice(0, QUOTE_WORDS).join(' ');
  }
  const emptyLists = has(FAKE_DOC_MARKERS.emptyLists);
  const fewExcerpts = has(FAKE_DOC_MARKERS.fewExcerpts);
  return {
    aspects,
    summary,
    sections,
    doList: emptyLists ? [''] : ['Fake do.'],
    dontList: emptyLists ? [''] : ['Fake dont.'],
    excerpts: Array.from({ length: EXCERPT_COUNT }, (_, i) => {
      const sample = samples[i % samples.length]!;
      return {
        text: fewExcerpts ? `not in any sample ${i + 1}` : excerptOf(stripNeutralizer(sample.text)),
        sampleRef: sample.ref,
        aspectKeys: [firstKey],
      };
    }),
    languages: [{ code: 'en', share: 1 }],
  };
}

/** Echoes the `Brief: ` line of the user prompt; cites `[M1]` when a memory block was supplied. */
function fakeDraft(contentType: DraftContentType, user: string): DraftOutput {
  const brief = BRIEF_LINE.exec(user)?.[1] ?? '';
  if (brief.includes(REFUSE_MARKER)) throw new LlmRefusedError();
  const memory = user.includes('<memory ref="M1">') ? ' [M1]' : '';
  return {
    title: contentType === 'short_article' ? 'Fake title' : null,
    body: `Fake ${CONTENT_TYPE_LABEL[contentType]} draft. ${brief}${memory}`,
    notes: null,
  };
}

/**
 * Deterministic generation LLM for tests: answers profile and document schemas from the `<sample>` blocks in the user prompt and
 * draft schemas from its `Brief: ` line; the output is validated against the caller's schema by `createFakeLlm`.
 */
export function createFakeGenerationLlm(): LlmClient {
  return createFakeLlm((args) => {
    const dimensions = profileSchemaDimensions(args.schema);
    if (dimensions !== undefined) return fakeProfile(dimensions, args.user);
    if (isDocumentOutputSchema(args.schema)) return fakeDocument(args.user);
    const contentType = draftSchemaContentType(args.schema);
    if (contentType !== undefined) return fakeDraft(contentType, args.user);
    throw new Error('fake_llm_unsupported');
  });
}
