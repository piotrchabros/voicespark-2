import Link from 'next/link';
import { FILTER_CATEGORIES as CATEGORY_DEFS } from '@voicespark/filters';
import * as filterPreferences from '@voicespark/core/services/filter-preferences';
import { FilterSettingsChecklist, type CategoryDef } from '@/components/filters/category-checklist';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function FiltersPage() {
  const ctx = await requireUserOrRedirect();
  const prefs = await filterPreferences.get(ctx);
  const categories: CategoryDef[] = CATEGORY_DEFS.map(
    ({ key, label, description, locked, defaultSelected }) => ({
      key,
      label,
      description,
      locked,
      defaultSelected,
    }),
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Filters</h1>
        <p className="text-muted-foreground text-sm">
          Checked categories are removed before anything is stored. Changes apply to future imports
          and ongoing syncing only; content excluded earlier is never re-imported. When you add a
          category we can scan what is already stored and offer to remove matching items.
        </p>
        <p className="text-sm">
          <Link href="/exclusion-rules" className="underline">
            Manage exclusion rules
          </Link>{' '}
          for specific senders, domains, folders or keywords.
        </p>
      </div>
      <FilterSettingsChecklist categories={categories} initialSelected={prefs.selectedCategories} />
    </div>
  );
}
