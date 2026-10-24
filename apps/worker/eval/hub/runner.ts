import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { connectedSource, getDb, getPool, hubMailboxSetting, user } from '@voicespark/db';
import { createFsBlobStore } from '@voicespark/core/hub/blob-store';
import { normalizeDomain } from '@voicespark/core/hub/normalize';
import { jobIds, type JobPayload } from '@voicespark/core/queues';
import { decryptContent, encryptContent } from '@voicespark/core/services/hub/common';
import { recordMessage } from '@voicespark/core/services/hub/ingest';
import * as links from '@voicespark/core/services/hub/links';
import * as records from '@voicespark/core/services/hub/records';
import type { ServiceContext } from '@voicespark/core/errors';
import type { Classifier } from '@voicespark/filters';
import type { LlmClient } from '@voicespark/integrations/anthropic';
import type { FetchedMessage, MailFetcher } from '@voicespark/integrations/mail';
import { parseMessage } from '@voicespark/integrations/mime';
import { InMemoryMemoryStore } from '@voicespark/integrations/supermemory';
import { createHubThreadHandler, type HubThreadResult } from '../../src/processors/hub-thread';
import type { EvalConversation } from './format';
import { emptyResult, score, type FileResult, type HubSnapshot, type LinkKind } from './grade';

// One conversation of the hub extraction eval through the real pipeline (T150, research R14): a fresh user with one
// hub-enabled source per `mailboxes` entry, the `seed` records, every message recorded through `recordMessage`, and
// `hub.thread` run by hand for each resulting thread with the given LLM (replay, live or synthetic). Mail is served
// from memory, the memory store is in-memory, the classifier finds nothing (the filter has its own corpus; a fixed
// classifier keeps the prompts, and so the recordings, deterministic). The user and all its rows are deleted after
// scoring. Callers own the environment: a test database only (run.ts checks it), no real memory store.

/** Runs per thread while it is left in a retry backoff (live rate limits, transient API errors). */
const MAX_RUNS = 3;

const classifier: Classifier = { classify: async () => ({ spans: [], mostlySensitive: false }) };
const store = new InMemoryMemoryStore();
const blobStore = createFsBlobStore(path.join(tmpdir(), 'voicespark-hub-eval-unused'));

type ThreadPayload = JobPayload<'hub.thread'>;

async function newUser(): Promise<ServiceContext> {
  const [u] = await getDb()
    .insert(user)
    .values({ name: 'Hub Eval', email: `hub-eval-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  return { userId: u!.id, role: 'user' };
}

/** Seeded records as the owner typed them; fields other than `name` (and an owner role) count as email-set. */
async function seedRecords(ctx: ServiceContext, seed: EvalConversation['seed']): Promise<void> {
  if (!seed) return;
  const companyByDomain = new Map<string, string>();
  for (const c of seed.companies ?? []) {
    const { record } = await records.create(ctx, 'company', {
      name: c.name,
      domains: c.domain ? [c.domain] : [],
    });
    if (c.domain) companyByDomain.set(normalizeDomain(c.domain) ?? c.domain, record.id);
  }
  for (const p of seed.people ?? []) {
    const { record } = await records.create(ctx, 'person', {
      name: p.name,
      roleTitle: p.roleTitle ?? null,
      emails: [p.email],
    });
    // The phone is written as stored: some synthetic numbers (`+48 601 300 707`) trip the ID-number detector of
    // the owner-input filter, and a seed stands for a record that already exists.
    const ownerFields = ['name', ...(p.roleSource === 'owner' ? ['roleTitle'] : [])];
    await getPool().query('UPDATE hub_person SET owner_fields = $1, phone_enc = $2 WHERE id = $3', [
      ownerFields,
      p.phone ? encryptContent(p.phone) : null,
      record.id,
    ]);
  }
  for (const pr of seed.projects ?? []) {
    const { record } = await records.create(ctx, 'project', { name: pr.name });
    for (const d of pr.companyDomains ?? []) {
      const companyId = companyByDomain.get(normalizeDomain(d) ?? d);
      if (companyId)
        await links.create(ctx, { kind: 'company_project', companyId, projectId: record.id });
    }
  }
}

/** The fetcher of one eval source: the conversation's raw messages by provider ref. */
function memoryFetcher(
  provider: MailFetcher['provider'],
  address: string,
  mail: Map<string, FetchedMessage>,
): MailFetcher {
  return {
    provider,
    getAddress: async () => address,
    listFolders: async () => [],
    listPage: async () => {
      throw new Error('eval sources are not listed');
    },
    fetchMessages: async (refs) => {
      const out = new Map<string, FetchedMessage | Error>();
      for (const r of refs) out.set(r.providerRef, mail.get(r.providerRef) ?? new Error('gone'));
      return out;
    },
    close: async () => undefined,
  };
}

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : (res as { rows: T[] }).rows);
const n = (v: string | null | undefined): string | null => v ?? null;
const dec = (v: string | null | undefined): string | null => (v == null ? null : decryptContent(v));

async function snapshot(userId: string): Promise<HubSnapshot> {
  const q = async <T>(text: string): Promise<T[]> =>
    (await getPool().query(text, [userId])).rows as T[];
  type Row = Record<string, string | null>;
  const people = await q<Row & { owner_fields: string[] }>(
    'select id, name_enc, role_title_enc, owner_fields, created_from from hub_person where user_id = $1',
  );
  const emails = await q<Row>(
    'select person_id, address_enc from hub_person_email where user_id = $1',
  );
  const companies = await q<Row>('select id, name_enc from hub_company where user_id = $1');
  const domains = await q<Row>(
    'select company_id, domain_enc from hub_company_domain where user_id = $1',
  );
  const projects = await q<Row>('select id, name_enc from hub_project where user_id = $1');
  const linkRows = await q<Row>(
    'select id, kind, person_id, company_id, project_id from hub_link where user_id = $1',
  );
  const threads = await q<Row>(
    'select id, status, skip_reason, last_error_code, summary_enc from hub_thread where user_id = $1',
  );
  const facts = await q<Row & { conflict: boolean }>(
    `select id, type, state, reason, field, conflict, person_id, company_id, project_id, link_id,
            depends_on_fact_id, value_enc from hub_fact where user_id = $1 order by created_at, id`,
  );
  return {
    people: people.map((p) => ({
      id: p.id!,
      name: dec(p.name_enc)!,
      roleTitle: dec(p.role_title_enc),
      ownerFields: p.owner_fields,
      createdFrom: p.created_from!,
    })),
    emails: emails.map((e) => ({ personId: e.person_id!, address: dec(e.address_enc)! })),
    companies: companies.map((c) => ({ id: c.id!, name: dec(c.name_enc)! })),
    domains: domains.map((d) => ({ companyId: d.company_id!, domain: dec(d.domain_enc)! })),
    projects: projects.map((p) => ({ id: p.id!, name: dec(p.name_enc)! })),
    links: linkRows.map((l) => ({
      id: l.id!,
      kind: l.kind as LinkKind,
      personId: n(l.person_id),
      companyId: n(l.company_id),
      projectId: n(l.project_id),
    })),
    threads: threads.map((t) => ({
      id: t.id!,
      status: t.status!,
      skipReason: n(t.skip_reason),
      lastErrorCode: n(t.last_error_code),
      summary: dec(t.summary_enc),
    })),
    facts: facts.map((f) => ({
      id: f.id!,
      type: f.type!,
      state: f.state!,
      reason: n(f.reason),
      field: n(f.field),
      conflict: f.conflict,
      personId: n(f.person_id),
      companyId: n(f.company_id),
      projectId: n(f.project_id),
      linkId: n(f.link_id),
      dependsOnFactId: n(f.depends_on_fact_id),
      value: (f.value_enc == null ? {} : JSON.parse(dec(f.value_enc)!)) as Record<string, unknown>,
    })),
  };
}

/** Distinct conversations of a file: its threads' first Message-IDs (the cross-mailbox files repeat one). */
export function expectedThreadCount(c: EvalConversation): number {
  const ids = c.threads.map((t) => {
    const m = /^Message-ID:\s*(\S+)/im.exec(t.messages[0]!.raw);
    return (m?.[1] ?? t.ref).toLowerCase();
  });
  return new Set(ids).size;
}

export interface ConversationRun {
  result: FileResult;
  /** `hub.thread` results in run order. */
  runs: HubThreadResult[];
}

/** Runs and scores one conversation with `llm`; never throws (a failure is `result.error`). */
export async function runConversation(
  c: EvalConversation,
  llm: LlmClient,
): Promise<ConversationRun> {
  const result = emptyResult(c);
  const runs: HubThreadResult[] = [];
  let ctx: ServiceContext | undefined;
  try {
    ctx = await newUser();
    const { userId } = ctx;

    const fetchers = new Map<string, MailFetcher>();
    const sourceOf = new Map<string, string>();
    const mailOf = new Map<string, Map<string, FetchedMessage>>();
    for (const mb of c.mailboxes) {
      const [src] = await getDb()
        .insert(connectedSource)
        .values({
          userId,
          type: mb.provider,
          accountLabel: mb.address,
          accountAddress: mb.address,
          status: 'connected',
          consentTextVersion: 'v1',
        } as typeof connectedSource.$inferInsert)
        .returning({ id: connectedSource.id });
      await getDb().insert(hubMailboxSetting).values({ sourceId: src!.id, userId, enabled: true });
      const mail = new Map<string, FetchedMessage>();
      sourceOf.set(mb.address, src!.id);
      mailOf.set(mb.address, mail);
      fetchers.set(src!.id, memoryFetcher(mb.provider, mb.address, mail));
    }

    await seedRecords(ctx, c.seed);

    const threadIds: string[] = [];
    for (const t of c.threads) {
      const sourceId = sourceOf.get(t.mailbox)!;
      for (const m of t.messages) {
        const raw = Buffer.from(m.raw, 'utf8');
        mailOf
          .get(t.mailbox)!
          .set(m.ref, { raw, folders: m.folders, isSent: m.direction === 'outbound' });
        const parsed = await parseMessage(raw, {
          authored: m.direction === 'outbound',
          folders: m.folders,
        });
        const rec = await recordMessage({
          userId,
          sourceId,
          providerRef: m.ref,
          folders: m.folders,
          parsed,
          direction: m.direction,
          webLink: null,
        });
        if (!threadIds.includes(rec.threadId)) threadIds.push(rec.threadId);
      }
    }

    const handler = createHubThreadHandler({
      store,
      classifier,
      llm,
      blobStore,
      openFetcher: async (sourceId) => {
        const f = fetchers.get(sourceId);
        if (!f) throw new Error('unknown eval source');
        return f;
      },
    });
    for (const threadId of threadIds) {
      for (let attempt = 1; attempt <= MAX_RUNS; attempt++) {
        // Skip the 60 s debounce or a backoff: the thread is due now.
        await getDb().execute(
          sql`UPDATE hub_thread SET next_attempt_at = now() WHERE id = ${threadId} AND status = 'pending'`,
        );
        const [row] = rowsOf<{ version: string }>(
          await getDb().execute(sql`SELECT version FROM hub_thread WHERE id = ${threadId}`),
        );
        const version = Number(row?.version ?? 1);
        const data: ThreadPayload = { userId, threadId, version };
        const job = {
          id: jobIds.hubThread(threadId, version),
          name: 'hub.thread',
          data,
          attemptsMade: 0,
        };
        const r = (await handler(
          job as unknown as Job<ThreadPayload, unknown, 'hub.thread'>,
        )) as HubThreadResult;
        runs.push(r);
        if (r.outcome !== 'retry' && r.outcome !== 'released') break;
      }
    }

    score(c, await snapshot(userId), expectedThreadCount(c), result);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (ctx) await getDb().delete(user).where(eq(user.id, ctx.userId));
  }
  return { result, runs };
}
