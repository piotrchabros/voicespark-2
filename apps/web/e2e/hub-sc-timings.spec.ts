import type { Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { confirmFilters } from './support/api';
import { measure } from './support/timing';

// Hub success-criterion timings (T152, quickstart section 8): SC-001 create a record and add a first note in under a
// minute and attach a file in three steps or fewer; SC-002 a record with 100 notes and files shows notes, files, links
// and summaries on one screen in under two seconds. Both timings land in test-results/sc-timings.json (support/timing.ts).

// SC-002 is in hub-sc-timings-sc002.spec.ts: it runs without Playwright tracing, which can only be switched off per file.
const SC001_LIMIT_MS = 60_000;

function uniqueName(base: string): string {
  return `${base} ${test.info().testId.slice(0, 8)}`;
}

async function signInConfirmed(page: Page): Promise<{ userId: string; email: string }> {
  const result = await signInAs(page, { email: `e2e-${test.info().testId}-${Date.now()}@example.test` });
  await confirmFilters(page);
  return result;
}

test.describe('hub success-criterion timings', () => {
  test('SC-001: a record and its first note in under a minute, a file attached in three steps or fewer @ui', async ({
    page,
  }) => {
    await signInConfirmed(page);
    const name = uniqueName('Timing Garden');

    await measure('create a record and add the first note', 'SC-001', SC001_LIMIT_MS, async () => {
      await page.goto('/hub/companies/new');
      await page.getByLabel('Name').fill(name);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('heading', { name })).toBeVisible();

      await page.getByRole('button', { name: 'New note' }).click();
      await page.getByLabel('Title', { exact: true }).fill('First note');
      await page.getByRole('textbox', { name: 'Note text' }).click();
      await page.keyboard.type('Call the supplier about spring seeds.');
      await page.getByRole('button', { name: 'Add note', exact: true }).click();
      await expect(page.getByRole('article', { name: 'First note' })).toBeVisible();
    });

    // Attach a file: pick it, then upload (no description needed).
    let steps = 0;
    await page.getByLabel('File', { exact: true }).setInputFiles({
      name: 'seed-list.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Spring seed list: tomatoes, basil, peppers.'),
    });
    steps++;
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    steps++;
    expect(steps).toBeLessThanOrEqual(3);
    await expect(
      page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: 'seed-list.txt' }),
    ).toBeVisible();
  });
});
