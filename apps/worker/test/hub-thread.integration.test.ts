import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  closeDb,
  connectedSource,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  getPool,
  hubMailboxSetting,
  user,
} from '@voicespark/db';
import type { ServiceContext } from '@voicespark/core/errors';
import { AppError } from '@voicespark/core/errors';
import { hubExtractionSchema, hubTriageSchema } from '@voicespark/core/hub/extraction-schema';
import { markerKey } from '@voicespark/core/hub/fingerprint';
import { isFreeMailDomain } from '@voicespark/core/hub/normalize';
import { createFakeGenerationLlm } from '@voicespark/core/prompting';
import { jobIds, type JobPayload } from '@voicespark/core/queues';
import * as apply from '@voicespark/core/services/hub/apply';
import { decryptContent } from '@voicespark/core/services/hub/common';
import { buildDocumentFor } from '@voicespark/core/services/hub/doc-builder';
import * as ignoreRules from '@voicespark/core/services/hub/ignore-rules';
import * as hubIngest from '@voicespark/core/services/hub/ingest';
import * as links from '@voicespark/core/services/hub/links';
import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import * as hubRecords from '@voicespark/core/services/hub/records';
import * as imports from '@voicespark/core/services/imports';
import { configureMailAccess, openFetcher } from '@voicespark/core/services/mail-access';
import * as sources from '@voicespark/core/services/sources';
import type { Classifier } from '@voicespark/filters';
import type { LlmClient } from '@voicespark/integrations/anthropic';
import { MailAuthError, type MailFetcher, type MailRef } from '@voicespark/integrations/mail';
import { parseMessage } from '@voicespark/integrations/mime';
import { InMemoryMemoryStore } from '@voicespark/integrations/supermemory';
import {
  HUB_THREAD_MAX_ATTEMPTS,
  createHubThreadHandler,
  type HubThreadResult,
} from '../src/processors/hub-thread';
import { createImportHandler } from '../src/processors/import';
import { hubThreadSweep } from '../src/processors/maintenance';
import { webLinkFor } from '../src/hub-links';
import { GREENMAIL_HOST, GREENMAIL_IMAPS_PORT, uniqueMailbox } from './helpers/greenmail';

// T103 (US3 sub-steps d-f; contracts/jobs.md (11) and (16), contracts/hub-extraction.md): `hub.thread` end to end over
// GreenMail with the synthetic `.eml` fixtures in fixtures/hub and the recorded fake-LLM outputs (`hubfx:` markers,
// packages/core/src/prompting/fake-llm.ts). Mail goes in through the real import hook; threads are run by hand (no
// BullMQ worker): every enqueue and every job log line is captured. Needs Postgres, Redis and GreenMail (IMAPS 3993).

type PagePayload = JobPayload<'import.page'>;
type ThreadPayload = JobPayload<'hub.thread'>;
interface Enqueued {
  name: string;
  payload: Record<string, unknown>;
  opts: { jobId?: string; delay?: number };
}
const enqueued: Enqueued[] = [];
const logLines: string[] = [];

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(
    async (name: string, payload: Record<string, unknown>, opts: Enqueued['opts'] = {}) => {
      enqueued.push({ name, payload, opts });
      return {};
    },
  ),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

vi.mock('@voicespark/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voicespark/core/logger')>();
  type Fields = Record<string, unknown>;
  const capture = (bindings: Fields): unknown => {
    const write = (fields: Fields, msg?: string) =>
      void logLines.push(JSON.stringify({ ...bindings, ...fields, msg }));
    return {
      trace: write,
      debug: write,
      info: write,
      warn: write,
      error: write,
      fatal: write,
      child: (b: Fields) => capture({ ...bindings, ...b }),
    };
  };
  return {
    ...actual,
    jobLogger: (jobId: string, extra: Fields = {}) => capture({ ...extra, jobId }),
  };
});

vi.mock('@voicespark/core/services/hub/apply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voicespark/core/services/hub/apply')>();
  return { ...actual, applyExtraction: vi.fn(actual.applyExtraction) };
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
const applySpy = vi.mocked(apply.applyExtraction);
const realApply = (
  await vi.importActual<typeof import('@voicespark/core/services/hub/apply')>(
    '@voicespark/core/services/hub/apply',
  )
).applyExtraction;

// ---------------------------------------------------------------------------------------------------------------
// Collaborators: the recorded classifier (switchable to failing), the fake LLM behind a spy that can inject HTTP
// errors, and a fetcher that records refs, can fail, and serves the fake Gmail and Graph sources from memory.

let classifierDown = false;
const classifier: Classifier = {
  classify: async () => {
    if (classifierDown) throw new Error('classifier_down');
    return { spans: [], mostlySensitive: false };
  },
};

const fakeLlm = createFakeGenerationLlm();
const llmCalls: { kind: 'triage' | 'extract' | 'other'; user: string }[] = [];
const llmFailures: number[] = [];
const llm: LlmClient = {
  parseStructured: async (args) => {
    const schema: unknown = args.schema;
    const kind =
      schema === hubTriageSchema ? 'triage' : schema === hubExtractionSchema ? 'extract' : 'other';
    llmCalls.push({ kind, user: args.user });
    const status = kind === 'extract' ? llmFailures.shift() : undefined;
    if (status !== undefined) throw Object.assign(new Error(`fake_http_${status}`), { status });
    return fakeLlm.parseStructured(args);
  },
};

let fetchMode: 'ok' | 'throw' | 'auth' = 'ok';
const fetchedRefs: MailRef[][] = [];
/** Raw messages of the fake (non-IMAP) sources, by provider ref. */
const memoryMail = new Map<string, Buffer>();
const memorySources = new Set<string>();
const testFetcher = async (sourceId: string): Promise<MailFetcher> => {
  if (fetchMode === 'throw') throw new Error('connect_failed');
  const real = memorySources.has(sourceId) ? null : await openFetcher(sourceId);
  return {
    provider: real?.provider ?? 'gmail',
    getAddress: () => real!.getAddress(),
    listFolders: () => real!.listFolders(),
    listPage: (...a: Parameters<MailFetcher['listPage']>) => real!.listPage(...a),
    fetchMessages: async (refs) => {
      fetchedRefs.push(refs);
      if (fetchMode === 'auth') throw new MailAuthError();
      if (real) return real.fetchMessages(refs);
      const out = new Map();
      for (const r of refs) {
        const raw = memoryMail.get(r.providerRef);
        out.set(
          r.providerRef,
          raw ? { raw, folders: ['INBOX'], isSent: false } : new Error('gone'),
        );
      }
      return out;
    },
    close: async () => real?.close(),
  } as MailFetcher;
};

const store = new InMemoryMemoryStore();
const importHandler = createImportHandler({ store, classifier });
const threadHandler = createHubThreadHandler({ store, classifier, llm, openFetcher: testFetcher });

// ---------------------------------------------------------------------------------------------------------------
// Fixtures and harness

interface Vars {
  OWNER: string;
  OWNER2?: string;
  OLD_OWNER?: string;
  RUN: string;
}

function eml(name: string, vars: Vars): Buffer {
  let text = readFileSync(join(FIXTURES, `${name}.eml`), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v ?? '');
  return Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8');
}

/** The fixture's Message-ID (normalised as by the thread key). */
const messageIdOf = (name: string, run: string) => `${name}-${run}@mail.example`;

async function seed(box: string, names: string[], vars: Vars): Promise<void> {
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
    for (const n of names) await client.append('INBOX', eml(n, vars), []);
  } finally {
    await client.logout();
  }
}

const userIds: string[] = [];

async function newUser(): Promise<ServiceContext> {
  const db = getDb();
  const [u] = await db
    .insert(user)
    .values({ name: 'Hub Thread', email: `hub-thread-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(u!.id);
  await db
    .insert(filterPreferences)
    .values({ userId: u!.id, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: new Date() });
  return { userId: u!.id, role: 'user' };
}

function fakeJob<P>(name: string, id: string, data: P) {
  return {
    id,
    name,
    data,
    attemptsMade: 0,
    opts: { attempts: 1 },
    moveToDelayed: vi.fn(async () => undefined),
    updateData: vi.fn(async () => undefined),
  };
}

async function drainImport(sourceId: string): Promise<void> {
  for (let guard = 0; ; guard++) {
    expect(guard).toBeLessThan(100);
    const idx = enqueued.findIndex(
      (e) => e.name === 'import.page' && e.payload.sourceId === sourceId,
    );
    if (idx < 0) return;
    const payload = enqueued.splice(idx, 1)[0]!.payload as unknown as PagePayload;
    const job = fakeJob('import.page', jobIds.importPage(payload.sourceId, Date.now()), payload);
    await importHandler(job as unknown as Job<PagePayload, unknown, 'import.page'>, 'token');
  }
}

interface Mailbox {
  ctx: ServiceContext;
  box: string;
  sourceId: string;
  run: string;
}

/** A user with one hub-enabled GreenMail mailbox holding `names`, imported (the hub hook records the threads). */
async function mailbox(
  names: string[],
  opts: { ctx?: ServiceContext; extraVars?: Partial<Vars> } = {},
): Promise<Mailbox> {
  const ctx = opts.ctx ?? (await newUser());
  const box = uniqueMailbox('hub-thread');
  const run = randomUUID().slice(0, 8);
  await seed(box, names, { OWNER: box, RUN: run, ...opts.extraVars });
  const source = await sources.connectImap(ctx, {
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    tlsMode: 'tls',
    username: box,
    password: 'password',
  });
  await mailboxes.enable(ctx, source.id, { acknowledgeAi: true });
  await drainImport(source.id);
  return { ctx, box, sourceId: source.id, run };
}

/** New mail in an existing mailbox, picked up by an incremental import. */
async function deliver(m: Mailbox, names: string[], extraVars: Partial<Vars> = {}): Promise<void> {
  await seed(m.box, names, { OWNER: m.box, RUN: m.run, ...extraVars });
  const job = await imports.createJob({
    userId: m.ctx.userId,
    sourceId: m.sourceId,
    kind: 'incremental',
  });
  await imports.enqueuePage({ userId: m.ctx.userId, sourceId: m.sourceId, importJobId: job.id });
  await drainImport(m.sourceId);
}

const pool = () => getPool();
async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query(text, params)).rows as T[];
}

interface ThreadRow {
  id: string;
  status: string;
  skip_reason: string | null;
  version: string;
  processed_version: string;
  attempts: number;
  next_attempt_at: Date | null;
  locked_until: Date | null;
  last_error_code: string | null;
  summary_enc: string | null;
  summary_version: number;
  subject_enc: string | null;
  participants_enc: string | null;
  first_message_at: Date | null;
  last_message_at: Date | null;
  message_count: number;
}

async function threadIdOf(userId: string, messageId: string): Promise<string> {
  const hash = hubIngest.messageIdHash(userId, messageId.toLowerCase());
  const [row] = await q<{ thread_id: string }>(
    'select thread_id from hub_message where user_id = $1 and message_id_hash = $2',
    [userId, hash],
  );
  expect(row, 'fixture message recorded').toBeDefined();
  return row!.thread_id;
}

const threadOf = async (id: string) =>
  (await q<ThreadRow>('select * from hub_thread where id = $1', [id]))[0]!;

/** Makes the thread due now (skips the 60 s debounce or a backoff) and runs `hub.thread` once. */
async function runThread(
  userId: string,
  threadId: string,
  opts: { due?: boolean } = {},
): Promise<HubThreadResult> {
  if (opts.due !== false)
    await q('update hub_thread set next_attempt_at = now() where id = $1 and status = $2', [
      threadId,
      'pending',
    ]);
  const version = Number((await threadOf(threadId))?.version ?? 1);
  const data: ThreadPayload = { userId, threadId, version };
  const job = fakeJob('hub.thread', jobIds.hubThread(threadId, version), data);
  return (await threadHandler(
    job as unknown as Job<ThreadPayload, unknown, 'hub.thread'>,
  )) as HubThreadResult;
}

const peopleOf = (userId: string) =>
  q<{
    id: string;
    name_enc: string;
    phone_enc: string | null;
    role_title_enc: string | null;
    owner_fields: string[];
  }>('select * from hub_person where user_id = $1', [userId]);
const companiesOf = (userId: string) =>
  q<{ id: string; name_enc: string }>('select * from hub_company where user_id = $1', [userId]);
const projectsOf = (userId: string) =>
  q<{ id: string; name_enc: string }>('select * from hub_project where user_id = $1', [userId]);
const linksOf = (userId: string) =>
  q<{
    id: string;
    kind: string;
    person_id: string | null;
    company_id: string | null;
    project_id: string | null;
  }>('select * from hub_link where user_id = $1', [userId]);
const factsOf = (userId: string) =>
  q<{
    id: string;
    thread_id: string | null;
    type: string;
    state: string;
    reason: string | null;
    field: string | null;
    conflict: boolean;
    person_id: string | null;
    company_id: string | null;
    project_id: string | null;
    link_id: string | null;
    value_enc: string | null;
    previous_value_enc: string | null;
  }>('select * from hub_fact where user_id = $1', [userId]);
const emailsOf = (userId: string) =>
  q<{ person_id: string; address_enc: string }>(
    'select * from hub_person_email where user_id = $1',
    [userId],
  );
const llmRowsOf = (userId: string) =>
  q<Record<string, unknown>>('select * from hub_llm_call where user_id = $1', [userId]);
const dec = (v: string | null) => (v === null ? null : decryptContent(v));
const extractCalls = () => llmCalls.filter((c) => c.kind === 'extract').length;
const triageCalls = () => llmCalls.filter((c) => c.kind === 'triage').length;

/** Every row of every hub table of the user, encrypted columns decrypted. */
async function hubDump(userId: string): Promise<string> {
  const tables = await q<{ table_name: string }>(
    `select distinct table_name from information_schema.columns
     where table_schema = 'public' and table_name like 'hub\\_%' and column_name = 'user_id'`,
  );
  const out: unknown[] = [];
  for (const { table_name } of tables) {
    for (const row of await q<Record<string, unknown>>(
      `select * from ${table_name} where user_id = $1`,
      [userId],
    )) {
      const plain: Record<string, unknown> = { table_name };
      for (const [k, v] of Object.entries(row)) {
        plain[k] = k.endsWith('_enc') && typeof v === 'string' ? decryptContent(v) : v;
      }
      out.push(plain);
    }
  }
  return JSON.stringify(out);
}

beforeAll(async () => {
  await getPool().query('select 1');
  configureMailAccess({ imap: { rejectUnauthorized: false } });
});

afterEach(() => {
  enqueued.length = 0;
  llmCalls.length = 0;
  llmFailures.length = 0;
  fetchedRefs.length = 0;
  fetchMode = 'ok';
  classifierDown = false;
  applySpy.mockReset();
  applySpy.mockImplementation(realApply);
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

// ---------------------------------------------------------------------------------------------------------------

describe('hub.thread: records from mail (US3 AS1, AS5, AS6, FR-014)', () => {
  it('AS1: a business thread creates the person, the company for acme.example and a person_company link', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    const r = await runThread(m.ctx.userId, threadId);
    expect(r).toMatchObject({ outcome: 'done', skipReason: null });

    const [p] = await peopleOf(m.ctx.userId);
    expect(dec(p!.name_enc)).toBe('Jan Kowalski');
    expect(dec(p!.phone_enc)).toBe('+48 601 234 567');
    expect((await emailsOf(m.ctx.userId)).map((e) => dec(e.address_enc))).toEqual([
      'jan@acme.example',
    ]);
    const [c] = await companiesOf(m.ctx.userId);
    expect(dec(c!.name_enc)).toBe('Acme Sp. z o.o.');
    const domains = await q<{ domain_enc: string }>(
      'select domain_enc from hub_company_domain where company_id = $1',
      [c!.id],
    );
    expect(domains.map((d) => dec(d.domain_enc))).toEqual(['acme.example']);
    const ls = await linksOf(m.ctx.userId);
    expect(ls).toEqual([
      expect.objectContaining({ kind: 'person_company', person_id: p!.id, company_id: c!.id }),
    ]);

    // AS6 / SC-008: every email-derived value and link has a fact that names the thread.
    const facts = (await factsOf(m.ctx.userId)).filter((f) => f.state === 'applied');
    for (const f of facts) expect(f.thread_id).toBe(threadId);
    expect(facts.some((f) => f.type === 'person' && f.person_id === p!.id)).toBe(true);
    expect(facts.some((f) => f.type === 'company' && f.company_id === c!.id)).toBe(true);
    expect(facts.some((f) => f.type === 'company_domain' && f.company_id === c!.id)).toBe(true);
    expect(facts.some((f) => f.type === 'link' && f.link_id === ls[0]!.id)).toBe(true);
    expect(
      facts.some((f) => f.type === 'field' && f.field === 'phone' && f.person_id === p!.id),
    ).toBe(true);

    const t = await threadOf(threadId);
    expect(t).toMatchObject({
      status: 'done',
      processed_version: '1',
      locked_until: null,
      attempts: 0,
    });
    const [setting] = await getDb()
      .select()
      .from(hubMailboxSetting)
      .where(eq(hubMailboxSetting.sourceId, m.sourceId));
    expect(setting!.threadsProcessed).toBe(1);
  }, 60_000);

  it('AS5: the summary keeps subject, dates and participants; open-original is Gmail #all/{id}, Graph webLink, none for IMAP', async () => {
    const m = await mailbox(['business-1']);
    const imapThread = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    await runThread(m.ctx.userId, imapThread);
    const t = await threadOf(imapThread);
    expect(dec(t.summary_enc)).toContain('Jan Kowalski z Acme');
    expect(t.summary_version).toBe(1);
    expect(dec(t.subject_enc)).toBe('Zapytanie o ofertę na stal');
    expect(t.first_message_at?.toISOString()).toBe('2026-09-07T09:00:00.000Z');
    expect(t.last_message_at?.toISOString()).toBe('2026-09-07T09:00:00.000Z');
    const participants = JSON.parse(dec(t.participants_enc)!) as {
      address: string;
      owner: boolean;
      roles: string[];
    }[];
    expect(participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: 'jan@acme.example', owner: false, roles: ['from'] }),
        expect.objectContaining({ address: m.box.toLowerCase(), owner: true, roles: ['to'] }),
      ]),
    );
    const imapLinks = await q<{ web_link_enc: string | null }>(
      'select web_link_enc from hub_thread_source where thread_id = $1',
      [imapThread],
    );
    expect(imapLinks.map((l) => l.web_link_enc)).toEqual([null]);

    // Gmail and Graph sources (no live provider here): recorded through the hook input, fetched from memory.
    const graphLink =
      'https://outlook.office365.com/owa/?ItemID=AAMkGraph1&exvsurl=1&viewmodel=ReadMessageItem';
    for (const [type, ref, webLink] of [
      ['gmail', `gm-${m.run}`, webLinkFor('gmail', `gm-${m.run}`)],
      ['microsoft', `AAMk-${m.run}`, graphLink],
    ] as const) {
      const [src] = await getDb()
        .insert(connectedSource)
        .values({
          userId: m.ctx.userId,
          type,
          accountLabel: m.box,
          accountAddress: m.box,
          status: 'connected',
          consentTextVersion: 'v1',
        } as typeof connectedSource.$inferInsert)
        .returning({ id: connectedSource.id });
      memorySources.add(src!.id);
      await getDb()
        .insert(hubMailboxSetting)
        .values({ sourceId: src!.id, userId: m.ctx.userId, enabled: true });
      const raw = eml('orion', { OWNER: m.box, RUN: `${type}-${m.run}` });
      memoryMail.set(ref, raw);
      const parsed = await parseMessage(raw, { authored: false, folders: ['INBOX'] });
      const rec = await hubIngest.recordMessage({
        userId: m.ctx.userId,
        sourceId: src!.id,
        providerRef: ref,
        folders: ['INBOX'],
        parsed,
        direction: 'inbound',
        webLink,
      });
      expect(await runThread(m.ctx.userId, rec.threadId)).toMatchObject({ outcome: 'done' });
      expect(fetchedRefs.at(-1)).toEqual([
        { providerRef: ref, folderKey: type === 'gmail' ? '_all' : 'INBOX' },
      ]);
      const [ts] = await q<{ web_link_enc: string | null }>(
        'select web_link_enc from hub_thread_source where thread_id = $1',
        [rec.threadId],
      );
      expect(dec(ts!.web_link_enc)).toBe(
        type === 'gmail' ? `https://mail.google.com/mail/#all/gm-${m.run}` : graphLink,
      );
      expect(dec((await threadOf(rec.threadId)).subject_enc)).toBe('Harmonogram Orion');
    }
  }, 90_000);

  it('FR-014: a free-mail sender becomes a person without a company; nothing from the owner or info@', async () => {
    const m = await mailbox(['freemail', 'owner-self', 'info']);
    const free = await threadIdOf(m.ctx.userId, messageIdOf('freemail', m.run));
    // `triage-error` makes the triage call fail: it falls through to the extraction.
    expect(await runThread(m.ctx.userId, free)).toMatchObject({ outcome: 'done' });
    expect(triageCalls()).toBe(1);
    expect(extractCalls()).toBe(1);
    const people = await peopleOf(m.ctx.userId);
    expect(people.map((p) => dec(p.name_enc))).toEqual(['Ola Nowak']);
    // FR-014: gmail.com is on the free-mail list, the participant is flagged free_mail for the model, and no
    // company (or company domain) is created for it.
    expect(isFreeMailDomain('gmail.com')).toBe(true);
    expect(llmCalls.find((c) => c.kind === 'extract')!.user).toMatch(
      /ola\.nowak@gmail\.com \|[^|\n]*free_mail/,
    );
    expect(await companiesOf(m.ctx.userId)).toEqual([]);
    expect(
      await q('select id from hub_company_domain where user_id = $1', [m.ctx.userId]),
    ).toEqual([]);

    const self = await threadIdOf(m.ctx.userId, messageIdOf('owner-self', m.run));
    expect(await runThread(m.ctx.userId, self)).toMatchObject({
      outcome: 'skipped',
      skipReason: 'owner_only',
    });
    const info = await threadIdOf(m.ctx.userId, messageIdOf('info', m.run));
    expect(await runThread(m.ctx.userId, info)).toMatchObject({
      outcome: 'skipped',
      skipReason: 'irrelevant',
    });
    expect(extractCalls()).toBe(2);
    expect((await peopleOf(m.ctx.userId)).length).toBe(1);
    expect((await emailsOf(m.ctx.userId)).map((e) => dec(e.address_enc))).toEqual([
      'ola.nowak@gmail.com',
    ]);
    const [setting] = await getDb()
      .select()
      .from(hubMailboxSetting)
      .where(eq(hubMailboxSetting.sourceId, m.sourceId));
    expect(setting).toMatchObject({ threadsProcessed: 1, threadsSkipped: 2 });
  }, 60_000);

  it("the owner's addresses include disconnected sources", async () => {
    const ctx = await newUser();
    const old = `old-${randomUUID().slice(0, 8)}@owner-old.example`;
    await getDb()
      .insert(connectedSource)
      .values({
        userId: ctx.userId,
        type: 'imap',
        accountLabel: old,
        accountAddress: old,
        status: 'disconnected',
        consentTextVersion: 'v1',
      } as typeof connectedSource.$inferInsert);
    const m = await mailbox(['owner-old'], { ctx, extraVars: { OLD_OWNER: old } });
    const threadId = await threadIdOf(ctx.userId, messageIdOf('owner-old', m.run));
    expect(await runThread(ctx.userId, threadId)).toMatchObject({
      outcome: 'skipped',
      skipReason: 'owner_only',
    });
    expect(extractCalls()).toBe(0);
  }, 60_000);

  it('SC-005: a sender with two addresses stays one person; two senders run no triage', async () => {
    const m = await mailbox(['two-addresses-1', 'two-addresses-2']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('two-addresses-1', m.run));
    expect(await threadIdOf(m.ctx.userId, messageIdOf('two-addresses-2', m.run))).toBe(threadId);
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
    expect(triageCalls()).toBe(0);
    expect((await peopleOf(m.ctx.userId)).length).toBe(1);
  }, 60_000);
});

describe('hub.thread: automated mail (US3 AS2)', () => {
  it('skips a newsletter and a no-reply notification as automated, a triaged system mail as automated_llm', async () => {
    const m = await mailbox(['newsletter', 'notification', 'triage-automated']);
    for (const name of ['newsletter', 'notification']) {
      const id = await threadIdOf(m.ctx.userId, messageIdOf(name, m.run));
      expect(await runThread(m.ctx.userId, id)).toMatchObject({
        outcome: 'skipped',
        skipReason: 'automated',
      });
    }
    expect(llmCalls).toEqual([]);
    const triaged = await threadIdOf(m.ctx.userId, messageIdOf('triage-automated', m.run));
    expect(await runThread(m.ctx.userId, triaged)).toMatchObject({
      outcome: 'skipped',
      skipReason: 'automated_llm',
    });
    expect(triageCalls()).toBe(1);
    expect(extractCalls()).toBe(0);
    expect(await peopleOf(m.ctx.userId)).toEqual([]);
    expect(await companiesOf(m.ctx.userId)).toEqual([]);
    expect((await threadOf(triaged)).status).toBe('skipped');
    // Triage writes its cost row too; counters only.
    const rows = await llmRowsOf(m.ctx.userId);
    expect(rows.map((r) => r.purpose)).toEqual(['triage']);
  }, 60_000);
});

describe('hub.thread: owner edits and markers (US3 AS3, AS4, SC-007)', () => {
  it('AS3: an owner-set phone is kept and the conflict suggestion carries both values', async () => {
    const ctx = await newUser();
    const { record } = await hubRecords.create(ctx, 'person', {
      name: 'Jan Kowalski',
      phone: '+48 600 100 200',
      emails: ['jan@acme.example'],
    });
    const m = await mailbox(['business-1'], { ctx });
    const threadId = await threadIdOf(ctx.userId, messageIdOf('business-1', m.run));
    await runThread(ctx.userId, threadId);
    // A known sender runs no triage.
    expect(triageCalls()).toBe(0);
    const [p] = await peopleOf(ctx.userId);
    expect(p!.id).toBe(record.id);
    expect(dec(p!.phone_enc)).toBe('+48 600 100 200');
    const f = (await factsOf(ctx.userId)).find((x) => x.field === 'phone');
    expect(f).toMatchObject({
      state: 'suggested',
      reason: 'conflict',
      conflict: true,
      person_id: record.id,
      thread_id: threadId,
    });
    expect(dec(f!.previous_value_enc)).toContain('+48 600 100 200');
    expect(dec(f!.value_enc)).toContain('+48 601 234 567');
  }, 60_000);

  it("the user's concurrent edit wins: owner_fields are read inside the apply lock", async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    await runThread(m.ctx.userId, threadId);
    const [p] = await peopleOf(m.ctx.userId);
    await deliver(m, ['business-2']);
    applySpy.mockImplementationOnce(async (...args) => {
      // The user edits the phone while the model call is running.
      await hubRecords.patch(m.ctx, 'person', p!.id, { phone: '+48 699 999 999' });
      return realApply(...args);
    });
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
    const [after] = await peopleOf(m.ctx.userId);
    expect(dec(after!.phone_enc)).toBe('+48 699 999 999');
    expect(after!.owner_fields).toContain('phone');
  }, 60_000);

  it('AS4: a deleted value, a deleted link and a rejected suggestion are not re-added', async () => {
    const m = await mailbox(['business-1', 'orion']);
    await runThread(m.ctx.userId, await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run)));
    const [p] = await peopleOf(m.ctx.userId);
    const [link] = await linksOf(m.ctx.userId);
    await hubRecords.patch(m.ctx, 'person', p!.id, { phone: null });
    await links.remove(m.ctx, link!.id);
    await q('insert into hub_block_marker (user_id, key_hash, reason) values ($1, $2, $3)', [
      m.ctx.userId,
      markerKey.projectName('Orion'),
      'rejected',
    ]);

    const orion = await threadIdOf(m.ctx.userId, messageIdOf('orion', m.run));
    await runThread(m.ctx.userId, orion);
    const [after] = await peopleOf(m.ctx.userId);
    expect(after!.phone_enc).toBeNull();
    expect((await linksOf(m.ctx.userId)).filter((l) => l.kind === 'person_company')).toEqual([]);
    expect(await projectsOf(m.ctx.userId)).toEqual([]);
    // At most a suggestion, marked as tombstoned.
    const fromOrion = (await factsOf(m.ctx.userId)).filter((f) => f.thread_id === orion);
    // A marker (deleted link, rejected project) gives at most a `tombstoned` suggestion; a value the owner cleared
    // is an owner field, so the email value is at most a suggestion as well.
    const markerFacts = fromOrion.filter((x) => x.type === 'project' || x.type === 'link');
    for (const f of markerFacts) expect(f.state).toBe('suggested');
    expect(markerFacts.find((f) => f.type === 'project')).toMatchObject({ reason: 'tombstoned' });
    const worksAt = markerFacts.find(
      (f) => f.type === 'link' && f.person_id === p!.id && f.company_id !== null,
    );
    expect(worksAt).toMatchObject({ reason: 'tombstoned' });
    for (const f of fromOrion.filter((x) => x.field === 'phone')) expect(f.state).toBe('suggested');
  }, 60_000);
});

describe('hub.thread: mailboxes and versions (US3 AS7, AS8)', () => {
  it('AS7: one thread in two mailboxes is processed once; a new message updates the summary', async () => {
    const ctx = await newUser();
    const run = randomUUID().slice(0, 8);
    const box2 = uniqueMailbox('hub-thread-b');
    const a = await mailbox([], { ctx });
    for (const box of [a.box, box2])
      await seed(box, ['shared'], { OWNER: a.box, OWNER2: box2, RUN: run });
    await deliver(a, []);
    const b = await sources.connectImap(ctx, {
      host: GREENMAIL_HOST,
      port: GREENMAIL_IMAPS_PORT,
      tlsMode: 'tls',
      username: box2,
      password: 'password',
    });
    await mailboxes.enable(ctx, b.id, { acknowledgeAi: true });
    await drainImport(b.id);

    const threadId = await threadIdOf(ctx.userId, messageIdOf('shared', run));
    const sourcesOf = await q<{ source_id: string }>(
      'select source_id from hub_thread_source where thread_id = $1',
      [threadId],
    );
    expect(sourcesOf.map((s) => s.source_id).sort()).toEqual([a.sourceId, b.id].sort());
    const t0 = await threadOf(threadId);
    expect(t0.version).toBe('1');

    expect(await runThread(ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
    expect(extractCalls()).toBe(1);
    expect(fetchedRefs).toHaveLength(1);
    expect(await runThread(ctx.userId, threadId)).toMatchObject({ outcome: 'not_claimed' });
    expect(extractCalls()).toBe(1);
    const t1 = await threadOf(threadId);
    expect(t1.summary_version).toBe(1);
    expect((await projectsOf(ctx.userId)).map((j) => dec(j.name_enc))).toEqual(['Orion']);
  }, 90_000);

  it('a new message arriving during the run leaves the thread pending; the next run reflects it (summary_version + 1)', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    applySpy.mockImplementationOnce(async (...args) => {
      await deliver(m, ['business-2']);
      return realApply(...args);
    });
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
    const mid = await threadOf(threadId);
    expect(mid).toMatchObject({
      status: 'pending',
      version: '2',
      processed_version: '1',
      locked_until: null,
    });
    expect(mid.next_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(mid.summary_version).toBe(1);

    // The sweep enqueues it (no debounce left), and the next run sees both messages.
    enqueued.length = 0;
    await hubThreadSweep();
    expect(enqueued).toContainEqual({
      name: 'hub.thread',
      payload: { userId: m.ctx.userId, threadId, version: 2 },
      opts: { jobId: jobIds.hubThread(threadId, 2) },
    });
    fetchedRefs.length = 0;
    expect(await runThread(m.ctx.userId, threadId, { due: false })).toMatchObject({
      outcome: 'done',
    });
    expect(fetchedRefs.flat()).toHaveLength(2);
    const last = await threadOf(threadId);
    expect(last).toMatchObject({
      status: 'done',
      processed_version: '2',
      summary_version: 2,
      message_count: 2,
    });
    expect(last.last_message_at?.toISOString()).toBe('2026-09-09T11:30:00.000Z');
    // The previous summary is handed to the model.
    expect(llmCalls.filter((c) => c.kind === 'extract').at(-1)!.user).toContain(
      '<previous_summary>',
    );
    const summaries = await q(
      'select * from hub_sync_item where user_id = $1 and entity_type = $2',
      [m.ctx.userId, 'summary'],
    );
    expect(summaries).toHaveLength(1);
  }, 90_000);

  it('AS8 / FR-021: an ignored address and an ignored domain (with subdomain) create nothing; deleting the rule restores processing', async () => {
    const m = await mailbox(['business-1', 'subdomain', 'freemail']);
    const freeRule = await ignoreRules.create(m.ctx, {
      kind: 'address',
      value: 'Ola.Nowak@gmail.com',
    });
    const domainRule = await ignoreRules.create(m.ctx, { kind: 'domain', value: 'acme.example' });
    const biz = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    const sub = await threadIdOf(m.ctx.userId, messageIdOf('subdomain', m.run));
    const free = await threadIdOf(m.ctx.userId, messageIdOf('freemail', m.run));
    for (const id of [biz, sub, free]) {
      expect(await runThread(m.ctx.userId, id)).toMatchObject({
        outcome: 'skipped',
        skipReason: 'ignored',
      });
    }
    expect(llmCalls).toEqual([]);
    expect(await peopleOf(m.ctx.userId)).toEqual([]);
    expect(await companiesOf(m.ctx.userId)).toEqual([]);
    expect(await factsOf(m.ctx.userId)).toEqual([]);

    await ignoreRules.remove(m.ctx, domainRule.id);
    await q(
      "update hub_thread set status = 'pending', skip_reason = null, processed_version = 0 where id = $1",
      [biz],
    );
    expect(await runThread(m.ctx.userId, biz)).toMatchObject({ outcome: 'done' });
    expect((await peopleOf(m.ctx.userId)).map((p) => dec(p.name_enc))).toEqual(['Jan Kowalski']);
    expect(freeRule.kind).toBe('address');
  }, 60_000);
});

describe('hub.thread: claim, lease, cap and errors (contracts/jobs.md (11))', () => {
  it('claims under a 600 s lease and sets processed_version only while the lease is held', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    let leaseSeconds = 0;
    applySpy.mockImplementationOnce(async (...args) => {
      const [row] = await q<{ s: number }>(
        'select extract(epoch from locked_until - now())::float as s from hub_thread where id = $1',
        [threadId],
      );
      leaseSeconds = row!.s;
      // The lease runs out before the apply commits (a run slower than 600 s).
      await q("update hub_thread set locked_until = now() - interval '1 second' where id = $1", [
        threadId,
      ]);
      return realApply(...args);
    });
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'lease_lost' });
    expect(leaseSeconds).toBeGreaterThan(590);
    expect(leaseSeconds).toBeLessThanOrEqual(600);
    const t = await threadOf(threadId);
    expect(t).toMatchObject({ status: 'pending', processed_version: '0' });
    expect(await peopleOf(m.ctx.userId)).toEqual([]);

    // The sweep expires the lease and re-enqueues the thread.
    enqueued.length = 0;
    const swept = await hubThreadSweep();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect((await threadOf(threadId)).locked_until).toBeNull();
    expect(enqueued.some((e) => e.name === 'hub.thread' && e.payload.threadId === threadId)).toBe(
      true,
    );
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
  }, 60_000);

  it('aborts for a user who is not active, and for a thread that is gone', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    await getDb().update(user).set({ status: 'suspended' }).where(eq(user.id, m.ctx.userId));
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'aborted' });
    await getDb().update(user).set({ status: 'active' }).where(eq(user.id, m.ctx.userId));
    expect(await runThread(m.ctx.userId, randomUUID())).toMatchObject({ outcome: 'aborted' });
    expect(fetchedRefs).toEqual([]);
  }, 60_000);

  it('llm_refused is final; llm_bad_output fails after two calls; bad-once succeeds on the retry', async () => {
    const m = await mailbox(['refuse', 'bad-twice', 'bad-once']);
    const refuse = await threadIdOf(m.ctx.userId, messageIdOf('refuse', m.run));
    expect(await runThread(m.ctx.userId, refuse)).toMatchObject({
      outcome: 'failed',
      errorCode: 'llm_refused',
    });
    expect(await threadOf(refuse)).toMatchObject({
      status: 'failed',
      last_error_code: 'llm_refused',
      next_attempt_at: null,
      attempts: 1,
    });

    llmCalls.length = 0;
    const bad = await threadIdOf(m.ctx.userId, messageIdOf('bad-twice', m.run));
    expect(await runThread(m.ctx.userId, bad)).toMatchObject({
      outcome: 'failed',
      errorCode: 'llm_bad_output',
    });
    expect(extractCalls()).toBe(2);
    expect(await threadOf(bad)).toMatchObject({ status: 'failed', next_attempt_at: null });

    llmCalls.length = 0;
    const once = await threadIdOf(m.ctx.userId, messageIdOf('bad-once', m.run));
    expect(await runThread(m.ctx.userId, once)).toMatchObject({ outcome: 'done' });
    expect(extractCalls()).toBe(2);
    // A schema retry writes two cost rows for one thread.
    const rows = (await llmRowsOf(m.ctx.userId)).filter(
      (r) => r.thread_id === once && r.purpose === 'extract',
    );
    expect(rows).toHaveLength(2);
  }, 60_000);

  it('429 and 5xx back off min(5 s * 2^(n-1), 15 min) +/-20% and fail after 8 attempts', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    llmFailures.push(429);
    // The handler writes next_attempt_at somewhere in [before, after]: bound the jittered backoff from both ends
    // (earliest from `before`, latest from `after`) so the check does not depend on how long the run took.
    const before = Date.now();
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'retry',
      errorCode: 'llm_rate_limited',
    });
    const after = Date.now();
    let t = await threadOf(threadId);
    expect(t).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error_code: 'llm_rate_limited',
      locked_until: null,
    });
    // Attempt 1: 5 s +/-20% = [4 s, 6 s], with 100 ms for clock rounding.
    expect(t.next_attempt_at!.getTime() - before).toBeGreaterThanOrEqual(4_000 - 100);
    expect(t.next_attempt_at!.getTime() - after).toBeLessThanOrEqual(6_000 + 100);

    // Attempt 7: 5 s * 2^6 = 320 s +/-20%.
    await q('update hub_thread set attempts = 6 where id = $1', [threadId]);
    llmFailures.push(503);
    const before7 = Date.now();
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'retry',
      errorCode: 'llm_unavailable',
    });
    const after7 = Date.now();
    t = await threadOf(threadId);
    expect(t.attempts).toBe(7);
    expect(t.next_attempt_at!.getTime() - before7).toBeGreaterThanOrEqual(256_000 - 100);
    expect(t.next_attempt_at!.getTime() - after7).toBeLessThanOrEqual(384_000 + 100);

    llmFailures.push(500);
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'failed',
      errorCode: 'llm_unavailable',
    });
    t = await threadOf(threadId);
    expect(t).toMatchObject({
      status: 'failed',
      attempts: HUB_THREAD_MAX_ATTEMPTS,
      next_attempt_at: null,
    });
  }, 60_000);

  it('fetch_unavailable and source_auth retry in 15 min without counting an attempt', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    const quarter = 15 * 60_000;

    // next_attempt_at is written in [before, after]: earliest bound from `before`, latest from `after`.
    fetchMode = 'throw';
    let before = Date.now();
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'released',
      errorCode: 'fetch_unavailable',
    });
    let after = Date.now();
    let t = await threadOf(threadId);
    expect(t).toMatchObject({
      status: 'pending',
      attempts: 0,
      last_error_code: 'fetch_unavailable',
      locked_until: null,
    });
    expect(t.next_attempt_at!.getTime() - before).toBeGreaterThanOrEqual(quarter - 100);
    expect(t.next_attempt_at!.getTime() - after).toBeLessThanOrEqual(quarter + 100);

    fetchMode = 'auth';
    before = Date.now();
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'released',
      errorCode: 'source_auth',
    });
    after = Date.now();
    t = await threadOf(threadId);
    expect(t).toMatchObject({ attempts: 0, last_error_code: 'source_auth' });
    expect(t.next_attempt_at!.getTime() - before).toBeGreaterThanOrEqual(quarter - 100);
    expect(t.next_attempt_at!.getTime() - after).toBeLessThanOrEqual(quarter + 100);
    const [src] = await getDb()
      .select()
      .from(connectedSource)
      .where(eq(connectedSource.id, m.sourceId));
    expect(src!.status).toBe('needs_reconnection');

    // While the only source needs reconnection, nothing is fetched at all.
    fetchMode = 'ok';
    fetchedRefs.length = 0;
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'released',
      errorCode: 'source_auth',
    });
    expect(fetchedRefs).toEqual([]);
    await getDb()
      .update(connectedSource)
      .set({ status: 'connected' })
      .where(eq(connectedSource.id, m.sourceId));
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
  }, 60_000);

  it('inspection_failed retries (classifier down, apply inspection unavailable); apply_failed backs off', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    classifierDown = true;
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'retry',
      errorCode: 'inspection_failed',
    });
    expect(extractCalls()).toBe(0);
    classifierDown = false;

    applySpy.mockRejectedValueOnce(new AppError('inspection_unavailable'));
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'retry',
      errorCode: 'inspection_failed',
    });
    applySpy.mockRejectedValueOnce(new Error('insert into hub_person ... Jan Kowalski'));
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'retry',
      errorCode: 'apply_failed',
    });
    const t = await threadOf(threadId);
    expect(t).toMatchObject({ status: 'pending', attempts: 3, last_error_code: 'apply_failed' });
    expect(logLines.join('\n')).not.toContain('Jan Kowalski');
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
  }, 60_000);

  it('daily_cap_reached releases to the next UTC midnight without counting an attempt (distinct threads)', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    // 500 other threads (the default cap) already had an extraction call in the last 24 h.
    await q(
      `with t as (
         insert into hub_thread (user_id, thread_key, status, version, processed_version)
         select $1, md5(random()::text) || md5(random()::text), 'done', 1, 1 from generate_series(1, 500)
         returning id)
       insert into hub_llm_call (user_id, thread_id, purpose, model, prompt_version, input_tokens, output_tokens)
       select $1, id, 'extract', 'm', 'hub-extract-v1', 1, 1 from t`,
      [m.ctx.userId],
    );
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({
      outcome: 'released',
      errorCode: 'daily_cap_reached',
    });
    const t = await threadOf(threadId);
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    expect(t).toMatchObject({
      status: 'pending',
      attempts: 0,
      last_error_code: 'daily_cap_reached',
    });
    expect(t.next_attempt_at!.getTime()).toBe(midnight);
    expect(fetchedRefs).toEqual([]);

    // A schema retry's two rows count as one thread: one thread fewer brings it under the cap.
    await q(
      `update hub_llm_call set thread_id = (select thread_id from hub_llm_call where user_id = $1 order by id limit 1)
       where id = (select id from hub_llm_call where user_id = $1 order by id desc limit 1)`,
      [m.ctx.userId],
    );
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
  }, 60_000);

  it('maintenance.hub-thread-sweep enqueues due pending threads and expires leases', async () => {
    const m = await mailbox(['business-1', 'freemail']);
    const biz = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    const free = await threadIdOf(m.ctx.userId, messageIdOf('freemail', m.run));
    await q("update hub_thread set next_attempt_at = now() - interval '1 second' where id = $1", [
      biz,
    ]);
    await q("update hub_thread set next_attempt_at = now() + interval '1 hour' where id = $1", [
      free,
    ]);
    enqueued.length = 0;
    await hubThreadSweep();
    const mine = enqueued.filter((e) => e.payload.userId === m.ctx.userId);
    expect(mine).toEqual([
      {
        name: 'hub.thread',
        payload: { userId: m.ctx.userId, threadId: biz, version: 1 },
        opts: { jobId: jobIds.hubThread(biz, 1) },
      },
    ]);

    // A live lease keeps it out of the sweep; an expired one is cleared.
    await q("update hub_thread set locked_until = now() + interval '5 minutes' where id = $1", [
      biz,
    ]);
    enqueued.length = 0;
    await hubThreadSweep();
    expect(enqueued.filter((e) => e.payload.threadId === biz)).toEqual([]);
    await q("update hub_thread set locked_until = now() - interval '1 second' where id = $1", [
      biz,
    ]);
    await hubThreadSweep();
    expect((await threadOf(biz)).locked_until).toBeNull();
  }, 60_000);
});

describe('hub.thread: privacy and latency (SC-008, SC-009)', () => {
  it('BODY-SENTINEL appears in no hub table, no memory document and no log line; hub_llm_call holds counts only', async () => {
    const m = await mailbox(['business-1', 'business-2']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    logLines.length = 0;
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });

    // The cleaned body reached the model (the sentinel is authored text) but quoted history and the footer did not.
    const prompt = llmCalls.find((c) => c.kind === 'extract')!.user;
    expect(prompt).toContain(BODY_SENTINEL);
    expect(prompt).not.toContain('QUOTED-HISTORY');
    expect(prompt).not.toContain('przeznaczona wyłącznie dla adresata');

    expect(await hubDump(m.ctx.userId)).not.toContain(BODY_SENTINEL);
    for (const entity of ['summary'] as const) {
      const doc = await buildDocumentFor(m.ctx.userId, entity, threadId, { classifier });
      expect(JSON.stringify(doc)).not.toContain(BODY_SENTINEL);
    }
    const [p] = await peopleOf(m.ctx.userId);
    expect(
      JSON.stringify(await buildDocumentFor(m.ctx.userId, 'person', p!.id, { classifier })),
    ).not.toContain(BODY_SENTINEL);
    const log = logLines.join('\n');
    expect(log).not.toContain(BODY_SENTINEL);
    expect(log).not.toContain('Jan Kowalski');
    expect(log).not.toContain('jan@acme.example');
    expect(log).not.toContain('Zapytanie');
    expect(log).toContain(threadId);

    const rows = await llmRowsOf(m.ctx.userId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        [
          'created_at',
          'id',
          'input_tokens',
          'model',
          'output_tokens',
          'prompt_version',
          'purpose',
          'stop_reason',
          'thread_id',
          'user_id',
        ].sort(),
      );
    }
    expect(JSON.stringify(rows)).not.toContain(BODY_SENTINEL);
  }, 60_000);

  it('SC-009: inbox-to-hub latency with the 60 s debounce stays under 15 min', async () => {
    const m = await mailbox(['business-1']);
    const threadId = await threadIdOf(m.ctx.userId, messageIdOf('business-1', m.run));
    const t = await threadOf(threadId);
    const recordedAt = Date.now();
    const debounce = t.next_attempt_at!.getTime() - recordedAt;
    expect(debounce).toBeLessThanOrEqual(61_000);
    const job = enqueued.find((e) => e.name === 'hub.thread' && e.payload.threadId === threadId);
    expect(job?.opts.delay).toBe(60_000);

    const started = Date.now();
    expect(await runThread(m.ctx.userId, threadId)).toMatchObject({ outcome: 'done' });
    const runMs = Date.now() - started;
    // Poll interval (at most 10 min) + debounce + one sweep minute + the run itself.
    const pollMs = Number(process.env.SYNC_POLL_INTERVAL_MINUTES ?? 5) * 60_000;
    expect(pollMs + debounce + 60_000 + runMs).toBeLessThan(15 * 60_000);
  }, 60_000);
});
