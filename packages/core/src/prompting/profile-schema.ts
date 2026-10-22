import { z } from 'zod';
import type { Dimension, ToneDefinitionVersion } from '@voicespark/db';

export interface ProfileExcerpt {
  text: string;
  sampleRef: string;
  contentItemId: string;
  dimensionKeys: string[];
}

export interface ProfileBody {
  summary: string;
  languages: { code: string; share: number }[];
  dimensions: { key: string; value: number | string | string[]; explanation: string; evidenceRefs: string[] }[];
  excerpts: ProfileExcerpt[];
  doList: string[];
  dontList: string[];
}

/** What the model returns: excerpts carry only the `A{n}` ref; `contentItemId` is mapped server-side. */
export type ProfileOutput = Omit<ProfileBody, 'excerpts'> & { excerpts: Omit<ProfileExcerpt, 'contentItemId'>[] };

const SAMPLE_REF = /^A[0-9]+$/;

// Lets the fake generation LLM recover the dimensions a schema was built for.
const schemaDimensions = new WeakMap<object, Dimension[]>();

function dimensionValueSchema(d: Dimension): z.ZodType<number | string | string[]> {
  switch (d.valueType) {
    case 'scale':
      return d.scale ? z.number().min(d.scale.min).max(d.scale.max) : z.number();
    case 'enum': {
      const [first, ...rest] = d.allowedValues ?? [];
      return first === undefined ? z.string() : z.enum([first, ...rest]);
    }
    case 'text':
      return z.string().max(600);
    case 'list':
      return z.array(z.string().max(200)).max(20);
  }
}

function dimensionEntrySchema(d: Dimension) {
  return z.strictObject({
    key: z.literal(d.key),
    value: dimensionValueSchema(d),
    explanation: z.string().max(600),
    evidenceRefs: z.array(z.string().regex(SAMPLE_REF)),
  });
}

/** Contract "Profile output schema", built per pinned definition version with per-dimension typed `value`. */
export function buildProfileOutputSchema(dv: Pick<ToneDefinitionVersion, 'dimensions'>): z.ZodType<ProfileOutput> {
  const [first, ...rest] = dv.dimensions.map(dimensionEntrySchema);
  const dimensionEntry = first === undefined ? z.never() : z.discriminatedUnion('key', [first, ...rest]);
  const schema = z.strictObject({
    summary: z.string().max(1200),
    languages: z.array(z.strictObject({ code: z.string(), share: z.number() })),
    dimensions: z.array(dimensionEntry),
    excerpts: z
      .array(
        z.strictObject({
          text: z.string().max(300),
          sampleRef: z.string().regex(SAMPLE_REF),
          dimensionKeys: z.array(z.string()),
        }),
      )
      .min(3)
      .max(12),
    doList: z.array(z.string()).max(10),
    dontList: z.array(z.string()).max(10),
  }) as z.ZodType<ProfileOutput>;
  schemaDimensions.set(schema, dv.dimensions);
  return schema;
}

export function profileSchemaDimensions(schema: unknown): Dimension[] | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  return schemaDimensions.get(schema);
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function valueProblem(d: Dimension, value: unknown): string | null {
  switch (d.valueType) {
    case 'scale':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `dimension_invalid_value:${d.key}`;
      if (d.scale && (value < d.scale.min || value > d.scale.max)) return `dimension_out_of_range:${d.key}`;
      return null;
    case 'enum':
      if (typeof value !== 'string') return `dimension_invalid_value:${d.key}`;
      if (d.allowedValues && !d.allowedValues.includes(value)) return `dimension_invalid_value:${d.key}`;
      return null;
    case 'text':
      return typeof value === 'string' ? null : `dimension_invalid_value:${d.key}`;
    case 'list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : `dimension_invalid_value:${d.key}`;
  }
}

/**
 * Post-validation (FR-028, FR-030): every dimension exactly once with a valid value; excerpts kept only when they
 * are a whitespace-normalized verbatim substring of an existing authored `A{n}` sample; refs to anything else
 * (received context, memory `M{n}`) are dropped. `ok` needs no dimension problems and at least 3 valid excerpts.
 */
export function postValidateProfile(
  output: ProfileOutput,
  dv: Pick<ToneDefinitionVersion, 'dimensions'>,
  samples: { ref: string; contentItemId: string; text: string }[],
): { ok: boolean; validExcerptCount: number; problems: string[]; body: ProfileBody } {
  const byRef = new Map(samples.map((s) => [s.ref, { contentItemId: s.contentItemId, text: normalizeWs(s.text) }]));
  const validRef = (ref: string) => SAMPLE_REF.test(ref) && byRef.has(ref);
  const definitionKeys = new Set(dv.dimensions.map((d) => d.key));

  const problems: string[] = [];
  const dimensions: ProfileBody['dimensions'] = [];
  for (const d of dv.dimensions) {
    const entries = output.dimensions.filter((e) => e.key === d.key);
    const [entry] = entries;
    if (entry === undefined) {
      problems.push(`dimension_missing:${d.key}`);
      continue;
    }
    if (entries.length > 1) problems.push(`dimension_duplicate:${d.key}`);
    const problem = valueProblem(d, entry.value);
    if (problem) problems.push(problem);
    dimensions.push({
      key: entry.key,
      value: entry.value,
      explanation: entry.explanation,
      evidenceRefs: entry.evidenceRefs.filter(validRef),
    });
  }
  for (const e of output.dimensions) {
    if (!definitionKeys.has(e.key)) problems.push(`dimension_unknown:${e.key}`);
  }
  const dimensionProblems = problems.length;

  const excerpts: ProfileExcerpt[] = [];
  output.excerpts.forEach((x, i) => {
    const sample = validRef(x.sampleRef) ? byRef.get(x.sampleRef) : undefined;
    const text = normalizeWs(x.text);
    if (!sample || text === '' || !sample.text.includes(text)) {
      problems.push(`excerpt_dropped:${i}`);
      return;
    }
    excerpts.push({
      text: x.text,
      sampleRef: x.sampleRef,
      contentItemId: sample.contentItemId,
      dimensionKeys: x.dimensionKeys.filter((k) => definitionKeys.has(k)),
    });
  });
  if (excerpts.length < 3) problems.push('too_few_excerpts');

  return {
    ok: dimensionProblems === 0 && excerpts.length >= 3,
    validExcerptCount: excerpts.length,
    problems,
    body: {
      summary: output.summary,
      languages: output.languages,
      dimensions,
      excerpts,
      doList: output.doList,
      dontList: output.dontList,
    },
  };
}

/** Profile JSON as shown to the model (`previousProfileJson`, `profileJson`): no server-side `contentItemId`. */
export function toPromptProfileJson(body: ProfileBody): string {
  const output: ProfileOutput = {
    ...body,
    excerpts: body.excerpts.map(({ text, sampleRef, dimensionKeys }) => ({ text, sampleRef, dimensionKeys })),
  };
  return JSON.stringify(output);
}
