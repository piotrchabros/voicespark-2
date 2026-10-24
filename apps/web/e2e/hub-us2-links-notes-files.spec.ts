import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, ApiError, confirmFilters, poll } from './support/api';
import { E2E_ENV } from './support/env';
import { scanNamespace } from './support/memory';

// Hub US2 (quickstart section 8 "Records, links, notes, files", rows US2.1..US2.7, the extraction edges and SC-001):
// links with roles, rich-text notes and files on the detail screens (T067, T068). Setup that is not under test goes
// through the API; each row runs in the browser, with the API as the oracle.

type Kind = 'people' | 'companies' | 'projects';

interface RecordView {
  id: string;
  name: string;
}

interface LinkedEnvelope {
  record: RecordView;
  links: { link: { id: string; role: string | null }; other: { id: string; name: string } }[];
}

interface FileView {
  id: string;
  name: string;
  extractionStatus: 'pending' | 'extracted' | 'empty' | 'unsupported' | 'failed' | 'excluded';
  extractionReason: string | null;
  redactedValues: number;
}

interface NoteView {
  id: string;
  title: string;
  body: unknown;
  redactedValues: number;
}

const MAX_FILE_BYTES = 26_214_400;
const PASSWORD = 'Tr0ub4dor&3x';
const FILE_PASSWORD = 'Gr33nH0use!9';
const PASSWORD_RESET_TEXT =
  'Reset your password here: https://app.service.test/reset/password?token=aB3dE9fG7hJ2kL5mN8pQ and enter verification code 482913.';
// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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

async function newPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

async function createRecord(page: Page, kind: Kind, name: string): Promise<RecordView> {
  return (await api.post<{ record: RecordView }>(page, `/api/hub/${kind}`, { name })).record;
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

function linkRow(page: Page, name: string): Locator {
  return page.getByRole('list', { name: 'Linked records' }).getByRole('listitem').filter({ hasText: name });
}

function fileRow(page: Page, name: string): Locator {
  return page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name });
}

function alertWith(scope: Page | Locator, text: RegExp): Locator {
  return scope.getByRole('alert').filter({ hasText: text });
}

async function listFiles(page: Page, kind: Kind, id: string): Promise<FileView[]> {
  return (await api.get<{ items: FileView[] }>(page, `/api/hub/${kind}/${id}/files`)).items;
}

async function fileByName(page: Page, kind: Kind, id: string, name: string): Promise<FileView> {
  const files = await poll(
    () => listFiles(page, kind, id),
    (items) => items.some((f) => f.name === name),
    { timeoutMs: 15_000 },
  );
  return files.find((f) => f.name === name)!;
}

/** Waits until the worker has read the file (any status but `pending`). */
async function settled(page: Page, fileId: string): Promise<FileView> {
  const { file } = await poll(
    () => api.get<{ file: FileView }>(page, `/api/hub/files/${fileId}`),
    (r) => r.file.extractionStatus !== 'pending',
    { timeoutMs: 90_000 },
  );
  return file;
}

/** Attaches a file through the upload form and returns the number of user steps it took (SC-001). */
async function attachThroughUi(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  description?: string,
): Promise<number> {
  let steps = 0;
  await page.getByLabel('File', { exact: true }).setInputFiles(file);
  steps++;
  if (description) {
    await page.getByLabel('Description (optional)').fill(description);
    steps++;
  }
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  steps++;
  return steps;
}

function filesUnder(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(filesUnder(p));
    else out.push(p);
  }
  return out;
}

test.describe('hub US2: links, notes, files', () => {
  test('US2.1 / US2.2 / FR-007: a CTO link shows on both records; a second link for the pair opens the role editor', async ({
    page,
  }) => {
    await signInConfirmed(page);
    const personName = uniqueName('Piotr Sad');
    const companyName = uniqueName('Sad Gardens');
    const person = await createRecord(page, 'people', personName);
    const company = await createRecord(page, 'companies', companyName);

    // US2.1: link from the person's screen with the role "CTO".
    await page.goto(`/hub/people/${person.id}`);
    await page.getByLabel('Link to', { exact: true }).selectOption({ label: 'Company' });
    await page.getByLabel('Record', { exact: true }).selectOption({ label: companyName });
    await page.getByLabel('Role (optional)').fill('CTO');
    await page.getByRole('button', { name: 'Add link', exact: true }).click();
    await expect(linkRow(page, companyName)).toContainText('CTO');

    await page.goto(`/hub/companies/${company.id}`);
    await expect(linkRow(page, personName)).toContainText('CTO');
    await expect(linkRow(page, personName).getByRole('link', { name: personName })).toHaveAttribute(
      'href',
      `/hub/people/${person.id}`,
    );
    const fromCompany = await api.get<LinkedEnvelope>(page, `/api/hub/companies/${company.id}`);
    expect(fromCompany.links.map((l) => [l.other.id, l.link.role])).toEqual([[person.id, 'CTO']]);
    const linkId = fromCompany.links[0]!.link.id;

    // US2.2: the same pair again is refused; the role editor of the existing link opens instead.
    await page.goto(`/hub/people/${person.id}`);
    await page.getByLabel('Link to', { exact: true }).selectOption({ label: 'Company' });
    await page.getByLabel('Record', { exact: true }).selectOption({ label: companyName });
    await page.getByLabel('Role (optional)').fill('Advisor');
    await page.getByRole('button', { name: 'Add link', exact: true }).click();
    await expect(page.getByText('These records are already linked.')).toBeVisible();
    const roleInput = page.getByRole('textbox', { name: `Role for ${companyName}` });
    await expect(roleInput).toBeVisible();
    await expect(roleInput).toHaveValue('CTO');

    // A role over 100 characters is refused by the form and by the API.
    await roleInput.fill('x'.repeat(101));
    await page.getByRole('button', { name: 'Update role' }).click();
    await expect(alertWith(page, /at most 100 characters/)).toBeVisible();
    await expect(api.patch(page, `/api/hub/links/${linkId}`, { role: 'x'.repeat(101) })).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
    });

    await roleInput.fill('CEO');
    await page.getByRole('button', { name: 'Update role' }).click();
    await expect(linkRow(page, companyName)).toContainText('CEO');

    // The API refuses the duplicate with the id of the existing link.
    const dup = await api
      .post(page, '/api/hub/links', { kind: 'person_company', personId: person.id, companyId: company.id })
      .catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(ApiError);
    expect(dup).toMatchObject({ status: 409, code: 'link_exists' });
    expect((dup as ApiError).body).toMatchObject({ error: { details: { linkId } } });

    const after = await api.get<LinkedEnvelope>(page, `/api/hub/people/${person.id}`);
    expect(after.links.map((l) => [l.other.id, l.link.role])).toEqual([[company.id, 'CEO']]);
  });

  test('US2.3: two people cannot be linked: the option is not offered and the API refuses', async ({ page }) => {
    await signInConfirmed(page);
    const first = await createRecord(page, 'people', uniqueName('Ola Brzoza'));
    const second = await createRecord(page, 'people', uniqueName('Ida Brzoza'));

    await page.goto(`/hub/people/${first.id}`);
    const options = await page.getByLabel('Link to', { exact: true }).locator('option').allInnerTexts();
    expect(options.map((o) => o.trim())).toEqual(['Company', 'Project']);

    await expect(
      api.post(page, '/api/hub/links', { kind: 'person_company', personId: first.id, companyId: second.id }),
    ).rejects.toMatchObject({ status: 409, code: 'invalid_link' });
    const still = await api.get<LinkedEnvelope>(page, `/api/hub/people/${first.id}`);
    expect(still.links).toEqual([]);
  });

  test('US2.4 / FR-008: a note with heading, checklist and link keeps its formatting; javascript: links are refused', async ({
    page,
  }) => {
    await signInConfirmed(page);
    const project = await createRecord(page, 'projects', uniqueName('Spring Beds'));
    const href = 'https://seeds.example.test/catalog';

    await page.goto(`/hub/projects/${project.id}`);
    await page.getByRole('button', { name: 'New note' }).click();
    const text = page.getByRole('textbox', { name: 'Note text' });
    await page.getByLabel('Title', { exact: true }).fill('Garden plan');
    await text.click();
    await page.getByRole('button', { name: 'Heading 1', exact: true }).click();
    await page.keyboard.type('Seed plan');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Checklist', exact: true }).click();
    await page.keyboard.type('Order seeds');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Prepare beds');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Supplier: ');

    // A javascript: link is refused by the editor.
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await page.getByLabel('Link address').fill('javascript:alert(1)');
    await page.getByRole('button', { name: 'Apply link' }).click();
    await expect(alertWith(page, /Only http, https and mailto links are allowed/)).toBeVisible();
    await page.getByLabel('Link address').fill(href);
    await page.getByRole('button', { name: 'Apply link' }).click();
    await expect(text.getByRole('link', { name: href })).toBeVisible();
    await text.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Add note', exact: true }).click();

    // Reopen: the screen is loaded fresh and the stored note keeps every format.
    await expect(page.getByRole('article', { name: 'Garden plan' })).toBeVisible();
    await page.reload();
    const note = page.getByRole('article', { name: 'Garden plan' });
    await expect(note.getByRole('heading', { name: 'Seed plan', level: 1 })).toBeVisible();
    await expect(note.getByRole('checkbox')).toHaveCount(2);
    await expect(note.getByRole('checkbox').first()).toBeChecked();
    await expect(note.getByRole('checkbox').nth(1)).not.toBeChecked();
    await expect(note.getByText('Prepare beds', { exact: true })).toBeVisible();
    await expect(note.getByRole('link', { name: href })).toHaveAttribute('href', href);
    // The note body is rendered by the editor schema, never as raw HTML.
    expect(await note.locator('script').count()).toBe(0);

    // Opening the editor again shows the same structure.
    await note.getByRole('button', { name: 'Change note' }).click();
    await expect(page.getByRole('textbox', { name: 'Note text' }).locator('h1')).toHaveText('Seed plan');
    await page.getByRole('button', { name: 'Cancel' }).click();

    const notes = await api.get<{ items: NoteView[] }>(page, `/api/hub/projects/${project.id}/notes`);
    const stored = JSON.stringify(notes.items.find((n) => n.title === 'Garden plan')?.body);
    expect(stored).toContain('"type":"heading"');
    expect(stored).toContain('"type":"taskList"');
    expect(stored).toContain(`"href":"${href}"`);

    // The API refuses a script node and a javascript: link; nothing is stored.
    const bad = (content: unknown[]) => ({ title: 'Bad', body: { type: 'doc', content } });
    await expect(
      api.post(page, `/api/hub/projects/${project.id}/notes`, bad([{ type: 'script', content: [] }])),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
    await expect(
      api.post(
        page,
        `/api/hub/projects/${project.id}/notes`,
        bad([
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
          },
        ]),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
    const after = await api.get<{ items: NoteView[] }>(page, `/api/hub/projects/${project.id}/notes`);
    expect(after.items.map((n) => n.title)).toEqual(['Garden plan']);
  });

  test('US2.5 / FR-010 / SC-001: a PDF becomes searchable; a PNG is kept and marked not searchable with the reason', async ({
    page,
  }) => {
    await signInConfirmed(page);
    const company = await createRecord(page, 'companies', uniqueName('Irrigation Co'));
    await page.goto(`/hub/companies/${company.id}`);

    // SC-001: attach in three steps or fewer (pick, describe, upload).
    const pdf = makePdf('Greenhouse irrigation schedule for the spring beds');
    const steps = await attachThroughUi(
      page,
      { name: 'irrigation.pdf', mimeType: 'application/pdf', buffer: pdf },
      'Watering plan',
    );
    expect(steps).toBeLessThanOrEqual(3);
    await expect(fileRow(page, 'irrigation.pdf')).toBeVisible();
    await expect(fileRow(page, 'irrigation.pdf')).toContainText('Watering plan');

    // Searchable is checked through the API until US5: the worker extracted the text.
    const pdfFile = await settled(page, (await fileByName(page, 'companies', company.id, 'irrigation.pdf')).id);
    expect(pdfFile.extractionStatus).toBe('extracted');
    await expect(fileRow(page, 'irrigation.pdf').getByText('Searchable', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await attachThroughUi(page, { name: 'bed-photo.png', mimeType: 'image/png', buffer: PNG_1X1 });
    const png = await settled(page, (await fileByName(page, 'companies', company.id, 'bed-photo.png')).id);
    expect(png).toMatchObject({ extractionStatus: 'unsupported', extractionReason: 'image_not_searchable' });
    const pngRow = fileRow(page, 'bed-photo.png');
    await expect(pngRow.getByText('Not searchable')).toBeVisible({ timeout: 15_000 });
    await expect(pngRow).toContainText('Images are kept, but their text is not read.');
    // Kept: the original downloads unchanged.
    const download = await page.request.get(`/api/hub/files/${png.id}/download`);
    expect(download.status()).toBe(200);
    expect(Buffer.from(await download.body()).equals(PNG_1X1)).toBe(true);
  });

  test('US2.6 / FR-009: a file over 25 MB and a disallowed type are refused with the reason', async ({ page }) => {
    await signInConfirmed(page);
    const person = await createRecord(page, 'people', uniqueName('Big File'));
    await page.goto(`/hub/people/${person.id}`);

    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 'a');
    await attachThroughUi(page, { name: 'big.txt', mimeType: 'text/plain', buffer: big });
    await expect(alertWith(page, /larger than 25 MB/)).toBeVisible({ timeout: 60_000 });

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    await attachThroughUi(page, { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: svg });
    const typeAlert = alertWith(page, /file type is not allowed/);
    await expect(typeAlert).toBeVisible();
    await expect(typeAlert).toContainText('pdf');

    // The API gives the same codes.
    const tooLarge = await page.request.post(`/api/hub/people/${person.id}/files`, {
      multipart: { file: { name: 'big.txt', mimeType: 'text/plain', buffer: big } },
    });
    expect(tooLarge.status()).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: 'too_large' } });
    const unsupported = await page.request.post(`/api/hub/people/${person.id}/files`, {
      multipart: { file: { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: svg } },
    });
    expect(unsupported.status()).toBe(415);
    const body = (await unsupported.json()) as { error: { code: string; details: { allowed: string[] } } };
    expect(body.error.code).toBe('unsupported_type');
    expect(body.error.details.allowed).toContain('pdf');
    expect(body.error.details.allowed).not.toContain('svg');

    expect(await listFiles(page, 'people', person.id)).toEqual([]);
  });

  test('US2.7 / FR-028: a password is excluded from a note and a file; the original downloads only for its owner', async ({
    page,
    browser,
  }) => {
    await signInConfirmed(page);
    const person = await createRecord(page, 'people', uniqueName('Shed Keeper'));
    await page.goto(`/hub/people/${person.id}`);

    // Note: the password is removed before saving and the user sees what was excluded.
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Shed access');
    await page.getByRole('textbox', { name: 'Note text' }).click();
    await page.keyboard.type(`Shared drive password: ${PASSWORD} for the garden team.`);
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    const note = page.getByRole('article', { name: 'Shed access' });
    await expect(note).toContainText('[excluded: Passwords and passphrases]');
    await expect(note).toContainText('1 value excluded');
    await expect(note).not.toContainText(PASSWORD);
    const stored = await api.get<{ items: NoteView[] }>(page, `/api/hub/people/${person.id}/notes`);
    expect(JSON.stringify(stored.items)).not.toContain(PASSWORD);
    expect(stored.items[0]?.redactedValues).toBeGreaterThanOrEqual(1);

    // A note that is only excluded content is not saved, and the editor says why.
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Reset');
    await page.getByRole('textbox', { name: 'Note text' }).click();
    await page.keyboard.type(PASSWORD_RESET_TEXT);
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await expect(alertWith(page, /not saved/)).toContainText('Excluded:');
    await page.getByRole('button', { name: 'Cancel' }).click();
    const notes = await api.get<{ items: NoteView[] }>(page, `/api/hub/people/${person.id}/notes`);
    expect(notes.items.map((n) => n.title)).toEqual(['Shed access']);

    // File: the extracted text loses the password; the original is kept as uploaded.
    const original = Buffer.from(`Greenhouse access notes.\nWi-Fi password: ${FILE_PASSWORD} for the shed.\nWater twice a week.\n`);
    await attachThroughUi(page, { name: 'access.txt', mimeType: 'text/plain', buffer: original });
    const file = await settled(page, (await fileByName(page, 'people', person.id, 'access.txt')).id);
    expect(file.extractionStatus).toBe('extracted');
    expect(file.redactedValues).toBeGreaterThanOrEqual(1);
    await expect(fileRow(page, 'access.txt')).toContainText('value excluded', { timeout: 15_000 });

    // The blob on disk is encrypted: neither password appears in any stored file.
    for (const path of filesUnder(E2E_ENV.HUB_FILES_DIR!)) {
      const raw = readFileSync(path);
      expect(raw.includes(FILE_PASSWORD)).toBe(false);
    }

    // The owner downloads the unmodified original.
    const own = await page.request.get(`/api/hub/files/${file.id}/download`);
    expect(own.status()).toBe(200);
    expect(own.headers()['content-disposition']).toMatch(/^attachment/);
    expect(Buffer.from(await own.body()).equals(original)).toBe(true);

    // Another user and an admin are refused.
    const other = await newPage(browser);
    await signInConfirmed(other, '-other');
    const foreign = await other.request.get(`/api/hub/files/${file.id}/download`);
    expect(foreign.status()).toBe(404);
    const admin = await newPage(browser);
    await signInAs(admin, { email: uniqueEmail('-admin'), role: 'admin' });
    const asAdmin = await admin.request.get(`/api/hub/files/${file.id}/download`);
    expect([403, 404]).toContain(asAdmin.status());
    expect(Buffer.from(await asAdmin.body()).includes(FILE_PASSWORD)).toBe(false);
  });

  test('extraction edges: a broken file is kept and marked not searchable; a wholly excluded file never reaches memory', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const project = await createRecord(page, 'projects', uniqueName('Edge Cases'));
    await page.goto(`/hub/projects/${project.id}`);

    // Edge: extraction fails (a PDF header with a corrupt body).
    const broken = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x8f), Buffer.from('\n%%EOF\n')]);
    await attachThroughUi(page, { name: 'broken.pdf', mimeType: 'application/pdf', buffer: broken });
    const bad = await settled(page, (await fileByName(page, 'projects', project.id, 'broken.pdf')).id);
    expect(['failed', 'empty']).toContain(bad.extractionStatus);
    const brokenRow = fileRow(page, 'broken.pdf');
    await expect(brokenRow.getByText('Not searchable')).toBeVisible({ timeout: 15_000 });
    const kept = await page.request.get(`/api/hub/files/${bad.id}/download`);
    expect(Buffer.from(await kept.body()).equals(broken)).toBe(true);

    // Edge: the whole text is excluded.
    const secret = Buffer.from(`${PASSWORD_RESET_TEXT}\n`);
    await attachThroughUi(page, { name: 'reset.txt', mimeType: 'text/plain', buffer: secret });
    const excluded = await settled(page, (await fileByName(page, 'projects', project.id, 'reset.txt')).id);
    expect(excluded.extractionStatus).toBe('excluded');
    expect(excluded.extractionReason).toBeTruthy();
    await expect(fileRow(page, 'reset.txt')).toContainText('The text was excluded', { timeout: 15_000 });
    const docs = await scanNamespace(userId);
    expect(docs.some((d) => d.content.includes('aB3dE9fG7hJ2kL5mN8pQ'))).toBe(false);
  });
});
