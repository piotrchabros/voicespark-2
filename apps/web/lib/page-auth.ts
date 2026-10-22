import { redirect } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import { requireUser, type UserContext } from './guards';

// Server components: unauthenticated and suspended users go to sign-in instead of an error page.
export async function requireUserOrRedirect(): Promise<UserContext> {
  try {
    return await requireUser();
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === 'unauthenticated') redirect('/sign-in');
      if (err.code === 'account_suspended') redirect('/sign-in?error=account_suspended');
    }
    throw err;
  }
}

// Admin pages: same redirects as above; signed-in non-admins get null so the caller renders the 403 page.
export async function requireAdminPage(): Promise<UserContext | null> {
  const ctx = await requireUserOrRedirect();
  return ctx.role === 'admin' ? ctx : null;
}
