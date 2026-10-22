import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as drafts from '@voicespark/core/services/drafts';
import { handle } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

const formatSchema = z.enum(['md', 'txt']);

const CONTENT_TYPES = {
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
} as const;

// A file download only; drafts are never published anywhere (FR-056).
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const format = formatSchema.parse(new URL(req.url).searchParams.get('format'));
  let file: Awaited<ReturnType<typeof drafts.exportDraft>>;
  try {
    file = await drafts.exportDraft(user, id, format);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'draft', id);
    throw err;
  }
  return new Response(file.body, {
    status: 200,
    headers: {
      'content-type': CONTENT_TYPES[format],
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'no-store',
    },
  });
});
