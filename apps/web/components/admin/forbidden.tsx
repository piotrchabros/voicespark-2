import Link from 'next/link';
import { Button } from '@/components/ui/button';

export function Forbidden() {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-start gap-3 py-16">
      <h1 className="text-2xl font-semibold">403</h1>
      <p className="text-sm">admin_required: this area is only available to administrators.</p>
      <Button asChild variant="outline">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
