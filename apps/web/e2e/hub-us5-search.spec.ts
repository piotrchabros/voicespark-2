import type { Browser, Locator, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, confirmFilters, poll } from './support/api';

// Hub US5 (quickstart "Search", rows US5.1..US5.4 and "Search rules"): keyword search over the user's own hub with
// highlighted snippets (T093). Setup goes through the API; each row runs in the browser on the search screen, with
// the API as the oracle. The search index holds only keyed token hashes; results come from decrypted content.

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

interface SearchItem {
  type: 'person' | 'company' | 'project' | 'note' | 'file';
  id: string;
  title: string;
  owner: { kind: string; id: string; name: string } | null;
  snippets: { text: string; highlights: [number, number][] }[];
  updatedAt: string;
}

interface SearchEnvelope {
  items: SearchItem[];
  nextCursor: string | null;
}

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

async function secondUser(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInConfirmed(page, '-other');
  return page;
}

async function createRecord(page: Page, kind: Kind, name: string): Promise<RecordView> {
  return (await api.post<{ record: RecordView }>(page, `/api/hub/${kind}`, { name })).record;
}

async function addNote(page: Page, kind: Kind, id: string, title: string, text: string): Promise<void> {
  await api.post(page, `/api/hub/${kind}/${id}/notes`, {
    title,
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  });
}

/** A one-page PDF with real text (Helvetica, uncompressed content stream). */
function makePdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 40 740 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function searchApi(page: Page, q: string, types?: string): Promise<SearchEnvelope> {
  const params = new URLSearchParams({ q });
  if (types) params.set('types', types);
  return api.get<SearchEnvelope>(page, `/api/hub/search?${params.toString()}`);
}

/** Types the query into the hub search box and submits it (UI contract: searchbox "Search hub"). */
async function searchUi(page: Page, q: string): Promise<void> {
  const box = page.getByRole('searchbox', { name: 'Search hub' });
  await box.fill(q);
  await box.press('Enter');
  await expect(page).toHaveURL(/\/hub\/search\?/);
  await expect(page.getByRole('heading', { name: `Results for “${q}”` })).toBeVisible();
}

function resultRows(page: Page): Locator {
  return page.getByRole('list', { name: 'Search results' }).getByRole('listitem');
}

function typeChip(page: Page, label: string): Locator {
  return page.getByRole('navigation', { name: 'Filter by type' }).getByRole('link', { name: label, exact: true });
}

test.describe('hub US5: search', () => {
  test('US5.1 / FR-011: a word in a note is found with a highlighted snippet and the record name', async ({ page }) => {
    await signInConfirmed(page);
    const person = await createRecord(page, 'people', uniqueName('Ewa Kowalska'));
    await addNote(
      page,
      'people',
      person.id,
      'Call with the grower',
      'We discussed the thermostat budget for the spring beds and agreed to meet in May.',
    );

    // API oracle: a note result owned by the person, with offsets that point at the word (no HTML).
    const { items } = await searchApi(page, 'thermostat');
    expect(items.map((i) => i.type)).toEqual(['note']);
    const note = items[0]!;
    expect(note.title).toBe('Call with the grower');
    expect(note.owner).toMatchObject({ kind: 'person', id: person.id, name: person.name });
    expect(note.snippets.length).toBeGreaterThanOrEqual(1);
    expect(note.snippets.length).toBeLessThanOrEqual(2);
    const [snippet] = note.snippets;
    expect(snippet!.text).not.toMatch(/<\/?[a-z]/i);
    expect(snippet!.highlights.length).toBeGreaterThanOrEqual(1);
    const [start, end] = snippet!.highlights[0]!;
    expect(snippet!.text.slice(start, end).toLowerCase()).toBe('thermostat');

    // Screen: the row shows the note type, its title, the record name as a link and the word marked.
    await page.goto('/hub/search');
    await searchUi(page, 'thermostat');
    const rows = resultRows(page);
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row).toContainText('Note');
    await expect(row).toContainText('Call with the grower');
    await expect(row.getByRole('link', { name: person.name })).toHaveAttribute('href', `/hub/people/${person.id}`);
    await expect(row.locator('mark')).toHaveText(/thermostat/i);
    // Highlights are React elements, never injected markup.
    expect(await row.locator('script').count()).toBe(0);
  });

  test('US5.2: a word only inside an attached PDF finds the file', async ({ page }) => {
    await signInConfirmed(page);
    const company = await createRecord(page, 'companies', uniqueName('Lis Garden'));
    const upload = await page.request.post(`/api/hub/companies/${company.id}/files`, {
      multipart: {
        file: {
          name: 'schedule.pdf',
          mimeType: 'application/pdf',
          buffer: makePdf('Greenhouse pergola irrigation schedule for the spring beds'),
        },
      },
    });
    expect(upload.status()).toBe(202);
    const fileId = ((await upload.json()) as { file: FileView }).file.id;

    // The word is indexed once the worker has read the file (same transaction as the text arrival).
    const { file } = await poll(
      () => api.get<{ file: FileView }>(page, `/api/hub/files/${fileId}`),
      (r) => r.file.extractionStatus !== 'pending',
      { timeoutMs: 90_000 },
    );
    expect(file.extractionStatus).toBe('extracted');
    const found = await poll(
      () => searchApi(page, 'pergola'),
      (r) => r.items.some((i) => i.type === 'file' && i.id === fileId),
      { timeoutMs: 15_000 },
    );
    const item = found.items.find((i) => i.id === fileId)!;
    expect(item.title).toBe('schedule.pdf');
    expect(item.owner).toMatchObject({ kind: 'company', id: company.id, name: company.name });
    expect(item.snippets[0]!.text.toLowerCase()).toContain('pergola');

    await page.goto('/hub/search');
    await searchUi(page, 'pergola');
    const row = resultRows(page).filter({ hasText: 'schedule.pdf' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('File');
    await expect(row.getByRole('link', { name: company.name })).toHaveAttribute(
      'href',
      `/hub/companies/${company.id}`,
    );
    await expect(row.locator('mark').first()).toHaveText(/pergola/i);
  });

  test('US5.3: filtering to "people" shows only people', async ({ page }) => {
    await signInConfirmed(page);
    const person = await createRecord(page, 'people', uniqueName('Marigold Baker'));
    const company = await createRecord(page, 'companies', uniqueName('Marigold Supplies'));
    const project = await createRecord(page, 'projects', uniqueName('Marigold Launch'));

    const all = await searchApi(page, 'marigold');
    expect(all.items.map((i) => i.id).sort()).toEqual([person.id, company.id, project.id].sort());
    const people = await searchApi(page, 'marigold', 'person');
    expect(people.items.map((i) => [i.type, i.id])).toEqual([['person', person.id]]);

    await page.goto('/hub/search');
    await searchUi(page, 'marigold');
    await expect(resultRows(page)).toHaveCount(3);

    await typeChip(page, 'People').click();
    await expect(page).toHaveURL(/types=person/);
    await expect(typeChip(page, 'People')).toHaveAttribute('aria-current', 'true');
    const rows = resultRows(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Person');
    await expect(rows.first().getByRole('link', { name: person.name })).toHaveAttribute(
      'href',
      `/hub/people/${person.id}`,
    );
    await expect(page.getByRole('list', { name: 'Search results' })).not.toContainText(company.name);
    await expect(page.getByRole('list', { name: 'Search results' })).not.toContainText(project.name);

    // Back to every type.
    await typeChip(page, 'All').click();
    await expect(resultRows(page)).toHaveCount(3);
  });

  test('US5.4 / FR-001: another user finds nothing from the first user', async ({ page, browser }) => {
    await signInConfirmed(page);
    const person = await createRecord(page, 'people', uniqueName('Zinnia Private'));
    await addNote(page, 'people', person.id, 'Private note', 'The quietwater contract is confidential.');
    expect((await searchApi(page, 'quietwater')).items).toHaveLength(1);

    const other = await secondUser(browser);
    for (const q of ['quietwater', 'Zinnia', 'confidential', 'Private']) {
      expect((await searchApi(other, q)).items, q).toEqual([]);
    }
    await other.goto('/hub/search');
    await searchUi(other, 'quietwater');
    await expect(other.getByRole('status')).toContainText('No results');
    await expect(other.getByRole('list', { name: 'Search results' })).toHaveCount(0);
    await expect(other.locator('body')).not.toContainText(person.name);

    // The first user still finds it.
    expect((await searchApi(page, 'quietwater')).items.map((i) => i.owner?.id)).toEqual([person.id]);
  });

  test('search rules: a word prefix matches; an accent difference does not (not folded in v1)', async ({ page }) => {
    await signInConfirmed(page);
    const project = await createRecord(page, 'projects', uniqueName('Orchard Refit'));
    await addNote(page, 'projects', project.id, 'Site visit', 'The hydroponics bay in Kraków needs new lighting.');

    // Prefix: "hydro" finds "hydroponics"; the highlight covers the matched prefix of the word.
    const prefix = await searchApi(page, 'hydro');
    expect(prefix.items.map((i) => i.owner?.id)).toEqual([project.id]);
    const [start, end] = prefix.items[0]!.snippets[0]!.highlights[0]!;
    expect(prefix.items[0]!.snippets[0]!.text.slice(start, end).toLowerCase().startsWith('hydro')).toBe(true);

    await page.goto('/hub/search');
    await searchUi(page, 'hydro');
    const rows = resultRows(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Site visit');
    await expect(rows.first().locator('mark').first()).toHaveText(/^hydro/i);

    // Accent: the exact spelling matches; the unaccented spelling does not.
    expect((await searchApi(page, 'Kraków')).items.map((i) => i.owner?.id)).toEqual([project.id]);
    expect((await searchApi(page, 'Krakow')).items).toEqual([]);
    await searchUi(page, 'Krakow');
    await expect(page.getByRole('status')).toContainText('No results');
  });
});
