import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// The root .env is the single local env file (plan 1.6).
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const nextConfig: NextConfig = {
  // The E2E_PROD=1 e2e harness builds into its own directory (`.next-e2e`) so it never overwrites the `.next` that
  // `next dev`, `next typegen` or a local production build use (e2e/README.md).
  ...(process.env.VS_NEXT_DIST_DIR ? { distDir: process.env.VS_NEXT_DIST_DIR } : {}),
  transpilePackages: [
    '@voicespark/core',
    '@voicespark/db',
    '@voicespark/filters',
    '@voicespark/integrations',
  ],
  serverExternalPackages: ['pg', 'bullmq', 'ioredis', 'pino'],
  typedRoutes: false,
  experimental: {
    // Body limit for multipart uploads (26 MB). Replaces the deprecated
    // `middlewareClientMaxBodySize`. Upload routes sit outside the proxy
    // matcher, so they also check `content-length` themselves.
    proxyClientMaxBodySize: '26mb',
  },
};

export default nextConfig;
