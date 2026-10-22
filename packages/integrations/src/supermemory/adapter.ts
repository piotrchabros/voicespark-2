import { Supermemory, SupermemoryError } from 'supermemory';
import type { FilterExpression, GetDocumentsResponse } from 'supermemory';
import type { FilterNode, MemoryDoc, MemoryMetadata, MemoryStore } from './port';

/** Chunks, not extracted memories: the profile pipeline needs source text (contracts/supermemory.md). */
export const SEARCH_MODE = 'chunks';

const DELETE_CHUNK = 100;
// The SDK retries 408/409/429/5xx with exponential back-off; 401 is never retried.
const MAX_RETRIES = 4;

/** 401 from Supermemory: fatal, raises an admin alert, no retry. */
export class MemoryStoreAuthError extends Error {
  readonly status = 401;
  constructor(message = 'Supermemory rejected the API key (401)') {
    super(message);
    this.name = 'MemoryStoreAuthError';
  }
}

function statusOf(err: unknown): number | undefined {
  return err instanceof SupermemoryError ? err.statusCode : undefined;
}

async function call<T>(fn: () => PromiseLike<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (statusOf(err) === 401) throw new MemoryStoreAuthError();
    throw err;
  }
}

/** Port filter -> SDK `{field, operator, value}` predicates / `{operator: and|or, operands}` nodes. */
function toFilter(node: FilterNode): FilterExpression {
  if ('and' in node) return { operator: 'and', operands: node.and.map(toFilter) };
  if ('or' in node) return { operator: 'or', operands: node.or.map(toFilter) };
  const { field, operator, value } = node;
  if (Array.isArray(value)) throw new Error(`Supermemory filters do not support array values (field ${field})`);
  // The SDK's predicate union is split per operator/value type; the port keeps them loose, so cast.
  return { field, operator, value } as FilterExpression;
}

function asMetadata(raw: Record<string, unknown> | null | undefined): MemoryMetadata {
  return (raw ?? {}) as MemoryMetadata;
}

export class SupermemoryAdapter implements MemoryStore {
  private readonly client: Supermemory;

  constructor(opts: { apiKey: string; baseURL?: string }) {
    this.client = new Supermemory({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseUrl: opts.baseURL } : {}),
      maxRetries: MAX_RETRIES,
    });
  }

  async addDocuments(ns: string, docs: MemoryDoc[]): Promise<{ id: string; status: string }[]> {
    const out: { id: string; status: string }[] = [];
    // Re-using an `id` merges into the existing document, which makes the write idempotent.
    for (const doc of docs) {
      const res = await call(() =>
        this.client.add(ns, { content: doc.content, id: doc.id, date: doc.documentDate, metadata: doc.metadata }),
      );
      out.push({ id: res.id, status: res.status });
    }
    return out;
  }

  async getDocument(ns: string, id: string): Promise<{ id: string; content: string; metadata: MemoryMetadata } | null> {
    let res: GetDocumentsResponse;
    try {
      res = await call(() => this.client.documents.get(ns, id));
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
    // `content` is the original text; `summary`/`title` are processed and must not stand in for it.
    return { id: res.id, content: res.content ?? '', metadata: asMetadata(res.metadata) };
  }

  async listDocuments(
    ns: string,
    q: { filter?: FilterNode; page: number; limit: number },
  ): Promise<{ documents: { id: string; metadata: MemoryMetadata }[]; hasMore: boolean }> {
    let res;
    try {
      res = await call(() =>
        this.client.list(ns, 'documents', {
          page: q.page,
          limit: q.limit,
          ...(q.filter ? { filter: toFilter(q.filter) } : {}),
        }),
      );
    } catch (err) {
      if (statusOf(err) === 404) return { documents: [], hasMore: false };
      throw err;
    }
    return {
      documents: res.documents.map((d) => ({ id: d.id, metadata: asMetadata(d.metadata) })),
      hasMore: res.pagination.currentPage < res.pagination.totalPages,
    };
  }

  async search(ns: string, q: { query: string; limit: number; filter?: FilterNode }): Promise<{ id: string; content: string; score: number }[]> {
    let res;
    try {
      res = await call(() =>
        this.client.search(ns, {
          query: q.query,
          limit: q.limit,
          searchMode: SEARCH_MODE,
          ...(q.filter ? { filter: toFilter(q.filter) } : {}),
        }),
      );
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
    return res.results.map((r) => ({ id: r.id, content: r.chunk ?? r.memory ?? '', score: r.similarity }));
  }

  async deleteDocuments(ns: string, ids: string[]): Promise<{ count: number; errors: { id: string; error: string }[] }> {
    let count = 0;
    let errors: { id: string; error: string }[] = [];
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      const chunk = ids.slice(i, i + DELETE_CHUNK);
      const res = await call(() => this.client.documents.delete(ns, { ids: chunk }));
      count += res.count;
      errors.push(...res.errors);
    }
    // Partial failures: retry the failed ids once; the caller retries anything left over.
    if (errors.length > 0) {
      const retryIds = errors.map((e) => e.id);
      errors = [];
      for (let i = 0; i < retryIds.length; i += DELETE_CHUNK) {
        const res = await call(() => this.client.documents.delete(ns, { ids: retryIds.slice(i, i + DELETE_CHUNK) }));
        count += res.count;
        errors.push(...res.errors);
      }
    }
    return { count, errors };
  }

  async updateDocumentMetadata(ns: string, id: string, metadata: MemoryMetadata): Promise<void> {
    await call(() => this.client.documents.update(ns, id, { metadata }));
  }

  async deleteNamespace(ns: string): Promise<void> {
    try {
      await call(() => this.client.namespaces.delete(ns));
    } catch (err) {
      if (statusOf(err) === 404) return;
      throw err;
    }
  }

  async listMemories(ns: string): Promise<{ id: string }[]> {
    try {
      const res = await call(() => this.client.list(ns, 'memories', { limit: 100 }));
      return res.memories.map((m) => ({ id: m.id }));
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
  }
}
