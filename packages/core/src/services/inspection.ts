import { eq, isNotNull, and, asc } from 'drizzle-orm';
import {
  connectedSource,
  exclusionRule,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  user,
  type DbOrTx,
} from '@voicespark/db';
import {
  createHaikuClassifier,
  inspect,
  LOCKED_CATEGORIES,
  type Classifier,
  type InspectionInput,
  type InspectionResult,
  type Policy,
} from '@voicespark/filters';
import { createFakeLlm, createLlm } from '@voicespark/integrations/anthropic';
import { loadEnv } from '../env';

let classifier: Classifier | undefined;

/**
 * The Haiku classifier (contracts/filter-categories.md). Under NODE_ENV=test / AUTH_TEST_MODE a fake answers
 * "nothing sensitive", so the deterministic detectors still run. Built lazily on first use.
 */
export function getClassifier(): Classifier {
  if (!classifier) {
    const env = loadEnv();
    const fakeLlm = createFakeLlm(() => ({ spans: [], mostlySensitive: false }));
    classifier = createHaikuClassifier({
      parseStructured: createLlm(env, fakeLlm).parseStructured,
      model: env.LLM_CLASSIFIER_MODEL,
    });
  }
  return classifier;
}

/** The user's policy: saved categories (defaults when no row) plus exclusion rules. Locked keys are always present. */
export async function loadPolicy(
  userId: string,
  db: DbOrTx = getDb(),
): Promise<{ policy: Policy; version: number }> {
  const [prefs] = await db
    .select({ selected: filterPreferences.selectedCategories, version: filterPreferences.version })
    .from(filterPreferences)
    .where(eq(filterPreferences.userId, userId))
    .limit(1);
  const rules = await db
    .select({ id: exclusionRule.id, type: exclusionRule.type, value: exclusionRule.value })
    .from(exclusionRule)
    .where(eq(exclusionRule.userId, userId))
    .orderBy(asc(exclusionRule.createdAt), asc(exclusionRule.id));
  const selected = new Set<string>(prefs ? prefs.selected : FILTER_CATEGORIES);
  for (const c of LOCKED_CATEGORIES) selected.add(c);
  return {
    policy: { selectedCategories: FILTER_CATEGORIES.filter((c) => selected.has(c)), rules },
    version: prefs?.version ?? 0,
  };
}

/** The user's own addresses (account email + connected mailbox addresses), lowercased and unique. */
export async function loadOwnAddresses(userId: string, db: DbOrTx = getDb()): Promise<string[]> {
  const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  const sources = await db
    .select({ address: connectedSource.accountAddress })
    .from(connectedSource)
    .where(and(eq(connectedSource.userId, userId), isNotNull(connectedSource.accountAddress)));
  const addresses = [owner?.email, ...sources.map((s) => s.address)]
    .filter((a): a is string => !!a)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  return [...new Set(addresses)];
}

/**
 * Inspects one item under the user's current policy. Fails closed: any error while loading the policy, the own
 * addresses or the classifier excludes the item as `inspection_failed` (FR-023); `inspect()` itself also fails closed.
 */
export async function inspectForUser(
  userId: string,
  input: Omit<InspectionInput, 'ownAddresses'>,
  opts: { policy?: Policy; ownAddresses?: string[]; classifier?: Classifier; db?: DbOrTx } = {},
): Promise<InspectionResult> {
  try {
    const policy = opts.policy ?? (await loadPolicy(userId, opts.db)).policy;
    const ownAddresses = opts.ownAddresses ?? (await loadOwnAddresses(userId, opts.db));
    return await inspect({ ...input, ownAddresses }, policy, { classifier: opts.classifier ?? getClassifier() });
  } catch {
    // Error details are dropped deliberately: they may echo document content.
    return {
      outcome: 'excluded',
      counts: [{ category: 'inspection_failed', redactedValues: 0, wholeItem: true }],
    };
  }
}
