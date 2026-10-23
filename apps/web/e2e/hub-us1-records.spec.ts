import type { Browser, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, ApiError, confirmFilters } from './support/api';

// Hub US1 (quickstart section 8 "Records, links, notes, files", rows US1.1..US1.5 and FR-006): people, companies and
// projects. Setup that is not under test (notes, files, links, the second record of a sort) goes through the API;
// the rows themselves run in the browser against the hub screens (T050..T052), with the API as the oracle.

type Kind = 'people' | 'companies' | 'projects';

interface PersonView {
  id: string;
  name: string;
  emails: { address: string }[];
}

interface RecordView {
  id: string;
  name: string;
}

interface SimilarEnvelope {
  record: RecordView;
  similar: { id: string; name: string }[];
}

interface ListEnvelope {
  items: RecordView[];
  nextCursor: string | null;
}

function uniqueEmail(tag = ''): string {
  return `e2e-${test.info().testId}${tag}-${Date.now()}@example.test`;
}

/** Names carry a per-test suffix so lists from earlier runs never interfere with order assertions. */
function uniqueName(base: string): string {
  return `${base} ${test.info().testId.slice(0, 8)}`;
}

async function signInConfirmed(page: Page, tag = ''): Promise<{ userId: string; email: string }> {
  const result = await signInAs(page, { email: uniqueEmail(tag) });
  await confirmFilters(page);
  return result;
}

async function secondUser(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInConfirmed(page, '-other');
  return page;
}

async function createRecord(page: Page, kind: Kind, body: Record<string, unknown>): Promise<SimilarEnvelope> {
  return api.post<SimilarEnvelope>(page, `/api/hub/${kind}`, body);
}

async function listNames(page: Page, kind: Kind, query: string): Promise<string[]> {
  const list = await api.get<ListEnvelope>(page, `/api/hub/${kind}?${query}`);
  return list.items.map((i) => i.name);
}

/** Names of the rows on the list screen, in display order (UI contract: list "People" / "Companies" / "Projects"). */
async function visibleNames(page: Page, listName: string): Promise<string[]> {
  const rows = page.getByRole('list', { name: listName }).getByRole('listitem');
  const links = rows.getByRole('link');
  const texts = await links.allInnerTexts();
  return texts.map((t) => t.trim());
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status });
  await promise.catch((e) => expect(e).toBeInstanceOf(ApiError));
}

test.describe('hub US1: records', () => {
  test('US1.1: a person with two email addresses is listed and shows both', async ({ page }) => {
    await signInConfirmed(page);
    const name = uniqueName('Ewa Kowalska');
    const first = `ewa-${Date.now()}@example.test`;
    const second = `ewa.work-${Date.now()}@example.test`;

    await page.goto('/hub/people/new');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Email address').fill(first);
    await page.getByRole('button', { name: 'Add email' }).click();
    await page.getByLabel('Email address').fill(second);
    await page.getByRole('button', { name: 'Add email' }).click();
    await page.getByRole('button', { name: 'Save' }).click();

    // After saving, the detail page shows the fields and both addresses.
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText(first)).toBeVisible();
    await expect(page.getByText(second)).toBeVisible();

    const people = await api.get<ListEnvelope>(page, '/api/hub/people');
    const listed = people.items.find((p) => p.name === name) as PersonView | undefined;
    expect(listed?.emails.map((e) => e.address).sort()).toEqual([first, second].sort());

    await page.goto('/hub/people');
    await expect(page.getByRole('list', { name: 'People' }).getByRole('link', { name })).toBeVisible();
  });

  test('US1.2 / FR-002: a project whose end date is before its start date is refused', async ({ page }) => {
    await signInConfirmed(page);
    const name = uniqueName('Orchard Refit');

    await page.goto('/hub/projects/new');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Start date').fill('2026-06-10');
    await page.getByLabel('End date').fill('2026-06-01');
    await page.getByRole('button', { name: 'Save' }).click();

    // Explanation as an alert; nothing is saved and the form stays on screen.
    await expect(page.getByRole('alert').filter({ hasText: /end date/i })).toContainText(/end date/i);
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    expect(await listNames(page, 'projects', 'limit=100')).not.toContain(name);

    // The API refuses the same input (validation_failed, 422), not only the form.
    await expect(
      createRecord(page, 'projects', { name, startDate: '2026-06-10', endDate: '2026-06-01' }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });

    // Fixing the end date makes the same form saveable.
    await page.getByLabel('End date').fill('2026-06-30');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    expect(await listNames(page, 'projects', 'limit=100')).toContain(name);
  });

  test('US1.3 / FR-003: a same name ignoring case warns with a link and never blocks the save', async ({ page }) => {
    await signInConfirmed(page);
    const name = uniqueName('Anna Nowak');
    const first = await createRecord(page, 'people', { name });
    expect(first.similar).toEqual([]);

    // Create path: the second "anna nowak" is saved, and the warning links to the first.
    await page.goto('/hub/people/new');
    await page.getByLabel('Name').fill(name.toLowerCase());
    await page.getByRole('button', { name: 'Save' }).click();
    const warning = page.getByRole('region', { name: 'Similar records' });
    await expect(warning).toBeVisible();
    await expect(warning.getByRole('link', { name })).toHaveAttribute('href', `/hub/people/${first.record.id}`);
    const names = await listNames(page, 'people', 'limit=100');
    expect(names.filter((n) => n.toLowerCase() === name.toLowerCase())).toHaveLength(2);

    // Rename path: renaming a third record to the same name warns too and still saves.
    const third = await createRecord(page, 'people', { name: uniqueName('Jan Zielinski') });
    await page.goto(`/hub/people/${third.record.id}`);
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('region', { name: 'Similar records' })).toBeVisible();
    const renamed = await api.get<{ record: RecordView }>(page, `/api/hub/people/${third.record.id}`);
    expect(renamed.record.name).toBe(name);
  });

  test('US1.4 / FR-004: delete shows counts first, then removes the record and keeps linked records', async ({ page }) => {
    await signInConfirmed(page);
    const person = await createRecord(page, 'people', { name: uniqueName('Marta Lis') });
    const company = await createRecord(page, 'companies', { name: uniqueName('Lis Garden') });
    const personId = person.record.id;

    await api.post(page, '/api/hub/links', {
      kind: 'person_company',
      personId,
      companyId: company.record.id,
    });
    for (const title of ['First note', 'Second note']) {
      await api.post(page, `/api/hub/people/${personId}/notes`, {
        title,
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain text.' }] }] },
      });
    }
    const upload = await page.request.post(`/api/hub/people/${personId}/files`, {
      multipart: { file: { name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Herb bed plan for spring.') } },
    });
    expect(upload.status()).toBe(202);

    const preview = await api.get<{ notes: number; files: number; links: number }>(
      page,
      `/api/hub/people/${personId}?deletePreview=1`,
    );
    expect(preview).toEqual({ notes: 2, files: 1, links: 1 });

    await page.goto(`/hub/people/${personId}`);
    await page.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete record' });
    await expect(dialog).toContainText('2 notes');
    await expect(dialog).toContainText('1 file');
    await expect(dialog).toContainText('1 link');
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    await page.waitForURL('**/hub/people');

    await expectApiError(api.get(page, `/api/hub/people/${personId}`), 404);
    // The linked company remains and no longer lists the link.
    const kept = await api.get<{ record: RecordView; links: unknown[] }>(page, `/api/hub/companies/${company.record.id}`);
    expect(kept.record.name).toBe(company.record.name);
    expect(kept.links).toHaveLength(0);
  });

  test('US1.5 / FR-001: a second user sees nothing of the first, and direct URLs give 404', async ({ page, browser }) => {
    await signInConfirmed(page);
    const mine = await createRecord(page, 'people', { name: uniqueName('Private Person') });
    const mineCompany = await createRecord(page, 'companies', { name: uniqueName('Private Company') });
    const mineProject = await createRecord(page, 'projects', { name: uniqueName('Private Project') });

    const other = await secondUser(browser);
    for (const kind of ['people', 'companies', 'projects'] as const) {
      const list = await api.get<ListEnvelope>(other, `/api/hub/${kind}?limit=100`);
      expect(list.items).toEqual([]);
    }
    const search = await api.get<{ items: unknown[] }>(other, `/api/hub/search?q=${encodeURIComponent('Private')}`);
    expect(search.items).toEqual([]);

    await expectApiError(api.get(other, `/api/hub/people/${mine.record.id}`), 404);
    await expectApiError(api.patch(other, `/api/hub/companies/${mineCompany.record.id}`, { name: 'Taken' }), 404);
    await expectApiError(api.delete(other, `/api/hub/projects/${mineProject.record.id}`), 404);

    // The screens answer 404 too (the app's not-found page), and the list screen is empty.
    for (const [kind, id] of [
      ['people', mine.record.id],
      ['companies', mineCompany.record.id],
      ['projects', mineProject.record.id],
    ] as const) {
      const res = await other.goto(`/hub/${kind}/${id}`);
      expect(res?.status()).toBe(404);
    }
    await other.goto('/hub/people');
    expect(await visibleNames(other, 'People')).toEqual([]);

    // Nothing was changed by the foreign calls.
    const still = await api.get<{ record: RecordView }>(page, `/api/hub/companies/${mineCompany.record.id}`);
    expect(still.record.name).toBe(mineCompany.record.name);
  });

  test('FR-006: lists sort by name, then by last change', async ({ page }) => {
    await signInConfirmed(page);
    const tag = test.info().testId.slice(0, 8);
    const names = [`Charlie ${tag}`, `alpha ${tag}`, `Bravo ${tag}`];
    const created: RecordView[] = [];
    for (const name of names) {
      created.push((await createRecord(page, 'companies', { name })).record);
      // updated_at has to differ between records.
      await page.waitForTimeout(25);
    }

    // By name, ascending, ignoring case: alpha, Bravo, Charlie.
    const byName = [`alpha ${tag}`, `Bravo ${tag}`, `Charlie ${tag}`];
    expect(await listNames(page, 'companies', 'sort=name&order=asc&limit=100')).toEqual(byName);
    await page.goto('/hub/companies');
    await page.getByLabel('Sort by').selectOption({ label: 'Name' });
    await expect.poll(() => visibleNames(page, 'Companies')).toEqual(byName);

    // Touch the oldest record (Charlie), so it is the most recent change.
    const oldest = created[0]!;
    await api.patch(page, `/api/hub/companies/${oldest.id}`, { industry: 'Gardening' });
    // Newest change first: the patched record, then the rest in reverse creation order.
    expect(await listNames(page, 'companies', 'sort=updated&order=desc&limit=100')).toEqual([
      oldest.name,
      `Bravo ${tag}`,
      `alpha ${tag}`,
    ]);

    await page.getByLabel('Sort by').selectOption({ label: 'Last change' });
    await expect
      .poll(() => visibleNames(page, 'Companies'))
      .toEqual([oldest.name, `Bravo ${tag}`, `alpha ${tag}`]);
  });
});
