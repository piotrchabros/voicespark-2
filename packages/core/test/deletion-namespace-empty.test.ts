import { describe, expect, it } from 'vitest';
import type { MemoryStore } from '@voicespark/integrations/supermemory';
import { namespaceEmpty } from '@voicespark/core/services/deletion';

function storeThrowing(err: unknown): MemoryStore {
  return {
    listDocuments: async () => {
      throw err;
    },
  } as unknown as MemoryStore;
}

function named(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('x'), { name }, extra);
}

describe('namespaceEmpty', () => {
  it('is true for an empty listing and false for a non-empty one', async () => {
    const mk = (n: number) =>
      ({
        listDocuments: async () => ({ documents: new Array(n).fill({}) }),
      }) as unknown as MemoryStore;
    expect(await namespaceEmpty(mk(0), 'ns')).toBe(true);
    expect(await namespaceEmpty(mk(1), 'ns')).toBe(false);
  });

  it('treats a not-found HTTP error as empty', async () => {
    expect(
      await namespaceEmpty(storeThrowing(named('MemoryStoreHttpError', { status: 404 })), 'ns'),
    ).toBe(true);
    expect(
      await namespaceEmpty(
        storeThrowing(named('MemoryStoreHttpError', { code: 'supermemory_not_found' })),
        'ns',
      ),
    ).toBe(true);
  });

  it('rethrows auth, other HTTP and generic errors', async () => {
    for (const err of [
      named('MemoryStoreAuthError'),
      named('MemoryStoreHttpError', { status: 500 }),
      named('Error', { status: 404 }),
      new Error('foreign document'),
    ]) {
      await expect(namespaceEmpty(storeThrowing(err), 'ns')).rejects.toBe(err);
    }
  });
});
