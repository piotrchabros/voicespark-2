import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/*.load.test.ts', 'test/corpus/**', 'test/admin-isolation/**', 'e2e/**'],
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
          name: 'corpus',
          // Hub first, so a hub-mode failure shows before the normal run reports.
          include: ['test/corpus/hub-corpus.test.ts', 'test/corpus/corpus.test.ts'],
          testTimeout: 600000,
        },
      },
    ],
  },
});
