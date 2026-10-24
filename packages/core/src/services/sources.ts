import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  connectedSource,
  deletionRequest,
  getDb,
  importJob,
  mailboxCredential,
  oauthConnectState,
  withTransaction,
  type SourcePauseReason,
  type SourceStatus,
  type SourceType,
  type Tx,
} from '@voicespark/db';
import * as hubMail from '@voicespark/db/repos/user/hub-mail';
import { getSource, listSources } from '@voicespark/db/repos/user/sources';
import type { ImapConfig } from '@voicespark/integrations/imap';
import {
  assertMinimalScopes,
  authorizeUrl,
  CONSENT_SUMMARY,
  exchangeCode,
  generateCodeVerifier,
  revokeGoogleToken,
  type ConsentSummary,
} from '@voicespark/integrations/oauth';
import type { OAuthTokens } from '@voicespark/integrations/mail';
import { decrypt, encrypt } from '../crypto';
import { loadEnv } from '../env';
import { AppError, type ServiceContext } from '../errors';
import { QUEUES, jobIds, removeScheduler, upsertScheduler } from '../queues';
import { audit } from './audit';
import { requestDeletion } from './deletion';
import * as imports from './imports';
import {
  NON_TERMINAL_STATUSES,
  toProgress,
  type ImportJobRow,
  type ImportProgress,
} from './imports';
import {
  loadImapSettings,
  loadRevocableToken,
  mailOAuthEnv,
  resolveOAuthAddress,
  saveImapCredential,
  saveOAuthCredential,
  verifyImap,
} from './mail-access';
import { notify } from './notifications';

export { assertFiltersConfirmed } from './imports';

export type MailProvider = 'gmail' | 'microsoft';

/** What happens to the context-hub data derived from a mailbox when it is disconnected or removed (FR-031). */
export type HubDataChoice = 'keep' | 'delete';

export interface DateRangeInput {
  from?: string | null;
  to?: string | null;
}

export interface SourceView {
  id: string;
  type: SourceType;
  accountLabel: string;
  status: SourceStatus;
  pauseReason: SourcePauseReason | null;
  itemCount: number;
  lastSyncAt: string | null;
  dateRange: { from: string | null; to: string | null };
  currentImport: ImportProgress | null;
  hub: { enabled: boolean };
}

export interface SourceDetail extends SourceView {
  /** Newest 10. */
  recentImports: ImportProgress[];
}

export type SourceRow = typeof connectedSource.$inferSelect;

/** PKCE connect state lifetime. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;
export const RECENT_IMPORTS = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUDIT_TARGET = 'source';

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

function isCalendarDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Inclusive `YYYY-MM-DD` bounds; either may be open. Invalid days or from > to -> `validation_failed`. */
export function validateDateRange(input?: DateRangeInput | null): {
  from: string | null;
  to: string | null;
} {
  const from = input?.from ?? null;
  const to = input?.to ?? null;
  if (from !== null && !isCalendarDay(from)) {
    throw new AppError('validation_failed', 'Invalid start date', { field: 'dateRange.from' });
  }
  if (to !== null && !isCalendarDay(to)) {
    throw new AppError('validation_failed', 'Invalid end date', { field: 'dateRange.to' });
  }
  if (from !== null && to !== null && from > to) {
    throw new AppError('validation_failed', 'Start date is after end date', { field: 'dateRange' });
  }
  return { from, to };
}

/** Mailbox address for an IMAP login: the username when it is an address, else `username@host`. */
export function imapAddress(cfg: Pick<ImapConfig, 'host' | 'username'>): string {
  const username = cfg.username.trim();
  return (username.includes('@') ? username : `${username}@${cfg.host.trim()}`).toLowerCase();
}

/** Never includes credentials or the raw account address beyond its label. */
export function toSourceView(
  row: SourceRow,
  currentImport: ImportProgress | null,
  hubEnabled = false,
): SourceView {
  return {
    id: row.id,
    type: row.type,
    accountLabel: row.accountLabel,
    status: row.status,
    pauseReason: row.pauseReason,
    itemCount: row.itemCount,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    dateRange: { from: row.dateRangeFrom, to: row.dateRangeTo },
    currentImport,
    hub: { enabled: hubEnabled },
  };
}

function validateImapConfig(cfg: ImapConfig): void {
  const bad = (field: string) => new AppError('validation_failed', `Invalid ${field}`, { field });
  if (!cfg.host?.trim()) throw bad('host');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw bad('port');
  if (cfg.tlsMode !== 'tls' && cfg.tlsMode !== 'starttls') throw bad('tlsMode');
  if (!cfg.username?.trim()) throw bad('username');
  if (!cfg.password) throw bad('password');
}

// ---------------------------------------------------------------------------------------------------------------
// Loading

async function ownedSource(ctx: ServiceContext, sourceId: string): Promise<SourceRow> {
  if (!UUID_RE.test(sourceId)) throw new AppError('not_found');
  const row = await getSource(ctx, sourceId);
  if (!row) throw new AppError('not_found');
  return row;
}

/** Newest job per source (a non-terminal job is always the newest): same order as `imports.listForSource`. */
async function currentImports(sourceIds: string[]): Promise<Map<string, ImportProgress>> {
  if (sourceIds.length === 0) return new Map();
  const rows: ImportJobRow[] = await getDb()
    .selectDistinctOn([importJob.sourceId])
    .from(importJob)
    .where(inArray(importJob.sourceId, sourceIds))
    .orderBy(
      importJob.sourceId,
      sql`${importJob.startedAt} desc nulls first`,
      desc(importJob.finishedAt),
      asc(importJob.id),
    );
  return new Map(rows.map((r) => [r.sourceId, toProgress(r)]));
}

async function view(row: SourceRow): Promise<SourceView> {
  const [current, hubEnabled] = await Promise.all([
    currentImports([row.id]),
    hubMail.isMailboxEnabled({ userId: row.userId }, row.id),
  ]);
  return toSourceView(row, current.get(row.id) ?? null, hubEnabled);
}

export async function list(ctx: ServiceContext): Promise<SourceView[]> {
  // The repo lists oldest first; the API shows the newest connection first (ties by id).
  const rows = (await listSources(ctx)).sort(
    (a, b) =>
      b.connectedAt.getTime() - a.connectedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const [current, settings] = await Promise.all([
    currentImports(rows.map((r) => r.id)),
    hubMail.listMailboxSettings(ctx),
  ]);
  const hubEnabled = new Set(settings.filter((s) => s.enabled).map((s) => s.sourceId));
  return rows.map((r) => toSourceView(r, current.get(r.id) ?? null, hubEnabled.has(r.id)));
}

export async function get(ctx: ServiceContext, sourceId: string): Promise<SourceDetail> {
  const row = await ownedSource(ctx, sourceId);
  const recentImports = await imports.listForSource(ctx, sourceId, RECENT_IMPORTS);
  return { ...(await view(row)), recentImports };
}

// ---------------------------------------------------------------------------------------------------------------
// Connect

async function schedulePoll(userId: string, sourceId: string): Promise<void> {
  await upsertScheduler(
    QUEUES.syncPoll,
    jobIds.poll(sourceId),
    { every: loadEnv().SYNC_POLL_INTERVAL_MINUTES * 60_000 },
    { name: 'sync.poll', data: { userId, sourceId } },
  );
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * New source + credential + `initial` job in one transaction; the poll scheduler and the first page are
 * enqueued only after the commit.
 */
async function createSource(
  ctx: ServiceContext,
  input: {
    type: Exclude<SourceType, 'uploads'>;
    address: string;
    dateRange: { from: string | null; to: string | null };
    saveCredential: (tx: Tx, sourceId: string) => Promise<void>;
  },
): Promise<{ row: SourceRow; importJobId: string }> {
  let created: { row: SourceRow; importJobId: string };
  try {
    created = await withTransaction(async (tx) => {
      const [existing] = await tx
        .select({ id: connectedSource.id })
        .from(connectedSource)
        .where(
          and(
            eq(connectedSource.userId, ctx.userId),
            eq(connectedSource.type, input.type),
            eq(connectedSource.accountAddress, input.address),
            ne(connectedSource.status, 'disconnected'),
          ),
        )
        .limit(1);
      if (existing) throw new AppError('conflict', 'This mailbox is already connected');
      const [row] = await tx
        .insert(connectedSource)
        .values({
          userId: ctx.userId,
          type: input.type,
          accountLabel: input.address,
          accountAddress: input.address,
          status: 'connected',
          dateRangeFrom: input.dateRange.from,
          dateRangeTo: input.dateRange.to,
          consentTextVersion: CONSENT_SUMMARY[input.type].version,
        })
        .returning();
      if (!row) throw new Error('source_insert_failed');
      await input.saveCredential(tx, row.id);
      const job = await imports.createJob(
        { userId: ctx.userId, sourceId: row.id, kind: 'initial' },
        tx,
      );
      await audit.record(
        {
          actorType: 'user',
          actorUserId: ctx.userId,
          action: 'source.connected',
          targetType: AUDIT_TARGET,
          targetId: row.id,
          metadata: { sourceType: input.type },
        },
        tx,
      );
      return { row, importJobId: job.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', 'This mailbox is already connected');
    throw err;
  }
  await schedulePoll(ctx.userId, created.row.id);
  await imports.enqueuePage({
    userId: ctx.userId,
    sourceId: created.row.id,
    importJobId: created.importJobId,
  });
  return created;
}

/** Starts a mailbox OAuth flow. The filter gate runs before any other I/O (FR-061). */
export async function startConnect(
  ctx: ServiceContext,
  provider: MailProvider,
  dateRange?: DateRangeInput,
  opts: { reconnectSourceId?: string } = {},
): Promise<{ authorizeUrl: string; consentSummary: ConsentSummary }> {
  await imports.assertFiltersConfirmed(ctx.userId);
  const range = validateDateRange(dateRange);
  const db = getDb();
  await db
    .delete(oauthConnectState)
    .where(
      and(eq(oauthConnectState.userId, ctx.userId), lt(oauthConnectState.expiresAt, new Date())),
    );
  const state = randomUUID();
  const verifier = generateCodeVerifier();
  const url = authorizeUrl(mailOAuthEnv(), provider, state, verifier);
  await db.insert(oauthConnectState).values({
    id: state,
    userId: ctx.userId,
    provider,
    codeVerifierEnc: encrypt('mailbox-credentials', verifier),
    dateRangeFrom: range.from,
    dateRangeTo: range.to,
    reconnectSourceId: opts.reconnectSourceId ?? null,
    expiresAt: new Date(Date.now() + CONNECT_STATE_TTL_MS),
  });
  return { authorizeUrl: url.toString(), consentSummary: CONSENT_SUMMARY[provider] };
}

/** OAuth callback. The state is consumed in every outcome; any mismatch is `oauth_failed`. */
export async function completeConnect(
  ctx: ServiceContext,
  input: { state: string; code: string; provider: MailProvider },
): Promise<{ sourceId: string }> {
  if (!UUID_RE.test(input.state)) throw new AppError('oauth_failed');
  const [state] = await getDb()
    .delete(oauthConnectState)
    .where(eq(oauthConnectState.id, input.state))
    .returning();
  if (
    !state ||
    state.userId !== ctx.userId ||
    state.provider !== input.provider ||
    state.expiresAt.getTime() <= Date.now()
  ) {
    throw new AppError('oauth_failed');
  }

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCode(
      mailOAuthEnv(),
      input.provider,
      input.code,
      decrypt('mailbox-credentials', state.codeVerifierEnc),
    );
  } catch {
    throw new AppError('oauth_failed');
  }
  try {
    assertMinimalScopes(input.provider, tokens.scopes);
  } catch {
    if (input.provider === 'gmail') {
      await revokeGoogleToken(tokens.refreshToken ?? tokens.accessToken).catch(() => undefined);
    }
    throw new AppError(
      'oauth_failed',
      'The granted permissions do not match the requested read-only access',
    );
  }
  let address: string;
  try {
    address = await resolveOAuthAddress(input.provider, tokens);
  } catch {
    throw new AppError('oauth_failed');
  }

  if (state.reconnectSourceId) {
    const source = await ownedSource(ctx, state.reconnectSourceId);
    if (source.type !== input.provider || source.accountAddress !== address) {
      // A reconnect may not swap the mailbox (D-C15).
      throw new AppError('conflict', 'Reconnect with the same mailbox');
    }
    await assertReconnectable(source);
    await finishReconnect(ctx, source, (tx) => saveOAuthCredential(tx, source.id, tokens));
    return { sourceId: source.id };
  }

  // Background sync needs a refresh token; both providers issue one with the requested consent.
  if (!tokens.refreshToken) throw new AppError('oauth_failed');
  const { row } = await createSource(ctx, {
    type: input.provider,
    address,
    dateRange: { from: state.dateRangeFrom, to: state.dateRangeTo },
    saveCredential: (tx, sourceId) => saveOAuthCredential(tx, sourceId, tokens),
  });
  return { sourceId: row.id };
}

/** Verifies the login synchronously; nothing is stored when it fails. */
export async function connectImap(
  ctx: ServiceContext,
  input: ImapConfig & { dateRange?: DateRangeInput },
): Promise<SourceView> {
  await imports.assertFiltersConfirmed(ctx.userId);
  const range = validateDateRange(input.dateRange);
  const cfg: ImapConfig = {
    host: input.host?.trim(),
    port: input.port,
    tlsMode: input.tlsMode,
    username: input.username?.trim(),
    password: input.password,
  };
  validateImapConfig(cfg);
  await verifyImap(cfg);
  const { row } = await createSource(ctx, {
    type: 'imap',
    address: imapAddress(cfg),
    dateRange: range,
    saveCredential: (tx, sourceId) => saveImapCredential(tx, sourceId, cfg),
  });
  return view(row);
}

// ---------------------------------------------------------------------------------------------------------------
// Reconnect

/** Only a source that needs reconnection, or whose job is paused for auth, can be reconnected. */
async function assertReconnectable(source: SourceRow): Promise<void> {
  if (source.status === 'needs_reconnection') return;
  if (source.status !== 'disconnected' && source.pauseReason !== 'suspended') {
    const [authPaused] = await getDb()
      .select({ id: importJob.id })
      .from(importJob)
      .where(
        and(
          eq(importJob.sourceId, source.id),
          eq(importJob.status, 'paused'),
          eq(importJob.pauseReason, 'auth'),
        ),
      )
      .limit(1);
    if (authPaused) return;
  }
  throw new AppError('conflict', 'This source does not need reconnecting');
}

/** A paused job resumes as `running`, or `queued` when it never started. */
const resumedJobStatus = sql`case when ${importJob.startedAt} is null then 'queued'::import_job_status else 'running'::import_job_status end`;

async function finishReconnect(
  ctx: ServiceContext,
  source: SourceRow,
  saveCredential: (tx: Tx) => Promise<void>,
): Promise<void> {
  const resumed = await withTransaction(async (tx) => {
    await saveCredential(tx);
    await tx
      .update(connectedSource)
      .set({ status: 'connected', pauseReason: null, lastErrorCode: null })
      .where(eq(connectedSource.id, source.id));
    const [job] = await tx
      .update(importJob)
      .set({ status: resumedJobStatus, pauseReason: null })
      .where(
        and(
          eq(importJob.sourceId, source.id),
          eq(importJob.status, 'paused'),
          eq(importJob.pauseReason, 'auth'),
        ),
      )
      .returning({ id: importJob.id });
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'source.reconnected',
        targetType: AUDIT_TARGET,
        targetId: source.id,
      },
      tx,
    );
    return job ?? null;
  });
  await schedulePoll(ctx.userId, source.id);
  if (resumed)
    await imports.enqueuePage({ userId: ctx.userId, sourceId: source.id, importJobId: resumed.id });
}

/** OAuth sources get a new authorize URL (same mailbox required); IMAP takes a new password. */
export async function reconnect(
  ctx: ServiceContext,
  sourceId: string,
  input: { password?: string } = {},
): Promise<{ authorizeUrl: string } | { source: SourceView }> {
  const source = await ownedSource(ctx, sourceId);
  await assertReconnectable(source);
  if (source.type === 'gmail' || source.type === 'microsoft') {
    const { authorizeUrl: url } = await startConnect(
      ctx,
      source.type,
      { from: source.dateRangeFrom, to: source.dateRangeTo },
      { reconnectSourceId: source.id },
    );
    return { authorizeUrl: url };
  }
  if (source.type !== 'imap')
    throw new AppError('conflict', 'This source does not need reconnecting');
  if (!input.password)
    throw new AppError('validation_failed', 'Password is required', { field: 'password' });
  const settings = await loadImapSettings(source.id);
  if (!settings) throw new AppError('conflict', 'This source has no stored IMAP settings');
  const cfg: ImapConfig = { ...settings, password: input.password };
  await verifyImap(cfg);
  await finishReconnect(ctx, source, (tx) => saveImapCredential(tx, source.id, cfg));
  return { source: await view(await ownedSource(ctx, source.id)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Pause, resume, disconnect

/** The in-flight page finishes and checkpoints; no further page runs while paused (SC-011, D-C9). */
export async function pause(ctx: ServiceContext, sourceId: string): Promise<SourceView> {
  const source = await ownedSource(ctx, sourceId);
  if (source.status === 'paused' && source.pauseReason === 'user') return view(source);
  if (source.status !== 'connected')
    throw new AppError('conflict', 'Only a connected source can be paused');
  const updated = await withTransaction(async (tx) => {
    const [row] = await tx
      .update(connectedSource)
      .set({ status: 'paused', pauseReason: 'user' })
      .where(and(eq(connectedSource.id, sourceId), eq(connectedSource.status, 'connected')))
      .returning();
    if (!row) throw new AppError('conflict', 'Only a connected source can be paused');
    await tx
      .update(importJob)
      .set({ status: 'paused', pauseReason: 'user' })
      .where(
        and(eq(importJob.sourceId, sourceId), inArray(importJob.status, ['queued', 'running'])),
      );
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'source.paused',
        targetType: AUDIT_TARGET,
        targetId: sourceId,
      },
      tx,
    );
    return row;
  });
  return view(updated);
}

export async function resume(ctx: ServiceContext, sourceId: string): Promise<SourceView> {
  const source = await ownedSource(ctx, sourceId);
  if (source.status === 'connected') return view(source);
  if (source.status !== 'paused' || source.pauseReason !== 'user') {
    throw new AppError('conflict', 'Only a source paused by you can be resumed');
  }
  const { row, job } = await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(connectedSource)
      .set({ status: 'connected', pauseReason: null })
      .where(
        and(
          eq(connectedSource.id, sourceId),
          eq(connectedSource.status, 'paused'),
          eq(connectedSource.pauseReason, 'user'),
        ),
      )
      .returning();
    if (!updated) throw new AppError('conflict', 'Only a source paused by you can be resumed');
    const [resumed] = await tx
      .update(importJob)
      .set({ status: resumedJobStatus, pauseReason: null })
      .where(
        and(
          eq(importJob.sourceId, sourceId),
          eq(importJob.status, 'paused'),
          eq(importJob.pauseReason, 'user'),
        ),
      )
      .returning({ id: importJob.id });
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'source.resumed',
        targetType: AUDIT_TARGET,
        targetId: sourceId,
      },
      tx,
    );
    return { row: updated, job: resumed ?? null };
  });
  if (job) await imports.enqueuePage({ userId: ctx.userId, sourceId, importJobId: job.id });
  return view(row);
}

/**
 * Stops syncing and drops the credential (Google tokens are revoked best effort). With `deleteContent` the
 * source's content is purged by a `source` deletion request (FR-015).
 *
 * With the hub enabled for the source `hubData` is required (422 `hub_data_choice_required`); it is ignored
 * otherwise. The hub is turned off with that choice stored as `data_choice`. `delete` without `deleteContent`
 * requests a separate `hub_source` deletion and returns its id; with `deleteContent` the hub purge runs inside the
 * `source` request (FR-031).
 */
export async function disconnect(
  ctx: ServiceContext,
  sourceId: string,
  deleteContent: boolean,
  hubData?: HubDataChoice,
): Promise<{ source: SourceView; deletionRequestId: string | null }> {
  const source = await ownedSource(ctx, sourceId);
  if (source.status === 'disconnected')
    throw new AppError('conflict', 'This source is already disconnected');
  const hubEnabled = await hubMail.isMailboxEnabled(ctx, sourceId);
  if (hubEnabled && !hubData) throw new AppError('hub_data_choice_required');
  const hubChoice = hubEnabled ? (hubData ?? null) : null;
  const row = await disconnectSource(ctx, source, deleteContent, hubChoice);
  let deletionRequestId: string | null = null;
  if (deleteContent || hubChoice === 'delete') {
    ({ id: deletionRequestId } = await requestDeletion({
      userId: ctx.userId,
      scope: deleteContent ? 'source' : 'hub_source',
      targetId: sourceId,
      requestedBy: 'user',
    }));
  }
  return { source: await view(row), deletionRequestId };
}

/**
 * Removes a source and its content (DELETE /api/sources/{id}, T145): disconnects when still connected, then
 * requests a `source` deletion. While that request is open the same id is returned again (idempotent).
 *
 * Hub data follows the stored `data_choice`. When the hub is still enabled, `hubData` (default `delete`) is stored
 * first; the hub purge then runs inside the `source` request (FR-031).
 */
export async function remove(
  ctx: ServiceContext,
  sourceId: string,
  hubData?: HubDataChoice,
): Promise<{ deletionRequestId: string }> {
  const source = await ownedSource(ctx, sourceId);
  const [pending] = await getDb()
    .select({ id: deletionRequest.id })
    .from(deletionRequest)
    .where(
      and(
        eq(deletionRequest.userId, ctx.userId),
        eq(deletionRequest.scope, 'source'),
        eq(deletionRequest.targetId, sourceId),
        ne(deletionRequest.status, 'completed'),
      ),
    )
    .orderBy(desc(deletionRequest.requestedAt), desc(deletionRequest.id))
    .limit(1);
  if (pending) return { deletionRequestId: pending.id };
  const hubChoice = (await hubMail.isMailboxEnabled(ctx, sourceId)) ? (hubData ?? 'delete') : null;
  if (source.status !== 'disconnected') await disconnectSource(ctx, source, true, hubChoice);
  else if (hubChoice) await withTransaction((tx) => disableHub(ctx, sourceId, hubChoice, tx));
  const { id } = await requestDeletion({
    userId: ctx.userId,
    scope: 'source',
    targetId: sourceId,
    requestedBy: 'user',
  });
  return { deletionRequestId: id };
}

/** Turns the hub off for the source with the data choice stored (as `hub/mailboxes.disable` does). */
async function disableHub(
  ctx: ServiceContext,
  sourceId: string,
  hubData: HubDataChoice,
  tx: Tx,
): Promise<void> {
  await hubMail.disableMailbox(ctx, sourceId, hubData, tx);
  await audit.record(
    {
      actorType: 'user',
      actorUserId: ctx.userId,
      action: 'hub.mailbox_disabled',
      targetType: AUDIT_TARGET,
      targetId: sourceId,
      metadata: { sourceId, hubData },
    },
    tx,
  );
}

/**
 * Disconnect steps shared by `disconnect` and `remove`; the caller requests the content deletion. A `hubData`
 * choice turns the hub off in the same transaction.
 */
async function disconnectSource(
  ctx: ServiceContext,
  source: SourceRow,
  deleteContent: boolean,
  hubData: HubDataChoice | null = null,
): Promise<SourceRow> {
  const sourceId = source.id;
  const revokeToken =
    source.type === 'gmail' ? await loadRevocableToken(sourceId).catch(() => null) : null;
  const now = new Date();
  const row = await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(connectedSource)
      .set({ status: 'disconnected', pauseReason: null, disconnectedAt: now })
      .where(and(eq(connectedSource.id, sourceId), ne(connectedSource.status, 'disconnected')))
      .returning();
    if (!updated) throw new AppError('conflict', 'This source is already disconnected');
    await tx
      .update(importJob)
      .set({ status: 'cancelled', pauseReason: null, finishedAt: now })
      .where(
        and(eq(importJob.sourceId, sourceId), inArray(importJob.status, NON_TERMINAL_STATUSES)),
      );
    await tx.delete(mailboxCredential).where(eq(mailboxCredential.sourceId, sourceId));
    await tx.delete(oauthConnectState).where(eq(oauthConnectState.reconnectSourceId, sourceId));
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'source.disconnected',
        targetType: AUDIT_TARGET,
        targetId: sourceId,
        metadata: { deleteContent },
      },
      tx,
    );
    if (hubData) await disableHub(ctx, sourceId, hubData, tx);
    return updated;
  });

  await removeScheduler(QUEUES.syncPoll, jobIds.poll(sourceId));
  if (revokeToken) await revokeGoogleToken(revokeToken).catch(() => undefined);
  return row;
}

/** Worker path on `MailAuthError`: no-op unless the source is still connected. */
export async function markNeedsReconnection(sourceId: string, errorCode: string): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(connectedSource)
      .set({ status: 'needs_reconnection', lastErrorCode: errorCode })
      .where(and(eq(connectedSource.id, sourceId), eq(connectedSource.status, 'connected')))
      .returning({ userId: connectedSource.userId });
    if (!row) return;
    await tx
      .update(importJob)
      .set({ status: 'paused', pauseReason: 'auth' })
      .where(
        and(eq(importJob.sourceId, sourceId), inArray(importJob.status, ['queued', 'running'])),
      );
    await notify(row.userId, 'source_needs_reconnection', { sourceId }, tx);
    await audit.record(
      {
        actorType: 'system',
        action: 'source.needs_reconnection',
        targetType: AUDIT_TARGET,
        targetId: sourceId,
        // Codes are internal identifiers; anything else is dropped rather than failing the audit write.
        metadata: /^[a-z0-9_.-]{1,64}$/.test(errorCode) ? { errorCode } : {},
      },
      tx,
    );
  });
}
