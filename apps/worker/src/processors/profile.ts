import { UnrecoverableError, type Job } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { contentItemOccurrence, getDb, type GenerationBlockReason, type ToneDefinitionVersion } from '@voicespark/db';
import {
  listActiveAuthored,
  listActiveReceived,
  type AuthoredItemSummary,
} from '@voicespark/db/repos/user/content-items';
import { jobLogger } from '@voicespark/core/logger';
import {
  buildProfileOutputSchema,
  dimensionsJson,
  documentBody,
  firstName,
  formatAuthoredSamples,
  formatDimensions,
  formatReceivedContext,
  postValidateProfile,
  render,
  RECEIVED_CONTEXT_LIMIT,
  SAMPLE_CHAR_BUDGET,
  toPromptProfileJson,
  type ProfileBody,
  type SampleInput,
} from '@voicespark/core/prompting';
import type { JobPayload } from '@voicespark/core/queues';
import { inspectForUser, loadOwnAddresses, loadPolicy } from '@voicespark/core/services/inspection';
import * as profiles from '@voicespark/core/services/profiles';
import { labelFor, type Classifier, type CountCategory, type InspectionInput, type Policy } from '@voicespark/filters';
import { LlmRefusedError, type Effort } from '@voicespark/integrations/anthropic';
import { META, memoryFilter, namespaceFor, type MemoryStore } from '@voicespark/integrations/supermemory';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';

/** Supermemory list page size while collecting authored document ids. */
const LIST_PAGE_SIZE = 100;
/** Model calls per run: the first answer plus one retry when post-validation fails (D-P6). */
const MAX_LLM_CALLS = 2;

export type ProfileRunResult =
  | { outcome: 'succeeded'; versionId: string }
  | { outcome: 'blocked'; blockReason: GenerationBlockReason }
  | { outcome: 'failed'; errorCode: string }
  | { outcome: 'skipped' };

type ProfileDeps = Pick<WorkerDeps, 'store' | 'classifier' | 'llm'>;
type ProfileJob = Job<JobPayload<'profile.generate'>, unknown, 'profile.generate'>;

interface Inspector {
  (input: Omit<InspectionInput, 'ownAddresses'>): Promise<string | null>;
}

interface Sample {
  ref: string;
  contentItemId: string;
  parentItemId: string | null;
  kind: SampleInput['kind'];
  date: string;
  lang: string | null;
  wordCount: number;
  text: string;
}

const HEADER_LINE = /^(Subject|Title|Date|Direction|From): ?(.*)$/;

/** Filtered body of a `buildDocument` output plus the header fields rules may match on. */
function splitDocument(content: string): Pick<InspectionInput, 'subject' | 'title' | 'headers' | 'bodyText'> {
  const bodyText = documentBody(content);
  const out: Pick<InspectionInput, 'subject' | 'title' | 'headers' | 'bodyText'> = { bodyText, headers: {} };
  if (bodyText === content) return out;
  for (const line of content.slice(0, content.indexOf('\n\n')).split('\n')) {
    const m = HEADER_LINE.exec(line);
    if (m?.[1] === 'Subject') out.subject = m[2];
    else if (m?.[1] === 'Title') out.title = m[2];
    else if (m?.[1] === 'From') out.headers = { from: m[2] };
  }
  return out;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Inspection under the user's current policy (fails closed): the filtered text, or null when excluded. */
function inspectorFor(
  userId: string,
  opts: { policy: Policy; ownAddresses: string[]; classifier: Classifier },
): Inspector {
  return async (input) => {
    const result = await inspectForUser(userId, input, opts);
    return result.outcome === 'accepted' ? (result.text ?? '') : null;
  };
}

/** Ids of the authored documents in the user's namespace (any order; Postgres decides recency). */
async function authoredDocumentIds(store: MemoryStore, ns: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const filter = memoryFilter.eq(META.authorship, 'authored');
  for (let page = 1; ; page++) {
    const res = await store.listDocuments(ns, { filter, page, limit: LIST_PAGE_SIZE });
    for (const doc of res.documents) {
      const fromMeta = doc.metadata[META.contentItemId];
      ids.add(typeof fromMeta === 'string' ? fromMeta : doc.id);
    }
    if (!res.hasMore || res.documents.length === 0) return ids;
  }
}

/** Re-inspected text of one stored item, or null when it is gone or now excluded. */
async function inspectedItem(
  store: MemoryStore,
  ns: string,
  row: AuthoredItemSummary,
  inspect: Inspector,
): Promise<string | null> {
  const doc = await store.getDocument(ns, row.id);
  if (!doc) return null;
  const text = await inspect({ kind: row.kind, folders: [], ...splitDocument(doc.content) });
  return text === null || text.trim() === '' ? null : text;
}

/** Newest-first authored samples under SAMPLE_CHAR_BUDGET, each re-inspected (D-P3). */
async function loadSamples(store: MemoryStore, userId: string, inspect: Inspector): Promise<Sample[]> {
  const ns = namespaceFor(userId);
  const stored = await authoredDocumentIds(store, ns);
  const samples: Sample[] = [];
  let chars = 0;
  for (const row of await listActiveAuthored({ userId })) {
    if (!stored.has(row.id)) continue;
    const text = await inspectedItem(store, ns, row, inspect);
    if (text === null) continue;
    if (chars + text.length > SAMPLE_CHAR_BUDGET) break;
    chars += text.length;
    samples.push({
      ref: `A${samples.length + 1}`,
      contentItemId: row.id,
      parentItemId: row.parentItemId,
      kind: row.kind,
      date: isoDate(row.itemDate),
      lang: row.languageCode,
      wordCount: row.wordCount,
      text,
    });
  }
  return samples;
}

/** Up to RECEIVED_CONTEXT_LIMIT received items, re-inspected; background only, never quotable. */
async function loadReceivedContext(store: MemoryStore, userId: string, inspect: Inspector): Promise<string> {
  const ns = namespaceFor(userId);
  const items: { kind: string; date: string; text: string }[] = [];
  for (const row of await listActiveReceived({ userId }, RECEIVED_CONTEXT_LIMIT)) {
    const text = await inspectedItem(store, ns, row, inspect);
    if (text !== null) items.push({ kind: row.kind, date: isoDate(row.itemDate), text });
  }
  return formatReceivedContext(items);
}

/** Sources the samples (or the items they are parts of) were imported from. */
async function contributingSourceIds(samples: Sample[]): Promise<string[]> {
  const itemIds = [
    ...new Set(samples.flatMap((s) => (s.parentItemId ? [s.contentItemId, s.parentItemId] : [s.contentItemId]))),
  ];
  if (itemIds.length === 0) return [];
  const rows = await getDb()
    .selectDistinct({ sourceId: contentItemOccurrence.sourceId })
    .from(contentItemOccurrence)
    .where(inArray(contentItemOccurrence.contentItemId, itemIds));
  return rows.map((r) => r.sourceId).sort();
}

function distinctLanguages(samples: Sample[]): string[] {
  return [...new Set(samples.map((s) => s.lang).filter((l): l is string => !!l))];
}

async function generateValidated(
  deps: ProfileDeps,
  prompt: { system: string; user: string },
  pinned: { model: string; effort: Effort; maxTokens: number },
  dv: ToneDefinitionVersion,
  samples: Sample[],
): Promise<ProfileBody | null> {
  const schema = buildProfileOutputSchema(dv);
  for (let call = 0; call < MAX_LLM_CALLS; call++) {
    const output = await deps.llm.parseStructured({ ...pinned, ...prompt, schema });
    const checked = postValidateProfile(output, dv, samples);
    if (checked.ok) return checked.body;
  }
  return null;
}

/** One `profile.generate` run (T120, jobs.md behavior 4). Every LLM input is re-inspected under current preferences. */
async function runGeneration(job: ProfileJob, deps: ProfileDeps): Promise<ProfileRunResult> {
  const { generationId } = job.data;
  const log = jobLogger(job.id ?? generationId, { entityId: generationId });
  const run = await profiles.loadGenerationForRun(generationId);
  if (!run || (run.generation.status !== 'queued' && run.generation.status !== 'running')) {
    return { outcome: 'skipped' };
  }
  const { generation, profile, definition, definitionVersion: dv, promptVersion, user, latestVersion } = run;
  const userId = generation.userId;
  if (user.status !== 'active') {
    await profiles.failGeneration(generationId, 'user_inactive');
    return { outcome: 'failed', errorCode: 'user_inactive' };
  }

  const block = async (blockReason: GenerationBlockReason): Promise<ProfileRunResult> => {
    await profiles.blockGeneration(generationId, blockReason);
    log.info({ status: 'blocked', errorCode: blockReason });
    return { outcome: 'blocked', blockReason };
  };
  const fail = async (errorCode: string): Promise<ProfileRunResult> => {
    await profiles.failGeneration(generationId, errorCode, { notify: true });
    log.warn({ status: 'failed', errorCode });
    return { outcome: 'failed', errorCode };
  };

  if (definition.availability !== 'available') return block('definition_retired');
  if (profile.status !== 'active' || !run.choiceActive) return block('definition_not_chosen');
  const eligibility = await profiles.eligibility({ userId });
  if (!eligibility.eligible) return block('insufficient_content');

  await profiles.markRunning(generationId);
  const { policy } = await loadPolicy(userId);
  const ownAddresses = await loadOwnAddresses(userId);
  const inspect = inspectorFor(userId, { policy, ownAddresses, classifier: deps.classifier });

  // Feedback first: a wholly excluded feedback ends the run before any content is loaded or sent.
  let feedback = '';
  if (generation.kind === 'feedback') {
    const raw = profiles.decryptGenerationFeedback(generation);
    const filtered = raw === null ? null : await inspect({ kind: 'note', bodyText: raw, headers: {}, folders: [] });
    if (filtered === null || filtered.trim() === '') return fail('feedback_excluded');
    feedback = filtered;
  }

  const samples = await loadSamples(deps.store, userId, inspect);
  if (samples.length === 0) return block('insufficient_content');
  const receivedContext = await loadReceivedContext(deps.store, userId, inspect);

  let previousProfileJson = '';
  if (latestVersion) {
    const json = toPromptProfileJson(profiles.decryptVersionBody(latestVersion));
    previousProfileJson = (await inspect({ kind: 'note', bodyText: json, headers: {}, folders: [] })) ?? '';
  }

  const languages = distinctLanguages(samples);
  const prompt = render(promptVersion, {
    definition: {
      name: dv.name,
      description: dv.description,
      dimensionsJson: dimensionsJson(dv.dimensions),
      dimensions: formatDimensions(dv.dimensions),
    },
    authoredSamples: formatAuthoredSamples(samples),
    receivedContext,
    authoredStats: {
      itemCount: samples.length,
      wordCount: samples.reduce((n, s) => n + s.wordCount, 0),
      languages: languages.join(', '),
    },
    previousProfileJson,
    user: { firstName: firstName(user.name) },
    excludedCategoryLabels: policy.selectedCategories.map((c) => labelFor(c as CountCategory)).join(', '),
    feedback,
  });

  const body = await generateValidated(
    deps,
    prompt,
    { model: promptVersion.model, effort: promptVersion.effort, maxTokens: promptVersion.maxTokens },
    dv,
    samples,
  );
  if (!body) {
    await fail('invalid_output');
    throw new UnrecoverableError('invalid_output');
  }

  const bodyLanguages = [...new Set(body.languages.map((l) => l.code).filter(Boolean))];
  const { versionId } = await profiles.storeGeneratedVersion(generationId, {
    body,
    languages: bodyLanguages.length > 0 ? bodyLanguages : languages,
    contributingSourceIds: await contributingSourceIds(samples),
    contributingItemCount: samples.length,
    authoredWordsNow: eligibility.authoredWordCount,
  });
  log.info({ status: 'succeeded', count: samples.length });
  return { outcome: 'succeeded', versionId };
}

/**
 * `profile.generate` (T120). Blocks (retired definition, removed choice, too little content) and wholly excluded
 * feedback end the run without an LLM call; a refusal or output that fails post-validation twice is final; any
 * other error is retried and marks the generation `generation_failed` on the last attempt.
 */
export function createProfileHandler(overrides: Partial<WorkerDeps> = {}): Handler<'profile.generate'> {
  let deps: ProfileDeps | undefined;
  return async (job) => {
    const { generationId } = job.data;
    try {
      deps ??= defaultDeps(overrides);
      return await runGeneration(job, deps);
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;
      if (err instanceof LlmRefusedError) {
        await profiles.failGeneration(generationId, 'llm_refused', { notify: true });
        jobLogger(job.id ?? generationId, { entityId: generationId }).warn({ status: 'failed', errorCode: 'llm_refused' });
        throw new UnrecoverableError('llm_refused');
      }
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt) await profiles.failGeneration(generationId, 'generation_failed', { notify: true });
      throw err;
    }
  };
}

export const handlers: HandlerMap = {
  'profile.generate': createProfileHandler(),
};
