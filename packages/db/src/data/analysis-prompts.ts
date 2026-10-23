import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import {
  promptTemplate,
  promptTemplateVersion,
  toneDefinitionVersion,
  versionActivation,
  type Dimension,
} from '../schema';

// Side-effect free: seed.ts and migrate.ts run on import, so shared text lives here.

export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export interface AnalysisPromptSourceDefinition {
  name: string;
  description: string;
  dimensions: Dimension[];
}

/** Value guidance for one dimension (same logic as core's `valueSpec`, phrased as an instruction). */
export function valueGuidance(d: Dimension): string {
  switch (d.valueType) {
    case 'scale':
      return d.scale
        ? `Rate it on a scale ${d.scale.min}-${d.scale.max} (${d.scale.min}=${d.scale.minLabel}, ${d.scale.max}=${d.scale.maxLabel}).`
        : 'Rate it on a scale.';
    case 'enum':
      return `Pick one of: ${(d.allowedValues ?? []).join(', ')}.`;
    case 'text':
      return 'Describe it in free text.';
    case 'list':
      return 'Give a list of short phrases.';
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** First default analysis prompt for a definition version (FR-025). Pure. */
export function buildAnalysisPromptFromDimensions(def: AnalysisPromptSourceDefinition): string {
  const intro = collapse(`Analyse how the author writes for "${def.name}". ${def.description}`);
  const lines = def.dimensions.map((d) => {
    const body = [d.description, valueGuidance(d), d.guidance ?? '']
      .map(collapse)
      .filter((p) => p !== '')
      .join(' ');
    return collapse(`- ${d.name}: ${body}`);
  });
  return [
    intro,
    '',
    'Write one section for each aspect below. For each aspect, describe how the author does it, with a short explanation based on the samples. Use the value guidance where it is given.',
    '',
    'Aspects:',
    ...lines,
  ]
    .join('\n')
    .trim();
}

export const ANALYSIS_WRAPPER_KEYS = ['tone_profile.generate', 'tone_profile.feedback'] as const;
export type AnalysisWrapperKey = (typeof ANALYSIS_WRAPPER_KEYS)[number];

export const ANALYSIS_WRAPPER_MAX_TOKENS = 16000;
export const ANALYSIS_WRAPPER_EFFORT = 'medium' as const;

const SHARED_RULES = `Never reproduce redaction tokens (for example [REDACTED:...]) or sensitive values; if one appears in the input, omit it.
Never invent facts about the user beyond the supplied content.`;

const DOCUMENT_RULES = `${SHARED_RULES}
Use only the authored samples (refs A1, A2, ...) as evidence of the user's voice; the received context is background only: never quote it, never cite it in excerpts, and never attribute its style to the user.
The analysis instructions in the user turn declare the aspects to cover. Return them in "aspects" (a stable lowercase snake_case "key" and a "name" for each), and write exactly one entry in "sections" per declared aspect, with "aspectKey" matching its key, a short "heading" and a "markdown" body that explains how the author writes, based on the samples.
Fill "summary" with a short overview of the voice, and "doList" and "dontList" (1-10 items each) with actionable guidance.
Include 3-12 short excerpts copied verbatim from the authored samples, each with its "sampleRef" (for example "A3") and the "aspectKeys" it illustrates.
Report the detected languages in "languages" with their share.
Do not draw on excluded categories ({{excludedCategoryLabels}}).
Output JSON only, matching the required document schema.`;

const GENERATE_SYSTEM = `You build tone-of-voice documents from a person's own writing.
${DOCUMENT_RULES}
If an earlier document is supplied, keep it stable unless the new evidence contradicts it.`;

const GENERATE_USER = `Voice: "{{definition.name}}". {{definition.description}}
{{analysisPrompt}}
Evidence written by {{user.firstName}} ({{authoredStats.itemCount}} items, {{authoredStats.wordCount}} words, languages: {{authoredStats.languages}}):
{{authoredSamples}}
Background only, never quote:
{{receivedContext}}
Earlier document, keep stable unless new evidence contradicts it:
{{previousDocumentJson}}
Return JSON only.`;

const FEEDBACK_SYSTEM = `You revise an existing tone-of-voice document according to the user's written feedback.
${DOCUMENT_RULES}
Apply the feedback to the earlier document, changing only what the feedback and the evidence justify, and keep other sections as they are.
Treat the feedback as a user preference, not as evidence of voice: evidence still comes only from the authored samples, and excerpts must remain verbatim.
If the feedback conflicts with the authored evidence, follow the feedback and say so in the affected section.
Output the full revised document in the same schema, not a diff.`;

const FEEDBACK_USER = `Voice: "{{definition.name}}". {{definition.description}}
{{analysisPrompt}}
Earlier document to revise:
{{previousDocumentJson}}
Feedback: {{feedback}}
Evidence written by {{user.firstName}} ({{authoredStats.itemCount}} items, {{authoredStats.wordCount}} words, languages: {{authoredStats.languages}}):
{{authoredSamples}}
Background only, never quote:
{{receivedContext}}
Return the full revised document as JSON only.`;

export const ANALYSIS_WRAPPER_TEMPLATES: Record<
  AnalysisWrapperKey,
  { description: string; systemTemplate: string; userTemplate: string }
> = {
  'tone_profile.generate': {
    description: 'Generates a tone-of-voice document from authored content.',
    systemTemplate: GENERATE_SYSTEM,
    userTemplate: GENERATE_USER,
  },
  'tone_profile.feedback': {
    description: 'Revises a tone-of-voice document using user feedback.',
    systemTemplate: FEEDBACK_SYSTEM,
    userTemplate: FEEDBACK_USER,
  },
};

/**
 * Migration 0007 backfill (FR-025). One transaction, idempotent: both steps filter on "not yet done".
 * A wrapper key without a prompt_template row (migrated but unseeded database) is skipped.
 */
export async function backfillAnalysisPrompts(
  db: Db,
): Promise<{ definitionVersionsUpdated: number; wrappersInserted: string[] }> {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select({
        id: toneDefinitionVersion.id,
        name: toneDefinitionVersion.name,
        description: toneDefinitionVersion.description,
        dimensions: toneDefinitionVersion.dimensions,
      })
      .from(toneDefinitionVersion)
      .where(isNull(toneDefinitionVersion.analysisPrompt));
    for (const v of pending) {
      await tx
        .update(toneDefinitionVersion)
        .set({ analysisPrompt: buildAnalysisPromptFromDimensions(v) })
        .where(and(eq(toneDefinitionVersion.id, v.id), isNull(toneDefinitionVersion.analysisPrompt)));
    }

    const wrappersInserted: string[] = [];
    for (const key of ANALYSIS_WRAPPER_KEYS) {
      const [template] = await tx
        .select({ id: promptTemplate.id, activeVersionId: promptTemplate.activeVersionId })
        .from(promptTemplate)
        .where(eq(promptTemplate.key, key))
        .for('update')
        .limit(1);
      if (!template) continue;

      const [active] = await tx
        .select()
        .from(promptTemplateVersion)
        .where(
          and(eq(promptTemplateVersion.promptTemplateId, template.id), eq(promptTemplateVersion.status, 'active')),
        )
        .limit(1);
      if (
        active &&
        (active.userTemplate.includes('{{analysisPrompt}}') || active.systemTemplate.includes('{{analysisPrompt}}'))
      ) {
        continue;
      }

      const numbers = await tx
        .select({ versionNumber: promptTemplateVersion.versionNumber })
        .from(promptTemplateVersion)
        .where(eq(promptTemplateVersion.promptTemplateId, template.id));
      const nextNumber = Math.max(0, ...numbers.map((n) => n.versionNumber)) + 1;

      const model = active?.model ?? process.env.LLM_PROFILE_MODEL ?? 'claude-sonnet-5-5';
      if (active) {
        await tx
          .update(promptTemplateVersion)
          .set({ status: 'superseded' })
          .where(eq(promptTemplateVersion.id, active.id));
      }
      const wrapper = ANALYSIS_WRAPPER_TEMPLATES[key];
      const [inserted] = await tx
        .insert(promptTemplateVersion)
        .values({
          promptTemplateId: template.id,
          versionNumber: nextNumber,
          status: 'active',
          systemTemplate: wrapper.systemTemplate,
          userTemplate: wrapper.userTemplate,
          model,
          effort: ANALYSIS_WRAPPER_EFFORT,
          maxTokens: ANALYSIS_WRAPPER_MAX_TOKENS,
          changeNote: 'Document-oriented analysis prompt wrapper (spec 002)',
          createdBy: SYSTEM_ACTOR,
          publishedBy: SYSTEM_ACTOR,
          publishedAt: new Date(),
        })
        .returning({ id: promptTemplateVersion.id });
      if (!inserted) throw new Error('wrapper version insert returned no row');
      await tx
        .update(promptTemplate)
        .set({ activeVersionId: inserted.id })
        .where(eq(promptTemplate.id, template.id));
      await tx.insert(versionActivation).values({
        entityType: 'prompt',
        entityId: template.id,
        fromVersionId: active?.id ?? null,
        toVersionId: inserted.id,
        action: 'publish',
        actorUserId: SYSTEM_ACTOR,
      });
      wrappersInserted.push(key);
    }

    return { definitionVersionsUpdated: pending.length, wrappersInserted };
  });
}
