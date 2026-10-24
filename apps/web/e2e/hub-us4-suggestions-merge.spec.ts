import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/auth';
import { api, type ApiError } from './support/api';
import { appendMessages, uniqueMailbox } from './support/greenmail';
import {
  ACME,
  ACME_INDUSTRY,
  BODY_SENTINEL,
  connectImap,
  EWA,
  JAN,
  MARK,
  OLA,
  olaMail,
  ORION,
  people,
  personDetail,
  projects,
  rfc822,
  signInConfirmed,
  sourcesOf,
  tag,
  toast,
  waitForImport,
  waitThreadsSettled,
  type LinkItem,
  type PersonView,
} from './support/hub-mail';
import { sql } from './support/scripts';

// Hub US4 (quickstart "Suggestions and merge": US4.1, US4.2, US4.3, US4.5 and the deleted-record edge; FR-005,
// FR-023, FR-024, FR-032). Suggestions come from the US3 path: a GreenMail mailbox and the fake LLM's
// `acme-inferred-project` fixture (packages/core/src/prompting/fake-llm.ts), against records the user typed in first
// so the findings conflict or are not certain enough. Setup that is not under test goes through the API; the rows
// run in the browser with the API and the database as the oracle. No message body is ever read back.

const TYPED_JAN_PHONE = '+48 500 000 000';
const TYPED_EWA_PHONE = '+48 500 111 222';
const KEPT_PHONE = '+48 500 333 444';
const DUPLICATE_PHONE = '+48 500 555 666';

interface Suggestion {
  id: string;
  type: string;
  target: { kind: string; id: string | null; label: string | null };
  field: string | null;
  proposed: unknown;
  current: unknown;
  conflict: boolean;
  reason: string | null;
  confidence: number;
  dependsOn: string | null;
  sources: { threadId: string; subject: string; evidence: string }[];
}

interface DecideResult {
  id: string;
  status: 'accepted' | 'rejected' | 'failed';
  errorCode?: string;
}

interface CompanyDetail {
  id: string;
  name: string;
  industry: string | null;
  ownerFields: string[];
}

type FactRow = { id: string; state: string; type: string; person_id: string | null; project_id: string | null; link_id: string | null; decided_at: string | null };

const suggestions = async (page: Page) => (await api.get<{ items: Suggestion[]; nextCursor: string | null }>(page, '/api/hub/suggestions')).items;
const pendingCount = async (page: Page) => (await api.get<{ pending: number }>(page, '/api/hub/suggestions/count')).pending;
const companyDetail = async (page: Page, id: string) => (await api.get<{ record: CompanyDetail; links: LinkItem[] }>(page, `/api/hub/companies/${id}`));
const badge = (page: Page) => page.getByRole('navigation', { name: 'Hub' }).getByTestId('suggestions-badge');
const card = (page: Page, id: string): Locator => page.getByRole('list', { name: 'Suggestions' }).locator(`li[data-suggestion-id="${id}"]`);
const factRows = (ids: string[]) =>
  sql<FactRow>(
    `SELECT id, state, type, person_id, project_id, link_id, decided_at::text AS decided_at FROM hub_fact WHERE id = ANY($1::uuid[])`,
    [ids],
  );

const noteBody = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function addNoteAndFile(page: Page, personId: string, label: string): Promise<void> {
  await api.post(page, `/api/hub/people/${personId}/notes`, { title: `${label} note`, body: noteBody(`${label} note text.`) });
  const upload = await page.request.post(`/api/hub/people/${personId}/files`, {
    multipart: { file: { name: `${label.toLowerCase()}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`${label} file`) } },
  });
  expect(upload.ok(), `${label} file upload`).toBe(true);
}

test.describe('hub US4: suggestions and merge', () => {
  test.describe.configure({ timeout: 12 * 60_000 });

  test('US4.1 / US4.2 / US4.5 / FR-023 / FR-024 / FR-032 / edge: queue, accept and reject, bulk accept in order, badge, deleted record @ui', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const mailbox = uniqueMailbox('us4-hub');
    const subject = `Harmonogram dostaw ${tag()}`;

    // Typed by hand: Jan and Ewa with phone numbers, Acme without an industry.
    const { record: jan } = await api.post<{ record: PersonView }>(page, '/api/hub/people', {
      name: JAN.name,
      emails: [JAN.address],
      phone: TYPED_JAN_PHONE,
    });
    const { record: ewa } = await api.post<{ record: PersonView }>(page, '/api/hub/people', {
      name: EWA.name,
      emails: [EWA.address],
      phone: TYPED_EWA_PHONE,
    });
    const { record: acme } = await api.post<{ record: CompanyDetail }>(page, '/api/hub/companies', {
      name: ACME.name,
      domains: [ACME.domain],
    });
    expect(acme.industry).toBeNull();

    // One conversation from Jan to the user and Ewa; the fake extraction proposes phones for both, an industry for
    // Acme and an inferred project with a link from Jan and one from Acme.
    await appendMessages(mailbox, [
      rfc822({
        subject,
        from: `${JAN.name} <${JAN.address}>`,
        to: `${mailbox}, ${EWA.name} <${EWA.address}>`,
        body: `Dzień dobry,\n\nprzesyłam harmonogram dostaw (${BODY_SENTINEL}). ${MARK.acmeInferredProject}\n\n--\n${JAN.name}\n${JAN.role}, ${ACME.name}\n${JAN.phone}`,
      }),
    ]);
    const source = await connectImap(page, mailbox);
    await waitForImport(page, source.id);
    await api.post(page, `/api/hub/mailboxes/${source.id}/enable`, { acknowledgeAi: true });
    const threads = await waitThreadsSettled(userId, 1);
    expect(threads.map((r) => [r.status, r.last_error_code])).toEqual([['done', null]]);

    // What was certain was applied; the rest waits. Nothing typed changed.
    expect((await companyDetail(page, acme.id)).record.industry).toBeNull();
    let janView = (await personDetail(page, jan.id)).record;
    expect(janView).toMatchObject({ phone: TYPED_JAN_PHONE, roleTitle: JAN.role });
    expect((await personDetail(page, ewa.id)).record.phone).toBe(TYPED_EWA_PHONE);
    expect(await projects(page)).toEqual([]);

    const queued = await suggestions(page);
    const find = (what: string, pred: (s: Suggestion) => boolean): Suggestion => {
      const s = queued.find(pred);
      expect(s, what).toBeDefined();
      return s!;
    };
    const janPhone = find('jan phone', (s) => s.type === 'field' && s.field === 'phone' && s.target.id === jan.id);
    const ewaPhone = find('ewa phone', (s) => s.type === 'field' && s.field === 'phone' && s.target.id === ewa.id);
    const industry = find('acme industry', (s) => s.type === 'field' && s.field === 'industry' && s.target.id === acme.id);
    const project = find('project', (s) => s.type === 'project');
    const janLink = find('jan link', (s) => s.type === 'link' && s.dependsOn === project.id && s.target.label === JAN.name);
    const acmeLink = find('acme link', (s) => s.type === 'link' && s.dependsOn === project.id && s.target.label === ACME.name);
    expect(queued).toHaveLength(6);
    expect(janPhone).toMatchObject({
      conflict: true,
      reason: 'conflict',
      proposed: JAN.phone,
      current: TYPED_JAN_PHONE,
      dependsOn: null,
      target: { kind: 'person', id: jan.id, label: JAN.name },
    });
    expect(janPhone.sources).toHaveLength(1);
    expect(janPhone.sources[0]).toMatchObject({ subject });
    expect(janPhone.sources[0]!.evidence).toBeTruthy();
    expect(ewaPhone).toMatchObject({ conflict: true, proposed: EWA.phone, current: TYPED_EWA_PHONE });
    expect(industry).toMatchObject({ conflict: false, reason: 'low_confidence', proposed: ACME_INDUSTRY, current: null });
    expect(project).toMatchObject({ reason: 'inferred_project', dependsOn: null, target: { kind: 'project', id: null, label: ORION.name } });
    expect(janLink.target.kind).toBe('link');
    expect(JSON.stringify(queued)).not.toContain(BODY_SENTINEL);
    expect(await pendingCount(page)).toBe(6);

    // US4.5 / FR-024: the waiting count on every hub page and on the overview card, from the same query.
    for (const path of ['/hub', '/hub/people', `/hub/people/${jan.id}`, '/hub/companies', '/hub/projects', '/hub/search', '/hub/settings', '/hub/suggestions']) {
      await page.goto(path);
      await expect(badge(page), path).toHaveText('6');
    }
    await page.goto('/hub');
    // The overview card (the nav link to the same page has no paragraph).
    await expect(page.locator('a[href="/hub/suggestions"]').filter({ has: page.locator('p') })).toContainText('6');

    // US4.1 / FR-023: the queue shows the change, the current value, the conflict flag, the confidence and the sources.
    await page.goto('/hub/suggestions');
    const janCard = card(page, janPhone.id);
    const janTitle = `Set Phone of ${JAN.name}`;
    await expect(janCard.getByRole('heading', { name: janTitle })).toBeVisible();
    await expect(janCard.getByText('Conflict', { exact: true })).toBeVisible();
    await expect(janCard.locator('[data-proposed]')).toHaveText(JAN.phone);
    await expect(janCard.locator('[data-current]')).toHaveText(TYPED_JAN_PHONE);
    await expect(janCard).toContainText('Confidence 95%');
    const janSources = janCard.getByRole('region', { name: `Sources of ${janTitle}` });
    await expect(janSources).toContainText(subject);
    await expect(janSources).toContainText(janPhone.sources[0]!.evidence);
    await expect(janCard.getByRole('link', { name: `Open ${JAN.name}` })).toHaveAttribute('href', `/hub/people/${jan.id}`);
    await expect(card(page, industry.id).locator('[data-current]')).toHaveText('Empty');
    await expect(card(page, industry.id).getByText('Conflict', { exact: true })).toHaveCount(0);
    // A link that waits for a record names it; the record card names the project it proposes.
    await expect(card(page, janLink.id).getByRole('heading', { name: `Link ${JAN.name} – ${ORION.name} (new project)` })).toBeVisible();
    await expect(card(page, project.id).getByRole('heading', { name: `Add project ${ORION.name}` })).toBeVisible();
    await expect(card(page, project.id).locator('[data-proposed]')).toContainText(ORION.description);

    // US4.1: accept one, reject another; only the accepted one changes a record.
    await card(page, industry.id).getByRole('button', { name: 'Accept' }).click();
    await expect(toast(page, '1 accepted.')).toBeVisible();
    await expect(card(page, industry.id)).toHaveCount(0);
    await janCard.getByRole('button', { name: 'Reject' }).click();
    await expect(toast(page, '1 rejected.')).toBeVisible();
    await expect(janCard).toHaveCount(0);
    await expect(badge(page)).toHaveText('4');
    const acmeAfter = (await companyDetail(page, acme.id)).record;
    expect(acmeAfter.industry).toBe(ACME_INDUSTRY);
    expect(acmeAfter.ownerFields).not.toContain('industry');
    janView = (await personDetail(page, jan.id)).record;
    expect(janView.phone).toBe(TYPED_JAN_PHONE);
    expect(janView.ownerFields).toContain('phone');
    const decidedRows = await factRows([industry.id, janPhone.id]);
    expect(decidedRows.find((r) => r.id === industry.id)).toMatchObject({ state: 'applied' });
    expect(decidedRows.find((r) => r.id === janPhone.id)).toMatchObject({ state: 'rejected' });
    expect(decidedRows.every((r) => r.decided_at !== null)).toBe(true);
    // FR-017: a rejection leaves block markers (the fact and the field value), so it is not proposed again.
    const markers = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM hub_block_marker WHERE user_id = $1 AND reason = 'rejected'`, [userId]);
    expect(markers[0]!.n).toBeGreaterThanOrEqual(2);
    expect(await pendingCount(page)).toBe(4);

    // US4.2: bulk accept the two links; the project they need is applied first although it was not selected.
    await card(page, janLink.id).getByRole('checkbox').check();
    await card(page, acmeLink.id).getByRole('checkbox').check();
    await expect(page.getByRole('toolbar', { name: 'Bulk actions' })).toContainText('2 selected');
    await page.getByRole('button', { name: 'Accept selected' }).click();
    const results = page.getByRole('region', { name: 'Decision results' });
    await expect(results.locator(`[data-result-id="${janLink.id}"]`)).toHaveAttribute('data-result-status', 'accepted');
    await expect(results.locator(`[data-result-id="${acmeLink.id}"]`)).toHaveAttribute('data-result-status', 'accepted');
    await expect(card(page, project.id)).toHaveCount(0);
    await expect(badge(page)).toHaveText('1');
    expect((await projects(page)).map((p) => p.name)).toEqual([ORION.name]);
    const janLinks = (await personDetail(page, jan.id)).links.map((l) => ({ kind: l.link.kind, other: l.other.name, origin: l.link.origin }));
    expect(janLinks).toEqual(
      expect.arrayContaining([
        { kind: 'person_company', other: ACME.name, origin: 'email' },
        { kind: 'person_project', other: ORION.name, origin: 'email' },
      ]),
    );
    expect((await companyDetail(page, acme.id)).links.map((l) => [l.link.kind, l.other.name])).toEqual(
      expect.arrayContaining([['company_project', ORION.name]]),
    );
    const applied = await factRows([project.id, janLink.id, acmeLink.id]);
    const projectRow = applied.find((r) => r.id === project.id)!;
    expect(projectRow).toMatchObject({ state: 'applied' });
    expect(projectRow.project_id).not.toBeNull();
    for (const id of [janLink.id, acmeLink.id]) {
      const row = applied.find((r) => r.id === id)!;
      expect(row).toMatchObject({ state: 'applied', project_id: projectRow.project_id });
      expect(row.link_id).not.toBeNull();
      expect(row.decided_at! >= projectRow.decided_at!).toBe(true);
    }
    // FR-032: each decision is audited with counts only.
    const audits = await sql<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log_entry WHERE action = 'hub.suggestions_bulk_decided' AND actor_user_id = $1 ORDER BY occurred_at`,
      [userId],
    );
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(audits.at(-1)!.metadata).sort()).toEqual(['accepted', 'failed', 'rejected']);
    expect(audits.at(-1)!.metadata).toEqual({ accepted: 2, rejected: 0, failed: 0 });
    const auditText = JSON.stringify(audits);
    for (const needle of [JAN.name, JAN.phone, ORION.name, ACME_INDUSTRY, subject, janLink.id]) expect(auditText).not.toContain(needle);

    // Edge: a record deleted with a queued suggestion drops it from the queue and the count.
    await api.delete(page, `/api/hub/people/${ewa.id}`);
    expect(await pendingCount(page)).toBe(0);
    expect(await suggestions(page)).toEqual([]);
    const ewaRows = await factRows([ewaPhone.id]);
    expect(ewaRows.filter((r) => r.person_id !== null)).toEqual([]);
    await page.goto('/hub/suggestions');
    await expect(page.getByText('No suggestions waiting.')).toBeVisible();
    await expect(badge(page)).toHaveText('0');

    // A decided or dropped id is a per-id result, not a failure of the call.
    const again = await api.post<{ results: DecideResult[] }>(page, '/api/hub/suggestions/decide', {
      ids: [janPhone.id, ewaPhone.id],
      action: 'accept',
    });
    expect(again.results).toEqual([
      { id: janPhone.id, status: 'failed', errorCode: 'suggestion_not_pending' },
      { id: ewaPhone.id, status: 'failed', errorCode: 'suggestion_not_pending' },
    ]);
    expect(await pendingCount(page)).toBe(0);
  });

  test('US4.3 / FR-005: merging two people keeps addresses, notes, files, links and summaries of both; kept values win @ui', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const mailbox = uniqueMailbox('us4-merge');
    const t = tag();
    const workshopSubject = `Workshop dates ${t}`;

    // The duplicate comes from email, with a conversation summary of its own.
    await appendMessages(mailbox, [rfc822(olaMail(mailbox, workshopSubject))]);
    const source = await connectImap(page, mailbox);
    await waitForImport(page, source.id);
    await api.post(page, `/api/hub/mailboxes/${source.id}/enable`, { acknowledgeAi: true });
    const threads = await waitThreadsSettled(userId, 1);
    expect(threads.map((r) => r.status)).toEqual(['done']);
    const ola = (await people(page)).find((p) => p.name === OLA.name);
    expect(ola, 'Ola from email').toBeDefined();
    expect((await sourcesOf(page, 'people', ola!.id)).map((s) => s.subject)).toEqual([workshopSubject]);

    // The kept record, typed by hand, with its own address, phone, note, file and link.
    const keptName = `Aleksandra Nowak ${t}`;
    const keptAddress = `aleksandra-${t}@example.test`;
    const { record: kept } = await api.post<{ record: PersonView }>(page, '/api/hub/people', {
      name: keptName,
      emails: [keptAddress],
      phone: KEPT_PHONE,
    });
    const { record: acme } = await api.post<{ record: CompanyDetail }>(page, '/api/hub/companies', { name: ACME.name, domains: [ACME.domain] });
    const projectName = `Orion ${t}`;
    const { record: project } = await api.post<{ record: { id: string } }>(page, '/api/hub/projects', { name: projectName });
    await addNoteAndFile(page, kept.id, 'Kept');
    await api.post(page, '/api/hub/links', { kind: 'person_company', personId: kept.id, companyId: acme.id });
    // The duplicate gets a role, another phone, a note, a file and a link of its own.
    await api.patch(page, `/api/hub/people/${ola!.id}`, { roleTitle: 'Trainer', phone: DUPLICATE_PHONE });
    await addNoteAndFile(page, ola!.id, 'Duplicate');
    await api.post(page, '/api/hub/links', { kind: 'person_project', personId: ola!.id, projectId: project.id });

    // The API refuses the record itself and another kind (409) and an unknown id (404).
    await expect(api.get(page, `/api/hub/people/${kept.id}/merge-preview?sourceId=${kept.id}`)).rejects.toMatchObject({
      status: 409,
      code: 'merge_invalid',
    } satisfies Partial<ApiError>);
    await expect(api.get(page, `/api/hub/people/${kept.id}/merge-preview?sourceId=${acme.id}`)).rejects.toMatchObject({
      status: 409,
      code: 'merge_invalid',
    } satisfies Partial<ApiError>);
    await expect(api.get(page, `/api/hub/people/${kept.id}/merge-preview?sourceId=${randomUUID()}`)).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<ApiError>);

    // The dialog on the kept record: pick the duplicate, read the preview, confirm.
    await page.goto(`/hub/people/${kept.id}`);
    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Merge into ${keptName}` })).toBeVisible();
    await dialog.getByLabel('Record to merge into this one').selectOption({ label: OLA.name });
    const moves = dialog.getByRole('list', { name: 'What the merge moves' });
    await expect(moves).toContainText('1 email address');
    await expect(moves).toContainText('1 note');
    await expect(moves).toContainText('1 file');
    await expect(moves).toContainText('1 link');
    await expect(moves).toContainText('1 conversation summary');
    // Both have a name and a phone: the kept record's win.
    await expect(dialog.getByText(`${keptName} keeps: Name, Phone`)).toBeVisible();
    await expect(dialog.getByText(`Filled from ${OLA.name}: Role`)).toBeVisible();
    await dialog.getByRole('button', { name: 'Merge records' }).click();
    await expect(toast(page, `Merged ${OLA.name} into ${keptName}.`)).toBeVisible();
    await expect(dialog).toBeHidden();

    // One record remains with everything of both; the kept values won and the empty role was filled.
    const merged = await personDetail(page, kept.id);
    expect(merged.record).toMatchObject({ name: keptName, phone: KEPT_PHONE, roleTitle: 'Trainer' });
    expect(merged.record.emails.map((e) => e.address).sort()).toEqual([keptAddress, OLA.address].sort());
    expect(merged.links.map((l) => l.other.name).sort()).toEqual([ACME.name, projectName].sort());
    const notes = await api.get<{ items: { title: string }[] }>(page, `/api/hub/people/${kept.id}/notes`);
    expect(notes.items.map((n) => n.title).sort()).toEqual(['Duplicate note', 'Kept note']);
    const files = await api.get<{ items: { name: string }[] }>(page, `/api/hub/people/${kept.id}/files`);
    expect(files.items.map((f) => f.name).sort()).toEqual(['duplicate.txt', 'kept.txt']);
    expect((await sourcesOf(page, 'people', kept.id)).map((s) => s.subject)).toEqual([workshopSubject]);
    await expect(api.get(page, `/api/hub/people/${ola!.id}`)).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
    expect((await people(page)).map((p) => p.name)).toEqual([keptName]);

    // The refreshed page shows both addresses and the conversation of the merged-away record.
    await expect(page.getByRole('region', { name: 'Email addresses' })).toContainText(OLA.address);
    await expect(page.getByRole('region', { name: 'Email addresses' })).toContainText(keptAddress);
    await expect(page.getByRole('article', { name: workshopSubject })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: 'Trainer' })).toBeVisible();

    // FR-032: the merge is audited with the kind only.
    const audits = await sql<{ target_id: string; metadata: Record<string, unknown> }>(
      `SELECT target_id, metadata FROM audit_log_entry WHERE action = 'hub.records_merged' AND actor_user_id = $1`,
      [userId],
    );
    expect(audits).toEqual([{ target_id: kept.id, metadata: { kind: 'person' } }]);
  });
});
