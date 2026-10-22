import type { Page } from '@playwright/test';
import { signInAs, test, expect } from './fixtures/auth';
import { api, confirmFilters, poll } from './support/api';
import { createProfileReady, listProfiles, restoreProfileThreshold } from './support/drafts';
import { E2E_BASE_URL } from './support/env';
import {
  appendMessages,
  GREENMAIL_PASSWORD,
  uniqueMailbox,
  waitForMail,
} from './support/greenmail';
import { scanNamespace } from './support/memory';
import { runCore, sql } from './support/scripts';
import { measure } from './support/timing';

// US7 / T161: deleting a source marks the profile built from it outdated; deleting the account empties the
// namespace, removes the user row, pseudonymizes the audit log and emails a confirmation (FR-044..047, SC-009).

const SENT_BODIES = [
  'Thanks for the lovely afternoon at the allotment. I wrote up the plan for the herb beds and will share it on Friday.',
  'Quick update from me: the newsletter is nearly done, I only need two more photos from the spring planting day.',
  'I am happy to host the next meetup at my place. Bring a chair if you can, and I will make lemonade for everyone.',
];

interface SourceView {
  id: string;
  status: string;
  itemCount: number;
  currentImport: {
    id: string;
    status: string;
    itemsDiscovered: number;
    itemsProcessed: number;
    lastActivityAt: string | null;
  } | null;
}

/**
 * Waits for the source's import to finish. Works around an app race (reported with T161): `import.page` enqueues the
 * follow-up page while it still holds the per-source lock, so a second worker slot picks it up, returns `locked` and
 * the job stays `running` until `maintenance.stale-imports` re-enqueues it after 15 min. A page job that went idle
 * with everything processed is re-enqueued here, exactly what that maintenance job would do.
 */
async function waitForImport(
  page: Page,
  userId: string,
  sourceId: string,
  minItems: number,
): Promise<SourceView> {
  let nudgedAt = 0;
  return poll(
    async () => {
      const s = await api.get<SourceView>(page, `/api/sources/${sourceId}`);
      const imp = s.currentImport;
      const idleMs = imp?.lastActivityAt ? Date.now() - Date.parse(imp.lastActivityAt) : 0;
      if (
        imp?.status === 'running' &&
        imp.itemsProcessed >= imp.itemsDiscovered &&
        idleMs > 5_000 &&
        Date.now() - nudgedAt > 10_000
      ) {
        nudgedAt = Date.now();
        await runCore(
          `const { enqueuePage } = await import('@voicespark/core/services/imports');
           await enqueuePage(args[0]);`,
          [{ userId, sourceId, importJobId: imp.id }],
        );
      }
      return s;
    },
    // `currentImport` is the newest job, terminal ones included.
    (s) => s.currentImport?.status === 'completed' && s.itemCount >= minItems,
    { timeoutMs: 120_000, intervalMs: 1_000 },
  );
}

/** Every document whose `vs_source_ids` metadata still names the source. */
async function docsOfSource(userId: string, sourceId: string): Promise<string[]> {
  const docs = await scanNamespace(userId);
  return docs
    .filter((d) => String(d.metadata.vs_source_ids ?? '').includes(sourceId))
    .map((d) => d.id);
}

test.afterAll(async () => {
  await restoreProfileThreshold();
});

test('source deletion outdates the profile; account deletion empties everything within 5 min (SC-009) @ui', async ({
  page,
  playwright,
}) => {
  test.setTimeout(600_000);
  // The account address is the GreenMail mailbox: its own sent mail is authored, and the confirmation lands there.
  const mailbox = uniqueMailbox('us7');
  const { userId, email } = await signInAs(page, { email: mailbox });
  await confirmFilters(page);

  await appendMessages(
    mailbox,
    SENT_BODIES.map((body, i) => ({
      subject: `Garden club note ${i + 1}`,
      from: mailbox,
      to: `friend${i}@example.com`,
      body,
      date: new Date(Date.now() - (i + 1) * 86_400_000),
    })),
  );
  const { source } = await api.post<{ source: { id: string } }>(page, '/api/sources/imap', {
    host: 'localhost',
    port: 3993,
    tlsMode: 'tls',
    username: mailbox,
    password: GREENMAIL_PASSWORD,
  });
  const sourceId = source.id;
  await waitForImport(page, userId, sourceId, SENT_BODIES.length);
  expect((await docsOfSource(userId, sourceId)).length).toBeGreaterThanOrEqual(SENT_BODIES.length);

  // Profile from the IMAP mail plus one note: the IMAP source is a contributing source.
  const { profileId } = await createProfileReady(page);
  expect((await listProfiles(page)).find((p) => p.id === profileId)?.outdatedReason).toBeNull();

  // Delete the source's data through the UI.
  // From the sources list: the detail page /sources/{id} currently fails to render (formatDate is a client export
  // called from the server component; reported with T161).
  await page.goto('/sources');
  const deleteData = page
    .getByRole('row')
    .filter({ hasText: mailbox })
    .getByRole('button', { name: 'Delete data' });
  await expect(deleteData).toBeVisible({ timeout: 60_000 });
  await deleteData.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Delete all data from this source?')).toBeVisible();
  const [deleteRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/sources/${sourceId}`) && r.request().method() === 'DELETE',
    ),
    dialog.getByRole('button', { name: 'Delete data' }).click(),
  ]);
  expect(deleteRes.status()).toBe(202);
  const { deletionRequestId } = (await deleteRes.json()) as { deletionRequestId: string };

  const done = await poll(
    () => api.get<{ status: string; scope: string }>(page, `/api/deletions/${deletionRequestId}`),
    (d) => d.status === 'completed' || d.status === 'failed',
    { timeoutMs: 120_000 },
  );
  expect(done).toMatchObject({ status: 'completed', scope: 'source' });
  expect(await docsOfSource(userId, sourceId)).toEqual([]);
  const [row] = await sql<{ n: number }>(
    'SELECT count(*)::int AS n FROM content_item_occurrence WHERE source_id = $1',
    [sourceId],
  );
  expect(row!.n).toBe(0);

  // The profile built from it is flagged; the profiles page offers Regenerate.
  await poll(
    () => listProfiles(page),
    (list) => list.find((p) => p.id === profileId)?.outdatedReason === 'sources_deleted',
    { timeoutMs: 30_000 },
  );
  await page.goto('/profiles');
  const banner = page.getByRole('status').filter({ hasText: 'Your profile may be outdated' });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Regenerate' })).toBeVisible();

  // Delete the account through the settings dialog.
  const sessionCookie = (await page.context().cookies())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Delete account' }).click();
  const confirm = page.getByRole('dialog');
  const submit = confirm.getByRole('button', { name: 'Delete account' });
  await expect(submit).toBeDisabled();
  await confirm.getByLabel(/to confirm/).fill('DELETE');

  await measure('account deletion complete', 'SC-009', 5 * 60_000, async () => {
    await submit.click();
    await page.waitForURL(
      (u) => u.pathname === '/sign-in' && u.searchParams.get('deleted') === '1',
    );

    await poll(
      () =>
        sql<{ status: string }>(
          `SELECT status FROM deletion_request WHERE scope = 'account' AND target_id = $1
           ORDER BY requested_at DESC LIMIT 1`,
          [userId],
        ),
      (rows) => rows[0]?.status === 'completed' || rows[0]?.status === 'failed',
      { timeoutMs: 5 * 60_000, intervalMs: 1_000 },
    ).then((rows) => expect(rows[0]?.status).toBe('completed'));
    await waitForMail(email, 'your account has been deleted', 60_000);
  });

  // The old session is dead.
  const stale = await playwright.request.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { cookie: sessionCookie },
  });
  try {
    const res = await stale.get('/api/me', { maxRedirects: 0 });
    expect([401, 403]).toContain(res.status());
  } finally {
    await stale.dispose();
  }

  // Namespace empty, user row gone, audit entries pseudonymized.
  expect(await scanNamespace(userId)).toEqual([]);
  const users = await sql('SELECT id FROM "user" WHERE id = $1', [userId]);
  expect(users).toEqual([]);
  const [linked] = await sql<{ n: number }>(
    'SELECT count(*)::int AS n FROM audit_log_entry WHERE actor_user_id = $1 OR target_id = $2',
    [userId, userId],
  );
  expect(linked!.n).toBe(0);
  const [deleted] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log_entry a
     JOIN deletion_request d ON d.subject_ref = a.subject_ref
     WHERE a.action = 'account.deleted' AND d.target_id = $1 AND a.actor_user_id IS NULL AND a.target_id IS NULL`,
    [userId],
  );
  expect(deleted!.n).toBe(1);
});
