import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, confirmFilters, poll, type ApiError } from './support/api';
import {
  appendMessages,
  GREENMAIL_HOST,
  GREENMAIL_IMAPS_PORT,
  GREENMAIL_PASSWORD,
  uniqueMailbox,
} from './support/greenmail';
import { runCore, sql } from './support/scripts';

// Hub US3 (quickstart "Hub from email": US3.1..US3.9, FR-012, FR-014, FR-017..FR-022; SC-007, SC-008): a GreenMail
// mailbox, the fake LLM (`hubfx:` markers in the message bodies select recorded extractions; see
// packages/core/src/prompting/fake-llm.ts), the mailbox section of /hub/settings, the summaries and sources panels on
// a record page and the ignore rules (T106). Processing takes the 60 s ingest debounce plus the worker's run; new mail
// after the connect arrives with the sync poll (SYNC_POLL_INTERVAL_MINUTES=1). Nothing here reads a message body
// back: assertions use record values, thread metadata and counts.

const HUB_PROCESSING_TIMEOUT_MS = 240_000;
const NEW_MAIL_TIMEOUT_MS = 360_000;

/** `hubfx:` tokens of `FAKE_HUB_FIXTURES` and `FAKE_HUB_SWITCHES` (fake-llm.ts). */
const MARK = {
  acmeOffer: 'hubfx:acme-offer',
  acmeProject: 'hubfx:acme-project',
  freeMailPerson: 'hubfx:freemail-person',
  irrelevant: 'hubfx:irrelevant',
  badTwice: 'hubfx:bad-twice',
} as const;

const JAN = { name: 'Jan Kowalski', address: 'jan@acme.example', role: 'Kierownik zakupów', phone: '+48 601 234 567' };
const ACME = { name: 'Acme Sp. z o.o.', domain: 'acme.example' };
const OLA = { name: 'Ola Nowak', address: 'ola.nowak@gmail.com' };
const TYPED_PHONE = '+48 500 000 000';

interface Mailbox {
  sourceId: string;
  accountLabel: string;
  enabled: boolean;
  backfillState: string;
  pausedUntil: string | null;
  threadsProcessed: number;
  threadsSkipped: number;
  threadsFailed: number;
  lastRunAt: string | null;
  dataChoice: 'keep' | 'delete' | null;
  failedThreads: { id: string; subjectAvailable: false; errorCode: string | null; attempts: number }[];
}

interface PersonView {
  id: string;
  name: string;
  roleTitle: string | null;
  phone: string | null;
  emails: { address: string; origin: 'user' | 'email' }[];
  ownerFields: string[];
  createdFrom: 'user' | 'email';
}

interface CompanyView {
  id: string;
  name: string;
  domains: { domain: string; origin: 'user' | 'email' }[];
}

interface LinkItem {
  link: { id: string; kind: string; role: string | null; origin: 'user' | 'email' };
  other: { kind: string; id: string; name: string };
}

interface SourceThread {
  threadId: string;
  subject: string | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  participants: { name: string | null; address: string; owner: boolean }[];
  summary: string | null;
  openUrl: string | null;
  supports: ({ field: string } | { link: string } | { email: string } | { domain: string })[];
}

interface Source {
  id: string;
  accountLabel: string;
  currentImport: { status: string } | null;
}

interface SeedMail {
  subject: string;
  from: string;
  to: string;
  body: string;
  headers?: Record<string, string>;
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

function uniqueEmail(): string {
  return `e2e-${test.info().testId}-${Date.now()}@example.test`;
}

const tag = () => test.info().testId.slice(0, 8);

async function signInConfirmed(page: Page): Promise<{ userId: string; email: string }> {
  const result = await signInAs(page, { email: uniqueEmail() });
  await confirmFilters(page);
  return result;
}

/** Raw RFC 822 with extra headers (the newsletter and notification markers live in headers). */
function rfc822(m: SeedMail): string {
  const extra = Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
  return [
    `Message-ID: <${randomUUID()}@greenmail.test>`,
    `Date: ${new Date().toUTCString()}`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    ...extra,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    m.body,
    '',
  ].join('\r\n');
}

/** Only ever in a message body: it must never show up in what the hub stores or returns (SC-008). */
const BODY_SENTINEL = 'BODY-SENTINEL-7f3a9c';

const janMail = (to: string, subject: string): SeedMail => ({
  subject,
  from: `${JAN.name} <${JAN.address}>`,
  to,
  body: `Dzień dobry,\n\nproszę o ofertę na dostawę stali (${BODY_SENTINEL}). ${MARK.acmeOffer}\n\n--\n${JAN.name}\n${JAN.role}, ${ACME.name}\n${JAN.phone}`,
});

const olaMail = (to: string, subject: string): SeedMail => ({
  subject,
  from: `${OLA.name} <${OLA.address}>`,
  to,
  body: `Hi,\n\ncould you send the workshop dates? ${MARK.freeMailPerson}\n\nBest, ${OLA.name}`,
});

async function connectImap(page: Page, mailbox: string): Promise<Source> {
  const { source } = await api.post<{ source: Source }>(page, '/api/sources/imap', {
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    tlsMode: 'tls',
    username: mailbox,
    password: GREENMAIL_PASSWORD,
  });
  return source;
}

async function waitForImport(page: Page, sourceId: string): Promise<void> {
  const source = await poll(
    () => api.get<Source>(page, `/api/sources/${sourceId}`),
    (s) => s.currentImport !== null && TERMINAL.includes(s.currentImport.status),
    { timeoutMs: 120_000, intervalMs: 1_000 },
  );
  expect(source.currentImport?.status).toBe('completed');
}

async function mailboxOf(page: Page, sourceId: string): Promise<Mailbox> {
  const { items } = await api.get<{ items: Mailbox[] }>(page, '/api/hub/mailboxes');
  const m = items.find((i) => i.sourceId === sourceId);
  expect(m, 'mailbox listed').toBeDefined();
  return m!;
}

const people = async (page: Page) => (await api.get<{ items: PersonView[] }>(page, '/api/hub/people')).items;
const companies = async (page: Page) => (await api.get<{ items: CompanyView[] }>(page, '/api/hub/companies')).items;
const projects = async (page: Page) => (await api.get<{ items: { name: string }[] }>(page, '/api/hub/projects')).items;

async function personDetail(page: Page, id: string) {
  return api.get<{ record: PersonView; links: LinkItem[] }>(page, `/api/hub/people/${id}`);
}

async function sourcesOf(page: Page, kind: string, id: string): Promise<SourceThread[]> {
  return (await api.get<{ items: SourceThread[] }>(page, `/api/hub/${kind}/${id}/sources`)).items;
}

type ThreadRow = Record<string, unknown> & {
  id: string;
  status: string;
  skip_reason: string | null;
  last_error_code: string | null;
};

const threadsOf = (userId: string) =>
  sql<ThreadRow>('SELECT id, status, skip_reason, last_error_code FROM hub_thread WHERE user_id = $1 ORDER BY created_at', [
    userId,
  ]);

/** Every recorded thread of the user left `pending` and there are at least `count` of them. */
async function waitThreadsSettled(userId: string, count: number, timeoutMs = HUB_PROCESSING_TIMEOUT_MS): Promise<ThreadRow[]> {
  return poll(() => threadsOf(userId), (rows) => rows.length >= count && rows.every((r) => r.status !== 'pending'), {
    timeoutMs,
    intervalMs: 2_000,
  });
}

async function llmCalls(threadId: string): Promise<number> {
  const [row] = await sql<{ n: number }>('SELECT count(*)::int AS n FROM hub_llm_call WHERE thread_id = $1', [threadId]);
  return row!.n;
}

/** Decrypts content-class values through the worker's environment (the spec never holds the key). */
async function decrypt(values: (string | null)[]): Promise<(string | null)[]> {
  return runCore<(string | null)[]>(
    `const { decryptContent } = await import('@voicespark/core/services/hub/common');
     return args[0].map((v) => (v === null ? null : decryptContent(v)));`,
    [values],
  );
}

// --- settings page helpers -----------------------------------------------------------------------------------

function mailboxCard(page: Page, sourceId: string): Locator {
  return page.getByRole('list', { name: 'Mailboxes' }).locator(`li[data-source-id="${sourceId}"]`);
}

async function hubCounts(card: Locator, label: string): Promise<Record<'Processed' | 'Skipped' | 'Failed', number>> {
  // A <dl> is not a list role: address it by its label.
  const list = card.locator(`dl[aria-label="Hub counts for ${label}"]`);
  await expect(list).toBeVisible();
  const read = async (name: string) => {
    const v = await list.locator(':scope > div').filter({ has: card.page().getByText(name, { exact: true }) }).locator('dd').innerText();
    expect(v, name).toMatch(/^\d+$/);
    return Number(v);
  };
  return { Processed: await read('Processed'), Skipped: await read('Skipped'), Failed: await read('Failed') };
}

const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });

/** Turns the hub off through the switch and the data choice dialog. */
async function turnOff(page: Page, sourceId: string, label: string, choice: 'keep' | 'delete'): Promise<void> {
  const card = mailboxCard(page, sourceId);
  await card.getByRole('switch', { name: `Hub for ${label}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Turn the hub off for ${label}?` })).toBeVisible();
  const keep = dialog.getByRole('radio', { name: 'Keep what was found' });
  const del = dialog.getByRole('radio', { name: 'Delete what was found' });
  // The radio names carry the source id, so two mailboxes never share a group.
  await expect(keep).toHaveAttribute('name', `hub-data-${sourceId}`);
  await expect(del).toHaveAttribute('name', `hub-data-${sourceId}`);
  await expect(keep).toBeChecked();
  await (choice === 'keep' ? keep : del).check();
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  await expect(toast(page, choice === 'keep' ? 'is kept' : 'is being deleted')).toBeVisible();
  await expect(card.locator('[data-hub-enabled]')).toHaveAttribute('data-hub-enabled', 'false');
}

test.describe('hub US3: hub filled in from email', () => {
  test.describe.configure({ timeout: 12 * 60_000 });

  test('US3.9 / FR-012 / US3.1 / US3.2 / FR-014 / US3.5 / US3.6 / FR-022: off by default, consent, records, summaries, sources, status @ui', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const mailbox = uniqueMailbox('us3-hub');
    const t = tag();
    const offerSubject = `Oferta na stal ${t}`;
    const workshopSubject = `Workshop dates ${t}`;
    await appendMessages(mailbox, [
      rfc822(janMail(mailbox, offerSubject)),
      rfc822(olaMail(mailbox, workshopSubject)),
      // A newsletter and a notification: with the `acme-project` marker they would create the project "Orion" if read.
      rfc822({
        subject: `Weekly digest ${t}`,
        from: 'Digest <news@digest.example>',
        to: mailbox,
        body: `This week in steel. ${MARK.acmeProject}`,
        headers: { 'List-Unsubscribe': '<mailto:unsubscribe@digest.example>', 'List-Id': 'Digest <digest.example>', Precedence: 'bulk' },
      }),
      rfc822({
        subject: `Your order has shipped ${t}`,
        from: 'Shop <no-reply@shop.example>',
        to: mailbox,
        body: `Order 1234 is on its way. ${MARK.acmeProject}`,
        headers: { 'Auto-Submitted': 'auto-generated' },
      }),
      // A generic role address never becomes a person (FR-014); the fake answers "not relevant" for it.
      rfc822({
        subject: `Office hours ${t}`,
        from: `Info <info@${ACME.domain}>`,
        to: mailbox,
        body: `Our office is open 8-16. ${MARK.irrelevant}`,
      }),
    ]);

    // US3.9: the import for tone of voice runs with the hub off; nothing is recorded for the hub.
    const source = await connectImap(page, mailbox);
    await waitForImport(page, source.id);
    const before = await mailboxOf(page, source.id);
    expect(before).toMatchObject({ enabled: false, backfillState: 'none', threadsProcessed: 0, dataChoice: null });
    expect(await threadsOf(userId)).toEqual([]);
    expect(await people(page)).toEqual([]);
    expect(await companies(page)).toEqual([]);
    const label = before.accountLabel;

    await page.goto(`/sources/${source.id}`);
    await expect(page.getByText('Hub: off.')).toBeVisible();

    // FR-012: enabling needs the acknowledgement, in the API and in the dialog.
    await expect(api.post(page, `/api/hub/mailboxes/${source.id}/enable`, {})).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
    } satisfies Partial<ApiError>);

    await page.goto('/hub/settings');
    const card = mailboxCard(page, source.id);
    await expect(card.locator('[data-hub-enabled]')).toHaveAttribute('data-hub-enabled', 'false');
    await card.getByRole('switch', { name: `Hub for ${label}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/conversation content from this mailbox is sent to the AI service/i)).toBeVisible();
    const turnOn = dialog.getByRole('button', { name: 'Turn on' });
    await expect(turnOn).toBeDisabled();
    await dialog.getByRole('checkbox').click();
    await expect(turnOn).toBeEnabled();
    await turnOn.click();
    await expect(toast(page, 'Hub turned on')).toBeVisible();
    await expect(card.locator('[data-hub-enabled]')).toHaveAttribute('data-hub-enabled', 'true');
    await expect(card.getByRole('switch', { name: `Hub for ${label}` })).toHaveAttribute('aria-checked', 'true');

    // The audit entry carries the source id and the consent text version, no content.
    const audit = await sql<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log_entry WHERE action = 'hub.mailbox_enabled' AND actor_user_id = $1 AND target_id = $2`,
      [userId, source.id],
    );
    expect(audit).toHaveLength(1);
    expect(Object.keys(audit[0]!.metadata).sort()).toEqual(['consentTextVersion', 'sourceId']);
    expect(audit[0]!.metadata.sourceId).toBe(source.id);
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(new RegExp(`${JAN.name}|${JAN.address}|${mailbox}|${offerSubject}`));

    // Backfill records the five imported messages; the worker processes them after the debounce.
    const threads = await waitThreadsSettled(userId, 5);
    expect(threads.filter((r) => r.status === 'done')).toHaveLength(2);
    expect(threads.filter((r) => r.status === 'failed')).toEqual([]);
    const skipped = threads.filter((r) => r.status === 'skipped');
    expect(skipped).toHaveLength(3);
    expect(skipped.filter((r) => r.skip_reason === 'automated')).toHaveLength(2);
    expect(skipped.filter((r) => r.skip_reason === 'irrelevant')).toHaveLength(1);

    // US3.1: Jan with his address, linked to the company of acme.example. FR-014: Ola from a free-mail address,
    // no company for her domain, no person for the owner or the role address. US3.2: the newsletter and the
    // notification created nothing (no project "Orion").
    const listed = await people(page);
    expect(listed.map((p) => p.name).sort()).toEqual([JAN.name, OLA.name]);
    const jan = listed.find((p) => p.name === JAN.name)!;
    expect(jan.createdFrom).toBe('email');
    expect(jan.ownerFields).toEqual([]);
    expect(jan.emails.map((e) => e.address)).toEqual([JAN.address]);
    expect(jan.emails[0]!.origin).toBe('email');
    expect(jan.phone).toBe(JAN.phone);
    expect(jan.roleTitle).toBe(JAN.role);
    const allAddresses = listed.flatMap((p) => p.emails.map((e) => e.address));
    expect(allAddresses).not.toContain(mailbox);
    expect(allAddresses).not.toContain(`info@${ACME.domain}`);
    const listedCompanies = await companies(page);
    expect(listedCompanies.map((c) => c.name)).toEqual([ACME.name]);
    expect(listedCompanies[0]!.domains.map((d) => d.domain)).toEqual([ACME.domain]);
    expect(await projects(page)).toEqual([]);
    const detail = await personDetail(page, jan.id);
    expect(detail.links.map((l) => ({ kind: l.link.kind, other: l.other.name, origin: l.link.origin }))).toEqual([
      { kind: 'person_company', other: ACME.name, origin: 'email' },
    ]);

    // US3.5 / FR-019 (API): the summary carries subject, dates, participants; IMAP has no provider link.
    const janSources = await sourcesOf(page, 'people', jan.id);
    expect(janSources).toHaveLength(1);
    const conv = janSources[0]!;
    expect(conv.subject).toBe(offerSubject);
    expect(conv.messageCount).toBe(1);
    expect(conv.firstMessageAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(conv.lastMessageAt).toBe(conv.firstMessageAt);
    expect(conv.summary).toBeTruthy();
    expect(conv.participants.map((p) => [p.address, p.owner])).toEqual(
      expect.arrayContaining([
        [JAN.address, false],
        [mailbox, true],
      ]),
    );
    expect(conv.openUrl).toBeNull();
    // US3.6 / FR-018 / SC-008: every derived item of the record names the conversation. The address created with
    // the person is covered by its creation fact (reported as the name; a separate `person_email` fact exists only
    // when an address is attached to an existing person).
    expect(conv.supports).toEqual(
      expect.arrayContaining([
        { field: 'name' },
        { field: 'roleTitle' },
        { field: 'phone' },
        { link: detail.links[0]!.link.id },
      ]),
    );
    const acmeSources = await sourcesOf(page, 'companies', listedCompanies[0]!.id);
    expect(acmeSources.map((s) => s.threadId)).toEqual([conv.threadId]);
    expect(acmeSources[0]!.supports).toEqual(expect.arrayContaining([{ field: 'name' }, { domain: ACME.domain }]));
    // SC-008: the body never reaches the stored metadata or the record (the fake's summary is recorded text).
    expect(JSON.stringify(janSources)).not.toContain(BODY_SENTINEL);
    expect(JSON.stringify(detail)).not.toContain(BODY_SENTINEL);

    // US3.5 / US3.6 on the record page: provenance badges, the summary and the sources panel.
    await page.goto(`/hub/people/${jan.id}`);
    await expect(page.getByText('Created from email')).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: JAN.phone })).toContainText('From email');
    await expect(page.locator('dd').filter({ hasText: JAN.role })).toContainText('From email');
    await expect(page.getByRole('region', { name: 'Email addresses' }).getByText('From email')).toBeVisible();
    const article = page.getByRole('article', { name: offerSubject });
    await expect(article).toBeVisible();
    await expect(article).toContainText(conv.firstMessageAt!.slice(0, 10));
    await expect(article).toContainText('1 message');
    await expect(article).toContainText(conv.summary!);
    const participants = article.getByRole('list', { name: `Participants of ${offerSubject}` });
    await expect(participants).toContainText(`${JAN.name} <${JAN.address}>`);
    await expect(participants).toContainText('(you)');
    await expect(article.getByText('Open the original in your mail app.')).toBeVisible();
    await expect(article.getByRole('button', { name: `Ignore sender ${JAN.address}` })).toBeVisible();
    await expect(article.getByRole('button', { name: `Ignore domain ${ACME.domain}` })).toBeVisible();
    const sourcesPanel = page.getByRole('region', { name: 'Where this came from' });
    await expect(sourcesPanel).toBeVisible();
    for (const key of ['field:name', 'field:roleTitle', 'field:phone', `link:${detail.links[0]!.link.id}`]) {
      const entry = sourcesPanel.locator(`[data-support="${key}"]`);
      await expect(entry, key).toBeVisible();
      await expect(entry.getByRole('link', { name: offerSubject })).toHaveAttribute('href', `#hub-thread-${conv.threadId}`);
    }
    await expect(sourcesPanel.locator('[data-support="field:phone"]')).toContainText('Phone');
    await expect(sourcesPanel.locator(`[data-support="link:${detail.links[0]!.link.id}"]`)).toContainText(`Link to ${ACME.name}`);
    await expect(page.getByText('No conversation from email yet.')).toHaveCount(0);

    // FR-022: processed, skipped, failed counts and the last run on the mailbox status.
    const status = await mailboxOf(page, source.id);
    expect(status).toMatchObject({ enabled: true, threadsProcessed: 2, threadsFailed: 0, backfillState: 'done', pausedUntil: null });
    expect(status.threadsSkipped).toBe(skipped.length);
    expect(status.lastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await page.goto('/hub/settings');
    expect(await hubCounts(card, label)).toEqual({ Processed: 2, Skipped: skipped.length, Failed: 0 });
    await expect(card).toContainText(`Last run ${status.lastRunAt!.slice(0, 16).replace('T', ' ')} UTC`);
    await expect(card.getByText('Paused until tomorrow')).toHaveCount(0);
    await expect(card.getByRole('list', { name: `Failed conversations of ${label}` })).toHaveCount(0);
    await page.goto(`/sources/${source.id}`);
    await expect(page.getByText('Hub: on.')).toBeVisible();

    // Edge "hub off" with delete (FR-031): processing stops and a hub_source deletion request is created.
    await page.goto('/hub/settings');
    await turnOff(page, source.id, label, 'delete');
    const after = await mailboxOf(page, source.id);
    expect(after).toMatchObject({ enabled: false, dataChoice: 'delete' });
    const requests = await sql<{ scope: string }>(
      `SELECT scope FROM deletion_request WHERE scope = 'hub_source' AND target_id = $1`,
      [source.id],
    );
    expect(requests).toHaveLength(1);
    await expect(
      api.post(page, `/api/hub/mailboxes/${source.id}/disable`, { hubData: 'keep' }),
    ).rejects.toMatchObject({ status: 409, code: 'hub_not_enabled' } satisfies Partial<ApiError>);
  });

  test('US3.8 / US3.3 / failure edge / US8.3: ignore then undo, the typed phone survives as a conflict, retry, keep @ui', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const mailbox = uniqueMailbox('us3-ignore');
    const t = tag();

    // The user typed Jan in by hand with a phone number.
    const { record: typedJan } = await api.post<{ record: PersonView }>(page, '/api/hub/people', {
      name: JAN.name,
      emails: [JAN.address],
      phone: TYPED_PHONE,
    });
    expect(typedJan.ownerFields).toEqual(expect.arrayContaining(['name', 'phone']));

    // US3.8: ignore Jan's address and Ola's domain before anything is read.
    await page.goto('/hub/settings');
    const form = page.getByRole('form', { name: 'Add an ignore rule' });
    await form.getByLabel('Email address to ignore').fill(JAN.address);
    await form.getByRole('button', { name: 'Ignore' }).click();
    await expect(toast(page, `${JAN.address} is ignored from now on.`)).toBeVisible();
    await form.getByRole('radio', { name: 'Domain' }).check();
    await form.getByLabel('Domain to ignore').fill('GMAIL.com');
    await form.getByRole('button', { name: 'Ignore' }).click();
    await expect(toast(page, 'GMAIL.com is ignored from now on.')).toBeVisible();
    const rules = page.getByRole('list', { name: 'Ignored senders and domains' });
    await expect(rules.getByText(JAN.address, { exact: true })).toBeVisible();
    await expect(rules.getByText('gmail.com', { exact: true })).toBeVisible();
    // A duplicate is reported on the form, not as a new row.
    await form.getByRole('radio', { name: 'Sender' }).check();
    await form.getByLabel('Email address to ignore').fill(JAN.address);
    await form.getByRole('button', { name: 'Ignore' }).click();
    await expect(form.getByRole('alert').filter({ hasText: 'This rule already exists.' })).toBeVisible();

    await appendMessages(mailbox, [
      rfc822(janMail(mailbox, `Oferta ${t} 1`)),
      rfc822(olaMail(mailbox, `Workshop ${t} 1`)),
      // The fake LLM answers this conversation with an unusable output on every call: a failed thread.
      rfc822({
        subject: `Umowa ${t}`,
        from: 'Ewa Lis <ewa@lis.example>',
        to: mailbox,
        body: `Dzień dobry, przesyłam umowę do podpisu. ${MARK.badTwice}\n\nEwa Lis`,
      }),
    ]);
    const source = await connectImap(page, mailbox);
    await waitForImport(page, source.id);
    const label = source.accountLabel;
    await api.post(page, `/api/hub/mailboxes/${source.id}/enable`, { acknowledgeAi: true });
    await expect(
      api.post(page, `/api/hub/mailboxes/${source.id}/enable`, { acknowledgeAi: true }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' } satisfies Partial<ApiError>);

    const first = await waitThreadsSettled(userId, 3);
    expect(first.filter((r) => r.status === 'skipped' && r.skip_reason === 'ignored')).toHaveLength(2);
    const failedThread = first.find((r) => r.status === 'failed');
    expect(failedThread).toMatchObject({ last_error_code: 'llm_bad_output' });

    // Ignored senders created and updated nothing: Jan is as typed, Ola does not exist.
    expect((await people(page)).map((p) => p.name)).toEqual([JAN.name]);
    let jan = (await personDetail(page, typedJan.id)).record;
    expect(jan).toMatchObject({ phone: TYPED_PHONE, roleTitle: null, createdFrom: 'user' });
    expect(await sourcesOf(page, 'people', typedJan.id)).toEqual([]);
    expect(await companies(page)).toEqual([]);
    const suggestedBefore = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM hub_fact WHERE user_id = $1 AND state = 'suggested'`,
      [userId],
    );
    expect(suggestedBefore[0]!.n).toBe(0);

    // Failure edge: the failed conversation is listed with its reason and can be retried; the rest went on.
    await page.goto('/hub/settings');
    const card = mailboxCard(page, source.id);
    expect(await hubCounts(card, label)).toEqual({ Processed: 0, Skipped: 2, Failed: 1 });
    const failedList = card.getByRole('list', { name: `Failed conversations of ${label}` });
    await expect(failedList.locator(`li[data-thread-id="${failedThread!.id}"]`)).toContainText('The AI service gave an unusable answer.');
    await expect(failedList).not.toContainText('Umowa');
    const mailboxView = await mailboxOf(page, source.id);
    expect(mailboxView.failedThreads).toEqual([
      expect.objectContaining({ id: failedThread!.id, subjectAvailable: false, errorCode: 'llm_bad_output', attempts: 1 }),
    ]);
    const callsBefore = await llmCalls(failedThread!.id);
    expect(callsBefore).toBeGreaterThan(0);
    await failedList.getByRole('button', { name: /^Retry conversation 1/ }).click();
    await expect(toast(page, 'Queued again.')).toBeVisible();
    await poll(() => llmCalls(failedThread!.id), (n) => n > callsBefore, { timeoutMs: 90_000, intervalMs: 2_000 });
    const retried = await poll(
      () => threadsOf(userId),
      (rows) => rows.find((r) => r.id === failedThread!.id)?.status === 'failed',
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
    expect(retried.find((r) => r.id === failedThread!.id)).toMatchObject({ last_error_code: 'llm_bad_output' });
    await expect(
      api.post(page, `/api/hub/mailboxes/${source.id}/threads/${randomUUID()}/retry`),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' } satisfies Partial<ApiError>);

    // US3.8 undo: remove both rules; new mail from Jan and Ola is processed again.
    await rules.getByRole('button', { name: `Stop ignoring ${JAN.address}` }).click();
    await expect(toast(page, `${JAN.address} is no longer ignored.`)).toBeVisible();
    await rules.getByRole('button', { name: 'Stop ignoring gmail.com' }).click();
    await expect(page.getByText('Nothing is ignored.')).toBeVisible();
    expect((await api.get<{ items: unknown[] }>(page, '/api/hub/ignore-rules')).items).toEqual([]);

    const secondOffer = `Oferta ${t} 2`;
    await appendMessages(mailbox, [rfc822(janMail(mailbox, secondOffer)), rfc822(olaMail(mailbox, `Workshop ${t} 2`))]);
    const after = await poll(
      () => threadsOf(userId),
      (rows) => rows.length >= 5 && rows.filter((r) => r.status === 'done').length >= 2,
      { timeoutMs: NEW_MAIL_TIMEOUT_MS, intervalMs: 3_000 },
    );
    expect(after.filter((r) => r.status === 'done')).toHaveLength(2);
    expect((await people(page)).map((p) => p.name).sort()).toEqual([JAN.name, OLA.name]);

    // US3.3 / SC-007: the typed phone is kept; the new number is a conflict suggestion with both values.
    jan = (await personDetail(page, typedJan.id)).record;
    expect(jan.phone).toBe(TYPED_PHONE);
    expect(jan.roleTitle).toBe(JAN.role);
    expect(jan.ownerFields).toContain('phone');
    expect(jan.ownerFields).not.toContain('roleTitle');
    const facts = await sql<{ conflict: boolean; reason: string | null; value_enc: string | null; previous_value_enc: string | null }>(
      `SELECT conflict, reason, value_enc, previous_value_enc FROM hub_fact
       WHERE user_id = $1 AND person_id = $2 AND field = 'phone' AND state = 'suggested'`,
      [userId, typedJan.id],
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ conflict: true, reason: 'conflict' });
    const [suggested, previous] = await decrypt([facts[0]!.value_enc, facts[0]!.previous_value_enc]);
    expect(suggested).toContain(JAN.phone);
    expect(previous).toContain(TYPED_PHONE);
    const overwrites = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM hub_fact WHERE user_id = $1 AND person_id = $2 AND field = 'phone' AND state = 'applied'`,
      [userId, typedJan.id],
    );
    expect(overwrites[0]!.n).toBe(0);

    // On the record page the typed phone has no provenance badge, the role does, and the conversation is listed.
    await page.goto(`/hub/people/${typedJan.id}`);
    await expect(page.getByText('Created by you')).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: TYPED_PHONE })).not.toContainText('From email');
    await expect(page.locator('dd').filter({ hasText: JAN.role })).toContainText('From email');
    await expect(page.getByRole('article', { name: secondOffer })).toBeVisible();
    const sourcesPanel = page.getByRole('region', { name: 'Where this came from' });
    await expect(sourcesPanel.locator('[data-support="field:roleTitle"]').getByRole('link', { name: secondOffer })).toBeVisible();
    await expect(sourcesPanel.locator('[data-support="field:phone"]')).toHaveCount(0);

    // US8.3 / edge "hub off": keep. Derived data stays and nothing new is read.
    await page.goto('/hub/settings');
    await turnOff(page, source.id, label, 'keep');
    expect(await mailboxOf(page, source.id)).toMatchObject({ enabled: false, dataChoice: 'keep' });
    expect((await people(page)).map((p) => p.name).sort()).toEqual([JAN.name, OLA.name]);
    expect(await sourcesOf(page, 'people', typedJan.id)).toHaveLength(1);
    expect(
      await sql<{ scope: string }>(`SELECT scope FROM deletion_request WHERE scope = 'hub_source' AND target_id = $1`, [source.id]),
    ).toEqual([]);
  });
});
