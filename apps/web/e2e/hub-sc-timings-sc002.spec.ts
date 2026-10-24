import type { Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, confirmFilters } from './support/api';
import { runCore } from './support/scripts';
import { measure } from './support/timing';

// Hub SC-002 (T152, quickstart section 8): a record with 100 notes and files shows notes, files, links and summaries on
// one screen in under two seconds. SC-001 is in hub-sc-timings.spec.ts; both land in test-results/sc-timings.json.
//
// Gated only against the production server (E2E_PROD=1, playwright.config.ts): under `next dev` the dev-mode React
// render of a 100-note, 100-file screen alone eats most of the budget on the shared host, so a dev run records the
// timing without asserting it.
const PROD_SERVER = process.env.E2E_PROD === '1';
const SC002_LIMIT_MS = 2_000;
const COUNT = 100;
const LINKED_COMPANIES = 5;
const THREADS = 5;

// Trace DOM snapshots of a 100-note, 100-file screen add up to a second to the timed open. Playwright allows switching
// tracing off only per file, which is why SC-002 has a file of its own.
test.use({ trace: 'off' });

interface RecordView {
  id: string;
  name: string;
}

function uniqueName(base: string): string {
  return `${base} ${test.info().testId.slice(0, 8)}`;
}

async function signInConfirmed(page: Page): Promise<{ userId: string; email: string }> {
  const result = await signInAs(page, { email: `e2e-${test.info().testId}-${Date.now()}@example.test` });
  await confirmFilters(page);
  return result;
}

test.describe('hub success-criterion timings: SC-002', () => {
  test('SC-002: a record with 100 notes and 100 files opens with notes, files, links and summaries in under 2 s @ui', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    if (!PROD_SERVER) {
      test.info().annotations.push({
        type: 'gate:SC-002',
        description: `timing recorded, not asserted: the ${SC002_LIMIT_MS} ms gate applies to the production server (E2E_PROD=1)`,
      });
    }
    const { userId } = await signInConfirmed(page);
    const person = (
      await api.post<{ record: RecordView }>(page, '/api/hub/people', { name: uniqueName('Busy Person') })
    ).record;

    // Links: a few companies.
    for (let i = 0; i < LINKED_COMPANIES; i++) {
      const company = (
        await api.post<{ record: RecordView }>(page, '/api/hub/companies', { name: uniqueName(`Linked Co ${i}`) })
      ).record;
      await api.post(page, '/api/hub/links', { kind: 'person_company', personId: person.id, companyId: company.id });
    }

    // Notes through the API (120 per minute limit).
    for (let i = 0; i < COUNT; i++) {
      await api.post(page, `/api/hub/people/${person.id}/notes`, {
        title: `Note ${String(i).padStart(3, '0')}`,
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: `Body of note number ${i}.` }] }],
        },
      });
    }

    // Files through the service (the upload route is limited to 60 per hour), and conversation summaries as thread
    // rows (summaries come from mail, which has no direct API).
    await runCore(
      `const { upload } = await import('@voicespark/core/services/hub/files');
       const { encryptContent } = await import('@voicespark/core/services/hub/common');
       const { getDb } = await import('@voicespark/db/client');
       const { hubThread, hubThreadRecord } = await import('@voicespark/db/schema');
       const { createHash } = await import('node:crypto');
       const [userId, personId, count, threads] = args;
       const ctx = { userId, role: 'user' };
       for (let i = 0; i < count; i++) {
         await upload(ctx, 'person', personId, {
           bytes: Buffer.from('File number ' + i + ' with plain text.'),
           filename: 'file-' + String(i).padStart(3, '0') + '.txt',
         });
       }
       const db = getDb();
       for (let i = 0; i < threads; i++) {
         const at = new Date(Date.UTC(2026, 5, 1 + i));
         const [t] = await db.insert(hubThread).values({
           userId,
           threadKey: createHash('sha256').update('sc002-' + personId + '-' + i).digest('hex'),
           subjectEnc: encryptContent('Summary subject ' + i),
           participantsEnc: encryptContent(JSON.stringify([{ name: 'Busy Person', address: 'busy@example.test', owner: false }])),
           firstMessageAt: at,
           lastMessageAt: at,
           messageCount: 2,
           language: 'en',
           summaryEnc: encryptContent('Short summary number ' + i + '.'),
           summaryVersion: 1,
           status: 'done',
         }).returning({ id: hubThread.id });
         await db.insert(hubThreadRecord).values({ userId, threadId: t.id, personId });
       }`,
      [userId, person.id, COUNT, THREADS],
    );

    // Wait until the API sees everything seeded and the background work the seeding started has settled: every file's
    // text is read (the file list polls the page while one is pending) and the memory copies of the notes, files and
    // record are stored. SC-002 times opening the screen, not the worker's extraction and sync on the same host.
    type Synced = { extractionStatus?: string; sync: { status: string } };
    const settled = (items: Synced[]) =>
      items.length === COUNT && items.every((i) => i.extractionStatus !== 'pending' && i.sync.status !== 'pending');
    await expect
      .poll(
        async () =>
          settled((await api.get<{ items: Synced[] }>(page, `/api/hub/people/${person.id}/files`)).items) &&
          settled((await api.get<{ items: Synced[] }>(page, `/api/hub/people/${person.id}/notes?limit=100`)).items) &&
          (await api.get<{ sync: { status: string } }>(page, `/api/hub/people/${person.id}`)).sync.status !== 'pending',
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true);

    // An unmeasured open of the same record first: it loads the route's bundles (dev-compiled under `next dev`) into
    // this browser and warms the server's render of a screen this size, as on a production server in use, so the
    // timing is the open of the screen and not first loading.
    await page.goto(`/hub/people/${person.id}`);
    await expect(page.getByRole('list', { name: 'Notes' }).getByRole('article')).toHaveCount(COUNT);
    await expect(page.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(COUNT);
    await page.goto('about:blank');

    await measure(
      'open a record with 100 notes and 100 files',
      'SC-002',
      SC002_LIMIT_MS,
      async () => {
        await page.goto(`/hub/people/${person.id}`);
        await expect(page.getByRole('list', { name: 'Notes' }).getByRole('article')).toHaveCount(COUNT);
        await expect(page.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(COUNT);
        await expect(page.getByRole('list', { name: 'Linked records' }).getByRole('listitem')).toHaveCount(
          LINKED_COMPANIES,
        );
        await expect(page.getByRole('list', { name: 'Conversation summaries' }).getByRole('article')).toHaveCount(
          THREADS,
        );
      },
      { gate: PROD_SERVER },
    );
  });
});
