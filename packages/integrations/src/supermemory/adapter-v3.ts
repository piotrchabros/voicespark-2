import { MemoryStoreAuthError, MemoryStoreBusyError, MemoryStoreHttpError } from './errors';
import { toV3Filter } from './v3-filter';
import { V3Http, errorFromResponse } from './v3-http';
import type { V3HttpOptions, V3Response } from './v3-http';
import type { FilterNode, MemoryDoc, MemoryMetadata, MemoryStore } from './port';

/** Statuses during which v3 silently drops writes (POST/PATCH return 200 but change nothing). */
export const V3_PROCESSING_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'extracting',
  'chunking',
  'embedding',
  'indexing',
]);

const NS_RE = /^[a-zA-Z0-9_:-]{1,100}$/;
const CUSTOM_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const SEP = '__';
const MAX_WRITE_ATTEMPTS = 3;
const SEARCH_MAX_LIMIT = 100;
const PURGE_PAGE = 100;
/** Poll count when the poll interval is 0 (tests): bounded so a stuck document cannot spin forever. */
const ZERO_POLL_ROUNDS = 20;

export function v3CustomId(ns: string, id: string): string {
  const customId = `${ns}${SEP}${id}`;
  if (!CUSTOM_ID_RE.test(customId))
    throw new Error('Invalid Supermemory document id: customId must match [A-Za-z0-9_.:-]{1,100}');
  return customId;
}

export function portIdFromCustomId(ns: string, customId: string | null | undefined): string | null {
  const prefix = `${ns}${SEP}`;
  if (
    typeof customId !== 'string' ||
    !customId.startsWith(prefix) ||
    customId.length === prefix.length
  )
    return null;
  return customId.slice(prefix.length);
}

export interface SupermemoryV3AdapterOptions extends V3HttpOptions {
  /** How long a write waits for a still-processing document before throwing MemoryStoreBusyError. */
  processingWaitMs?: number;
  processingPollMs?: number;
  /** Max list+delete rounds when purging a namespace. */
  purgeRounds?: number;
}

interface RemoteDoc {
  id: string;
  status: string;
  content: string;
  metadata: Record<string, unknown>;
  containerTags: string[] | undefined;
}

type Settled = { busy: true } | { busy: false; doc: RemoteDoc | null };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isOk = (status: number) => status >= 200 && status < 300;
const isProcessing = (doc: RemoteDoc) => V3_PROCESSING_STATUSES.has(doc.status);

function validateNs(ns: string): void {
  if (!NS_RE.test(ns))
    throw new Error('Invalid Supermemory namespace: must match [a-zA-Z0-9_:-]{1,100}');
}

function badResponse(res: V3Response, what: string): MemoryStoreHttpError {
  return new MemoryStoreHttpError(
    res.status,
    'supermemory_bad_response',
    true,
    `Supermemory ${what} response had an unexpected shape`,
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  return false;
}

/** Every key we would send is already stored with the same value (PATCH merges per key, so extra stored keys are fine). */
function metadataCovered(stored: Record<string, unknown>, sent: MemoryMetadata): boolean {
  return Object.entries(sent).every(([k, v]) => deepEqual(stored[k], v));
}

function notFound(): MemoryStoreHttpError {
  return new MemoryStoreHttpError(
    404,
    'supermemory_not_found',
    false,
    'Supermemory document not found',
  );
}

/** Transient failure worth restarting a write at the GET step. */
function isRestartable(err: unknown): boolean {
  return err instanceof MemoryStoreHttpError && err.retryable;
}

export class SupermemoryV3Adapter implements MemoryStore {
  private readonly http: V3Http;
  private readonly processingWaitMs: number;
  private readonly processingPollMs: number;
  private readonly purgeRounds: number;

  constructor(opts: SupermemoryV3AdapterOptions) {
    this.http = new V3Http(opts);
    this.processingWaitMs = opts.processingWaitMs ?? 15_000;
    this.processingPollMs = opts.processingPollMs ?? 5_000;
    this.purgeRounds = opts.purgeRounds ?? 10;
  }

  async addDocuments(ns: string, docs: MemoryDoc[]): Promise<{ id: string; status: string }[]> {
    validateNs(ns);
    const out: { id: string; status: string }[] = [];
    for (const doc of docs) out.push(await this.upsertOne(ns, doc));
    return out;
  }

  async getDocument(
    ns: string,
    id: string,
  ): Promise<{ id: string; content: string; metadata: MemoryMetadata } | null> {
    validateNs(ns);
    const doc = await this.fetchDoc(v3CustomId(ns, id));
    if (!doc || (doc.containerTags && !doc.containerTags.includes(ns))) return null;
    return { id, content: doc.content, metadata: doc.metadata as MemoryMetadata };
  }

  async updateDocumentMetadata(ns: string, id: string, metadata: MemoryMetadata): Promise<void> {
    validateNs(ns);
    const customId = v3CustomId(ns, id);
    const budget = this.newBudget();
    let doc = await this.fetchDoc(customId);
    if (!doc || (doc.containerTags && !doc.containerTags.includes(ns))) throw notFound();
    if (metadataCovered(doc.metadata, metadata)) return;
    if (isProcessing(doc)) {
      const settled = await this.settle(customId, budget);
      if (settled.busy) throw new MemoryStoreBusyError('updateDocumentMetadata');
      doc = settled.doc;
      if (!doc) throw notFound();
      if (metadataCovered(doc.metadata, metadata)) return;
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.http.sendRetrying('PATCH', this.docPath(customId), {
        metadata,
        containerTag: ns,
      });
      if (isOk(res.status)) return;
      if (res.status === 404) throw notFound();
      if (res.status !== 409) throw errorFromResponse(res);
      const settled = await this.settle(customId, budget);
      if (settled.busy || attempt >= 1) throw new MemoryStoreBusyError('updateDocumentMetadata');
      if (!settled.doc) throw notFound();
    }
  }

  async listDocuments(
    ns: string,
    q: { filter?: FilterNode; page: number; limit: number },
  ): Promise<{ documents: { id: string; metadata: MemoryMetadata }[]; hasMore: boolean }> {
    validateNs(ns);
    const res = await this.http.sendRetrying('POST', '/v3/documents/list', {
      containerTags: [ns],
      page: q.page,
      limit: q.limit,
      sort: 'createdAt',
      order: 'asc',
      ...(q.filter ? { filters: toV3Filter(q.filter) } : {}),
    });
    if (res.status === 404) return { documents: [], hasMore: false };
    if (!isOk(res.status)) throw errorFromResponse(res);
    const body = res.body;
    if (!isObject(body) || !Array.isArray(body.memories)) throw badResponse(res, 'list');
    const documents = body.memories.map((m: unknown) => {
      const item = isObject(m) ? m : {};
      const id = portIdFromCustomId(ns, typeof item.customId === 'string' ? item.customId : null);
      const tags = Array.isArray(item.containerTags) ? item.containerTags : undefined;
      if (id === null || (tags && !tags.includes(ns))) {
        throw new Error('Supermemory list returned a document outside the requested namespace');
      }
      return { id, metadata: (isObject(item.metadata) ? item.metadata : {}) as MemoryMetadata };
    });
    const p = isObject(body.pagination) ? body.pagination : {};
    const currentPage = typeof p.currentPage === 'number' ? p.currentPage : q.page;
    const totalPages = typeof p.totalPages === 'number' ? p.totalPages : currentPage;
    return { documents, hasMore: currentPage < totalPages };
  }

  async search(
    ns: string,
    q: { query: string; limit: number; filter?: FilterNode },
  ): Promise<{ id: string; content: string; score: number }[]> {
    validateNs(ns);
    if (!q.query.trim()) return [];
    const res = await this.http.sendRetrying('POST', '/v3/search', {
      q: q.query,
      containerTag: ns,
      limit: Math.max(1, Math.min(q.limit, SEARCH_MAX_LIMIT)),
      onlyMatchingChunks: true,
      rerank: false,
      rewriteQuery: false,
      ...(q.filter ? { filters: toV3Filter(q.filter) } : {}),
    });
    if (res.status === 404) return [];
    if (!isOk(res.status)) throw errorFromResponse(res);
    if (!isObject(res.body) || !Array.isArray(res.body.results)) throw badResponse(res, 'search');
    const hits: { id: string; content: string; score: number }[] = [];
    for (const r of res.body.results as unknown[]) {
      if (!isObject(r)) continue;
      const id = portIdFromCustomId(ns, typeof r.documentId === 'string' ? r.documentId : null);
      if (id === null) continue;
      const chunks = (Array.isArray(r.chunks) ? r.chunks : []).filter(isObject);
      const relevant = chunks.filter((c) => c.isRelevant === true);
      const picked = (relevant.length > 0 ? relevant : chunks)
        .slice()
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
      const content = picked
        .map((c) => (typeof c.content === 'string' ? c.content : ''))
        .join('\n\n');
      hits.push({ id, content, score: typeof r.score === 'number' ? r.score : 0 });
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  async deleteDocuments(
    ns: string,
    ids: string[],
  ): Promise<{ count: number; errors: { id: string; error: string }[] }> {
    validateNs(ns);
    const budget = this.newBudget();
    let count = 0;
    const errors: { id: string; error: string }[] = [];
    for (const id of ids) {
      const customId = v3CustomId(ns, id);
      try {
        let res = await this.http.sendRetrying('DELETE', this.docPath(customId));
        if (res.status === 409) {
          const settled = await this.settle(customId, budget);
          if (settled.busy) {
            errors.push({ id, error: 'still_processing' });
            continue;
          }
          res = await this.http.sendRetrying('DELETE', this.docPath(customId));
          if (res.status === 409) {
            errors.push({ id, error: 'still_processing' });
            continue;
          }
        }
        if (isOk(res.status)) count++;
        else if (res.status !== 404) errors.push({ id, error: `http_${res.status}` });
      } catch (err) {
        if (err instanceof MemoryStoreAuthError || !(err instanceof MemoryStoreHttpError))
          throw err;
        errors.push({ id, error: err.code });
      }
    }
    return { count, errors };
  }

  async deleteNamespace(ns: string): Promise<void> {
    validateNs(ns);
    const res = await this.http.sendRetrying(
      'DELETE',
      `/v3/container-tags/${encodeURIComponent(ns)}`,
    );
    // 403: the key is not org owner/admin; fall through to the per-document purge.
    if (!isOk(res.status) && res.status !== 404 && res.status !== 403) throw errorFromResponse(res);
    for (let round = 0; round < this.purgeRounds; round++) {
      const page = await this.listDocuments(ns, { page: 1, limit: PURGE_PAGE });
      if (page.documents.length === 0) return;
      await this.deleteDocuments(
        ns,
        page.documents.map((d) => d.id),
      );
    }
    const left = await this.listDocuments(ns, { page: 1, limit: 1 });
    if (left.documents.length > 0) throw new MemoryStoreBusyError('deleteNamespace');
  }

  async listMemories(ns: string): Promise<{ id: string }[]> {
    validateNs(ns);
    const res = await this.http.sendRetrying('POST', '/v4/memories/list', {
      containerTags: [ns],
      page: 1,
      limit: 100,
    });
    if (res.status === 404) return [];
    if (!isOk(res.status)) throw errorFromResponse(res);
    if (!isObject(res.body) || !Array.isArray(res.body.memoryEntries))
      throw badResponse(res, 'memories');
    return (res.body.memoryEntries as unknown[])
      .filter(isObject)
      .filter((m) => m.isForgotten !== true && typeof m.id === 'string')
      .map((m) => ({ id: m.id as string }));
  }

  /** Not on the port: polls until none of `ids` is processing or the timeout elapses; returns the ids still processing. */
  async waitUntilProcessed(ns: string, ids: string[], timeoutMs: number): Promise<string[]> {
    validateNs(ns);
    let pending = ids.slice();
    const rounds = this.pollRounds(timeoutMs);
    for (let round = 0; ; round++) {
      const still: string[] = [];
      for (const id of pending) {
        const doc = await this.fetchDoc(v3CustomId(ns, id));
        if (doc && isProcessing(doc)) still.push(id);
      }
      pending = still;
      if (pending.length === 0 || round >= rounds) return pending;
      await this.http.sleep(this.processingPollMs);
    }
  }

  private docPath(customId: string): string {
    return `/v3/documents/${encodeURIComponent(customId)}`;
  }

  private pollRounds(waitMs: number): number {
    return this.processingPollMs > 0 ? Math.ceil(waitMs / this.processingPollMs) : ZERO_POLL_ROUNDS;
  }

  private newBudget(): { polls: number } {
    return { polls: this.pollRounds(this.processingWaitMs) };
  }

  /** GET by customId; null = 404. */
  private async fetchDoc(customId: string): Promise<RemoteDoc | null> {
    const res = await this.http.sendRetrying('GET', this.docPath(customId));
    if (res.status === 404) return null;
    if (!isOk(res.status)) throw errorFromResponse(res);
    const b = res.body;
    if (!isObject(b)) throw badResponse(res, 'document');
    return {
      id: typeof b.id === 'string' ? b.id : customId,
      status: typeof b.status === 'string' ? b.status : 'unknown',
      content: typeof b.content === 'string' ? b.content : '',
      metadata: isObject(b.metadata) ? b.metadata : {},
      containerTags: Array.isArray(b.containerTags)
        ? b.containerTags.filter((t): t is string => typeof t === 'string')
        : undefined,
    };
  }

  /** Polls until the document is gone or finished processing; busy when the budget runs out first. */
  private async settle(customId: string, budget: { polls: number }): Promise<Settled> {
    while (budget.polls > 0) {
      budget.polls--;
      await this.http.sleep(this.processingPollMs);
      const doc = await this.fetchDoc(customId);
      if (!doc || !isProcessing(doc)) return { busy: false, doc };
    }
    return { busy: true };
  }

  private async upsertOne(ns: string, doc: MemoryDoc): Promise<{ id: string; status: string }> {
    const customId = v3CustomId(ns, doc.id);
    const content: string = doc.content;
    const budget = this.newBudget();
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      try {
        let existing = await this.fetchDoc(customId);
        if (existing && existing.containerTags && !existing.containerTags.includes(ns)) {
          throw new Error('Supermemory document exists outside the requested namespace');
        }
        if (!existing) {
          // Never POST to an existing id: v3 appends the new content to the old.
          const res = await this.http.sendRetrying(
            'POST',
            '/v3/documents',
            {
              content,
              customId,
              containerTag: ns,
              metadata: doc.metadata,
              documentDate: doc.documentDate,
            },
            { idempotent: false },
          );
          if (res.status >= 500) {
            lastErr = errorFromResponse(res);
            continue;
          }
          if (!isOk(res.status)) throw errorFromResponse(res);
          return {
            id: doc.id,
            status:
              isObject(res.body) && typeof res.body.status === 'string'
                ? res.body.status
                : 'queued',
          };
        }
        const same = (d: RemoteDoc) =>
          d.content === content && metadataCovered(d.metadata, doc.metadata);
        if (same(existing)) return { id: doc.id, status: existing.status };
        if (isProcessing(existing)) {
          const settled = await this.settle(customId, budget);
          if (settled.busy) throw new MemoryStoreBusyError('addDocuments');
          if (!settled.doc) continue;
          existing = settled.doc;
          if (same(existing)) return { id: doc.id, status: existing.status };
        }
        const res = await this.http.sendRetrying(
          'PATCH',
          this.docPath(customId),
          { content, containerTag: ns, metadata: doc.metadata, documentDate: doc.documentDate },
          { idempotent: false },
        );
        if (res.status === 404) continue;
        if (res.status === 409) {
          const settled = await this.settle(customId, budget);
          if (settled.busy) throw new MemoryStoreBusyError('addDocuments');
          continue;
        }
        if (res.status >= 500) {
          lastErr = errorFromResponse(res);
          continue;
        }
        if (!isOk(res.status)) throw errorFromResponse(res);
        return {
          id: doc.id,
          status:
            isObject(res.body) && typeof res.body.status === 'string' ? res.body.status : 'queued',
        };
      } catch (err) {
        if (!isRestartable(err)) throw err;
        lastErr = err;
      }
    }
    throw (
      lastErr ??
      new MemoryStoreHttpError(
        undefined,
        'supermemory_network',
        true,
        'Supermemory write did not complete after retries',
      )
    );
  }
}
