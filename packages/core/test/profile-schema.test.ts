import { describe, expect, it } from 'vitest';
import type { Dimension } from '@voicespark/db';
import {
  buildProfileOutputSchema,
  createFakeGenerationLlm,
  formatAuthoredSamples,
  postValidateProfile,
  profileSchemaDimensions,
  toPromptProfileJson,
  type ProfileOutput,
} from '../src/prompting';

const DIMS: Dimension[] = [
  {
    key: 'formality',
    name: 'Formality',
    description: 'How formal.',
    valueType: 'scale',
    scale: { min: 1, max: 5, minLabel: 'very casual', maxLabel: 'very formal' },
  },
  { key: 'humour', name: 'Humour', description: 'How funny.', valueType: 'enum', allowedValues: ['none', 'light'] },
  { key: 'sign_off', name: 'Sign-off', description: 'Closing.', valueType: 'text' },
  { key: 'signature_phrases', name: 'Phrases', description: 'Habits.', valueType: 'list' },
];
const DV = { dimensions: DIMS };

const SAMPLES = [
  { ref: 'A1', contentItemId: 'c-1', text: 'Thanks for the update.\n  I will   review it tomorrow morning.' },
  { ref: 'A2', contentItemId: 'c-2', text: 'Quick note: the launch moved to Friday. Cheers!' },
];

function output(overrides: Partial<ProfileOutput> = {}): ProfileOutput {
  return {
    summary: 'Friendly and brief.',
    languages: [{ code: 'en', share: 1 }],
    dimensions: [
      { key: 'formality', value: 2, explanation: 'Casual.', evidenceRefs: ['A1', 'A9', 'A3'] },
      { key: 'humour', value: 'light', explanation: 'Some.', evidenceRefs: ['A2'] },
      { key: 'sign_off', value: 'Cheers', explanation: 'Signs off.', evidenceRefs: [] },
      { key: 'signature_phrases', value: ['quick note'], explanation: 'Habit.', evidenceRefs: ['A2'] },
    ],
    excerpts: [
      { text: 'I will review it tomorrow', sampleRef: 'A1', dimensionKeys: ['formality', 'nope'] },
      { text: 'Quick note: the launch', sampleRef: 'A2', dimensionKeys: ['signature_phrases'] },
      { text: 'Cheers!', sampleRef: 'A2', dimensionKeys: [] },
    ],
    doList: ['Be brief.'],
    dontList: ['Ramble.'],
    ...overrides,
  };
}

describe('buildProfileOutputSchema', () => {
  const schema = buildProfileOutputSchema(DV);

  it('accepts a well-formed output and registers its dimensions', () => {
    expect(schema.safeParse(output()).success).toBe(true);
    expect(profileSchemaDimensions(schema)).toBe(DIMS);
    expect(profileSchemaDimensions({})).toBeUndefined();
  });

  it('rejects unknown keys and wrongly typed values', () => {
    const dims = output().dimensions;
    const withDim = (d: unknown) => output({ dimensions: [...dims.slice(1), d] as ProfileOutput['dimensions'] });
    expect(schema.safeParse(withDim({ key: 'other', value: 1, explanation: '', evidenceRefs: [] })).success).toBe(false);
    expect(schema.safeParse(withDim({ key: 'formality', value: 'high', explanation: '', evidenceRefs: [] })).success).toBe(false);
    expect(schema.safeParse(withDim({ key: 'formality', value: 9, explanation: '', evidenceRefs: [] })).success).toBe(false);
    const humourBad = output({
      dimensions: [dims[0]!, { key: 'humour', value: 'frequent', explanation: '', evidenceRefs: [] }, dims[2]!, dims[3]!],
    });
    expect(schema.safeParse(humourBad).success).toBe(false);
    const listBad = output({
      dimensions: [dims[0]!, dims[1]!, dims[2]!, { key: 'signature_phrases', value: 'x', explanation: '', evidenceRefs: [] }],
    });
    expect(schema.safeParse(listBad).success).toBe(false);
  });

  it('enforces excerpt count, refs and extra properties', () => {
    expect(schema.safeParse(output({ excerpts: output().excerpts.slice(0, 2) })).success).toBe(false);
    const mRef = output().excerpts.map((e, i) => (i === 0 ? { ...e, sampleRef: 'M1' } : e));
    expect(schema.safeParse(output({ excerpts: mRef })).success).toBe(false);
    expect(schema.safeParse({ ...output(), extra: true }).success).toBe(false);
    expect(schema.safeParse(output({ doList: Array(11).fill('x') })).success).toBe(false);
  });
});

describe('postValidateProfile', () => {
  it('maps excerpts to content items and filters evidence refs', () => {
    const r = postValidateProfile(output(), DV, SAMPLES);
    expect(r.ok).toBe(true);
    expect(r.validExcerptCount).toBe(3);
    expect(r.problems).toEqual([]);
    expect(r.body.excerpts.map((e) => e.contentItemId)).toEqual(['c-1', 'c-2', 'c-2']);
    expect(r.body.excerpts[0]!.dimensionKeys).toEqual(['formality']);
    expect(r.body.dimensions[0]!.evidenceRefs).toEqual(['A1']);
  });

  it('drops non-verbatim, unknown-sample and non-A excerpts', () => {
    const r = postValidateProfile(
      output({
        excerpts: [
          ...output().excerpts,
          { text: 'I will review it on Monday', sampleRef: 'A1', dimensionKeys: [] },
          { text: 'fake received content', sampleRef: 'A7', dimensionKeys: [] },
          { text: 'SAMPLE FACT', sampleRef: 'M1', dimensionKeys: [] },
        ],
      }),
      DV,
      SAMPLES,
    );
    expect(r.validExcerptCount).toBe(3);
    expect(r.problems).toEqual(['excerpt_dropped:3', 'excerpt_dropped:4', 'excerpt_dropped:5']);
    expect(r.ok).toBe(true);
  });

  it('fails with fewer than three valid excerpts', () => {
    const r = postValidateProfile(
      output({ excerpts: [output().excerpts[0]!, { text: 'not there', sampleRef: 'A2', dimensionKeys: [] }] }),
      DV,
      SAMPLES,
    );
    expect(r.ok).toBe(false);
    expect(r.validExcerptCount).toBe(1);
    expect(r.problems).toContain('too_few_excerpts');
  });

  it('reports missing, duplicate and out-of-range dimensions', () => {
    const dims = output().dimensions;
    const r = postValidateProfile(
      output({ dimensions: [{ ...dims[0]!, value: 7 }, dims[1]!, dims[1]!, dims[3]!] }),
      DV,
      SAMPLES,
    );
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'dimension_out_of_range:formality',
      'dimension_duplicate:humour',
      'dimension_missing:sign_off',
    ]);
    expect(r.body.dimensions.map((d) => d.key)).toEqual(['formality', 'humour', 'signature_phrases']);
  });

  it('strips contentItemId for prompt JSON', () => {
    const json = toPromptProfileJson(postValidateProfile(output(), DV, SAMPLES).body);
    expect(json).not.toContain('contentItemId');
    expect(JSON.parse(json)).toMatchObject({ summary: 'Friendly and brief.' });
  });
});

describe('createFakeGenerationLlm', () => {
  const llm = createFakeGenerationLlm();
  const args = (user: string) => ({
    model: 'fake',
    effort: 'high' as const,
    maxTokens: 1000,
    system: 'sys',
    user,
    schema: buildProfileOutputSchema(DV),
  });

  it('returns a profile that passes post-validation', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join('  ');
    const user = formatAuthoredSamples([
      { ref: 'A1', kind: 'email', date: '2024-01-02', lang: 'en', text: SAMPLES[0]!.text },
      { ref: 'A2', kind: 'note', date: '2024-01-03', lang: null, text: long },
    ]);
    const out = await llm.parseStructured(args(`Evidence:\n${user}\n<received_context>x</received_context>`));
    const r = postValidateProfile(out, DV, [SAMPLES[0]!, { ref: 'A2', contentItemId: 'c-2', text: long }]);
    expect(r.ok).toBe(true);
    expect(r.validExcerptCount).toBe(3);
    expect(out.excerpts.every((e) => e.text.length <= 120)).toBe(true);
  });

  it('throws without samples or for unsupported schemas', async () => {
    await expect(llm.parseStructured(args('no samples here'))).rejects.toThrow('fake_llm_no_samples');
    const { z } = await import('zod');
    await expect(llm.parseStructured({ ...args('x'), schema: z.object({}) })).rejects.toThrow('fake_llm_unsupported');
  });
});
