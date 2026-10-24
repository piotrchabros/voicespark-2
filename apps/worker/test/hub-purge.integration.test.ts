import { randomBytes, randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLogEntry,
  closeDb,
  connectedSource,
  getDb,
  getPool,
  hubBlockMarker,
  hubCompany,
  hubCompanyDomain,
  hubFact,
  hubFactEvidence,
  hubLink,
  hubMailboxSetting,
  hubMessage,
  hubMessageSource,
  hubNote,
  hubPerson,
  hubPersonEmail,
  hubSyncItem,
  hubThread,
  hubThreadRecord,
  hubThreadSource,
  user,
  type HubFact,
} from '@voicespark/db';
import { addressHash, matchHash } from '@voicespark/core/hub/normalize';
import { enqueue, jobIds } from '@voicespark/core/queues';
import { getDeletion, requestDeletion } from '@voicespark/core/services/deletion';
import { encryptContent, decryptContent } from '@voicespark/core/services/hub/common';
import { purgeSource } from '@voicespark/core/services/hub/purge';
import { domainHash } from '@voicespark/core/services/hub/records';
import type { FilteredText } from '@voicespark/filters';
import { InMemoryMemoryStore, namespaceFor, type MemoryStore } from '@voicespark/integrations/supermemory';
import { createDeletionHandler } from '../src/processors/deletion';
import { handlers as maintenanceHandlers } from '../src/processors/maintenance';

// T126 (US8; contracts/jobs.md (6) `hub_source`, data-model.md "Mailbox scope"; FR-031, SC-012, AS8.2):
// `purgeSource` and `deletion.execute` for one mailbox's hub data. Rows are seeded directly (no extraction run).
// Postgres + the in-memory store; queues mocked (no Redis needed).

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const store = new InMemoryMemoryStore();
const execute = createDeletionHandler({ store });
const ft = (s: string) => s as FilteredText;
const hex = () => randomBytes(32).toString('hex');

interface FakeJob {
  id: string;
  data: { deletionRequestId: string; waitCount?: number };
  opts: { attempts: number };
  attemptsMade: number;
  updateData: ReturnType<typeof vi.fn>;
  moveToDelayed: ReturnType<typeof vi.fn>;
}

function fakeJob(deletionRequestId: string, attemptsMade = 0): FakeJob {
  const job: FakeJob = {
    id: jobIds.deletion(deletionRequestId),
    data: { deletionRequestId },
    opts: { attempts: 12 },
    attemptsMade,
    updateData: vi.fn(async (d: FakeJob['data']) => {
      job.data = d;
    }),
    moveToDelayed: vi.fn(async () => undefined),
  };
  return job;
}

const runWith = (handler: ReturnType<typeof createDeletionHandler>, job: FakeJob) =>
  handler(job as unknown as Job<FakeJob['data'], unknown, 'deletion.execute'>, 'token');
const run = (job: FakeJob) => runWith(execute, job);

// ---------------------------------------------------------------------------------------------------------------
// Seeding

const userIds: string[] = [];

async function createUser(): Promise<string> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Purge Test', email: `hub-purge-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  return row!.id;
}

async function createSource(userId: string, hub: { dataChoice?: 'keep' | 'delete' | null; enabled?: boolean } | null) {
  const [row] = await getDb()
    .insert(connectedSource)
    .values({
      userId,
      type: 'imap',
      accountLabel: 'Hub mailbox',
      accountAddress: `${randomUUID()}@example.test`,
      status: 'connected',
      consentTextVersion: 'v1',
    })
    .returning({ id: connectedSource.id });
  if (hub) {
    await getDb()
      .insert(hubMailboxSetting)
      .values({
        sourceId: row!.id,
        userId,
        enabled: hub.enabled ?? true,
        consentTextVersion: 'hub-ai-2026-10',
        enabledAt: new Date(),
        dataChoice: hub.dataChoice ?? null,
      });
  }
  return row!.id;
}

const ns = (userId: string) => namespaceFor(userId);

async function addDoc(userId: string, docId: string): Promise<void> {
  await store.addDocuments(ns(userId), [
    { id: docId, content: ft('hub document'), documentDate: new Date().toISOString(), metadata: {} },
  ]);
}

async function createThread(userId: string, sourceIds: (string | null)[], summary = true): Promise<string> {
  const [t] = await getDb()
    .insert(hubThread)
    .values({
      userId,
      threadKey: hex(),
      subjectEnc: encryptContent('Quarterly plan'),
      summaryEnc: summary ? encryptContent('A summary of the thread') : null,
      summaryVersion: summary ? 1 : 0,
      status: 'done',
      processedVersion: 1,
      messageCount: 1,
    })
    .returning({ id: hubThread.id });
  const [m] = await getDb()
    .insert(hubMessage)
    .values({ userId, threadId: t!.id, messageIdHash: hex(), direction: 'inbound' })
    .returning({ id: hubMessage.id });
  for (const sourceId of sourceIds) {
    await getDb().insert(hubMessageSource).values({ userId, messageId: m!.id, sourceId, providerRef: randomUUID() });
    await getDb().insert(hubThreadSource).values({ userId, threadId: t!.id, sourceId });
  }
  if (summary) await addDoc(userId, `hub_summary_${t!.id}`);
  return t!.id;
}

async function createPerson(
  userId: string,
  opts: { createdFrom?: 'user' | 'email'; ownerFields?: string[]; roleTitle?: string; phone?: string } = {},
): Promise<string> {
  const [p] = await getDb()
    .insert(hubPerson)
    .values({
      userId,
      nameEnc: encryptContent('Jan Kowalski'),
      nameKey: hex(),
      matchKey: hex(),
      roleTitleEnc: opts.roleTitle ? encryptContent(opts.roleTitle) : null,
      phoneEnc: opts.phone ? encryptContent(opts.phone) : null,
      ownerFields: opts.ownerFields ?? [],
      createdFrom: opts.createdFrom ?? 'email',
    })
    .returning({ id: hubPerson.id });
  await addDoc(userId, `hub_person_${p!.id}`);
  return p!.id;
}

async function createCompany(
  userId: string,
  opts: { createdFrom?: 'user' | 'email'; ownerFields?: string[]; industry?: string } = {},
): Promise<string> {
  const [c] = await getDb()
    .insert(hubCompany)
    .values({
      userId,
      nameEnc: encryptContent('Acme'),
      nameKey: hex(),
      matchKey: hex(),
      industryEnc: opts.industry ? encryptContent(opts.industry) : null,
      ownerFields: opts.ownerFields ?? [],
      createdFrom: opts.createdFrom ?? 'email',
    })
    .returning({ id: hubCompany.id });
  await addDoc(userId, `hub_company_${c!.id}`);
  return c!.id;
}

async function addEmail(userId: string, personId: string, address: string, origin: 'user' | 'email', isPrimary = false) {
  const [e] = await getDb()
    .insert(hubPersonEmail)
    .values({
      userId,
      personId,
      addressEnc: encryptContent(address),
      addressHash: addressHash(address),
      matchHash: matchHash(address),
      isPrimary,
      origin,
    })
    .returning({ id: hubPersonEmail.id });
  return e!.id;
}

async function addDomain(userId: string, companyId: string, domain: string, origin: 'user' | 'email') {
  const [d] = await getDb()
    .insert(hubCompanyDomain)
    .values({ userId, companyId, domainEnc: encryptContent(domain), domainHash: domainHash(domain), origin })
    .returning({ id: hubCompanyDomain.id });
  return d!.id;
}

async function addLink(
  userId: string,
  personId: string,
  companyId: string,
  opts: { origin: 'user' | 'email'; roleOwnerSet?: boolean; role?: string },
) {
  const [l] = await getDb()
    .insert(hubLink)
    .values({
      userId,
      kind: 'person_company',
      personId,
      companyId,
      roleEnc: opts.role ? encryptContent(opts.role) : null,
      roleOwnerSet: opts.roleOwnerSet ?? false,
      origin: opts.origin,
    })
    .returning({ id: hubLink.id });
  return l!.id;
}

async function addFact(
  userId: string,
  threadId: string,
  values: Partial<typeof hubFact.$inferInsert> & Pick<HubFact, 'type'> & { value?: unknown },
  extraEvidence: string[] = [],
): Promise<string> {
  const { value, ...rest } = values;
  const [f] = await getDb()
    .insert(hubFact)
    .values({
      userId,
      threadId,
      state: 'applied',
      confidence: 0.95,
      fingerprint: hex(),
      policyVersion: 'v1',
      promptVersion: 'v1',
      ...rest,
      valueEnc: value === undefined ? (rest.valueEnc ?? null) : encryptContent(JSON.stringify(value)),
    })
    .returning({ id: hubFact.id });
  for (const t of extraEvidence) await getDb().insert(hubFactEvidence).values({ factId: f!.id, threadId: t, userId });
  return f!.id;
}

async function attach(userId: string, threadId: string, target: { personId?: string; companyId?: string }) {
  await getDb().insert(hubThreadRecord).values({ userId, threadId, ...target });
}

async function addNote(userId: string, companyId: string) {
  await getDb()
    .insert(hubNote)
    .values({ userId, companyId, titleEnc: encryptContent('Call notes'), bodyJsonEnc: encryptContent('{}') });
}

const docExists = async (userId: string, docId: string) => (await store.getDocument(ns(userId), docId)) !== null;

async function syncRow(userId: string, docId: string) {
  const [row] = await getDb()
    .select()
    .from(hubSyncItem)
    .where(and(eq(hubSyncItem.userId, userId), eq(hubSyncItem.docId, docId)));
  return row ?? null;
}

async function auditsFor(sourceId: string, action = 'hub.mailbox_data_deleted') {
  return getDb()
    .select()
    .from(auditLogEntry)
    .where(and(eq(auditLogEntry.action, action), eq(auditLogEntry.targetId, sourceId)));
}

const TABLE_NAME = new Map<unknown, string>([
  [hubThread, 'hub_thread'],
  [hubPerson, 'hub_person'],
  [hubPersonEmail, 'hub_person_email'],
  [hubCompany, 'hub_company'],
  [hubCompanyDomain, 'hub_company_domain'],
  [hubLink, 'hub_link'],
  [hubFact, 'hub_fact'],
  [connectedSource, 'connected_source'],
]);

async function exists(table: unknown, id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`select 1 from ${TABLE_NAME.get(table)!} where id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The FR-031 matrix fixture

interface Matrix {
  userId: string;
  sourceA: string;
  sourceB: string;
  tA: string;
  tShared: string;
  tB: string;
  orphan: string;
  orphanEmail: string;
  edited: string;
  editedEmailFromMail: string;
  editedEmailByUser: string;
  supported: string;
  userLinked: string;
  company: string;
  domainFromMail: string;
  domainByUser: string;
  linkFromMail: string;
  linkRoleSet: string;
  linkByUser: string;
  suggestion: string;
  markerKeys: number;
}

/**
 * Source A is purged; B stays. `tA` is A's only thread, `tShared` is seen through both, `tB` only through B.
 * Records: an orphan created by tA, an email person the user edited, a person a B fact still supports, a person the
 * user linked, and a company with a note, an email domain, a user domain and an email-set industry.
 */
async function seedMatrix(hub: { dataChoice?: 'keep' | 'delete' | null; enabled?: boolean } = {}): Promise<Matrix> {
  const userId = await createUser();
  const sourceA = await createSource(userId, { dataChoice: hub.dataChoice ?? null, enabled: hub.enabled ?? true });
  const sourceB = await createSource(userId, {});
  const tA = await createThread(userId, [sourceA]);
  const tShared = await createThread(userId, [sourceA, sourceB]);
  const tB = await createThread(userId, [sourceB]);

  const orphan = await createPerson(userId);
  const orphanEmail = await addEmail(userId, orphan, 'jan@acme.example', 'email', true);
  await addFact(userId, tA, { type: 'person', personId: orphan, value: { name: 'Jan Kowalski', email: 'jan@acme.example' } });
  await attach(userId, tA, { personId: orphan });

  const edited = await createPerson(userId, { ownerFields: ['phone'], phone: '+48 600 100 200', roleTitle: 'CTO' });
  const editedEmailFromMail = await addEmail(userId, edited, 'anna@acme.example', 'email', true);
  const editedEmailByUser = await addEmail(userId, edited, 'anna@home.example', 'user');
  await addFact(userId, tA, { type: 'person', personId: edited, value: { name: 'Anna', email: 'anna@acme.example' } });
  await addFact(userId, tA, { type: 'field', personId: edited, field: 'roleTitle', value: { value: 'CTO' } });
  await attach(userId, tA, { personId: edited });

  const supported = await createPerson(userId, { roleTitle: 'CEO', phone: '+48 600 300 400' });
  await addFact(userId, tA, { type: 'person', personId: supported, value: { name: 'Piotr', email: null } });
  await addFact(userId, tB, { type: 'field', personId: supported, field: 'roleTitle', value: { value: 'CEO' } });
  // Corroborated by tB: the fact has surviving evidence, so the value stays.
  await addFact(userId, tA, { type: 'field', personId: supported, field: 'phone', value: { value: '+48 600 300 400' } }, [tB]);

  const userLinked = await createPerson(userId);
  await addFact(userId, tA, { type: 'person', personId: userLinked, value: { name: 'Ewa', email: null } });

  const company = await createCompany(userId, { industry: 'Logistics' });
  await addNote(userId, company);
  await addFact(userId, tA, { type: 'company', companyId: company, value: { name: 'Acme', website: null } });
  await addFact(userId, tA, { type: 'field', companyId: company, field: 'industry', value: { value: 'Logistics' } });
  const domainFromMail = await addDomain(userId, company, 'acme.example', 'email');
  await addFact(userId, tA, { type: 'company_domain', companyId: company, value: { domain: 'acme.example' } });
  const domainByUser = await addDomain(userId, company, 'acme-group.example', 'user');

  const linkFromMail = await addLink(userId, edited, company, { origin: 'email' });
  await addFact(userId, tA, { type: 'link', personId: edited, companyId: company, linkId: linkFromMail });
  const linkRoleSet = await addLink(userId, supported, company, { origin: 'email', roleOwnerSet: true, role: 'Owner' });
  await addFact(userId, tA, { type: 'link', personId: supported, companyId: company, linkId: linkRoleSet });
  const linkByUser = await addLink(userId, userLinked, company, { origin: 'user' });

  const suggestion = await addFact(userId, tA, {
    type: 'field',
    state: 'suggested',
    reason: 'low_confidence',
    personId: supported,
    field: 'phone',
    value: { value: '+48 600 999 999' },
  });

  await getDb().insert(hubBlockMarker).values({ userId, keyHash: hex(), reason: 'rejected' });
  return {
    userId,
    sourceA,
    sourceB,
    tA,
    tShared,
    tB,
    orphan,
    orphanEmail,
    edited,
    editedEmailFromMail,
    editedEmailByUser,
    supported,
    userLinked,
    company,
    domainFromMail,
    domainByUser,
    linkFromMail,
    linkRoleSet,
    linkByUser,
    suggestion,
    markerKeys: 1,
  };
}

async function expectPurged(m: Matrix): Promise<void> {
  // Threads: only the exclusive one goes (messages and attachments cascade); shared threads stay.
  expect(await exists(hubThread, m.tA)).toBe(false);
  expect(await exists(hubThread, m.tShared)).toBe(true);
  expect(await exists(hubThread, m.tB)).toBe(true);
  expect(await getDb().select().from(hubMessage).where(eq(hubMessage.threadId, m.tA))).toHaveLength(0);
  expect(await getDb().select().from(hubThreadRecord).where(eq(hubThreadRecord.threadId, m.tA))).toHaveLength(0);
  const sharedSources = await getDb().select().from(hubThreadSource).where(eq(hubThreadSource.threadId, m.tShared));
  expect(sharedSources.map((s) => s.sourceId)).toEqual([m.sourceB]);
  expect(
    await getDb().select().from(hubMessageSource).where(eq(hubMessageSource.sourceId, m.sourceA)),
  ).toHaveLength(0);
  expect(
    await getDb().select().from(hubThreadSource).where(eq(hubThreadSource.sourceId, m.sourceA)),
  ).toHaveLength(0);

  // Orphan record goes; the others stay.
  expect(await exists(hubPerson, m.orphan)).toBe(false);
  expect(await exists(hubPersonEmail, m.orphanEmail)).toBe(false);
  expect(await exists(hubPerson, m.edited)).toBe(true);
  expect(await exists(hubPerson, m.supported)).toBe(true);
  expect(await exists(hubPerson, m.userLinked)).toBe(true);
  expect(await exists(hubCompany, m.company)).toBe(true);

  // Values: email-set ones without other support are cleared; user-entered and supported ones stay (AS8.2).
  const [edited] = await getDb().select().from(hubPerson).where(eq(hubPerson.id, m.edited));
  expect(edited!.roleTitleEnc).toBeNull();
  expect(decryptContent(edited!.phoneEnc!)).toBe('+48 600 100 200');
  expect(await exists(hubPersonEmail, m.editedEmailFromMail)).toBe(false);
  const [userEmail] = await getDb().select().from(hubPersonEmail).where(eq(hubPersonEmail.id, m.editedEmailByUser));
  expect(userEmail).toBeDefined();
  expect(userEmail!.isPrimary).toBe(true);
  const [supported] = await getDb().select().from(hubPerson).where(eq(hubPerson.id, m.supported));
  expect(decryptContent(supported!.roleTitleEnc!)).toBe('CEO');
  expect(decryptContent(supported!.phoneEnc!)).toBe('+48 600 300 400');
  const [company] = await getDb().select().from(hubCompany).where(eq(hubCompany.id, m.company));
  expect(company!.industryEnc).toBeNull();
  expect(await exists(hubCompanyDomain, m.domainFromMail)).toBe(false);
  expect(await exists(hubCompanyDomain, m.domainByUser)).toBe(true);
  expect(await getDb().select().from(hubNote).where(eq(hubNote.companyId, m.company))).toHaveLength(1);

  // Links: the email link goes; a role the user set and a user link stay.
  expect(await exists(hubLink, m.linkFromMail)).toBe(false);
  expect(await exists(hubLink, m.linkRoleSet)).toBe(true);
  expect(await exists(hubLink, m.linkByUser)).toBe(true);

  // Findings from the exclusive thread go, a suggestion included.
  expect(await exists(hubFact, m.suggestion)).toBe(false);

  // Memory store: deleted synchronously in the job; the rest is marked dirty.
  expect(await docExists(m.userId, `hub_summary_${m.tA}`)).toBe(false);
  expect(await docExists(m.userId, `hub_person_${m.orphan}`)).toBe(false);
  expect(await docExists(m.userId, `hub_summary_${m.tShared}`)).toBe(true);
  expect(await docExists(m.userId, `hub_person_${m.edited}`)).toBe(true);
  expect((await syncRow(m.userId, `hub_summary_${m.tA}`))?.deleted).toBe(true);
  expect((await syncRow(m.userId, `hub_person_${m.orphan}`))?.deleted).toBe(true);
  const editedSync = await syncRow(m.userId, `hub_person_${m.edited}`);
  expect(editedSync?.deleted).toBe(false);
  expect(editedSync?.status).toBe('pending');
  expect((await syncRow(m.userId, `hub_company_${m.company}`))?.status).toBe('pending');

  // Block markers stay, and none are written for email-derived data.
  expect(await getDb().select().from(hubBlockMarker).where(eq(hubBlockMarker.userId, m.userId))).toHaveLength(m.markerKeys);
}

// Values: edited.roleTitle, company.industry, orphan email, edited email, the email domain.
const EXPECTED_COUNTS = (m: Matrix) => ({ sourceId: m.sourceA, threads: 1, records: 1, links: 1, values: 5 });

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await getPool().query('delete from deletion_request where user_id = any($1::uuid[])', [userIds]);
    await getPool().query('delete from audit_log_entry where actor_user_id = any($1::uuid[])', [userIds]);
    await getPool().query('delete from "user" where id = any($1::uuid[])', [userIds]);
  }
  await closeDb();
});

describe('purgeSource (FR-031 matrix)', () => {
  it('removes only the mailbox data, keeps user-entered data and returns the audit counts', async () => {
    const m = await seedMatrix();
    const result = await purgeSource(store, m.userId, m.sourceA);
    expect(result).toMatchObject(EXPECTED_COUNTS(m));
    await expectPurged(m);

    const audits = await auditsFor(m.sourceA);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual(EXPECTED_COUNTS(m));
  });

  it('is idempotent: a second run finds nothing and writes no audit', async () => {
    const m = await seedMatrix();
    await purgeSource(store, m.userId, m.sourceA);
    const again = await purgeSource(store, m.userId, m.sourceA);
    expect(again).toMatchObject({ sourceId: m.sourceA, threads: 0, records: 0, links: 0, values: 0 });
    await expectPurged(m);
    expect(await auditsFor(m.sourceA)).toHaveLength(1);
  });

  it('keeps a thread that is also attached to a kept (removed) mailbox', async () => {
    const userId = await createUser();
    const sourceA = await createSource(userId, {});
    const kept = await createThread(userId, [sourceA, null]);
    await purgeSource(store, userId, sourceA);
    expect(await exists(hubThread, kept)).toBe(true);
    expect(await docExists(userId, `hub_summary_${kept}`)).toBe(true);
  });
});

describe('deletion.execute hub_source', () => {
  it('purges, verifies the documents and completes the request', async () => {
    const m = await seedMatrix({ dataChoice: 'delete' });
    const { id } = await requestDeletion({ userId: m.userId, scope: 'hub_source', targetId: m.sourceA, requestedBy: 'user' });
    await run(fakeJob(id));

    await expectPurged(m);
    const row = await getDeletion(id);
    expect(row?.status).toBe('completed');
    expect(row?.supermemoryDeletedCount).toBeGreaterThanOrEqual(2);
    // The source and its setting stay: only the hub data went.
    expect(await exists(connectedSource, m.sourceA)).toBe(true);
    expect(await auditsFor(m.sourceA)).toHaveLength(1);

    // Re-running a completed request is a no-op.
    await run(fakeJob(id));
    expect(await auditsFor(m.sourceA)).toHaveLength(1);
  });

  it('a document that is still there fails with verify_failed and retries; the next attempt completes', async () => {
    const m = await seedMatrix({ dataChoice: 'delete' });
    const stubborn: MemoryStore = Object.create(store, {
      deleteDocuments: { value: async () => ({ count: 0, errors: [] }) },
    });
    const failing = createDeletionHandler({ store: stubborn });
    const { id } = await requestDeletion({ userId: m.userId, scope: 'hub_source', targetId: m.sourceA, requestedBy: 'user' });

    const err = await runWith(failing, fakeJob(id)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    let row = await getDeletion(id);
    expect(row?.lastErrorCode).toBe('verify_failed');
    expect(row?.status).not.toBe('failed');
    expect(await docExists(m.userId, `hub_summary_${m.tA}`)).toBe(true);

    await run(fakeJob(id, 1));
    row = await getDeletion(id);
    expect(row?.status).toBe('completed');
    await expectPurged(m);
    expect(await auditsFor(m.sourceA)).toHaveLength(1);
  });
});

describe('deletion.execute source with hub data', () => {
  // sources.disconnect/remove turn the hub off and store the choice before the source request runs.
  it('runs the purge before the source row goes when data_choice is delete (hub already off)', async () => {
    const m = await seedMatrix({ dataChoice: 'delete', enabled: false });
    const { id } = await requestDeletion({ userId: m.userId, scope: 'source', targetId: m.sourceA, requestedBy: 'user' });
    await run(fakeJob(id));

    expect((await getDeletion(id))?.status).toBe('completed');
    expect(await exists(connectedSource, m.sourceA)).toBe(false);
    expect(await getDb().select().from(hubMailboxSetting).where(eq(hubMailboxSetting.sourceId, m.sourceA))).toHaveLength(0);
    expect(await exists(hubThread, m.tA)).toBe(false);
    expect(await exists(hubPerson, m.orphan)).toBe(false);
    expect(await docExists(m.userId, `hub_summary_${m.tA}`)).toBe(false);
    expect(await auditsFor(m.sourceA)).toHaveLength(1);
  });

  it('defaults to delete when the hub is enabled and no choice is stored', async () => {
    const m = await seedMatrix({ dataChoice: null });
    const { id } = await requestDeletion({ userId: m.userId, scope: 'source', targetId: m.sourceA, requestedBy: 'user' });
    await run(fakeJob(id));
    expect(await exists(hubThread, m.tA)).toBe(false);
    expect(await exists(hubPerson, m.orphan)).toBe(false);
    expect(await auditsFor(m.sourceA)).toHaveLength(1);
  });

  it('keep leaves derived data with source_id set to null', async () => {
    const m = await seedMatrix({ dataChoice: 'keep', enabled: false });
    const { id } = await requestDeletion({ userId: m.userId, scope: 'source', targetId: m.sourceA, requestedBy: 'user' });
    await run(fakeJob(id));

    expect((await getDeletion(id))?.status).toBe('completed');
    expect(await exists(connectedSource, m.sourceA)).toBe(false);
    expect(await getDb().select().from(hubMailboxSetting).where(eq(hubMailboxSetting.sourceId, m.sourceA))).toHaveLength(0);
    expect(await exists(hubThread, m.tA)).toBe(true);
    expect(await exists(hubPerson, m.orphan)).toBe(true);
    expect(await exists(hubLink, m.linkFromMail)).toBe(true);
    const [edited] = await getDb().select().from(hubPerson).where(eq(hubPerson.id, m.edited));
    expect(decryptContent(edited!.roleTitleEnc!)).toBe('CTO');
    const threadSources = await getDb()
      .select()
      .from(hubThreadSource)
      .where(inArray(hubThreadSource.threadId, [m.tA, m.tShared]));
    expect(threadSources.filter((s) => s.sourceId === null)).toHaveLength(2);
    expect(await docExists(m.userId, `hub_summary_${m.tA}`)).toBe(true);
    expect(await auditsFor(m.sourceA)).toHaveLength(0);
  });

  it('leaves hub data alone for a source without the hub', async () => {
    const userId = await createUser();
    const sourceA = await createSource(userId, null);
    const thread = await createThread(userId, [sourceA]);
    const { id } = await requestDeletion({ userId, scope: 'source', targetId: sourceA, requestedBy: 'user' });
    await run(fakeJob(id));
    expect(await exists(hubThread, thread)).toBe(true);
    expect(await auditsFor(sourceA)).toHaveLength(0);
  });
});

describe('maintenance.deletion-sla', () => {
  it('flags an overdue hub_source request (24 h SLA, SC-012)', async () => {
    const userId = await createUser();
    const sourceA = await createSource(userId, { dataChoice: 'delete' });
    const { id } = await requestDeletion({ userId, scope: 'hub_source', targetId: sourceA, requestedBy: 'user' });
    await getPool().query(`update deletion_request set due_by = now() - interval '1 hour' where id = $1`, [id]);
    const sla = maintenanceHandlers['maintenance.deletion-sla']!;
    const res = (await sla(
      { id: 'sla', name: 'maintenance.deletion-sla', data: {}, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job<
        Record<string, never>,
        unknown,
        'maintenance.deletion-sla'
      >,
      'token',
    )) as { flagged: number; overdue: number };
    expect(res.overdue).toBeGreaterThanOrEqual(1);
  });
});
