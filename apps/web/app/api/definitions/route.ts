import * as definitions from '@voicespark/core/services/definitions';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

export const GET = handle(async () => {
  const user = await requireUser();
  await definitions.autoChooseIfSingle(user);
  return definitions.listAvailable(user);
});
