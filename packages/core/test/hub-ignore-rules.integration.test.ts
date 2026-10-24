import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { ignoreRuleHash, selectParticipants } from '@voicespark/core/services/hub/extraction';
import * as ignoreRules from '@voicespark/core/services/hub/ignore-rules';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US3 ignore rules (T123; contracts/http-api.md "Mailboxes and ignore rules", data-model.md "hub_ignore_rule";
// FR-021, FR-032). The hash is the one the extraction matcher uses.

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

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

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function newCtx(): Promise<ServiceContext> {
  return { userId: await createUser(), role: 'user' };
}

async function auditRows(userId: string, action: string) {
  return q<{ metadata: Record<string, unknown>; target_id: string }>(
    'select metadata, target_id from audit_log_entry where actor_user_id = $1 and action = $2',
    [userId, action],
  );
}

const OWNER = 'me@owner.example';
const msg = (from: string) => ({ from, to: OWNER, cc: '', automated: false });

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('create', () => {
  it('lower-cases an address, encrypts the value and stores the extraction hash', async () => {
    const ctx = await newCtx();
    const rule = await ignoreRules.create(ctx, { kind: 'address', value: '  Jan.Kowalski@Acme.Example ' });
    expect(rule).toEqual({
      id: expect.any(String),
      kind: 'address',
      value: 'jan.kowalski@acme.example',
      createdAt: expect.any(String),
    });
    const [row] = await q<{ value_enc: string; value_hash: string }>(
      'select value_enc, value_hash from hub_ignore_rule where id = $1',
      [rule.id],
    );
    expect(row!.value_enc).not.toContain('acme');
    expect(decrypt('user-content', row!.value_enc)).toBe('jan.kowalski@acme.example');
    expect(row!.value_hash).toBe(ignoreRuleHash('address', 'jan.kowalski@acme.example'));
  });

  it('normalises a domain as for company domains (lower-case, no www.)', async () => {
    const ctx = await newCtx();
    const rule = await ignoreRules.create(ctx, { kind: 'domain', value: 'WWW.Newsletter.Example' });
    expect(rule.value).toBe('newsletter.example');
    const [row] = await q<{ value_hash: string }>('select value_hash from hub_ignore_rule where id = $1', [rule.id]);
    expect(row!.value_hash).toBe(ignoreRuleHash('domain', 'newsletter.example'));
  });

  it('audits hub.ignore_rule_created with the kind only', async () => {
    const ctx = await newCtx();
    const rule = await ignoreRules.create(ctx, { kind: 'address', value: 'audit@acme.example' });
    const rows = await auditRows(ctx.userId, 'hub.ignore_rule_created');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({ kind: 'address' });
    expect(rows[0]!.target_id).toBe(rule.id);
    expect(JSON.stringify(rows[0])).not.toContain('acme');
  });

  it('returns 409 conflict for an existing rule (after normalisation), per user', async () => {
    const ctx = await newCtx();
    await ignoreRules.create(ctx, { kind: 'domain', value: 'acme.example' });
    await expectCode(ignoreRules.create(ctx, { kind: 'domain', value: 'www.ACME.example' }), 'conflict', 409);
    // The same value as an address rule, or for another user, is a different rule.
    await ignoreRules.create(ctx, { kind: 'address', value: 'x@acme.example' });
    const other = await newCtx();
    await ignoreRules.create(other, { kind: 'domain', value: 'acme.example' });
    expect(await auditRows(ctx.userId, 'hub.ignore_rule_created')).toHaveLength(2);
  });

  it('rejects an unknown kind, a bad address and a bad domain with 422', async () => {
    const ctx = await newCtx();
    await expectCode(ignoreRules.create(ctx, { kind: 'name', value: 'Jan' }), 'validation_failed', 422);
    await expectCode(ignoreRules.create(ctx, { kind: 'address', value: 'not-an-address' }), 'validation_failed', 422);
    await expectCode(ignoreRules.create(ctx, { kind: 'domain', value: 'no_dots' }), 'validation_failed', 422);
    await expectCode(ignoreRules.create(ctx, {}), 'validation_failed', 422);
    expect(await ignoreRules.list(ctx)).toEqual([]);
  });
});

describe('list and remove', () => {
  it('lists only the caller rules, oldest first, decrypted', async () => {
    const ctx = await newCtx();
    const a = await ignoreRules.create(ctx, { kind: 'address', value: 'a@acme.example' });
    const b = await ignoreRules.create(ctx, { kind: 'domain', value: 'spam.example' });
    const other = await newCtx();
    await ignoreRules.create(other, { kind: 'address', value: 'z@other.example' });
    expect(await ignoreRules.list(ctx)).toEqual([a, b]);
  });

  it('removes a rule and audits hub.ignore_rule_deleted {kind}', async () => {
    const ctx = await newCtx();
    const rule = await ignoreRules.create(ctx, { kind: 'domain', value: 'gone.example' });
    await ignoreRules.remove(ctx, rule.id);
    expect(await ignoreRules.list(ctx)).toEqual([]);
    const rows = await auditRows(ctx.userId, 'hub.ignore_rule_deleted');
    expect(rows.map((r) => r.metadata)).toEqual([{ kind: 'domain' }]);
    await expectCode(ignoreRules.remove(ctx, rule.id), 'not_found', 404);
  });

  it("answers 404 for another user's rule and a malformed id, leaving the rule in place", async () => {
    const owner = await newCtx();
    const rule = await ignoreRules.create(owner, { kind: 'address', value: 'kept@acme.example' });
    const intruder = await newCtx();
    await expectCode(ignoreRules.remove(intruder, rule.id), 'not_found', 404);
    await expectCode(ignoreRules.remove(intruder, 'nope'), 'not_found', 404);
    expect(await ignoreRules.list(owner)).toEqual([rule]);
    expect(await auditRows(intruder.userId, 'hub.ignore_rule_deleted')).toEqual([]);
  });
});

describe('matcher', () => {
  it('feeds selectParticipants: an address rule, a domain rule with subdomains, and removal undoes it', async () => {
    const ctx = await newCtx();
    const none = await ignoreRules.matcher(ctx.userId);
    expect(selectParticipants([msg('jan@acme.example')], [OWNER], none).skip).toBeNull();

    const addr = await ignoreRules.create(ctx, { kind: 'address', value: 'Jan@Acme.Example' });
    await ignoreRules.create(ctx, { kind: 'domain', value: 'news.example' });
    const rules = await ignoreRules.matcher(ctx.userId);
    expect(rules.addressHashes.size).toBe(1);
    expect(rules.domainHashes.size).toBe(1);
    expect(selectParticipants([msg('jan@acme.example')], [OWNER], rules).skip).toBe('ignored');
    expect(selectParticipants([msg('ola@acme.example')], [OWNER], rules).skip).toBeNull();
    expect(selectParticipants([msg('promo@mail.news.example')], [OWNER], rules).skip).toBe('ignored');
    expect(selectParticipants([msg('promo@othernews.example')], [OWNER], rules).skip).toBeNull();

    await ignoreRules.remove(ctx, addr.id);
    const after = await ignoreRules.matcher(ctx.userId);
    expect(selectParticipants([msg('jan@acme.example')], [OWNER], after).skip).toBeNull();
    // Another user's rules never apply.
    expect((await ignoreRules.matcher((await newCtx()).userId)).domainHashes.size).toBe(0);
  });
});
