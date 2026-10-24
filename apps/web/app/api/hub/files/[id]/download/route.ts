import { AppError } from '@voicespark/core/errors';
import * as files from '@voicespark/core/services/hub/files';
import { handle } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ id: string }> };

// ASCII fallback plus the RFC 5987 form; quotes, backslashes and control chars never reach the header.
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Owner only (FR-009): the decrypted original goes to its owner and nowhere else.
export const GET = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  let file: files.FileDownload;
  try {
    file = await files.download(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_file', id);
    throw err;
  }
  return new Response(new Blob([file.bytes as Uint8Array<ArrayBuffer>]), {
    status: 200,
    headers: {
      'content-type': file.mimeType,
      'content-length': String(file.bytes.byteLength),
      'content-disposition': contentDisposition(file.filename),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
});
