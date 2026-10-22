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
    ],
  },
});
