import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/auth';
import { api, poll, type ApiError } from './support/api';
import { appendMessages, uniqueMailbox } from './support/greenmail';
import {
  ACME,
  companies,
  connectImap,
  JAN,
  janMail,
  mailboxOf,
  OLA,
  olaMail,
  people,
  personDetail,
  rfc822,
  signInConfirmed,
  sourcesOf,
  tag,
  threadsOf,
  turnOff,
  waitForImport,
  waitThreadsSettled,
  type PersonView,
} from './support/hub-mail';
import { scanNamespace, type ScannedDoc } from './support/memory';
import { sql } from './support/scripts';

// Hub US8 mailbox scope (quickstart "Privacy, admin and deletion": US8.2, US8.3 and the "hub off" edge; FR-031,
// SC-012). GreenMail mailboxes with the fake LLM (support/hub-mail.ts), the keep/delete choice of the disconnect
// dialog on /sources/{id} (T132) and of the hub switch on /hub/settings, the `hub_source` deletion run by the worker
// and the shared memory store read back with support/memory.ts.

const PURGE_TIMEOUT_MS = 120_000;
/** Longer than the sync poll (SYNC_POLL_INTERVAL_MINUTES=1) plus the 60 s ingest debounce. */
const QUIET_PERIOD_MS = 130_000;

interface SourceRow {
  id: string;
  status: string;
  itemCount: number;
  hub: { enabled: boolean };
}

const sourceOf = (page: Page, id: string) => api.get<SourceRow>(page, `/api/sources/${id}`);

const hubDeletions = (sourceId: string) =>
  sql<{ status: string }>(`SELECT status FROM deletion_request WHERE scope = 'hub_source' AND target_id = $1`, [sourceId]);

const docsById = async (userId: string): Promise<Map<string, ScannedDoc>> =>
  new Map((await scanNamespace(userId)).map((d) => [d.id, d]));

/** Polls the store until every id in `present` is there (with `until` true) and every id in `absent` is gone. */
async function waitForDocs(
  userId: string,
  present: string[],
  absent: string[] = [],
  until: (docs: Map<string, ScannedDoc>) => boolean = () => true,
  timeoutMs = 90_000,
): Promise<Map<string, ScannedDoc>> {
  return poll(
    () => docsById(userId),
    (docs) => present.every((id) => docs.has(id)) && absent.every((id) => !docs.has(id)) && until(docs),
    { timeoutMs, intervalMs: 1_000 },
  );
}

async function enableHub(page: Page, sourceId: string): Promise<void> {
  await api.post(page, `/api/hub/mailboxes/${sourceId}/enable`, { acknowledgeAi: true });
}

async function findPerson(page: Page, name: string): Promise<PersonView> {
  const p = (await people(page)).find((x) => x.name === name);
  expect(p, name).toBeDefined();
  return p!;
}

/** Opens the disconnect dialog on the source page and returns it. */
async function openDisconnect(page: Page, sourceId: string) {
  await page.goto(`/sources/${sourceId}`);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Disconnect this source?' })).toBeVisible();
  return dialog;
}

/** Disconnects through the dialog with a hub data choice; the radio names carry the source id. */
async function disconnectWithChoice(page: Page, sourceId: string, choice: 'keep' | 'delete'): Promise<void> {
  const dialog = await openDisconnect(page, sourceId);
  const keep = dialog.getByRole('radio', { name: 'Keep what was found' });
  const del = dialog.getByRole('radio', { name: 'Delete what was found' });
  await expect(keep).toHaveAttribute('name', `hub-data-${sourceId}`);
  await expect(del).toHaveAttribute('name', `hub-data-${sourceId}`);
  await expect(keep).toBeChecked();
  await (choice === 'keep' ? keep : del).check();
  const done = page.waitForResponse((r) => r.url().endsWith(`/api/sources/${sourceId}/disconnect`));
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
  expect((await done).status()).toBe(200);
  await expect(dialog).toBeHidden();
}

test.describe('hub US8: mailbox disconnect and hub off', () => {
  test.describe.configure({ timeout: 12 * 60_000 });

  test('US8.2 / FR-031 / SC-012: disconnect with delete removes only that mailbox\'s hub data, also from the store @ui', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const t = tag();
    const mailboxA = uniqueMailbox('us8-del-a');
    const mailboxB = uniqueMailbox('us8-del-b');
    const offerSubject = `Oferta ${t}`;
    await appendMessages(mailboxA, [rfc822(janMail(mailboxA, offerSubject))]);
    await appendMessages(mailboxB, [rfc822(olaMail(mailboxB, `Workshop ${t}`))]);

    // User-entered data: a typed company that no mailbox touches.
    const { record: typedCo } = await api.post<{ record: { id: string; name: string } }>(page, '/api/hub/companies', {
      name: `Typed Co ${t}`,
    });

    const a = await connectImap(page, mailboxA);
    const b = await connectImap(page, mailboxB);
    await waitForImport(page, a.id);
    await waitForImport(page, b.id);
    await enableHub(page, a.id);
    await enableHub(page, b.id);
    expect((await sourceOf(page, a.id)).hub).toEqual({ enabled: true });

    const settled = await waitThreadsSettled(userId, 2);
    expect(settled.filter((r) => r.status === 'done')).toHaveLength(2);
    const jan = await findPerson(page, JAN.name);
    const ola = await findPerson(page, OLA.name);
    const acme = (await companies(page)).find((c) => c.name === ACME.name);
    expect(acme, 'Acme from mailbox A').toBeDefined();
    const [threadA] = await sourcesOf(page, 'people', jan.id);
    const [threadB] = await sourcesOf(page, 'people', ola.id);
    expect(threadA?.subject).toBe(offerSubject);
    expect(threadB).toBeDefined();
    const janLink = (await personDetail(page, jan.id)).links[0]!.link.id;

    // User-entered data on a derived record: a note keeps Jan (FR-031), his derived values still go.
    const { note } = await api.post<{ note: { id: string } }>(page, `/api/hub/people/${jan.id}/notes`, {
      title: `Call notes ${t}`,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Called about steel.' }] }] },
    });

    const docs = {
      summaryA: `hub_summary_${threadA!.threadId}`,
      summaryB: `hub_summary_${threadB!.threadId}`,
      acme: `hub_company_${acme!.id}`,
      jan: `hub_person_${jan.id}`,
      ola: `hub_person_${ola.id}`,
      typedCo: `hub_company_${typedCo.id}`,
      note: `hub_note_${note.id}`,
    };
    await waitForDocs(userId, Object.values(docs));

    // With the hub on, the choice is required (422) and the dialog asks for it.
    await expect(api.post(page, `/api/sources/${a.id}/disconnect`, { deleteContent: false })).rejects.toMatchObject({
      status: 422,
      code: 'hub_data_choice_required',
    } satisfies Partial<ApiError>);
    await disconnectWithChoice(page, a.id, 'delete');

    const done = await poll(
      () => hubDeletions(a.id),
      (r) => r[0]?.status === 'completed' || r[0]?.status === 'failed',
      { timeoutMs: PURGE_TIMEOUT_MS, intervalMs: 1_000 },
    );
    expect(done.map((r) => r.status)).toEqual(['completed']);
    expect(await sourceOf(page, a.id)).toMatchObject({ status: 'disconnected', hub: { enabled: false } });
    expect(await mailboxOf(page, a.id)).toMatchObject({ enabled: false, dataChoice: 'delete' });

    // Summaries, values and links only from mailbox A are gone; Acme (nothing user-made, no other source) is deleted.
    const threadIds = (await threadsOf(userId)).map((r) => r.id);
    expect(threadIds).not.toContain(threadA!.threadId);
    expect(threadIds).toContain(threadB!.threadId);
    const janAfter = await personDetail(page, jan.id);
    expect(janAfter.record).toMatchObject({ name: JAN.name, phone: null, roleTitle: null });
    expect(janAfter.record.emails).toEqual([]);
    expect(janAfter.links.map((l) => l.link.id)).not.toContain(janLink);
    expect(await sourcesOf(page, 'people', jan.id)).toEqual([]);
    expect((await companies(page)).map((c) => c.name)).toEqual([typedCo.name]);

    // Mailbox B and user-entered data stay.
    const olaAfter = await personDetail(page, ola.id);
    expect(olaAfter.record.emails.map((e) => e.address)).toEqual([OLA.address]);
    expect((await sourcesOf(page, 'people', ola.id)).map((s) => s.threadId)).toEqual([threadB!.threadId]);
    const notes = await api.get<{ items: { id: string }[] }>(page, `/api/hub/people/${jan.id}/notes`);
    expect(notes.items.map((n) => n.id)).toEqual([note.id]);

    // The store: the deleted summary and record are gone, the rest is there and Jan's document lost his phone.
    const after = await waitForDocs(
      userId,
      [docs.summaryB, docs.jan, docs.ola, docs.typedCo, docs.note],
      [docs.summaryA, docs.acme],
      (d) => !d.get(docs.jan)!.content.includes(JAN.phone),
    );
    expect(after.get(docs.jan)!.content).toContain(JAN.name);

    const audit = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log_entry WHERE action = 'hub.mailbox_data_deleted' AND target_id = $1`,
      [a.id],
    );
    expect(audit[0]!.n).toBe(1);
  });

  test('US8.3: disconnect with keep leaves derived data and nothing new arrives @ui', async ({ page }) => {
    const { userId } = await signInConfirmed(page);
    const t = tag();
    const mailbox = uniqueMailbox('us8-keep');
    await appendMessages(mailbox, [rfc822(janMail(mailbox, `Oferta ${t}`))]);
    const source = await connectImap(page, mailbox);
    await waitForImport(page, source.id);
    await enableHub(page, source.id);
    await waitThreadsSettled(userId, 1);
    const jan = await findPerson(page, JAN.name);
    const [thread] = await sourcesOf(page, 'people', jan.id);
    const docIds = [`hub_person_${jan.id}`, `hub_summary_${thread!.threadId}`];
    await waitForDocs(userId, docIds);

    await disconnectWithChoice(page, source.id, 'keep');
    const disconnected = await sourceOf(page, source.id);
    expect(disconnected).toMatchObject({ status: 'disconnected', hub: { enabled: false } });
    expect(await mailboxOf(page, source.id)).toMatchObject({ enabled: false, dataChoice: 'keep' });
    expect(await hubDeletions(source.id)).toEqual([]);

    // Derived data stays, in the hub and in the store.
    expect((await personDetail(page, jan.id)).record).toMatchObject({ phone: JAN.phone, roleTitle: JAN.role });
    expect((await sourcesOf(page, 'people', jan.id)).map((s) => s.threadId)).toEqual([thread!.threadId]);
    expect((await companies(page)).map((c) => c.name)).toEqual([ACME.name]);
    const stored = await docsById(userId);
    for (const id of docIds) expect(stored.has(id), id).toBe(true);

    // Nothing new comes from the mailbox.
    await appendMessages(mailbox, [rfc822(olaMail(mailbox, `Workshop ${t}`))]);
    await page.waitForTimeout(QUIET_PERIOD_MS);
    expect((await sourceOf(page, source.id)).itemCount).toBe(disconnected.itemCount);
    expect((await threadsOf(userId)).map((r) => r.id)).toEqual([thread!.threadId]);
    expect((await people(page)).map((p) => p.name)).toEqual([JAN.name]);
  });

  test('edge "hub off": turning the hub off asks keep or delete and stops processing; the dialog then asks nothing @ui', async ({
    page,
  }) => {
    const { userId } = await signInConfirmed(page);
    const t = tag();
    const mailbox = uniqueMailbox('us8-off');
    await appendMessages(mailbox, [rfc822(janMail(mailbox, `Oferta ${t}`))]);
    const source = await connectImap(page, mailbox);
    await waitForImport(page, source.id);
    await enableHub(page, source.id);
    const [first] = await waitThreadsSettled(userId, 1);
    const before = await sourceOf(page, source.id);
    const label = (await mailboxOf(page, source.id)).accountLabel;

    await page.goto('/hub/settings');
    await turnOff(page, source.id, label, 'keep');
    expect(await sourceOf(page, source.id)).toMatchObject({ status: 'connected', hub: { enabled: false } });
    await page.goto(`/sources/${source.id}`);
    await expect(page.getByText('Hub: off.')).toBeVisible();

    // The mailbox still syncs, but the hub reads nothing new.
    await appendMessages(mailbox, [rfc822(olaMail(mailbox, `Workshop ${t}`))]);
    await poll(
      () => sourceOf(page, source.id),
      (s) => s.itemCount > before.itemCount,
      { timeoutMs: 180_000, intervalMs: 3_000 },
    );
    await page.waitForTimeout(QUIET_PERIOD_MS / 2);
    expect((await threadsOf(userId)).map((r) => r.id)).toEqual([first!.id]);
    expect((await people(page)).map((p) => p.name)).toEqual([JAN.name]);

    // With the hub off the disconnect dialog has no hub choice and the request needs none (spec 001 behaviour).
    const dialog = await openDisconnect(page, source.id);
    await expect(dialog.getByRole('radio')).toHaveCount(0);
    const done = page.waitForResponse((r) => r.url().endsWith(`/api/sources/${source.id}/disconnect`));
    await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
    expect((await done).status()).toBe(200);
    expect((await sourceOf(page, source.id)).status).toBe('disconnected');
    expect(await hubDeletions(source.id)).toEqual([]);
  });
});
