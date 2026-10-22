import { z } from 'zod';
import { PROMPT_EFFORTS } from '@voicespark/db';
import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../../../../lib/guards';
import { handle, parseJson } from '../../../../../../../lib/http';

type Ctx = { params: Promise<{ id: string; versionId: string }> };

const patchBody = z.strictObject({
  systemTemplate: z.string().min(1).optional(),
  userTemplate: z.string().min(1).optional(),
  model: z.string().min(1).max(100).optional(),
  effort: z.enum(PROMPT_EFFORTS).optional(),
  maxTokens: z.number().int().positive().optional(),
  changeNote: z.string().max(500).nullable().optional(),
});

export const PATCH = handle(async (req, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id, versionId } = await ctx.params;
  const body = await parseJson(req, patchBody);
  const version = await prompts.updateDraft(admin.userId, id, versionId, body);
  return adminJson('PATCH /api/admin/prompts/[id]/versions/[versionId]', { version });
});

export const DELETE = handle(async (_req, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id, versionId } = await ctx.params;
  await prompts.discardDraft(admin.userId, id, versionId);
  return undefined;
});
