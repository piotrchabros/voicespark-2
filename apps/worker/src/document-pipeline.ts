import { ZodError } from 'zod';
import {
  buildDocumentOutputSchema,
  buildMessages,
  formatAuthoredSamples,
  formatReceivedContext,
  mapExcerptsToItems,
  MAX_LLM_CALLS,
  neutralizeTags,
  postValidateDocument,
  render,
  wrapAnalysisPrompt,
  type DocumentOutput,
  type VoiceDocument,
} from '@voicespark/core/prompting';
import type { Effort, LlmClient } from '@voicespark/integrations/anthropic';

/** The client's error when a response carries no parsed output (`createAnthropicClient`). */
const NO_STRUCTURED_OUTPUT = 'LLM response did not contain structured output';

export interface PipelineSample {
  ref: string;
  contentItemId: string;
  kind: 'email' | 'attachment' | 'file' | 'note';
  date: string;
  lang: string | null;
  text: string;
  wordCount: number;
}

export interface DocumentPipelineInput {
  wrapper: {
    systemTemplate: string;
    userTemplate: string;
    model: string;
    effort: Effort;
    maxTokens: number;
  };
  /** Already inspected (and redacted) by the caller. */
  analysisPromptText: string;
  promptSource: 'default' | 'own';
  definition: { name: string; description: string };
  /** Already inspected. */
  samples: PipelineSample[];
  /** Already inspected; background only, never quotable. */
  received: { kind: string; date: string; text: string }[];
  /** '' when there is no previous document. */
  previousDocumentJson: string;
  /** '' unless this is a feedback generation. */
  feedback: string;
  userFirstName: string;
  excludedCategoryLabels: string;
}

export type DocumentPipelineResult =
  | {
      status: 'done';
      document: VoiceDocument;
      output: DocumentOutput;
      problems: string[];
      calls: number;
    }
  | { status: 'invalid'; problems: string[]; calls: number };

const isUnparseable = (err: unknown) =>
  err instanceof ZodError || (err instanceof Error && err.message === NO_STRUCTURED_OUTPUT);

/**
 * Contract analysis-prompt.md steps 4-5 shared by `profile.generate` and `analysis.preview`: neutralise and wrap the
 * untrusted text, render the wrapper, add guard and reminder, call the model and post-validate, retrying once with the
 * problem codes. The retry text goes before the reminder so the reminder stays last. `LlmRefusedError` and any other
 * error propagate to the caller.
 */
export async function runDocumentPipeline(
  llm: LlmClient,
  input: DocumentPipelineInput,
): Promise<DocumentPipelineResult> {
  const { wrapper, samples } = input;
  const languages = [...new Set(samples.map((s) => s.lang).filter((l): l is string => !!l))];
  const rendered = render(wrapper, {
    definition: input.definition,
    analysisPrompt: wrapAnalysisPrompt(input.analysisPromptText, input.promptSource),
    authoredSamples: formatAuthoredSamples(samples),
    receivedContext: formatReceivedContext(input.received),
    authoredStats: {
      itemCount: samples.length,
      wordCount: samples.reduce((n, s) => n + s.wordCount, 0),
      languages: languages.join(', '),
    },
    previousDocumentJson: input.previousDocumentJson,
    user: { firstName: input.userFirstName },
    excludedCategoryLabels: input.excludedCategoryLabels,
    feedback:
      input.feedback === '' ? '' : `<feedback>\n${neutralizeTags(input.feedback)}\n</feedback>`,
  });
  const schema = buildDocumentOutputSchema();
  const received = input.received.map((r) => r.text);

  let problems: string[] = [];
  for (let call = 1; call <= MAX_LLM_CALLS; call++) {
    const retry =
      call === 1
        ? ''
        : `\n\nThe previous answer had these problems: ${problems.join(', ')}. Return the full corrected JSON.`;
    const { system, user } = buildMessages(
      rendered.system,
      rendered.user + retry,
      input.excludedCategoryLabels,
    );
    let output: DocumentOutput;
    try {
      output = await llm.parseStructured({
        model: wrapper.model,
        effort: wrapper.effort,
        maxTokens: wrapper.maxTokens,
        system,
        user,
        schema,
      });
    } catch (err) {
      if (!isUnparseable(err)) throw err;
      problems = ['output_unparseable'];
      continue;
    }
    const checked = postValidateDocument(output, { samples, received });
    problems = checked.problems;
    if (checked.ok) {
      return {
        status: 'done',
        document: mapExcerptsToItems(checked.cleaned, samples),
        output: checked.cleaned,
        problems,
        calls: call,
      };
    }
  }
  return { status: 'invalid', problems, calls: MAX_LLM_CALLS };
}
