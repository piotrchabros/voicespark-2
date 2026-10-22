import { z } from 'zod';
import { CLASSIFIER_CATEGORIES, type ClassifierCategory } from '../categories';
import { buildClassifierUserMessage, CLASSIFIER_SYSTEM_PROMPT } from './prompt';

export { CLASSIFIER_SYSTEM_PROMPT } from './prompt';

export interface ClassifierOutput {
  spans: { category: ClassifierCategory; text: string }[];
  mostlySensitive: boolean;
}

export const classifierOutputSchema: z.ZodType<ClassifierOutput> = z.object({
  spans: z.array(
    z.object({
      category: z.enum(['health', 'special_category', 'third_party_contacts']),
      text: z.string().min(1),
    }),
  ),
  mostlySensitive: z.boolean(),
});

export interface Classifier {
  /** `text` must already be credential-redacted; it is the only content sent to the model. */
  classify(
    text: string,
    opts?: { categories?: readonly ClassifierCategory[] },
  ): Promise<ClassifierOutput>;
}

export type ParseStructuredFn = <T>(args: {
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  system: string;
  user: string;
  schema: z.ZodType<T>;
}) => Promise<T>;

/** Thrown when every attempt failed. The message never includes document text or model output. */
export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierError';
  }
}

export interface HaikuClassifierDeps {
  parseStructured: ParseStructuredFn;
  model: string;
  /** Total attempts, default 3. */
  attempts?: number;
}

export function createHaikuClassifier(deps: HaikuClassifierDeps): Classifier {
  const attempts = deps.attempts ?? 3;
  return {
    async classify(text, opts) {
      const categories = opts?.categories?.length ? opts.categories : CLASSIFIER_CATEGORIES;
      const user = buildClassifierUserMessage(text, categories);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const out = await deps.parseStructured({
            model: deps.model,
            effort: 'low',
            maxTokens: 1024,
            system: CLASSIFIER_SYSTEM_PROMPT,
            user,
            schema: classifierOutputSchema,
          });
          // Drop spans for categories that were not requested.
          return {
            spans: out.spans.filter((s) => categories.includes(s.category)),
            mostlySensitive: out.mostlySensitive,
          };
        } catch {
          // Error details are dropped deliberately: they may echo document content.
        }
      }
      throw new ClassifierError(`classifier failed after ${attempts} attempts`);
    },
  };
}
