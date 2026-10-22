import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilteredText } from '@voicespark/filters';
import { InMemoryMemoryStore } from '../src/supermemory/in-memory';
import { META, memoryFilter, namespaceFor, type MemoryDoc, type MemoryStore } from '../src/supermemory/port';
// Static import on purpose: the file stays RED until T034 (adapter) lands.
import { SupermemoryAdapter } from '../src/supermemory/adapter';
// Static on purpose: RED until U2 lands the remote store and the test RPC server.
import { RemoteMemoryStore } from '../src/supermemory/remote';
import { startMemoryRpcServer } from '../src/testing';

const ft = (s: string) => s as FilteredText;

function doc(id: string, content: string, metadata: MemoryMetadataInput = {}): MemoryDoc {
  return {
    id,
    content: ft(content),
    documentDate: '2026-01-15T10:00:00.000Z',
    metadata: {
      [META.kind]: 'email',
      [META.authorship]: 'authored',
      [META.contentItemId]: id,
      [META.sourceIds]: ['src-1'],
      [META.itemTs]: 1768471200,
      [META.wordCount]: content.split(/\s+/).length,
      [META.filterPolicyVersion]: 'v1',
      ...metadata,
    },
  };
}
type MemoryMetadataInput = MemoryDoc['metadata'];

function runContract(name: string, factory: () => MemoryStore, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip)(`MemoryStore contract: ${name}`, () => {
    const newNs = () => namespaceFor(`t${Date.now()}${Math.random().toString(36).slice(2, 8)}`);

    it('isolates namespaces', async () => {
      const store = factory();
      const a = newNs();
      const b = newNs();
      await store.addDocuments(a, [doc('d1', 'alpha content about coffee')]);
      expect(await store.getDocument(b, 'd1')).toBeNull();
      expect((await store.listDocuments(b, { page: 1, limit: 10 })).documents).toHaveLength(0);
      expect(await store.search(b, { query: 'coffee', limit: 5 })).toHaveLength(0);
      await store.deleteNamespace(a);
    });

    it('re-adding the same id is idempotent', async () => {
      const store = factory();
      const ns = newNs();
      await store.addDocuments(ns, [doc('d1', 'first version text')]);
      await store.addDocuments(ns, [doc('d1', 'first version text')]);
      const listed = await store.listDocuments(ns, { page: 1, limit: 10 });
      expect(listed.documents.map((d) => d.id)).toEqual(['d1']);
      await store.deleteNamespace(ns);
    });

    it('returns verbatim content from getDocument', async () => {
      const store = factory();
      const ns = newNs();
      const content = 'Subject: Hello\nDate: 2026-01-15\n\nBody line one.\nBody line two.';
      await store.addDocuments(ns, [doc('d1', content)]);
      const got = await store.getDocument(ns, 'd1');
      expect(got?.id).toBe('d1');
      expect(got?.content).toBe(content);
      await store.deleteNamespace(ns);
    });

    it('filters by metadata (eq and arrayContains)', async () => {
      const store = factory();
      const ns = newNs();
      await store.addDocuments(ns, [
        doc('d1', 'authored by me', { [META.authorship]: 'authored', [META.sourceIds]: ['src-1'] }),
        doc('d2', 'received from someone', { [META.authorship]: 'received', [META.sourceIds]: ['src-2'] }),
      ]);
      const authored = await store.listDocuments(ns, {
        filter: memoryFilter.eq(META.authorship, 'authored'),
        page: 1,
        limit: 10,
      });
      expect(authored.documents.map((d) => d.id)).toEqual(['d1']);
      const bySource = await store.listDocuments(ns, {
        filter: memoryFilter.arrayContains(META.sourceIds, 'src-2'),
        page: 1,
        limit: 10,
      });
      expect(bySource.documents.map((d) => d.id)).toEqual(['d2']);
      const both = await store.listDocuments(ns, {
        filter: memoryFilter.and(
          memoryFilter.eq(META.authorship, 'authored'),
          memoryFilter.arrayContains(META.sourceIds, 'src-2'),
        ),
        page: 1,
        limit: 10,
      });
      expect(both.documents).toHaveLength(0);
      await store.deleteNamespace(ns);
    });

    it('verifies deletion', async () => {
      const store = factory();
      const ns = newNs();
      await store.addDocuments(ns, [doc('d1', 'to be deleted', { [META.sourceIds]: ['src-del'] })]);
      const res = await store.deleteDocuments(ns, ['d1']);
      expect(res.errors).toEqual([]);
      expect(await store.getDocument(ns, 'd1')).toBeNull();
      const bySource = await store.listDocuments(ns, {
        filter: memoryFilter.arrayContains(META.sourceIds, 'src-del'),
        page: 1,
        limit: 10,
      });
      expect(bySource.documents).toHaveLength(0);
      expect(await store.listMemories(ns)).toEqual([]);
      await store.deleteNamespace(ns);
    });

    it('deleteNamespace removes everything', async () => {
      const store = factory();
      const ns = newNs();
      await store.addDocuments(ns, [doc('d1', 'one'), doc('d2', 'two')]);
      await store.deleteNamespace(ns);
      expect((await store.listDocuments(ns, { page: 1, limit: 10 })).documents).toHaveLength(0);
    });

    it('updates document metadata in place', async () => {
      const store = factory();
      const ns = newNs();
      await store.addDocuments(ns, [doc('d1', 'shared document', { [META.sourceIds]: ['a', 'b'] })]);
      await store.updateDocumentMetadata(ns, 'd1', doc('d1', 'shared document', { [META.sourceIds]: ['b'] }).metadata);
      const onlyA = await store.listDocuments(ns, {
        filter: memoryFilter.arrayContains(META.sourceIds, 'a'),
        page: 1,
        limit: 10,
      });
      expect(onlyA.documents).toHaveLength(0);
      await store.deleteNamespace(ns);
    });

    it('search returns {id, content, score} shaped results', async () => {
      const store = factory();
      const ns = newNs();
      await store.addDocuments(ns, [doc('d1', 'espresso machines and grinders'), doc('d2', 'completely unrelated gardening text')]);
      const hits = await store.search(ns, { query: 'espresso grinders', limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) {
        expect(typeof h.id).toBe('string');
        expect(typeof h.content).toBe('string');
        expect(typeof h.score).toBe('number');
      }
      expect(hits[0]?.id).toBe('d1');
      await store.deleteNamespace(ns);
    });

    it('paginates listDocuments', async () => {
      const store = factory();
      const ns = newNs();
      await store.addDocuments(ns, [doc('d1', 'a'), doc('d2', 'b'), doc('d3', 'c')]);
      const p1 = await store.listDocuments(ns, { page: 1, limit: 2 });
      const p2 = await store.listDocuments(ns, { page: 2, limit: 2 });
      expect(p1.documents).toHaveLength(2);
      expect(p1.hasMore).toBe(true);
      expect(p2.documents).toHaveLength(1);
      expect(p2.hasMore).toBe(false);
      await store.deleteNamespace(ns);
    });
  });
}

runContract('InMemoryMemoryStore', () => new InMemoryMemoryStore());

describe('RemoteMemoryStore over the test RPC server', () => {
  let server: Awaited<ReturnType<typeof startMemoryRpcServer>>;
  beforeAll(async () => {
    server = await startMemoryRpcServer({ port: 0 });
  });
  afterAll(async () => {
    await server.close();
  });

  runContract('remote', () => new RemoteMemoryStore(server.url));
});

const live = Boolean(process.env.SUPERMEMORY_API_KEY);
runContract(
  'SupermemoryAdapter',
  () => new SupermemoryAdapter({ apiKey: process.env.SUPERMEMORY_API_KEY ?? '', baseURL: process.env.SUPERMEMORY_BASE_URL }),
  { skip: !live },
);

describe('port helpers', () => {
  it('builds namespaces and filters', () => {
    expect(namespaceFor('abc')).toBe('vs_user_abc');
    expect(memoryFilter.eq('k', 'v')).toEqual({ field: 'k', operator: 'eq', value: 'v' });
    expect(memoryFilter.and(memoryFilter.arrayContains('a', 'b'))).toEqual({
      and: [{ field: 'a', operator: 'arrayContains', value: 'b' }],
    });
  });
});
