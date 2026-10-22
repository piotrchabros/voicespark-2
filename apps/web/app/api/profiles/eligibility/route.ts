import * as profiles from '@voicespark/core/services/profiles';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

export const GET = handle(async () => {
  const user = await requireUser();
  return profiles.eligibility(user);
});
