import { z } from 'zod';
import * as filterPreferences from '@voicespark/core/services/filter-preferences';
import { handle, parseJson } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Keys are validated by the service: unknown -> validation_failed, a missing locked key -> category_locked.
const bodySchema = z.object({ selectedCategories: z.array(z.string()).max(50) });

export const GET = handle(async () => {
  const user = await requireUser();
  return filterPreferences.get(user);
});

export const PUT = handle(async (req: Request) => {
  const user = await requireUser();
  const { selectedCategories } = await parseJson(req, bodySchema);
  return filterPreferences.update(user, selectedCategories);
});
