import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Every source of the user with its hub state (contracts/http-api.md "Mailboxes and ignore rules"; FR-022).
export const GET = handle(async () => {
  const user = await requireUser();
  return { items: await mailboxes.list(user) };
});
