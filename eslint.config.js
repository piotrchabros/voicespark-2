// Flat ESLint config. The admin import ban below is the lint half of the admin content-isolation
// guard (constitution III, research R13); the typecheck half is the SafeLogFields typing of
// logger.* (T026), which rejects content-bearing objects.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Test-only memory-store bridge (D-E1): application source must never import it. Repeated in the admin block
// below because a later `no-restricted-imports` entry replaces earlier options instead of merging them.
const TEST_ONLY_IMPORTS = {
  group: ['@voicespark/integrations/testing', '@voicespark/integrations/testing/*'],
  message: 'Test-only module: never import it from application source (D-E1)',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/.next',
      '**/coverage',
      'packages/db/drizzle/**',
      '**/playwright-report',
      '**/test-results',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/e2e/**', '**/playwright.config.ts'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: [
      'apps/*/src/**/*.{ts,tsx}',
      'apps/web/app/**/*.{ts,tsx}',
      'apps/web/lib/**/*.{ts,tsx}',
      'apps/web/components/**/*.{ts,tsx}',
      'packages/*/src/**/*.{ts,tsx}',
    ],
    ignores: ['packages/integrations/src/testing/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [TEST_ONLY_IMPORTS] }],
    },
  },
  {
    files: [
      'apps/web/app/api/admin/**',
      'apps/web/app/(admin)/**',
      'apps/web/components/admin/**',
      'packages/core/src/services/admin-users.ts',
      'packages/core/src/services/admin-system.ts',
      'packages/db/src/repos/admin/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@voicespark/db/repos/user',
                '@voicespark/db/repos/user/*',
                '@voicespark/integrations/supermemory',
                '@voicespark/integrations/supermemory/*',
                '@voicespark/core/crypto',
                '@voicespark/core/crypto/*',
                '../crypto',
                '../crypto/*',
                // Content services: admin code reads metadata through repos/admin only.
                '@voicespark/core/services/profiles',
                '@voicespark/core/services/uploads',
                '@voicespark/core/services/content-items',
                '@voicespark/core/services/drafts',
                '@voicespark/core/services/mail-access',
                '@voicespark/core/services/inspection',
                '@voicespark/core/services/sources',
                '@voicespark/core/services/deletion',
                '@voicespark/core/services/own-prompts',
                '@voicespark/core/services/hub',
                '@voicespark/core/services/hub/*',
                '@voicespark/core/hub/*',
                './profiles',
                './uploads',
                './content-items',
                './drafts',
                './mail-access',
                './inspection',
                './sources',
                './deletion',
                './own-prompts',
                './hub',
                './hub/*',
                '../hub/*',
                '**/services/hub/**',
                '../user/*',
                '**/repos/user/**',
                '@voicespark/db/repos/user/own-prompts',
                '@voicespark/db/repos/user/hub*',
              ],
              message: 'Admin code must not touch content (constitution III, research R13)',
            },
            TEST_ONLY_IMPORTS,
          ],
        },
      ],
    },
  },
  {
    // Hub extraction input is inspected in hub mode only by the extraction service (research R6, R9).
    files: ['apps/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
    ignores: ['packages/core/src/services/hub/extraction*.ts', 'packages/filters/src/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportSpecifier[imported.name='inspectForHubExtraction'], ExportSpecifier[local.name='inspectForHubExtraction']",
          message: 'inspectForHubExtraction may only be used by packages/core/src/services/hub/extraction*.ts (R6, R9)',
        },
      ],
    },
  },
);
