import { describe, expect, it } from 'vitest';
import type { FilteredText } from '@voicespark/filters';
import {
  SupermemoryV3Adapter,
  portIdFromCustomId,
  v3CustomId,
} from '../src/supermemory/adapter-v3';
import {
  MemoryStoreAuthError,
  MemoryStoreBusyError,
  MemoryStoreHttpError,
} from '../src/supermemory/errors';
import { toV3Filter } from '../src/supermemory/v3-filter';
import { memoryFilter, type FilterNode, type MemoryDoc } from '../src/supermemory/port';
import {
  createFakeSupermemoryV3,
  type FakeV3Options,
  type FakeV3Server,
} from './helpers/fake-supermemory-v3';

const NS = 'vs_user_t1';
const BASE = 'https://sm.test';

const doc = (
  id: string,
  content: string,
  metadata: MemoryDoc['metadata'] = { vs_kind: 'email' },
): MemoryDoc => ({
  id,
  content: content as FilteredText,
  documentDate: '2026-01-15T10:00:00.000Z',
  metadata,
});

function setup(
  fakeOpts: FakeV3Options = { apiKey: 'k' },
  adapterOpts: { apiKey?: string; purgeRounds?: number } = {},
) {
  const fake = createFakeSupermemoryV3(fakeOpts);
  const sleeps: number[] = [];
  const store = new SupermemoryV3Adapter({
    baseUrl: BASE,
    apiKey: adapterOpts.apiKey ?? 'k',
    fetchImpl: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    processingPollMs: 0,
    ...(adapterOpts.purgeRounds !== undefined ? { purgeRounds: adapterOpts.purgeRounds } : {}),
  });
  return { fake, store, sleeps };
}

const writes = (fake: FakeV3Server) =>
  fake.requests.filter(
    (r) =>
      ['POST', 'PATCH'].includes(r.method) &&
      r.path.startsWith('/v3/documents') &&
      r.path !== '/v3/documents/list',
  );
const countOf = (fake: FakeV3Server, method: string, path: string) =>
  fake.requests.filter((r) => r.method === method && r.path === path).length;
const lastBody = (fake: FakeV3Server, method: string, path: string) =>
  [...fake.requests].reverse().find((r) => r.method === method && r.path === path)!.body as Record<
    string,
    unknown
  >;

function seed(
  fake: FakeV3Server,
  ns: string,
  customId: string,
  content: string,
  status = 'done',
  tags = [ns],
) {
  const n = fake.docs.size + 1;
  fake.docs.set(customId, {
    smId: `seed_${n}`,
    customId,
    content,
    metadata: {},
    containerTags: tags,
    status,
    createdSeq: 1000 + n,
  });
}

describe('customId prefixing', () => {
  it('round-trips ns and id', () => {
    const cid = v3CustomId(NS, 'd1');
    expect(cid).toBe(`${NS}__d1`);
    expect(portIdFromCustomId(NS, cid)).toBe('d1');
  });
  it('rejects invalid ids and foreign ids', () => {
    expect(() => v3CustomId(NS, 'has space')).toThrow();
    expect(() => v3CustomId(NS, 'x'.repeat(100))).toThrow();
    expect(portIdFromCustomId(NS, 'other__d1')).toBeNull();
    expect(portIdFromCustomId(NS, `${NS}__`)).toBeNull();
    expect(portIdFromCustomId(NS, null)).toBeNull();
  });
  it('validates the namespace on every method', async () => {
    const { store } = setup();
    await expect(store.getDocument('bad ns', 'd1')).rejects.toThrow(/namespace/i);
  });
});

describe('addDocuments', () => {
  it('posts a new document once with a Bearer key', async () => {
    const { fake, store } = setup();
    const out = await store.addDocuments(NS, [doc('d1', 'hello world')]);
    expect(out).toEqual([{ id: 'd1', status: 'queued' }]);
    const posts = fake.requests.filter((r) => r.method === 'POST' && r.path === '/v3/documents');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers.authorization).toBe('Bearer k');
    expect(posts[0]!.body).toMatchObject({
      content: 'hello world',
      customId: `${NS}__d1`,
      containerTag: NS,
      metadata: { vs_kind: 'email' },
      documentDate: '2026-01-15T10:00:00.000Z',
    });
  });

  it('does not write when an identical document is still processing', async () => {
    const { fake, store } = setup({ apiKey: 'k', processingSteps: 2 });
    await store.addDocuments(NS, [doc('d1', 'same')]);
    await store.addDocuments(NS, [doc('d1', 'same')]);
    expect(writes(fake)).toHaveLength(1);
  });

  it('PATCHes (not POSTs) a changed done document, replacing the content', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'old text')]);
    await store.addDocuments(NS, [doc('d1', 'new text')]);
    const w = writes(fake);
    expect(w.map((r) => r.method)).toEqual(['POST', 'PATCH']);
    expect(w[1]!.body).toMatchObject({ content: 'new text', containerTag: NS });
    expect(fake.docs.get(`${NS}__d1`)!.content).toBe('new text');
  });

  it('polls a processing changed document, then PATCHes', async () => {
    const { fake, store, sleeps } = setup({ apiKey: 'k', processingSteps: 2 });
    await store.addDocuments(NS, [doc('d1', 'old text')]);
    await store.addDocuments(NS, [doc('d1', 'new text')]);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(writes(fake).map((r) => r.method)).toEqual(['POST', 'PATCH']);
    expect(fake.docs.get(`${NS}__d1`)!.content).toBe('new text');
  });

  it('throws MemoryStoreBusyError without writing when the wait budget runs out', async () => {
    const { fake, store, sleeps } = setup();
    await store.addDocuments(NS, [doc('d1', 'old text')]);
    fake.setStatus(`${NS}__d1`, 'indexing');
    await expect(store.addDocuments(NS, [doc('d1', 'new text')])).rejects.toBeInstanceOf(
      MemoryStoreBusyError,
    );
    expect(writes(fake)).toHaveLength(1);
    expect(sleeps).toHaveLength(20);
  });

  it('re-GETs after a POST that landed but answered 500, with no second POST or duplicate content', async () => {
    const fake = createFakeSupermemoryV3({ apiKey: 'k' });
    let first = true;
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const res = await fake.fetch(input, init);
      if (first && init?.method === 'POST' && String(input).endsWith('/v3/documents')) {
        first = false;
        return new Response('{"error":"boom"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return res;
    }) as typeof fetch;
    const store = new SupermemoryV3Adapter({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl,
      sleep: async () => {},
      processingPollMs: 0,
    });
    await store.addDocuments(NS, [doc('d1', 'only once')]);
    expect(countOf(fake, 'POST', '/v3/documents')).toBe(1);
    expect(fake.docs.get(`${NS}__d1`)!.content).toBe('only once');
  });

  it('honours Retry-After on 429', async () => {
    const { fake, store, sleeps } = setup();
    fake.failNext({
      method: 'POST',
      pathPrefix: '/v3/documents',
      status: 429,
      headers: { 'retry-after': '2' },
    });
    await store.addDocuments(NS, [doc('d1', 'x')]);
    expect(sleeps).toContain(2000);
    expect(fake.docs.size).toBe(1);
  });

  it('retries a 5xx GET', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x')]);
    const before = countOf(fake, 'GET', `/v3/documents/${NS}__d1`);
    fake.failNext({ method: 'GET', status: 503, times: 2 });
    await expect(store.getDocument(NS, 'd1')).resolves.toMatchObject({ id: 'd1' });
    expect(countOf(fake, 'GET', `/v3/documents/${NS}__d1`) - before).toBe(3);
  });

  it('throws a retryable MemoryStoreHttpError once retries are exhausted', async () => {
    const { fake, store } = setup();
    fake.failNext({ method: 'GET', status: 500, times: 20 });
    const err = await store.getDocument(NS, 'd1').catch((e) => e);
    expect(err).toBeInstanceOf(MemoryStoreHttpError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(500);
  });

  it('throws MemoryStoreAuthError after exactly one request on 401', async () => {
    const { fake, store } = setup({ apiKey: 'k' }, { apiKey: 'wrong' });
    await expect(store.addDocuments(NS, [doc('d1', 'x')])).rejects.toBeInstanceOf(
      MemoryStoreAuthError,
    );
    expect(fake.requests).toHaveLength(1);
  });

  it('keeps document content and body.data out of 400 messages', async () => {
    const { fake, store } = setup();
    fake.failNext({
      method: 'POST',
      status: 400,
      body: {
        error: [{ path: ['content'], message: 'is missing' }],
        data: { content: 'SECRET-CONTENT' },
        success: false,
      },
    });
    const err = await store.addDocuments(NS, [doc('d1', 'SECRET-CONTENT')]).catch((e) => e);
    expect(err).toBeInstanceOf(MemoryStoreHttpError);
    expect(err.message).toContain('content: is missing');
    expect(err.message).not.toContain('SECRET-CONTENT');
    expect(err.message).not.toContain('data');
  });

  it('retries a truncated 2xx JSON body on GET', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x')]);
    const before = countOf(fake, 'GET', `/v3/documents/${NS}__d1`);
    fake.failNext({ method: 'GET', transport: 'truncate' });
    await expect(store.getDocument(NS, 'd1')).resolves.toMatchObject({ content: 'x' });
    expect(countOf(fake, 'GET', `/v3/documents/${NS}__d1`) - before).toBe(2);
  });
});

describe('getDocument', () => {
  it('returns id, content and metadata', async () => {
    const { store } = setup();
    await store.addDocuments(NS, [doc('d1', 'body', { a: 'b' })]);
    await expect(store.getDocument(NS, 'd1')).resolves.toEqual({
      id: 'd1',
      content: 'body',
      metadata: { a: 'b' },
    });
  });
  it('returns null on 404', async () => {
    const { store } = setup();
    await expect(store.getDocument(NS, 'missing')).resolves.toBeNull();
  });
  it('returns null when containerTags exclude the namespace', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x')]);
    fake.docs.get(`${NS}__d1`)!.containerTags = ['someone_else'];
    await expect(store.getDocument(NS, 'd1')).resolves.toBeNull();
  });
});

describe('updateDocumentMetadata', () => {
  it('throws not_found for a missing document', async () => {
    const { store } = setup();
    const err = await store.updateDocumentMetadata(NS, 'missing', { a: 'b' }).catch((e) => e);
    expect(err).toBeInstanceOf(MemoryStoreHttpError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('supermemory_not_found');
  });
  it('is a no-op for equal metadata', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x', { a: 'b' })]);
    await store.updateDocumentMetadata(NS, 'd1', { a: 'b' });
    expect(writes(fake)).toHaveLength(1);
  });
  it('PATCHes changed metadata with containerTag', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x', { a: 'b' })]);
    await store.updateDocumentMetadata(NS, 'd1', { a: 'c' });
    expect(lastBody(fake, 'PATCH', `/v3/documents/${NS}__d1`)).toEqual({
      metadata: { a: 'c' },
      containerTag: NS,
    });
    expect(fake.docs.get(`${NS}__d1`)!.metadata).toEqual({ a: 'c' });
  });
  it('waits for a processing document, then PATCHes', async () => {
    const { fake, store } = setup({ apiKey: 'k', processingSteps: 2 });
    await store.addDocuments(NS, [doc('d1', 'x', { a: 'b' })]);
    await store.updateDocumentMetadata(NS, 'd1', { a: 'c' });
    expect(fake.docs.get(`${NS}__d1`)!.metadata).toEqual({ a: 'c' });
  });
  it('throws Busy without PATCHing when processing never finishes', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x', { a: 'b' })]);
    fake.setStatus(`${NS}__d1`, 'embedding');
    await expect(store.updateDocumentMetadata(NS, 'd1', { a: 'c' })).rejects.toBeInstanceOf(
      MemoryStoreBusyError,
    );
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });
});

describe('listDocuments', () => {
  it('sends the scoped body and maps de-prefixed ids', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x', { k: 'v' })]);
    const out = await store.listDocuments(NS, {
      page: 1,
      limit: 10,
      filter: memoryFilter.eq('k', 'v'),
    });
    expect(out).toEqual({ documents: [{ id: 'd1', metadata: { k: 'v' } }], hasMore: false });
    expect(lastBody(fake, 'POST', '/v3/documents/list')).toEqual({
      containerTags: [NS],
      page: 1,
      limit: 10,
      sort: 'createdAt',
      order: 'asc',
      filters: { AND: [{ key: 'k', value: 'v' }] },
    });
  });
  it('reports hasMore across 3 pages', async () => {
    const { store } = setup();
    await store.addDocuments(NS, [doc('a', 'x'), doc('b', 'x'), doc('c', 'x')]);
    const flags: boolean[] = [];
    const ids: string[] = [];
    for (const page of [1, 2, 3]) {
      const r = await store.listDocuments(NS, { page, limit: 1 });
      flags.push(r.hasMore);
      ids.push(...r.documents.map((d) => d.id));
    }
    expect(flags).toEqual([true, true, false]);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
  it('throws when an item is outside the namespace', async () => {
    const { fake, store } = setup();
    seed(fake, NS, 'other_ns__x', 'foreign');
    await expect(store.listDocuments(NS, { page: 1, limit: 10 })).rejects.toThrow(
      /outside the requested namespace/,
    );
  });
  it('returns empty on 404', async () => {
    const { fake, store } = setup();
    fake.failNext({ pathPrefix: '/v3/documents/list', status: 404 });
    await expect(store.listDocuments(NS, { page: 1, limit: 10 })).resolves.toEqual({
      documents: [],
      hasMore: false,
    });
  });
});

describe('toV3Filter', () => {
  const leaf = (operator: string, value: unknown) => ({ field: 'f', operator, value });
  it.each([
    [leaf('eq', 'x'), { key: 'f', value: 'x' }],
    [leaf('eq', 5), { key: 'f', value: '5', filterType: 'numeric', numericOperator: '=' }],
    [leaf('eq', true), { key: 'f', value: 'true' }],
    [leaf('neq', 'x'), { key: 'f', value: 'x', negate: true }],
    [leaf('gt', 3), { key: 'f', value: '3', filterType: 'numeric', numericOperator: '>' }],
    [leaf('gte', 3), { key: 'f', value: '3', filterType: 'numeric', numericOperator: '>=' }],
    [leaf('lt', 3), { key: 'f', value: '3', filterType: 'numeric', numericOperator: '<' }],
    [leaf('lte', 3), { key: 'f', value: '3', filterType: 'numeric', numericOperator: '<=' }],
    [leaf('contains', 'x'), { key: 'f', value: 'x', filterType: 'string_contains' }],
    [
      leaf('notContains', 'x'),
      { key: 'f', value: 'x', filterType: 'string_contains', negate: true },
    ],
    [leaf('arrayContains', 'x'), { key: 'f', value: 'x', filterType: 'array_contains' }],
    [
      leaf('arrayNotContains', 'x'),
      { key: 'f', value: 'x', filterType: 'array_contains', negate: true },
    ],
  ])('maps %j', (node, expected) => {
    expect(toV3Filter(node as unknown as FilterNode)).toEqual({ AND: [expected] });
  });
  it('keeps and/or roots and nests', () => {
    expect(
      toV3Filter({ or: [leaf('eq', 'a'), { and: [leaf('eq', 'b')] }] } as unknown as FilterNode),
    ).toEqual({
      OR: [{ key: 'f', value: 'a' }, { AND: [{ key: 'f', value: 'b' }] }],
    });
  });
  it('throws on non-number numeric values, array values and depth > 5', () => {
    expect(() => toV3Filter(leaf('gt', 'x') as unknown as FilterNode)).toThrow();
    expect(() => toV3Filter(leaf('eq', ['a']) as unknown as FilterNode)).toThrow();
    let n = leaf('eq', 'x') as unknown as FilterNode;
    for (let i = 0; i < 6; i++) n = { and: [n] };
    expect(() => toV3Filter(n)).toThrow();
    let ok = leaf('eq', 'x') as unknown as FilterNode;
    for (let i = 0; i < 5; i++) ok = { and: [ok] };
    expect(() => toV3Filter(ok)).not.toThrow();
  });
});

describe('search', () => {
  it('returns [] for an empty query without a request', async () => {
    const { fake, store } = setup();
    await expect(store.search(NS, { query: '   ', limit: 5 })).resolves.toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });
  it('sends the v3 body, de-prefixes ids and clamps the limit', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'coffee beans')]);
    const hits = await store.search(NS, {
      query: 'coffee',
      limit: 500,
      filter: memoryFilter.eq('vs_kind', 'email'),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'd1', content: 'coffee beans' });
    expect(lastBody(fake, 'POST', '/v3/search')).toEqual({
      q: 'coffee',
      containerTag: NS,
      limit: 100,
      onlyMatchingChunks: true,
      rerank: false,
      rewriteQuery: false,
      filters: { AND: [{ key: 'vs_kind', value: 'email' }] },
    });
  });
  it('joins relevant chunks in position order', async () => {
    const { store } = setup();
    await store.addDocuments(NS, [doc('d1', 'alpha coffee\n\nbeta tea\n\ngamma coffee')]);
    const hits = await store.search(NS, { query: 'coffee', limit: 5 });
    expect(hits[0]!.content).toBe('alpha coffee\n\ngamma coffee');
  });
  it('skips results without the namespace prefix and sorts by score', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('low', 'coffee tea water'), doc('high', 'coffee')]);
    seed(fake, NS, 'other__d', 'coffee');
    const hits = await store.search(NS, { query: 'coffee', limit: 5 });
    expect(hits.map((h) => h.id)).toEqual(
      ['high', 'low'].sort(
        (a, b) => hits.findIndex((h) => h.id === a) - hits.findIndex((h) => h.id === b),
      ),
    );
    expect(hits.map((h) => h.id)).not.toContain('other__d');
    expect(hits).toHaveLength(2);
    for (let i = 1; i < hits.length; i++)
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
  });
});

describe('deleteDocuments', () => {
  it('deletes a done document', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x')]);
    await expect(store.deleteDocuments(NS, ['d1'])).resolves.toEqual({ count: 1, errors: [] });
    expect(fake.docs.size).toBe(0);
  });
  it('treats 404 as success without counting', async () => {
    const { store } = setup();
    await expect(store.deleteDocuments(NS, ['missing'])).resolves.toEqual({ count: 0, errors: [] });
  });
  it('waits out a 409 and then deletes', async () => {
    const { fake, store } = setup({ apiKey: 'k', processingSteps: 2 });
    await store.addDocuments(NS, [doc('d1', 'x')]);
    await expect(store.deleteDocuments(NS, ['d1'])).resolves.toEqual({ count: 1, errors: [] });
    expect(fake.docs.size).toBe(0);
    expect(countOf(fake, 'DELETE', `/v3/documents/${NS}__d1`)).toBe(2);
  });
  it('reports still_processing when the document never settles', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x')]);
    fake.setStatus(`${NS}__d1`, 'queued');
    await expect(store.deleteDocuments(NS, ['d1'])).resolves.toEqual({
      count: 0,
      errors: [{ id: 'd1', error: 'still_processing' }],
    });
  });
  it('reports other 4xx as http_<status>', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('d1', 'x')]);
    fake.failNext({ method: 'DELETE', status: 403 });
    await expect(store.deleteDocuments(NS, ['d1'])).resolves.toEqual({
      count: 0,
      errors: [{ id: 'd1', error: 'http_403' }],
    });
  });
  it('throws on 401', async () => {
    const { store } = setup({ apiKey: 'k' }, { apiKey: 'wrong' });
    await expect(store.deleteDocuments(NS, ['d1'])).rejects.toBeInstanceOf(MemoryStoreAuthError);
  });
});

describe('deleteNamespace', () => {
  it('uses the container-tag delete on 200', async () => {
    const { fake, store } = setup();
    await store.addDocuments(NS, [doc('a', 'x'), doc('b', 'x')]);
    await store.deleteNamespace(NS);
    expect(fake.docs.size).toBe(0);
    expect(countOf(fake, 'DELETE', `/v3/container-tags/${NS}`)).toBe(1);
  });
  it('continues on 404', async () => {
    const { fake, store } = setup();
    await expect(store.deleteNamespace(NS)).resolves.toBeUndefined();
    expect(countOf(fake, 'DELETE', `/v3/container-tags/${NS}`)).toBe(1);
  });
  it('falls back to a multi-page purge on 403', async () => {
    const { fake, store } = setup({ apiKey: 'k', containerTagDelete: 'forbidden' });
    for (let i = 0; i < 120; i++) seed(fake, NS, `${NS}__d${i}`, 'x');
    seed(fake, 'vs_other', 'vs_other__keep', 'x');
    await store.deleteNamespace(NS);
    expect([...fake.docs.keys()]).toEqual(['vs_other__keep']);
    expect(countOf(fake, 'POST', '/v3/documents/list')).toBeGreaterThanOrEqual(3);
  });
  it('throws Busy when documents are left after the purge rounds', async () => {
    const { fake, store } = setup(
      { apiKey: 'k', containerTagDelete: 'forbidden' },
      { purgeRounds: 1 },
    );
    await store.addDocuments(NS, [doc('d1', 'x')]);
    fake.setStatus(`${NS}__d1`, 'queued');
    await expect(store.deleteNamespace(NS)).rejects.toBeInstanceOf(MemoryStoreBusyError);
  });
});

describe('listMemories', () => {
  it('drops forgotten entries', async () => {
    const { store } = setup({
      apiKey: 'k',
      memories: { [NS]: [{ id: 'm1' }, { id: 'm2', isForgotten: true }] },
    });
    await expect(store.listMemories(NS)).resolves.toEqual([{ id: 'm1' }]);
  });
  it('returns [] on 404', async () => {
    const { fake, store } = setup();
    fake.failNext({ pathPrefix: '/v4/memories/list', status: 404 });
    await expect(store.listMemories(NS)).resolves.toEqual([]);
  });
});
