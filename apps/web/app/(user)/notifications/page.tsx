import Link from 'next/link';
import { redirect } from 'next/navigation';
import * as notifications from '@voicespark/core/services/notifications';
import { AppError } from '@voicespark/core/errors';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { MarkReadButton } from '@/components/notifications/mark-read-button';
import { requireUser } from '@/lib/guards';

type Payload = Record<string, string | number | boolean | null>;

function describe(type: string, payload: Payload): { text: string; href?: string } {
  switch (type) {
    case 'source_needs_reconnection':
      return {
        text: 'A connected mailbox needs to be reconnected before it can be imported again.',
        ...(typeof payload.sourceId === 'string' ? { href: `/sources/${payload.sourceId}` } : {}),
      };
    case 'import_completed': {
      const count = typeof payload.itemsImported === 'number' ? payload.itemsImported : null;
      return { text: count === null ? 'Import completed.' : `Import completed: ${count} items imported.` };
    }
    case 'deletion_completed':
      return { text: 'Your deletion request has completed.' };
    case 'profile_ready':
      return { text: 'Your voice profile is ready.' };
    case 'profile_outdated':
      return { text: 'Your voice profile is out of date.' };
    case 'draft_ready':
      return { text: 'Your draft is ready.' };
    case 'draft_failed':
      return { text: 'Draft generation failed.' };
    case 'generation_failed':
      return { text: 'Generation failed.' };
    default:
      return { text: 'Notification' };
  }
}

export default async function NotificationsPage() {
  let userId: string;
  try {
    userId = (await requireUser()).userId;
  } catch (err) {
    if (err instanceof AppError && err.code === 'unauthenticated') redirect('/sign-in');
    if (err instanceof AppError && err.code === 'account_suspended') redirect('/sign-in?error=account_suspended');
    throw err;
  }
  const { items } = await notifications.list(userId, { limit: 50 });

  return (
    <main className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Notifications</h1>
      {items.length === 0 ? (
        <p className="text-muted-foreground">No notifications yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => {
            const { text, href } = describe(n.type, n.payload as Payload);
            const unread = n.readAt === null;
            return (
              <li key={n.id}>
                <Card className={unread ? 'border-primary' : 'opacity-70'}>
                  <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        {unread ? <Badge>Unread</Badge> : null}
                        <time className="text-xs text-muted-foreground" dateTime={n.createdAt.toISOString()}>
                          {n.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                        </time>
                      </div>
                      <p className={unread ? 'font-medium' : ''}>{text}</p>
                      {href ? (
                        <Link href={href} className="text-sm underline">
                          Go to source
                        </Link>
                      ) : null}
                    </div>
                    {unread ? <MarkReadButton notificationId={n.id} /> : null}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
