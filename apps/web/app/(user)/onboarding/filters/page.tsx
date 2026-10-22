import { FILTER_CATEGORIES as CATEGORY_DEFS } from '@voicespark/filters';
import * as filterPreferences from '@voicespark/core/services/filter-preferences';
import { OnboardingChecklist, type CategoryDef } from '@/components/filters/category-checklist';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * Only same-origin relative paths are followed (no open redirect): a single leading '/', no '//' or '/\'
 * protocol-relative forms, no backslashes or control characters. Anything else falls back to the dashboard.
 */
function safeReturnTo(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dashboard';
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/dashboard';
  try {
    const url = new URL(value, 'http://localhost');
    if (url.origin !== 'http://localhost') return '/dashboard';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/dashboard';
  }
}

export default async function OnboardingFiltersPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const ctx = await requireUserOrRedirect();
  const [prefs, params] = await Promise.all([filterPreferences.get(ctx), searchParams]);
  const categories: CategoryDef[] = CATEGORY_DEFS.map(
    ({ key, label, description, locked, defaultSelected }) => ({
      key,
      label,
      description,
      locked,
      defaultSelected,
    }),
  );
  // Before the first confirmation the catalog defaults apply (credentials locked on, the rest on by default).
  const initialSelected =
    prefs.confirmedAt === null
      ? categories.filter((c) => c.defaultSelected).map((c) => c.key)
      : prefs.selectedCategories;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Choose what to keep out</h1>
        <p className="text-muted-foreground text-sm">
          Before your first import, choose which kinds of sensitive content are removed before
          anything is stored. Checked categories are excluded. You can change this later under
          Filters.
        </p>
      </div>
      <OnboardingChecklist
        categories={categories}
        initialSelected={initialSelected}
        returnTo={safeReturnTo(params.returnTo)}
      />
    </div>
  );
}
