import { Badge } from '@/components/ui/badge';
import { IgnoreParticipantActions } from './ignore-rules';
import { formatDay, plural, threadAnchor, type HubSourceParticipant, type HubSourceThread } from './labels';

// Conversation summaries of a record (US3; FR-019): subject, dates, participants, the short summary and the provider
// "open original" link. Never a message body: the server sends only the stored, filtered thread metadata.

function participantLabel(p: HubSourceParticipant): string {
  if (p.owner) return p.name ? `${p.name} (you)` : `${p.address} (you)`;
  return p.name ? `${p.name} <${p.address}>` : p.address;
}

function dateRange(t: HubSourceThread): string {
  const first = formatDay(t.firstMessageAt);
  const last = formatDay(t.lastMessageAt);
  return first === last ? first : `${first} to ${last}`;
}

export function SummariesPanel({ items }: { items: HubSourceThread[] }) {
  return (
    <section aria-labelledby="hub-summaries-heading" className="flex flex-col gap-3">
      <h2 id="hub-summaries-heading" className="text-lg font-semibold">
        Conversations
      </h2>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No conversation from email yet.</p>
      ) : (
        <ul aria-label="Conversation summaries" className="flex flex-col gap-3">
          {items.map((t) => {
            const subject = t.subject || 'Untitled conversation';
            return (
              <li key={t.threadId}>
                <article
                  id={threadAnchor(t.threadId)}
                  aria-label={subject}
                  data-thread-id={t.threadId}
                  className="flex flex-col gap-2 rounded-lg border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{subject}</h3>
                    <span className="text-muted-foreground text-xs">
                      {dateRange(t)}. {plural(t.messageCount, 'message')}.
                    </span>
                  </div>
                  {t.summary ? <p className="text-sm">{t.summary}</p> : null}
                  <div className="flex flex-col gap-1">
                    <span className="text-muted-foreground text-xs">Participants</span>
                    <ul aria-label={`Participants of ${subject}`} className="flex flex-col gap-1 text-sm">
                      {t.participants.map((p) => (
                        <li key={p.address} className="flex flex-wrap items-center gap-2">
                          <span className="break-all">{participantLabel(p)}</span>
                          {p.owner ? null : <IgnoreParticipantActions address={p.address} />}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="secondary">From email</Badge>
                    {t.openUrl ? (
                      <a href={t.openUrl} target="_blank" rel="noopener noreferrer" className="underline">
                        Open original
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-xs">Open the original in your mail app.</span>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
