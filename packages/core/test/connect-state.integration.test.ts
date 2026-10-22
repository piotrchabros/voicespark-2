import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  connectedSource,
  FILTER_CATEGORIES,
  getDb,
  getPool,
  mailboxCredential,
  oauthConnectState,
  user,
} from '@voicespark/db';
import { eq, inArray } from 'drizzle-orm';
import { exchangeCode } from '@voicespark/integrations/oauth';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import * as sources from '@voicespark/core/services/sources';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';

// OI-7: completeConnect's state checks against the real DB. The provider code exchange and the Gmail profile
// lookup are stubbed so no network is used; queues are mocked.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

vi.mock('@voicespark/integrations/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voicespark/integrations/oauth')>();
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: [actual.GMAIL_READONLY_SCOPE],
    })),
    revokeGoogleToken: vi.fn(async () => undefined),
  };
});

const mailboxAddress = { value: '' };
vi.mock('@voicespark/integrations/gmail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/integrations/gmail')>()),
  createGmailClient: vi.fn(() => ({ getProfile: async () => ({ emailAddress: mailboxAddress.value }) })),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';
process.env.GOOGLE_MAIL_CLIENT_ID ??= 'test-client';
process.env.GOOGLE_MAIL_CLIENT_SECRET ??= 'test-secret';
process.env.APP_URL ??= 'http://localhost:3000';

const userIds: string[] = [];

async function createUser(): Promise<ServiceContext> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Connect', email: `connect-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  const ctx: ServiceContext = { userId: row!.id, role: 'user' };
  await filterPrefs.update(ctx, [...FILTER_CATEGORIES]);
  return ctx;
}

async function startGmail(ctx: ServiceContext): Promise<string> {
  const start = await sources.startConnect(ctx, 'gmail');
  const state = new URL(start.authorizeUrl).searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

async function rows(userId: string): Promise<{ sources: number; credentials: number }> {
  const db = getDb();
  const srcs = await db
    .select({ id: connectedSource.id })
    .from(connectedSource)
    .where(eq(connectedSource.userId, userId));
  const creds =
    srcs.length === 0
      ? []
      : await db
          .select({ id: mailboxCredential.sourceId })
          .from(mailboxCredential)
          .where(inArray(mailboxCredential.sourceId, srcs.map((s) => s.id)));
  return { sources: srcs.length, credentials: creds.length };
}

async function stateExists(state: string): Promise<boolean> {
  const found = await getDb()
    .select({ id: oauthConnectState.id })
    .from(oauthConnectState)
    .where(eq(oauthConnectState.id, state));
  return found.length > 0;
}

async function expectRefused(p: Promise<unknown>, code = 'oauth_failed'): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(exchangeCode).mockClear();
  mailboxAddress.value = `mailbox-${randomUUID()}@gmail.test`;
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe('completeConnect state handling (OI-7)', () => {
  it('connects with a valid state, then refuses a replay of the consumed state', async () => {
    const ctx = await createUser();
    const state = await startGmail(ctx);

    const { sourceId } = await sources.completeConnect(ctx, { state, code: 'code-1', provider: 'gmail' });
    expect(sourceId).toBeTruthy();
    expect(await rows(ctx.userId)).toEqual({ sources: 1, credentials: 1 });
    expect(await stateExists(state)).toBe(false);
    expect(exchangeCode).toHaveBeenCalledTimes(1);

    // Replay with a different mailbox so a reused state would create a second source rather than hit `conflict`.
    mailboxAddress.value = `other-${randomUUID()}@gmail.test`;
    await expectRefused(sources.completeConnect(ctx, { state, code: 'code-2', provider: 'gmail' }));
    expect(exchangeCode).toHaveBeenCalledTimes(1);
    expect(await rows(ctx.userId)).toEqual({ sources: 1, credentials: 1 });
  });

  it("refuses another user's state and writes nothing for either user", async () => {
    const owner = await createUser();
    const attacker = await createUser();
    const state = await startGmail(owner);

    await expectRefused(sources.completeConnect(attacker, { state, code: 'code', provider: 'gmail' }));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await rows(attacker.userId)).toEqual({ sources: 0, credentials: 0 });
    expect(await rows(owner.userId)).toEqual({ sources: 0, credentials: 0 });
    // Consumed in every outcome: the owner cannot finish with it either.
    expect(await stateExists(state)).toBe(false);
    await expectRefused(sources.completeConnect(owner, { state, code: 'code', provider: 'gmail' }));
    expect(await rows(owner.userId)).toEqual({ sources: 0, credentials: 0 });
  });

  it('refuses a state issued for a different provider, and the state cannot be reused', async () => {
    const ctx = await createUser();
    const state = await startGmail(ctx);

    await expectRefused(sources.completeConnect(ctx, { state, code: 'code', provider: 'microsoft' }));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await rows(ctx.userId)).toEqual({ sources: 0, credentials: 0 });
    expect(await stateExists(state)).toBe(false);

    await expectRefused(sources.completeConnect(ctx, { state, code: 'code', provider: 'gmail' }));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await rows(ctx.userId)).toEqual({ sources: 0, credentials: 0 });
  });

  it('refuses an expired state, and the state cannot be reused', async () => {
    const ctx = await createUser();
    const state = await startGmail(ctx);
    await getDb()
      .update(oauthConnectState)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthConnectState.id, state));

    await expectRefused(sources.completeConnect(ctx, { state, code: 'code', provider: 'gmail' }));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await rows(ctx.userId)).toEqual({ sources: 0, credentials: 0 });
    expect(await stateExists(state)).toBe(false);
  });

  it('refuses unknown and malformed states', async () => {
    const ctx = await createUser();
    await expectRefused(sources.completeConnect(ctx, { state: randomUUID(), code: 'code', provider: 'gmail' }));
    await expectRefused(sources.completeConnect(ctx, { state: 'not-a-uuid', code: 'code', provider: 'gmail' }));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await rows(ctx.userId)).toEqual({ sources: 0, credentials: 0 });
  });
});
