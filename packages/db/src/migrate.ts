import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from './client';

async function main(): Promise<void> {
  await migrate(getDb(), {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  });
}

main()
  .then(() => closeDb())
  .then(() => {
    console.log('migrations applied');
  })
  .catch(async (err: unknown) => {
    console.error('migration failed', err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
