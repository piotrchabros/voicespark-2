import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/auth';
import { api, confirmFilters, poll } from './support/api';
import { E2E_BASE_URL } from './support/env';
import {
  appendMessages,
  GREENMAIL_HOST,
  GREENMAIL_IMAPS_PORT,
  GREENMAIL_PASSWORD,
  uniqueMailbox,
  waitForMail,
  type SeedMessage,
} from './support/greenmail';
import { scanNamespace, type ScannedDoc } from './support/memory';
import { markNeedsReconnection } from './support/scripts';
import { measure } from './support/timing';

// US2 / SC-002 (quickstart section 6, T156): IMAP end to end against GreenMail; Gmail and Microsoft only up to the
// consent redirect and the cancel path (D-E2); token revocation simulated through scripts.ts (D-E3).

interface ImportProgress {
  id: string;
  kind: string;
  status: string;
  pauseReason: string | null;
  itemsDiscovered: number;
  itemsProcessed: number;
  itemsImported: number;
  itemsDuplicate: number;
  itemsExcluded: number;
  itemsSkipped: number;
  itemsFailed: number;
  totalEstimate: number | null;
  remainingEstimate: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
}

interface Source {
  id: string;
  type: string;
  accountLabel: string;
  status: string;
  pauseReason: string | null;
  itemCount: number;
  lastSyncAt: string | null;
  dateRange: { from: string | null; to: string | null };
  currentImport: ImportProgress | null;
}

interface Notification {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
}

interface Deletion {
  id: string;
  scope: string;
  status: string;
  completedAt: string | null;
}

interface ConsentSummary {
  provider: string;
  version: string;
  title: string;
  items: string[];
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

const uniqueEmail = (info: TestInfo, tag: string) => `e2e-${tag}-${info.testId}-${Date.now()}@example.test`;

/** Distinct messages (unique subject and body, so nothing deduplicates) delivered to `mailbox`. */
function seed(mailbox: string, n: number, tag: string, date?: Date): SeedMessage[] {
  const domain = mailbox.split('@')[1] ?? 'greenmail.test';
  return Array.from({ length: n }, (_, i) => ({
    subject: `${tag} ${i + 1}`,
    from: `Sender ${i + 1} <sender${i + 1}@${domain}>`,
    to: mailbox,
    body: `Message ${i + 1} of ${n} for ${tag}: ${mailbox}.\n\nNothing sensitive here, only text to import.`,
    ...(date ? { date } : {}),
  }));
}

async function connectImap(page: Page, mailbox: string, dateRange?: { from?: string; to?: string }): Promise<Source> {
  const { source } = await api.post<{ source: Source }>(page, '/api/sources/imap', {
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    tlsMode: 'tls',
    username: mailbox,
    password: GREENMAIL_PASSWORD,
    ...(dateRange ? { dateRange } : {}),
  });
  return source;
}

const getSource = (page: Page, id: string) => api.get<Source>(page, `/api/sources/${id}`);

/** Polls the source until its newest import reaches a terminal status; expects `completed`. */
async function waitForImport(page: Page, sourceId: string, timeoutMs = 120_000): Promise<Source> {
  const source = await poll(
    () => getSource(page, sourceId),
    (s) => s.currentImport !== null && TERMINAL.includes(s.currentImport.status),
    { timeoutMs, intervalMs: 1_000 },
  );
  expect(source.currentImport?.status).toBe('completed');
  return source;
}

async function notifications(page: Page): Promise<Notification[]> {
  return (await api.get<{ items: Notification[] }>(page, '/api/notifications')).items;
}

const taggedWith = (docs: ScannedDoc[], sourceId: string) =>
  docs.filter((d) => {
    const ids = d.metadata['vs_source_ids'];
    return Array.isArray(ids) && ids.includes(sourceId);
  });

async function newUser(page: Page, signInAs: (o: { email: string }) => Promise<{ userId: string; email: string }>, info: TestInfo, tag: string) {
  const user = await signInAs({ email: uniqueEmail(info, tag) });
  await confirmFilters(page);
  return user;
}

test('SC-002: an IMAP mailbox with a date range imports under 2 minutes with progress updating', async ({
  page,
  signInAs,
}, testInfo) => {
  const { userId } = await newUser(page, signInAs, testInfo, 'imap-range');
  const mailbox = uniqueMailbox('us2-range');
  await appendMessages(mailbox, [
    ...seed(mailbox, 10, 'in range', new Date('2024-03-15T10:00:00Z')),
    ...seed(mailbox, 2, 'too old', new Date('2022-01-10T10:00:00Z')),
  ]);

  const { created, finished } = await measure('IMAP initial import (10 messages)', 'SC-002', 120_000, async () => {
    const created = await connectImap(page, mailbox, { from: '2024-03-01', to: '2024-03-31' });
    const finished = await waitForImport(page, created.id, 110_000);
    return { created, finished };
  });

  expect(created).toMatchObject({ type: 'imap', status: 'connected', pauseReason: null, itemCount: 0 });
  expect(created.accountLabel).toContain(mailbox);
  expect(created.dateRange).toEqual({ from: '2024-03-01', to: '2024-03-31' });

  // The progress fields moved from the queued snapshot returned by connect to the completed one.
  const before = created.currentImport!;
  const after = finished.currentImport!;
  expect(before).toMatchObject({ kind: 'initial', itemsProcessed: 0, itemsImported: 0, finishedAt: null });
  expect(['queued', 'running']).toContain(before.status);
  expect(after).toMatchObject({ id: before.id, kind: 'initial', status: 'completed', itemsImported: 10, itemsFailed: 0 });
  expect(after.itemsProcessed).toBeGreaterThanOrEqual(10);
  expect(after.startedAt).not.toBeNull();
  expect(after.finishedAt).not.toBeNull();
  expect(after.lastActivityAt).not.toBeNull();
  expect(finished.itemCount).toBe(10);
  expect(finished.lastSyncAt).not.toBeNull();
  expect(await api.get<ImportProgress>(page, `/api/imports/${after.id}`)).toMatchObject({
    id: after.id,
    status: 'completed',
    itemsImported: 10,
  });

  // Only the in-range messages were stored.
  const { items } = await api.get<{ items: { itemDate: string; title?: string }[] }>(
    page,
    `/api/content-items?sourceId=${created.id}&limit=100`,
  );
  expect(items).toHaveLength(10);
  expect(items.every((i) => i.itemDate.startsWith('2024-03-'))).toBe(true);
  expect(taggedWith(await scanNamespace(userId), created.id)).toHaveLength(10);

  // The first import notifies in-app.
  await poll(() => notifications(page), (list) => list.some((n) => n.type === 'import_completed'), {
    timeoutMs: 30_000,
  });
});

test('IMAP connect form shows the import progress @ui', async ({ page, signInAs }, testInfo) => {
  await newUser(page, signInAs, testInfo, 'imap-ui');
  const mailbox = uniqueMailbox('us2-ui');
  await appendMessages(mailbox, seed(mailbox, 5, 'form'));

  await page.goto('/sources/connect');
  await page.getByRole('tab', { name: 'IMAP' }).click();
  await page.getByLabel('Host').fill(GREENMAIL_HOST);
  await page.getByLabel('Port').fill(String(GREENMAIL_IMAPS_PORT));
  await page.getByLabel('Username').fill(mailbox);
  await page.getByLabel('App password').fill(GREENMAIL_PASSWORD);
  await page.getByRole('button', { name: 'Connect mailbox' }).click();

  // next dev compiles the source page on first use.
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByText('Current import')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\d+ processed/)).toBeVisible();
  // The page polls the import every 5 s until it finishes.
  // The first match is the live Current import badge; Import history also lists it once finished.
  await expect(page.getByText('completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('5 processed')).toBeVisible();
});

test('pause then resume an import leaves no duplicate content items', async ({ page, signInAs }, testInfo) => {
  const { userId } = await newUser(page, signInAs, testInfo, 'pause');
  const mailbox = uniqueMailbox('us2-pause');
  await appendMessages(mailbox, seed(mailbox, 40, 'pause'));

  const created = await connectImap(page, mailbox);
  const paused = await api.post<{ source: Source }>(page, `/api/sources/${created.id}/pause`);
  expect(paused.source).toMatchObject({ status: 'paused', pauseReason: 'user' });

  // Nothing moves while paused.
  await page.waitForTimeout(3_000);
  const during = await getSource(page, created.id);
  expect(during).toMatchObject({ status: 'paused', pauseReason: 'user' });
  if (during.currentImport && !TERMINAL.includes(during.currentImport.status)) {
    expect(during.currentImport).toMatchObject({ status: 'paused', pauseReason: 'user' });
  }
  const stillPaused = await getSource(page, created.id);
  expect(stillPaused.currentImport?.itemsProcessed ?? 0).toBe(during.currentImport?.itemsProcessed ?? 0);

  const resumed = await api.post<{ source: Source }>(page, `/api/sources/${created.id}/resume`);
  expect(resumed.source).toMatchObject({ status: 'connected', pauseReason: null });
  const finished = await waitForImport(page, created.id);

  const imports = await api.get<ImportProgress[]>(page, `/api/sources/${created.id}/imports`);
  expect(imports.reduce((n, i) => n + i.itemsDuplicate, 0)).toBe(0);
  expect(imports.reduce((n, i) => n + i.itemsImported, 0)).toBe(40);
  expect(imports.reduce((n, i) => n + i.itemsFailed, 0)).toBe(0);
  expect(finished.itemCount).toBe(40);

  const { items, nextCursor } = await api.get<{ items: { id: string }[]; nextCursor: string | null }>(
    page,
    `/api/content-items?sourceId=${created.id}&limit=100`,
  );
  expect(nextCursor).toBeNull();
  expect(items).toHaveLength(40);
  expect(new Set(items.map((i) => i.id)).size).toBe(40);
  expect(taggedWith(await scanNamespace(userId), created.id)).toHaveLength(40);
});

test('a revoked token marks the source needs_reconnection and notifies in-app and by email', async ({
  page,
  signInAs,
}, testInfo) => {
  const { email } = await newUser(page, signInAs, testInfo, 'revoked');
  const mailbox = uniqueMailbox('us2-revoked');
  await appendMessages(mailbox, seed(mailbox, 3, 'revoked'));
  const created = await connectImap(page, mailbox);
  await waitForImport(page, created.id);

  await markNeedsReconnection(created.id);
  const source = await getSource(page, created.id);
  expect(source.status).toBe('needs_reconnection');
  expect(source.itemCount).toBe(3);

  const list = await poll(
    () => notifications(page),
    (l) => l.some((n) => n.type === 'source_needs_reconnection' && n.payload['sourceId'] === created.id),
    { timeoutMs: 30_000 },
  );
  const note = list.find((n) => n.type === 'source_needs_reconnection')!;
  expect(note.readAt).toBeNull();
  // Ids only, never content.
  expect(JSON.stringify(note.payload)).not.toContain('revoked 1');

  const mail = await waitForMail(email, 'needs reconnection', 60_000);
  expect(mail.subject).toBe('VoiceSpark: a source needs reconnection');
  expect(mail.source).toContain(`${E2E_BASE_URL}/sources`);
  expect(mail.source).not.toContain('revoked 1');
});

test('source page explains the lost access @ui', async ({ page, signInAs }, testInfo) => {
  await newUser(page, signInAs, testInfo, 'revoked-ui');
  const mailbox = uniqueMailbox('us2-revoked-ui');
  await appendMessages(mailbox, seed(mailbox, 2, 'revoked-ui'));
  const created = await connectImap(page, mailbox);
  await waitForImport(page, created.id);
  await markNeedsReconnection(created.id);

  await page.goto(`/sources/${created.id}`);
  await expect(page.getByText('needs reconnection', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('This source needs reconnection')).toBeVisible();
  await expect(page.getByRole('button', { name: /reconnect/i })).toBeVisible();
});

test('new mail in a connected mailbox is imported within two poll intervals', async ({ page, signInAs }, testInfo) => {
  // SYNC_POLL_INTERVAL_MINUTES=1 in E2E_ENV: two intervals plus slack.
  test.setTimeout(300_000);
  await newUser(page, signInAs, testInfo, 'sync');
  const mailbox = uniqueMailbox('us2-sync');
  await appendMessages(mailbox, seed(mailbox, 2, 'sync'));
  const created = await connectImap(page, mailbox);
  await waitForImport(page, created.id);

  await appendMessages(mailbox, seed(mailbox, 1, 'new mail'));
  const started = Date.now();
  await poll(() => getSource(page, created.id), (s) => s.itemCount >= 3, { timeoutMs: 150_000, intervalMs: 2_000 });
  const elapsed = Date.now() - started;
  testInfo.annotations.push({ type: 'timing:sync', description: `new mail visible after ${elapsed} ms` });
  const source = await waitForImport(page, created.id, 60_000);
  expect(source.itemCount).toBe(3);

  const imports = await api.get<ImportProgress[]>(page, `/api/sources/${created.id}/imports`);
  const incremental = imports.filter((i) => i.kind === 'incremental' && i.status === 'completed');
  expect(incremental.reduce((n, i) => n + i.itemsImported, 0)).toBe(1);
  expect(imports.reduce((n, i) => n + i.itemsDuplicate, 0)).toBe(0);
  const { items } = await api.get<{ items: { title?: string }[] }>(
    page,
    `/api/content-items?sourceId=${created.id}&limit=100`,
  );
  expect(items.map((i) => i.title)).toContain('new mail 1');
});

test('SC-002: disconnect with "delete data" removes the documents from the namespace under 2 minutes', async ({
  page,
  signInAs,
}, testInfo) => {
  const { userId } = await newUser(page, signInAs, testInfo, 'delete');
  const mailbox = uniqueMailbox('us2-delete');
  await appendMessages(mailbox, seed(mailbox, 5, 'delete'));
  const created = await connectImap(page, mailbox);
  await waitForImport(page, created.id);
  expect(taggedWith(await scanNamespace(userId), created.id)).toHaveLength(5);

  const result = await measure('source disconnect with delete (5 documents)', 'SC-002', 120_000, async () => {
    const r = await api.post<{ source: Source; deletionRequestId: string | null }>(
      page,
      `/api/sources/${created.id}/disconnect`,
      { deleteContent: true },
    );
    expect(r.deletionRequestId).toBeTruthy();
    const deletion = await poll(
      () => api.get<Deletion>(page, `/api/deletions/${r.deletionRequestId}`),
      (d) => d.status === 'completed' || d.status === 'failed',
      { timeoutMs: 110_000, intervalMs: 1_000 },
    );
    expect(deletion).toMatchObject({ scope: 'source', status: 'completed' });
    expect(deletion.completedAt).not.toBeNull();
    expect(taggedWith(await scanNamespace(userId), created.id)).toEqual([]);
    return r;
  });

  expect(result.source.status).toBe('disconnected');
  // The `source` deletion removes the row itself once its content is gone.
  await expect(getSource(page, created.id)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  expect((await api.get<Source[]>(page, '/api/sources')).map((s) => s.id)).not.toContain(created.id);
  expect(await scanNamespace(userId)).toEqual([]);
  const { items } = await api.get<{ items: unknown[] }>(page, `/api/content-items?sourceId=${created.id}&limit=100`);
  expect(items).toEqual([]);
  await poll(
    () => notifications(page),
    (l) => l.some((n) => n.type === 'deletion_completed' && n.payload['scope'] === 'source'),
    { timeoutMs: 30_000 },
  );
});

test('Gmail and Microsoft connect start a least-privilege consent flow; cancel returns to /sources/connect', async ({
  page,
  signInAs,
}, testInfo) => {
  await newUser(page, signInAs, testInfo, 'oauth');

  const gmail = await api.post<{ authorizeUrl: string; consentSummary: ConsentSummary }>(
    page,
    '/api/sources/connect/gmail',
    { dateRange: { from: '2024-01-01' } },
  );
  const g = new URL(gmail.authorizeUrl);
  expect(g.hostname).toBe('accounts.google.com');
  expect(g.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
  expect(g.searchParams.get('access_type')).toBe('offline');
  expect(g.searchParams.get('prompt')).toBe('consent');
  expect(g.searchParams.get('code_challenge_method')).toBe('S256');
  expect(g.searchParams.get('redirect_uri')).toBe(`${E2E_BASE_URL}/api/sources/connect/gmail/callback`);
  expect(gmail.consentSummary.provider).toBe('gmail');
  expect(gmail.consentSummary.items.length).toBeGreaterThan(0);

  const microsoft = await api.post<{ authorizeUrl: string; consentSummary: ConsentSummary }>(
    page,
    '/api/sources/connect/microsoft',
    {},
  );
  const m = new URL(microsoft.authorizeUrl);
  expect(m.hostname).toBe('login.microsoftonline.com');
  expect(m.searchParams.get('scope')).toBe('Mail.Read offline_access User.Read');
  expect(m.searchParams.get('code_challenge_method')).toBe('S256');
  expect(m.searchParams.get('redirect_uri')).toBe(`${E2E_BASE_URL}/api/sources/connect/microsoft/callback`);
  expect(microsoft.consentSummary.provider).toBe('microsoft');
  expect(microsoft.consentSummary.items.length).toBeGreaterThan(0);

  // Cancelling at the consent screen comes back with `oauth_cancelled` and nothing connected.
  for (const provider of ['gmail', 'microsoft']) {
    const res = await page.request.get(`/api/sources/connect/${provider}/callback?error=access_denied&state=cancelled`, {
      maxRedirects: 0,
    });
    expect(res.status(), provider).toBe(303);
    const location = new URL(res.headers()['location']!);
    expect(`${location.pathname}${location.search}`, provider).toBe('/sources/connect?error=oauth_cancelled');
  }
  expect(await api.get(page, '/api/sources')).toEqual([]);
});

test('cancelled mailbox consent shows a message on the connect page @ui', async ({ page, signInAs }, testInfo) => {
  await newUser(page, signInAs, testInfo, 'oauth-ui');
  await page.goto('/api/sources/connect/gmail/callback?error=access_denied&state=cancelled');
  await expect(page).toHaveURL(/\/sources\/connect\?error=oauth_cancelled$/, { timeout: 30_000 });
  // Next's route announcer also has role=alert.
  await expect(page.getByRole('alert').filter({ hasText: 'You cancelled' })).toContainText(
    'You cancelled at the provider',
  );
  await expect(page.getByRole('tab', { name: 'Gmail' })).toBeVisible();
});
