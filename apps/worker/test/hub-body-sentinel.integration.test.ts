import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DelayedError, type Job } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { closeDb, FILTER_CATEGORIES, filterPreferences, getDb, getPool, user } from '@voicespark/db';
import type { ServiceContext } from '@voicespark/core/errors';
import { hubExtractionSchema, hubTriageSchema } from '@voicespark/core/hub/extraction-schema';
import * as hubIngest from '@voicespark/core/services/hub/ingest';
import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import { createFakeGenerationLlm } from '@voicespark/core/prompting';
import { jobIds, type JobPayload } from '@voicespark/core/queues';
import { configureMailAccess, openFetcher } from '@voicespark/core/services/mail-access';
import * as sources from '@voicespark/core/services/sources';
import { createRecordedClassifier } from '@voicespark/filters';
import type { LlmClient } from '@voicespark/integrations/anthropic';
import { InMemoryMemoryStore, namespaceFor } from '@voicespark/integrations/supermemory';
import { createHubSyncHandler } from '../src/processors/hub-sync';
import { createHubThreadHandler, type HubThreadResult } from '../src/processors/hub-thread';
import { createImportHandler } from '../src/processors/import';
import { GREENMAIL_HOST, GREENMAIL_IMAPS_PORT, uniqueMailbox } from './helpers/greenmail';

// SC-008 (T154; quickstart section 7): import and process the BODY-SENTINEL fixture with the hub on. Neither the
// sentinel nor the fixture's full message text may appear in a dump of every hub_* table, in any document of the
// in-memory store namespace, in the captured pino output, or in the hub_llm_call rows. The mail goes in through the
// real import hook (GreenMail), the thread through the real hub.thread handler with the recorded fake LLM, and the
// documents through the real hub.sync handler. Needs Postgres, Redis and GreenMail (IMAPS 3993).
type PagePayload = JobPayload<'import.page'>;
type ThreadPayload = JobPayload<'hub.thread'>;
type SyncPayload = JobPayload<'hub.sync'>;

const enqueued: { name: string; payload: Record<string, unknown> }[] = [];
const pinoOutput: string[] = [];

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async (name: string, payload: Record<string, unknown>) => {
    enqueued.push({ name, payload });
    return {};
  }),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

// Real pino (redaction and formatters included), written to memory at trace level instead of stdout.
vi.mock('@voicespark/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voicespark/core/logger')>();
  const destination = { write: (line: string) => void pinoOutput.push(line) };
  return {
    ...actual,
    logger: actual.createLogger({ level: 'trace', destination }),
    jobLogger: (jobId: string, extra: Record<string, unknown> = {}) =>
      actual.createLogger({ level: 'trace', destination, base: { ...extra, jobId } }),
  };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const BODY_SENTINEL = 'BODY-SENTINEL';
const FIXTURES = join(import.meta.dirname, 'fixtures', 'hub');
const POSTGRES_CONTAINER = process.env.TEST_POSTGRES_CONTAINER ?? 'voicespark-2-postgres-test-1';

// The authored body text of the fixture's messages (business-2 carries the sentinel), plus the quoted history that
// the cleaner drops before the model sees it. None of it may be stored anywhere.
const FULL_BODIES = [
  'dziękuję za szybką odpowiedź. Termin dostawy pasuje. BODY-SENTINEL',
  'dziękuję za szybką odpowiedź. Termin dostawy pasuje.',
  'proszę o przygotowanie oferty na dostawę stali do końca miesiąca.',
  'Dzień dobry,\n\ndziękuję za szybką odpowiedź.',
  'QUOTED-HISTORY',
];

const classifier = createRecordedClassifier();
const fakeLlm = createFakeGenerationLlm();
const llm: LlmClient = {
  parseStructured: async (args) => {
    const schema: unknown = args.schema;
    if (schema !== hubTriageSchema && schema !== hubExtractionSchema) throw new Error('unexpected_schema');
    return fakeLlm.parseStructured(args);
  },
};

const store = new InMemoryMemoryStore();
const importHandler = createImportHandler({ store, classifier });
const threadHandler = createHubThreadHandler({ store, classifier, llm, openFetcher });
const syncHandler = createHubSyncHandler({ store, classifier });
const userIds: string[] = [];

function eml(name: string, vars: Record<string, string>): Buffer {
  let text = readFileSync(join(FIXTURES, `${name}.eml`), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8');
}

const fakeJob = (name: string, id: string, data: unknown) =>
  ({
    id,
    name,
    data,
    attemptsMade: 0,
    opts: { attempts: 1 },
    moveToDelayed: vi.fn(async () => undefined),
    updateData: vi.fn(async () => undefined),
  }) as unknown;

async function drainImport(sourceId: string): Promise<void> {
  for (let guard = 0; ; guard++) {
    expect(guard).toBeLessThan(100);
    const idx = enqueued.findIndex((e) => e.name === 'import.page' && e.payload.sourceId === sourceId);
    if (idx < 0) return;
    const payload = enqueued.splice(idx, 1)[0]!.payload as unknown as PagePayload;
    await importHandler(
      fakeJob('import.page', jobIds.importPage(payload.sourceId, Date.now()), payload) as Job<PagePayload, unknown, 'import.page'>,
      'token',
    );
  }
}

/** Every hub_* table of the whole test database as text: pg_dump from the postgres container, else a row dump. */
async function hubTablesDump(): Promise<{ text: string; via: 'pg_dump' | 'row dump' }> {
  const url = new URL(process.env.DATABASE_URL!);
  const tables = (
    await getPool().query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and tablename like 'hub\\_%' order by 1`,
    )
  ).rows.map((r) => r.tablename);
  expect(tables.length).toBeGreaterThan(10);
  try {
    const text = execFileSync(
      'docker',
      [
        'exec',
        POSTGRES_CONTAINER,
        'pg_dump',
        '-U',
        decodeURIComponent(url.username),
        '-d',
        url.pathname.slice(1),
        '--data-only',
        '--inserts',
        ...tables.flatMap((t) => ['-t', `public.${t}`]),
      ],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
    );
    expect(text).toContain('INSERT INTO public.hub_');
    return { text, via: 'pg_dump' };
  } catch (err) {
    // No docker (ENOENT) or no such container (CI runs postgres as a service): dump the rows instead.
    const missing =
      (err as { code?: string }).code === 'ENOENT' || /No such container/.test(String((err as { stderr?: unknown }).stderr));
    if (!missing) throw err;
    const parts: string[] = [];
    for (const t of tables)
      parts.push((await getPool().query(`select to_jsonb(x) as row from ${t} x`)).rows.map((r) => JSON.stringify(r.row)).join('\n'));
    return { text: parts.join('\n'), via: 'row dump' };
  }
}

/**
 * The namespace also holds the spec 001 `email` content documents that the import writes by design (the cleaned message
 * text is the voice-memory content). Those are not hub documents: they are counted and reported, and the check covers
 * every `hub_*` document, which is all the hub writes.
 */
async function storeDump(userId: string): Promise<{ text: string; hub: number; importedEmails: number }> {
  const ns = namespaceFor(userId);
  const { documents } = await store.listDocuments(ns, { page: 1, limit: 1000 });
  const hubDocs = [];
  let importedEmails = 0;
  for (const d of documents) {
    const full = await store.getDocument(ns, d.id);
    if (String(full!.metadata.vs_kind).startsWith('hub_')) hubDocs.push(full);
    else importedEmails++;
  }
  return { text: JSON.stringify(hubDocs), hub: hubDocs.length, importedEmails };
}

function expectNoBody(label: string, text: string): void {
  expect(text, `${label} holds the sentinel`).not.toContain(BODY_SENTINEL);
  for (const body of FULL_BODIES) {
    expect(text, `${label} holds message text: ${body.slice(0, 40)}`).not.toContain(body);
    expect(text, `${label} holds message text (JSON-escaped): ${body.slice(0, 40)}`).not.toContain(JSON.stringify(body).slice(1, -1));
  }
}

beforeAll(async () => {
  await getPool().query('select 1');
  configureMailAccess({ imap: { rejectUnauthorized: false } });
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe('hub body sentinel (SC-008)', () => {
  it('the sentinel and the fixture message text appear in no hub table, memory document, log line or hub_llm_call row', async () => {
    const [u] = await getDb()
      .insert(user)
      .values({ name: 'Hub Sentinel', email: `hub-sentinel-${randomUUID()}@example.test` })
      .returning({ id: user.id });
    userIds.push(u!.id);
    await getDb()
      .insert(filterPreferences)
      .values({ userId: u!.id, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: new Date() });
    const ctx: ServiceContext = { userId: u!.id, role: 'user' };

    const box = uniqueMailbox('hub-sentinel');
    const run = randomUUID().slice(0, 8);
    const client = new ImapFlow({
      host: GREENMAIL_HOST,
      port: GREENMAIL_IMAPS_PORT,
      secure: true,
      auth: { user: box, pass: 'password' },
      tls: { rejectUnauthorized: false },
      logger: false,
    });
    await client.connect();
    try {
      for (const n of ['business-1', 'business-2']) await client.append('INBOX', eml(n, { OWNER: box, RUN: run }), []);
    } finally {
      await client.logout();
    }

    // Import with the hub on: the ingest hook records the messages and the thread.
    pinoOutput.length = 0;
    const source = await sources.connectImap(ctx, {
      host: GREENMAIL_HOST,
      port: GREENMAIL_IMAPS_PORT,
      tlsMode: 'tls',
      username: box,
      password: 'password',
    });
    await mailboxes.enable(ctx, source.id, { acknowledgeAi: true });
    await drainImport(source.id);

    // hub.thread: extraction through the fake LLM (the cleaned body does reach the model, by design).
    const hash = hubIngest.messageIdHash(ctx.userId, `business-1-${run}@mail.example`);
    const { rows: found } = await getPool().query<{ thread_id: string }>(
      'select thread_id from hub_message where user_id = $1 and message_id_hash = $2',
      [ctx.userId, hash],
    );
    expect(found).toHaveLength(1);
    const threadId = found[0]!.thread_id;
    await getPool().query(`update hub_thread set next_attempt_at = now() where id = $1 and status = 'pending'`, [threadId]);
    const { rows: [t] } = await getPool().query<{ version: string }>('select version from hub_thread where id = $1', [threadId]);
    const version = Number(t!.version);
    const data: ThreadPayload = { userId: ctx.userId, threadId, version };
    const result = (await threadHandler(
      fakeJob('hub.thread', jobIds.hubThread(threadId, version), data) as Job<ThreadPayload, unknown, 'hub.thread'>,
    )) as HubThreadResult;
    expect(result).toMatchObject({ outcome: 'done' });

    // hub.sync: every dirty row is written to the in-memory store.
    for (let pass = 0; pass < 10; pass++) {
      await getPool().query(`update hub_sync_item set next_attempt_at = now() where user_id = $1 and status <> 'stored'`, [ctx.userId]);
      try {
        await syncHandler(fakeJob('hub.sync', jobIds.hubSync(ctx.userId), { userId: ctx.userId } satisfies SyncPayload) as Job<SyncPayload, unknown, 'hub.sync'>, 'token');
      } catch (err) {
        if (!(err instanceof DelayedError)) throw err;
      }
      const { rows } = await getPool().query('select 1 from hub_sync_item where user_id = $1 and status <> \'stored\'', [ctx.userId]);
      if (rows.length === 0) break;
    }

    // The checks are only meaningful if the pipeline produced data in every sink.
    const pg = await hubTablesDump();
    const mem = await storeDump(ctx.userId);
    const llmRows = (await getPool().query('select to_jsonb(x) as row from hub_llm_call x where user_id = $1', [ctx.userId])).rows;
    const logs = pinoOutput.join('\n');
    expect(mem.hub).toBeGreaterThan(0);
    expect(mem.importedEmails).toBe(2);
    expect(llmRows.length).toBeGreaterThan(0);
    expect(logs).toContain(threadId);
    console.info(
      `body sentinel: hub tables via ${pg.via} (${pg.text.length} chars), ${mem.hub} hub memory documents (plus ${mem.importedEmails} spec 001 imported email documents, not hub), ${pinoOutput.length} log lines, ${llmRows.length} hub_llm_call rows`,
    );

    expectNoBody('pg dump of hub_* tables', pg.text);
    expectNoBody('hub documents of the memory store namespace', mem.text);
    expectNoBody('pino output', logs);
    expectNoBody('hub_llm_call rows', JSON.stringify(llmRows));
  }, 120_000);
});
