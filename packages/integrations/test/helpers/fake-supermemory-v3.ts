/**
 * In-process fake of the self-hosted Supermemory v3 server (a `fetch` replacement).
 *
 * Reproduces the behaviour probed against the real server: account-global customId, POST to an
 * existing customId APPENDS, writes are silently dropped while a document is processing, DELETE
 * 409s in the early stages, metadata merges per key, container-tag scoping on list/search.
 * Does not import the adapter.
 */

export interface FakeV3Options {
  apiKey?: string;
  /** Number of GETs a document reports a processing status before it flips to done (0 = instantly done). */
  processingSteps?: number;
  containerTagDelete?: 'ok' | 'forbidden';
  memories?: Record<string, { id: string; isForgotten?: boolean }[]>;
}

export interface FakeV3Doc {
  smId: string;
  customId: string;
  content: string;
  metadata: Record<string, unknown>;
  containerTags: string[];
  status: string;
  createdSeq: number;
}

export interface FakeV3Server {
  fetch: typeof fetch;
  requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
  docs: Map<string, FakeV3Doc>;
  failNext(rule: {
    method?: string;
    pathPrefix?: string;
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    times?: number;
    transport?: 'reset' | 'truncate';
  }): void;
  setStatus(customId: string, status: string): void;
  finishAll(): void;
}

const PROCESSING = ['queued', 'extracting', 'chunking', 'embedding', 'indexing'];
const DELETE_CONFLICT = new Set(['queued', 'extracting', 'embedding']);
const CUSTOM_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_FILTER_DEPTH = 5;

type Json = Record<string, unknown>;
type Failure = Parameters<FakeV3Server['failNext']>[0] & { left: number };

class FilterError extends Error {}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function validation(data: unknown, ...errors: { path: string[]; message: string }[]): Response {
  return json(400, { data, error: errors, success: false });
}

function validMetadataValue(v: unknown): boolean {
  return (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    (Array.isArray(v) && v.every((x) => typeof x === 'string'))
  );
}

function matchLeaf(meta: Record<string, unknown>, leaf: Json): boolean {
  if (typeof leaf.key !== 'string' || typeof leaf.value !== 'string')
    throw new FilterError('bad leaf');
  const raw = meta[leaf.key];
  const type = (leaf.filterType as string | undefined) ?? 'metadata';
  let hit: boolean;
  if (raw === undefined) hit = false;
  else if (type === 'metadata') hit = String(raw) === leaf.value;
  else if (type === 'numeric') {
    const a = Number(raw);
    const b = Number(leaf.value);
    const op = (leaf.numericOperator as string | undefined) ?? '=';
    if (Number.isNaN(a) || Number.isNaN(b)) hit = false;
    else if (op === '>') hit = a > b;
    else if (op === '<') hit = a < b;
    else if (op === '>=') hit = a >= b;
    else if (op === '<=') hit = a <= b;
    else if (op === '=') hit = a === b;
    else throw new FilterError('bad numericOperator');
  } else if (type === 'array_contains') hit = Array.isArray(raw) && raw.includes(leaf.value);
  else if (type === 'string_contains')
    hit = String(raw).toLowerCase().includes(leaf.value.toLowerCase());
  else throw new FilterError('bad filterType');
  return leaf.negate === true ? !hit : hit;
}

function matchFilter(meta: Record<string, unknown>, node: unknown, depth: number): boolean {
  if (depth > MAX_FILTER_DEPTH) throw new FilterError('filter too deep');
  if (typeof node !== 'object' || node === null) throw new FilterError('bad filter');
  const n = node as Json;
  if (Array.isArray(n.AND)) return n.AND.every((c) => matchFilter(meta, c, depth + 1));
  if (Array.isArray(n.OR)) return n.OR.some((c) => matchFilter(meta, c, depth + 1));
  return matchLeaf(meta, n);
}

export function createFakeSupermemoryV3(opts: FakeV3Options = {}): FakeV3Server {
  const steps = opts.processingSteps ?? 0;
  const docs = new Map<string, FakeV3Doc>();
  const requests: FakeV3Server['requests'] = [];
  const failures: Failure[] = [];
  const memories = new Map(Object.entries(opts.memories ?? {}).map(([k, v]) => [k, [...v]]));
  /** GETs left before a doc reports done; Infinity pins it to its current processing status. */
  const remaining = new Map<string, number>();
  let seq = 0;

  const isProcessing = (d: FakeV3Doc) => PROCESSING.includes(d.status);

  function requeue(d: FakeV3Doc): void {
    if (steps <= 0) {
      d.status = 'done';
      remaining.set(d.customId, 0);
    } else {
      d.status = 'queued';
      remaining.set(d.customId, steps);
    }
  }

  function tick(d: FakeV3Doc): void {
    const left = remaining.get(d.customId) ?? 0;
    if (!isProcessing(d) || left === Infinity) return;
    if (left <= 0) {
      d.status = 'done';
      return;
    }
    remaining.set(d.customId, left - 1);
    const done = steps - left;
    d.status = PROCESSING[Math.min(Math.max(done, 0), PROCESSING.length - 1)]!;
    if (left - 1 <= 0) remaining.set(d.customId, 0);
  }

  function lookup(id: string): FakeV3Doc | undefined {
    const direct = docs.get(id);
    if (direct) return direct;
    for (const d of docs.values()) if (d.smId === id) return d;
    return undefined;
  }

  function view(d: FakeV3Doc): Json {
    const iso = new Date(1_700_000_000_000 + d.createdSeq * 1000).toISOString();
    return {
      id: d.smId,
      customId: d.customId,
      content: d.content,
      metadata: d.metadata,
      status: d.status,
      containerTags: d.containerTags,
      title: null,
      type: 'text',
      createdAt: iso,
      updatedAt: iso,
      ...(d.status === 'done' ? { memories: [] } : {}),
    };
  }

  function inTags(d: FakeV3Doc, tags: string[]): boolean {
    return d.containerTags.some((t) => tags.includes(t));
  }

  function postDocument(body: Json): Response {
    const { content, customId, metadata } = body;
    const tag =
      (body.containerTag as string | undefined) ??
      (body.containerTags as string[] | undefined)?.[0];
    const errors: { path: string[]; message: string }[] = [];
    if (typeof content !== 'string' || content === '')
      errors.push({ path: ['content'], message: 'is missing' });
    if (typeof customId !== 'string' || !CUSTOM_ID_RE.test(customId)) {
      errors.push({ path: ['customId'], message: 'is invalid' });
    }
    if (metadata !== undefined) {
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        errors.push({ path: ['metadata'], message: 'is invalid' });
      } else if (!Object.values(metadata).every(validMetadataValue)) {
        errors.push({ path: ['metadata'], message: 'has an invalid value' });
      }
    }
    if (errors.length > 0) return validation(body, ...errors);
    const id = customId as string;
    const meta = (metadata as Record<string, unknown> | undefined) ?? {};
    const existing = docs.get(id);
    if (existing) {
      // Dropped while processing; otherwise APPENDS and merges metadata (the real server's footgun).
      if (isProcessing(existing)) return json(200, { id: existing.smId, status: existing.status });
      existing.content = `${existing.content}\n\n---\n\n${content as string}`;
      Object.assign(existing.metadata, meta);
      requeue(existing);
      return json(200, { id: existing.smId, status: existing.status });
    }
    seq += 1;
    const d: FakeV3Doc = {
      smId: `sm_${seq}`,
      customId: id,
      content: content as string,
      metadata: { ...meta },
      containerTags: tag ? [tag] : [],
      status: 'queued',
      createdSeq: seq,
    };
    docs.set(id, d);
    requeue(d);
    return json(200, { id: d.smId, status: steps <= 0 ? 'queued' : d.status });
  }

  function patchDocument(id: string, body: Json): Response {
    const d = lookup(id);
    if (!d) return json(404, { error: 'Document not found' });
    const meta = body.metadata;
    if (meta !== undefined) {
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
        return validation(body, { path: ['metadata'], message: 'is invalid' });
      }
      if (!Object.values(meta).every(validMetadataValue)) {
        return validation(body, { path: ['metadata'], message: 'has an invalid value' });
      }
    }
    if (body.content !== undefined && typeof body.content !== 'string') {
      return validation(body, { path: ['content'], message: 'is invalid' });
    }
    // Silently dropped while processing: 200 with the current status, nothing changed.
    if (isProcessing(d)) return json(200, { id: d.smId, status: d.status });
    if (typeof body.content === 'string') d.content = body.content;
    if (meta) Object.assign(d.metadata, meta);
    requeue(d);
    return json(200, { id: d.smId, status: 'queued' });
  }

  function deleteDocument(id: string): Response {
    const d = lookup(id);
    if (!d) return json(404, { error: 'Document not found' });
    if (DELETE_CONFLICT.has(d.status)) return json(409, { error: 'Document is still processing' });
    docs.delete(d.customId);
    remaining.delete(d.customId);
    return new Response(null, { status: 204 });
  }

  function listDocuments(body: Json): Response {
    const tags = body.containerTags;
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      return validation(body, { path: ['containerTags'], message: 'is invalid' });
    }
    const page = typeof body.page === 'number' ? body.page : 1;
    const limit = typeof body.limit === 'number' ? body.limit : 50;
    if (!Number.isInteger(page) || page < 1)
      return validation(body, { path: ['page'], message: 'is invalid' });
    if (!Number.isInteger(limit) || limit < 1 || limit > 1100) {
      return validation(body, { path: ['limit'], message: 'must be between 1 and 1100' });
    }
    let matched = [...docs.values()].filter((d) => inTags(d, tags as string[]));
    try {
      if (body.filters !== undefined)
        matched = matched.filter((d) => matchFilter(d.metadata, body.filters, 1));
    } catch (e) {
      return validation(body, { path: ['filters'], message: (e as Error).message });
    }
    matched.sort((a, b) => a.createdSeq - b.createdSeq);
    if (body.order === 'desc') matched.reverse();
    const slice = matched.slice((page - 1) * limit, page * limit);
    return json(200, {
      memories: slice.map((d) => {
        const { content: _content, ...rest } = view(d);
        return rest;
      }),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(matched.length / limit),
        totalItems: matched.length,
      },
    });
  }

  function search(body: Json): Response {
    const errors: { path: string[]; message: string }[] = [];
    if (typeof body.q !== 'string' || body.q === '')
      errors.push({ path: ['q'], message: 'is missing' });
    const limit = typeof body.limit === 'number' ? body.limit : 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      errors.push({ path: ['limit'], message: 'must be between 1 and 100' });
    }
    if (errors.length > 0) return validation(body, ...errors);
    const tags =
      typeof body.containerTag === 'string'
        ? [body.containerTag]
        : Array.isArray(body.containerTags)
          ? (body.containerTags as string[])
          : [];
    const tokens = (body.q as string)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    const onlyMatching = body.onlyMatchingChunks === true;
    const results: Json[] = [];
    try {
      for (const d of docs.values()) {
        if (d.status !== 'done' || !inTags(d, tags)) continue;
        if (body.filters !== undefined && !matchFilter(d.metadata, body.filters, 1)) continue;
        const chunks = d.content
          .split(/\n{2,}/)
          .map((text, position) => {
            const lower = text.toLowerCase();
            const hits = tokens.filter((t) => lower.includes(t)).length;
            const score = tokens.length === 0 ? 0 : hits / tokens.length;
            return { content: text, position, isRelevant: score > 0, score };
          })
          .filter((c) => c.content.trim() !== '');
        const relevant = chunks.filter((c) => c.isRelevant);
        if (relevant.length === 0) continue;
        const v = view(d);
        results.push({
          documentId: d.customId,
          chunks: onlyMatching ? relevant : chunks,
          metadata: d.metadata,
          score: Math.max(...relevant.map((c) => c.score)),
          title: null,
          type: 'text',
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        });
      }
    } catch (e) {
      return validation(body, { path: ['filters'], message: (e as Error).message });
    }
    results.sort((a, b) => (b.score as number) - (a.score as number));
    const top = results.slice(0, limit);
    return json(200, { results: top, total: results.length, timing: 1 });
  }

  function deleteContainerTag(tag: string): Response {
    if (opts.containerTagDelete === 'forbidden') return json(403, { error: 'Forbidden' });
    const owned = [...docs.values()].filter((d) => d.containerTags.includes(tag));
    if (owned.length === 0 && !memories.has(tag))
      return json(404, { error: 'Container tag not found' });
    for (const d of owned) {
      docs.delete(d.customId);
      remaining.delete(d.customId);
    }
    const deletedMemoriesCount = memories.get(tag)?.length ?? 0;
    memories.delete(tag);
    return json(200, { deletedDocumentsCount: owned.length, deletedMemoriesCount });
  }

  function listMemories(body: Json): Response {
    const tags = body.containerTags;
    if (!Array.isArray(tags) || tags.length === 0) {
      return validation(body, { path: ['containerTags'], message: 'is invalid' });
    }
    const page = typeof body.page === 'number' ? body.page : 1;
    const limit = typeof body.limit === 'number' ? body.limit : 50;
    const all = (tags as string[]).flatMap((t) => memories.get(t) ?? []);
    const slice = all.slice((page - 1) * limit, page * limit);
    return json(200, {
      memoryEntries: slice.map((m) => ({
        id: m.id,
        isForgotten: m.isForgotten ?? false,
        isLatest: true,
        memory: '',
      })),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(all.length / limit),
        totalItems: all.length,
      },
    });
  }

  function route(method: string, path: string, body: Json): Response {
    if (method === 'POST' && path === '/v3/documents') return postDocument(body);
    if (method === 'POST' && path === '/v3/documents/list') return listDocuments(body);
    if (method === 'POST' && path === '/v3/search') return search(body);
    if (method === 'POST' && path === '/v4/memories/list') return listMemories(body);
    const doc = /^\/v3\/documents\/([^/]+)$/.exec(path);
    if (doc && !['list', 'bulk', 'batch', 'file', 'processing'].includes(doc[1]!)) {
      const id = decodeURIComponent(doc[1]!);
      if (method === 'GET') {
        const d = lookup(id);
        if (!d) return json(404, { error: 'Document not found' });
        tick(d);
        return json(200, view(d));
      }
      if (method === 'PATCH') return patchDocument(id, body);
      if (method === 'DELETE') return deleteDocument(id);
    }
    const tag = /^\/v3\/container-tags\/([^/]+)$/.exec(path);
    if (tag && method === 'DELETE') return deleteContainerTag(decodeURIComponent(tag[1]!));
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req ? req.url : String(input));
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    let parsed: unknown;
    let badJson = false;
    if (rawBody !== undefined && rawBody !== '') {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        badJson = true;
      }
    }
    requests.push({ method, path: url.pathname, body: parsed, headers });

    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    const fi = failures.findIndex(
      (f) =>
        f.left > 0 &&
        (f.method === undefined || f.method.toUpperCase() === method) &&
        (f.pathPrefix === undefined || url.pathname.startsWith(f.pathPrefix)),
    );
    if (fi >= 0) {
      const f = failures[fi]!;
      f.left -= 1;
      if (f.left <= 0) failures.splice(fi, 1);
      if (f.transport === 'reset') throw new TypeError('fetch failed');
      if (f.transport === 'truncate') {
        return new Response('{"id":"sm_trunc","content":"cut off', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return json(f.status ?? 500, f.body ?? { error: 'injected failure' }, f.headers);
    }

    if (opts.apiKey !== undefined && headers.authorization !== `Bearer ${opts.apiKey}`) {
      return headers.authorization === undefined
        ? new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } })
        : json(401, { error: 'Unauthorized' });
    }
    if (badJson) return json(400, { error: 'Invalid JSON body' });
    const body = typeof parsed === 'object' && parsed !== null ? (parsed as Json) : {};
    return route(method, url.pathname, body);
  };

  return {
    fetch: fakeFetch as typeof fetch,
    requests,
    docs,
    failNext(rule) {
      failures.push({ ...rule, left: rule.times ?? 1 });
    },
    setStatus(customId, status) {
      const d = docs.get(customId);
      if (!d) throw new Error(`fake: no document ${customId}`);
      d.status = status;
      remaining.set(customId, PROCESSING.includes(status) ? Infinity : 0);
    },
    finishAll() {
      for (const d of docs.values()) {
        d.status = 'done';
        remaining.set(d.customId, 0);
      }
    },
  };
}
