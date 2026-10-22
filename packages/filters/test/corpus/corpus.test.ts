import { describe, expect, it } from 'vitest';
import { inspect } from '../../src/pipeline';
import { createHaikuClassifier, type ClassifierOutput, type ParseStructuredFn } from '../../src/classifier';
import { createRecordedClassifier } from '../../src/classifier/recorded';
import { FILTER_CATEGORY_KEYS, LOCKED_CATEGORIES, type FilterCategory, type InspectionResult } from '../../src/categories';
import { loadExpected, loadFixtures, loadRecorded, type ExpectedEntry } from './load';

const LIVE = process.env.CORPUS_LIVE === '1';

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

const fixtures = loadFixtures();
const expected = loadExpected(fixtures);
const liveClassifier = LIVE ? await buildLiveClassifier() : undefined;

const policy = { selectedCategories: [...FILTER_CATEGORY_KEYS], rules: [] };

const results = new Map<string, InspectionResult>();
for (const fx of fixtures) {
  const classifier =
    liveClassifier ?? createRecordedClassifier(loadRecorded(fx.key) as ClassifierOutput | undefined);
  results.set(fx.key, await inspect(fx.input, policy, { classifier }));
}

/** A value is recalled if the item is excluded or the value is absent from the text and every field. */
function recalled(result: InspectionResult, value: string): boolean {
  if (result.outcome === 'excluded') return true;
  const haystacks = [result.text ?? '', ...Object.values(result.fields ?? {})];
  return !haystacks.some((h) => h.includes(value));
}

const isLocked = (c: FilterCategory) => (LOCKED_CATEGORIES as readonly string[]).includes(c);
const positives = fixtures.filter((f) => (expected[f.key] ?? []).length > 0);
const pct = (n: number, d: number) => (d === 0 ? 100 : (n / d) * 100);

interface Tally { values: number; recalled: number }
const perCategory = new Map<FilterCategory, Tally>();
let lockedTotal = 0;
let lockedRecalled = 0;
let allTotal = 0;
let allRecalled = 0;
let itemsFullyRecalled = 0;
const missed: string[] = [];
const countMismatches: string[] = [];

for (const fx of positives) {
  const result = results.get(fx.key)!;
  let itemOk = true;
  for (const entry of expected[fx.key] as ExpectedEntry[]) {
    const tally = perCategory.get(entry.category) ?? { values: 0, recalled: 0 };
    for (const value of entry.values) {
      const ok = recalled(result, value);
      tally.values++;
      allTotal++;
      if (ok) {
        tally.recalled++;
        allRecalled++;
      } else {
        itemOk = false;
        missed.push(`${fx.key} [${entry.category}] ${JSON.stringify(value)}`);
      }
      if (isLocked(entry.category)) {
        lockedTotal++;
        if (ok) lockedRecalled++;
      }
    }
    perCategory.set(entry.category, tally);

    // Whole-item exclusions report one count with wholeItem:true, not one per planted value.
    const actual = result.counts.find((c) => c.category === entry.category);
    if (entry.wholeItem) {
      if (result.outcome !== 'excluded' || !result.counts.some((c) => c.wholeItem)) {
        countMismatches.push(`${fx.key} [${entry.category}] expected whole-item exclusion, got ${result.outcome}`);
      }
    } else if (result.outcome === 'excluded') {
      // Excluded as a whole where spans were expected: safe, but flagged.
      countMismatches.push(`${fx.key} [${entry.category}] expected ${entry.count} span(s), item excluded as ${result.counts[0]?.category}`);
    } else if (!actual || actual.redactedValues !== entry.count) {
      countMismatches.push(`${fx.key} [${entry.category}] expected ${entry.count}, got ${actual?.redactedValues ?? 0}`);
    }
  }
  if (itemOk) itemsFullyRecalled++;
}

const benign = fixtures.filter((f) => (expected[f.key] ?? []).length === 0);
const benignFlagged = benign.filter((f) => {
  const r = results.get(f.key)!;
  return r.outcome === 'excluded' || r.counts.length > 0;
});

describe('corpus', () => {
  it('reports recall, count mismatches and benign false positives', () => {
    const rows = [...perCategory.entries()].map(([category, t]) => ({
      category,
      values: t.values,
      recalled: t.recalled,
      recallPct: pct(t.recalled, t.values).toFixed(2),
    }));
    console.table(rows);
    console.log(
      `overall value recall ${pct(allRecalled, allTotal).toFixed(2)}% (${allRecalled}/${allTotal}); ` +
        `item recall ${pct(itemsFullyRecalled, positives.length).toFixed(2)}% (${itemsFullyRecalled}/${positives.length}); ` +
        `benign false positives ${pct(benignFlagged.length, benign.length).toFixed(2)}% (${benignFlagged.length}/${benign.length}, target <= 5%); ` +
        `count mismatches ${countMismatches.length}`,
    );
    if (countMismatches.length) console.log(`count mismatches:\n${countMismatches.join('\n')}`);
    if (benignFlagged.length) console.log(`benign flagged:\n${benignFlagged.map((f) => f.key).join('\n')}`);
    if (missed.length) console.log(`missed values:\n${missed.join('\n')}`);
    expect(true).toBe(true);
  });

  it('recalls 100% of values in the four locked categories (SC-005)', () => {
    expect(missed.filter((m) => LOCKED_CATEGORIES.some((c) => m.includes(`[${c}]`)))).toEqual([]);
    expect(lockedRecalled).toBe(lockedTotal);
  });

  it('recalls 100% of the overall excluded-value count (SC-005)', () => {
    // Whole-item exclusions count as recalled for all their planted values (see recalled()).
    expect(allTotal).toBeGreaterThan(0);
    expect(missed).toEqual([]);
    expect(allRecalled).toBe(allTotal);
  });

  it('excludes every whole-item locked-category item', () => {
    const wrong = positives.filter((fx) =>
      (expected[fx.key] as ExpectedEntry[]).some(
        (e) => e.wholeItem && isLocked(e.category) && results.get(fx.key)!.outcome !== 'excluded',
      ),
    );
    expect(wrong.map((f) => f.key)).toEqual([]);
  });

  it('reaches at least 99% item-level recall over positive items (SC-004)', () => {
    expect(pct(itemsFullyRecalled, positives.length)).toBeGreaterThanOrEqual(99);
  });

  it('produced a result for every fixture', () => {
    expect(results.size).toBe(fixtures.length);
    for (const fx of fixtures) {
      const r = results.get(fx.key);
      expect(r, fx.key).toBeDefined();
      expect(['accepted', 'excluded']).toContain(r!.outcome);
    }
  });
});
