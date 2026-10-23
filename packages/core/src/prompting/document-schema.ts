import { z } from 'zod';
import type { ContentKind, Dimension, ProfileRating, ProfileVersionOrigin } from '@voicespark/db';
import { stripNeutralizer } from './analysis';
import type { ProfileBody } from './profile-schema';

/** One call plus one retry carrying the post-validation problem codes. */
export const MAX_LLM_CALLS = 2;

export const DOCUMENT_LIMITS = {
  aspectsMin: 1,
  aspectsMax: 20,
  aspectNameMax: 80,
  summaryMax: 1200,
  sectionsMax: 20,
  headingMax: 120,
  markdownMax: 4000,
  listMin: 1,
  listMax: 10,
  listItemMax: 200,
  excerptsMin: 3,
  excerptsMax: 12,
  excerptTextMax: 300,
} as const;

export const ASPECT_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;

const SAMPLE_REF = /^A[0-9]+$/;
const SHINGLE_WORDS = 8;

/** Persisted in profile_version.body_enc when format = 'document'. */
export interface VoiceDocument {
  aspects: { key: string; name: string }[];
  summary: string;
  sections: { aspectKey: string; heading: string; markdown: string }[];
  doList: string[];
  dontList: string[];
  /** `contentItemId` is mapped server-side, never from the model; null once the source is deleted. */
  excerpts: {
    text: string;
    sampleRef: string;
    contentItemId: string | null;
    aspectKeys: string[];
  }[];
  languages: { code: string; share: number }[];
}

/** What the model returns: the document without `contentItemId`. */
export interface DocumentOutput {
  aspects: VoiceDocument['aspects'];
  summary: string;
  sections: VoiceDocument['sections'];
  doList: string[];
  dontList: string[];
  excerpts: { text: string; sampleRef: string; aspectKeys: string[] }[];
  languages: VoiceDocument['languages'];
}

export type VersionBodyView =
  { format: 'structured'; body: ProfileBody } | { format: 'document'; body: VoiceDocument };

export interface ExcerptSource {
  kind: ContentKind;
  /** YYYY-MM-DD */
  itemDate: string;
  sourceLabels: string[];
}

export interface VersionView {
  id: string;
  versionNumber: number;
  origin: ProfileVersionOrigin;
  createdAt: string;
  rating: ProfileRating | null;
  format: 'structured' | 'document';
  body: ProfileBody | VoiceDocument;
  promptSource: 'default' | 'own' | null;
  analysisPrompt:
    | { kind: 'default'; definitionVersion: { id: string; versionNumber: number } }
    | { kind: 'own'; ownVersion: { id: string; versionNumber: number } }
    | null;
  /** Key = contentItemId; null = source deleted. */
  excerptSources: Record<string, ExcerptSource | null>;
}

// Lets the fake generation LLM recognise document schema calls.
const documentSchemas = new WeakSet<object>();

/** Contract "Output schema": one strict schema for every definition, independent of the prompt. */
export function buildDocumentOutputSchema(): z.ZodType<DocumentOutput> {
  const L = DOCUMENT_LIMITS;
  const list = z.array(z.string().max(L.listItemMax)).min(L.listMin).max(L.listMax);
  const schema = z.strictObject({
    aspects: z
      .array(
        z.strictObject({
          key: z.string().regex(ASPECT_KEY_RE),
          name: z.string().max(L.aspectNameMax),
        }),
      )
      .min(L.aspectsMin)
      .max(L.aspectsMax),
    summary: z.string().max(L.summaryMax),
    sections: z
      .array(
        z.strictObject({
          aspectKey: z.string(),
          heading: z.string().max(L.headingMax),
          markdown: z.string().max(L.markdownMax),
        }),
      )
      .max(L.sectionsMax),
    doList: list,
    dontList: list,
    excerpts: z
      .array(
        z.strictObject({
          text: z.string().max(L.excerptTextMax),
          sampleRef: z.string().regex(SAMPLE_REF),
          aspectKeys: z.array(z.string()),
        }),
      )
      .min(L.excerptsMin)
      .max(L.excerptsMax),
    languages: z.array(z.strictObject({ code: z.string(), share: z.number() })),
  }) as z.ZodType<DocumentOutput>;
  documentSchemas.add(schema);
  return schema;
}

export function isDocumentOutputSchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && documentSchemas.has(schema);
}

function normalizeWs(s: string): string {
  return stripNeutralizer(s).replace(/\s+/g, ' ').trim();
}

function words(s: string): string[] {
  return stripNeutralizer(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((w) => w !== '');
}

function shingles(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const w = words(t);
    for (let i = 0; i + SHINGLE_WORDS <= w.length; i++)
      out.add(w.slice(i, i + SHINGLE_WORDS).join(' '));
  }
  return out;
}

/** True when an 8-word run of any text appears in the received context and in no authored sample. */
export function receivedOverlap(texts: string[], received: string[], authored: string[]): boolean {
  const fromReceived = shingles(received);
  if (fromReceived.size === 0) return false;
  const fromAuthored = shingles(authored);
  for (const s of shingles(texts)) {
    if (fromReceived.has(s) && !fromAuthored.has(s)) return true;
  }
  return false;
}

export interface PostValidateInput {
  samples: { ref: string; text: string }[];
  received: string[];
}

export interface PostValidateResult {
  ok: boolean;
  problems: string[];
  cleaned: DocumentOutput;
}

/**
 * Contract "Post-validation": one section per declared aspect, non-empty summary and do / don't lists, at least 3
 * excerpts that are whitespace-normalised verbatim substrings of their `A{n}` sample (U+200B stripped), and no
 * 8-word run of received context unless an authored sample has it too. `excerpt_dropped:{i}` is informational.
 */
export function postValidateDocument(
  output: DocumentOutput,
  input: PostValidateInput,
): PostValidateResult {
  const problems: string[] = [];
  const declared = new Set(output.aspects.map((a) => a.key));
  let duplicate = declared.size !== output.aspects.length;
  let unknown = false;
  const missing: string[] = [];
  for (const key of declared) {
    const count = output.sections.filter((s) => s.aspectKey === key).length;
    if (count === 0) missing.push(`aspect_missing:${key}`);
    if (count > 1) duplicate = true;
  }
  if (output.sections.some((s) => !declared.has(s.aspectKey))) unknown = true;
  problems.push(...missing);
  if (duplicate) problems.push('aspect_duplicate');
  if (unknown) problems.push('section_unknown');

  const doList = output.doList.filter((x) => x.trim() !== '');
  const dontList = output.dontList.filter((x) => x.trim() !== '');
  if (output.summary.trim() === '') problems.push('summary_missing');
  if (doList.length === 0) problems.push('do_list_empty');
  if (dontList.length === 0) problems.push('dont_list_empty');

  const byRef = new Map(input.samples.map((s) => [s.ref, normalizeWs(s.text)]));
  const excerpts: DocumentOutput['excerpts'] = [];
  output.excerpts.forEach((x, i) => {
    const sample = SAMPLE_REF.test(x.sampleRef) ? byRef.get(x.sampleRef) : undefined;
    const text = normalizeWs(x.text);
    if (sample === undefined || text === '' || !sample.includes(text)) {
      problems.push(`excerpt_dropped:${i}`);
      return;
    }
    excerpts.push({
      text: x.text,
      sampleRef: x.sampleRef,
      aspectKeys: x.aspectKeys.filter((k) => declared.has(k)),
    });
  });
  if (excerpts.length < DOCUMENT_LIMITS.excerptsMin) problems.push('too_few_excerpts');

  const checked = [
    output.summary,
    ...output.sections.map((s) => s.markdown),
    ...doList,
    ...dontList,
  ];
  if (
    receivedOverlap(
      checked,
      input.received,
      input.samples.map((s) => s.text),
    )
  )
    problems.push('received_quote');

  return {
    ok: problems.every((p) => p.startsWith('excerpt_dropped:')),
    problems,
    cleaned: { ...output, doList, dontList, excerpts },
  };
}

/** Maps each `A{n}` ref to its content item server-side; an unknown ref maps to null. */
export function mapExcerptsToItems(
  output: DocumentOutput,
  samples: { ref: string; contentItemId: string }[],
): VoiceDocument {
  const byRef = new Map(samples.map((s) => [s.ref, s.contentItemId]));
  return {
    aspects: output.aspects,
    summary: output.summary,
    sections: output.sections,
    doList: output.doList,
    dontList: output.dontList,
    excerpts: output.excerpts.map((x) => ({
      text: x.text,
      sampleRef: x.sampleRef,
      contentItemId: byRef.get(x.sampleRef) ?? null,
      aspectKeys: x.aspectKeys,
    })),
    languages: output.languages,
  };
}

function formatValue(v: number | string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

/** Shows a legacy 001 `ProfileBody` as a document: one aspect and section per dimension. */
export function structuredToDocument(
  body: ProfileBody,
  dimensions: Pick<Dimension, 'key' | 'name'>[] = [],
): VoiceDocument {
  const nameOf = (key: string) => dimensions.find((d) => d.key === key)?.name ?? key;
  return {
    aspects: body.dimensions.map((d) => ({ key: d.key, name: nameOf(d.key) })),
    summary: body.summary,
    sections: body.dimensions.map((d) => ({
      aspectKey: d.key,
      heading: nameOf(d.key),
      markdown: formatValue(d.value) + (d.explanation ? `\n\n${d.explanation}` : ''),
    })),
    doList: body.doList,
    dontList: body.dontList,
    excerpts: body.excerpts.map((e) => ({
      text: e.text,
      sampleRef: e.sampleRef,
      contentItemId: e.contentItemId,
      aspectKeys: e.dimensionKeys,
    })),
    languages: body.languages,
  };
}

/** Plain markdown export of a document; empty lists are left out. */
export function documentToMarkdown(
  doc: Pick<VoiceDocument, 'summary' | 'sections' | 'doList' | 'dontList' | 'excerpts'>,
): string {
  const list = (heading: string, items: string[]) =>
    items.length === 0 ? [] : [`### ${heading}\n\n${items.map((i) => `- ${i}`).join('\n')}`];
  return [
    doc.summary,
    ...doc.sections.map((s) => `### ${s.heading}\n\n${s.markdown}`),
    ...list('Do', doc.doList),
    ...list("Don't", doc.dontList),
    ...list(
      'Excerpts',
      doc.excerpts.map((e) => `"${e.text}"`),
    ),
  ].join('\n\n');
}

/** Document JSON as shown to the model (`previousProfileJson`, `profileJson`): no server-side `contentItemId`. */
export function toPromptDocumentJson(doc: VoiceDocument): string {
  const output: DocumentOutput = {
    ...doc,
    excerpts: doc.excerpts.map(({ text, sampleRef, aspectKeys }) => ({
      text,
      sampleRef,
      aspectKeys,
    })),
  };
  return JSON.stringify(output);
}

/** Document JSON for draft prompts: only what shapes the writing, no refs or ids. */
export function toDraftDocumentJson(doc: VoiceDocument): string {
  return JSON.stringify({
    format: 'document',
    summary: doc.summary,
    sections: doc.sections.map(({ heading, markdown }) => ({ heading, markdown })),
    doList: doc.doList,
    dontList: doc.dontList,
    excerpts: doc.excerpts.map(({ text }) => ({ text })),
    languages: doc.languages,
  });
}
