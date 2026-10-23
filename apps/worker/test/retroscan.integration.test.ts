import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  exclusionRule,
  getDb,
  getPool,
  retroscan,
  user,
  type FilterCategory,
} from '@voicespark/db';
import type { Classifier, FilteredText } from '@voicespark/filters';
import {
  InMemoryMemoryStore,
  META,
  namespaceFor,
  type MemoryMetadata,
} from '@voicespark/integrations/supermemory';
import { senderDomainHash, senderHash } from '@voicespark/core/services/imports';
import { createRetroscanHandler } from '../src/processors/retroscan';
import { handlers as maintenance } from '../src/processors/maintenance';

// Integration: compose Postgres (migrated) + the in-memory Supermemory store. Queues are mocked (no Redis needed).
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

const ft = (s: string) => s as FilteredText;
const store = new InMemoryMemoryStore();
const classifier: Classifier = { classify: async () => ({ spans: [], mostlySensitive: false }) };
const scan = createRetroscanHandler({ store, classifier });

let userId: string;
const ids = {
  plan: randomUUID(),
  digest: randomUUID(),
  note: randomUUID(),
  attachment: randomUUID(),
};

interface FakeJob {
  id: string;
  data: { retroscanId: string };
  opts: { attempts: number };
  attemptsMade: number;
}

const run = (retroscanId: string, attemptsMade = 0) =>
  scan({
    id: `retroscan-${retroscanId}`,
    data: { retroscanId },
    opts: { attempts: 3 },
    attemptsMade,
  } as unknown as Job<FakeJob['data'], unknown, 'retroscan.scan'>) as Promise<{
    outcome: string;
    matchedCount?: number;
  }>;

async function addDoc(id: string, content: string, metadata: MemoryMetadata): Promise<void> {
  await store.addDocuments(namespaceFor(userId), [
    {
      id,
      content: ft(content),
      documentDate: new Date().toISOString(),
      metadata: { [META.contentItemId]: id, ...metadata },
    },
  ]);
}

async function createRule(
  type: 'sender' | 'domain' | 'folder_label' | 'keyword',
  value: string,
): Promise<string> {
  const [row] = await getDb()
    .insert(exclusionRule)
    .values({ userId, type, value })
    .returning({ id: exclusionRule.id });
  return row!.id;
}

async function createScan(input: {
  trigger?: 'rule_created' | 'rule_updated' | 'categories_selected';
  ruleId?: string | null;
  categories?: FilterCategory[];
  status?: 'scanning' | 'awaiting_confirmation' | 'dismissed';
  expiresAt?: Date;
}): Promise<string> {
  const [row] = await getDb()
    .insert(retroscan)
    .values({
      userId,
      trigger: input.trigger ?? 'rule_created',
      exclusionRuleId: input.ruleId ?? null,
      categories: input.categories ?? [],
      status: input.status ?? 'scanning',
      expiresAt: input.expiresAt ?? new Date(Date.now() + 86_400_000),
    })
    .returning({ id: retroscan.id });
  return row!.id;
}

const load = async (id: string) => {
  const row = await getDb().query.retroscan.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  return row!;
};

beforeAll(async () => {
  await getPool().query('select 1');
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Retroscan', email: `retroscan-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userId = row!.id;

  const date = 'Date: 2026-01-05T10:00:00.000Z';
  await addDoc(
    ids.plan,
    `Subject: Quarterly plan\n${date}\nDirection: received\nFrom: Boss <boss@acme.test>\n\nLet us discuss the roadmap.`,
    {
      [META.kind]: 'email',
      [META.folders]: ['inbox'],
      [META.senderHash]: senderHash('Boss@Acme.test'),
      [META.senderDomainHash]: senderDomainHash('acme.test'),
    },
  );
  await addDoc(
    ids.digest,
    `Subject: Weekly digest\n${date}\n\nMy card is 4111 1111 1111 1111, please charge it.`,
    {
      [META.kind]: 'email',
      [META.folders]: ['newsletters', 'inbox'],
      [META.senderHash]: senderHash('news@other.test'),
      [META.senderDomainHash]: senderDomainHash('other.test'),
    },
  );
  await addDoc(ids.note, 'Title: Ideas\n\nThe secret project codename is Bluebird.', {
    [META.kind]: 'note',
  });
  await addDoc(
    ids.attachment,
    `Subject: Quarterly plan\n${date}\n\nAttached agenda for the offsite.`,
    {
      [META.kind]: 'attachment',
      [META.parentItemId]: ids.plan,
      [META.folders]: ['inbox'],
      [META.senderHash]: senderHash('boss@acme.test'),
      [META.senderDomainHash]: senderDomainHash('acme.test'),
    },
  );
});

afterAll(async () => {
  await getPool().query('delete from "user" where id = $1', [userId]);
  await closeDb();
});

describe('retroscan.scan rule triggers', () => {
  it('sender rule matches by vs_sender_hash', async () => {
    const id = await createScan({ ruleId: await createRule('sender', 'BOSS@acme.test') });
    expect(await run(id)).toEqual({ outcome: 'awaiting_confirmation', matchedCount: 2 });
    const row = await load(id);
    expect(row.status).toBe('awaiting_confirmation');
    expect([...row.matchedItemIds].sort()).toEqual([ids.plan, ids.attachment].sort());
    expect(row.matchedCount).toBe(2);
  });

  it('domain rule matches by vs_sender_domain_hash', async () => {
    const id = await createScan({ ruleId: await createRule('domain', 'other.test') });
    await run(id);
    expect((await load(id)).matchedItemIds).toEqual([ids.digest]);
  });

  it('folder_label rule matches vs_folders case-insensitively', async () => {
    const id = await createScan({
      trigger: 'rule_updated',
      ruleId: await createRule('folder_label', 'Newsletters'),
    });
    await run(id);
    expect((await load(id)).matchedItemIds).toEqual([ids.digest]);
  });

  it('keyword rule pages the namespace and matches subject or body', async () => {
    const body = await createScan({ ruleId: await createRule('keyword', 'bluebird') });
    await run(body);
    expect((await load(body)).matchedItemIds).toEqual([ids.note]);

    const subject = await createScan({ ruleId: await createRule('keyword', 'quarterly') });
    await run(subject);
    expect([...(await load(subject)).matchedItemIds].sort()).toEqual(
      [ids.plan, ids.attachment].sort(),
    );
  });

  it('keyword rule ignores the document header lines', async () => {
    const id = await createScan({ ruleId: await createRule('keyword', 'received') });
    expect(await run(id)).toEqual({ outcome: 'no_matches', matchedCount: 0 });
    const row = await load(id);
    expect(row.status).toBe('no_matches');
    expect(row.matchedItemIds).toEqual([]);
  });

  it('a deleted rule yields no_matches', async () => {
    const id = await createScan({ ruleId: null });
    expect((await run(id)).outcome).toBe('no_matches');
    expect((await load(id)).status).toBe('no_matches');
  });
});

describe('retroscan.scan category trigger', () => {
  it('payment_cards re-inspection matches only the document with a card number', async () => {
    const id = await createScan({ trigger: 'categories_selected', categories: ['payment_cards'] });
    expect(await run(id)).toEqual({ outcome: 'awaiting_confirmation', matchedCount: 1 });
    expect((await load(id)).matchedItemIds).toEqual([ids.digest]);
  });

  it('fails closed: a classifier error excludes (matches) every item', async () => {
    const failing = createRetroscanHandler({
      store,
      classifier: { classify: async () => Promise.reject(new Error('boom')) },
    });
    const id = await createScan({ trigger: 'categories_selected', categories: ['health'] });
    await failing({
      id: 'x',
      data: { retroscanId: id },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as unknown as Job<FakeJob['data'], unknown, 'retroscan.scan'>);
    expect([...(await load(id)).matchedItemIds].sort()).toEqual(Object.values(ids).sort());
  });
});

describe('retroscan.scan hub documents', () => {
  // A hub document holding a rule keyword: retroscan never reads, inspects or matches it (hub content is re-filtered
  // by hub.refilter instead). It even carries a uuid content item id, so only the `hub_` id prefix keeps it out.
  const hubItemId = randomUUID();
  const hubDocId = `hub_note_${hubItemId}`;

  beforeAll(async () => {
    await store.addDocuments(namespaceFor(userId), [
      {
        id: hubDocId,
        content: ft('Title: Codename\n\nThe codename card is 4111 1111 1111 1111.'),
        documentDate: new Date().toISOString(),
        metadata: {
          [META.kind]: 'hub_note',
          vs_hub_item_id: hubItemId,
          [META.contentItemId]: hubItemId,
        },
      },
    ]);
  });

  afterAll(async () => {
    await store.deleteDocuments(namespaceFor(userId), [hubDocId]);
  });

  it('skips ids starting with hub_ in rule and category scans', async () => {
    const getDocument = vi.spyOn(store, 'getDocument');
    const classify = vi.fn(async () => Promise.reject(new Error('boom')));
    const failing = createRetroscanHandler({ store, classifier: { classify } });
    try {
      const keyword = await createScan({ ruleId: await createRule('keyword', 'codename') });
      await run(keyword);
      expect((await load(keyword)).matchedItemIds).toEqual([ids.note]);

      // Fails closed on every document it inspects, so an inspected hub document would match.
      const categories = await createScan({
        trigger: 'categories_selected',
        categories: ['health'],
      });
      await failing({
        id: 'x',
        data: { retroscanId: categories },
        opts: { attempts: 3 },
        attemptsMade: 0,
      } as unknown as Job<FakeJob['data'], unknown, 'retroscan.scan'>);
      expect([...(await load(categories)).matchedItemIds].sort()).toEqual(
        Object.values(ids).sort(),
      );
      expect(classify).toHaveBeenCalledTimes(Object.values(ids).length);

      expect(getDocument.mock.calls.map(([, id]) => id)).not.toContain(hubDocId);
    } finally {
      getDocument.mockRestore();
    }
  });
});

describe('retroscan.scan lifecycle', () => {
  it('leaves a non-scanning retroscan alone', async () => {
    const id = await createScan({
      status: 'dismissed',
      ruleId: await createRule('keyword', 'offsite'),
    });
    expect((await run(id)).outcome).toBe('not_scanning');
    expect((await load(id)).status).toBe('dismissed');
  });

  it('records failed only on the final attempt', async () => {
    const broken = createRetroscanHandler({
      store: Object.assign(new InMemoryMemoryStore(), {
        listDocuments: async () => Promise.reject(new Error('upstream said: secret text')),
      }),
      classifier,
    });
    const id = await createScan({ ruleId: await createRule('sender', 'x@y.test') });
    const job = (attemptsMade: number) =>
      ({
        id: 'x',
        data: { retroscanId: id },
        opts: { attempts: 3 },
        attemptsMade,
      }) as unknown as Job<FakeJob['data'], unknown, 'retroscan.scan'>;
    await expect(broken(job(0))).rejects.toThrow('retroscan_failed');
    expect((await load(id)).status).toBe('scanning');
    await expect(broken(job(2))).rejects.toThrow('retroscan_failed');
    expect((await load(id)).status).toBe('failed');
  });

  it('throws a retryable error for an unknown retroscan', async () => {
    await expect(run(randomUUID())).rejects.toThrow('retroscan_not_found');
  });
});

describe('maintenance.retroscan-expiry', () => {
  it('dismisses awaiting_confirmation scans past expires_at only', async () => {
    const expired = await createScan({
      status: 'awaiting_confirmation',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fresh = await createScan({ status: 'awaiting_confirmation' });
    const result = (await maintenance['maintenance.retroscan-expiry']!(
      {} as unknown as Job<Record<string, never>, unknown, 'maintenance.retroscan-expiry'>,
    )) as { count: number };
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect((await load(expired)).status).toBe('dismissed');
    expect((await load(fresh)).status).toBe('awaiting_confirmation');
  });
});
