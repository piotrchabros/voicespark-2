import { AppError } from '@voicespark/core/errors';
import { loadEnv } from '@voicespark/core/env';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import * as files from '@voicespark/core/services/hub/files';
import { handle, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string; id: string }> };

// Room for the multipart boundaries and the description part on top of the file itself.
const MULTIPART_OVERHEAD_BYTES = 1048576;

export const GET = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  try {
    return { items: await files.list(user, kind, params.id) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, `hub_${kind}`, params.id);
    throw err;
  }
});

// Size (413) and magic-byte (415) checks on the file itself are done by the service.
export const POST = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  // `/api/**` is outside the proxy matcher, so the body limit is enforced here before buffering the body.
  const length = Number(req.headers.get('content-length'));
  if (Number.isFinite(length) && length > loadEnv().HUB_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new AppError('too_large');
  }
  // Shared with /api/uploads: 60 file uploads per hour per user.
  await rateLimit(`uploads:${user.userId}`, 60, 3600);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError('validation_failed', 'Request body must be multipart form data');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError('validation_failed', 'A file is required');
  const description = form.get('description');
  if (description !== null && typeof description !== 'string') {
    throw new AppError('validation_failed', 'Invalid description');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await files.upload(user, kind, params.id, {
      bytes,
      filename: file.name,
      ...(description !== null ? { description } : {}),
    });
    return Response.json(result, { status: 202 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, `hub_${kind}`, params.id);
    throw err;
  }
});
