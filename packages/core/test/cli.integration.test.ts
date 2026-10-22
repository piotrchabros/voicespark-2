import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogEntry, closeDb, getDb, user } from '@voicespark/db';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const EMAIL = 'cli-test-admin@voicespark.test';

function cli(args: string[]): Promise<{ code: number; stderr: string }> {
  return run('npx', ['tsx', CLI, ...args], { env: process.env }).then(
    () => ({ code: 0, stderr: '' }),
    (err: { code?: number; stderr?: string }) => ({ code: err.code ?? 1, stderr: err.stderr ?? '' }),
  );
}

describe('cli admin:grant', { timeout: 60_000 }, () => {
  let userId: string;

  beforeAll(async () => {
    const db = getDb();
    await db.delete(user).where(eq(user.email, EMAIL));
    const [row] = await db.insert(user).values({ name: 'Cli Test', email: EMAIL }).returning({ id: user.id });
    userId = row!.id;
  });

  afterAll(async () => {
    await getDb().delete(auditLogEntry).where(eq(auditLogEntry.targetId, userId));
    await getDb().delete(user).where(eq(user.email, EMAIL));
    await closeDb();
  });

  it('exits non-zero when the user does not exist', async () => {
    const res = await cli(['admin:grant', '--email', 'nobody@voicespark.test']);
    expect(res.code).not.toBe(0);
  });

  it('exits non-zero without --email', async () => {
    expect((await cli(['admin:grant'])).code).not.toBe(0);
  });

  it('grants the admin role and writes a system audit entry', async () => {
    const res = await cli(['admin:grant', '--email', EMAIL]);
    expect(res.code).toBe(0);

    const [row] = await getDb().select({ role: user.role }).from(user).where(eq(user.id, userId));
    expect(row?.role).toBe('admin');

    const entries = await getDb().select().from(auditLogEntry).where(eq(auditLogEntry.targetId, userId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'user.role_granted', actorType: 'system', targetType: 'user' });
  });
});
