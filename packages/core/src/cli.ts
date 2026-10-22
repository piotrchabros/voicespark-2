#!/usr/bin/env -S npx tsx
import { eq } from 'drizzle-orm';
import { closeDb, user, withTransaction } from '@voicespark/db';
import { toErrorCode } from './error-code';
import { audit } from './services/audit';

const USAGE = 'usage: voicespark-cli admin:grant --email <email>';

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Promotes an existing user to admin. The only way to create the first admin (no env var involved, FR-037). */
async function grantAdmin(email: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const [found] = await tx
      .update(user)
      .set({ role: 'admin', updatedAt: new Date() })
      .where(eq(user.email, email.trim().toLowerCase()))
      .returning({ id: user.id });
    if (!found) return false;
    await audit.record(
      { actorType: 'system', action: 'user.role_granted', targetType: 'user', targetId: found.id },
      tx,
    );
    return true;
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'admin:grant') {
    console.error(USAGE);
    return 2;
  }
  const email = readFlag(rest, '--email');
  if (!email) {
    console.error(USAGE);
    return 2;
  }
  if (!(await grantAdmin(email))) {
    console.error('no user with that email exists; sign in once first, then retry');
    return 1;
  }
  console.log('admin role granted');
  return 0;
}

main(process.argv.slice(2))
  .catch((err: unknown) => {
    console.error('command failed', toErrorCode(err));
    return 1;
  })
  .then(async (code) => {
    await closeDb().catch(() => undefined);
    process.exitCode = code;
  });
