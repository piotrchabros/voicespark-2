import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  exclusionRule,
  getDb,
  withTransaction,
  type ExclusionRule,
  type ExclusionRuleType,
  type Tx,
} from '@voicespark/db';
import { AppError, type ServiceContext } from '../errors';
import { audit } from './audit';
import * as retroscans from './retroscans';

/** At most 200 rules per user (FR-021). */
export const RULE_LIMIT = 200;

export interface ExclusionRuleView {
  id: string;
  type: ExclusionRuleType;
  value: string;
  createdAt: string;
  updatedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const VALUE_SCHEMAS: Record<ExclusionRuleType, z.ZodType<string>> = {
  sender: z.string().trim().toLowerCase().pipe(z.email()),
  // A leading '@' is accepted as a convenience and dropped; the stored domain never contains '@'.
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/^@/, ''))
    .pipe(z.string().regex(HOSTNAME_RE)),
  folder_label: z.string().trim().min(1).max(200),
  keyword: z.string().trim().min(3).max(100),
};

const VALUE_MESSAGES: Record<ExclusionRuleType, string> = {
  sender: 'Enter a valid email address',
  domain: 'Enter a domain such as example.com',
  folder_label: 'Folder or label must be 1-200 characters',
  keyword: 'Keyword must be 3-100 characters',
};

/** Validates and normalizes a rule value per data-model entity 5 (FR-021). */
export function normalizeRuleValue(type: ExclusionRuleType, value: string): string {
  const parsed = VALUE_SCHEMAS[type].safeParse(value);
  if (!parsed.success) throw new AppError('validation_failed', VALUE_MESSAGES[type], { field: 'value' });
  return parsed.data;
}

function toView(r: ExclusionRule): ExclusionRuleView {
  return {
    id: r.id,
    type: r.type,
    value: r.value,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function isUniqueViolation(e: unknown): boolean {
  for (let err = e; err && typeof err === 'object'; err = (err as { cause?: unknown }).cause) {
    if ((err as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

async function withUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', 'This rule already exists');
    throw e;
  }
}

async function auditRule(
  tx: Tx,
  ctx: ServiceContext,
  action: 'exclusion_rule.created' | 'exclusion_rule.updated' | 'exclusion_rule.deleted',
  rule: Pick<ExclusionRule, 'id' | 'type'>,
): Promise<void> {
  // The rule type only, never the value (it may name a person or address).
  await audit.record(
    {
      actorType: 'user',
      actorUserId: ctx.userId,
      action,
      targetType: 'exclusion_rule',
      targetId: rule.id,
      metadata: { ruleType: rule.type },
    },
    tx,
  );
}

async function offerRetroscan(
  ctx: ServiceContext,
  trigger: 'rule_created' | 'rule_updated',
  ruleId: string,
): Promise<string | null> {
  if (!(await retroscans.userHasContent(ctx.userId))) return null;
  const { id } = await retroscans.create({ userId: ctx.userId, trigger, exclusionRuleId: ruleId, categories: [] });
  return id;
}

export async function list(ctx: ServiceContext): Promise<ExclusionRuleView[]> {
  const rows = await getDb()
    .select()
    .from(exclusionRule)
    .where(eq(exclusionRule.userId, ctx.userId))
    .orderBy(asc(exclusionRule.createdAt), asc(exclusionRule.id));
  return rows.map(toView);
}

export async function create(
  ctx: ServiceContext,
  input: { type: ExclusionRuleType; value: string },
): Promise<{ rule: ExclusionRuleView; retroscanId: string | null }> {
  const value = normalizeRuleValue(input.type, input.value);
  const row = await withUniqueGuard(() =>
    withTransaction(async (tx) => {
      // Serializes rule creation per user so the cap holds under concurrent requests.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`exclusion_rule:${ctx.userId}`}))`);
      const [current] = await tx
        .select({ n: count() })
        .from(exclusionRule)
        .where(eq(exclusionRule.userId, ctx.userId));
      if ((current?.n ?? 0) >= RULE_LIMIT) throw new AppError('conflict', 'rule limit reached');
      const [inserted] = await tx
        .insert(exclusionRule)
        .values({ userId: ctx.userId, type: input.type, value })
        .returning();
      if (!inserted) throw new Error('exclusion_rule_insert_failed');
      await auditRule(tx, ctx, 'exclusion_rule.created', inserted);
      return inserted;
    }),
  );
  const retroscanId = await offerRetroscan(ctx, 'rule_created', row.id);
  return { rule: toView(row), retroscanId };
}

export async function update(
  ctx: ServiceContext,
  id: string,
  input: { value: string },
): Promise<{ rule: ExclusionRuleView; retroscanId: string | null }> {
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  const row = await withUniqueGuard(() =>
    withTransaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(exclusionRule)
        .where(and(eq(exclusionRule.id, id), eq(exclusionRule.userId, ctx.userId)))
        .for('update')
        .limit(1);
      if (!existing) throw new AppError('not_found');
      const value = normalizeRuleValue(existing.type, input.value);
      const [updated] = await tx
        .update(exclusionRule)
        .set({ value, updatedAt: new Date() })
        .where(eq(exclusionRule.id, id))
        .returning();
      if (!updated) throw new AppError('not_found');
      await auditRule(tx, ctx, 'exclusion_rule.updated', updated);
      return updated;
    }),
  );
  const retroscanId = await offerRetroscan(ctx, 'rule_updated', row.id);
  return { rule: toView(row), retroscanId };
}

export async function remove(ctx: ServiceContext, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  await withTransaction(async (tx) => {
    const [deleted] = await tx
      .delete(exclusionRule)
      .where(and(eq(exclusionRule.id, id), eq(exclusionRule.userId, ctx.userId)))
      .returning({ id: exclusionRule.id, type: exclusionRule.type });
    if (!deleted) throw new AppError('not_found');
    await auditRule(tx, ctx, 'exclusion_rule.deleted', deleted);
  });
}
