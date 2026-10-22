import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  auditLogEntry,
  FILTER_CATEGORIES,
  getDb,
  type AuditAction,
  type AuditActorType,
  type DbOrTx,
} from '@voicespark/db';

export interface AuditRecordInput {
  actorType: AuditActorType;
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  subjectRef?: string;
  metadata?: Record<string, unknown>;
  ipHash?: string;
}

const scalar = z.union([
  z.number(),
  z.boolean(),
  z.uuid(),
  z.string().regex(/^[a-z0-9_.-]{1,64}$/),
]);

/** Ids, category keys, counts, version ids only: never free text (FR-048). */
export const DEFAULT_AUDIT_METADATA: z.ZodType = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  z.union([scalar, z.array(scalar)]),
);

const filterCategory = z.enum(FILTER_CATEGORIES);

export const AUDIT_METADATA_SCHEMAS: Partial<Record<AuditAction, z.ZodType>> = {
  'filter.preferences_changed': z
    .object({ added: z.array(filterCategory), removed: z.array(filterCategory) })
    .strict(),
  'filter.audit_hit': z.object({ category: filterCategory, count: z.number().int().min(0) }).strict(),
  'settings.changed': z.object({ key: z.string().regex(/^[a-z0-9_.]{1,64}$/) }).strict(),
};

export function validateAuditMetadata(action: AuditAction, metadata: unknown): Record<string, unknown> {
  const schema = AUDIT_METADATA_SCHEMAS[action] ?? DEFAULT_AUDIT_METADATA;
  return schema.parse(metadata ?? {}) as Record<string, unknown>;
}

export const audit = {
  async record(input: AuditRecordInput, db: DbOrTx = getDb()): Promise<void> {
    const metadata = input.metadata === undefined ? null : validateAuditMetadata(input.action, input.metadata);
    await db.insert(auditLogEntry).values({
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      subjectRef: input.subjectRef ?? null,
      metadata,
      ipHash: input.ipHash ?? null,
    });
  },

  /** Unlinks a deleted user from the log; `subject_ref` (a one-way digest) stays (R14, FR-064). */
  async pseudonymize(userId: string, db: DbOrTx = getDb()): Promise<void> {
    await db.update(auditLogEntry).set({ actorUserId: null }).where(eq(auditLogEntry.actorUserId, userId));
    await db.update(auditLogEntry).set({ targetId: null }).where(eq(auditLogEntry.targetId, userId));
  },
};
