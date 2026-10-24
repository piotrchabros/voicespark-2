import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  connectedSource,
  contentItemOccurrence,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  getPool,
  hubMailboxSetting,
  hubMessage,
  hubMessageSource,
  hubSyncItem,
  hubThread,
  hubThreadSource,
  user,
} from '@voicespark/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { jobIds, type JobPayload } from '@voicespark/core/queues';
import type { ServiceContext } from '@voicespark/core/errors';
import { logger } from '@voicespark/core/logger';
import * as hubIngest from '@voicespark/core/services/hub/ingest';
import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import * as imports from '@voicespark/core/services/imports';
import { configureMailAccess } from '@voicespark/core/services/mail-access';
import * as sources from '@voicespark/core/services/sources';
import { createRecordedClassifier } from '@voicespark/filters';
import type { MailFetcher, MailRef } from '@voicespark/integrations/mail';
import { parseMessage } from '@voicespark/integrations/mime';
import { InMemoryMemoryStore } from '@voicespark/integrations/supermemory';
import { defaultDeps } from '../src/deps';
import { createImportHandler } from '../src/processors/import';
import { GREENMAIL_HOST, GREENMAIL_IMAPS_PORT, uniqueMailbox } from './helpers/greenmail';

// T102 (US3 sub-step c; contracts/jobs.md (1) and (12)): the import hook of the hub and `hub.backfill`, over GreenMail.
// Deterministic: no BullMQ worker. Every enqueue is captured; queued `import.page` payloads are run by hand.
// `recordMessage` is the real function behind a spy, so calls can be counted and one failure injected.
// Needs Postgres, Redis (per-source lock) and GreenMail (IMAPS 3993).

type PagePayload = JobPayload<'import.page'>;
type BackfillPayload = JobPayload<'hub.backfill'>;
interface Enqueued {
  name: string;
  payload: Record<string, unknown>;
  opts: { jobId?: string; delay?: number };
}
const enqueued: Enqueued[] = [];

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async (name: string, payload: Record<string, unknown>, opts: Enqueued['opts'] = {}) => {
    enqueued.push({ name, payload, opts });
    return {};
  }),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

vi.mock('@voicespark/integrations/mime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voicespark/integrations/mime')>();
  return { ...actual, parseMessage: vi.fn(actual.parseMessage) };
});

vi.mock('@voicespark/core/services/hub/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voicespark/core/services/hub/ingest')>();
  return { ...actual, recordMessage: vi.fn(actual.recordMessage) };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const recordMessage = vi.mocked(hubIngest.recordMessage);
const store = new InMemoryMemoryStore();
const importHandler = createImportHandler({ store, classifier: createRecordedClassifier() });

const BODY_SENTINEL = 'BODY-SENTINEL-hub-ingest';
const DEBOUNCE_MS = 60_000;
const FIFTEEN_MIN_MS = 15 * 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Mail fixtures (synthetic, `.example` domains)

interface Mail {
  messageId: string | null;
  subject: string;
  date: Date;
  body: string;
  from?: string;
  inReplyTo?: string;
  references?: string[];
}

function rfc822(m: Mail, to: string): Buffer {
  const lines = [
    ...(m.messageId ? [`Message-ID: ${m.messageId}`] : []),
    `Date: ${m.date.toUTCString()}`,
    `From: ${m.from ?? 'Jan Kowalski <jan@acme.example>'}`,
    `To: ${to}`,
    `Subject: ${m.subject}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    m.body,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

async function seed(box: string, mails: Mail[], folder = 'INBOX'): Promise<void> {
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
    if (folder !== 'INBOX') await client.mailboxCreate(folder).catch(() => undefined);
    for (const m of mails) await client.append(folder, rfc822(m, box), [], m.date);
  } finally {
    await client.logout();
  }
}

const day = (n: number) => new Date(Date.UTC(2024, 2, 1) + n * 3_600_000);

const prose = (topic: string) =>
  `Dear Anna, thank you for the meeting about the ${topic}. We will send the revised plan next week. ${BODY_SENTINEL} Best regards, Jan`;

// ---------------------------------------------------------------------------------------------------------------
// Harness

const userIds: string[] = [];

async function newUser(): Promise<ServiceContext> {
  const db = getDb();
  const [u] = await db
    .insert(user)
    .values({ name: 'Hub Ingest', email: `hub-ingest-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(u!.id);
  await db
    .insert(filterPreferences)
    .values({ userId: u!.id, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: new Date() });
  return { userId: u!.id, role: 'user' };
}

const imapCfg = (username: string) => ({
  host: GREENMAIL_HOST,
  port: GREENMAIL_IMAPS_PORT,
  tlsMode: 'tls' as const,
  username,
  password: 'password',
});

function fakeJob<P>(name: string, id: string, data: P) {
  return {
    id,
    name,
    data,
    attemptsMade: 0,
    opts: { attempts: 5 },
    moveToDelayed: vi.fn(async () => undefined),
    updateData: vi.fn(async () => undefined),
  };
}

function takeEnqueued(name: string, pred: (e: Enqueued) => boolean = () => true): Enqueued[] {
  const out: Enqueued[] = [];
  for (let i = 0; i < enqueued.length; ) {
    if (enqueued[i]!.name === name && pred(enqueued[i]!)) out.push(...enqueued.splice(i, 1));
    else i++;
  }
  return out;
}

/** Runs every queued `import.page` of the source until none is left. */
async function drainImport(sourceId: string): Promise<void> {
  for (let guard = 0; ; guard++) {
    expect(guard).toBeLessThan(100);
    const idx = enqueued.findIndex((e) => e.name === 'import.page' && e.payload.sourceId === sourceId);
    if (idx < 0) return;
    const payload = enqueued.splice(idx, 1)[0]!.payload as unknown as PagePayload;
    await importHandler(
      fakeJob('import.page', jobIds.importPage(payload.sourceId, Date.now()), payload) as unknown as Job<
        PagePayload,
        unknown,
        'import.page'
      >,
      'token',
    );
  }
}

async function connectAndImport(ctx: ServiceContext, box: string, opts: { hub: boolean }) {
  const source = await sources.connectImap(ctx, imapCfg(box));
  if (opts.hub) {
    await mailboxes.enable(ctx, source.id, { acknowledgeAi: true });
    takeEnqueued('hub.backfill', (e) => e.payload.sourceId === source.id);
  }
  await drainImport(source.id);
  return source;
}

async function incremental(ctx: ServiceContext, sourceId: string): Promise<void> {
  const job = await imports.createJob({ userId: ctx.userId, sourceId, kind: 'incremental' });
  await imports.enqueuePage({ userId: ctx.userId, sourceId, importJobId: job.id });
  await drainImport(sourceId);
}

async function hubRows(userId: string) {
  const db = getDb();
  return {
    threads: await db.select().from(hubThread).where(eq(hubThread.userId, userId)),
    messages: await db.select().from(hubMessage).where(eq(hubMessage.userId, userId)),
    messageSources: await db.select().from(hubMessageSource).where(eq(hubMessageSource.userId, userId)),
    threadSources: await db.select().from(hubThreadSource).where(eq(hubThreadSource.userId, userId)),
  };
}

async function occurrenceRefs(sourceId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ ref: contentItemOccurrence.providerRef })
    .from(contentItemOccurrence)
    .where(eq(contentItemOccurrence.sourceId, sourceId));
  return rows.map((r) => r.ref);
}

const recordedRefs = (sourceId: string) =>
  recordMessage.mock.calls.filter(([i]) => i.sourceId === sourceId).map(([i]) => i.providerRef);

beforeAll(async () => {
  await getPool().query('select 1');
  configureMailAccess({ imap: { rejectUnauthorized: false } });
});

afterEach(() => {
  enqueued.length = 0;
  recordMessage.mockReset();
  vi.mocked(parseMessage).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

// ---------------------------------------------------------------------------------------------------------------

describe('import.page hub hook (contracts/jobs.md (1))', () => {
  it('a mailbox without the hub never calls recordMessage and leaves every hub table empty (AS3.9)', async () => {
    const ctx = await newUser();
    const box = uniqueMailbox('hub-off');
    await seed(box, [
      { messageId: '<off-1@acme.example>', subject: 'Offer', date: day(1), body: prose('offer') },
      {
        messageId: '<off-2@acme.example>',
        subject: 'Re: Offer',
        date: day(2),
        body: prose('reply'),
        inReplyTo: '<off-1@acme.example>',
        references: ['<off-1@acme.example>'],
      },
    ]);
    const source = await connectAndImport(ctx, box, { hub: false });

    expect((await occurrenceRefs(source.id)).length).toBe(2);
    expect(recordMessage).not.toHaveBeenCalled();
    const rows = await hubRows(ctx.userId);
    expect(rows.threads).toEqual([]);
    expect(rows.messages).toEqual([]);
    expect(rows.messageSources).toEqual([]);
    expect(rows.threadSources).toEqual([]);
    expect(takeEnqueued('hub.thread')).toEqual([]);
  }, 60_000);

  it('records imported and duplicate messages as metadata only; excluded and failed are not recorded', async () => {
    const ctx = await newUser();
    const box = uniqueMailbox('hub-on');
    await seed(box, [
      { messageId: '<on-1@acme.example>', subject: 'Project kickoff', date: day(1), body: prose('kickoff') },
      {
        messageId: '<on-2@acme.example>',
        subject: 'Re: Project kickoff',
        date: day(2),
        body: prose('kickoff follow-up'),
        inReplyTo: '<on-1@acme.example>',
        references: ['<on-1@acme.example>'],
      },
      // Excluded by the reset-link category: never recorded.
      {
        messageId: '<on-secret@acme.example>',
        subject: 'Access',
        date: day(3),
        body: 'Please reset your password using this link: https://accounts.example.test/reset?token=Zx81Qw93Lm20Pa77Rt44 before Friday.',
      },
    ]);
    // The same message twice in one mailbox (INBOX and a label folder): the second is a duplicate outcome.
    await seed(
      box,
      [{ messageId: '<on-1@acme.example>', subject: 'Project kickoff', date: day(1), body: prose('kickoff') }],
      'Clients',
    );
    const source = await connectAndImport(ctx, box, { hub: true });

    const job = await getDb()
      .select({ excluded: sql<number>`items_excluded`, duplicate: sql<number>`items_duplicate` })
      .from(sql`import_job`)
      .where(sql`source_id = ${source.id}`);
    expect(job[0]!.excluded).toBe(1);
    expect(job[0]!.duplicate).toBe(1);

    // imported (2) + duplicate (1); the excluded message never reaches recordMessage.
    expect(recordMessage).toHaveBeenCalledTimes(3);
    const rows = await hubRows(ctx.userId);
    expect(rows.threads).toHaveLength(1);
    expect(rows.messages).toHaveLength(2);
    expect(rows.messageSources).toHaveLength(3);
    expect(rows.threadSources).toHaveLength(1);
    expect(rows.threadSources[0]!.sourceId).toBe(source.id);
    const thread = rows.threads[0]!;
    expect(thread.messageCount).toBe(2);
    expect(thread.status).toBe('pending');
    expect(thread.version).toBe(2);
    expect(thread.processedVersion).toBe(0);

    // Hashes only: 64-hex HMACs, the reply links its parent, and no column holds the body or a raw id.
    for (const m of rows.messages) expect(m.messageIdHash).toMatch(/^[0-9a-f]{64}$/);
    const reply = rows.messages.find((m) => m.inReplyToHash !== null)!;
    const parent = rows.messages.find((m) => m.inReplyToHash === null)!;
    expect(reply.inReplyToHash).toBe(parent.messageIdHash);
    expect(reply.referencesHashes).toEqual([parent.messageIdHash]);
    expect(reply.direction).toBe('inbound');
    const columns = await getPool().query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_name in ('hub_thread','hub_message','hub_message_source','hub_thread_source')`,
    );
    expect(columns.rows.filter((c) => /body|text|raw|html/.test(c.column_name))).toEqual([]);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(BODY_SENTINEL);
    expect(dump).not.toContain('on-1@acme.example');
    expect(dump).not.toContain('Project kickoff');
    expect(dump).not.toContain('Zx81Qw93Lm20Pa77Rt44');

    // One hub.thread per version, debounced 60 s.
    const jobs = takeEnqueued('hub.thread');
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    for (const j of jobs) {
      expect(j.payload).toMatchObject({ userId: ctx.userId, threadId: thread.id });
      expect(j.opts.jobId).toBe(jobIds.hubThread(thread.id, j.payload.version as number));
      expect(j.opts.delay).toBe(DEBOUNCE_MS);
    }
    expect(jobs.map((j) => j.payload.version)).toContain(thread.version);
  }, 60_000);

  it('a message that fails to parse is not recorded', async () => {
    const ctx = await newUser();
    const box = uniqueMailbox('hub-failed');
    await seed(box, [{ messageId: '<ok@acme.example>', subject: 'Fine', date: day(1), body: prose('fine') }]);
    const source = await sources.connectImap(ctx, imapCfg(box));
    await mailboxes.enable(ctx, source.id, { acknowledgeAi: true });
    vi.mocked(parseMessage).mockRejectedValueOnce(new Error('parse_failed'));
    await drainImport(source.id);

    const [job] = await getDb()
      .select({ failed: sql<number>`items_failed` })
      .from(sql`import_job`)
      .where(sql`source_id = ${source.id}`);
    expect(job!.failed).toBe(1);
    expect(recordMessage).not.toHaveBeenCalled();
    expect((await hubRows(ctx.userId)).messages).toEqual([]);
  }, 60_000);

  it('the same Message-ID from a second mailbox adds a source row and does not bump version (FR-020)', async () => {
    const ctx = await newUser();
    const boxA = uniqueMailbox('hub-a');
    const boxB = uniqueMailbox('hub-b');
    const shared: Mail = { messageId: '<shared@acme.example>', subject: 'Contract', date: day(5), body: prose('contract') };
    await seed(boxA, [shared]);
    await seed(boxB, [shared]);
    const a = await connectAndImport(ctx, boxA, { hub: true });
    const before = (await hubRows(ctx.userId)).threads[0]!;
    expect(before.version).toBe(1);
    takeEnqueued('hub.thread');

    const b = await connectAndImport(ctx, boxB, { hub: true });
    const rows = await hubRows(ctx.userId);
    expect(rows.threads).toHaveLength(1);
    expect(rows.messages).toHaveLength(1);
    expect(rows.threads[0]!.version).toBe(1);
    expect(rows.messageSources.map((s) => s.sourceId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.threadSources.map((s) => s.sourceId).sort()).toEqual([a.id, b.id].sort());
    expect(takeEnqueued('hub.thread')).toEqual([]);
  }, 60_000);

  it('a new reply bumps version, sets pending with a 60 s debounce and enqueues hub.thread', async () => {
    const ctx = await newUser();
    const box = uniqueMailbox('hub-reply');
    await seed(box, [{ messageId: '<r-1@acme.example>', subject: 'Budget', date: day(1), body: prose('budget') }]);
    const source = await connectAndImport(ctx, box, { hub: true });
    const [t0] = (await hubRows(ctx.userId)).threads;
    // As if hub.thread had processed version 1.
    await getDb()
      .update(hubThread)
      .set({ status: 'done', processedVersion: 1, nextAttemptAt: null, attempts: 3 })
      .where(eq(hubThread.id, t0!.id));
    takeEnqueued('hub.thread');

    await seed(box, [
      {
        messageId: '<r-2@acme.example>',
        subject: 'Re: Budget',
        date: day(2),
        body: prose('budget reply'),
        inReplyTo: '<r-1@acme.example>',
        references: ['<r-1@acme.example>'],
      },
    ]);
    await incremental(ctx, source.id);

    const { rows } = await getPool().query<{
      version: string;
      status: string;
      attempts: number;
      due_in_ms: number;
      message_count: number;
    }>(
      `select version, status, attempts, message_count,
              (extract(epoch from (next_attempt_at - now())) * 1000)::float8 as due_in_ms
       from hub_thread where id = $1`,
      [t0!.id],
    );
    expect(Number(rows[0]!.version)).toBe(2);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.message_count).toBe(2);
    expect(rows[0]!.due_in_ms).toBeGreaterThan(DEBOUNCE_MS - 30_000);
    expect(rows[0]!.due_in_ms).toBeLessThanOrEqual(DEBOUNCE_MS);

    const jobs = takeEnqueued('hub.thread');
    expect(jobs).toEqual([
      {
        name: 'hub.thread',
        payload: { userId: ctx.userId, threadId: t0!.id, version: 2 },
        opts: { jobId: `hubthread-${t0!.id}-2`, delay: DEBOUNCE_MS },
      },
    ]);
  }, 60_000);

  it('a message linking two threads merges them into the older one and tombstones the younger summary', async () => {
    const ctx = await newUser();
    const box = uniqueMailbox('hub-merge');
    await seed(box, [{ messageId: '<x-1@acme.example>', subject: 'Plan X', date: day(1), body: prose('plan x') }]);
    const source = await connectAndImport(ctx, box, { hub: true });
    await seed(box, [{ messageId: '<y-1@beta.example>', subject: 'Plan Y', date: day(2), body: prose('plan y') }]);
    await incremental(ctx, source.id);

    const threads = (await hubRows(ctx.userId)).threads.sort((p, q) => p.createdAt.getTime() - q.createdAt.getTime());
    expect(threads).toHaveLength(2);
    const [older, younger] = threads as [typeof threads[0], typeof threads[0]];
    await getDb().update(hubThread).set({ summaryEnc: 'enc-placeholder', summaryVersion: 1 }).where(eq(hubThread.id, younger.id));

    await seed(box, [
      {
        messageId: '<z-1@acme.example>',
        subject: 'Re: Plan X and Plan Y',
        date: day(3),
        body: prose('both plans'),
        inReplyTo: '<y-1@beta.example>',
        references: ['<x-1@acme.example>', '<y-1@beta.example>'],
      },
    ]);
    await incremental(ctx, source.id);

    const rows = await hubRows(ctx.userId);
    expect(rows.threads.map((t) => t.id)).toEqual([older.id]);
    expect(rows.messages).toHaveLength(3);
    expect(new Set(rows.messages.map((m) => m.threadId))).toEqual(new Set([older.id]));
    expect(rows.threadSources.map((s) => s.threadId)).toEqual([older.id]);
    expect(rows.threads[0]!.messageCount).toBe(3);
    expect(rows.threads[0]!.status).toBe('pending');

    const [tomb] = await getDb()
      .select()
      .from(hubSyncItem)
      .where(and(eq(hubSyncItem.entityType, 'summary'), eq(hubSyncItem.entityId, younger.id)));
    expect(tomb?.deleted).toBe(true);
  }, 60_000);

  it('a recordMessage failure is logged by code and does not fail the page', async () => {
    const ctx = await newUser();
    const box = uniqueMailbox('hub-fail');
    await seed(box, [
      { messageId: '<f-1@acme.example>', subject: 'One', date: day(1), body: prose('one') },
      { messageId: '<f-2@acme.example>', subject: 'Two', date: day(2), body: prose('two') },
    ]);
    const warn = vi.spyOn(logger, 'warn');
    recordMessage.mockRejectedValueOnce(new Error('boom'));
    const source = await connectAndImport(ctx, box, { hub: true });

    const [job] = await getDb()
      .select({ status: sql<string>`status`, imported: sql<number>`items_imported`, failed: sql<number>`items_failed` })
      .from(sql`import_job`)
      .where(sql`source_id = ${source.id}`);
    expect(job).toEqual({ status: 'completed', imported: 2, failed: 0 });
    expect(recordMessage).toHaveBeenCalledTimes(2);
    expect((await hubRows(ctx.userId)).messages).toHaveLength(1);
    const codes = warn.mock.calls.map(([fields]) => fields.errorCode);
    expect(codes).toContain('hub_ingest_failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('boom');
  }, 60_000);

  // One spam and one trash folder per mailbox: without SPECIAL-USE (GreenMail) the client infers each role from
  // the folder name once per mailbox.
  it.each([
    ['Spam', 'Trash'],
    ['Junk', 'Deleted Items'],
  ])('a message in %s or %s is not imported and never reaches recordMessage', async (spam, trash) => {
    const ctx = await newUser();
    const box = uniqueMailbox('hub-spam');
    await seed(box, [{ messageId: '<in@acme.example>', subject: 'Inbox', date: day(1), body: prose('inbox') }]);
    for (const folder of [spam, trash]) {
      await seed(
        box,
        [{ messageId: `<${folder.replace(' ', '-').toLowerCase()}@acme.example>`, subject: folder, date: day(2), body: prose(folder) }],
        folder,
      );
    }
    const source = await connectAndImport(ctx, box, { hub: true });

    const refs = await occurrenceRefs(source.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.startsWith('INBOX|')).toBe(true);
    expect(recordedRefs(source.id)).toEqual(refs);
    expect((await hubRows(ctx.userId)).messages).toHaveLength(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------

describe('hub.backfill (contracts/jobs.md (12))', () => {
  const TOTAL = 150;

  type BackfillModule = {
    createHubBackfillHandler: (overrides?: Record<string, unknown>) => (job: unknown, token?: string) => Promise<unknown>;
  };
  const loadBackfill = async (): Promise<BackfillModule> =>
    (await import('../src/processors/hub-backfill')) as unknown as BackfillModule;

  /** Real IMAP fetcher, with every `fetchMessages` batch recorded. */
  function recordingFetcher(batches: MailRef[][]) {
    const real = defaultDeps({ store, classifier: createRecordedClassifier() }).openFetcher;
    return async (sourceId: string): Promise<MailFetcher> => {
      const f = await real(sourceId);
      return {
        ...f,
        provider: f.provider,
        fetchMessages: async (refs) => {
          batches.push(refs);
          return f.fetchMessages(refs);
        },
      };
    };
  }

  async function setup() {
    const ctx = await newUser();
    const box = uniqueMailbox('hub-backfill');
    const mails: Mail[] = Array.from({ length: TOTAL }, (_, i) => ({
      messageId: `<bf-${i}@acme.example>`,
      subject: `Topic ${i}`,
      date: day(i),
      body: prose(`topic number ${i}`),
    }));
    await seed(box, mails);
    // Imported while the hub was off; the hub is enabled afterwards.
    const source = await connectAndImport(ctx, box, { hub: false });
    expect((await occurrenceRefs(source.id)).length).toBe(TOTAL);
    await mailboxes.enable(ctx, source.id, { acknowledgeAi: true });
    const [queued] = takeEnqueued('hub.backfill');
    expect(queued).toMatchObject({ payload: { userId: ctx.userId, sourceId: source.id }, opts: { jobId: `hubbackfill-${source.id}` } });
    return { ctx, source, payload: queued!.payload as unknown as BackfillPayload };
  }

  const setting = async (sourceId: string) =>
    (await getDb().select().from(hubMailboxSetting).where(eq(hubMailboxSetting.sourceId, sourceId)))[0]!;

  async function runBackfill(handler: Awaited<ReturnType<BackfillModule['createHubBackfillHandler']>>, payload: BackfillPayload) {
    const job = fakeJob('hub.backfill', jobIds.hubBackfill(payload.sourceId), payload);
    let error: unknown;
    try {
      await handler(job, 'token');
    } catch (err) {
      error = err;
    }
    return { job, error };
  }

  /** A reschedule in about 15 min: a delayed re-enqueue or a move of the job to delayed. */
  function rescheduled(job: ReturnType<typeof fakeJob>, sourceId: string): boolean {
    const re = takeEnqueued('hub.backfill', (e) => e.payload.sourceId === sourceId);
    const viaEnqueue = re.some((e) => Math.abs((e.opts.delay ?? 0) - FIFTEEN_MIN_MS) < 60_000);
    const viaMove = job.moveToDelayed.mock.calls.some(
      (c) => Math.abs(Number((c as unknown[])[0]) - (Date.now() + FIFTEEN_MIN_MS)) < 120_000,
    );
    return viaEnqueue || viaMove;
  }

  it('pages occurrences 100 at a time newest first, keeps the cursor, moves pending -> running -> done', async () => {
    const { ctx, source, payload } = await setup();
    expect((await setting(source.id)).backfillState).toBe('pending');

    const batches: MailRef[][] = [];
    const states: string[] = [];
    const recorded: Date[] = [];
    const actual = await vi.importActual<typeof import('@voicespark/core/services/hub/ingest')>(
      '@voicespark/core/services/hub/ingest',
    );
    recordMessage.mockImplementation(async (input) => {
      states.push((await setting(source.id)).backfillState);
      if (input.parsed.date) recorded.push(input.parsed.date);
      return actual.recordMessage(input);
    });
    const handler = (await loadBackfill()).createHubBackfillHandler({ store, openFetcher: recordingFetcher(batches) });

    // Run until done, following any self re-enqueue (one page per run is allowed).
    for (let guard = 0; (await setting(source.id)).backfillState !== 'done'; guard++) {
      expect(guard).toBeLessThan(5);
      const { error } = await runBackfill(handler, payload);
      // A handler that re-delays itself for the next page ends the run with BullMQ's DelayedError.
      if (error !== undefined) expect((error as Error).name).toBe('DelayedError');
      takeEnqueued('hub.backfill');
      if ((await setting(source.id)).backfillState !== 'done') {
        expect((await setting(source.id)).backfillCursor).not.toBeNull();
      }
    }

    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(100);
    expect(batches[0]!.length).toBe(100);
    expect(batches.flat()).toHaveLength(TOTAL);
    // Newest first: the first page holds the 100 newest messages.
    const sorted = [...recorded].sort((p, q) => q.getTime() - p.getTime());
    expect(recorded.slice(0, 100).map((d) => d.getTime()).sort()).toEqual(
      sorted.slice(0, 100).map((d) => d.getTime()).sort(),
    );
    expect(new Set(states)).toEqual(new Set(['running']));
    expect((await setting(source.id)).backfillState).toBe('done');

    const rows = await hubRows(ctx.userId);
    expect(rows.messages).toHaveLength(TOTAL);
    expect(rows.messageSources).toHaveLength(TOTAL);
    expect(JSON.stringify(rows)).not.toContain(BODY_SENTINEL);
  }, 180_000);

  it('is idempotent: a second run adds no messages, sources or versions', async () => {
    const { ctx, source, payload } = await setup();
    const handler = (await loadBackfill()).createHubBackfillHandler({ store });
    for (let guard = 0; (await setting(source.id)).backfillState !== 'done'; guard++) {
      expect(guard).toBeLessThan(5);
      await runBackfill(handler, payload);
      takeEnqueued('hub.backfill');
    }
    const before = await hubRows(ctx.userId);
    takeEnqueued('hub.thread');

    await getDb().update(hubMailboxSetting).set({ backfillState: 'pending', backfillCursor: null }).where(eq(hubMailboxSetting.sourceId, source.id));
    for (let guard = 0; (await setting(source.id)).backfillState !== 'done'; guard++) {
      expect(guard).toBeLessThan(5);
      await runBackfill(handler, payload);
      takeEnqueued('hub.backfill');
    }
    const after = await hubRows(ctx.userId);
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.messageSources).toHaveLength(before.messageSources.length);
    expect(after.threads.map((t) => [t.id, t.version]).sort()).toEqual(before.threads.map((t) => [t.id, t.version]).sort());
    expect(takeEnqueued('hub.thread')).toEqual([]);
  }, 240_000);

  it('runs under the per-source import lock', async () => {
    const { ctx, source, payload } = await setup();
    const release = await imports.acquireSourceLock(source.id);
    expect(release).not.toBeNull();
    try {
      const handler = (await loadBackfill()).createHubBackfillHandler({ store });
      await runBackfill(handler, payload);
      expect(recordMessage).not.toHaveBeenCalled();
      expect((await hubRows(ctx.userId)).messages).toEqual([]);
      expect((await setting(source.id)).backfillState).not.toBe('done');
    } finally {
      await release!();
    }
  }, 120_000);

  it.each(['paused', 'needs_reconnection'] as const)('reschedules in 15 min when the source is %s', async (status) => {
    const { ctx, source, payload } = await setup();
    if (status === 'paused') await sources.pause(ctx, source.id);
    else await getDb().update(connectedSource).set({ status }).where(eq(connectedSource.id, source.id));
    takeEnqueued('import.page');

    const handler = (await loadBackfill()).createHubBackfillHandler({ store });
    const { job } = await runBackfill(handler, payload);
    expect(rescheduled(job, source.id)).toBe(true);
    expect(recordMessage).not.toHaveBeenCalled();
    expect((await setting(source.id)).backfillState).toBe('pending');
  }, 120_000);

  it('stops when the hub was disabled', async () => {
    const { ctx, source, payload } = await setup();
    await mailboxes.disable(ctx, source.id, { hubData: 'keep' });
    const handler = (await loadBackfill()).createHubBackfillHandler({ store });
    const { job, error } = await runBackfill(handler, payload);
    if (error !== undefined) expect((error as Error).name).not.toBe('DelayedError');
    expect(rescheduled(job, source.id)).toBe(false);
    expect(recordMessage).not.toHaveBeenCalled();
    expect((await hubRows(ctx.userId)).messages).toEqual([]);
  }, 120_000);
});
