import Link from 'next/link';
import { counts } from '@voicespark/core/services/hub/records';
import { count as pendingSuggestions } from '@voicespark/core/services/hub/suggestions';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function HubPage() {
  const ctx = await requireUserOrRedirect();
  // The suggestions number is the badge count (FR-024): the same query, so every pending number agrees.
  const [{ people, companies, projects }, { pending: suggestions }] = await Promise.all([counts(ctx), pendingSuggestions(ctx)]);
  const cards = [
    { href: '/hub/people', label: 'People', count: people },
    { href: '/hub/companies', label: 'Companies', count: companies },
    { href: '/hub/projects', label: 'Projects', count: projects },
    { href: '/hub/suggestions', label: 'Suggestions', count: suggestions },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Context Hub</h1>
        <p className="text-muted-foreground text-sm">
          The people, companies and projects behind your writing, with the notes and files that
          give your drafts context.
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <li key={c.href}>
            <Link href={c.href} className="hover:bg-accent block rounded-lg border p-4">
              <p className="text-muted-foreground text-sm">{c.label}</p>
              <p className="text-2xl font-semibold">{c.count}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
