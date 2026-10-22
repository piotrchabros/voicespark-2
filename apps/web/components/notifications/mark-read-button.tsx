'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function MarkReadButton({ notificationId }: { notificationId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function markRead() {
    setPending(true);
    try {
      const res = await fetch(`/api/notifications/${notificationId}/read`, { method: 'POST' });
      if (!res.ok) throw new Error('mark_read_failed');
      router.refresh();
    } catch {
      toast.error('Could not mark the notification as read.');
      setPending(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={markRead}>
      Mark as read
    </Button>
  );
}
