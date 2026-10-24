import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, signInAs, test } from '../fixtures/auth';
import { api, confirmFilters, poll } from './api';
import { GREENMAIL_HOST, GREENMAIL_IMAPS_PORT, GREENMAIL_PASSWORD } from './greenmail';
import { sql } from './scripts';

// Hub-from-email helpers shared by the hub US3 and US8 mailbox specs: seed messages with `hubfx:` markers for the
// fake LLM (packages/core/src/prompting/fake-llm.ts), connect a GreenMail mailbox, read the mailbox status, records
// and threads back, and drive the hub switch on /hub/settings.

export const HUB_PROCESSING_TIMEOUT_MS = 240_000;
export const NEW_MAIL_TIMEOUT_MS = 360_000;

/** `hubfx:` tokens of `FAKE_HUB_FIXTURES` and `FAKE_HUB_SWITCHES` (fake-llm.ts). */
export const MARK = {
  acmeOffer: 'hubfx:acme-offer',
  acmeProject: 'hubfx:acme-project',
  acmeInferredProject: 'hubfx:acme-inferred-project',
  freeMailPerson: 'hubfx:freemail-person',
  irrelevant: 'hubfx:irrelevant',
  badTwice: 'hubfx:bad-twice',
} as const;

export const JAN = { name: 'Jan Kowalski', address: 'jan@acme.example', role: 'Kierownik zakupów', phone: '+48 601 234 567' };
export const ACME = { name: 'Acme Sp. z o.o.', domain: 'acme.example' };
export const OLA = { name: 'Ola Nowak', address: 'ola.nowak@gmail.com' };
/** Only in the `acme-inferred-project` fixture (US4): a recipient with a phone in the signature. */
export const EWA = { name: 'Ewa Lis', address: 'ewa@lis.example', phone: '+48 602 345 678' };
/** The fixture's project and the industry it proposes for Acme. */
export const ORION = { name: 'Orion', description: 'Dostawa stali dla budowy hali.' };
export const ACME_INDUSTRY = 'Budownictwo';

export interface Mailbox {
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

export interface PersonView {
  id: string;
  name: string;
  roleTitle: string | null;
  phone: string | null;
  emails: { address: string; origin: 'user' | 'email' }[];
  ownerFields: string[];
  createdFrom: 'user' | 'email';
}

export interface CompanyView {
  id: string;
  name: string;
  domains: { domain: string; origin: 'user' | 'email' }[];
}

export interface LinkItem {
  link: { id: string; kind: string; role: string | null; origin: 'user' | 'email' };
  other: { kind: string; id: string; name: string };
}

export interface SourceThread {
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

export interface Source {
  id: string;
  accountLabel: string;
  currentImport: { status: string } | null;
}

export interface SeedMail {
  subject: string;
  from: string;
  to: string;
  body: string;
  headers?: Record<string, string>;
}

export const TERMINAL = ['completed', 'failed', 'cancelled'];

export function uniqueEmail(): string {
  return `e2e-${test.info().testId}-${Date.now()}@example.test`;
}

export const tag = () => test.info().testId.slice(0, 8);

export async function signInConfirmed(page: Page): Promise<{ userId: string; email: string }> {
  const result = await signInAs(page, { email: uniqueEmail() });
  await confirmFilters(page);
  return result;
}

/** Raw RFC 822 with extra headers (the newsletter and notification markers live in headers). */
export function rfc822(m: SeedMail): string {
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
export const BODY_SENTINEL = 'BODY-SENTINEL-7f3a9c';

export const janMail = (to: string, subject: string): SeedMail => ({
  subject,
  from: `${JAN.name} <${JAN.address}>`,
  to,
  body: `Dzień dobry,\n\nproszę o ofertę na dostawę stali (${BODY_SENTINEL}). ${MARK.acmeOffer}\n\n--\n${JAN.name}\n${JAN.role}, ${ACME.name}\n${JAN.phone}`,
});

export const olaMail = (to: string, subject: string): SeedMail => ({
  subject,
  from: `${OLA.name} <${OLA.address}>`,
  to,
  body: `Hi,\n\ncould you send the workshop dates? ${MARK.freeMailPerson}\n\nBest, ${OLA.name}`,
});

export async function connectImap(page: Page, mailbox: string): Promise<Source> {
  const { source } = await api.post<{ source: Source }>(page, '/api/sources/imap', {
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    tlsMode: 'tls',
    username: mailbox,
    password: GREENMAIL_PASSWORD,
  });
  return source;
}

export async function waitForImport(page: Page, sourceId: string): Promise<void> {
  const source = await poll(
    () => api.get<Source>(page, `/api/sources/${sourceId}`),
    (s) => s.currentImport !== null && TERMINAL.includes(s.currentImport.status),
    { timeoutMs: 120_000, intervalMs: 1_000 },
  );
  expect(source.currentImport?.status).toBe('completed');
}

export async function mailboxOf(page: Page, sourceId: string): Promise<Mailbox> {
  const { items } = await api.get<{ items: Mailbox[] }>(page, '/api/hub/mailboxes');
  const m = items.find((i) => i.sourceId === sourceId);
  expect(m, 'mailbox listed').toBeDefined();
  return m!;
}

export const people = async (page: Page) => (await api.get<{ items: PersonView[] }>(page, '/api/hub/people')).items;
export const companies = async (page: Page) => (await api.get<{ items: CompanyView[] }>(page, '/api/hub/companies')).items;
export const projects = async (page: Page) => (await api.get<{ items: { name: string }[] }>(page, '/api/hub/projects')).items;

export async function personDetail(page: Page, id: string) {
  return api.get<{ record: PersonView; links: LinkItem[] }>(page, `/api/hub/people/${id}`);
}

export async function sourcesOf(page: Page, kind: string, id: string): Promise<SourceThread[]> {
  return (await api.get<{ items: SourceThread[] }>(page, `/api/hub/${kind}/${id}/sources`)).items;
}

export type ThreadRow = Record<string, unknown> & {
  id: string;
  status: string;
  skip_reason: string | null;
  last_error_code: string | null;
};

export const threadsOf = (userId: string) =>
  sql<ThreadRow>('SELECT id, status, skip_reason, last_error_code FROM hub_thread WHERE user_id = $1 ORDER BY created_at', [
    userId,
  ]);

/** Every recorded thread of the user left `pending` and there are at least `count` of them. */
export async function waitThreadsSettled(userId: string, count: number, timeoutMs = HUB_PROCESSING_TIMEOUT_MS): Promise<ThreadRow[]> {
  return poll(() => threadsOf(userId), (rows) => rows.length >= count && rows.every((r) => r.status !== 'pending'), {
    timeoutMs,
    intervalMs: 2_000,
  });
}

export function mailboxCard(page: Page, sourceId: string): Locator {
  return page.getByRole('list', { name: 'Mailboxes' }).locator(`li[data-source-id="${sourceId}"]`);
}

export const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });

/** Turns the hub off through the switch and the data choice dialog. */
export async function turnOff(page: Page, sourceId: string, label: string, choice: 'keep' | 'delete'): Promise<void> {
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
