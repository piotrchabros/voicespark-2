import Link from 'next/link';
import { redirect } from 'next/navigation';
import * as notifications from '@voicespark/core/services/notifications';
import * as profiles from '@voicespark/core/services/profiles';
import { AppError } from '@voicespark/core/errors';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { MarkReadButton } from '@/components/notifications/mark-read-button';
import { requireUser } from '@/lib/guards';

type Payload = Record<string, string | number | boolean | null>;

type DefinitionInfo = { profileId: string; name: string };

const GENERATION_FAILED_MESSAGES: Record<string, string> = {
  invalid_output: 'Generation failed: the result was not valid.',
  analysis_prompt_excluded: 'Generation failed: your analysis prompt was rejected. Edit it or use the default.',
  analysis_prompt_missing: 'Generation failed: no analysis prompt was available.',
  inspection_failed: 'Generation failed: the result could not be checked.',
  output_excluded: 'Generation failed: the result was rejected.',
  feedback_excluded: 'Generation failed: your feedback was rejected.',
  llm_refused: 'Generation failed: the model declined the request.',
};

function describe(
  type: string,
  payload: Payload,
  definitionsById: Map<string, DefinitionInfo>,
): { text: string; href?: string } {
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
      return {
        text:
          (typeof payload.errorCode === 'string' ? GENERATION_FAILED_MESSAGES[payload.errorCode] : undefined) ??
          'Generation failed.',
      };
    case 'analysis_prompt_default_changed': {
      const def =
        typeof payload.definitionId === 'string' ? definitionsById.get(payload.definitionId) : undefined;
      const text = `The default analysis prompt for ${def?.name ?? 'a voice profile'} changed.`;
      if (
        !def ||
        typeof payload.fromDefinitionVersionId !== 'string' ||
        typeof payload.toDefinitionVersionId !== 'string'
      ) {
        return { text, href: '/profiles' };
      }
      const qs = new URLSearchParams({
        from: payload.fromDefinitionVersionId,
        to: payload.toDefinitionVersionId,
      });
      return { text, href: `/profiles/${def.profileId}/analysis-prompt?${qs.toString()}` };
    }
    case 'hub_refilter_pending':
      return {
        text: 'Some Context Hub items could not be checked against your new filter settings. They are kept in the app and will be copied to memory again once they are checked.',
        href: '/hub',
      };
    default:
      return { text: 'Notification' };
  }
}

export default async function NotificationsPage() {
  let ctx: Awaited<ReturnType<typeof requireUser>>;
  try {
    ctx = await requireUser();
  } catch (err) {
    if (err instanceof AppError && err.code === 'unauthenticated') redirect('/sign-in');
    if (err instanceof AppError && err.code === 'account_suspended') redirect('/sign-in?error=account_suspended');
    throw err;
  }
  const [{ items }, profileList] = await Promise.all([
    notifications.list(ctx.userId, { limit: 50 }),
    profiles.list(ctx),
  ]);
  const definitionsById = new Map<string, DefinitionInfo>();
  for (const p of profileList) {
    if (p.status !== 'removed') definitionsById.set(p.definition.id, { profileId: p.id, name: p.definition.name });
  }

  return (
    <main className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Notifications</h1>
      {items.length === 0 ? (
        <p className="text-muted-foreground">No notifications yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => {
            const { text, href } = describe(n.type, n.payload as Payload, definitionsById);
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
