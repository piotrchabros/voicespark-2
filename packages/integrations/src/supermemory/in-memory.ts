import type { FilterNode, MemoryDoc, MemoryMetadata, MemoryStore, MetadataValue } from './port';

interface StoredDoc {
  id: string;
  content: string;
  documentDate: string;
  metadata: MemoryMetadata;
}

function matchLeaf(actual: MetadataValue | undefined, operator: string, expected: MetadataValue): boolean {
  switch (operator) {
    case 'eq':
      return Array.isArray(actual) || Array.isArray(expected)
        ? JSON.stringify(actual) === JSON.stringify(expected)
        : actual === expected;
    case 'neq':
      return !matchLeaf(actual, 'eq', expected);
    case 'gt':
      return actual !== undefined && !Array.isArray(actual) && !Array.isArray(expected) && actual > expected;
    case 'gte':
      return actual !== undefined && !Array.isArray(actual) && !Array.isArray(expected) && actual >= expected;
    case 'lt':
      return actual !== undefined && !Array.isArray(actual) && !Array.isArray(expected) && actual < expected;
    case 'lte':
      return actual !== undefined && !Array.isArray(actual) && !Array.isArray(expected) && actual <= expected;
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'notContains':
      return !(typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected));
    case 'arrayContains':
      return Array.isArray(actual) && typeof expected === 'string' && actual.includes(expected);
    case 'arrayNotContains':
      return !(Array.isArray(actual) && typeof expected === 'string' && actual.includes(expected));
    default:
      return false;
  }
}

function matches(node: FilterNode | undefined, metadata: MemoryMetadata): boolean {
  if (!node) return true;
  if ('and' in node) return node.and.every((n) => matches(n, metadata));
  if ('or' in node) return node.or.some((n) => matches(n, metadata));
  return matchLeaf(metadata[node.field], node.operator, node.value);
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Test fake: namespace-isolated, idempotent by id, metadata filters, chunk-style lexical search. */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly namespaces = new Map<string, Map<string, StoredDoc>>();

  private ns(ns: string, create = false): Map<string, StoredDoc> | undefined {
    let docs = this.namespaces.get(ns);
    if (!docs && create) {
      docs = new Map();
      this.namespaces.set(ns, docs);
    }
    return docs;
  }

  async addDocuments(ns: string, docs: MemoryDoc[]): Promise<{ id: string; status: string }[]> {
    const store = this.ns(ns, true)!;
    return docs.map((d) => {
      store.set(d.id, {
        id: d.id,
        content: d.content,
        documentDate: d.documentDate,
        metadata: structuredClone(d.metadata),
      });
      return { id: d.id, status: 'done' };
    });
  }

  async getDocument(ns: string, id: string): Promise<{ id: string; content: string; metadata: MemoryMetadata } | null> {
    const d = this.ns(ns)?.get(id);
    return d ? { id: d.id, content: d.content, metadata: structuredClone(d.metadata) } : null;
  }

  async listDocuments(
    ns: string,
    q: { filter?: FilterNode; page: number; limit: number },
  ): Promise<{ documents: { id: string; metadata: MemoryMetadata }[]; hasMore: boolean }> {
    const all = [...(this.ns(ns)?.values() ?? [])].filter((d) => matches(q.filter, d.metadata));
    const start = (Math.max(q.page, 1) - 1) * q.limit;
    const slice = all.slice(start, start + q.limit);
    return {
      documents: slice.map((d) => ({ id: d.id, metadata: structuredClone(d.metadata) })),
      hasMore: start + q.limit < all.length,
    };
  }

  async search(ns: string, q: { query: string; limit: number; filter?: FilterNode }): Promise<{ id: string; content: string; score: number }[]> {
    const qt = new Set(tokens(q.query));
    if (qt.size === 0) return [];
    const hits: { id: string; content: string; score: number }[] = [];
    for (const d of this.ns(ns)?.values() ?? []) {
      if (!matches(q.filter, d.metadata)) continue;
      const dt = new Set(tokens(d.content));
      let overlap = 0;
      for (const t of qt) if (dt.has(t)) overlap++;
      if (overlap > 0) hits.push({ id: d.id, content: d.content, score: overlap / qt.size });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, q.limit);
  }

  async deleteDocuments(ns: string, ids: string[]): Promise<{ count: number; errors: { id: string; error: string }[] }> {
    const store = this.ns(ns);
    let count = 0;
    for (const id of ids) if (store?.delete(id)) count++;
    return { count, errors: [] };
  }

  async updateDocumentMetadata(ns: string, id: string, metadata: MemoryMetadata): Promise<void> {
    const d = this.ns(ns)?.get(id);
    if (!d) throw new Error(`document not found: ${id}`);
    d.metadata = structuredClone(metadata);
  }

  async deleteNamespace(ns: string): Promise<void> {
    this.namespaces.delete(ns);
  }

  async listMemories(_ns: string): Promise<{ id: string }[]> {
    return [];
  }
}
