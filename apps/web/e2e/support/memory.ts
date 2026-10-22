import { expect } from '@playwright/test';
import { namespaceFor, RemoteMemoryStore, type MemoryMetadata } from '@voicespark/integrations/supermemory';
import { E2E_ENV } from './env';

export interface ScannedDoc {
  id: string;
  content: string;
  metadata: MemoryMetadata;
}

/** The one in-memory store web, worker and specs share through the bridge global setup hosts (D-E1). */
export function memory(): RemoteMemoryStore {
  return new RemoteMemoryStore(E2E_ENV.TEST_MEMORY_STORE_URL!);
}

/** Every document (with content) in the user's namespace. */
export async function scanNamespace(userId: string): Promise<ScannedDoc[]> {
  const store = memory();
  const ns = namespaceFor(userId);
  const docs: ScannedDoc[] = [];
  for (let page = 1; ; page++) {
    const res = await store.listDocuments(ns, { page, limit: 100 });
    for (const { id } of res.documents) {
      const doc = await store.getDocument(ns, id);
      if (doc) docs.push(doc);
    }
    if (!res.hasMore) return docs;
  }
}

export async function expectNamespaceEmpty(userId: string): Promise<void> {
  const docs = await scanNamespace(userId);
  expect(docs.map((d) => d.id)).toEqual([]);
}
