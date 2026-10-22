import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

let pool: Pool | undefined;
let db: Db | undefined;

// Lazy: nothing connects (or reads env) at import time.
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString });
  }
  return pool;
}

export function getDb(): Db {
  db ??= drizzle(getPool(), { schema });
  return db;
}

export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  db = undefined;
  await current?.end();
}
