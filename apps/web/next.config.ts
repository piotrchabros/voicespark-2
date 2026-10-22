import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// The root .env is the single local env file (plan 1.6).
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const nextConfig: NextConfig = {
  transpilePackages: [
    '@voicespark/core',
    '@voicespark/db',
    '@voicespark/filters',
    '@voicespark/integrations',
  ],
  serverExternalPackages: ['pg', 'bullmq', 'ioredis', 'pino'],
  typedRoutes: false,
};

export default nextConfig;
