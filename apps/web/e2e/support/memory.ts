import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from '@playwright/test';
import {
  InMemoryMemoryStore,
  META,
  namespaceFor,
  RemoteMemoryStore,
  type MemoryDoc,
  type MemoryMetadata,
} from '@voicespark/integrations/supermemory';
import { E2E_ENV } from './env';

export interface ScannedDoc {
  id: string;
  /** `vs_kind`: a content kind, or `hub_person`, `hub_note`, ... for context hub documents (`hub_` ids). */
  kind: string | null;
  content: string;
  metadata: MemoryMetadata;
}

/** The one in-memory store web, worker and specs share through the bridge global setup hosts (D-E1). */
export function memory(): RemoteMemoryStore {
  return new RemoteMemoryStore(E2E_ENV.TEST_MEMORY_STORE_URL!);
}

/** Every document (with content) in the user's namespace, content items and context hub documents alike. */
export async function scanNamespace(userId: string): Promise<ScannedDoc[]> {
  const store = memory();
  const ns = namespaceFor(userId);
  const docs: ScannedDoc[] = [];
  for (let page = 1; ; page++) {
    const res = await store.listDocuments(ns, { page, limit: 100 });
    for (const { id } of res.documents) {
      const doc = await store.getDocument(ns, id);
      if (!doc) continue;
      const kind = doc.metadata[META.kind];
      docs.push({ ...doc, kind: typeof kind === 'string' ? kind : null });
    }
    if (!res.hasMore || res.documents.length === 0) return docs;
  }
}

export async function expectNamespaceEmpty(userId: string): Promise<void> {
  const docs = await scanNamespace(userId);
  expect(docs.map((d) => d.id)).toEqual([]);
}

// Failing store (quickstart "Memory store sync", US7.2 and the rejected-item edge). Global setup serves a
// `FailableMemoryStore`; specs switch it through a flag file, since setup and specs run in different processes.
// Failures are scoped to namespaces or document ids, so other specs' users are never affected.

const FAIL_FILE = join(tmpdir(), 'vs-e2e', 'memory-fail.json');

interface FailFlags {
  namespaces: string[];
  docIds: string[];
}

function readFlags(): FailFlags {
  if (!existsSync(FAIL_FILE)) return { namespaces: [], docIds: [] };
  try {
    const f = JSON.parse(readFileSync(FAIL_FILE, 'utf8')) as Partial<FailFlags>;
    return { namespaces: f.namespaces ?? [], docIds: f.docIds ?? [] };
  } catch {
    return { namespaces: [], docIds: [] };
  }
}

function writeFlags(f: FailFlags): void {
  mkdirSync(dirname(FAIL_FILE), { recursive: true });
  writeFileSync(FAIL_FILE, JSON.stringify(f));
}

/** Every write and delete in the user's namespace fails until `restoreMemoryStore`. */
export function failMemoryStoreFor(userId: string): void {
  const f = readFlags();
  writeFlags({ ...f, namespaces: [...new Set([...f.namespaces, namespaceFor(userId)])] });
}

/** The store rejects these documents (`hub_note_<id>`, ...) until `restoreMemoryStore`. */
export function rejectMemoryDocs(docIds: string[]): void {
  const f = readFlags();
  writeFlags({ ...f, docIds: [...new Set([...f.docIds, ...docIds])] });
}

export function restoreMemoryStore(): void {
  rmSync(FAIL_FILE, { force: true });
}

/** The bridge's store in global setup: an InMemoryMemoryStore that obeys the flag file. Test-only. */
export class FailableMemoryStore extends InMemoryMemoryStore {
  private check(ns: string, ids: string[]): void {
    const f = readFlags();
    if (f.namespaces.includes(ns)) throw new Error('e2e: memory store is down');
    if (ids.some((id) => f.docIds.includes(id))) throw new Error('e2e: memory store rejected the document');
  }

  override async addDocuments(ns: string, docs: MemoryDoc[]): Promise<{ id: string; status: string }[]> {
    this.check(ns, docs.map((d) => d.id));
    return super.addDocuments(ns, docs);
  }

  override async deleteDocuments(
    ns: string,
    ids: string[],
  ): Promise<{ count: number; errors: { id: string; error: string }[] }> {
    this.check(ns, ids);
    return super.deleteDocuments(ns, ids);
  }
}
