import { and, eq, sql } from 'drizzle-orm';
import {
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  hubSyncItem,
  withTransaction,
  type FilterCategory,
} from '@voicespark/db';
import { LOCKED_CATEGORIES, type LockedCategory } from '@voicespark/filters';
import { AppError, type ServiceContext } from '../errors';
import { logger } from '../logger';
import { enqueue, jobIds } from '../queues';
import { audit } from './audit';
import * as retroscans from './retroscans';

export interface FilterPreferencesView {
  selectedCategories: FilterCategory[];
  lockedCategories: LockedCategory[];
  confirmedAt: string | null;
  version: number;
  updatedAt: string | null;
}

const isCategory = (c: string): c is FilterCategory => (FILTER_CATEGORIES as readonly string[]).includes(c);

/** Catalog order, no duplicates. */
function inCatalogOrder(selected: Iterable<FilterCategory>): FilterCategory[] {
  const set = new Set(selected);
  return FILTER_CATEGORIES.filter((c) => set.has(c));
}

/**
 * Unknown key -> `validation_failed`; a missing locked key -> `category_locked` (FR-018, constitution I):
 * credential categories can never be deselected. Returns the selection deduplicated, in catalog order.
 */
export function validateSelection(selected: readonly string[]): FilterCategory[] {
  const unknown = selected.filter((c) => !isCategory(c));
  if (unknown.length > 0) {
    throw new AppError('validation_failed', 'Unknown filter category', { field: 'selectedCategories' });
  }
  const valid = selected as readonly FilterCategory[];
  const missing = LOCKED_CATEGORIES.filter((c) => !valid.includes(c));
  if (missing.length > 0) {
    throw new AppError('category_locked', 'Locked categories cannot be deselected', { missing });
  }
  return inCatalogOrder(valid);
}

/** `added`/`removed` between two selections, both in catalog order. */
export function diffSelection(
  before: readonly FilterCategory[],
  after: readonly FilterCategory[],
): { added: FilterCategory[]; removed: FilterCategory[] } {
  return {
    added: FILTER_CATEGORIES.filter((c) => after.includes(c) && !before.includes(c)),
    removed: FILTER_CATEGORIES.filter((c) => before.includes(c) && !after.includes(c)),
  };
}

/** Any record, note, file or thread of the Context Hub (`hub.refilter` has something to re-inspect). */
async function userHasHubData(userId: string): Promise<boolean> {
  const result = await getDb().execute<{ found: boolean }>(sql`
    select exists (select 1 from hub_person where user_id = ${userId})
        or exists (select 1 from hub_company where user_id = ${userId})
        or exists (select 1 from hub_project where user_id = ${userId})
        or exists (select 1 from hub_note where user_id = ${userId})
        or exists (select 1 from hub_file where user_id = ${userId})
        or exists (select 1 from hub_thread where user_id = ${userId}) as found`);
  return result.rows[0]?.found === true;
}

/** No row: all 10 selected, not confirmed, version 0. */
export async function get(ctx: ServiceContext): Promise<FilterPreferencesView> {
  const [row] = await getDb()
    .select()
    .from(filterPreferences)
    .where(eq(filterPreferences.userId, ctx.userId))
    .limit(1);
  if (!row) {
    return {
      selectedCategories: [...FILTER_CATEGORIES],
      lockedCategories: [...LOCKED_CATEGORIES],
      confirmedAt: null,
      version: 0,
      updatedAt: null,
    };
  }
  return {
    selectedCategories: inCatalogOrder(row.selectedCategories),
    lockedCategories: [...LOCKED_CATEGORIES],
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Saves the selection (FR-018, FR-061..064): `confirmed_at` is set on the first save and kept after, `version` grows by
 * one, audit `filter.preferences_changed {added, removed}`. Newly added categories get a retroscan offer when the user
 * already has content; unselecting never re-imports anything.
 */
export async function update(
  ctx: ServiceContext,
  selected: readonly string[],
): Promise<{ preferences: FilterPreferencesView; retroscanId: string | null }> {
  const next = validateSelection(selected);

  const { added, version } = await withTransaction(async (tx) => {
    const [prev] = await tx
      .select()
      .from(filterPreferences)
      .where(eq(filterPreferences.userId, ctx.userId))
      .for('update')
      .limit(1);
    const diff = diffSelection(prev ? prev.selectedCategories : FILTER_CATEGORIES, next);
    const now = new Date();
    const version = (prev?.version ?? 0) + 1;
    await tx
      .insert(filterPreferences)
      .values({ userId: ctx.userId, selectedCategories: next, confirmedAt: now, version: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: filterPreferences.userId,
        set: {
          selectedCategories: next,
          confirmedAt: prev?.confirmedAt ?? now,
          version,
          updatedAt: now,
        },
      });
    // Category keys only: never content (FR-064).
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'filter.preferences_changed',
        targetType: 'user',
        targetId: ctx.userId,
        metadata: diff,
      },
      tx,
    );
    // Fail-closed (constitution VI): with the new policy, every hub document was filtered under an older one. Held as
    // `refilter_pending` (never claimed by `hub.sync`) until `hub.refilter` re-inspects it; the version bump keeps an
    // in-flight `hub.sync` write from completing the row as `stored`. A lost enqueue below is recovered by the daily
    // `maintenance.hub-refilter-retry`, which selects users with `refilter_pending` rows.
    await tx
      .update(hubSyncItem)
      .set({
        version: sql`${hubSyncItem.version} + 1`,
        status: 'pending',
        attempts: 0,
        lastErrorCode: 'refilter_pending',
        updatedAt: sql`now()`,
      })
      .where(and(eq(hubSyncItem.userId, ctx.userId), eq(hubSyncItem.deleted, false)));
    return { ...diff, version };
  });

  // Hub data is re-inspected under the new policy (contracts/jobs.md (15)); one job per policy version. The rows are
  // already held, so a Redis failure only delays the refilter to the daily retry; the save still succeeds.
  if (await userHasHubData(ctx.userId)) {
    try {
      await enqueue(
        'hub.refilter',
        { userId: ctx.userId, policyVersion: version },
        { jobId: jobIds.hubRefilter(ctx.userId, version) },
      );
    } catch {
      logger.warn({ userId: ctx.userId, errorCode: 'hub_refilter_enqueue_failed' }, 'hub.refilter not enqueued; daily retry will');
    }
  }

  let retroscanId: string | null = null;
  if (added.length > 0 && (await retroscans.userHasContent(ctx.userId))) {
    ({ id: retroscanId } = await retroscans.create({
      userId: ctx.userId,
      trigger: 'categories_selected',
      categories: added,
    }));
  }
  return { preferences: await get(ctx), retroscanId };
}
