import { describe, expect, it } from 'vitest';
import {
  ASPECT_KEY_RE,
  DOCUMENT_LIMITS,
  MAX_LLM_CALLS,
  buildDocumentOutputSchema,
  documentToMarkdown,
  isDocumentOutputSchema,
  mapExcerptsToItems,
  postValidateDocument,
  receivedOverlap,
  structuredToDocument,
  toDraftDocumentJson,
  toPromptDocumentJson,
  type DocumentOutput,
  type VoiceDocument,
} from '../src/prompting/document-schema';
import type { ProfileBody } from '../src/prompting/profile-schema';
import { ZERO_WIDTH_SPACE, neutralizeTags } from '../src/prompting/analysis';

const SAMPLES = [
  { ref: 'A1', text: 'Thanks for the update.\n  I will   review it tomorrow morning.' },
  { ref: 'A2', text: 'Quick note: the launch moved to Friday. Cheers!' },
];
const ITEMS = [
  { ref: 'A1', contentItemId: 'c-1' },
  { ref: 'A2', contentItemId: 'c-2' },
];
const RECEIVED = [
  'Please send the quarterly budget report to the finance team before the end of the week.',
];

function output(overrides: Partial<DocumentOutput> = {}): DocumentOutput {
  return {
    aspects: [
      { key: 'formality', name: 'Formality' },
      { key: 'sign_off', name: 'Sign-off' },
    ],
    summary: 'Friendly and brief.',
    sections: [
      { aspectKey: 'formality', heading: 'Formality', markdown: 'Mostly **casual**.' },
      { aspectKey: 'sign_off', heading: 'Sign-off', markdown: 'Signs off with *Cheers*.' },
    ],
    doList: ['Be brief.'],
    dontList: ['Ramble.'],
    excerpts: [
      { text: 'I will review it tomorrow', sampleRef: 'A1', aspectKeys: ['formality', 'nope'] },
      { text: 'Quick note: the launch', sampleRef: 'A2', aspectKeys: [] },
      { text: 'Cheers!', sampleRef: 'A2', aspectKeys: ['sign_off'] },
    ],
    languages: [{ code: 'en', share: 1 }],
    ...overrides,
  };
}

const INPUT = { samples: SAMPLES, received: RECEIVED };

describe('constants', () => {
  it('pins the call budget, limits and aspect key pattern', () => {
    expect(MAX_LLM_CALLS).toBe(2);
    expect(DOCUMENT_LIMITS).toMatchObject({
      aspectsMax: 20,
      summaryMax: 1200,
      excerptsMin: 3,
      excerptsMax: 12,
    });
    expect(ASPECT_KEY_RE.test('sign_off')).toBe(true);
    expect(ASPECT_KEY_RE.test('a')).toBe(false);
    expect(ASPECT_KEY_RE.test('1abc')).toBe(false);
    expect(ASPECT_KEY_RE.test('Sign')).toBe(false);
    expect(ASPECT_KEY_RE.test(`a${'b'.repeat(41)}`)).toBe(false);
  });
});

describe('buildDocumentOutputSchema', () => {
  const schema = buildDocumentOutputSchema();
  const ok = (o: unknown) => schema.safeParse(o).success;

  it('accepts a well-formed output and registers the schema', () => {
    expect(ok(output())).toBe(true);
    expect(isDocumentOutputSchema(schema)).toBe(true);
    expect(isDocumentOutputSchema(buildDocumentOutputSchema())).toBe(true);
    expect(isDocumentOutputSchema({})).toBe(false);
    expect(isDocumentOutputSchema(null)).toBe(false);
  });

  it('is strict at every level', () => {
    expect(ok({ ...output(), extra: true })).toBe(false);
    expect(ok(output({ aspects: [{ key: 'formality', name: 'F', x: 1 } as never] }))).toBe(false);
    expect(
      ok(output({ sections: [{ aspectKey: 'a', heading: 'h', markdown: 'm', x: 1 } as never] })),
    ).toBe(false);
    const excerpts = output().excerpts.map((e, i) =>
      i === 0 ? { ...e, contentItemId: 'c-1' } : e,
    );
    expect(ok(output({ excerpts }))).toBe(false);
    expect(ok(output({ languages: [{ code: 'en', share: 1, x: 1 } as never] }))).toBe(false);
    const { summary: _s, ...noSummary } = output();
    expect(ok(noSummary)).toBe(false);
  });

  it('enforces aspect count, key pattern and name length', () => {
    expect(ok(output({ aspects: [] }))).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ key: `k${i}x`, name: 'n' }));
    expect(ok(output({ aspects: many }))).toBe(false);
    expect(ok(output({ aspects: many.slice(0, 20) }))).toBe(true);
    expect(ok(output({ aspects: [{ key: 'Bad', name: 'n' }] }))).toBe(false);
    expect(ok(output({ aspects: [{ key: 'ok', name: 'x'.repeat(81) }] }))).toBe(false);
    expect(ok(output({ aspects: [{ key: 'ok', name: 'x'.repeat(80) }] }))).toBe(true);
  });

  it('enforces summary, heading, markdown and section limits', () => {
    expect(ok(output({ summary: 'x'.repeat(1201) }))).toBe(false);
    expect(ok(output({ summary: 'x'.repeat(1200) }))).toBe(true);
    const section = output().sections[0]!;
    expect(ok(output({ sections: [{ ...section, heading: 'x'.repeat(121) }] }))).toBe(false);
    expect(ok(output({ sections: [{ ...section, markdown: 'x'.repeat(4001) }] }))).toBe(false);
    expect(ok(output({ sections: [{ ...section, markdown: 'x'.repeat(4000) }] }))).toBe(true);
    expect(ok(output({ sections: Array(21).fill(section) }))).toBe(false);
  });

  it('enforces do and dont list limits', () => {
    expect(ok(output({ doList: [] }))).toBe(false);
    expect(ok(output({ dontList: [] }))).toBe(false);
    expect(ok(output({ doList: Array(11).fill('x') }))).toBe(false);
    expect(ok(output({ dontList: Array(10).fill('x') }))).toBe(true);
    expect(ok(output({ doList: ['x'.repeat(201)] }))).toBe(false);
  });

  it('enforces excerpt count, text length and A refs', () => {
    const ex = output().excerpts;
    expect(ok(output({ excerpts: ex.slice(0, 2) }))).toBe(false);
    expect(ok(output({ excerpts: Array(13).fill(ex[0]) }))).toBe(false);
    expect(ok(output({ excerpts: Array(12).fill(ex[0]) }))).toBe(true);
    expect(ok(output({ excerpts: [...ex, { ...ex[0]!, text: 'x'.repeat(301) }] }))).toBe(false);
    expect(ok(output({ excerpts: [...ex, { ...ex[0]!, sampleRef: 'M1' }] }))).toBe(false);
    expect(ok(output({ excerpts: [...ex, { ...ex[0]!, sampleRef: 'R1' }] }))).toBe(false);
  });
});

describe('postValidateDocument', () => {
  it('passes a valid output and filters unknown excerpt aspect keys', () => {
    const r = postValidateDocument(output(), INPUT);
    expect(r).toMatchObject({ ok: true, problems: [] });
    expect(r.cleaned.excerpts).toHaveLength(3);
    expect(r.cleaned.excerpts[0]!.aspectKeys).toEqual(['formality']);
  });

  it('reports a missing section per declared aspect', () => {
    const r = postValidateDocument(output({ sections: output().sections.slice(0, 1) }), INPUT);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['aspect_missing:sign_off']);
  });

  it('reports duplicate aspects and duplicate sections', () => {
    const dupAspect = output({
      aspects: [...output().aspects, { key: 'formality', name: 'Again' }],
    });
    expect(postValidateDocument(dupAspect, INPUT).problems).toEqual(['aspect_duplicate']);
    const dupSection = output({ sections: [...output().sections, output().sections[0]!] });
    const r = postValidateDocument(dupSection, INPUT);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['aspect_duplicate']);
  });

  it('reports a section for an undeclared aspect', () => {
    const r = postValidateDocument(
      output({
        sections: [...output().sections, { aspectKey: 'other', heading: 'Other', markdown: 'x' }],
      }),
      INPUT,
    );
    expect(r.problems).toEqual(['section_unknown']);
    expect(r.ok).toBe(false);
  });

  it('reports an empty summary and empty do and dont lists', () => {
    const r = postValidateDocument(
      output({ summary: '  \n ', doList: ['', '  '], dontList: [' '] }),
      INPUT,
    );
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['summary_missing', 'do_list_empty', 'dont_list_empty']);
  });

  it('removes empty do and dont items from the cleaned output', () => {
    const r = postValidateDocument(
      output({ doList: ['', 'Be brief.', ' '], dontList: ['Ramble.', ''] }),
      INPUT,
    );
    expect(r.ok).toBe(true);
    expect(r.cleaned.doList).toEqual(['Be brief.']);
    expect(r.cleaned.dontList).toEqual(['Ramble.']);
  });

  it('drops non-verbatim, unknown-sample and non-A excerpts as informational problems', () => {
    const r = postValidateDocument(
      output({
        excerpts: [
          ...output().excerpts,
          { text: 'I will review it on Monday', sampleRef: 'A1', aspectKeys: [] },
          { text: 'Thanks for the update.', sampleRef: 'A7', aspectKeys: [] },
          { text: 'Thanks for the update.', sampleRef: 'M1', aspectKeys: [] },
          { text: '   ', sampleRef: 'A1', aspectKeys: [] },
        ],
      }),
      INPUT,
    );
    expect(r.problems).toEqual([
      'excerpt_dropped:3',
      'excerpt_dropped:4',
      'excerpt_dropped:5',
      'excerpt_dropped:6',
    ]);
    expect(r.ok).toBe(true);
    expect(r.cleaned.excerpts.map((e) => e.text)).toEqual(output().excerpts.map((e) => e.text));
  });

  it('matches excerpts after whitespace normalisation', () => {
    const r = postValidateDocument(
      output({
        excerpts: [
          { text: 'update.  I will\nreview it', sampleRef: 'A1', aspectKeys: [] },
          { text: '  the launch moved\tto Friday. ', sampleRef: 'A2', aspectKeys: [] },
          { text: 'Cheers!', sampleRef: 'A2', aspectKeys: [] },
        ],
      }),
      INPUT,
    );
    expect(r).toMatchObject({ ok: true, problems: [] });
  });

  it('strips U+200B from neutralised samples and excerpts before matching', () => {
    const raw = 'See the <sample> tag here and </item> there, then sign off. Thanks!';
    const neutral = neutralizeTags(raw);
    expect(neutral).toContain(ZERO_WIDTH_SPACE);
    const r = postValidateDocument(
      output({
        excerpts: [
          { text: 'See the <sample> tag here', sampleRef: 'A3', aspectKeys: [] },
          { text: `and <${ZERO_WIDTH_SPACE}/item> there`, sampleRef: 'A3', aspectKeys: [] },
          { text: 'Cheers!', sampleRef: 'A2', aspectKeys: [] },
        ],
      }),
      { samples: [...SAMPLES, { ref: 'A3', text: neutral }], received: [] },
    );
    expect(r).toMatchObject({ ok: true, problems: [] });
  });

  it('fails with fewer than three valid excerpts', () => {
    const r = postValidateDocument(
      output({
        excerpts: [
          output().excerpts[0]!,
          { text: 'not there', sampleRef: 'A2', aspectKeys: [] },
          { text: 'also not there', sampleRef: 'A1', aspectKeys: [] },
        ],
      }),
      INPUT,
    );
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['excerpt_dropped:1', 'excerpt_dropped:2', 'too_few_excerpts']);
    expect(r.cleaned.excerpts).toHaveLength(1);
  });

  it('reports received quotes in summary, sections and do/dont items', () => {
    const quote = 'send the quarterly budget report to the finance team';
    for (const o of [
      output({ summary: `They often ${quote}.` }),
      output({
        sections: [output().sections[0]!, { ...output().sections[1]!, markdown: `- ${quote}` }],
      }),
      output({ doList: [`Always ${quote.toUpperCase()}!`] }),
      output({ dontList: [`Never "${quote}"`] }),
    ]) {
      const r = postValidateDocument(o, INPUT);
      expect(r.problems).toEqual(['received_quote']);
      expect(r.ok).toBe(false);
    }
  });

  it('allows a received 8-word run when it also appears in an authored sample', () => {
    const quote = 'send the quarterly budget report to the finance team';
    const r = postValidateDocument(output({ summary: `They ${quote}.` }), {
      samples: [...SAMPLES, { ref: 'A3', text: `I will ${quote}, as usual.` }],
      received: RECEIVED,
    });
    expect(r).toMatchObject({ ok: true, problems: [] });
  });

  it('ignores runs shorter than eight words', () => {
    const r = postValidateDocument(
      output({ summary: 'They send the quarterly budget report to the.' }),
      INPUT,
    );
    expect(r.ok).toBe(true);
  });
});

describe('receivedOverlap', () => {
  const received = [
    'Hello there, please send the quarterly budget report to the finance team today.',
  ];

  it('detects 8-word lowercased punctuation-stripped shingles', () => {
    expect(
      receivedOverlap(['PLEASE send the quarterly, budget report; to the finance!'], received, []),
    ).toBe(true);
    expect(receivedOverlap(['please send the quarterly budget report to'], received, [])).toBe(
      false,
    );
    expect(
      receivedOverlap(
        ['totally unrelated words in this sentence about nothing at all'],
        received,
        [],
      ),
    ).toBe(false);
  });

  it('strips U+200B before comparing', () => {
    const text = `please send the quar${ZERO_WIDTH_SPACE}terly budget report to the finance`;
    expect(receivedOverlap([text], received, [])).toBe(true);
  });

  it('allows shingles that also appear in authored samples', () => {
    const text = 'please send the quarterly budget report to the finance';
    expect(
      receivedOverlap([text], received, [
        'I always please send the quarterly budget report to the finance.',
      ]),
    ).toBe(false);
    expect(receivedOverlap([text], received, ['please send the quarterly budget report'])).toBe(
      true,
    );
  });

  it('is false with no received context', () => {
    expect(
      receivedOverlap(['please send the quarterly budget report to the finance'], [], []),
    ).toBe(false);
  });
});

describe('mapExcerptsToItems', () => {
  it('maps A refs to content items server-side and keeps everything else', () => {
    const doc = mapExcerptsToItems(output(), ITEMS);
    expect(doc.excerpts.map((e) => e.contentItemId)).toEqual(['c-1', 'c-2', 'c-2']);
    expect(doc.excerpts[0]).toEqual({
      text: 'I will review it tomorrow',
      sampleRef: 'A1',
      contentItemId: 'c-1',
      aspectKeys: ['formality', 'nope'],
    });
    expect(doc).toMatchObject({
      summary: 'Friendly and brief.',
      doList: ['Be brief.'],
      dontList: ['Ramble.'],
    });
    expect(doc.aspects).toEqual(output().aspects);
    expect(doc.sections).toEqual(output().sections);
    expect(doc.languages).toEqual([{ code: 'en', share: 1 }]);
  });

  it('maps an unknown ref to null', () => {
    const doc = mapExcerptsToItems(output(), ITEMS.slice(0, 1));
    expect(doc.excerpts.map((e) => e.contentItemId)).toEqual(['c-1', null, null]);
  });
});

const BODY: ProfileBody = {
  summary: 'Friendly and brief.',
  languages: [
    { code: 'en', share: 0.8 },
    { code: 'pl', share: 0.2 },
  ],
  dimensions: [
    { key: 'formality', value: 2, explanation: 'Casual.', evidenceRefs: ['A1'] },
    {
      key: 'signature_phrases',
      value: ['quick note', 'cheers'],
      explanation: '',
      evidenceRefs: [],
    },
    { key: 'sign_off', value: 'Cheers', explanation: 'Signs off.', evidenceRefs: [] },
  ],
  excerpts: [
    { text: 'Cheers!', sampleRef: 'A2', contentItemId: 'c-2', dimensionKeys: ['sign_off'] },
  ],
  doList: ['Be brief.'],
  dontList: ['Ramble.'],
};

describe('structuredToDocument', () => {
  it('turns each dimension into an aspect and a section', () => {
    const doc = structuredToDocument(BODY, [
      { key: 'formality', name: 'Formality' },
      { key: 'sign_off', name: 'Sign-off' },
    ]);
    expect(doc.aspects).toEqual([
      { key: 'formality', name: 'Formality' },
      { key: 'signature_phrases', name: 'signature_phrases' },
      { key: 'sign_off', name: 'Sign-off' },
    ]);
    expect(doc.sections).toEqual([
      { aspectKey: 'formality', heading: 'Formality', markdown: '2\n\nCasual.' },
      {
        aspectKey: 'signature_phrases',
        heading: 'signature_phrases',
        markdown: 'quick note, cheers',
      },
      { aspectKey: 'sign_off', heading: 'Sign-off', markdown: 'Cheers\n\nSigns off.' },
    ]);
  });

  it('keeps summary, do/dont, excerpts and languages', () => {
    const doc = structuredToDocument(BODY);
    expect(doc.summary).toBe(BODY.summary);
    expect(doc.doList).toEqual(BODY.doList);
    expect(doc.dontList).toEqual(BODY.dontList);
    expect(doc.languages).toEqual(BODY.languages);
    expect(doc.excerpts).toEqual([
      { text: 'Cheers!', sampleRef: 'A2', contentItemId: 'c-2', aspectKeys: ['sign_off'] },
    ]);
    expect(doc.aspects[0]).toEqual({ key: 'formality', name: 'formality' });
  });
});

const DOC: VoiceDocument = mapExcerptsToItems(output(), ITEMS);

describe('documentToMarkdown', () => {
  it('renders summary, sections, do, dont and excerpts as blank-line separated blocks', () => {
    expect(documentToMarkdown(DOC)).toBe(
      [
        'Friendly and brief.',
        '### Formality\n\nMostly **casual**.',
        '### Sign-off\n\nSigns off with *Cheers*.',
        '### Do\n\n- Be brief.',
        "### Don't\n\n- Ramble.",
        '### Excerpts\n\n- "I will review it tomorrow"\n- "Quick note: the launch"\n- "Cheers!"',
      ].join('\n\n'),
    );
  });

  it('omits the excerpts block when no excerpts remain', () => {
    expect(documentToMarkdown({ ...DOC, excerpts: [] })).not.toContain('### Excerpts');
  });
});

describe('document JSON for prompts', () => {
  it('toPromptDocumentJson drops contentItemId only', () => {
    const json = toPromptDocumentJson(DOC);
    expect(json).not.toContain('contentItemId');
    expect(JSON.parse(json)).toEqual(output());
  });

  it('toDraftDocumentJson keeps only the parts drafts need', () => {
    expect(JSON.parse(toDraftDocumentJson(DOC))).toEqual({
      format: 'document',
      summary: 'Friendly and brief.',
      sections: [
        { heading: 'Formality', markdown: 'Mostly **casual**.' },
        { heading: 'Sign-off', markdown: 'Signs off with *Cheers*.' },
      ],
      doList: ['Be brief.'],
      dontList: ['Ramble.'],
      excerpts: [
        { text: 'I will review it tomorrow' },
        { text: 'Quick note: the launch' },
        { text: 'Cheers!' },
      ],
      languages: [{ code: 'en', share: 1 }],
    });
  });
});
