import { RecordListPage } from '@/components/hub/record-list-page';

export const dynamic = 'force-dynamic';

export default function Page({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; order?: string; cursor?: string }>;
}) {
  return <RecordListPage kind="companies" searchParams={searchParams} />;
}
