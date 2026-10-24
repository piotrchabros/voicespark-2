import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { hubIgnoreRule, withTransaction, type HubIgnoreRule } from '@voicespark/db';
import * as mail from '@voicespark/db/repos/user/hub-mail';
import { validateContactValue } from '@voicespark/filters';
import { AppError, type ServiceContext } from '../../errors';
import { normalizeDomain } from '../../hub/normalize';
import { audit } from '../audit';
import { decryptContent, encryptContent, hubNotFound } from './common';
import { ignoreRuleHash, type HubIgnoreRules } from './extraction';

// Ignore rules (US3; contracts/http-api.md "Mailboxes and ignore rules", data-model.md "hub_ignore_rule"; FR-021).
// Rules apply at thread processing, not at ingest: deleting one undoes the ignore for later processing. The stored
// `value_hash` is `ignoreRuleHash`, the hash the extraction matcher computes for participants.

export type IgnoreRuleKind = 'address' | 'domain';

export interface IgnoreRuleView {
  id: string;
  kind: IgnoreRuleKind;
  value: string;
  createdAt: string;
}

const AUDIT_TARGET = 'hub_ignore_rule';

const createSchema = z.object({ kind: z.enum(['address', 'domain']), value: z.string().max(320) }).strict();

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
    throw new AppError('validation_failed', undefined, { fields });
  }
  return r.data;
}

/** Address lower-cased; domain lower-cased without `www.` as for company domains. Null when not valid. */
function normalizeValue(kind: IgnoreRuleKind, raw: string): string | null {
  if (kind === 'address') return validateContactValue('email', raw);
  const domain = normalizeDomain(raw);
  return domain === null ? null : validateContactValue('domain', domain);
}

function view(r: HubIgnoreRule): IgnoreRuleView {
  return { id: r.id, kind: r.kind as IgnoreRuleKind, value: decryptContent(r.valueEnc), createdAt: r.createdAt.toISOString() };
}

/** The user's rules, oldest first. */
export async function list(ctx: ServiceContext): Promise<IgnoreRuleView[]> {
  return (await mail.listIgnoreRules(ctx)).map(view);
}

/** Adds a rule. 422 `validation_failed` for a bad kind or value, 409 `conflict` when the same rule exists. */
export async function create(ctx: ServiceContext, input: unknown): Promise<IgnoreRuleView> {
  const { kind, value: raw } = parse(createSchema, input);
  const value = normalizeValue(kind, raw);
  if (value === null) throw new AppError('validation_failed', undefined, { fields: ['value'] });
  return withTransaction(async (tx) => {
    const [row] = await tx
      .insert(hubIgnoreRule)
      .values({ userId: ctx.userId, kind, valueEnc: encryptContent(value), valueHash: ignoreRuleHash(kind, value) })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new AppError('conflict');
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'hub.ignore_rule_created',
        targetType: AUDIT_TARGET,
        targetId: row.id,
        metadata: { kind },
      },
      tx,
    );
    return view(row);
  });
}

/** Deletes a rule; a foreign or missing id is 404. */
export async function remove(ctx: ServiceContext, ruleId: string): Promise<void> {
  if (!z.uuid().safeParse(ruleId).success) throw hubNotFound();
  await withTransaction(async (tx) => {
    const [row] = await tx
      .delete(hubIgnoreRule)
      .where(and(eq(hubIgnoreRule.id, ruleId), eq(hubIgnoreRule.userId, ctx.userId)))
      .returning({ kind: hubIgnoreRule.kind });
    if (!row) throw hubNotFound();
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'hub.ignore_rule_deleted',
        targetType: AUDIT_TARGET,
        targetId: ruleId,
        metadata: { kind: row.kind },
      },
      tx,
    );
  });
}

/** The user's rule hashes for `selectParticipants` (thread processing; no user context needed). */
export async function matcher(userId: string): Promise<HubIgnoreRules> {
  const addressHashes = new Set<string>();
  const domainHashes = new Set<string>();
  for (const r of await mail.listIgnoreRules({ userId })) (r.kind === 'address' ? addressHashes : domainHashes).add(r.valueHash);
  return { addressHashes, domainHashes };
}
