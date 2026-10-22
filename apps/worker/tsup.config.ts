import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  noExternal: [/^@voicespark\//],
  // Keep every third-party (bare) specifier external; only workspace packages are inlined.
  external: [/^(?!@voicespark\/)[^./]/],
  sourcemap: true,
  clean: true,
});
