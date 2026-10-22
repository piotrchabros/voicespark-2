import { AUTHORSHIPS } from '@voicespark/db';
import * as uploads from '@voicespark/core/services/uploads';
import { z } from 'zod';
import { AppError, handle, parsePagination, rateLimit } from '@/lib/http';
import { requireFiltersConfirmed, requireUser } from '@/lib/guards';

const authorshipSchema = z.enum(AUTHORSHIPS).optional();

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  return uploads.list(user, parsePagination(req.url));
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  await requireFiltersConfirmed(user);
  await rateLimit(`uploads:${user.userId}`, 60, 3600);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError('validation_failed', 'Request body must be multipart form data');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError('validation_failed', 'A file is required');
  const rawAuthorship = form.get('authorship');
  const authorship = authorshipSchema.safeParse(rawAuthorship ?? undefined);
  if (!authorship.success) throw new AppError('validation_failed', 'Invalid authorship');
  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await uploads.createFileUpload(user, {
    buffer,
    filename: file.name,
    ...(authorship.data ? { authorship: authorship.data } : {}),
  });
  return Response.json(result, { status: 202 });
});
