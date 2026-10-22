import * as identities from '@voicespark/core/services/identities';
import { requireUser } from '../../../../lib/guards';
import { handle } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

export const DELETE = handle(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireUser();
  const { id } = await params;
  await identities.unlink(ctx, id);
});
