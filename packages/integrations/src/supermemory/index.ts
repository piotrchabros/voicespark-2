import { InMemoryMemoryStore } from './in-memory';
import { SupermemoryAdapter } from './adapter';
import { RemoteMemoryStore } from './remote';
import type { MemoryStore } from './port';

export * from './port';
export * from './in-memory';
export * from './adapter';
export * from './remote';

let inMemorySingleton: InMemoryMemoryStore | undefined;

/**
 * InMemory only in test / AUTH_TEST_MODE (shared singleton, or the cross-process test bridge when
 * TEST_MEMORY_STORE_URL is set); otherwise a missing key fails startup.
 */
export function createMemoryStore(env: {
  NODE_ENV: string;
  AUTH_TEST_MODE?: boolean;
  SUPERMEMORY_API_KEY?: string;
  SUPERMEMORY_BASE_URL?: string;
  TEST_MEMORY_STORE_URL?: string;
}): MemoryStore {
  if (env.NODE_ENV === 'test' || env.AUTH_TEST_MODE) {
    return env.TEST_MEMORY_STORE_URL
      ? new RemoteMemoryStore(env.TEST_MEMORY_STORE_URL)
      : (inMemorySingleton ??= new InMemoryMemoryStore());
  }
  if (!env.SUPERMEMORY_API_KEY) {
    throw new Error('SUPERMEMORY_API_KEY is required outside test mode (set AUTH_TEST_MODE=1 or NODE_ENV=test to use the in-memory store)');
  }
  return new SupermemoryAdapter({ apiKey: env.SUPERMEMORY_API_KEY, baseURL: env.SUPERMEMORY_BASE_URL });
}
