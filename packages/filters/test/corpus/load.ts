import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FilterCategory, InspectionInput } from '../../src/categories';

export const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(CORPUS_DIR, 'fixtures');
export const RECORDED_DIR = join(CORPUS_DIR, 'recorded');
export const OWN_ADDRESSES = ['me@voicespark.test'];

export interface ExpectedEntry {
  category: FilterCategory;
  count: number;
  wholeItem: boolean;
  values: string[];
}
export type ExpectedMap = Record<string, ExpectedEntry[]>;

export interface Fixture {
  /** Path relative to fixtures/, e.g. `otp_codes/001.eml`. */
  key: string;
  /** Directory name, e.g. `otp_codes` or `benign`. */
  group: string;
  input: InspectionInput;
}

/** Parses the simple RFC 822 fixtures: headers, blank line, body. To/Cc are deliberately not passed on. */
export function parseEml(raw: string): InspectionInput {
  const text = raw.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 2);
  const headers: Record<string, string> = {};
  let last = '';
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] = `${headers[last]} ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    last = line.slice(0, idx).trim().toLowerCase();
    headers[last] = line.slice(idx + 1).trim();
  }
  const from = headers['from'];
  const subject = headers['subject'];
  const folders = (headers['x-folders'] ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  return {
    kind: 'email',
    ...(subject !== undefined ? { subject } : {}),
    bodyText: body,
    headers: from !== undefined ? { from } : {},
    folders,
    ownAddresses: OWN_ADDRESSES,
  };
}

export function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const group of readdirSync(FIXTURES_DIR).sort()) {
    for (const file of readdirSync(join(FIXTURES_DIR, group)).sort()) {
      const raw = readFileSync(join(FIXTURES_DIR, group, file), 'utf8');
      const input: InspectionInput = file.endsWith('.eml')
        ? parseEml(raw)
        : { kind: 'note', bodyText: raw, headers: {}, folders: [], ownAddresses: OWN_ADDRESSES };
      out.push({ key: `${group}/${file}`, group, input });
    }
  }
  return out;
}

/** Loads expected.json and fails when fixtures and entries do not match one to one. */
export function loadExpected(fixtures: readonly Fixture[]): ExpectedMap {
  const expected = JSON.parse(readFileSync(join(CORPUS_DIR, 'expected.json'), 'utf8')) as ExpectedMap;
  const keys = new Set(fixtures.map((f) => f.key));
  const missing = fixtures.filter((f) => !(f.key in expected)).map((f) => f.key);
  const orphan = Object.keys(expected).filter((k) => !keys.has(k));
  if (missing.length || orphan.length) {
    throw new Error(`expected.json mismatch: fixtures without entry [${missing.join(', ')}], entries without fixture [${orphan.join(', ')}]`);
  }
  return expected;
}

/** Recorded classifier output for a fixture, if one exists (`recorded/<key without ext>.json`). */
export function loadRecorded(key: string): unknown | undefined {
  const path = join(RECORDED_DIR, key.replace(/\.(eml|txt)$/, '.json'));
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}
