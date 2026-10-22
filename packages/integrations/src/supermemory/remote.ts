import type { FilterNode, MemoryDoc, MemoryMetadata, MemoryStore } from './port';

/** Methods the test-only RPC bridge forwards (every `MemoryStore` method). */
export const MEMORY_RPC_METHODS = [
  'addDocuments',
  'getDocument',
  'listDocuments',
  'search',
  'deleteDocuments',
  'updateDocumentMetadata',
  'deleteNamespace',
  'listMemories',
] as const satisfies readonly (keyof MemoryStore)[];

export type MemoryRpcMethod = (typeof MEMORY_RPC_METHODS)[number];

/**
 * Test-only client for the memory-store bridge (`startMemoryRpcServer` in '@voicespark/integrations/testing'), so
 * web, worker and e2e specs share one in-memory store across processes. Selected only via TEST_MEMORY_STORE_URL in
 * test / AUTH_TEST_MODE (production refuses the variable). `addDocuments` still takes branded `FilteredText`, so
 * nothing unfiltered can be sent (constitution Principle I). JSON over `POST {baseUrl}/rpc`; no retries.
 */
export class RemoteMemoryStore implements MemoryStore {
  private readonly endpoint: string;

  constructor(baseUrl: string) {
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/rpc`;
  }

  private async call<T>(method: MemoryRpcMethod, args: unknown[]): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) {
      throw new Error(`memory store rpc ${method} failed: ${body?.error ?? `HTTP ${res.status}`}`);
    }
    return body.result as T;
  }

  addDocuments(ns: string, docs: MemoryDoc[]): Promise<{ id: string; status: string }[]> {
    return this.call('addDocuments', [ns, docs]);
  }

  getDocument(ns: string, id: string): Promise<{ id: string; content: string; metadata: MemoryMetadata } | null> {
    return this.call('getDocument', [ns, id]);
  }

  listDocuments(
    ns: string,
    q: { filter?: FilterNode; page: number; limit: number },
  ): Promise<{ documents: { id: string; metadata: MemoryMetadata }[]; hasMore: boolean }> {
    return this.call('listDocuments', [ns, q]);
  }

  search(ns: string, q: { query: string; limit: number; filter?: FilterNode }): Promise<{ id: string; content: string; score: number }[]> {
    return this.call('search', [ns, q]);
  }

  deleteDocuments(ns: string, ids: string[]): Promise<{ count: number; errors: { id: string; error: string }[] }> {
    return this.call('deleteDocuments', [ns, ids]);
  }

  async updateDocumentMetadata(ns: string, id: string, metadata: MemoryMetadata): Promise<void> {
    await this.call('updateDocumentMetadata', [ns, id, metadata]);
  }

  async deleteNamespace(ns: string): Promise<void> {
    await this.call('deleteNamespace', [ns]);
  }

  listMemories(ns: string): Promise<{ id: string }[]> {
    return this.call('listMemories', [ns]);
  }
}
