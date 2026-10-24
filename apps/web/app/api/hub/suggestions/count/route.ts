import * as suggestions from '@voicespark/core/services/hub/suggestions';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Pending suggestions for the hub badge (contracts/http-api.md "Suggestions"; FR-024).
export const GET = handle(async () => {
  const user = await requireUser();
  return suggestions.count(user);
});
