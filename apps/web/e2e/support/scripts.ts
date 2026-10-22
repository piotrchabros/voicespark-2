import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '@voicespark/db/client';
import { E2E_ENV } from './env';

// Back doors for things with no HTTP surface (D-E3, D-E4), always against the e2e database. `runCore` evaluates a
// small TypeScript snippet with tsx inside apps/worker (so `@voicespark/*` resolve) under E2E_ENV; plain row updates
// go straight through `sql`.

const WORKER_DIR = fileURLToPath(new URL('../../../worker/', import.meta.url));
const RESULT_MARKER = '__E2E_RESULT__';

/**
 * Runs `script` as the body of an async function with `args` in scope (use `await import('@voicespark/...')`);
 * resolves with its JSON-serializable return value.
 */
export async function runCore<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
  const program = `
const args = JSON.parse(process.env.E2E_SCRIPT_ARGS ?? '[]');
(async () => { ${script}\n })().then(
  (r) => process.stdout.write('\\n${RESULT_MARKER}' + JSON.stringify(r ?? null) + '\\n', () => process.exit(0)),
  (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); },
);`;
  const child = spawn(join(WORKER_DIR, 'node_modules/.bin/tsx'), ['-e', program], {
    cwd: WORKER_DIR,
    env: { ...process.env, ...E2E_ENV, E2E_SCRIPT_ARGS: JSON.stringify(args) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARKER));
  if (code !== 0 || line === undefined) throw new Error(`runCore failed (exit ${code}): ${stderr.trim()}`);
  return JSON.parse(line.slice(RESULT_MARKER.length)) as T;
}

/** Parameterized query against the e2e database (DATABASE_URL comes from E2E_ENV via playwright.config.ts). */
export async function sql<R extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  return (await getPool().query<R>(text, params)).rows;
}

/** Simulated token revocation at the provider (D-E3): the worker's MailAuthError path. */
export async function markNeedsReconnection(sourceId: string, errorCode = 'invalid_grant'): Promise<void> {
  await runCore(
    `const { markNeedsReconnection } = await import('@voicespark/core/services/sources');
     await markNeedsReconnection(args[0], args[1]);`,
    [sourceId, errorCode],
  );
}

/** Demotes every active admin except `keepUserId` (D-E4); returns their ids for `restoreAdmins`. */
export async function demoteOtherAdmins(keepUserId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>(
    `UPDATE "user" SET role = 'user', updated_at = now() WHERE role = 'admin' AND id <> $1 RETURNING id`,
    [keepUserId],
  );
  return rows.map((r) => r.id);
}

export async function restoreAdmins(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql(`UPDATE "user" SET role = 'admin', updated_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
}

export async function setUserStatus(email: string, status: 'active' | 'suspended'): Promise<void> {
  await sql(
    `UPDATE "user" SET status = $2::user_status, suspended_at = CASE WHEN $3::boolean THEN now() END,
     updated_at = now() WHERE email = $1`,
    [email.trim().toLowerCase(), status, status === 'suspended'],
  );
}
