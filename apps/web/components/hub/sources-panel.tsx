import { FIELD_LABELS, formatDay, threadAnchor, type HubLinkItem, type HubSourceSupport, type HubSourceThread } from './labels';

// Where a record's email-derived data came from (US3; FR-018, SC-008): for every field, address, domain and link
// that an email supports, the conversations it came from. Each entry points at the summary in the summaries panel.

interface SourceGroup {
  key: string;
  label: string;
  threads: HubSourceThread[];
}

function supportKey(s: HubSourceSupport): string {
  if ('field' in s) return `field:${s.field}`;
  if ('email' in s) return `email:${s.email}`;
  if ('domain' in s) return `domain:${s.domain}`;
  return `link:${s.link}`;
}

function supportLabel(s: HubSourceSupport, links: HubLinkItem[]): string {
  if ('field' in s) return FIELD_LABELS[s.field] ?? s.field;
  if ('email' in s) return `Email ${s.email}`;
  if ('domain' in s) return `Domain ${s.domain}`;
  const link = links.find((l) => l.link.id === s.link);
  return link ? `Link to ${link.other.name}` : 'Link';
}

/** Groups in first-seen order (items arrive newest conversation first). */
function groupBySupport(items: HubSourceThread[], links: HubLinkItem[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const t of items) {
    for (const s of t.supports) {
      const key = supportKey(s);
      const g = groups.get(key) ?? { key, label: supportLabel(s, links), threads: [] };
      if (!g.threads.includes(t)) g.threads.push(t);
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}

export function SourcesPanel({ items, links }: { items: HubSourceThread[]; links: HubLinkItem[] }) {
  const groups = groupBySupport(items, links);
  if (groups.length === 0) return null;
  return (
    <section aria-labelledby="hub-sources-heading" className="flex flex-col gap-3">
      <h2 id="hub-sources-heading" className="text-lg font-semibold">
        Where this came from
      </h2>
      <dl aria-label="Sources of email-derived data" className="grid gap-3 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.key} className="rounded-md border p-3" data-support={g.key}>
            <dt className="text-muted-foreground text-sm">{g.label}</dt>
            <dd>
              <ul className="flex flex-col gap-1 text-sm">
                {g.threads.map((t) => (
                  <li key={t.threadId}>
                    <a href={`#${threadAnchor(t.threadId)}`} className="underline">
                      {t.subject || 'Untitled conversation'}
                    </a>
                    <span className="text-muted-foreground text-xs"> {formatDay(t.lastMessageAt)}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
