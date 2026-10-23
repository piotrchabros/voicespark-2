import { eq } from 'drizzle-orm';
import { getDb, user } from '@voicespark/db';
import { loadEnv } from '@voicespark/core/env';
import { jobLogger } from '@voicespark/core/logger';
import {
  createFakeGenerationLlm,
  documentToMarkdown,
  PREVIEW_SAMPLES,
} from '@voicespark/core/prompting';
import * as definitions from '@voicespark/core/services/definitions';
import * as prompts from '@voicespark/core/services/prompts';
import { FILTER_CATEGORIES } from '@voicespark/filters';
import { createLlm, LlmRefusedError, type LlmClient } from '@voicespark/integrations/anthropic';
import type { WorkerDeps } from '../deps';
import { runDocumentPipeline } from '../document-pipeline';
import type { Handler, HandlerMap } from '../handlers';

/** Stands in for the user's first name in the synthetic run. */
const PREVIEW_FIRST_NAME = 'Sample';

export interface AnalysisPreviewResult {
  status: 'done' | 'failed';
  markdown: string | null;
  problems: string[];
}

const failed = (...problems: string[]): AnalysisPreviewResult => ({
  status: 'failed',
  markdown: null,
  problems,
});

async function isActiveAdmin(adminId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ role: user.role, status: user.status })
    .from(user)
    .where(eq(user.id, adminId))
    .limit(1);
  return row?.role === 'admin' && row.status === 'active';
}

/**
 * `analysis.preview` (T035, jobs.md behavior 10): runs a definition version's analysis prompt through the active
 * `tone_profile.generate` wrapper over the built-in synthetic samples. Reads no user content, never calls Supermemory
 * and writes nothing. Expected failures are returned as the result; anything else throws (attempts 1, so final).
 */
export function createAnalysisPreviewHandler(
  overrides: Partial<WorkerDeps> = {},
): Handler<'analysis.preview'> {
  let llm: LlmClient | undefined = overrides.llm;
  return async (job) => {
    const { definitionVersionId, adminId } = job.data;
    const log = jobLogger(job.id ?? definitionVersionId, { entityId: definitionVersionId });
    const finish = (result: AnalysisPreviewResult): AnalysisPreviewResult => {
      // Problem codes as count keys: SafeLogFields has no free-form list.
      const counts: Record<string, number> = {};
      for (const p of result.problems) counts[p] = (counts[p] ?? 0) + 1;
      log.info({ status: result.status, count: result.problems.length, counts });
      return result;
    };

    if (!(await isActiveAdmin(adminId))) return finish(failed('admin_required'));
    const dv = await definitions.getVersionForGeneration(definitionVersionId);
    if (!dv) return finish(failed('not_found'));
    if (!dv.analysisPrompt || dv.analysisPrompt.trim() === '')
      return finish(failed('analysis_prompt_missing'));
    const wrapper = await prompts.getActiveVersion('tone_profile.generate');
    if (!wrapper) return finish(failed('not_found'));

    // Only the LLM is resolved: a preview has no user data, so the store and classifier are never built.
    llm ??= createLlm(loadEnv(), createFakeGenerationLlm());
    try {
      const result = await runDocumentPipeline(llm, {
        wrapper,
        analysisPromptText: dv.analysisPrompt,
        promptSource: 'default',
        definition: { name: dv.name, description: dv.description },
        samples: PREVIEW_SAMPLES.authored,
        received: PREVIEW_SAMPLES.received,
        previousDocumentJson: '',
        feedback: '',
        userFirstName: PREVIEW_FIRST_NAME,
        excludedCategoryLabels: FILTER_CATEGORIES.map((c) => c.label).join(', '),
      });
      if (result.status === 'invalid') return finish(failed('invalid_output', ...result.problems));
      return finish({
        status: 'done',
        markdown: documentToMarkdown(result.document),
        problems: result.problems,
      });
    } catch (err) {
      if (err instanceof LlmRefusedError) return finish(failed('llm_refused'));
      throw err;
    }
  };
}

export const handlers: HandlerMap = {
  'analysis.preview': createAnalysisPreviewHandler(),
};
