import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Success-criterion timings (plan section 7): each measurement is attached to the test as an annotation and appended
// to test-results/sc-timings.json (a JSON array) for the quickstart validation record.

export interface ScTiming {
  name: string;
  sc: string;
  ms: number;
  limitMs: number;
  at: string;
}

export const SC_TIMINGS_FILE = fileURLToPath(new URL('../../test-results/sc-timings.json', import.meta.url));

function record(entry: ScTiming): void {
  mkdirSync(dirname(SC_TIMINGS_FILE), { recursive: true });
  // workers: 1, so the read-modify-write cannot race.
  const all: ScTiming[] = existsSync(SC_TIMINGS_FILE)
    ? (JSON.parse(readFileSync(SC_TIMINGS_FILE, 'utf8')) as ScTiming[])
    : [];
  all.push(entry);
  writeFileSync(SC_TIMINGS_FILE, `${JSON.stringify(all, null, 2)}\n`);
}

/**
 * Runs `fn`, records its duration against success criterion `sc` and asserts it stays under `limitMs`. With
 * `{ gate: false }` the timing is still recorded but not asserted (the caller annotates why).
 */
export async function measure<T>(
  name: string,
  sc: string,
  limitMs: number,
  fn: () => Promise<T>,
  { gate = true }: { gate?: boolean } = {},
): Promise<T> {
  const started = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - started);
  test.info().annotations.push({ type: `timing:${sc}`, description: `${name}: ${ms} ms (limit ${limitMs} ms)` });
  record({ name, sc, ms, limitMs, at: new Date().toISOString() });
  if (gate) expect(ms, `${sc} ${name}`).toBeLessThan(limitMs);
  return result;
}
