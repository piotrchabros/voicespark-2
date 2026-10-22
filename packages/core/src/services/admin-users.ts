import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  connectedSource,
  importJob,
  session,
  user,
  withTransaction,
  type Tx,
  type UserRole,
  type UserStatus,
} from '@voicespark/db';
import { countUsers, getUserDetail, listUsers } from '@voicespark/db/repos/admin/users';
import type { AdminUserDetail } from '@voicespark/db/repos/admin/types';
import { loadEnv } from '../env';
import { AppError } from '../errors';
import { QUEUES, enqueue, jobIds, removeScheduler, upsertScheduler } from '../queues';
import { audit } from './audit';

// Admin user management (T130). Metadata only: this module never touches content, credentials or user repos
// (constitution III); sources and jobs are paused/resumed by direct row updates (D-A13).

export interface AdminUserSummary {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}

const AUDIT_TARGET = 'user';

const summaryColumns = { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status };

/**
 * Locks every active admin row (in id order, so concurrent callers queue instead of deadlocking) and refuses when
 * the target is the only one left (FR-006, R3). Exported for account deletion (T142).
 */
export async function assertNotLastActiveAdmin(tx: Tx, targetUserId: string): Promise<void> {
  const admins = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, 'admin'), eq(user.status, 'active')))
    .orderBy(asc(user.id))
    .for('update');
  if (admins.length === 1 && admins[0]!.id === targetUserId) {
    throw new AppError('last_admin', 'The last active admin cannot be removed');
  }
}

/**
 * Takes the locks for a change to `userId`: when the target is an active admin the admin set is locked first
 * (same order as assertNotLastActiveAdmin), then the target row itself.
 */
async function lockTarget(tx: Tx, userId: string, guardLastAdmin: boolean): Promise<AdminUserSummary> {
  const [current] = await tx.select(summaryColumns).from(user).where(eq(user.id, userId)).limit(1);
  if (!current) throw new AppError('not_found');
  if (guardLastAdmin && current.role === 'admin' && current.status === 'active') {
    await assertNotLastActiveAdmin(tx, userId);
  }
  const [locked] = await tx.select(summaryColumns).from(user).where(eq(user.id, userId)).for('update');
  if (!locked) throw new AppError('not_found');
  return locked;
}

export async function list(q: Parameters<typeof listUsers>[0]): ReturnType<typeof listUsers> {
  return listUsers(q);
}

export async function count(q?: { role?: UserRole; status?: UserStatus }): Promise<number> {
  return countUsers(q);
}

export async function detail(id: string): Promise<AdminUserDetail> {
  const found = await getUserDetail(id);
  if (!found) throw new AppError('not_found');
  return found;
}

/**
 * Suspends a user: sessions revoked, connected sources and in-flight imports paused with reason `suspended`,
 * poll schedulers removed after commit. The free-text `reason` is accepted but never stored (D-A6, FR-048).
 */
export async function suspend(adminId: string, userId: string, _reason?: string): Promise<AdminUserSummary> {
  const { summary, pausedSourceIds } = await withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId, true);
    if (target.status === 'suspended') return { summary: target, pausedSourceIds: [] as string[] };
    const now = new Date();
    const [updated] = await tx
      .update(user)
      .set({ status: 'suspended', suspendedAt: now, suspendedBy: adminId, updatedAt: now })
      .where(eq(user.id, userId))
      .returning(summaryColumns);
    await tx.delete(session).where(eq(session.userId, userId));
    const paused = await tx
      .update(connectedSource)
      .set({ status: 'paused', pauseReason: 'suspended' })
      .where(and(eq(connectedSource.userId, userId), eq(connectedSource.status, 'connected')))
      .returning({ id: connectedSource.id });
    await tx
      .update(importJob)
      .set({ status: 'paused', pauseReason: 'suspended' })
      .where(
        and(
          eq(importJob.userId, userId),
          inArray(importJob.status, ['queued', 'running']),
          ne(importJob.kind, 'upload'),
        ),
      );
    await audit.record(
      { actorType: 'admin', actorUserId: adminId, action: 'user.suspended', targetType: AUDIT_TARGET, targetId: userId },
      tx,
    );
    return { summary: updated!, pausedSourceIds: paused.map((s) => s.id) };
  });
  for (const sourceId of pausedSourceIds) await removeScheduler(QUEUES.syncPoll, jobIds.poll(sourceId));
  return summary;
}

/** Restores `active` and resumes only what the suspension paused (D-A14); polling and imports restart after commit. */
export async function reinstate(adminId: string, userId: string): Promise<AdminUserSummary> {
  const { summary, sourceIds, jobs } = await withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId, false);
    if (target.status !== 'suspended') {
      return { summary: target, sourceIds: [] as string[], jobs: [] as { id: string; sourceId: string }[] };
    }
    const [updated] = await tx
      .update(user)
      .set({ status: 'active', suspendedAt: null, suspendedBy: null, updatedAt: new Date() })
      .where(eq(user.id, userId))
      .returning(summaryColumns);
    const resumed = await tx
      .update(connectedSource)
      .set({ status: 'connected', pauseReason: null })
      .where(
        and(
          eq(connectedSource.userId, userId),
          eq(connectedSource.status, 'paused'),
          eq(connectedSource.pauseReason, 'suspended'),
        ),
      )
      .returning({ id: connectedSource.id });
    const resumedJobs = await tx
      .update(importJob)
      .set({ status: 'running', pauseReason: null })
      .where(
        and(eq(importJob.userId, userId), eq(importJob.status, 'paused'), eq(importJob.pauseReason, 'suspended')),
      )
      .returning({ id: importJob.id, sourceId: importJob.sourceId });
    await audit.record(
      { actorType: 'admin', actorUserId: adminId, action: 'user.reinstated', targetType: AUDIT_TARGET, targetId: userId },
      tx,
    );
    return { summary: updated!, sourceIds: resumed.map((s) => s.id), jobs: resumedJobs };
  });
  const every = loadEnv().SYNC_POLL_INTERVAL_MINUTES * 60_000;
  for (const sourceId of sourceIds) {
    await upsertScheduler(QUEUES.syncPoll, jobIds.poll(sourceId), { every }, {
      name: 'sync.poll',
      data: { userId, sourceId },
    });
  }
  for (const job of jobs) {
    await enqueue(
      'import.page',
      { userId, sourceId: job.sourceId, importJobId: job.id },
      { jobId: jobIds.importPage(job.sourceId, Date.now()) },
    );
  }
  return summary;
}

/** Grants or revokes the admin role; a demotion of the last active admin (including self) is refused (FR-043). */
export async function setRole(adminId: string, userId: string, role: UserRole): Promise<AdminUserSummary> {
  return withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId, role !== 'admin');
    if (target.role === role) return target;
    const [updated] = await tx
      .update(user)
      .set({ role, updatedAt: new Date() })
      .where(eq(user.id, userId))
      .returning(summaryColumns);
    await audit.record(
      {
        actorType: 'admin',
        actorUserId: adminId,
        action: role === 'admin' ? 'user.role_granted' : 'user.role_revoked',
        targetType: AUDIT_TARGET,
        targetId: userId,
      },
      tx,
    );
    return updated!;
  });
}

export async function revokeRole(adminId: string, userId: string): Promise<AdminUserSummary> {
  return setRole(adminId, userId, 'user');
}
