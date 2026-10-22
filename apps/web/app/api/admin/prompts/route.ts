import { z } from 'zod';
import { PROMPT_EFFORTS } from '@voicespark/db';
import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../lib/guards';
import { handle, parseJson } from '../../../../lib/http';

const createBody = z.strictObject({
  key: z.string().min(1).max(100),
  description: z.string().max(500),
  systemTemplate: z.string().min(1),
  userTemplate: z.string().min(1),
  model: z.string().min(1).max(100),
  effort: z.enum(PROMPT_EFFORTS),
  maxTokens: z.number().int().positive(),
});

export const GET = handle(async () => {
  await requireAdmin();
  return adminJson('GET /api/admin/prompts', await prompts.adminList());
});

export const POST = handle(async (req) => {
  const admin = await requireAdmin();
  const body = await parseJson(req, createBody);
  return adminJson('POST /api/admin/prompts', await prompts.create(admin.userId, body), 201);
});
