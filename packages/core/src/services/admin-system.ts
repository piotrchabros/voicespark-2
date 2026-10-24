import { APP_SETTING_DEFAULTS, appSetting, getDb } from '@voicespark/db';
import { countActionsSince, queryAudit } from '@voicespark/db/repos/admin/audit';
import { hubAggregates } from '@voicespark/db/repos/admin/hub-counts';
import { ratings } from '@voicespark/db/repos/admin/metrics';
import type { AdminHubAggregates } from '@voicespark/db/repos/admin/types';
import { countFlaggedDeletions } from '@voicespark/db/repos/system/deletions';
import { QUEUES, getQueue, type QueueName } from '../queues';
import { getSetting, type SettingKey } from './settings';

// Admin system views (T131): queue health, audit search and rating aggregates. Metadata and counts only (FR-048).

export interface QueueCounts {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
}

export interface SystemHealth {
  queues: Record<QueueName, QueueCounts>;
  overdueDeletions: number;
  credentialAuditHits: number;
  /** Context Hub aggregates (FR-029): numbers only. */
  hub: AdminHubAggregates;
}

export interface SettingView {
  key: SettingKey;
  value: number;
  defaultValue: number;
  updatedAt: Date | null;
}

/** Window for `filter.audit_hit` rows reported as credential audit hits (D-A12). */
const CREDENTIAL_AUDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function health(): Promise<SystemHealth> {
  const names = Object.values(QUEUES);
  const counts = await Promise.all(
    names.map(async (name) => {
      const c = await getQueue(name).getJobCounts('waiting', 'active', 'failed', 'delayed');
      return [name, { waiting: c.waiting ?? 0, active: c.active ?? 0, failed: c.failed ?? 0, delayed: c.delayed ?? 0 }] as const;
    }),
  );
  const now = new Date();
  // The SLA job's flagged set: not completed and overdue or due within 2 h (R19, D-U7e).
  const overdueDeletions = await countFlaggedDeletions(now);
  const credentialAuditHits = await countActionsSince(
    'filter.audit_hit',
    new Date(now.getTime() - CREDENTIAL_AUDIT_WINDOW_MS),
  );
  const hub = await hubAggregates();
  return {
    queues: Object.fromEntries(counts) as Record<QueueName, QueueCounts>,
    overdueDeletions,
    credentialAuditHits,
    hub,
  };
}

export async function auditQuery(q: Parameters<typeof queryAudit>[0]): ReturnType<typeof queryAudit> {
  return queryAudit(q);
}

export async function ratingsMetrics(q: { from?: Date; to?: Date }): ReturnType<typeof ratings> {
  return ratings(q);
}

export async function listSettings(): Promise<SettingView[]> {
  const keys = Object.keys(APP_SETTING_DEFAULTS) as SettingKey[];
  const rows = await getDb().select({ key: appSetting.key, updatedAt: appSetting.updatedAt }).from(appSetting);
  const updated = new Map(rows.map((r) => [r.key, r.updatedAt]));
  return Promise.all(
    keys.map(async (key) => ({
      key,
      value: await getSetting(key),
      defaultValue: APP_SETTING_DEFAULTS[key],
      updatedAt: updated.get(key) ?? null,
    })),
  );
}
