import { eq } from 'drizzle-orm';
import { getDb, user } from '@voicespark/db';
import * as filterPreferences from '@voicespark/core/services/filter-preferences';
import { requireUser } from '../../../lib/guards';
import { AppError, handle } from '../../../lib/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const ctx = await requireUser();
  const [row] = await getDb()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, ctx.userId))
    .limit(1);
  if (!row) throw new AppError('unauthenticated');
  const prefs = await filterPreferences.get(ctx);
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    filtersConfirmed: prefs.confirmedAt !== null,
  };
});
