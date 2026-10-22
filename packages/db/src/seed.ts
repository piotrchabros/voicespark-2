import { eq } from 'drizzle-orm';
import { closeDb, withTransaction, type Tx } from './client';
import {
  APP_SETTING_DEFAULTS,
  appSetting,
  promptTemplate,
  promptTemplateVersion,
  toneDefinition,
  toneDefinitionVersion,
  type Dimension,
  type PromptEffort,
  type SystemPromptKey,
} from './schema';

// Seeded rows have no real author; created_by has no FK, so the nil uuid marks "system".
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

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

const DIMENSIONS: Dimension[] = [
  {
    key: 'formality',
    name: 'Formality',
    description: 'How formal or casual the writing is.',
    valueType: 'scale',
    scale: { min: 1, max: 5, minLabel: 'very casual', maxLabel: 'very formal' },
  },
  {
    key: 'warmth',
    name: 'Warmth',
    description: 'How warm and personable the writing feels.',
    valueType: 'scale',
    scale: { min: 1, max: 5, minLabel: 'reserved', maxLabel: 'very warm' },
  },
  {
    key: 'sentence_length',
    name: 'Sentence length',
    description: 'Typical sentence length.',
    valueType: 'enum',
    allowedValues: ['short', 'medium', 'long', 'varied'],
  },
  {
    key: 'vocabulary',
    name: 'Vocabulary',
    description: 'Register of the vocabulary used.',
    valueType: 'enum',
    allowedValues: ['plain', 'professional', 'technical', 'rich'],
  },
  {
    key: 'humour',
    name: 'Humour',
    description: 'How often humour appears.',
    valueType: 'enum',
    allowedValues: ['none', 'light', 'frequent'],
  },
  {
    key: 'signature_phrases',
    name: 'Signature phrases',
    description: 'Phrases the writer habitually uses.',
    valueType: 'list',
  },
];

interface PromptSeed {
  key: SystemPromptKey;
  description: string;
  model: 'profile' | 'draft';
  effort: PromptEffort;
  maxTokens: number;
  systemTemplate: string;
  userTemplate: string;
}

const PROMPTS: PromptSeed[] = [
  {
    key: 'tone_profile.generate',
    description: 'Generates a tone-of-voice profile from authored content.',
    model: 'profile',
    effort: 'high',
    maxTokens: 8192,
    systemTemplate: GENERATE_SYSTEM,
    userTemplate: GENERATE_USER,
  },
  {
    key: 'tone_profile.feedback',
    description: 'Revises a tone-of-voice profile using user feedback.',
    model: 'profile',
    effort: 'high',
    maxTokens: 8192,
    systemTemplate: FEEDBACK_SYSTEM,
    userTemplate: FEEDBACK_USER,
  },
  {
    key: 'draft.social_post',
    description: 'Writes a social post in the selected voice.',
    model: 'draft',
    effort: 'medium',
    maxTokens: 4096,
    systemTemplate: SOCIAL_SYSTEM,
    userTemplate: SOCIAL_USER,
  },
  {
    key: 'draft.bio',
    description: 'Writes a professional bio in the selected voice.',
    model: 'draft',
    effort: 'medium',
    maxTokens: 4096,
    systemTemplate: BIO_SYSTEM,
    userTemplate: BIO_USER,
  },
  {
    key: 'draft.short_article',
    description: 'Writes a short article in the selected voice.',
    model: 'draft',
    effort: 'medium',
    maxTokens: 4096,
    systemTemplate: ARTICLE_SYSTEM,
    userTemplate: ARTICLE_USER,
  },
];

async function seedDefinition(tx: Tx): Promise<void> {
  const [existing] = await tx
    .select({ id: toneDefinition.id })
    .from(toneDefinition)
    .where(eq(toneDefinition.key, 'general_voice'))
    .limit(1);
  if (existing) return;

  const now = new Date();
  const [definition] = await tx
    .insert(toneDefinition)
    .values({ key: 'general_voice', availability: 'available', createdBy: SYSTEM_ACTOR })
    .returning({ id: toneDefinition.id });
  if (!definition) throw new Error('definition insert returned no row');
  const [version] = await tx
    .insert(toneDefinitionVersion)
    .values({
      definitionId: definition.id,
      versionNumber: 1,
      status: 'active',
      name: 'General voice',
      description: 'A general-purpose description of how you write: formality, warmth and style.',
      dimensions: DIMENSIONS,
      createdBy: SYSTEM_ACTOR,
      publishedBy: SYSTEM_ACTOR,
      publishedAt: now,
    })
    .returning({ id: toneDefinitionVersion.id });
  if (!version) throw new Error('definition version insert returned no row');
  await tx.update(toneDefinition).set({ activeVersionId: version.id }).where(eq(toneDefinition.id, definition.id));
}

async function seedPrompts(tx: Tx): Promise<void> {
  const profileModel = process.env.LLM_PROFILE_MODEL || 'claude-sonnet-5-5';
  const draftModel = process.env.LLM_DRAFT_MODEL || 'claude-sonnet-5-5';
  const now = new Date();

  for (const p of PROMPTS) {
    const [existing] = await tx
      .select({ id: promptTemplate.id })
      .from(promptTemplate)
      .where(eq(promptTemplate.key, p.key))
      .limit(1);
    if (existing) continue;

    const [template] = await tx
      .insert(promptTemplate)
      .values({ key: p.key, isSystem: true, description: p.description, createdBy: SYSTEM_ACTOR })
      .returning({ id: promptTemplate.id });
    if (!template) throw new Error('prompt insert returned no row');
    const [version] = await tx
      .insert(promptTemplateVersion)
      .values({
        promptTemplateId: template.id,
        versionNumber: 1,
        status: 'active',
        systemTemplate: p.systemTemplate,
        userTemplate: p.userTemplate,
        model: p.model === 'profile' ? profileModel : draftModel,
        effort: p.effort,
        maxTokens: p.maxTokens,
        changeNote: 'Initial seeded version',
        createdBy: SYSTEM_ACTOR,
        publishedBy: SYSTEM_ACTOR,
        publishedAt: now,
      })
      .returning({ id: promptTemplateVersion.id });
    if (!version) throw new Error('prompt version insert returned no row');
    await tx
      .update(promptTemplate)
      .set({ activeVersionId: version.id })
      .where(eq(promptTemplate.id, template.id));
  }
}

async function seedSettings(tx: Tx): Promise<void> {
  for (const [key, value] of Object.entries(APP_SETTING_DEFAULTS)) {
    await tx.insert(appSetting).values({ key, value }).onConflictDoNothing({ target: appSetting.key });
  }
}

export async function seed(): Promise<void> {
  await withTransaction(async (tx) => {
    await seedDefinition(tx);
    await seedPrompts(tx);
    await seedSettings(tx);
  });
}

seed()
  .then(() => closeDb())
  .then(() => {
    console.log('seed applied');
  })
  .catch(async (err: unknown) => {
    console.error('seed failed', err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
