import { RecordDetailPage } from '@/components/hub/record-detail-page';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecordDetailPage kind="projects" id={id} />;
}
