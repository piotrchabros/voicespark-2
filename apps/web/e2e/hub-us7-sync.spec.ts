import type { Locator, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, confirmFilters, poll } from './support/api';
import { namespaceFor } from '@voicespark/integrations/supermemory';
import {
  failMemoryStoreFor,
  memory,
  rejectMemoryDocs,
  restoreMemoryStore,
  scanNamespace,
  type ScannedDoc,
} from './support/memory';
import { measure } from './support/timing';

// Hub US7 (quickstart "Memory store sync", rows US7.1..US7.4, FR-028 and the rejected-item edge; FR-025, FR-026,
// SC-010): the badge on record, note and file views, the sync section of /hub/settings, and the stored copies in the
// shared in-memory store (T080). Setup goes through the /api/hub routes; the store fails through the test-only
// `FailableMemoryStore` flag (support/memory.ts), scoped to this spec's users.

type Kind = 'people' | 'companies' | 'projects';
type SyncStatus = 'pending' | 'stored' | 'failed';

interface RecordView {
  id: string;
  name: string;
}

interface SyncField {
  status: SyncStatus;
  lastSyncedAt: string | null;
}

interface NoteView {
  id: string;
  title: string;
  body: unknown;
  sync: SyncField;
}

interface SyncStatusResponse {
  counts: Record<SyncStatus, number>;
  items: {
    id: string;
    entityType: string;
    entityId: string;
    label: string | null;
    status: SyncStatus;
    attempts: number;
    lastErrorCode: string | null;
    lastSyncedAt: string | null;
  }[];
  nextCursor: string | null;
}

const EMAIL = 'anna.nowak@acme-orchard.test';
const PHONE = '+48 601 234 567';
const CONTACTS = 'third_party_contacts';

function uniqueEmail(tag = ''): string {
  return `e2e-${test.info().testId}${tag}-${Date.now()}@example.test`;
}

function uniqueName(base: string): string {
  return `${base} ${test.info().testId.slice(0, 8)}`;
}

async function signInConfirmed(page: Page): Promise<{ userId: string; email: string }> {
  const result = await signInAs(page, { email: uniqueEmail() });
  await confirmFilters(page);
  return result;
}

async function createRecord(page: Page, kind: Kind, body: Record<string, unknown>): Promise<RecordView> {
  return (await api.post<{ record: RecordView }>(page, `/api/hub/${kind}`, body)).record;
}

function noteBody(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

async function createNote(page: Page, kind: Kind, recordId: string, title: string, text: string): Promise<NoteView> {
  const res = await api.post<{ note: NoteView } | NoteView>(page, `/api/hub/${kind}/${recordId}/notes`, {
    title,
    body: noteBody(text),
  });
  return 'note' in res ? res.note : res;
}

async function getNote(page: Page, id: string): Promise<NoteView> {
  const res = await api.get<{ note: NoteView } | NoteView>(page, `/api/hub/notes/${id}`);
  return 'note' in res ? res.note : res;
}

async function syncStatus(page: Page, query = ''): Promise<SyncStatusResponse> {
  return api.get<SyncStatusResponse>(page, `/api/hub/sync${query}`);
}

/** Every item of the user is stored (nothing waiting or failed). */
async function waitAllStored(page: Page, timeoutMs = 60_000): Promise<SyncStatusResponse> {
  return poll(
    () => syncStatus(page),
    (s) => s.counts.stored > 0 && s.counts.pending === 0 && s.counts.failed === 0,
    { timeoutMs, intervalMs: 1_000 },
  );
}

async function storedDoc(userId: string, docId: string): Promise<ScannedDoc | undefined> {
  return (await scanNamespace(userId)).find((d) => d.id === docId);
}

/** Polls the shared store until the document satisfies `until` (`undefined`: not in the store). */
async function waitForDoc(
  userId: string,
  docId: string,
  until: (doc: ScannedDoc | undefined) => boolean,
  timeoutMs = 60_000,
): Promise<ScannedDoc | undefined> {
  return poll(() => storedDoc(userId, docId), until, { timeoutMs, intervalMs: 1_000 });
}

/** Reloads until the badge in `scope` shows one of `statuses`. */
async function expectBadge(page: Page, scope: () => Locator, statuses: SyncStatus[], timeoutMs = 60_000) {
  await expect(async () => {
    await page.reload();
    const badge = scope().locator('[data-sync-status]').first();
    await expect(badge).toBeVisible({ timeout: 5_000 });
    expect(statuses).toContain(await badge.getAttribute('data-sync-status'));
  }).toPass({ timeout: timeoutMs, intervals: [1_000, 2_000] });
}

/** The three counts of the "Sync counts" list on /hub/settings. */
async function settingsCounts(page: Page): Promise<Record<'Stored' | 'Waiting' | 'Failed', number>> {
  const list = page.locator('dl[aria-label="Sync counts"]');
  await expect(list).toBeVisible();
  const read = async (label: string) => {
    const v = await list
      .locator(':scope > div')
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator('dd')
      .innerText();
    expect(v, label).toMatch(/^\d+$/);
    return Number(v);
  };
  return { Stored: await read('Stored'), Waiting: await read('Waiting'), Failed: await read('Failed') };
}

test.describe('hub US7: memory store sync', () => {
  test.afterEach(() => restoreMemoryStore());

  test('US7.1 / SC-010: a record and its note show "stored" within 1 minute @ui', async ({ page }) => {
    const { userId } = await signInConfirmed(page);
    const person = await createRecord(page, 'people', { name: uniqueName('Hanna Pigwa') });
    const noteTitle = uniqueName('Pruning plan');
    const note = await createNote(page, 'people', person.id, noteTitle, 'Prune the quince trees in March.');

    await page.goto(`/hub/people/${person.id}`);
    await measure('hub record and note stored', 'SC-010', 60_000, async () => {
      await expectBadge(page, () => page.locator('body'), ['stored']);
      await expectBadge(page, () => page.getByRole('article', { name: noteTitle }), ['stored']);
    });
    const recordBadge = page.locator('[data-sync-status]').first();
    await expect(recordBadge).toContainText('Sync: stored');
    await expect(recordBadge).toHaveAttribute('title', /^Last stored \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);

    // The API carries the same state, and the store holds both documents.
    expect((await api.get<{ sync: SyncField }>(page, `/api/hub/people/${person.id}`)).sync.status).toBe('stored');
    expect((await getNote(page, note.id)).sync.status).toBe('stored');
    const docs = await scanNamespace(userId);
    expect(docs.find((d) => d.id === `hub_person_${person.id}`)?.content).toContain(person.name);
    expect(docs.find((d) => d.id === `hub_note_${note.id}`)?.content).toContain('Prune the quince trees in March.');

    await page.goto('/hub/settings');
    await expect(page.getByRole('heading', { name: 'Memory store sync' })).toBeVisible();
    const counts = await settingsCounts(page);
    expect(counts).toMatchObject({ Waiting: 0, Failed: 0 });
    expect(counts.Stored).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('No failed items.')).toBeVisible();
  });

  test('US7.2 / FR-026: with the store down an edit shows failed or waiting, content stays, retry works once it is back @ui', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const person = await createRecord(page, 'people', { name: uniqueName('Jan Grusza') });
    const noteTitle = uniqueName('Harvest log');
    const note = await createNote(page, 'people', person.id, noteTitle, 'First harvest notes.');
    await waitAllStored(page);

    failMemoryStoreFor(userId);
    await api.patch(page, `/api/hub/notes/${note.id}`, { body: noteBody('Second harvest notes, kept safe.') });

    await page.goto(`/hub/people/${person.id}`);
    await expectBadge(page, () => page.getByRole('article', { name: noteTitle }), ['failed', 'pending'], 10_000);
    // VoiceSpark keeps the content: the edit is on screen and in the API.
    await expect(page.getByRole('article', { name: noteTitle })).toContainText('Second harvest notes, kept safe.');
    expect(JSON.stringify((await getNote(page, note.id)).body)).toContain('Second harvest notes, kept safe.');

    // The worker's attempt fails; the badge and the settings section say so.
    await expectBadge(page, () => page.getByRole('article', { name: noteTitle }), ['failed'], 30_000);
    await expect(page.getByRole('article', { name: noteTitle }).locator('[data-sync-status]')).toContainText(
      'Sync: failed',
    );
    await page.goto('/hub/settings');
    const failedList = page.getByRole('list', { name: 'Failed items' });
    await expect(failedList.getByText(noteTitle, { exact: true })).toBeVisible();
    expect((await settingsCounts(page)).Failed).toBeGreaterThanOrEqual(1);
    // The store still has the old copy.
    expect((await storedDoc(userId, `hub_note_${note.id}`))?.content).toContain('First harvest notes.');

    // The store is back: "Retry failed" sends the current state.
    restoreMemoryStore();
    await page.getByRole('button', { name: 'Retry failed' }).click();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: /queued again/ }),
    ).toBeVisible();
    await expect(async () => {
      await page.reload();
      expect(await settingsCounts(page)).toMatchObject({ Waiting: 0, Failed: 0 });
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
    await expect(page.getByText('No failed items.')).toBeVisible();
    const doc = await waitForDoc(userId, `hub_note_${note.id}`, (d) => !!d?.content.includes('Second harvest'));
    expect(doc!.content).not.toContain('First harvest notes.');
    expect((await getNote(page, note.id)).sync.status).toBe('stored');
  });

  test('edge: a rejected item stays saved, shows failed and can be retried on its own @ui', async ({ page }) => {
    const { userId } = await signInConfirmed(page);
    const person = await createRecord(page, 'people', { name: uniqueName('Ola Wiśnia') });
    await waitAllStored(page);
    const rejectedTitle = uniqueName('Rejected note');
    const acceptedTitle = uniqueName('Accepted note');
    // Create the note first, reject its id, then let the worker try: the wake-up job runs 2 s after the write.
    const rejected = await createNote(page, 'people', person.id, rejectedTitle, 'Rejected body text.');
    rejectMemoryDocs([`hub_note_${rejected.id}`]);
    await api.patch(page, `/api/hub/notes/${rejected.id}`, { body: noteBody('Rejected body text, second try.') });
    const accepted = await createNote(page, 'people', person.id, acceptedTitle, 'Accepted body text.');

    await poll(
      () => syncStatus(page, '?status=failed'),
      (s) => s.items.some((i) => i.entityId === rejected.id),
      { timeoutMs: 30_000, intervalMs: 1_000 },
    );
    await waitForDoc(userId, `hub_note_${accepted.id}`, (d) => !!d?.content.includes('Accepted body text.'));
    expect(JSON.stringify((await getNote(page, rejected.id)).body)).toContain('Rejected body text, second try.');

    await page.goto('/hub/settings');
    const failedList = page.getByRole('list', { name: 'Failed items' });
    await expect(failedList.getByText(rejectedTitle, { exact: true })).toBeVisible();
    await expect(failedList.getByText(acceptedTitle, { exact: true })).toHaveCount(0);

    restoreMemoryStore();
    await failedList.getByRole('button', { name: `Retry ${rejectedTitle}` }).click();
    await waitForDoc(userId, `hub_note_${rejected.id}`, (d) => !!d?.content.includes('second try'), 30_000);
    await expect(async () => {
      await page.reload();
      await expect(page.getByText('No failed items.')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
  });

  test('US7.2: a full re-sync returns every item to "stored" @ui', async ({ page }) => {
    const { userId } = await signInConfirmed(page);
    const person = await createRecord(page, 'people', { name: uniqueName('Ewa Jabłoń') });
    const company = await createRecord(page, 'companies', { name: uniqueName('Jabłoń Orchards') });
    await createNote(page, 'people', person.id, uniqueName('Visit'), 'Visit the orchard in May.');
    const before = await waitAllStored(page);
    const total = before.counts.stored;
    expect(total).toBeGreaterThanOrEqual(3);

    // A copy lost on the store side comes back with the re-sync.
    await memory().deleteDocuments(namespaceFor(userId), [`hub_company_${company.id}`]);
    expect(await storedDoc(userId, `hub_company_${company.id}`)).toBeUndefined();

    await page.goto('/hub/settings');
    await page.getByRole('button', { name: 'Re-sync everything' }).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Re-sync started' })).toBeVisible();
    await expect(async () => {
      await page.reload();
      expect(await settingsCounts(page)).toEqual({ Stored: total, Waiting: 0, Failed: 0 });
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000] });
    expect((await syncStatus(page)).counts).toEqual({ stored: total, pending: 0, failed: 0 });
    expect((await storedDoc(userId, `hub_company_${company.id}`))?.content).toContain(company.name);
  });

  test('US7.3 / FR-025: rename and link reach the stored copies of notes, files and linked records', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const oldName = uniqueName('Piotr Śliwa');
    const newName = uniqueName('Piotr Morela');
    const person = await createRecord(page, 'people', { name: oldName });
    const company = await createRecord(page, 'companies', { name: uniqueName('Morela Farms') });
    const note = await createNote(page, 'people', person.id, uniqueName('Contract'), 'Contract renewal in June.');
    const uploaded = await page.request.post(`/api/hub/people/${person.id}/files`, {
      multipart: {
        file: { name: `plan-${test.info().testId.slice(0, 8)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Plan.\n') },
      },
    });
    expect(uploaded.status(), await uploaded.text()).toBe(202);
    const { file } = (await uploaded.json()) as { file: { id: string } };
    await waitForDoc(userId, `hub_file_${file.id}`, (d) => !!d?.content.includes(oldName), 90_000);
    await waitForDoc(userId, `hub_note_${note.id}`, (d) => !!d?.content.includes(oldName));

    await api.patch(page, `/api/hub/people/${person.id}`, { name: newName });
    await api.post(page, '/api/hub/links', {
      kind: 'person_company',
      personId: person.id,
      companyId: company.id,
      role: 'Buyer',
    });

    const renamed = (d: ScannedDoc | undefined) => !!d && d.content.includes(newName) && !d.content.includes(oldName);
    await waitForDoc(userId, `hub_note_${note.id}`, renamed);
    await waitForDoc(userId, `hub_file_${file.id}`, renamed);
    const personDoc = await waitForDoc(userId, `hub_person_${person.id}`, (d) => renamed(d) && d!.content.includes(company.name));
    expect(personDoc!.content).toContain('Buyer');
    await waitForDoc(userId, `hub_company_${company.id}`, renamed);
    await waitAllStored(page);
  });

  test('US7.4: a deleted note, and a deleted record with its files, are removed from the store', async ({ page }) => {
    const { userId } = await signInConfirmed(page);
    const person = await createRecord(page, 'people', { name: uniqueName('Zofia Gruszka') });
    const keep = await createNote(page, 'people', person.id, uniqueName('Keep'), 'Keep this one.');
    const gone = await createNote(page, 'people', person.id, uniqueName('Remove'), 'Remove this one.');
    await waitAllStored(page);
    expect(await storedDoc(userId, `hub_note_${gone.id}`)).toBeDefined();

    await api.delete(page, `/api/hub/notes/${gone.id}`);
    await waitForDoc(userId, `hub_note_${gone.id}`, (d) => d === undefined);
    expect(await storedDoc(userId, `hub_note_${keep.id}`)).toBeDefined();
    // The tombstone is not an item of the hub any more.
    expect((await syncStatus(page)).items.some((i) => i.entityId === gone.id)).toBe(false);

    await api.delete(page, `/api/hub/people/${person.id}`);
    await waitForDoc(userId, `hub_person_${person.id}`, (d) => d === undefined);
    await waitForDoc(userId, `hub_note_${keep.id}`, (d) => d === undefined);
    expect((await scanNamespace(userId)).filter((d) => d.id.startsWith('hub_'))).toEqual([]);
  });

  test('FR-028: contact values are stored only while "other people\'s contact details" is not selected', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const prefs = await api.get<{ selectedCategories: string[] }>(page, '/api/filter-preferences');
    expect(prefs.selectedCategories).toContain(CONTACTS);
    const name = uniqueName('Anna Nowak');
    const person = await createRecord(page, 'people', { name, phone: PHONE, emails: [EMAIL] });
    const docId = `hub_person_${person.id}`;

    // Selected (the default): names only, no contact lines.
    const selected = await waitForDoc(userId, docId, (d) => !!d?.content.includes(name));
    expect(selected!.content).not.toContain(EMAIL);
    expect(selected!.content).not.toContain(PHONE);
    expect(selected!.content).not.toContain('Email:');

    // Not selected: the re-filter marks every item dirty and the rebuilt copy carries the contact values.
    await api.put(page, '/api/filter-preferences', {
      selectedCategories: prefs.selectedCategories.filter((c) => c !== CONTACTS),
    });
    const notSelected = await waitForDoc(userId, docId, (d) => !!d?.content.includes(`Email: ${EMAIL}`), 90_000);
    expect(notSelected!.content).toContain(`Phone: ${PHONE}`);
    // The values never go into metadata.
    expect(JSON.stringify(notSelected!.metadata)).not.toContain(EMAIL);

    // Selected again: the contact lines leave the store; the record itself keeps them.
    await api.put(page, '/api/filter-preferences', { selectedCategories: prefs.selectedCategories });
    const again = await waitForDoc(userId, docId, (d) => !!d && d.content.includes(name) && !d.content.includes(EMAIL), 90_000);
    expect(again!.content).not.toContain(PHONE);
    const record = await api.get<{ record: { emails: { address: string }[]; phone: string | null } }>(
      page,
      `/api/hub/people/${person.id}`,
    );
    expect(record.record.emails.map((e) => e.address)).toContain(EMAIL);
    expect(record.record.phone).toBe(PHONE);
  });
});
