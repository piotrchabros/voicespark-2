import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLogEntry,
  closeDb,
  connectedSource,
  contentItem,
  deletionRequest,
  draft,
  exclusionRule,
  getDb,
  getPool,
  importJob,
  mailboxCredential,
  notification,
  session,
  toneProfile,
  upload,
  user,
  withTransaction,
} from '@voicespark/db';
import { and, eq, inArray, or } from 'drizzle-orm';
import { decrypt, subjectRef } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { QUEUES, enqueue, removeScheduler } from '@voicespark/core/queues';
import * as contentItems from '@voicespark/core/services/content-items';
import * as deletion from '@voicespark/core/services/deletion';
import * as profiles from '@voicespark/core/services/profiles';
import { saveImapCredential, saveOAuthCredential } from '@voicespark/core/services/mail-access';
import * as sources from '@voicespark/core/services/sources';
import type { FilteredText } from '@voicespark/filters';
import { renderAccountDeletedEmail } from '@voicespark/integrations/smtp';
import { InMemoryMemoryStore, META, namespaceFor } from '@voicespark/integrations/supermemory';
import {
  choose,
  cleanupProfiles,
  createUser,
  ensureActivePrompt,
  insertVersion,
  sampleBody,
  sampleDocument,
  seedAuthoredContent,
  seedDefinition,
} from './helpers/profiles';

// US7 core (T142, T144, T145 core): account deletion request + execution, owner deletion view, source and
// content-item removal, completion notifications. Queues are mocked; the memory store is in-memory.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));
// Never reach Google from a test: every revoke goes through the injected fake or this mock.
vi.mock('@voicespark/integrations/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/integrations/oauth')>()),
  revokeGoogleToken: vi.fn(async () => undefined),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const APP_URL = 'http://app.test';
const ft = (s: string) => s as FilteredText;

/** Every user created here (helpers track theirs too); account requests survive the cascade with user_id null. */
const accountUserIds: string[] = [];
let displacedAdminIds: string[] = [];

async function newCtx(role: 'user' | 'admin' = 'user'): Promise<ServiceContext> {
  const userId = await createUser('Delete Me');
  accountUserIds.push(userId);
  if (role === 'admin') await getDb().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  return { userId, role };
}

async function emailOf(userId: string): Promise<string> {
  const [row] = await getDb().select({ email: user.email }).from(user).where(eq(user.id, userId));
  return row!.email;
}

async function addSessions(userId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await getDb()
      .insert(session)
      .values({ userId, token: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) });
  }
}

async function createMailSource(
  userId: string,
  type: 'imap' | 'gmail',
  status: 'connected' | 'disconnected' = 'connected',
): Promise<string> {
  const [row] = await getDb()
    .insert(connectedSource)
    .values({
      userId,
      type,
      accountLabel: `${type} box`,
      accountAddress: `${randomUUID()}@example.test`,
      status,
      consentTextVersion: 'v1',
    })
    .returning({ id: connectedSource.id });
  const sourceId = row!.id;
  if (type === 'gmail') {
    await saveOAuthCredential(getDb(), sourceId, {
      accessToken: 'access-tok',
      refreshToken: `refresh-${sourceId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
  } else {
    await saveImapCredential(getDb(), sourceId, {
      host: 'imap.example.test',
      port: 993,
      tlsMode: 'tls',
      username: 'someone',
      password: 'imap-secret',
    });
  }
  return sourceId;
}

const credentialRows = (sourceIds: string[]) =>
  getDb().select().from(mailboxCredential).where(inArray(mailboxCredential.sourceId, sourceIds));

async function findRequest(id: string) {
  const [row] = await getDb().select().from(deletionRequest).where(eq(deletionRequest.id, id));
  return row;
}

async function expectCode(p: Promise<unknown>, code: string, status?: number): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status !== undefined) expect((err as AppError).status).toBe(status);
  return err as AppError;
}

/** listDocuments, treating a thrown "namespace not found" as empty (R19 verify step). */
async function docIds(store: InMemoryMemoryStore, userId: string): Promise<string[]> {
  try {
    const res = await store.listDocuments(namespaceFor(userId), { page: 1, limit: 100 });
    return res.documents.map((d) => d.id);
  } catch {
    return [];
  }
}

function fakeMailer() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const send = vi.fn(async (msg: { to: string; subject: string; text: string }) => {
    sent.push(msg);
  });
  return { mailer: { send }, sent };
}

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
  vi.mocked(removeScheduler).mockClear();
});

afterAll(async () => {
  if (displacedAdminIds.length > 0) {
    await getDb().update(user).set({ role: 'admin' }).where(inArray(user.id, displacedAdminIds));
  }
  if (accountUserIds.length > 0) {
    await getDb()
      .delete(deletionRequest)
      .where(or(inArray(deletionRequest.userId, accountUserIds), inArray(deletionRequest.targetId, accountUserIds)));
    await getDb()
      .delete(auditLogEntry)
      .where(inArray(auditLogEntry.subjectRef, accountUserIds.map((id) => subjectRef(id))));
  }
  await cleanupProfiles();
  await closeDb();
});

// ---------------------------------------------------------------------------------------------------------------------

describe('requestAccountDeletion', () => {
  it('marks the user pending_deletion, revokes sessions, captures the email, audits and enqueues', async () => {
    const ctx = await newCtx();
    const email = await emailOf(ctx.userId);
    await addSessions(ctx.userId, 2);

    const { deletionRequestId } = await deletion.requestAccountDeletion(ctx);

    const [u] = await getDb().select().from(user).where(eq(user.id, ctx.userId));
    expect(u!.status).toBe('pending_deletion');
    expect(await getDb().select().from(session).where(eq(session.userId, ctx.userId))).toHaveLength(0);

    const row = await findRequest(deletionRequestId);
    expect(row).toMatchObject({
      userId: ctx.userId,
      scope: 'account',
      targetId: ctx.userId,
      requestedBy: 'user',
      status: 'pending',
    });
    expect(row!.notifyEmailEnc).not.toBeNull();
    expect(row!.notifyEmailEnc).not.toContain(email);
    expect(decrypt('user-content', row!.notifyEmailEnc!)).toBe(email);

    const audits = await getDb()
      .select()
      .from(auditLogEntry)
      .where(and(eq(auditLogEntry.action, 'account.deletion_requested'), eq(auditLogEntry.targetId, ctx.userId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.subjectRef).toBe(subjectRef(ctx.userId));
    expect(JSON.stringify(audits[0]!.metadata ?? {})).not.toContain(email);

    expect(enqueue).toHaveBeenCalledWith(
      'deletion.execute',
      { deletionRequestId },
      { jobId: `deletion-${deletionRequestId}` },
    );
  });

  it('is idempotent while pending: a second call returns the existing request id', async () => {
    const ctx = await newCtx();
    const first = await deletion.requestAccountDeletion(ctx);
    const second = await deletion.requestAccountDeletion(ctx);
    expect(second.deletionRequestId).toBe(first.deletionRequestId);
    const rows = await getDb()
      .select()
      .from(deletionRequest)
      .where(and(eq(deletionRequest.targetId, ctx.userId), eq(deletionRequest.scope, 'account')));
    expect(rows).toHaveLength(1);
  });

  describe('last-admin protection (assertNotLastActiveAdmin)', () => {
    beforeAll(async () => {
      const others = await getDb()
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.role, 'admin'), eq(user.status, 'active')));
      displacedAdminIds = others.map((r) => r.id);
      if (displacedAdminIds.length > 0) {
        await getDb().update(user).set({ role: 'user' }).where(inArray(user.id, displacedAdminIds));
      }
    });

    afterAll(async () => {
      if (displacedAdminIds.length > 0) {
        await getDb().update(user).set({ role: 'admin' }).where(inArray(user.id, displacedAdminIds));
        displacedAdminIds = [];
      }
    });

    it('refuses the last active admin with 409 last_admin and changes nothing', async () => {
      const ctx = await newCtx('admin');
      await addSessions(ctx.userId, 1);

      await expectCode(deletion.requestAccountDeletion(ctx), 'last_admin', 409);

      const [u] = await getDb().select().from(user).where(eq(user.id, ctx.userId));
      expect(u!.status).toBe('active');
      expect(await getDb().select().from(session).where(eq(session.userId, ctx.userId))).toHaveLength(1);
      expect(
        await getDb().select().from(deletionRequest).where(eq(deletionRequest.targetId, ctx.userId)),
      ).toHaveLength(0);
      expect(
        await getDb()
          .select()
          .from(auditLogEntry)
          .where(and(eq(auditLogEntry.action, 'account.deletion_requested'), eq(auditLogEntry.targetId, ctx.userId))),
      ).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();

      // Demote it again so the next case controls the admin set itself.
      await getDb().update(user).set({ role: 'user' }).where(eq(user.id, ctx.userId));
    });

    it('lets an admin delete their account when another active admin remains', async () => {
      const other = await newCtx('admin');
      const ctx = await newCtx('admin');
      const { deletionRequestId } = await deletion.requestAccountDeletion(ctx);
      expect((await findRequest(deletionRequestId))!.scope).toBe('account');
      const [u] = await getDb().select().from(user).where(eq(user.id, ctx.userId));
      expect(u!.status).toBe('pending_deletion');
      await getDb().update(user).set({ role: 'user' }).where(inArray(user.id, [other.userId, ctx.userId]));
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('executeDeletion (account scope)', () => {
  it('runs R19: disconnect, revoke, credentials, namespace, verify, cascade, email once, pseudonymize, audit', async () => {
    const store = new InMemoryMemoryStore();
    const deleteNamespace = vi.spyOn(store, 'deleteNamespace');
    const ctx = await newCtx();
    const email = await emailOf(ctx.userId);

    const gmailId = await createMailSource(ctx.userId, 'gmail');
    const imapId = await createMailSource(ctx.userId, 'imap');
    const { sourceId: uploadsId, itemIds } = await seedAuthoredContent({
      userId: ctx.userId,
      items: [{ text: 'first authored note' }, { text: 'second authored note' }],
      store,
    });
    const def = await seedDefinition();
    const profileId = await choose(ctx.userId, def.definitionId);
    const promptId = await ensureActivePrompt('tone_profile.generate');
    const versionId = await insertVersion({
      profileId,
      body: sampleBody(itemIds[0]!),
      definitionVersionId: def.versionId,
      promptVersionId: promptId,
    });
    const draftPromptId = await ensureActivePrompt('draft.social_post');
    await getPool().query(
      `insert into draft (user_id, content_type, profile_id, profile_version_id, prompt_version_id, topic_enc, brief_enc)
       values ($1, 'social_post', $2, $3, $4, 'x', 'x')`,
      [ctx.userId, profileId, versionId, draftPromptId],
    );
    await getDb().insert(exclusionRule).values({ userId: ctx.userId, type: 'keyword', value: 'zephyr' });
    await getDb().insert(notification).values({ userId: ctx.userId, type: 'import_completed', payload: {} });

    // Another user's namespace is never touched.
    const bystander = await newCtx();
    await store.addDocuments(namespaceFor(bystander.userId), [
      { id: randomUUID(), content: ft('bystander doc'), documentDate: new Date().toISOString(), metadata: {} },
    ]);

    const { deletionRequestId } = await deletion.requestAccountDeletion(ctx);
    const { mailer, sent } = fakeMailer();
    const revoke = vi.fn(async () => undefined);

    const result = await deletion.executeDeletion(deletionRequestId, store, {
      deps: { mailer, revokeGoogleToken: revoke, appUrl: APP_URL },
    });

    expect(result).toMatchObject({ outcome: 'completed', scope: 'account' });
    // Memory store: namespace emptied and verified; the bystander keeps its document.
    expect(await docIds(store, ctx.userId)).toEqual([]);
    expect(await docIds(store, bystander.userId)).toHaveLength(1);
    expect(deleteNamespace).toHaveBeenCalledWith(namespaceFor(ctx.userId));
    // Google mail token revoked, every mailbox credential gone, poll schedulers removed.
    expect(revoke).toHaveBeenCalledWith(`refresh-${gmailId}`);
    expect(await credentialRows([gmailId, imapId])).toHaveLength(0);
    expect(removeScheduler).toHaveBeenCalledWith(QUEUES.syncPoll, `poll-${gmailId}`);
    expect(removeScheduler).toHaveBeenCalledWith(QUEUES.syncPoll, `poll-${imapId}`);
    // User row gone; everything owned cascades.
    expect(await getDb().select().from(user).where(eq(user.id, ctx.userId))).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(connectedSource)
        .where(inArray(connectedSource.id, [gmailId, imapId, uploadsId])),
    ).toHaveLength(0);
    expect(await getDb().select().from(contentItem).where(inArray(contentItem.id, itemIds))).toHaveLength(0);
    expect(await getDb().select().from(toneProfile).where(eq(toneProfile.id, profileId))).toHaveLength(0);
    expect(await getDb().select().from(draft).where(eq(draft.userId, ctx.userId))).toHaveLength(0);
    expect(await getDb().select().from(exclusionRule).where(eq(exclusionRule.userId, ctx.userId))).toHaveLength(0);
    expect(await getDb().select().from(notification).where(eq(notification.userId, ctx.userId))).toHaveLength(0);
    // Confirmation email sent once to the captured address; the address is then removed.
    expect(sent).toEqual([{ to: email, ...renderAccountDeletedEmail(APP_URL) }]);
    const row = await findRequest(deletionRequestId);
    expect(row!.status).toBe('completed');
    expect(row!.completedAt).toBeInstanceOf(Date);
    expect(row!.notifyEmailEnc).toBeNull();
    expect(row!.targetId).toBe(ctx.userId);
    // Audit: unlinked from the user id; `account.deleted` carries only the subject ref.
    const linked = await getDb()
      .select()
      .from(auditLogEntry)
      .where(or(eq(auditLogEntry.targetId, ctx.userId), eq(auditLogEntry.actorUserId, ctx.userId)));
    expect(linked).toHaveLength(0);
    const deleted = await getDb()
      .select()
      .from(auditLogEntry)
      .where(and(eq(auditLogEntry.action, 'account.deleted'), eq(auditLogEntry.subjectRef, subjectRef(ctx.userId))));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.actorUserId).toBeNull();
    expect(JSON.stringify(deleted[0]!.metadata ?? {})).not.toContain(email);

    // Idempotent re-run: nothing is sent or deleted again.
    const again = await deletion.executeDeletion(deletionRequestId, store, {
      deps: { mailer, revokeGoogleToken: revoke, appUrl: APP_URL },
    });
    expect(again.outcome).toBe('noop');
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(deleteNamespace).toHaveBeenCalledTimes(1);
  });

  it('a mail failure fails the attempt; the retry sends exactly one email without deleting twice', async () => {
    const store = new InMemoryMemoryStore();
    const deleteNamespace = vi.spyOn(store, 'deleteNamespace');
    const ctx = await newCtx();
    const email = await emailOf(ctx.userId);
    await seedAuthoredContent({ userId: ctx.userId, items: [{ text: 'some note' }], store });
    const { deletionRequestId } = await deletion.requestAccountDeletion(ctx);

    const sent: string[] = [];
    const send = vi
      .fn(async (msg: { to: string }) => {
        sent.push(msg.to);
      })
      .mockRejectedValueOnce(new Error('smtp down'));
    const deps = { mailer: { send }, revokeGoogleToken: vi.fn(async () => undefined), appUrl: APP_URL };

    await expect(deletion.executeDeletion(deletionRequestId, store, { deps })).rejects.toThrow();
    const mid = await findRequest(deletionRequestId);
    expect(mid!.status).not.toBe('completed');
    expect(mid!.notifyEmailEnc).not.toBeNull();

    const result = await deletion.executeDeletion(deletionRequestId, store, { deps });
    expect(result).toMatchObject({ outcome: 'completed', scope: 'account' });
    expect(sent).toEqual([email]);
    expect(deleteNamespace).toHaveBeenCalledTimes(1);
    const done = await findRequest(deletionRequestId);
    expect(done!.status).toBe('completed');
    expect(done!.notifyEmailEnc).toBeNull();
  });

  it('waits for a running import (wait_import), then gives up after ACCOUNT_WAIT_MAX waits', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = await newCtx();
    const sourceId = await createMailSource(ctx.userId, 'imap');
    await getDb().insert(importJob).values({ userId: ctx.userId, sourceId, kind: 'initial', status: 'running' });
    const { deletionRequestId } = await deletion.requestAccountDeletion(ctx);
    const { mailer } = fakeMailer();
    const deps = { mailer, revokeGoogleToken: vi.fn(async () => undefined), appUrl: APP_URL };

    const result = await deletion.executeDeletion(deletionRequestId, store, { waitCount: 0, deps });
    expect(result).toEqual({ outcome: 'wait_import' });
    expect(await getDb().select().from(user).where(eq(user.id, ctx.userId))).toHaveLength(1);
    expect(mailer.send).not.toHaveBeenCalled();

    expect(deletion.ACCOUNT_WAIT_MAX).toBe(10);
    const err = await deletion
      .executeDeletion(deletionRequestId, store, { waitCount: deletion.ACCOUNT_WAIT_MAX, deps })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(deletion.DeletionError);
    expect((err as InstanceType<typeof deletion.DeletionError>).code).toBe('account_import_running');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('getForUser', () => {
  it('returns the owner view with exactly the contract fields; anyone else gets not_found', async () => {
    const ctx = await newCtx();
    const other = await newCtx();
    const { id } = await deletion.requestDeletion({
      userId: ctx.userId,
      scope: 'content_item',
      targetId: randomUUID(),
      requestedBy: 'user',
    });

    const view = await deletion.getForUser(ctx, id);
    expect(Object.keys(view).sort()).toEqual(['completedAt', 'dueBy', 'id', 'requestedAt', 'scope', 'status']);
    expect(view).toMatchObject({ id, scope: 'content_item', status: 'pending', completedAt: null });
    expect(new Date(view.requestedAt).toISOString()).toBe(view.requestedAt);
    expect(new Date(view.dueBy).getTime() - new Date(view.requestedAt).getTime()).toBe(24 * 60 * 60 * 1000);

    await expectCode(deletion.getForUser(other, id), 'not_found');
    await expectCode(deletion.getForUser(ctx, randomUUID()), 'not_found');
    await expectCode(deletion.getForUser(ctx, 'not-a-uuid'), 'not_found');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('sources.remove', () => {
  it('disconnects, deletes the credential, removes the scheduler and requests a source deletion', async () => {
    const ctx = await newCtx();
    const sourceId = await createMailSource(ctx.userId, 'imap');

    const { deletionRequestId } = await sources.remove(ctx, sourceId);

    const [src] = await getDb().select().from(connectedSource).where(eq(connectedSource.id, sourceId));
    expect(src!.status).toBe('disconnected');
    expect(await credentialRows([sourceId])).toHaveLength(0);
    expect(removeScheduler).toHaveBeenCalledWith(QUEUES.syncPoll, `poll-${sourceId}`);
    expect(await findRequest(deletionRequestId)).toMatchObject({
      userId: ctx.userId,
      scope: 'source',
      targetId: sourceId,
      requestedBy: 'user',
      status: 'pending',
    });
    expect(enqueue).toHaveBeenCalledWith(
      'deletion.execute',
      { deletionRequestId },
      { jobId: `deletion-${deletionRequestId}` },
    );
    const audits = await getDb()
      .select()
      .from(auditLogEntry)
      .where(and(eq(auditLogEntry.action, 'source.disconnected'), eq(auditLogEntry.targetId, sourceId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ deleteContent: true });

    // The source stays readable until the deletion completes.
    expect((await sources.get(ctx, sourceId)).status).toBe('disconnected');

    // A second call returns the same pending request.
    const again = await sources.remove(ctx, sourceId);
    expect(again.deletionRequestId).toBe(deletionRequestId);
    expect(
      await getDb()
        .select()
        .from(deletionRequest)
        .where(and(eq(deletionRequest.targetId, sourceId), eq(deletionRequest.scope, 'source'))),
    ).toHaveLength(1);
  });

  it('works for an already disconnected source (no conflict)', async () => {
    const ctx = await newCtx();
    const sourceId = await createMailSource(ctx.userId, 'imap', 'disconnected');
    const { deletionRequestId } = await sources.remove(ctx, sourceId);
    expect((await findRequest(deletionRequestId))!.scope).toBe('source');
  });

  it('returns not_found for a foreign or unknown source and changes nothing', async () => {
    const owner = await newCtx();
    const other = await newCtx();
    const sourceId = await createMailSource(owner.userId, 'imap');
    await expectCode(sources.remove(other, sourceId), 'not_found');
    await expectCode(sources.remove(other, randomUUID()), 'not_found');
    const [src] = await getDb().select().from(connectedSource).where(eq(connectedSource.id, sourceId));
    expect(src!.status).toBe('connected');
    expect(await credentialRows([sourceId])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('contentItems.remove', () => {
  it('requests a content_item deletion for an active item and audits the request', async () => {
    const ctx = await newCtx();
    const { itemIds } = await seedAuthoredContent({ userId: ctx.userId, items: [{ text: 'a note' }] });

    const { deletionRequestId } = await contentItems.remove(ctx, itemIds[0]!);

    expect(await findRequest(deletionRequestId)).toMatchObject({
      userId: ctx.userId,
      scope: 'content_item',
      targetId: itemIds[0],
      requestedBy: 'user',
    });
    const audits = await getDb()
      .select()
      .from(auditLogEntry)
      .where(and(eq(auditLogEntry.action, 'content.deletion_requested'), eq(auditLogEntry.actorUserId, ctx.userId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ scope: 'content_item' });
  });

  it('refuses an item already pending deletion with conflict', async () => {
    const ctx = await newCtx();
    const { itemIds } = await seedAuthoredContent({ userId: ctx.userId, items: [{ text: 'a note' }] });
    await getDb().update(contentItem).set({ status: 'pending_deletion' }).where(eq(contentItem.id, itemIds[0]!));
    await expectCode(contentItems.remove(ctx, itemIds[0]!), 'conflict');
  });

  it('returns not_found for a foreign, unknown or malformed id', async () => {
    const owner = await newCtx();
    const other = await newCtx();
    const { itemIds } = await seedAuthoredContent({ userId: owner.userId, items: [{ text: 'a note' }] });
    await expectCode(contentItems.remove(other, itemIds[0]!), 'not_found');
    await expectCode(contentItems.remove(owner, randomUUID()), 'not_found');
    await expectCode(contentItems.remove(owner, 'nope'), 'not_found');
    expect(
      await getDb().select().from(deletionRequest).where(eq(deletionRequest.targetId, itemIds[0]!)),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('completion of user-requested content_item and source deletions', () => {
  it('content_item: notifies deletion_completed, deletes upload rows of the purged item, audits content.purged', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = await newCtx();
    const { sourceId, itemIds } = await seedAuthoredContent({
      userId: ctx.userId,
      items: [{ text: 'uploaded note' }],
      store,
    });
    const [up] = await getDb()
      .insert(upload)
      .values({ userId: ctx.userId, sourceId, kind: 'note', status: 'stored', contentItemId: itemIds[0]! })
      .returning({ id: upload.id });

    const { deletionRequestId } = await contentItems.remove(ctx, itemIds[0]!);
    const result = await deletion.executeDeletion(deletionRequestId, store);

    expect(result).toMatchObject({ outcome: 'completed', scope: 'content_item' });
    expect(await store.getDocument(namespaceFor(ctx.userId), itemIds[0]!)).toBeNull();
    expect(await getDb().select().from(upload).where(eq(upload.id, up!.id))).toHaveLength(0);
    const notes = await getDb()
      .select()
      .from(notification)
      .where(and(eq(notification.userId, ctx.userId), eq(notification.type, 'deletion_completed')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload).toEqual({ deletionRequestId, scope: 'content_item' });
    const purged = await getDb()
      .select()
      .from(auditLogEntry)
      .where(and(eq(auditLogEntry.action, 'content.purged'), eq(auditLogEntry.subjectRef, subjectRef(ctx.userId))));
    expect(purged.map((a) => a.metadata)).toContainEqual({ scope: 'content_item', count: 1 });
  });

  it('source: notifies deletion_completed with scope source', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = await newCtx();
    const sourceId = await createMailSource(ctx.userId, 'imap');
    const { itemIds } = await seedAuthoredContent({
      userId: ctx.userId,
      sourceId,
      items: [{ text: 'mail body' }],
      store,
    });

    const { deletionRequestId } = await sources.remove(ctx, sourceId);
    const result = await deletion.executeDeletion(deletionRequestId, store);

    expect(result).toMatchObject({ outcome: 'completed', scope: 'source' });
    expect(await store.getDocument(namespaceFor(ctx.userId), itemIds[0]!)).toBeNull();
    const notes = await getDb()
      .select()
      .from(notification)
      .where(and(eq(notification.userId, ctx.userId), eq(notification.type, 'deletion_completed')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload).toEqual({ deletionRequestId, scope: 'source' });
  });

  it('system-requested content_item deletions do not notify the user', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = await newCtx();
    const { itemIds } = await seedAuthoredContent({ userId: ctx.userId, items: [{ text: 'x y z' }], store });
    await store.updateDocumentMetadata(namespaceFor(ctx.userId), itemIds[0]!, {
      [META.contentItemId]: itemIds[0]!,
    });
    const { id } = await deletion.requestDeletion({
      userId: ctx.userId,
      scope: 'content_item',
      targetId: itemIds[0]!,
      requestedBy: 'system',
    });
    await deletion.executeDeletion(id, store);
    expect(
      await getDb()
        .select()
        .from(notification)
        .where(and(eq(notification.userId, ctx.userId), eq(notification.type, 'deletion_completed'))),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 002: excerpts of deleted items are scrubbed from every profile version (T045, FR-023)

async function profileWithVersions(
  userId: string,
  bodies: { body: Parameters<typeof insertVersion>[0]['body']; format: 'structured' | 'document' }[],
): Promise<{ profileId: string; versionIds: string[] }> {
  const def = await seedDefinition();
  const profileId = await choose(userId, def.definitionId);
  const promptVersionId = await ensureActivePrompt('tone_profile.generate');
  const versionIds: string[] = [];
  for (const b of bodies) {
    versionIds.push(
      await insertVersion({
        profileId,
        body: b.body,
        format: b.format,
        promptSource: b.format === 'document' ? 'default' : null,
        definitionVersionId: def.versionId,
        promptVersionId,
      }),
    );
  }
  return { profileId, versionIds };
}

/** A two-aspect document whose first excerpt quotes `first` and second quotes `second`. */
function mixedDocument(first: string, second: string) {
  const doc = sampleDocument(first);
  doc.excerpts[1]!.contentItemId = second;
  return doc;
}

async function bodyOf(versionId: string): Promise<{ enc: string; body: { excerpts: { contentItemId: string }[] } }> {
  const { rows } = await getPool().query<{ body_enc: string }>('select body_enc from profile_version where id = $1', [
    versionId,
  ]);
  return { enc: rows[0]!.body_enc, body: JSON.parse(decrypt('user-content', rows[0]!.body_enc)) };
}

async function profileState(profileId: string, userId: string) {
  const { rows } = await getPool().query<{ outdated_reason: string | null }>(
    'select outdated_reason from tone_profile where id = $1',
    [profileId],
  );
  const notes = await getDb()
    .select()
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.type, 'profile_outdated')));
  return { outdatedReason: rows[0]!.outdated_reason, notes: notes.map((n) => n.payload) };
}

describe('profiles.scrubDeletedExcerpts', () => {
  it('drops deleted excerpts from document and legacy versions, re-encrypts, marks and notifies once', async () => {
    const ctx = await newCtx();
    const { itemIds } = await seedAuthoredContent({ userId: ctx.userId, items: [{ text: 'a b c' }, { text: 'd e f' }] });
    const [gone, kept] = itemIds as [string, string];
    const { profileId, versionIds } = await profileWithVersions(ctx.userId, [
      { body: sampleBody(gone), format: 'structured' },
      { body: mixedDocument(gone, kept), format: 'document' },
    ]);
    const before = await bodyOf(versionIds[1]!);

    const result = await withTransaction((tx) => profiles.scrubDeletedExcerpts(tx, ctx.userId, [gone]));
    expect(result).toEqual({ versionsChanged: 2, profilesOutdated: 1 });

    expect((await bodyOf(versionIds[0]!)).body.excerpts).toEqual([]);
    const after = await bodyOf(versionIds[1]!);
    expect(after.body.excerpts.map((e) => e.contentItemId)).toEqual([kept]);
    expect(after.enc).not.toBe(before.enc);
    expect(after.enc.split('.')[1]).toBe(process.env.ENCRYPTION_ACTIVE_KEY_ID);
    expect(await profileState(profileId, ctx.userId)).toEqual({
      outdatedReason: 'sources_deleted',
      notes: [{ profileId, reason: 'sources_deleted' }],
    });

    // Idempotent: nothing left to drop, no second notification.
    const again = await withTransaction((tx) => profiles.scrubDeletedExcerpts(tx, ctx.userId, [gone]));
    expect(again).toEqual({ versionsChanged: 0, profilesOutdated: 0 });
    expect((await profileState(profileId, ctx.userId)).notes).toHaveLength(1);
  });

  it('scrubs earlier versions without marking the profile when the latest is unchanged', async () => {
    const ctx = await newCtx();
    const { itemIds } = await seedAuthoredContent({ userId: ctx.userId, items: [{ text: 'a b c' }, { text: 'd e f' }] });
    const [gone, kept] = itemIds as [string, string];
    const { profileId, versionIds } = await profileWithVersions(ctx.userId, [
      { body: sampleDocument(gone), format: 'document' },
      { body: sampleDocument(kept), format: 'document' },
    ]);
    const latestBefore = await bodyOf(versionIds[1]!);

    const result = await withTransaction((tx) => profiles.scrubDeletedExcerpts(tx, ctx.userId, [gone]));
    expect(result).toEqual({ versionsChanged: 1, profilesOutdated: 0 });
    expect((await bodyOf(versionIds[0]!)).body.excerpts).toEqual([]);
    expect((await bodyOf(versionIds[1]!)).enc).toBe(latestBefore.enc);
    expect(await profileState(profileId, ctx.userId)).toEqual({ outdatedReason: null, notes: [] });
  });

  it('never touches another user\'s versions', async () => {
    const ctx = await newCtx();
    const other = await newCtx();
    const { itemIds } = await seedAuthoredContent({ userId: other.userId, items: [{ text: 'a b c' }] });
    const { versionIds } = await profileWithVersions(other.userId, [
      { body: sampleDocument(itemIds[0]!), format: 'document' },
    ]);
    const before = await bodyOf(versionIds[0]!);
    const result = await withTransaction((tx) => profiles.scrubDeletedExcerpts(tx, ctx.userId, [itemIds[0]!]));
    expect(result).toEqual({ versionsChanged: 0, profilesOutdated: 0 });
    expect((await bodyOf(versionIds[0]!)).enc).toBe(before.enc);
  });

  it('runs in the content_item purge finalize', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = await newCtx();
    const { itemIds } = await seedAuthoredContent({
      userId: ctx.userId,
      items: [{ text: 'a b c' }, { text: 'd e f' }],
      store,
    });
    const [gone, kept] = itemIds as [string, string];
    const { profileId, versionIds } = await profileWithVersions(ctx.userId, [
      { body: mixedDocument(gone, kept), format: 'document' },
    ]);

    const { deletionRequestId } = await contentItems.remove(ctx, gone);
    await deletion.executeDeletion(deletionRequestId, store);

    expect((await bodyOf(versionIds[0]!)).body.excerpts.map((e) => e.contentItemId)).toEqual([kept]);
    expect(await profileState(profileId, ctx.userId)).toEqual({
      outdatedReason: 'sources_deleted',
      notes: [{ profileId, reason: 'sources_deleted' }],
    });
  });

  it('runs in deleteSource for the items exclusive to the source', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = await newCtx();
    const sourceId = await createMailSource(ctx.userId, 'imap');
    const { itemIds } = await seedAuthoredContent({ userId: ctx.userId, sourceId, items: [{ text: 'mail body' }], store });
    const { itemIds: keptIds } = await seedAuthoredContent({ userId: ctx.userId, items: [{ text: 'a note' }], store });
    const { profileId, versionIds } = await profileWithVersions(ctx.userId, [
      { body: sampleBody(keptIds[0]!), format: 'structured' },
      { body: mixedDocument(itemIds[0]!, keptIds[0]!), format: 'document' },
    ]);

    const { deletionRequestId } = await sources.remove(ctx, sourceId);
    await deletion.executeDeletion(deletionRequestId, store);

    expect((await bodyOf(versionIds[0]!)).body.excerpts).toHaveLength(3);
    expect((await bodyOf(versionIds[1]!)).body.excerpts.map((e) => e.contentItemId)).toEqual([keptIds[0]]);
    expect(await profileState(profileId, ctx.userId)).toEqual({
      outdatedReason: 'sources_deleted',
      notes: [{ profileId, reason: 'sources_deleted' }],
    });
  });
});
