'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  userId: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'pending_deletion';
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code === 'last_admin')
      return 'This is the last active admin and cannot be suspended or demoted.';
    return body.error?.message ?? 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

export function UserActions({ userId, role, status }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState('');

  async function call(path: string, method: 'POST' | 'PUT', body: unknown, done: string) {
    setPending(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res));
        return;
      }
      toast.success(done);
      setReason('');
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {status === 'pending_deletion' ? (
        <p className="text-sm text-muted-foreground">This account is pending deletion.</p>
      ) : status === 'active' ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Reason (optional, not stored)"
            aria-label="Suspension reason"
          />
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              call(
                'suspend',
                'POST',
                reason.trim() ? { reason: reason.trim() } : {},
                'User suspended',
              )
            }
          >
            Suspend
          </Button>
        </div>
      ) : (
        <div>
          <Button
            disabled={pending}
            onClick={() => call('reinstate', 'POST', {}, 'User reinstated')}
          >
            Reinstate
          </Button>
        </div>
      )}
      <div>
        {role === 'user' ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => call('role', 'PUT', { role: 'admin' }, 'Admin role granted')}
          >
            Grant admin
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => call('role', 'PUT', { role: 'user' }, 'Admin role revoked')}
          >
            Revoke admin
          </Button>
        )}
      </div>
    </div>
  );
}
