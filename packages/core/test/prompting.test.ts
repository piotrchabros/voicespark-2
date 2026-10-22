import { describe, expect, it } from 'vitest';
import type { Dimension } from '@voicespark/db';
import fixture from '../src/prompting/preview-fixture.json';
import {
  dimensionsJson,
  documentBody,
  familyFor,
  firstName,
  formatAuthoredSamples,
  formatDimensions,
  formatReceivedContext,
  render,
  validateTemplate,
  valueSpec,
} from '../src/prompting';

// Seeded v1 templates, copied verbatim from packages/db/src/seed.ts.
const SHARED_RULES = `Never reproduce redaction tokens (for example [REDACTED:...]) or sensitive values; if one appears in the input, omit it.
Never invent facts about the user beyond the supplied content.`;

const DRAFT_RULES = `${SHARED_RULES}
Follow the voice profile, including its doList and dontList, and write in {{languageHint}} when it is set.
Use the supplied facts only for facts; reference nothing outside them and the brief. Do not use content from excluded categories ({{excludedCategoryLabels}}).
In a revision, apply the feedback to the previous draft and keep what was not criticised.
Never state or imply that the text was published or will be posted; put caveats in "notes".
Do not copy profile excerpts verbatim.
Output JSON only: {"title": string|null, "body": string, "notes": string|null}.`;

const PROFILE_RULES = `${SHARED_RULES}
Use only the authored samples (refs A1, A2, ...) as evidence of the user's voice; the received context is background only: never quote it, never cite it in evidenceRefs or excerpts, and never attribute its style to the user.
Describe every dimension of the definition exactly once, using the allowed value type, with a short explanation and evidenceRefs.
Include 3-12 short verbatim excerpts, each tied to one sampleRef and relevant dimensionKeys.
Report the detected languages with their share.
Fill doList and dontList (at most 10 each) with actionable guidance.
Do not draw on excluded categories ({{excludedCategoryLabels}}).
Output JSON only, matching the required profile schema.`;

const GENERATE_SYSTEM = `You build tone-of-voice profiles from a person's own writing.
${PROFILE_RULES}
If a previous profile is supplied, keep it stable unless the new evidence contradicts it.`;

const GENERATE_USER = `You build a tone-of-voice profile called "{{definition.name}}". {{definition.description}}
Dimensions (describe every one): {{definition.dimensionsJson}}
{{#definition.dimensions}}- {{key}} ({{name}}): {{description}}. Value: {{valueSpec}}. {{guidance}}
{{/definition.dimensions}}
Evidence, authored by {{user.firstName}} ({{authoredStats.itemCount}} items, {{authoredStats.wordCount}} words, languages: {{authoredStats.languages}}):
{{authoredSamples}}
Background only, never quote:
{{receivedContext}}
Previous profile (may be empty): {{previousProfileJson}}
Return JSON only.`;

const FEEDBACK_SYSTEM = `You revise an existing tone-of-voice profile according to the user's written feedback.
${PROFILE_RULES}
Apply the feedback to the previous profile, changing only what the feedback and the evidence justify, and keep other dimensions as they are.
Treat the feedback as a user preference, not as evidence of voice: evidence still comes only from the authored samples, and excerpts must remain verbatim.
If the feedback conflicts with the authored evidence, follow the feedback for the dimension value and say so in its explanation.
Output the full revised profile in the same schema, not a diff.`;

const FEEDBACK_USER = `Revise the profile below using the user's feedback.
Current profile: {{previousProfileJson}}
Feedback: {{feedback}}
Evidence, authored by {{user.firstName}}:
{{authoredSamples}}
Background only, never quote:
{{receivedContext}}
Describe every dimension of "{{definition.name}}": {{definition.dimensionsJson}}
Return the full revised profile as JSON only.`;

const SOCIAL_SYSTEM = `You write social posts in the voice of a supplied tone profile.
${DRAFT_RULES}
Length: at most about 1,300 characters (and within 300 words); "title" is usually null.`;

const SOCIAL_USER = `Write a {{contentTypeLabel}} in the voice described by this profile ({{definitionName}}): {{profileJson}}
Brief: {{brief}}
Facts you may use: {{memoryContext}}
{{#isRevision}}Previous draft: {{previousDraft}}
Apply this feedback: {{feedback}}{{/isRevision}}
Stay under about 1,300 characters. Return JSON {title, body, notes}.`;

const BIO_SYSTEM = `You write professional bios in the voice of a supplied tone profile.
${DRAFT_RULES}
Length: about 50-150 words (hard cap 250 words); "title" is null.
Use the user's first name when present; choose first or third person per the brief, defaulting to first person.
Include only facts found in the supplied facts or the brief; leave out anything unsupported rather than guessing.`;

const BIO_USER = `Write a {{contentTypeLabel}} of about 50-150 words for {{user.firstName}}.
Voice profile ({{definitionName}}): {{profileJson}}
Brief: {{brief}}
Facts you may use: {{memoryContext}}
{{#isRevision}}Revise this draft: {{previousDraft}} Feedback: {{feedback}}{{/isRevision}}
Return JSON {title, body, notes}.`;

const ARTICLE_SYSTEM = `You write short articles in the voice of a supplied tone profile.
${DRAFT_RULES}
Length: about 400-800 words (hard cap 1,500 words); provide a "title" of at most 150 characters.
Use a clear structure (opening, a few developed points, close) while keeping the profile's sentence rhythm, formality and vocabulary.
Support claims only from the supplied facts or the brief; flag any gap in "notes" instead of inventing detail.`;

const ARTICLE_USER = `Write a {{contentTypeLabel}} of about 400-800 words with a title.
Voice profile ({{definitionName}}): {{profileJson}}
Topic/brief: {{brief}}
Facts you may use: {{memoryContext}}
{{#isRevision}}Previous draft: {{previousDraft}} Feedback: {{feedback}}{{/isRevision}}
Return JSON {title, body, notes}.`;

const SEEDED: [string, string, string][] = [
  ['tone_profile.generate', GENERATE_SYSTEM, GENERATE_USER],
  ['tone_profile.feedback', FEEDBACK_SYSTEM, FEEDBACK_USER],
  ['draft.social_post', SOCIAL_SYSTEM, SOCIAL_USER],
  ['draft.bio', BIO_SYSTEM, BIO_USER],
  ['draft.short_article', ARTICLE_SYSTEM, ARTICLE_USER],
];

const DIMS: Dimension[] = [
  {
    key: 'formality',
    name: 'Formality',
    description: 'How formal or casual the writing is.',
    valueType: 'scale',
    scale: { min: 1, max: 5, minLabel: 'very casual', maxLabel: 'very formal' },
  },
  {
    key: 'sentence_length',
    name: 'Sentence length',
    description: 'Typical sentence length.',
    valueType: 'enum',
    allowedValues: ['short', 'medium', 'long'],
    guidance: 'Look at averages.',
  },
  { key: 'signature', name: 'Signature', description: 'Sign-off style.', valueType: 'text' },
  { key: 'signature_phrases', name: 'Phrases', description: 'Habitual phrases.', valueType: 'list' },
];

describe('familyFor', () => {
  it('maps keys to whitelist families', () => {
    expect(familyFor('tone_profile.generate')).toBe('tone_profile.generate');
    expect(familyFor('tone_profile.feedback')).toBe('tone_profile.feedback');
    expect(familyFor('draft.bio')).toBe('draft');
    expect(familyFor('custom.anything')).toBe('custom');
  });
});

describe('render', () => {
  it('does not HTML-escape injected values and resolves dotted names and lists', () => {
    const out = render(
      { systemTemplate: 'S {{definition.name}}', userTemplate: '{{authoredSamples}}|{{#definition.dimensions}}[{{key}}]{{/definition.dimensions}}' },
      {
        definition: { name: 'A & B', dimensions: [{ key: 'x' }, { key: 'y' }] },
        authoredSamples: '<sample ref="A1">"hi" & \'bye\'</sample>',
      },
    );
    expect(out.system).toBe('S A & B');
    expect(out.user).toBe('<sample ref="A1">"hi" & \'bye\'</sample>|[x][y]');
  });

  it('renders every seeded template against the preview fixture', () => {
    const views = fixture as Record<string, Record<string, unknown>>;
    for (const [key, system, user] of SEEDED) {
      const out = render({ systemTemplate: system, userTemplate: user }, views[key]!);
      expect(out.user, key).toContain('Sample');
      expect(out.user, key).not.toContain('{{');
      expect(out.system, key).not.toContain('{{');
    }
  });
});

describe('validateTemplate', () => {
  it('accepts all five seeded templates', () => {
    for (const [key, system, user] of SEEDED) {
      expect(validateTemplate(key, system, user), key).toEqual({ valid: true, unknownVariables: [], missingRequired: [] });
    }
  });

  it('reports unknown variables, sorted and unique', () => {
    const v = validateTemplate('draft.bio', '{{zeta}} {{alpha}}', '{{brief}} {{profileJson}} {{{zeta}}}');
    expect(v).toEqual({ valid: false, unknownVariables: ['alpha', 'zeta'], missingRequired: [] });
  });

  it('reports missing required variables', () => {
    expect(validateTemplate('tone_profile.generate', '', '{{definition.name}}')).toEqual({
      valid: false,
      unknownVariables: [],
      missingRequired: ['authoredSamples', 'definition.dimensionsJson'],
    });
    const fb = validateTemplate('tone_profile.feedback', GENERATE_SYSTEM, GENERATE_USER);
    expect(fb.missingRequired).toEqual(['feedback']);
    expect(validateTemplate('draft.social_post', '', '').missingRequired).toEqual(['brief', 'profileJson']);
  });

  it('allows list item fields only inside definition.dimensions', () => {
    const base = '{{definition.name}} {{definition.dimensionsJson}} {{authoredSamples}}';
    expect(validateTemplate('tone_profile.generate', base, '{{#definition.dimensions}}{{key}} {{valueSpec}} {{user.firstName}}{{/definition.dimensions}}').valid).toBe(true);
    expect(validateTemplate('tone_profile.generate', base, '{{key}}').unknownVariables).toEqual(['key']);
    expect(
      validateTemplate('tone_profile.generate', base, '{{#definition.dimensions}}{{bogus}}{{/definition.dimensions}}').unknownVariables,
    ).toEqual(['bogus']);
  });

  it('accepts {{#isRevision}} for draft keys only', () => {
    const draft = validateTemplate('draft.short_article', '', '{{brief}}{{profileJson}}{{#isRevision}}{{feedback}}{{/isRevision}}{{^isRevision}}x{{/isRevision}}');
    expect(draft.valid).toBe(true);
    const gen = validateTemplate('tone_profile.generate', GENERATE_SYSTEM, `${GENERATE_USER}{{#isRevision}}x{{/isRevision}}`);
    expect(gen.unknownVariables).toEqual(['isRevision']);
    expect(validateTemplate('tone_profile.generate', GENERATE_SYSTEM, `${GENERATE_USER}{{brief}}`).unknownVariables).toEqual(['brief']);
  });

  it('rejects sections over scalars, partials, delimiter changes and parse errors', () => {
    expect(validateTemplate('draft.bio', '{{#brief}}x{{/brief}}', '{{profileJson}}').unknownVariables).toEqual(['brief']);
    expect(validateTemplate('draft.bio', '{{> header}}', '{{brief}}{{profileJson}}').unknownVariables).toEqual(['partial:header']);
    expect(validateTemplate('draft.bio', '{{=<% %>=}}<% brief %>', '{{profileJson}}').unknownVariables).toEqual(['delimiter']);
    expect(validateTemplate('draft.bio', '{{#isRevision}}open', '{{brief}}{{profileJson}}')).toEqual({
      valid: false,
      unknownVariables: ['<parse_error>'],
      missingRequired: [],
    });
  });

  it('gives custom.* keys the union of variables and nothing required', () => {
    expect(validateTemplate('custom.x', '', '')).toEqual({ valid: true, unknownVariables: [], missingRequired: [] });
    expect(validateTemplate('custom.x', '{{brief}}{{authoredSamples}}{{feedback}}', '{{#isRevision}}{{/isRevision}}').valid).toBe(true);
    expect(validateTemplate('custom.x', '{{secret}}', '').unknownVariables).toEqual(['secret']);
  });
});

describe('formatters', () => {
  it('formats authored samples', () => {
    expect(
      formatAuthoredSamples([
        { ref: 'A1', kind: 'email', date: '2024-01-02', lang: 'en', text: 'Hello there.' },
        { ref: 'A2', kind: 'note', date: '2024-02-03', lang: null, text: 'Note.' },
      ]),
    ).toBe(
      '<sample ref="A1" kind="email" date="2024-01-02" lang="en">Hello there.</sample>\n' +
        '<sample ref="A2" kind="note" date="2024-02-03" lang="und">Note.</sample>',
    );
  });

  it('formats received context, empty when there is none', () => {
    expect(formatReceivedContext([])).toBe('');
    expect(formatReceivedContext([{ kind: 'email', date: '2024-01-02', text: 'Hi.' }])).toBe(
      '<received_context>\n<item kind="email" date="2024-01-02">Hi.</item>\n</received_context>',
    );
  });

  it('prerenders valueSpec per value type', () => {
    expect(DIMS.map(valueSpec)).toEqual([
      'scale 1-5 (1=very casual, 5=very formal)',
      'one of: short, medium, long',
      'free text',
      'list of short phrases',
    ]);
    expect(formatDimensions(DIMS)[1]).toEqual({
      key: 'sentence_length',
      name: 'Sentence length',
      description: 'Typical sentence length.',
      valueType: 'enum',
      valueSpec: 'one of: short, medium, long',
      guidance: 'Look at averages.',
    });
    expect(formatDimensions(DIMS)[0]!.guidance).toBe('');
  });

  it('serializes dimensions JSON without undefined fields', () => {
    const parsed = JSON.parse(dimensionsJson(DIMS)) as Record<string, unknown>[];
    expect(parsed[0]).toEqual({
      key: 'formality',
      name: 'Formality',
      description: 'How formal or casual the writing is.',
      valueType: 'scale',
      scale: { min: 1, max: 5, minLabel: 'very casual', maxLabel: 'very formal' },
    });
    expect(parsed[1]).toHaveProperty('allowedValues', ['short', 'medium', 'long']);
  });
});

describe('sample helpers', () => {
  it('strips the buildDocument header block only', () => {
    expect(documentBody('Subject: Hi\nDate: 2024-01-02\nDirection: sent\nFrom: Ann <a@example.test>\n\nBody\n\nMore')).toBe(
      'Body\n\nMore',
    );
    expect(documentBody('Title: notes.txt\n\nBody')).toBe('Body');
    expect(documentBody('Just text\n\nwith paragraphs')).toBe('Just text\n\nwith paragraphs');
    expect(documentBody('Plain')).toBe('Plain');
  });

  it('takes the first name token', () => {
    expect(firstName('  Ann  Smith ')).toBe('Ann');
    expect(firstName(null)).toBe('');
    expect(firstName(undefined)).toBe('');
    expect(firstName('   ')).toBe('');
  });
});
