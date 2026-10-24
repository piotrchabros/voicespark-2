import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, ApiError } from './support/api';
import {
  createProfileReady,
  getDraft,
  requestDraft,
  restoreProfileThreshold,
  waitForDraft,
  type DraftView,
} from './support/drafts';

// Hub US6 (quickstart "Drafts", rows US6.1..US6.4 and "Edge: deleted record"; FR-027, FR-028): a draft request can
// pin a person, company or project. The worker runs the fake generation LLM, which echoes only the `Brief: ` line, so
// the record context itself is observed through `hubContextStatus` ('used' once the inspected block went into the
// prompt); the block's content is covered by apps/worker/test/draft-generate.integration.test.ts (T142).

type HubRecordRef = { kind: 'person' | 'company' | 'project'; id: string | null; label: string } | null;
type HubDraftView = DraftView & {
  hubRecord: HubRecordRef;
  hubContextStatus: 'used' | 'missing' | 'inspection_failed' | null;
};
interface ListItem {
  id: string;
  hubRecord: HubRecordRef;
  hubContextStatus: HubDraftView['hubContextStatus'];
}

const BRIEF = 'A short thank-you note after our call about the Q3 rollout plan';
/** Contact values on the record: excluded under the default policy, so absent from the draft (AS6.4). */
const CONTACT_EMAIL = `dana-${randomUUID().slice(0, 8)}@acme-e2e.test`;
const CONTACT_PHONE = '+48 601 234 567';

const mailOf = (prefix: string) => `${prefix}-${randomUUID()}@e2e.test`;
const uniqueName = (base: string) => `${base} ${test.info().testId.slice(0, 8)}`;

const fetchDraft = (page: Page, id: string) => getDraft(page, id) as Promise<HubDraftView>;
const waitDraft = (page: Page, id: string) => waitForDraft(page, id) as Promise<HubDraftView>;

async function listItem(page: Page, id: string): Promise<ListItem | undefined> {
  const list = await api.get<{ items: ListItem[] }>(page, '/api/drafts?limit=100');
  return list.items.find((i) => i.id === id);
}

/** The "CTO at Acme, discussed the Q3 rollout" person: role, a linked company and a note with the topic. */
async function createCtoAtAcme(page: Page): Promise<{ id: string; name: string; companyId: string }> {
  const company = (await api.post<{ record: { id: string } }>(page, '/api/hub/companies', { name: uniqueName('Acme') }))
    .record;
  const person = (
    await api.post<{ record: { id: string; name: string } }>(page, '/api/hub/people', {
      name: uniqueName('Dana Wierzbicka'),
      roleTitle: 'CTO',
      phone: CONTACT_PHONE,
      emails: [CONTACT_EMAIL],
    })
  ).record;
  await api.post(page, '/api/hub/links', {
    kind: 'person_company',
    personId: person.id,
    companyId: company.id,
    role: 'CTO',
  });
  await api.post(page, `/api/hub/people/${person.id}/notes`, {
    title: 'Call notes',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CTO at Acme, discussed the Q3 rollout.' }] }],
    },
  });
  return { id: person.id, name: person.name, companyId: company.id };
}

async function otherUsersPerson(browser: Browser): Promise<string> {
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await signInAs(other, { email: mailOf('us6-other') });
    const { record } = await api.post<{ record: { id: string } }>(other, '/api/hub/people', {
      name: 'Someone Else',
    });
    return record.id;
  } finally {
    await context.close();
  }
}

test.afterAll(async () => {
  await restoreProfileThreshold();
});

test.describe('hub US6: drafts about a record', () => {
  test('US6.1, US6.3, US6.4, deleted record: a pinned person is used, shown and kept as removed @ui', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await signInAs(page, { email: mailOf('us6-pinned') });
    await createProfileReady(page);
    const person = await createCtoAtAcme(page);

    // Request the draft in the browser with the record picker (search-as-you-type).
    await page.goto('/drafts/new');
    await page.getByLabel('Topic or brief').fill(BRIEF);
    await page.getByRole('searchbox', { name: 'Search people, companies and projects' }).fill('Wierzbicka');
    const results = page.getByRole('list', { name: 'Matching records' });
    await results.getByRole('button', { name: person.name }).click();
    await expect(page.getByTestId('picked-record')).toContainText(person.name);
    await page.getByRole('button', { name: 'Write draft' }).click();
    await page.waitForURL(/\/drafts\/[0-9a-f-]{36}$/);
    const draftId = page.url().split('/').pop()!;

    // US6.1 / US6.4: the draft is ready in the chosen voice, the record context was used, contact values are absent.
    const draft = await waitDraft(page, draftId);
    expect(draft.status).toBe('ready');
    expect(draft.generatedText).toContain(BRIEF);
    expect(draft.hubRecord).toEqual({ kind: 'person', id: person.id, label: person.name });
    expect(draft.hubContextStatus).toBe('used');
    for (const value of [CONTACT_EMAIL, CONTACT_PHONE]) {
      expect(draft.text ?? '').not.toContain(value);
      expect(draft.generatedText ?? '').not.toContain(value);
    }

    // US6.3: the detail page and the draft list show the record used, linked to it.
    await page.reload();
    const detailRef = page.getByTestId('draft-hub-record');
    await expect(detailRef.getByRole('link', { name: person.name })).toHaveAttribute(
      'href',
      `/hub/people/${person.id}`,
    );
    await page.goto('/drafts');
    const row = page.getByTestId('draft-row').filter({ hasText: BRIEF.slice(0, 40) });
    await expect(row.getByTestId('draft-hub-record').getByRole('link', { name: person.name })).toHaveAttribute(
      'href',
      `/hub/people/${person.id}`,
    );
    expect((await listItem(page, draftId))?.hubRecord).toEqual({ kind: 'person', id: person.id, label: person.name });

    // Edge: deleting the record keeps the draft; the reference shows as removed with the label kept.
    await api.delete(page, `/api/hub/people/${person.id}`);
    const after = await fetchDraft(page, draftId);
    expect(after).toMatchObject({ status: 'ready', generatedText: draft.generatedText });
    expect(after.hubRecord).toEqual({ kind: 'person', id: null, label: person.name });
    expect((await listItem(page, draftId))?.hubRecord).toEqual({ kind: 'person', id: null, label: person.name });

    await page.reload();
    const removedRow = page.getByTestId('draft-row').filter({ hasText: BRIEF.slice(0, 40) });
    await expect(removedRow.getByTestId('draft-hub-record')).toContainText(`${person.name} (removed)`);
    await expect(removedRow.getByTestId('draft-hub-record').getByRole('link')).toHaveCount(0);
    await page.goto(`/drafts/${draftId}`);
    await expect(page.getByTestId('draft-hub-record')).toContainText(`${person.name} (removed)`);
    await expect(page.getByTestId('draft-hub-record').getByRole('link')).toHaveCount(0);

    // Regenerating after the deletion still runs; the context is reported missing.
    const { draftId: childId } = await api.post<{ draftId: string }>(page, `/api/drafts/${draftId}/regenerate`, {});
    const child = await waitDraft(page, childId);
    expect(child.status).toBe('ready');
    expect(child.hubRecord).toEqual({ kind: 'person', id: null, label: person.name });
    expect(child.hubContextStatus).toBe('missing');
  });

  test('US6.2: a draft without a record behaves as before; a foreign record is 404', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signInAs(page, { email: mailOf('us6-plain') });
    const { profileId } = await createProfileReady(page);

    const plainId = await requestDraft(page, { contentType: 'social_post', profileId, brief: BRIEF });
    const plain = await waitDraft(page, plainId);
    expect(plain.status).toBe('ready');
    expect(plain.generatedText).toContain(BRIEF);
    expect(plain.hubRecord).toBeNull();
    expect(plain.hubContextStatus).toBeNull();
    expect(await listItem(page, plainId)).toMatchObject({ hubRecord: null, hubContextStatus: null });

    const foreignId = await otherUsersPerson(browser);
    for (const hubRecord of [
      { kind: 'person', id: foreignId },
      { kind: 'company', id: randomUUID() },
    ]) {
      const attempt = api.post(page, '/api/drafts', { contentType: 'social_post', profileId, brief: BRIEF, hubRecord });
      await expect(attempt).rejects.toMatchObject({ status: 404, code: 'not_found' });
      await attempt.catch((e) => expect(e).toBeInstanceOf(ApiError));
    }
  });
});
