import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHaikuClassifier, type ClassifierOutput, type ParseStructuredFn } from '../../src/classifier';
import { createRecordedClassifier } from '../../src/classifier/recorded';
import { FILTER_CATEGORY_KEYS, LOCKED_CATEGORIES, type InspectionInput } from '../../src/categories';
import { inspectForHubExtraction } from '../../src/hub';
import { OWN_ADDRESSES, parseEml } from './load';

const LIVE = process.env.CORPUS_LIVE === '1';
const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'hub');
const GROUPS = ['keep', 'locked', 'optional', 'hard_negative'] as const;

interface HubExpected {
  category: string;
  values: string[];
}

async function buildLiveClassifier() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  const sdk = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const parseStructured: ParseStructuredFn = async (args) => {
    const message = await sdk.beta.messages.parse({
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: [{ role: 'user', content: args.user }],
      output_config: { effort: args.effort, format: betaZodOutputFormat(args.schema as never) },
    } as never);
    const parsed = (message as { parsed_output?: unknown }).parsed_output;
    if (parsed == null) throw new Error('LLM response did not contain structured output');
    return parsed as never;
  };
  return createHaikuClassifier({ parseStructured, model: process.env.LLM_CLASSIFIER_MODEL ?? 'claude-haiku-5-5' });
}

interface HubFixture {
  key: string;
  group: (typeof GROUPS)[number];
  input: InspectionInput;
}

function loadHubFixtures(): HubFixture[] {
  const out: HubFixture[] = [];
  for (const group of GROUPS) {
    for (const file of readdirSync(join(HUB_DIR, 'fixtures', group)).sort()) {
      const raw = readFileSync(join(HUB_DIR, 'fixtures', group, file), 'utf8');
      const input: InspectionInput = file.endsWith('.eml')
        ? parseEml(raw)
        : { kind: 'note', bodyText: raw, headers: {}, folders: [], ownAddresses: OWN_ADDRESSES };
      out.push({ key: `${group}/${file}`, group, input });
    }
  }
  return out;
}

function loadHubRecorded(key: string): ClassifierOutput | undefined {
  const path = join(HUB_DIR, 'recorded', key.replace(/\.(eml|txt)$/, '.json'));
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ClassifierOutput) : undefined;
}

const fixtures = loadHubFixtures();
const expected = JSON.parse(readFileSync(join(HUB_DIR, 'expected.json'), 'utf8')) as Record<string, HubExpected[]>;
{
  const keys = new Set(fixtures.map((f) => f.key));
  const missing = fixtures.filter((f) => !(f.key in expected)).map((f) => f.key);
  const orphan = Object.keys(expected).filter((k) => !keys.has(k));
  if (missing.length || orphan.length) {
    throw new Error(`hub expected.json mismatch: fixtures without entry [${missing}], entries without fixture [${orphan}]`);
  }
}

const liveClassifier = LIVE ? await buildLiveClassifier() : undefined;
const policy = { selectedCategories: [...FILTER_CATEGORY_KEYS], rules: [] };

type Result = Awaited<ReturnType<typeof inspectForHubExtraction>>;
const results = new Map<string, Result>();
for (const fx of fixtures) {
  const classifier = liveClassifier ?? createRecordedClassifier(loadHubRecorded(fx.key));
  results.set(fx.key, await inspectForHubExtraction(fx.input, policy, { classifier }));
}

/** Recalled if the item is excluded or the value is absent from the hub text. */
const recalled = (r: Result, value: string): boolean => r.excluded || !r.text.includes(value);
/** Survives only in an accepted item whose text still holds the value. */
const survives = (r: Result, value: string): boolean => !r.excluded && r.text.includes(value);

const pct = (n: number, d: number) => (d === 0 ? 100 : (n / d) * 100);
const isLocked = (c: string) => (LOCKED_CATEGORIES as readonly string[]).includes(c);
const inGroup = (g: string) => fixtures.filter((f) => f.group === g);

const lockedMissed: string[] = [];
let lockedTotal = 0;
const itemFail: string[] = [];
const recallItems = [...inGroup('locked'), ...inGroup('optional')];
for (const fx of recallItems) {
  const r = results.get(fx.key)!;
  let ok = true;
  for (const e of expected[fx.key]!) {
    for (const v of e.values) {
      if (isLocked(e.category)) lockedTotal++;
      if (!recalled(r, v)) {
        ok = false;
        if (isLocked(e.category)) lockedMissed.push(`${fx.key} [${e.category}] ${JSON.stringify(v)}`);
      }
    }
  }
  if (!ok) itemFail.push(fx.key);
}

const keepMissed: string[] = [];
let keepTotal = 0;
for (const fx of inGroup('keep')) {
  for (const e of expected[fx.key]!) {
    for (const v of e.values) {
      keepTotal++;
      if (!survives(results.get(fx.key)!, v)) keepMissed.push(`${fx.key} ${JSON.stringify(v)}`);
    }
  }
}

const hardNegatives = inGroup('hard_negative');
const hardNegativeBad = hardNegatives.filter((fx) => {
  const r = results.get(fx.key)!;
  return r.excluded || r.redactedValues > 0 || expected[fx.key]!.some((e) => e.values.some((v) => !survives(r, v)));
});

describe('hub corpus', () => {
  it('has the required fixture volume (FR-028)', () => {
    expect(inGroup('keep').length).toBeGreaterThanOrEqual(40);
    expect(inGroup('locked').length).toBeGreaterThanOrEqual(30);
    expect(inGroup('optional').length).toBeGreaterThan(0);
    expect(hardNegatives.length).toBeGreaterThan(0);
    expect(results.size).toBe(fixtures.length);
  });

  it('reports recall, survival and hard-negative precision', () => {
    console.log(
      `hub locked value recall ${pct(lockedTotal - lockedMissed.length, lockedTotal).toFixed(2)}% (${lockedTotal - lockedMissed.length}/${lockedTotal}); ` +
        `locked+optional item recall ${pct(recallItems.length - itemFail.length, recallItems.length).toFixed(2)}% (${recallItems.length - itemFail.length}/${recallItems.length}); ` +
        `keep contact survival ${pct(keepTotal - keepMissed.length, keepTotal).toFixed(2)}% (${keepTotal - keepMissed.length}/${keepTotal}); ` +
        `hard negatives harmed ${hardNegativeBad.length}/${hardNegatives.length} (reported only)`,
    );
    if (lockedMissed.length) console.log(`hub locked missed:\n${lockedMissed.join('\n')}`);
    if (keepMissed.length) console.log(`hub keep lost:\n${keepMissed.join('\n')}`);
    if (hardNegativeBad.length) console.log(`hub hard negatives flagged:\n${hardNegativeBad.map((f) => f.key).join('\n')}`);
    expect(true).toBe(true);
  });

  it('recalls 100% of values in the four locked categories in hub mode', () => {
    expect(lockedTotal).toBeGreaterThan(0);
    expect(lockedMissed).toEqual([]);
  });

  it('reaches at least 99% item-level recall over locked and optional items', () => {
    expect(pct(recallItems.length - itemFail.length, recallItems.length)).toBeGreaterThanOrEqual(99);
  });

  it('keeps 100% of emails and phones in the keep items', () => {
    expect(keepTotal).toBeGreaterThan(0);
    expect(keepMissed).toEqual([]);
  });
});
