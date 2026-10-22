import { z } from 'zod';
import * as definitions from '@voicespark/core/services/definitions';
import { handle, parseJson } from '@/lib/http';
import { requireUser } from '@/lib/guards';

const bodySchema = z.object({ definitionIds: z.array(z.uuid()).min(1).max(100) });

export const PUT = handle(async (req: Request) => {
  const user = await requireUser();
  const { definitionIds } = await parseJson(req, bodySchema);
  return definitions.setChoices(user, definitionIds);
});
