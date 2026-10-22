import { and, count, desc, eq, ilike, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { getDb } from '../../client';
import {
  connectedSource,
  importJob,
  profileVersion,
  signInIdentity,
  toneDefinition,
  toneDefinitionVersion,
  toneProfile,
  user,
  type UserRole,
  type UserStatus,
} from '../../schema';
import type { AdminUserDetail, AdminUserListItem } from './types';

export interface ListUsersQuery {
  query?: string;
  role?: UserRole;
  status?: UserStatus;
  cursor?: string;
  limit: number;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = iso ? new Date(iso) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

// Postgres keeps microseconds and JS Dates milliseconds, so keyset ordering and comparison use the
// millisecond-truncated timestamp (as notifications.list).
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${user.createdAt})`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function listUsers(
  q: ListUsersQuery,
): Promise<{ items: AdminUserListItem[]; nextCursor: string | null }> {
  const db = getDb();
  const conditions = [];
  if (q.query) {
    const like = `%${q.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(user.name, like), ilike(user.email, like)));
  }
  if (q.role) conditions.push(eq(user.role, q.role));
  if (q.status) conditions.push(eq(user.status, q.status));
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (cursor) {
    conditions.push(
      or(
        lt(createdAtMs, cursor.createdAt),
        and(eq(createdAtMs, cursor.createdAt), lt(user.id, cursor.id)),
      ),
    );
  }

  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      lastSignInAt: user.lastSignInAt,
    })
    .from(user)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(createdAtMs), desc(user.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null;
  if (page.length === 0) return { items: [], nextCursor };

  const ids = page.map((r) => r.id);
  const [identityRows, sourceRows] = await Promise.all([
    db
      .select({ userId: signInIdentity.userId, provider: signInIdentity.provider })
      .from(signInIdentity)
      .where(inArray(signInIdentity.userId, ids)),
    db
      .select({ userId: connectedSource.userId, count: sql<number>`count(*)::int` })
      .from(connectedSource)
      .where(and(inArray(connectedSource.userId, ids), ne(connectedSource.status, 'disconnected')))
      .groupBy(connectedSource.userId),
  ]);
  const providers = new Map<string, string[]>();
  for (const r of identityRows) {
    const list = providers.get(r.userId) ?? [];
    if (!list.includes(r.provider)) list.push(r.provider);
    providers.set(r.userId, list);
  }
  const counts = new Map(sourceRows.map((r) => [r.userId, r.count]));

  const items = page.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    status: r.status,
    providers: providers.get(r.id) ?? [],
    sourceCount: counts.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
    lastSignInAt: iso(r.lastSignInAt),
  }));
  return { items, nextCursor };
}

export async function getUserDetail(id: string): Promise<AdminUserDetail | null> {
  const db = getDb();
  const [u] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      lastSignInAt: user.lastSignInAt,
      suspendedAt: user.suspendedAt,
    })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  if (!u) return null;

  const [identities, sources, profiles] = await Promise.all([
    db
      .select({
        provider: signInIdentity.provider,
        providerEmail: signInIdentity.providerEmail,
        verified: signInIdentity.emailVerified,
      })
      .from(signInIdentity)
      .where(eq(signInIdentity.userId, id)),
    db
      .select({
        id: connectedSource.id,
        type: connectedSource.type,
        accountLabel: connectedSource.accountLabel,
        status: connectedSource.status,
        itemCount: connectedSource.itemCount,
        lastSyncAt: connectedSource.lastSyncAt,
      })
      .from(connectedSource)
      .where(eq(connectedSource.userId, id))
      .orderBy(connectedSource.connectedAt, connectedSource.id),
    db
      .select({
        definitionKey: toneDefinition.key,
        definitionName: toneDefinitionVersion.name,
        status: toneProfile.status,
        versionCount: sql<number>`count(${profileVersion.id})::int`,
        lastGeneratedAt: sql<Date | null>`max(${profileVersion.createdAt})`,
      })
      .from(toneProfile)
      .innerJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
      .leftJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, toneDefinition.activeVersionId))
      .leftJoin(profileVersion, eq(profileVersion.profileId, toneProfile.id))
      .where(eq(toneProfile.userId, id))
      .groupBy(toneProfile.id, toneDefinition.key, toneDefinitionVersion.name)
      .orderBy(toneProfile.createdAt),
  ]);

  const sourceIds = sources.map((s) => s.id);
  const jobs = sourceIds.length
    ? await db
        .select({
          sourceId: importJob.sourceId,
          status: importJob.status,
          itemsProcessed: importJob.itemsProcessed,
          totalEstimate: importJob.totalEstimate,
        })
        .from(importJob)
        .where(
          and(
            inArray(importJob.sourceId, sourceIds),
            inArray(importJob.status, ['queued', 'running', 'paused']),
            ne(importJob.kind, 'upload'),
          ),
        )
        .orderBy(sql`${importJob.lastActivityAt} desc nulls last`)
    : [];
  const currentImports = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) if (!currentImports.has(j.sourceId)) currentImports.set(j.sourceId, j);

  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt.toISOString(),
    lastSignInAt: iso(u.lastSignInAt),
    suspendedAt: iso(u.suspendedAt),
    identities,
    sources: sources.map((s) => {
      const j = currentImports.get(s.id);
      return {
        id: s.id,
        type: s.type,
        accountLabel: s.accountLabel,
        status: s.status,
        itemCount: s.itemCount,
        lastSyncAt: iso(s.lastSyncAt),
        currentImport: j
          ? { status: j.status, itemsProcessed: j.itemsProcessed, totalEstimate: j.totalEstimate }
          : null,
      };
    }),
    profiles: profiles.map((p) => ({
      definitionName: p.definitionName ?? p.definitionKey,
      status: p.status,
      versionCount: p.versionCount,
      lastGeneratedAt: p.lastGeneratedAt ? new Date(p.lastGeneratedAt).toISOString() : null,
    })),
  };
}

export async function countUsers(q: { role?: UserRole; status?: UserStatus } = {}): Promise<number> {
  const conditions = [];
  if (q.role) conditions.push(eq(user.role, q.role));
  if (q.status) conditions.push(eq(user.status, q.status));
  const [row] = await getDb()
    .select({ n: count() })
    .from(user)
    .where(conditions.length ? and(...conditions) : undefined);
  return Number(row?.n ?? 0);
}
