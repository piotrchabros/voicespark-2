/**
 * Node.js-only startup check: validate the environment once when the server starts, so `next start` refuses to boot
 * with an invalid or unsafe production configuration (assertProductionSafety) instead of failing on the first request.
 * Next only logs an error thrown from register() and keeps serving, so the process exits explicitly.
 * Skipped during `next build` (NEXT_PHASE=phase-production-build): the build does not need runtime secrets.
 * The error message lists missing variable names only, so writing it to stderr is safe.
 */
import { assertProductionSafety, loadEnv } from '@voicespark/core';

if (process.env.NEXT_PHASE !== 'phase-production-build') {
  try {
    assertProductionSafety(loadEnv());
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : 'Invalid environment'}\n`);
    process.exit(1);
  }
}
