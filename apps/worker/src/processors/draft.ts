import { UnrecoverableError, type Job } from 'bullmq';
import { loadEnv } from '@voicespark/core/env';
import { jobLogger } from '@voicespark/core/logger';
import {
  applyWordCap,
  buildDraftOutputSchema,
  CONTENT_TYPE_LABEL,
  documentBody,
  firstName,
  render,
  toPromptProfileJson,
} from '@voicespark/core/prompting';
import type { JobPayload } from '@voicespark/core/queues';
import * as drafts from '@voicespark/core/services/drafts';
import { inspectForUser, loadOwnAddresses, loadPolicy } from '@voicespark/core/services/inspection';
import { getSetting } from '@voicespark/core/services/settings';
import { labelFor, type CountCategory } from '@voicespark/filters';
import { LlmRefusedError } from '@voicespark/integrations/anthropic';
import { namespaceFor } from '@voicespark/integrations/supermemory';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';

export type DraftRunResult =
  | { outcome: 'ready'; durationMs: number }
  | { outcome: 'failed'; errorCode: string; durationMs: number }
  | { outcome: 'skipped' };

type DraftDeps = Pick<WorkerDeps, 'store' | 'classifier' | 'llm'>;
type DraftJob = Job<JobPayload<'draft.generate'>, unknown, 'draft.generate'>;

/** Inspects one text under the user's current policy: the filtered text, or null when wholly excluded. */
type Inspector = (text: string) => Promise<string | null>;

/** One `draft.generate` run (T152, jobs.md behavior 5). Every LLM input is inspected under current preferences. */
async function runDraft(job: DraftJob, deps: DraftDeps): Promise<DraftRunResult> {
  const started = Date.now();
  const { draftId, userId } = job.data;
  const log = jobLogger(job.id ?? draftId, { entityId: draftId });
  const run = await drafts.loadDraftForRun(draftId);
  if (!run || run.draft.userId !== userId || (run.draft.status !== 'queued' && run.draft.status !== 'generating')) {
    return { outcome: 'skipped' };
  }

  let redactions = 0;
  const fail = async (errorCode: string, notify = true): Promise<DraftRunResult> => {
    await drafts.failDraft(draftId, errorCode, { notify, redactionsApplied: redactions });
    log.warn({ status: 'failed', errorCode });
    return { outcome: 'failed', errorCode, durationMs: Date.now() - started };
  };

  if (run.user.status !== 'active') return fail('user_inactive', false);
  if (!run.profileVersion) return fail('profile_deleted');
  if (!(await drafts.markGenerating(draftId))) return { outcome: 'skipped' };

  const { policy } = await loadPolicy(userId);
  const ownAddresses = await loadOwnAddresses(userId);
  const inspect: Inspector = async (text) => {
    const result = await inspectForUser(
      userId,
      { kind: 'note', bodyText: text, headers: {}, folders: [] },
      { policy, ownAddresses, classifier: deps.classifier },
    );
    if (result.outcome !== 'accepted') return null;
    redactions += result.counts.reduce((n, c) => n + c.redactedValues, 0);
    return result.text ?? '';
  };
  const usable = (text: string | null) => (text === null || text.trim() === '' ? null : text);
  const inputs = drafts.decryptDraftInputs(run);

  // Brief first: a wholly excluded brief ends the run before the profile, memory or model are touched.
  const brief = usable(await inspect(inputs.brief));
  if (brief === null) return fail('brief_excluded');

  // Profile JSON and summary are inspected separately (D-D8).
  const body = inputs.profileBody!;
  const profileJson = usable(await inspect(toPromptProfileJson(body)));
  if (profileJson === null) return fail('profile_excluded');
  const profileSummary = (await inspect(body.summary)) ?? '';

  const feedback = inputs.feedback === null ? '' : ((await inspect(inputs.feedback)) ?? '');
  const previousDraft = inputs.previousDraft === null ? '' : ((await inspect(inputs.previousDraft)) ?? '');

  // Memory only from the user's own namespace, searched with the INSPECTED brief; nothing is written back.
  const hits = await deps.store.search(namespaceFor(userId), {
    query: brief,
    limit: await getSetting('draft.memory_context_limit'),
  });
  const snippets: string[] = [];
  for (const hit of hits) {
    const text = usable(await inspect(documentBody(hit.content)));
    if (text !== null) snippets.push(`<memory ref="M${snippets.length + 1}">${text}</memory>`);
  }

  const type = run.draft.contentType;
  const version = run.promptVersion;
  const languageHint = [...body.languages].sort((a, b) => b.share - a.share)[0]?.code ?? '';
  const prompt = render(version, {
    brief,
    profileJson,
    contentTypeLabel: CONTENT_TYPE_LABEL[type],
    profileSummary,
    definitionName: run.definitionName ?? '',
    memoryContext: snippets.join('\n'),
    previousDraft,
    feedback,
    isRevision: run.draft.parentDraftId !== null,
    excludedCategoryLabels: policy.selectedCategories.map((c) => labelFor(c as CountCategory)).join(', '),
    user: { firstName: firstName(run.user.name) },
    languageHint,
  });

  const output = await deps.llm.parseStructured({
    model: version.model || loadEnv().LLM_DRAFT_MODEL,
    effort: version.effort,
    maxTokens: version.maxTokens,
    ...prompt,
    schema: buildDraftOutputSchema(type),
  });
  const capped = applyWordCap(type, output);

  // The output is inspected too: any hit is redacted and counted; a wholly excluded body fails (D-D9).
  const text = usable(await inspect(capped.body));
  if (text === null) return fail('output_excluded');
  const title = capped.title === null ? null : usable(await inspect(capped.title));
  const notes = capped.notes === null ? null : usable(await inspect(capped.notes));

  await drafts.completeDraft(draftId, {
    title,
    body: text,
    notes,
    truncated: capped.truncated,
    redactionsApplied: redactions,
  });
  const durationMs = Date.now() - started;
  log.info({ status: 'ready', count: snippets.length, durationMs });
  return { outcome: 'ready', durationMs };
}

/**
 * `draft.generate` (T152). An excluded brief or profile, a deleted profile version and an inactive user end the run
 * without an LLM call; a refusal is final; any other error is retried and marks the draft `generation_failed` on
 * the last attempt.
 */
export function createDraftHandler(overrides: Partial<WorkerDeps> = {}): Handler<'draft.generate'> {
  let deps: DraftDeps | undefined;
  return async (job) => {
    const { draftId } = job.data;
    try {
      deps ??= defaultDeps(overrides);
      return await runDraft(job, deps);
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;
      const log = jobLogger(job.id ?? draftId, { entityId: draftId });
      if (err instanceof LlmRefusedError) {
        await drafts.failDraft(draftId, 'llm_refused', { notify: true });
        log.warn({ status: 'failed', errorCode: 'llm_refused' });
        throw new UnrecoverableError('llm_refused');
      }
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt) {
        await drafts.failDraft(draftId, 'generation_failed', { notify: true });
        log.warn({ status: 'failed', errorCode: 'generation_failed' });
      }
      throw err;
    }
  };
}

export const handlers: HandlerMap = {
  'draft.generate': createDraftHandler(),
};
