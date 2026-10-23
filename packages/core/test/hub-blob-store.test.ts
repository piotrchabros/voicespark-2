import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBinaryKeyId, resetKeyringForTests } from '../src/crypto';
import { resetEnvForTests } from '../src/env';
import { BlobStoreError, createFsBlobStore, type BlobStore } from '../src/hub/blob-store';

let dir: string;
let store: BlobStore;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= 'x'.repeat(32);
  process.env.DEDUP_HMAC_KEY ??= 'test-dedup-key';
  process.env.ENCRYPTION_KEYRING = JSON.stringify({ k1: randomBytes(32).toString('base64') });
  process.env.ENCRYPTION_ACTIVE_KEY_ID = 'k1';
  resetEnvForTests();
  resetKeyringForTests();
  dir = await mkdtemp(join(tmpdir(), 'hub-blob-'));
  store = createFsBlobStore(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fs blob store', () => {
  it('stores encrypted bytes at {dir}/{userId}/{storageKey}.bin and returns the kid', async () => {
    const userId = randomUUID();
    const key = randomUUID();
    const plain = Buffer.from('quarterly plan: confidential numbers', 'utf8');
    const { keyId } = await store.put(userId, key, plain);
    expect(keyId).toBe('k1');
    const onDisk = await readFile(join(dir, userId, `${key}.bin`));
    expect(onDisk.equals(plain)).toBe(false);
    expect(onDisk.includes(plain)).toBe(false);
    expect(readBinaryKeyId(onDisk)).toBe('k1');
    expect(Buffer.from(await store.get(userId, key)).equals(plain)).toBe(true);
  });

  it('throws a typed blob_missing error for a missing key', async () => {
    const err = await store.get(randomUUID(), randomUUID()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect((err as BlobStoreError).code).toBe('blob_missing');
  });

  it('rejects a userId or storageKey that is not a UUID', async () => {
    const ok = randomUUID();
    for (const bad of ['../etc', '..', 'a/b', `${ok}/../x`, '', 'not-a-uuid']) {
      await expect(store.put(bad, ok, Buffer.from('x'))).rejects.toBeInstanceOf(BlobStoreError);
      await expect(store.put(ok, bad, Buffer.from('x'))).rejects.toBeInstanceOf(BlobStoreError);
      await expect(store.get(ok, bad)).rejects.toBeInstanceOf(BlobStoreError);
      await expect(store.delete(bad, ok)).rejects.toBeInstanceOf(BlobStoreError);
      await expect(store.listUser(bad)).rejects.toBeInstanceOf(BlobStoreError);
      await expect(store.deleteUser(bad)).rejects.toBeInstanceOf(BlobStoreError);
    }
    expect(await readdir(dir)).not.toContain('etc');
  });

  it('deletes one blob idempotently', async () => {
    const userId = randomUUID();
    const key = randomUUID();
    await store.put(userId, key, Buffer.from('x'));
    await store.delete(userId, key);
    await store.delete(userId, key);
    expect(existsSync(join(dir, userId, `${key}.bin`))).toBe(false);
  });

  it('lists storage keys only', async () => {
    const userId = randomUUID();
    const keys = [randomUUID(), randomUUID()];
    for (const k of keys) await store.put(userId, k, randomBytes(10));
    expect((await store.listUser(userId)).sort()).toEqual([...keys].sort());
    expect(await store.listUser(randomUUID())).toEqual([]);
  });

  it('deleteUser removes the directory and is idempotent', async () => {
    const userId = randomUUID();
    const other = randomUUID();
    await store.put(userId, randomUUID(), Buffer.from('a'));
    await store.put(other, randomUUID(), Buffer.from('b'));
    await store.deleteUser(userId);
    expect(existsSync(join(dir, userId))).toBe(false);
    await store.deleteUser(userId);
    expect(await store.listUser(other)).toHaveLength(1);
  });
});
