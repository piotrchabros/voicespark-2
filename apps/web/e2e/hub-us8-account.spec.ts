import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, confirmFilters, poll } from './support/api';
import { E2E_ENV } from './support/env';
import { scanNamespace } from './support/memory';
import { sql } from './support/scripts';

// Hub US8 (quickstart rows US8.1 and US8.4; FR-029, FR-030, FR-032; SC-011, SC-012): admins see hub counts only, and
// deleting the account removes every hub row, the user's file directory and every `hub_` document in the store
// (T072). Setup goes through the /api/hub routes; the admin screens and the deletion run in the browser.

type Kind = 'people' | 'companies' | 'projects';

interface RecordView {
  id: string;
  name: string;
}

interface FileView {
  id: string;
  name: string;
  extractionStatus: 'pending' | 'extracted' | 'empty' | 'unsupported' | 'failed' | 'excluded';
}

interface HubCounts {
  recordCount: number;
  noteCount: number;
  fileCount: number;
  pendingSuggestionCount: number;
  syncFailedCount: number;
  hubMailboxCount: number;
}

interface HubAggregates {
  llmCallsToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
  threadsPending: number;
  threadsFailed: number;
  syncFailed: number;
}

/** Labels of the "Context Hub" cards (apps/web/app/(admin)/admin/users/[userId]/page.tsx and admin/page.tsx). */
const USER_COUNT_LABELS: Record<keyof HubCounts, string> = {
  recordCount: 'Records',
  noteCount: 'Notes',
  fileCount: 'Files',
  pendingSuggestionCount: 'Pending suggestions',
  syncFailedCount: 'Failed syncs',
  hubMailboxCount: 'Hub mailboxes',
};
const AGGREGATE_LABELS: Record<keyof HubAggregates, string> = {
  llmCallsToday: 'LLM calls today',
  inputTokensToday: 'Input tokens today',
  outputTokensToday: 'Output tokens today',
  threadsPending: 'Threads pending',
  threadsFailed: 'Threads failed',
  syncFailed: 'Failed syncs',
};

// Strings that only exist in this user's hub content: none of them may reach an admin surface.
const NOTE_SECRET = 'quince-ledger-note-phrase';
const FILE_SECRET = 'bramble-trellis-file-phrase';
const LINK_ROLE = 'Head of Greenhouses';

function uniqueEmail(tag = ''): string {
  return `e2e-${test.info().testId}${tag}-${Date.now()}@example.test`;
}

function uniqueName(base: string): string {
  return `${base} ${test.info().testId.slice(0, 8)}`;
}

async function signInConfirmed(page: Page, tag = ''): Promise<{ userId: string; email: string }> {
  const result = await signInAs(page, { email: uniqueEmail(tag) });
  await confirmFilters(page);
  return result;
}

async function adminPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInAs(page, { email: uniqueEmail('-admin'), role: 'admin' });
  return page;
}

async function createRecord(page: Page, kind: Kind, name: string): Promise<RecordView> {
  return (await api.post<{ record: RecordView }>(page, `/api/hub/${kind}`, { name })).record;
}

interface Seeded {
  person: RecordView;
  company: RecordView;
  project: RecordView;
  noteTitle: string;
  fileName: string;
  fileId: string;
  /** Every user-entered string an admin must never see. */
  secrets: string[];
}

/** One record of each kind, a link with a role, a note and an extracted text file; counts: 3 records, 1 note, 1 file. */
async function seedHub(page: Page): Promise<Seeded> {
  const person = await createRecord(page, 'people', uniqueName('Hanna Pigwa'));
  const company = await createRecord(page, 'companies', uniqueName('Pigwa Orchards'));
  const project = await createRecord(page, 'projects', uniqueName('Trellis Rebuild'));
  await api.post(page, '/api/hub/links', {
    kind: 'person_company',
    personId: person.id,
    companyId: company.id,
    role: LINK_ROLE,
  });

  const noteTitle = uniqueName('Pruning calendar');
  await api.post(page, `/api/hub/people/${person.id}/notes`, {
    title: noteTitle,
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `Prune in March: ${NOTE_SECRET}.` }] }],
    },
  });

  const fileName = `trellis-${test.info().testId.slice(0, 8)}.txt`;
  const uploaded = await page.request.post(`/api/hub/projects/${project.id}/files`, {
    multipart: {
      file: { name: fileName, mimeType: 'text/plain', buffer: Buffer.from(`Trellis plan.\n${FILE_SECRET}\n`) },
    },
  });
  // 202 `{file}` with extraction pending (contracts/http-api.md "Files").
  expect(uploaded.status(), await uploaded.text()).toBe(202);
  const { file } = (await uploaded.json()) as { file: FileView };
  // The worker has read the file: the blob and the extracted text both exist before the checks below.
  await poll(
    () => api.get<{ file: FileView }>(page, `/api/hub/files/${file.id}`),
    (r) => r.file.extractionStatus !== 'pending',
    { timeoutMs: 90_000 },
  );

  return {
    person,
    company,
    project,
    noteTitle,
    fileName,
    fileId: file.id,
    secrets: [person.name, company.name, project.name, noteTitle, NOTE_SECRET, fileName, FILE_SECRET, LINK_ROLE],
  };
}

/** The `<dl>` of a "Context Hub" card, found by one of its labels. */
function hubList(page: Page, label: string) {
  return page.locator('dl').filter({ hasText: label });
}

/** The rendered value under `label` in a "Context Hub" card. */
async function shownCount(page: Page, list: ReturnType<typeof hubList>, label: string): Promise<number> {
  const value = await list
    .locator(':scope > div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd')
    .innerText();
  expect(value, label).toMatch(/^\d+$/);
  return Number(value);
}

/** Rows per `hub_*` table that still name the user; every hub table carries `user_id` (data-model.md). */
async function hubRowsOf(userId: string): Promise<Record<string, number>> {
  const tables = await sql<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name LIKE 'hub\\_%' AND column_name = 'user_id'
     ORDER BY table_name`,
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [row] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "${table_name}" WHERE user_id = $1`, [
      userId,
    ]);
    out[table_name] = row!.n;
  }
  return out;
}

function hubFilesDir(userId: string): string {
  return join(E2E_ENV.HUB_FILES_DIR!, userId.toLowerCase());
}

test.describe('hub US8: admin counts and account deletion', () => {
  test('US8.1 / FR-029 / SC-011: the admin screens and routes show hub counts only, never names, notes or files @ui', async ({
    page,
    browser,
  }) => {
    const { userId, email } = await signInConfirmed(page);
    const seeded = await seedHub(page);
    const expected: HubCounts = {
      recordCount: 3,
      noteCount: 1,
      fileCount: 1,
      pendingSuggestionCount: 0,
      syncFailedCount: 0,
      hubMailboxCount: 0,
    };

    const admin = await adminPage(browser);
    try {
      // User detail: the six counts, and nothing the user typed.
      await admin.goto(`/admin/users/${userId}`);
      await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(admin.getByText(email, { exact: true })).toBeVisible();
      const counts = hubList(admin, 'Hub mailboxes');
      await expect(counts).toBeVisible();
      await expect(admin.getByText('Counts only; hub content is never shown to admins.')).toBeVisible();
      for (const [key, label] of Object.entries(USER_COUNT_LABELS) as [keyof HubCounts, string][]) {
        expect(await shownCount(admin, counts, label), label).toBe(expected[key]);
      }
      const detailText = await admin.locator('body').innerText();
      for (const secret of seeded.secrets) expect(detailText, secret).not.toContain(secret);

      // Dashboard: six aggregates, integers only, still nothing of the user's.
      await admin.goto('/admin');
      await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();
      const aggregates = hubList(admin, 'LLM calls today');
      await expect(aggregates).toBeVisible();
      for (const label of Object.values(AGGREGATE_LABELS)) {
        expect(await shownCount(admin, aggregates, label)).toBeGreaterThanOrEqual(0);
      }
      const dashboardText = await admin.locator('body').innerText();
      for (const secret of seeded.secrets) expect(dashboardText, secret).not.toContain(secret);

      // The routes behind the screens carry the same numbers and no other hub field.
      const detail = await api.get<{ hub: HubCounts }>(admin, `/api/admin/users/${userId}`);
      expect(detail.hub).toEqual(expected);
      const detailJson = JSON.stringify(detail);
      for (const secret of seeded.secrets) expect(detailJson, secret).not.toContain(secret);
      for (const id of [seeded.person.id, seeded.company.id, seeded.project.id, seeded.fileId]) {
        expect(detailJson).not.toContain(id);
      }

      const health = await api.get<{ hub: HubAggregates }>(admin, '/api/admin/system/health');
      expect(Object.keys(health.hub).sort()).toEqual(Object.keys(AGGREGATE_LABELS).sort());
      for (const value of Object.values(health.hub)) {
        expect(Number.isInteger(value) && value >= 0, JSON.stringify(health.hub)).toBe(true);
      }
      const healthJson = JSON.stringify(health);
      for (const secret of seeded.secrets) expect(healthJson, secret).not.toContain(secret);

      // The admin has no way into the content itself: hub routes are owner-scoped, so the record is not found.
      await expect(api.get(admin, `/api/hub/people/${seeded.person.id}`)).rejects.toMatchObject({ status: 404 });
      const download = await admin.request.get(`/api/hub/files/${seeded.fileId}/download`);
      expect([403, 404]).toContain(download.status());
    } finally {
      await admin.context().close();
    }
  });

  test('US8.4 / FR-030 / SC-012: deleting the account removes every hub row, the file directory and the hub_ documents @ui', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const { userId } = await signInConfirmed(page);
    await seedHub(page);

    // Preconditions: the rows and the user's blob directory exist, so the checks after deletion mean something.
    const before = await hubRowsOf(userId);
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(20);
    for (const table of ['hub_person', 'hub_company', 'hub_project', 'hub_link', 'hub_note', 'hub_file']) {
      expect(before[table], table).toBeGreaterThanOrEqual(1);
    }
    expect(existsSync(hubFilesDir(userId)), hubFilesDir(userId)).toBe(true);

    // Delete the account through the settings dialog (as us7-deletion).
    await page.goto('/settings/account');
    await page.getByRole('button', { name: 'Delete account' }).click();
    const confirm = page.getByRole('dialog');
    const submit = confirm.getByRole('button', { name: 'Delete account' });
    await expect(submit).toBeDisabled();
    await confirm.getByLabel(/to confirm/).fill('DELETE');
    await submit.click();
    await page.waitForURL((u) => u.pathname === '/sign-in' && u.searchParams.get('deleted') === '1');

    // The deletion job (or, past its deadline, the maintenance job) completes well inside SC-012's 24 hours.
    const rows = await poll(
      () =>
        sql<{ status: string }>(
          `SELECT status FROM deletion_request WHERE scope = 'account' AND target_id = $1
           ORDER BY requested_at DESC LIMIT 1`,
          [userId],
        ),
      (r) => r[0]?.status === 'completed' || r[0]?.status === 'failed',
      { timeoutMs: 5 * 60_000, intervalMs: 1_000 },
    );
    expect(rows[0]?.status).toBe('completed');

    // Every hub table is empty for the user, the directory is gone, the store holds no hub_ document.
    const after = await hubRowsOf(userId);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(Object.fromEntries(Object.keys(after).map((t) => [t, 0])));
    expect(existsSync(hubFilesDir(userId))).toBe(false);
    const hubDocs = (await scanNamespace(userId)).filter((d) => d.id.startsWith('hub_'));
    expect(hubDocs.map((d) => d.id)).toEqual([]);
    expect(await sql('SELECT id FROM "user" WHERE id = $1', [userId])).toEqual([]);
  });
});
