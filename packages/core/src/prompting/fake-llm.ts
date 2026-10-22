import { createFakeLlm, LlmRefusedError, type LlmClient } from '@voicespark/integrations/anthropic';
import type { Dimension, DraftContentType } from '@voicespark/db';
import { CONTENT_TYPE_LABEL, draftSchemaContentType, type DraftOutput } from './draft-schema';
import { profileSchemaDimensions, type ProfileOutput } from './profile-schema';

const SAMPLE_BLOCK = /<sample ref="(A[0-9]+)"[^>]*>([\s\S]*?)<\/sample>/g;
const EXCERPT_MAX_CHARS = 120;
const EXCERPT_COUNT = 3;
const BRIEF_LINE = /Brief: ([^\n]*)/;
/** Test hook: a brief line containing this marker makes the fake refuse. */
const REFUSE_MARKER = 'FAKE_LLM_REFUSE';

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
 * Deterministic generation LLM for tests: answers profile schemas from the `<sample>` blocks in the user prompt and
 * draft schemas from its `Brief: ` line; the output is validated against the caller's schema by `createFakeLlm`.
 */
export function createFakeGenerationLlm(): LlmClient {
  return createFakeLlm((args) => {
    const dimensions = profileSchemaDimensions(args.schema);
    if (dimensions !== undefined) return fakeProfile(dimensions, args.user);
    const contentType = draftSchemaContentType(args.schema);
    if (contentType !== undefined) return fakeDraft(contentType, args.user);
    throw new Error('fake_llm_unsupported');
  });
}
