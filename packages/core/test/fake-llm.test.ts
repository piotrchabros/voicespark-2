import { describe, expect, it } from 'vitest';
import { LlmRefusedError } from '@voicespark/integrations/anthropic';
import { wrapAnalysisPrompt } from '../src/prompting/analysis';
import { buildDocumentOutputSchema, postValidateDocument } from '../src/prompting/document-schema';
import { FAKE_DOC_MARKERS, createFakeGenerationLlm } from '../src/prompting/fake-llm';

const SAMPLES = [
  { ref: 'A1', text: 'Hello there, thanks for the quick update on the schedule.' },
  { ref: 'A2', text: 'Let us sync tomorrow morning and finalise the plan together.' },
];
const RECEIVED = 'Please remember that the quarterly numbers are due on Friday afternoon sharp.';
const PROMPT =
  '- Formality: how formal\n- Warmth: how warm\n- Sentence length: short or long\n- 2nd aspect: digits\n- Humor: jokes';

const BASE = { model: 'fake', effort: 'low', maxTokens: 1000, system: 's' } as const;

function userPrompt(extra = ''): string {
  const samples = SAMPLES.map((s) => `<sample ref="${s.ref}" kind="email">${s.text}</sample>`).join(
    '\n',
  );
  return [
    wrapAnalysisPrompt(PROMPT, 'own'),
    samples,
    `<received_context><item kind="email" date="2000-01-01">${RECEIVED}</item></received_context>`,
    extra,
  ].join('\n');
}

async function run(extra = '') {
  const schema = buildDocumentOutputSchema();
  return createFakeGenerationLlm().parseStructured({ ...BASE, user: userPrompt(extra), schema });
}

describe('fake generation llm, document schema', () => {
  it('produces a valid 5-aspect document', async () => {
    const doc = await run();
    expect(doc.aspects.map((a) => a.key)).toEqual([
      'formality',
      'warmth',
      'sentence_length',
      'a_2nd_aspect',
      'humor',
    ]);
    expect(doc.sections).toHaveLength(5);
    const result = postValidateDocument(doc, { samples: SAMPLES, received: [RECEIVED] });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('falls back to a single voice aspect', async () => {
    const doc = await createFakeGenerationLlm().parseStructured({
      ...BASE,
      user: SAMPLES.map((s) => `<sample ref="${s.ref}">${s.text}</sample>`).join('\n'),
      schema: buildDocumentOutputSchema(),
    });
    expect(doc.aspects).toEqual([{ key: 'voice', name: 'Voice' }]);
  });

  const codes: [keyof typeof FAKE_DOC_MARKERS, string][] = [
    ['noSummary', 'summary_missing'],
    ['missingAspect', 'aspect_missing:humor'],
    ['fewExcerpts', 'too_few_excerpts'],
    ['receivedQuote', 'received_quote'],
  ];
  it.each(codes)('switch %s yields %s', async (name, code) => {
    const doc = await run(FAKE_DOC_MARKERS[name]);
    const result = postValidateDocument(doc, { samples: SAMPLES, received: [RECEIVED] });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(code);
  });

  it('empty lists switch yields both list codes', async () => {
    const doc = await run(FAKE_DOC_MARKERS.emptyLists);
    const { problems } = postValidateDocument(doc, { samples: SAMPLES, received: [RECEIVED] });
    expect(problems).toEqual(expect.arrayContaining(['do_list_empty', 'dont_list_empty']));
  });

  it('refuse switch throws LlmRefusedError', async () => {
    await expect(run(FAKE_DOC_MARKERS.refuse)).rejects.toBeInstanceOf(LlmRefusedError);
  });
});
