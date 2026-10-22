/**
 * Next.js startup hook. Kept tiny and runtime-neutral because Next also compiles this file for the edge runtime;
 * the Node-only startup validation lives in ./instrumentation-node.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
