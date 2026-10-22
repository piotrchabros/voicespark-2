import { FILTER_CATEGORIES as CATEGORY_DEFS } from '@voicespark/filters';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// The catalog from contracts/filter-categories.md; detector handling stays internal.
export const GET = handle(async () => {
  await requireUser();
  return CATEGORY_DEFS.map(({ key, label, description, locked, defaultSelected }) => ({
    key,
    label,
    description,
    locked,
    defaultSelected,
  }));
});
