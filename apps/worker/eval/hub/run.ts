import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LlmClient } from '@voicespark/integrations/anthropic';
import { loadConversations, type EvalConversation } from './format';
import type { FileResult } from './grade';

// Hub extraction eval runner (T150/T151, research R14; SC-004 to SC-006). Every conversation of
// `conversations/` runs through `recordMessage`, `hub.thread` and the real policy and apply code against the test
// database (runner.ts), and is scored by grade.ts. The in-sample (ported reference) set and the held-out subset are
// reported on separate lines.
//
//   pnpm hub:eval                                   replay recorded/{id}.json (default; CI)
//   HUB_EVAL_LIVE=1 ANTHROPIC_API_KEY=... pnpm hub:eval --model claude-sonnet-5-5 [--record]
//
// Options: `--record` writes recorded/{id}.json from a live run (T151); `--only en-01,holdout-03` runs a subset;
// `--json <file>` writes the per-file results. Dev only: `--synthetic` answers from the `expected` labels (checks the
// harness and grader without recordings; its scores say nothing about the model).
//
// The live run is manual or nightly, never in PR CI. Writes go only to the test database (DATABASE_URL must name a
// `_test` database) and to an in-memory store; the memory-store settings are blanked so nothing reaches a real
// Supermemory, and queue jobs the pipeline enqueues land in Redis db 15 of the local Redis and are removed at the
// end. Exits 1 when a threshold fails, 2 on a usage or setup problem (no recordings, missing key, wrong database).

const TEST_DATABASE_URL = 'postgres://voicespark:voicespark@127.0.0.1:55432/voicespark_test';
const TEST_REDIS_URL = 'redis://127.0.0.1:56379';
const EVAL_REDIS_DB = '15';

class UsageError extends Error {}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return v;
}
const hasFlag = (name: string) => process.argv.includes(name);

interface Options {
  mode: 'replay' | 'live' | 'synthetic';
  record: boolean;
  model: string | undefined;
  only: Set<string> | null;
  json: string | undefined;
}

function parseOptions(): Options {
  const known = new Set(['--record', '--synthetic', '--model', '--only', '--json']);
  for (const [i, a] of process.argv.slice(2).entries()) {
    const prev = process.argv[i + 1];
    if (a.startsWith('--') && !known.has(a)) throw new UsageError(`unknown option ${a}`);
    if (!a.startsWith('--') && !['--model', '--only', '--json'].includes(prev ?? ''))
      throw new UsageError(`unexpected argument ${a}`);
  }
  const live = process.env.HUB_EVAL_LIVE === '1';
  const record = hasFlag('--record');
  const synthetic = hasFlag('--synthetic');
  const model = argValue('--model');
  const only = argValue('--only');
  if (synthetic && (live || record))
    throw new UsageError('--synthetic cannot be combined with HUB_EVAL_LIVE=1 or --record');
  if (record && !live)
    throw new UsageError(
      '--record needs the live model: set HUB_EVAL_LIVE=1 and ANTHROPIC_API_KEY, and pass --model',
    );
  if (model && !live)
    throw new UsageError('--model applies to the live run only (HUB_EVAL_LIVE=1)');
  if (live) {
    if (process.env.CI)
      throw new UsageError(
        'the live eval (HUB_EVAL_LIVE=1) never runs in CI; CI replays the recordings',
      );
    if (!process.env.ANTHROPIC_API_KEY)
      throw new UsageError(
        'ANTHROPIC_API_KEY is not set: the live eval (HUB_EVAL_LIVE=1) calls the real model and needs it',
      );
    if (!model)
      throw new UsageError('the live eval needs --model (e.g. --model claude-sonnet-5-5)');
  }
  return {
    mode: live ? 'live' : synthetic ? 'synthetic' : 'replay',
    record,
    model,
    only: only
      ? new Set(
          only
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : null,
    json: argValue('--json'),
  };
}

const isLocalHost = (host: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);

/** Test database, local Redis db 15, no memory store, fixed test keys; set before any module reads the env. */
function prepareEnv(opts: Options): void {
  process.env.DATABASE_URL ??= TEST_DATABASE_URL;
  let dbName: string;
  try {
    dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
  } catch {
    throw new UsageError('DATABASE_URL is not a valid URL');
  }
  if (!dbName.includes('_test'))
    throw new UsageError(
      `refusing to run against database "${dbName}": the eval writes only to a test database (name containing "_test")`,
    );
  const redis = new URL(process.env.REDIS_URL ?? TEST_REDIS_URL);
  if (!isLocalHost(redis.hostname))
    throw new UsageError(
      `refusing to use Redis at ${redis.hostname}: the eval uses a local test Redis only`,
    );
  redis.pathname = `/${EVAL_REDIS_DB}`;
  process.env.REDIS_URL = redis.toString();

  // The fake classifier and test-mode fallbacks; never a real memory store.
  process.env.NODE_ENV = 'test';
  delete process.env.SUPERMEMORY_API_KEY;
  delete process.env.TEST_MEMORY_STORE_URL;
  process.env.SUPERMEMORY_BASE_URL = 'http://127.0.0.1:9';
  process.env.LOG_LEVEL = process.env.HUB_EVAL_LOG_LEVEL ?? 'error';
  process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
  process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
  process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
  process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
  if (opts.mode === 'live') process.env.LLM_HUB_EXTRACTION_MODEL = opts.model;
  else delete process.env.ANTHROPIC_API_KEY;
}

async function main(): Promise<number> {
  const opts = parseOptions();
  prepareEnv(opts);

  // Imported after the env is fixed: these modules read it on first use.
  const { closeDb } = await import('@voicespark/db');
  const { closeQueues, getQueue } = await import('@voicespark/core/queues');
  const { HUB_EXTRACTION_PROMPT_VERSION } = await import('@voicespark/core/hub/prompts');
  const { createAnthropicClient } = await import('@voicespark/integrations/anthropic');
  const { runConversation } = await import('./runner');
  const { infoLines, scLines, summarize } = await import('./grade');
  const llmModule = await import('./llm');
  const { createSyntheticLlm } = await import('./synthetic-llm');

  let conversations: EvalConversation[] = await loadConversations();
  if (opts.only) {
    const unknown = [...opts.only].filter((id) => !conversations.some((c) => c.id === id));
    if (unknown.length > 0)
      throw new UsageError(`unknown conversation id(s): ${unknown.join(', ')}`);
    conversations = conversations.filter((c) => opts.only!.has(c.id));
  }

  let recordings = new Map<string, import('./llm').Recording>();
  if (opts.mode === 'replay') {
    try {
      recordings = await llmModule.loadRecordings();
    } catch (err) {
      throw new UsageError(
        `unreadable recording: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const howTo =
      'run `HUB_EVAL_LIVE=1 ANTHROPIC_API_KEY=... pnpm hub:eval --record --model <model>` (T151) and commit apps/worker/eval/hub/recorded/';
    if (recordings.size === 0)
      throw new UsageError(`no recordings in ${llmModule.RECORDED_DIR}; ${howTo}`);
    const missing = conversations.filter((c) => !recordings.has(c.id)).map((c) => c.id);
    if (missing.length > 0)
      throw new UsageError(
        `no recordings for ${missing.length} conversation(s): ${missing.join(', ')}; ${howTo}`,
      );
    const stale = conversations
      .filter((c) => recordings.get(c.id)!.promptVersion !== HUB_EXTRACTION_PROMPT_VERSION)
      .map((c) => c.id);
    if (stale.length > 0)
      throw new UsageError(
        `recordings of ${stale.join(', ')} were made for another prompt version than ${HUB_EXTRACTION_PROMPT_VERSION}; ${howTo}`,
      );
  }
  const live =
    opts.mode === 'live' ? createAnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY! }) : null;
  const recordedModel = (id: string) => recordings.get(id)?.model;

  const results: FileResult[] = [];
  try {
    for (const [i, c] of conversations.entries()) {
      let llm: LlmClient;
      let problems: string[] = [];
      let recorder: ReturnType<typeof llmModule.createRecordingLlm> | undefined;
      if (opts.mode === 'replay') {
        const replay = llmModule.createReplayLlm(recordings.get(c.id)!);
        problems = replay.problems;
        llm = replay;
      } else if (opts.mode === 'live') {
        recorder = llmModule.createRecordingLlm(live!);
        llm = recorder;
      } else {
        llm = createSyntheticLlm(c);
      }

      const { result } = await runConversation(c, llm);
      if (problems.length > 0)
        result.error = [`stale recording: ${problems.join('; ')}`, result.error]
          .filter(Boolean)
          .join('; ');
      if (recorder && opts.record) {
        await llmModule.writeRecording({
          id: c.id,
          model: opts.model!,
          promptVersion: HUB_EXTRACTION_PROMPT_VERSION,
          recordedAt: new Date().toISOString(),
          calls: recorder.calls,
        });
      }
      results.push(result);
      const state = result.error
        ? `ERROR ${result.error}`
        : result.misses.length > 0
          ? `${result.misses.length} miss(es)`
          : 'ok';
      console.error(`[${i + 1}/${conversations.length}] ${c.id}: ${state}`);
    }
  } finally {
    // Jobs the pipeline enqueued (hub.thread, hub.sync) sit in the eval Redis db; nothing consumes them.
    await getQueue('hub')
      .obliterate({ force: true })
      .catch(() => undefined);
    await closeQueues().catch(() => undefined);
    await closeDb();
  }

  const models = [...new Set(conversations.map((c) => recordedModel(c.id)).filter(Boolean))];
  const source =
    opts.mode === 'replay'
      ? `replay of recorded/ (${models.join(', ')})`
      : opts.mode === 'live'
        ? `live ${opts.model}${opts.record ? ', recording' : ''}`
        : 'SYNTHETIC answers from the labels (harness check; not a model result)';
  const inSample = results.filter((r) => r.set === 'reference');
  const heldOut = results.filter((r) => r.set === 'holdout');
  const sets = [
    summarize('in-sample', inSample),
    ...(heldOut.length > 0 ? [summarize('held-out', heldOut)] : []),
  ].filter((s) => s.files > 0);

  const lines = [`Hub extraction eval: ${source}; ${results.length} conversations`, ''];
  for (const s of sets) lines.push(...scLines(s));
  lines.push('');
  if (inSample.length > 0) lines.push(...infoLines('in-sample', inSample));
  if (heldOut.length > 0) lines.push(...infoLines('held-out', heldOut));
  const missed = results.filter((r) => r.error || r.misses.length > 0);
  if (missed.length > 0) {
    lines.push('', 'Misses:');
    for (const r of missed)
      lines.push(
        `- ${r.id}: ${[r.error ? `ERROR ${r.error}` : null, ...r.misses].filter(Boolean).join('; ')}`,
      );
  }
  const passed = sets.every((s) => s.passed);
  lines.push('', `Result: ${passed ? 'PASS' : 'FAIL'}`);
  console.log(lines.join('\n'));

  if (opts.json) {
    const out = path.resolve(opts.json);
    await writeFile(out, `${JSON.stringify({ source, sets, files: results }, null, 2)}\n`);
    console.error(`Results written to ${out}`);
  }
  return passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`hub:eval: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(err);
    process.exitCode = 1;
  },
);
