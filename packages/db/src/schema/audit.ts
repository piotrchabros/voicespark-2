import { char, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditActorTypeEnum } from './enums';
import { user } from './auth';

export const AUDIT_ACTIONS = [
  'auth.sign_in',
  'auth.sign_in_refused_suspended',
  'auth.identity_linked',
  'auth.identity_unlinked',
  'source.connected',
  'source.reconnected',
  'source.needs_reconnection',
  'source.paused',
  'source.resumed',
  'source.disconnected',
  'source.deleted',
  'filter.preferences_changed',
  'filter.audit_hit',
  'exclusion_rule.created',
  'exclusion_rule.updated',
  'exclusion_rule.deleted',
  'exclusion.report_submitted',
  'content.purged',
  'retroscan.purge_confirmed',
  'account.deletion_requested',
  'account.deleted',
  'deletion.sla_flagged',
  'draft.deleted',
  'content.deletion_requested',
  'definition.created',
  'definition.version_drafted',
  'definition.version_published',
  'definition.rolled_back',
  'definition.made_available',
  'definition.retired',
  'prompt.created',
  'prompt.version_drafted',
  'prompt.version_published',
  'prompt.rolled_back',
  'user.suspended',
  'user.reinstated',
  'user.role_granted',
  'user.role_revoked',
  'settings.changed',
  'admin.content_access_denied',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Append-only. Never holds content or values (FR-048). */
export const auditLogEntry = pgTable(
  'audit_log_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    subjectRef: char('subject_ref', { length: 64 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ipHash: char('ip_hash', { length: 64 }),
  },
  (t) => [
    index('audit_log_entry_action_idx').on(t.action, t.occurredAt),
    index('audit_log_entry_actor_idx').on(t.actorUserId),
    index('audit_log_entry_target_idx').on(t.targetType, t.targetId),
  ],
);

export type AuditLogEntry = typeof auditLogEntry.$inferSelect;
