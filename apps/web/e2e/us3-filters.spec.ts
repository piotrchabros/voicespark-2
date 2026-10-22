import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/auth';
import { api, confirmFilters, poll } from './support/api';
import {
  appendMessages,
  GREENMAIL_HOST,
  GREENMAIL_IMAPS_PORT,
  GREENMAIL_PASSWORD,
  uniqueMailbox,
  type SeedMessage,
} from './support/greenmail';
import { scanNamespace } from './support/memory';

// US3 / SC-014, SC-004/005 (quickstart section 6, T157): the first-import filter gate, locked categories, the
// corpus mailbox through a real IMAP import, keyword retroscans, reports and unselecting a category.

const CATALOG = [
  'passwords',
  'otp_codes',
  'reset_verification_links',
  'api_keys_tokens',
  'payment_cards',
  'bank_accounts',
  'government_ids',
  'health',
  'special_category',
  'third_party_contacts',
] as const;
const LOCKED = ['passwords', 'otp_codes', 'reset_verification_links', 'api_keys_tokens'] as const;
/** Categories a deterministic detector owns (D-E5): the fake classifier finds nothing, so only these are compared. */
const DETERMINISTIC = [
  'passwords',
  'otp_codes',
  'reset_verification_links',
  'api_keys_tokens',
  'payment_cards',
  'bank_accounts',
  'government_ids',
] as const;

const CORPUS_DIR = fileURLToPath(new URL('../../../packages/filters/test/corpus/', import.meta.url));

interface Preferences {
  selectedCategories: string[];
  lockedCategories: string[];
  confirmedAt: string | null;
  version: number;
}

interface CategoryDef {
  key: string;
  label: string;
  locked: boolean;
  defaultSelected: boolean;
}

interface ImportProgress {
  id: string;
  kind: string;
  status: string;
  itemsProcessed: number;
  itemsImported: number;
  itemsDuplicate: number;
  itemsExcluded: number;
  itemsFailed: number;
}

interface Source {
  id: string;
  status: string;
  itemCount: number;
  currentImport: ImportProgress | null;
}

interface ExclusionSummary {
  importJobId: string;
  categories: { key: string; label: string; excludedItems: number; redactedValues: number }[];
  skipped: { reason: string; count: number }[];
}

interface ContentItem {
  id: string;
  kind: string;
  title?: string;
  snippet?: string;
}

interface Retroscan {
  id: string;
  status: string;
  matchedCount: number;
}

interface Deletion {
  id: string;
  scope: string;
  status: string;
}

interface ExpectedEntry {
  category: string;
  count: number;
  wholeItem: boolean;
  values: string[];
}

interface CorpusEmail {
  key: string;
  raw: string;
  expected: ExpectedEntry[];
}

type Counts = Record<string, { excludedItems: number; redactedValues: number }>;

const TERMINAL = ['completed', 'failed', 'cancelled'];

const uniqueEmail = (info: TestInfo, tag: string) => `e2e-${tag}-${info.testId}-${Date.now()}@example.test`;

const imapBody = (username: string) => ({
  host: GREENMAIL_HOST,
  port: GREENMAIL_IMAPS_PORT,
  tlsMode: 'tls',
  username,
  password: GREENMAIL_PASSWORD,
});

async function connectImap(page: Page, mailbox: string): Promise<Source> {
  const { source } = await api.post<{ source: Source }>(page, '/api/sources/imap', imapBody(mailbox));
  return source;
}

async function waitForImport(page: Page, sourceId: string, timeoutMs = 120_000): Promise<ImportProgress> {
  const source = await poll(
    () => api.get<Source>(page, `/api/sources/${sourceId}`),
    (s) => s.currentImport !== null && TERMINAL.includes(s.currentImport.status),
    { timeoutMs, intervalMs: 1_000 },
  );
  expect(source.currentImport?.status).toBe('completed');
  return source.currentImport!;
}

/** Appends messages and runs the initial import to completion. */
async function importMailbox(page: Page, prefix: string, msgs: readonly (SeedMessage | string)[]) {
  const mailbox = uniqueMailbox(prefix);
  await appendMessages(mailbox, msgs);
  const source = await connectImap(page, mailbox);
  const job = await waitForImport(page, source.id);
  return { mailbox, source, job };
}

async function listItems(page: Page, sourceId: string): Promise<ContentItem[]> {
  return (await api.get<{ items: ContentItem[] }>(page, `/api/content-items?sourceId=${sourceId}&limit=100`)).items;
}

async function summaryOf(page: Page, importJobId: string): Promise<Counts> {
  const summary = await api.get<ExclusionSummary>(page, `/api/imports/${importJobId}/exclusion-summary`);
  return Object.fromEntries(
    summary.categories.map((c) => [c.key, { excludedItems: c.excludedItems, redactedValues: c.redactedValues }]),
  );
}

async function waitForDeletion(page: Page, id: string): Promise<void> {
  const deletion = await poll(
    () => api.get<Deletion>(page, `/api/deletions/${id}`),
    (d) => d.status === 'completed' || d.status === 'failed',
    { timeoutMs: 120_000, intervalMs: 1_000 },
  );
  expect(deletion.status).toBe('completed');
}

/** The `.eml` fixtures of the deterministic corpus groups, with CRLF line endings for IMAP APPEND. */
function loadCorpusEmails(): CorpusEmail[] {
  const expected = JSON.parse(readFileSync(join(CORPUS_DIR, 'expected.json'), 'utf8')) as Record<string, ExpectedEntry[]>;
  const out: CorpusEmail[] = [];
  for (const group of DETERMINISTIC) {
    for (const file of readdirSync(join(CORPUS_DIR, 'fixtures', group)).sort()) {
      if (!file.endsWith('.eml')) continue;
      const key = `${group}/${file}`;
      const raw = readFileSync(join(CORPUS_DIR, 'fixtures', group, file), 'utf8').replace(/\r?\n/g, '\r\n');
      out.push({ key, raw, expected: expected[key] ?? [] });
    }
  }
  return out;
}

const deterministicEntries = (f: CorpusEmail) =>
  f.expected
    .filter((e) => (DETERMINISTIC as readonly string[]).includes(e.category))
    .sort((a, b) => CATALOG.indexOf(a.category as (typeof CATALOG)[number]) - CATALOG.indexOf(b.category as (typeof CATALOG)[number]));

/**
 * What the import's exclusion summary must show for the deterministic categories: a whole-item exclusion is
 * counted once under its category (the worker's `excludedCategory` rule), otherwise every span count is a
 * redacted value.
 */
function expectedCounts(fixtures: readonly CorpusEmail[]): Counts {
  const out: Counts = {};
  const bump = (category: string, excludedItems: number, redactedValues: number) => {
    const cur = out[category] ?? { excludedItems: 0, redactedValues: 0 };
    out[category] = {
      excludedItems: cur.excludedItems + excludedItems,
      redactedValues: cur.redactedValues + redactedValues,
    };
  };
  for (const f of fixtures) {
    const entries = deterministicEntries(f);
    const whole = entries.find((e) => e.wholeItem);
    if (whole) {
      bump(whole.category, 1, 0);
      continue;
    }
    for (const e of entries) bump(e.category, 0, e.count);
  }
  return out;
}

const corpusFixture = (key: string) => readFileSync(join(CORPUS_DIR, 'fixtures', key), 'utf8').replace(/\r?\n/g, '\r\n');

test('first connect: 4 locked + 10 selected, and source/upload endpoints are 409 until confirmed', async ({
  page,
  signInAs,
}, testInfo) => {
  await signInAs({ email: uniqueEmail(testInfo, 'gate') });

  const catalog = await api.get<CategoryDef[]>(page, '/api/filter-categories');
  expect(catalog.map((c) => c.key)).toEqual([...CATALOG]);
  expect(catalog.filter((c) => c.locked).map((c) => c.key)).toEqual([...LOCKED]);
  expect(catalog.every((c) => c.defaultSelected)).toBe(true);

  const prefs = await api.get<Preferences>(page, '/api/filter-preferences');
  expect(prefs.confirmedAt).toBeNull();
  expect(prefs.selectedCategories).toEqual([...CATALOG]);
  expect(prefs.lockedCategories).toEqual([...LOCKED]);
  expect((await api.get<{ filtersConfirmed: boolean }>(page, '/api/me')).filtersConfirmed).toBe(false);

  const gated = { status: 409, code: 'filter_confirmation_required' };
  await expect(api.post(page, '/api/sources/imap', imapBody(uniqueMailbox('us3-gated')))).rejects.toMatchObject(gated);
  await expect(api.post(page, '/api/sources/connect/gmail', {})).rejects.toMatchObject(gated);
  await expect(api.post(page, '/api/sources/connect/microsoft', {})).rejects.toMatchObject(gated);
  await expect(api.post(page, '/api/notes', { text: 'A note written before the filters were confirmed.' })).rejects.toMatchObject(gated);
  const upload = await page.request.post('/api/uploads', {
    multipart: { file: { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text upload') } },
  });
  expect(upload.status()).toBe(409);
  expect(((await upload.json()) as { error: { code: string } }).error.code).toBe('filter_confirmation_required');
  expect(await api.get(page, '/api/sources')).toEqual([]);

  // Confirming the defaults opens the gate.
  const saved = await api.put<{ preferences: Preferences; retroscanId: string | null }>(page, '/api/filter-preferences', {
    selectedCategories: prefs.selectedCategories,
  });
  expect(saved.preferences.confirmedAt).not.toBeNull();
  expect(saved.retroscanId).toBeNull();
  expect((await api.get<{ filtersConfirmed: boolean }>(page, '/api/me')).filtersConfirmed).toBe(true);
  const note = await api.post<{ uploadId: string }>(page, '/api/notes', { text: 'A note written after confirmation.' });
  expect(note.uploadId).toBeTruthy();
});

test('first upload or connect shows the onboarding checklist @ui', async ({ page, signInAs }, testInfo) => {
  await signInAs({ email: uniqueEmail(testInfo, 'gate-ui') });

  // next dev compiles each page on first use, hence the long first waits.
  await page.goto('/uploads');
  await expect(page).toHaveURL(/\/onboarding\/filters\?returnTo=(%2F|\/)uploads$/, { timeout: 60_000 });
  await page.goto('/sources/connect');
  await expect(page).toHaveURL(/\/onboarding\/filters\?returnTo=(%2F|\/)sources(%2F|\/)connect$/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Choose what to keep out' })).toBeVisible({ timeout: 30_000 });

  await expect(page.getByRole('checkbox')).toHaveCount(10);
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(10);
  await expect(page.getByRole('checkbox', { disabled: true })).toHaveCount(4);
  await expect(page.getByText('Credentials are always excluded')).toHaveCount(4);

  // A locked category cannot be unchecked (its label is tied to a disabled checkbox); clicking the row explains why.
  await page.locator('li', { hasText: 'Passwords and passphrases' }).getByText('Credentials are always excluded').click();
  await expect(page.getByRole('status')).toContainText('cannot be turned off');
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(10);

  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page).toHaveURL(/\/sources\/connect$/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Connect a mailbox' })).toBeVisible({ timeout: 30_000 });
  expect((await api.get<Preferences>(page, '/api/filter-preferences')).confirmedAt).not.toBeNull();
});

test('unchecking a locked category is refused with category_locked', async ({ page, signInAs }, testInfo) => {
  await signInAs({ email: uniqueEmail(testInfo, 'locked') });
  for (const locked of LOCKED) {
    await expect(
      api.put(page, '/api/filter-preferences', { selectedCategories: CATALOG.filter((c) => c !== locked) }),
    ).rejects.toMatchObject({ status: 422, code: 'category_locked' });
  }
  // Nothing was saved by the refused calls.
  expect((await api.get<Preferences>(page, '/api/filter-preferences')).confirmedAt).toBeNull();
  // Optional categories can be left out.
  const saved = await api.put<{ preferences: Preferences }>(page, '/api/filter-preferences', {
    selectedCategories: CATALOG.filter((c) => c !== 'health'),
  });
  expect(saved.preferences.selectedCategories).toEqual(CATALOG.filter((c) => c !== 'health'));
});

test('SC-004/005: the corpus mailbox summary matches expected.json and no seeded value reaches the namespace', async ({
  page,
  signInAs,
}, testInfo) => {
  test.setTimeout(420_000);
  const fixtures = loadCorpusEmails();
  expect(fixtures.length).toBeGreaterThan(100);
  const { userId } = await signInAs({ email: uniqueEmail(testInfo, 'corpus') });
  await confirmFilters(page);

  const { source, job } = await importMailbox(
    page,
    'us3-corpus',
    fixtures.map((f) => f.raw),
  );
  expect(job.itemsProcessed).toBe(fixtures.length);
  expect(job.itemsFailed).toBe(0);
  expect(job.itemsDuplicate).toBe(0);

  const expected = expectedCounts(fixtures);
  const actual = await summaryOf(page, job.id);
  const deterministicActual = Object.fromEntries(
    Object.entries(actual).filter(([key]) => (DETERMINISTIC as readonly string[]).includes(key)),
  );
  expect(deterministicActual).toEqual(expected);
  const wholeItems = Object.values(expected).reduce((n, c) => n + c.excludedItems, 0);
  expect(job.itemsExcluded).toBe(wholeItems);
  expect(job.itemsImported).toBe(fixtures.length - wholeItems);
  expect(source.status).toBe('connected');

  // SC-004/005: none of the planted values survives into the store (whole exclusions or span redactions).
  const docs = await scanNamespace(userId);
  expect(docs).toHaveLength(job.itemsImported);
  const values = fixtures.flatMap((f) => deterministicEntries(f).flatMap((e) => e.values));
  expect(values.length).toBeGreaterThan(100);
  const leaked = values.filter((v) => docs.some((d) => d.content.includes(v)));
  expect(leaked).toEqual([]);
  // Redacted spans leave a token behind, so the values were removed and not just missed.
  expect(docs.some((d) => d.content.includes('[excluded:'))).toBe(true);
  testInfo.annotations.push({
    type: 'corpus',
    description: `${fixtures.length} emails, ${values.length} seeded values checked, 0 leaked`,
  });
});

test('a keyword rule offers a retroscan and confirming it purges the matches', async ({ page, signInAs }, testInfo) => {
  const { userId } = await signInAs({ email: uniqueEmail(testInfo, 'keyword') });
  await confirmFilters(page);
  const mailbox = uniqueMailbox('us3-keyword');
  const from = `Pat <pat@${mailbox.split('@')[1]}>`;
  const msgs: SeedMessage[] = [
    { subject: 'Lab notes 1', from, to: mailbox, body: 'The zebrafish tank needs a new heater before Monday.' },
    { subject: 'Lab notes 2', from, to: mailbox, body: 'Ordered the zebrafish feed and two filters.' },
    { subject: 'Lunch plans', from, to: mailbox, body: 'Shall we try the new place by the river on Friday?' },
    { subject: 'Reading list', from, to: mailbox, body: 'Three essays on long-form writing worth your time.' },
  ];
  const { source } = await importMailbox(page, 'us3-keyword', msgs);
  expect((await listItems(page, source.id)).length).toBe(4);

  const { rule, retroscanId } = await api.post<{ rule: { id: string; type: string; value: string }; retroscanId: string | null }>(
    page,
    '/api/exclusion-rules',
    { type: 'keyword', value: 'zebrafish' },
  );
  expect(rule).toMatchObject({ type: 'keyword', value: 'zebrafish' });
  expect(retroscanId).toBeTruthy();

  const scan = await poll(
    () => api.get<Retroscan>(page, `/api/retroscans/${retroscanId}`),
    (s) => s.status !== 'scanning',
    { timeoutMs: 60_000, intervalMs: 1_000 },
  );
  expect(scan).toMatchObject({ status: 'awaiting_confirmation', matchedCount: 2 });

  const { deletionRequestId } = await api.post<{ deletionRequestId: string }>(page, `/api/retroscans/${retroscanId}/confirm`);
  expect(deletionRequestId).toBeTruthy();
  await waitForDeletion(page, deletionRequestId);
  await poll(() => api.get<Retroscan>(page, `/api/retroscans/${retroscanId}`), (s) => s.status === 'completed', {
    timeoutMs: 30_000,
  });

  const left = await listItems(page, source.id);
  expect(left.map((i) => i.title).sort()).toEqual(['Lunch plans', 'Reading list']);
  const docs = await scanNamespace(userId);
  expect(docs).toHaveLength(2);
  expect(docs.some((d) => /zebrafish/i.test(d.content))).toBe(false);
  expect(await api.get(page, '/api/exclusion-rules')).toHaveLength(1);
});

test('exclusion-rules page offers the retroscan dialog @ui', async ({ page, signInAs }, testInfo) => {
  await signInAs({ email: uniqueEmail(testInfo, 'keyword-ui') });
  await confirmFilters(page);
  const mailbox = uniqueMailbox('us3-keyword-ui');
  const from = `Pat <pat@${mailbox.split('@')[1]}>`;
  await importMailbox(page, 'us3-keyword-ui', [
    { subject: 'Garden', from, to: mailbox, body: 'The quince tree finally flowered this spring.' },
    { subject: 'Weekend', from, to: mailbox, body: 'A quince crumble recipe for Sunday.' },
    { subject: 'Hello', from, to: mailbox, body: 'Just checking in.' },
  ]);

  await page.goto('/exclusion-rules');
  await expect(page.getByRole('heading', { name: 'Exclusion rules' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Keyword' }).click();
  await page.getByLabel('Value').fill('quince');
  const created = page.waitForResponse((r) => r.url().includes('/api/exclusion-rules') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /add/i }).click();
  const { retroscanId } = (await (await created).json()) as { retroscanId: string | null };
  expect(retroscanId).toBeTruthy();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Check existing content')).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText('2 existing items match your new settings.', { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Remove 2 matching items' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const scan = await poll(
    () => api.get<Retroscan>(page, `/api/retroscans/${retroscanId}`),
    (s) => s.status === 'completed',
    { timeoutMs: 120_000, intervalMs: 1_000 },
  );
  expect(scan.matchedCount).toBe(2);
});

test('reporting an imported item as sensitive purges it', async ({ page, signInAs }, testInfo) => {
  const { userId } = await signInAs({ email: uniqueEmail(testInfo, 'report') });
  await confirmFilters(page);
  const mailbox = uniqueMailbox('us3-report');
  const from = `Sam <sam@${mailbox.split('@')[1]}>`;
  const { source } = await importMailbox(page, 'us3-report', [
    { subject: 'Report me', from, to: mailbox, body: 'Something personal slipped through the filters here.' },
    { subject: 'Keep me 1', from, to: mailbox, body: 'Nothing sensitive in this one.' },
    { subject: 'Keep me 2', from, to: mailbox, body: 'Nor in this one.' },
  ]);
  const items = await listItems(page, source.id);
  const target = items.find((i) => i.title === 'Report me');
  expect(target).toBeDefined();

  const { reportId, deletionRequestId } = await api.post<{ reportId: string; deletionRequestId: string }>(
    page,
    `/api/content-items/${target!.id}/report`,
    { category: 'health' },
  );
  expect(reportId).toBeTruthy();
  await waitForDeletion(page, deletionRequestId);
  expect((await api.get<Deletion>(page, `/api/deletions/${deletionRequestId}`)).scope).toBe('exclusion_report');

  const left = await listItems(page, source.id);
  expect(left.map((i) => i.id)).not.toContain(target!.id);
  expect(left.map((i) => i.title).sort()).toEqual(['Keep me 1', 'Keep me 2']);
  const docs = await scanNamespace(userId);
  expect(docs.map((d) => d.id)).not.toContain(target!.id);
  expect(docs.some((d) => d.content.includes('slipped through'))).toBe(false);
  expect((await api.get<Source>(page, `/api/sources/${source.id}`)).itemCount).toBe(2);
});

test('unselecting payment_cards keeps cards in later imports; locked categories still apply', async ({
  page,
  signInAs,
}, testInfo) => {
  const { userId } = await signInAs({ email: uniqueEmail(testInfo, 'cards') });
  await confirmFilters(page);
  const expected = JSON.parse(readFileSync(join(CORPUS_DIR, 'expected.json'), 'utf8')) as Record<string, ExpectedEntry[]>;
  const value = (key: string, category: string) => expected[key]!.find((e) => e.category === category)!.values[0]!;
  const card1 = value('payment_cards/001.eml', 'payment_cards');
  const card2 = value('payment_cards/002.eml', 'payment_cards');
  const password = value('passwords/001.eml', 'passwords');

  // With the defaults the card is redacted.
  const first = await importMailbox(page, 'us3-cards-on', [corpusFixture('payment_cards/001.eml')]);
  expect(first.job.itemsProcessed).toBe(1);
  expect((await summaryOf(page, first.job.id))['payment_cards']).toBeDefined();
  expect((await scanNamespace(userId)).some((d) => d.content.includes(card1))).toBe(false);

  // Unselecting a category never triggers a retroscan and never re-imports anything.
  const prefs = await api.get<Preferences>(page, '/api/filter-preferences');
  const saved = await api.put<{ preferences: Preferences; retroscanId: string | null }>(page, '/api/filter-preferences', {
    selectedCategories: prefs.selectedCategories.filter((c) => c !== 'payment_cards'),
  });
  expect(saved.retroscanId).toBeNull();
  expect(saved.preferences.selectedCategories).not.toContain('payment_cards');
  expect(saved.preferences.version).toBe(prefs.version + 1);
  expect((await scanNamespace(userId)).some((d) => d.content.includes(card1))).toBe(false);

  // A later import keeps the card data but still excludes the (locked) password.
  const second = await importMailbox(page, 'us3-cards-off', [
    corpusFixture('payment_cards/002.eml'),
    corpusFixture('passwords/001.eml'),
  ]);
  expect(second.job.itemsProcessed).toBe(2);
  const counts = await summaryOf(page, second.job.id);
  expect(counts['payment_cards']).toBeUndefined();
  expect(counts['passwords']).toBeDefined();
  const docs = await scanNamespace(userId);
  expect(docs.some((d) => d.content.includes(card2))).toBe(true);
  expect(docs.some((d) => d.content.includes(password))).toBe(false);
  expect(docs.some((d) => d.content.includes(card1))).toBe(false);
});
