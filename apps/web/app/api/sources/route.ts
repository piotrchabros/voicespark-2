import * as sources from '@voicespark/core/services/sources';
import { requireUser } from '../../../lib/guards';
import { handle } from '../../../lib/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const user = await requireUser();
  return sources.list(user);
});
