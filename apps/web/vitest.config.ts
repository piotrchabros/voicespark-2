import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest 3 only honours `fileParallelism` at the root level (not per project). Integration and
// admin-isolation suites share one Postgres DB and mutate global rows, so run their files serially
// when those projects are selected; unit projects keep the default parallelism.
const serialDb = process.argv.some((a) => /integration|admin-isolation/.test(a));

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    fileParallelism: !serialDb,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          // Backstop for CPU-contended hosts: route modules pull large import graphs (Next, Better
          // Auth, db) that can take several seconds to load under load; 5s defaults flake.
          testTimeout: 20_000,
          hookTimeout: 20_000,
          exclude: [
            '**/node_modules/**',
            '**/*.integration.test.ts',
            '**/*.load.test.ts',
            'test/corpus/**',
            'test/admin-isolation/**',
            'e2e/**',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'admin-isolation',
          include: ['test/admin-isolation/**/*.test.ts'],
        },
      },
    ],
  },
});
