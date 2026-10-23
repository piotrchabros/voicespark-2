import { UnrecoverableError, type Job } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { contentItemOccurrence, getDb, type GenerationBlockReason } from '@voicespark/db';
import {
  listActiveAuthored,
  listActiveReceived,
  type AuthoredItemSummary,
} from '@voicespark/db/repos/user/content-items';
import { jobLogger } from '@voicespark/core/logger';
import {
  documentBody,
  firstName,
  RECEIVED_CONTEXT_LIMIT,
  SAMPLE_CHAR_BUDGET,
  structuredToDocument,
  toPromptDocumentJson,
  type SampleInput,
  type VoiceDocument,
} from '@voicespark/core/prompting';
import type { JobPayload } from '@voicespark/core/queues';
import * as definitions from '@voicespark/core/services/definitions';
import { inspectForUser, loadOwnAddresses, loadPolicy } from '@voicespark/core/services/inspection';
import * as profiles from '@voicespark/core/services/profiles';
import {
  labelFor,
  type Classifier,
  type CountCategory,
  type InspectionInput,
  type InspectionResult,
  type Policy,
} from '@voicespark/filters';
import { LlmRefusedError } from '@voicespark/integrations/anthropic';
import { META, memoryFilter, namespaceFor, type MemoryStore } from '@voicespark/integrations/supermemory';
import { defaultDeps, type WorkerDeps } from '../deps';
import { runDocumentPipeline } from '../document-pipeline';
import type { Handler, HandlerMap } from '../handlers';

/** Supermemory list page size while collecting authored document ids. */
const LIST_PAGE_SIZE = 100;
/** Output inspection needs at least this many excerpts left (contract "Output inspection"). */
const MIN_EXCERPTS = 3;

/**
 * An `inspect()` of the own prompt, feedback or output that could not complete (Principle VI). Retryable: the
 * handler lets the queue back off and marks the generation `inspection_failed` only on the last attempt.
 */
export class InspectionIncompleteError extends Error {
  readonly code = 'inspection_failed';
  constructor() {
    super('inspection_failed');
    this.name = 'InspectionIncompleteError';
  }
}

export type ProfileRunResult =
  | { outcome: 'succeeded'; versionId: string }
  | { outcome: 'blocked'; blockReason: GenerationBlockReason }
  | { outcome: 'failed'; errorCode: string }
  | { outcome: 'skipped' };

type ProfileDeps = Pick<WorkerDeps, 'store' | 'classifier' | 'llm'>;
type ProfileJob = Job<JobPayload<'profile.generate'>, unknown, 'profile.generate'>;

type InspectArgs = Omit<InspectionInput, 'ownAddresses'>;

/** 001 behaviour (samples, received context, previous version): the filtered text, or null when excluded. */
interface Inspector {
  (input: InspectArgs): Promise<string | null>;
}

/** Fail-closed variant for the own prompt, feedback and output: the full result, or a throw when incomplete. */
interface StrictInspector {
  (input: InspectArgs): Promise<InspectionResult>;
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

interface ReceivedItem {
  kind: string;
  date: string;
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

const noteInput = (bodyText: string): InspectArgs => ({ kind: 'note', bodyText, headers: {}, folders: [] });

const isIncomplete = (r: InspectionResult) => r.counts.some((c) => c.category === 'inspection_failed');
const isRedacted = (r: InspectionResult) => r.counts.some((c) => c.redactedValues > 0);

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

/** Like `inspectorFor`, but an inspection that cannot complete throws instead of reading as an exclusion. */
function strictInspectorFor(
  userId: string,
  opts: { policy: Policy; ownAddresses: string[]; classifier: Classifier },
): StrictInspector {
  return async (input) => {
    const result = await inspectForUser(userId, input, opts);
    if (isIncomplete(result)) throw new InspectionIncompleteError();
    return result;
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
async function loadReceivedContext(store: MemoryStore, userId: string, inspect: Inspector): Promise<ReceivedItem[]> {
  const ns = namespaceFor(userId);
  const items: ReceivedItem[] = [];
  for (const row of await listActiveReceived({ userId }, RECEIVED_CONTEXT_LIMIT)) {
    const text = await inspectedItem(store, ns, row, inspect);
    if (text !== null) items.push({ kind: row.kind, date: isoDate(row.itemDate), text });
  }
  return items;
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

/** `previousDocumentJson`: the latest version as prompt JSON (legacy rows converted), or '' when wholly excluded. */
async function previousDocumentJson(
  latest: NonNullable<Awaited<ReturnType<typeof profiles.loadGenerationForRun>>>['latestVersion'],
  inspect: Inspector,
): Promise<string> {
  if (!latest) return '';
  const view = profiles.decryptVersionBody(latest);
  const doc =
    view.format === 'document'
      ? view.body
      : structuredToDocument(
          view.body,
          (await definitions.getVersionForGeneration(latest.definitionVersionId))?.dimensions,
        );
  return (await inspect(noteInput(toPromptDocumentJson(doc)))) ?? '';
}

/** A string field of the output after its own inspection: the (redacted) text, or null when wholly excluded. */
async function inspectField(text: string, inspect: StrictInspector): Promise<string | null> {
  const r = await inspect(noteInput(text));
  return r.outcome === 'accepted' ? (r.text ?? '') : null;
}

/**
 * Contract "Output inspection": every text of the document joined and inspected once; on a hit, each field alone.
 * A wholly excluded summary, or a required part left empty, gives null (`output_excluded`); other excluded
 * fields are replaced (heading: aspect name, markdown: '', list item or excerpt: dropped). Redacted text is kept,
 * except in excerpts, which must stay verbatim and are dropped instead.
 */
async function inspectOutput(doc: VoiceDocument, inspect: StrictInspector): Promise<VoiceDocument | null> {
  const joined = [
    doc.summary,
    ...doc.sections.flatMap((s) => [s.heading, s.markdown]),
    ...doc.doList,
    ...doc.dontList,
    ...doc.excerpts.map((x) => x.text),
  ].join('\n\n');
  const once = await inspect(noteInput(joined));
  if (once.outcome === 'accepted' && !isRedacted(once)) return doc;

  const summary = await inspectField(doc.summary, inspect);
  if (summary === null || summary.trim() === '') return null;
  const nameOf = (key: string) => doc.aspects.find((a) => a.key === key)?.name ?? key;
  const sections: VoiceDocument['sections'] = [];
  for (const s of doc.sections) {
    const heading = await inspectField(s.heading, inspect);
    const markdown = await inspectField(s.markdown, inspect);
    sections.push({ aspectKey: s.aspectKey, heading: heading ?? nameOf(s.aspectKey), markdown: markdown ?? '' });
  }
  const list = async (items: string[]): Promise<string[]> => {
    const kept: string[] = [];
    for (const item of items) {
      const text = await inspectField(item, inspect);
      if (text !== null && text.trim() !== '') kept.push(text);
    }
    return kept;
  };
  const doList = await list(doc.doList);
  const dontList = await list(doc.dontList);
  const excerpts: VoiceDocument['excerpts'] = [];
  for (const x of doc.excerpts) {
    const r = await inspect(noteInput(x.text));
    if (r.outcome === 'accepted' && !isRedacted(r)) excerpts.push(x);
  }
  if (doList.length === 0 || dontList.length === 0 || excerpts.length < MIN_EXCERPTS) return null;
  return { ...doc, summary, sections, doList, dontList, excerpts };
}

/** Log-safe view of a pipeline result: the call count and each problem code with its occurrences (no text). */
function problemCounts(result: { calls: number; problems: string[] }): Record<string, number> {
  const counts: Record<string, number> = { calls: result.calls };
  for (const code of result.problems) counts[code] = (counts[code] ?? 0) + 1;
  return counts;
}

/** One `profile.generate` run (jobs.md behavior 4). Every LLM input is re-inspected under current preferences. */
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
  const inspectOpts = { policy, ownAddresses, classifier: deps.classifier };
  const inspect = inspectorFor(userId, inspectOpts);
  const inspectStrict = strictInspectorFor(userId, inspectOpts);

  // Feedback first: a wholly excluded feedback ends the run before any content is loaded or sent.
  let feedback = '';
  if (generation.kind === 'feedback') {
    const raw = profiles.decryptGenerationFeedback(generation);
    const filtered = raw === null ? null : await inspectField(raw, inspectStrict);
    if (filtered === null || filtered.trim() === '') return fail('feedback_excluded');
    feedback = filtered;
  }

  // The analysis prompt comes from the pins (FR-019); an own prompt is re-inspected and never falls back.
  let analysisPromptText: string;
  let promptSource: 'default' | 'own';
  if (generation.ownPromptVersionId) {
    if (!run.ownPromptVersion) return fail('analysis_prompt_missing');
    const filtered = await inspectField(profiles.decryptOwnPromptText(run.ownPromptVersion), inspectStrict);
    if (filtered === null || filtered.trim() === '') return fail('analysis_prompt_excluded');
    analysisPromptText = filtered;
    promptSource = 'own';
  } else {
    if (!dv.analysisPrompt || dv.analysisPrompt.trim() === '') return fail('analysis_prompt_missing');
    analysisPromptText = dv.analysisPrompt;
    promptSource = 'default';
  }

  const samples = await loadSamples(deps.store, userId, inspect);
  if (samples.length === 0) return block('insufficient_content');
  const received = await loadReceivedContext(deps.store, userId, inspect);
  const previous = await previousDocumentJson(latestVersion, inspect);

  const result = await runDocumentPipeline(deps.llm, {
    wrapper: promptVersion,
    analysisPromptText,
    promptSource,
    definition: { name: dv.name, description: dv.description },
    samples,
    received,
    previousDocumentJson: previous,
    feedback,
    userFirstName: firstName(user.name),
    excludedCategoryLabels: policy.selectedCategories.map((c) => labelFor(c as CountCategory)).join(', '),
  });
  if (result.status === 'invalid') {
    log.warn({ status: 'failed', errorCode: 'invalid_output', counts: problemCounts(result) });
    await fail('invalid_output');
    throw new UnrecoverableError('invalid_output');
  }

  const document = await inspectOutput(result.document, inspectStrict);
  if (!document) return fail('output_excluded');

  const languages = distinctLanguages(samples);
  const bodyLanguages = [...new Set(document.languages.map((l) => l.code).filter(Boolean))];
  const { versionId } = await profiles.storeGeneratedDocument(generationId, {
    document,
    languages: bodyLanguages.length > 0 ? bodyLanguages : languages,
    contributingSourceIds: await contributingSourceIds(samples),
    contributingItemCount: samples.length,
    authoredWordsNow: eligibility.authoredWordCount,
  });
  log.info({
    status: 'succeeded',
    count: samples.length,
    counts: { ...problemCounts(result), sections: document.sections.length, excerpts: document.excerpts.length },
  });
  return { outcome: 'succeeded', versionId };
}

/**
 * `profile.generate` (jobs.md behavior 4). Blocks (retired definition, removed choice, too little content), a
 * wholly excluded feedback or own prompt and a missing own prompt end the run without an LLM call; a refusal or
 * output that fails post-validation twice is final; an inspection that cannot complete is retried and marks the
 * generation `inspection_failed` on the last attempt; any other error is retried and marks it `generation_failed`.
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
      if (finalAttempt) {
        const errorCode = err instanceof InspectionIncompleteError ? 'inspection_failed' : 'generation_failed';
        await profiles.failGeneration(generationId, errorCode, { notify: true });
        jobLogger(job.id ?? generationId, { entityId: generationId }).warn({ status: 'failed', errorCode });
      }
      throw err;
    }
  };
}

export const handlers: HandlerMap = {
  'profile.generate': createProfileHandler(),
};
