import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptBinary, encryptBinary } from '../crypto/aead';
import { getKeyring } from '../crypto/keyring';
import { loadEnv } from '../env';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUFFIX = '.bin';

/** Hub file blobs (FR-009): encrypted with purpose `hub-files`, never sent to the AI service or memory store. */
export interface BlobStore {
  /** Returns the keyring kid used, stored in `hub_file.key_id`. */
  put(userId: string, storageKey: string, bytes: Uint8Array): Promise<{ keyId: string }>;
  get(userId: string, storageKey: string): Promise<Uint8Array>;
  delete(userId: string, storageKey: string): Promise<void>;
  listUser(userId: string): Promise<string[]>;
  deleteUser(userId: string): Promise<void>;
}

/** A blob store failure with a code safe to log. */
export class BlobStoreError extends Error {
  constructor(readonly code: 'blob_missing' | 'invalid_id') {
    super(code);
    this.name = 'BlobStoreError';
  }
}

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) throw new BlobStoreError('invalid_id');
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Blobs live at `{dir}/{userId}/{storageKey}.bin`; ids must be UUIDs, so no path can escape `dir`. */
export function createFsBlobStore(dir: string = loadEnv().HUB_FILES_DIR): BlobStore {
  const userDir = (userId: string): string => {
    assertUuid(userId);
    return join(dir, userId.toLowerCase());
  };
  const blobPath = (userId: string, storageKey: string): string => {
    const base = userDir(userId);
    assertUuid(storageKey);
    return join(base, `${storageKey.toLowerCase()}${SUFFIX}`);
  };

  return {
    async put(userId, storageKey, bytes) {
      const path = blobPath(userId, storageKey);
      const keyId = getKeyring().activeKeyId;
      const data = encryptBinary('hub-files', bytes);
      await mkdir(userDir(userId), { recursive: true, mode: 0o700 });
      // Write then rename so a reader never sees a partial blob.
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, data, { mode: 0o600 });
        await rename(tmp, path);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      return { keyId };
    },

    async get(userId, storageKey) {
      const path = blobPath(userId, storageKey);
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (e) {
        if (isNotFound(e)) throw new BlobStoreError('blob_missing');
        throw e;
      }
      return decryptBinary('hub-files', data);
    },

    async delete(userId, storageKey) {
      await rm(blobPath(userId, storageKey), { force: true });
    },

    async listUser(userId) {
      let names: string[];
      try {
        names = await readdir(userDir(userId));
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
      return names
        .filter((n) => n.endsWith(SUFFIX))
        .map((n) => n.slice(0, -SUFFIX.length))
        .filter((k) => UUID_RE.test(k));
    },

    async deleteUser(userId) {
      await rm(userDir(userId), { recursive: true, force: true });
    },
  };
}
