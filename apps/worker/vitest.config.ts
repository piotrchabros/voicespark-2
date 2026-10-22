import { defineConfig } from 'vitest/config';

// Vitest 3 only honours `fileParallelism` at the root level (not per project). Integration and
// admin-isolation suites share one Postgres DB and mutate global rows, so run their files serially
// when those projects are selected; unit projects keep the default parallelism.
const serialDb = process.argv.some((a) => /integration|admin-isolation/.test(a));

export default defineConfig({
  test: {
    fileParallelism: !serialDb,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [
            '**/*.integration.test.ts',
            '**/*.load.test.ts',
            'test/corpus/**',
            'test/admin-isolation/**',
            'e2e/**',
            '**/node_modules/**',
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
          name: 'import-load',
          include: ['test/**/*.load.test.ts'],
        },
      },
    ],
  },
});
