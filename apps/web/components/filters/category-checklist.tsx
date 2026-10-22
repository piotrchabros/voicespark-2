'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RetroscanDialog } from '@/components/retroscan-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export interface CategoryDef {
  key: string;
  label: string;
  description: string;
  locked: boolean;
  defaultSelected: boolean;
}

export interface SavedPreferences {
  preferences: unknown;
  retroscanId: string | null;
}

const LOCKED_NOTE = 'Credentials are always excluded';
const LOCKED_EXPLANATION =
  'Credentials (passwords, one-time codes, reset links, API keys) are always excluded and cannot be turned off.';

export function CategoryChecklist({
  categories,
  initialSelected,
  submitLabel,
  onSaved,
}: {
  categories: CategoryDef[];
  initialSelected: string[];
  submitLabel: string;
  onSaved: (r: SavedPreferences) => void;
}) {
  // Locked categories are always part of the selection (FR-018, constitution I), whatever the stored row says.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set([...initialSelected, ...categories.filter((c) => c.locked).map((c) => c.key)]),
  );
  const [explained, setExplained] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(c: CategoryDef, checked: boolean) {
    if (c.locked) {
      setExplained(c.key);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(c.key);
      else next.delete(c.key);
      return next;
    });
  }

  async function save() {
    setPending(true);
    setError(null);
    try {
      const selectedCategories = categories
        .filter((c) => c.locked || selected.has(c.key))
        .map((c) => c.key);
      const res = await fetch('/api/filter-preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedCategories }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        setError(
          body?.error?.code === 'category_locked'
            ? LOCKED_EXPLANATION
            : 'Could not save your filters. Please try again.',
        );
        return;
      }
      onSaved((await res.json()) as SavedPreferences);
    } catch {
      setError('Could not save your filters. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {categories.map((c) => {
          const id = `category-${c.key}`;
          const checked = c.locked || selected.has(c.key);
          return (
            <li
              key={c.key}
              className="flex gap-3 rounded-lg border p-3 sm:p-4"
              onClick={c.locked ? () => setExplained(c.key) : undefined}
            >
              <Checkbox
                id={id}
                className="mt-0.5 disabled:pointer-events-none"
                checked={checked}
                disabled={c.locked}
                aria-describedby={`${id}-description`}
                onCheckedChange={(v) => toggle(c, v === true)}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor={id} className="leading-snug">
                    {c.label}
                  </Label>
                  {c.locked ? <Badge variant="secondary">{LOCKED_NOTE}</Badge> : null}
                </div>
                <p id={`${id}-description`} className="text-muted-foreground text-sm">
                  {c.description}
                </p>
                {c.locked && explained === c.key ? (
                  <p role="status" className="text-sm font-medium">
                    {LOCKED_EXPLANATION}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        className="w-full sm:w-auto sm:self-start"
        disabled={pending}
        onClick={() => void save()}
      >
        {pending ? 'Saving...' : submitLabel}
      </Button>
    </div>
  );
}

/** First-import onboarding (T100): confirm, then continue to the already sanitized `returnTo` path. */
export function OnboardingChecklist({
  categories,
  initialSelected,
  returnTo,
}: {
  categories: CategoryDef[];
  initialSelected: string[];
  returnTo: string;
}) {
  const router = useRouter();
  return (
    <CategoryChecklist
      categories={categories}
      initialSelected={initialSelected}
      submitLabel="Confirm and continue"
      onSaved={() => {
        router.push(returnTo);
        router.refresh();
      }}
    />
  );
}

/** Filter settings (T101): save, then offer a retroscan when the server started one. */
export function FilterSettingsChecklist({
  categories,
  initialSelected,
}: {
  categories: CategoryDef[];
  initialSelected: string[];
}) {
  const router = useRouter();
  const [retroscanId, setRetroscanId] = useState<string | null>(null);
  return (
    <>
      <CategoryChecklist
        categories={categories}
        initialSelected={initialSelected}
        submitLabel="Save filters"
        onSaved={(r) => {
          toast.success('Filters saved.');
          setRetroscanId(r.retroscanId);
          router.refresh();
        }}
      />
      <RetroscanDialog retroscanId={retroscanId} onClose={() => setRetroscanId(null)} />
    </>
  );
}
