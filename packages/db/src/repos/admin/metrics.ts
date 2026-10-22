import { and, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../../client';
import { DRAFT_CONTENT_TYPES, draft, profileVersion, type DraftContentType } from '../../schema';
import type { RatingCounts, RatingsMetrics } from './types';

function counts(rated: number, soundsLikeMe: number): RatingCounts {
  return { rated, soundsLikeMe, share: rated > 0 ? soundsLikeMe / rated : null };
}

/**
 * Rating aggregates (FR-043, FR-045, research R13): for profiles, the latest rated version of each
 * profile whose rating falls in range, grouped by rating; for drafts, every rated draft in range.
 * Drafts are read through rating metadata only (draft.rating, rated_at, content_type): constitution III.
 */
export async function ratings(range: { from?: Date; to?: Date }): Promise<RatingsMetrics> {
  const conditions = [sql`${profileVersion.rating} is not null`];
  if (range.from) conditions.push(gte(profileVersion.ratedAt, range.from));
  if (range.to) conditions.push(lte(profileVersion.ratedAt, range.to));

  const latest = getDb()
    .selectDistinctOn([profileVersion.profileId], {
      rating: profileVersion.rating,
    })
    .from(profileVersion)
    .where(and(...conditions))
    .orderBy(profileVersion.profileId, sql`${profileVersion.ratedAt} desc`)
    .as('latest_rated');

  const rows = await getDb()
    .select({ rating: latest.rating, n: sql<number>`count(*)::int` })
    .from(latest)
    .groupBy(latest.rating);

  const draftConditions = [sql`${draft.rating} is not null`];
  if (range.from) draftConditions.push(gte(draft.ratedAt, range.from));
  if (range.to) draftConditions.push(lte(draft.ratedAt, range.to));
  const draftRows = await getDb()
    .select({
      contentType: draft.contentType,
      rated: sql<number>`count(*)::int`,
      soundsLikeMe: sql<number>`count(*) filter (where ${draft.rating} = 'sounds_like_me')::int`,
    })
    .from(draft)
    .where(and(...draftConditions))
    .groupBy(draft.contentType);
  const byContentType = {} as Record<DraftContentType, RatingCounts>;
  let draftsRated = 0;
  let draftsLiked = 0;
  for (const type of DRAFT_CONTENT_TYPES) {
    const r = draftRows.find((x) => x.contentType === type);
    byContentType[type] = counts(r?.rated ?? 0, r?.soundsLikeMe ?? 0);
    draftsRated += r?.rated ?? 0;
    draftsLiked += r?.soundsLikeMe ?? 0;
  }

  const n = (r: string) => rows.find((x) => x.rating === r)?.n ?? 0;
  const soundsLikeMe = n('sounds_like_me');
  return {
    profiles: counts(soundsLikeMe + n('not_like_me'), soundsLikeMe),
    drafts: { ...counts(draftsRated, draftsLiked), byContentType },
  };
}
