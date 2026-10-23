import type { Browser, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, confirmFilters, poll, setAdminSetting } from './support/api';
import { demoteOtherAdmins, restoreAdmins } from './support/scripts';
import { measure } from './support/timing';

// US6 (quickstart section 6): admin surface. Admin calls run in a second browser context; the user under test
// keeps the fixture page. Global rows touched here (definitions, prompt versions, admin roles) are restored.

const MIN_WORDS = 50;
const SECRET_PHRASE = 'heron-ledger-private-note-text';
const GENERAL_KEY = 'general_voice';

const NOTES = [
  `${SECRET_PHRASE}: the valley keeps its own calendar. By the time the town has moved on to autumn coats, the orchard still holds a few warm afternoons in reserve, and I like to spend them walking the rows with a notebook, writing down which trees carried fruit and which ones rested. The notes are plain, but they add up to a kind of diary of the place.`,
  'When I write for the newsletter I try to keep the sentences short and the pictures concrete: the ladder against the pear tree, the crates stacked by the gate, the dog asleep in the one patch of shade. Readers tell me they can see it, and that is the whole point of the exercise, so I keep doing it that way.',
];

interface UploadView {
  id: string;
  status: 'received' | 'processing' | 'stored' | 'rejected' | 'failed';
  contentItemId: string | null;
}

interface ProfileListItem {
  id: string;
  definition: { id: string; name: string; retired: boolean };
  latestVersion: { id: string; versionNumber: number } | null;
}

interface GenerationView {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';
  blockReason: string | null;
  errorCode: string | null;
  resultVersionId: string | null;
}

interface AdminDefinition {
  id: string;
  key: string;
  availability: 'available' | 'retired';
  activeVersion: { id: string; versionNumber: number; name: string } | null;
  draftVersionId: string | null;
}

interface AdminPrompt {
  id: string;
  key: string;
  activeVersion: { id: string; versionNumber: number; model: string } | null;
  draftVersionId: string | null;
}

interface PromptVersion {
  id: string;
  versionNumber: number;
  status: string;
  systemTemplate: string;
  userTemplate: string;
}

interface HistoryEntry {
  action: 'publish' | 'rollback';
  fromVersion: { id: string } | null;
  toVersion: { id: string };
  actor: { id: string; name: string | null };
  occurredAt: string;
}

interface AdminUserDetail {
  id: string;
  email: string;
  role: string;
  identities: { provider: string }[];
  sources: { id: string; type: string; itemCount: number }[];
  profiles: { definitionName: string; status: string; versionCount: number }[];
}

function uniqueEmail(tag = ''): string {
  return `e2e-${test.info().testId}${tag}-${Date.now()}@example.test`;
}

async function signInConfirmed(page: Page, tag = ''): Promise<{ userId: string; email: string }> {
  const result = await signInAs(page, { email: uniqueEmail(tag) });
  await confirmFilters(page);
  return result;
}

async function adminPage(browser: Browser): Promise<Page & { adminId: string }> {
  const page = await (await browser.newContext()).newPage();
  const { userId } = await signInAs(page, { email: uniqueEmail('-admin'), role: 'admin' });
  await setAdminSetting(page, 'profile.min_authored_words', MIN_WORDS);
  return Object.assign(page, { adminId: userId });
}

async function uploadNote(page: Page, text: string): Promise<UploadView> {
  const { uploadId } = await api.post<{ uploadId: string }>(page, '/api/notes', { text });
  const upload = await poll(
    () => api.get<UploadView>(page, `/api/uploads/${uploadId}`),
    (u) => u.status !== 'received' && u.status !== 'processing',
    { timeoutMs: 90_000 },
  );
  expect(upload).toMatchObject({ status: 'stored' });
  return upload;
}

async function waitForGeneration(page: Page, generationId: string): Promise<GenerationView> {
  const g = await poll(
    () => api.get<GenerationView>(page, `/api/profile-generations/${generationId}`),
    (x) => x.status !== 'queued' && x.status !== 'running',
    { timeoutMs: 150_000, intervalMs: 1_000 },
  );
  expect(g, JSON.stringify(g)).toMatchObject({ status: 'succeeded' });
  return g;
}

/**
 * Notes over the threshold: the first stored upload auto-chooses the single available definition and queues the
 * first generation (T121), so the profile gets exactly one version without calling generate.
 */
async function seedProfile(page: Page): Promise<{ profile: ProfileListItem; contentItemId: string }> {
  const uploads = [];
  for (const note of NOTES) uploads.push(await uploadNote(page, note));
  const [profile] = await poll(
    () => api.get<ProfileListItem[]>(page, '/api/profiles'),
    (list) => list.some((p) => p.latestVersion !== null),
    { timeoutMs: 150_000, intervalMs: 1_000 },
  );
  expect(profile!.latestVersion!.versionNumber).toBe(1);
  return { profile: profile!, contentItemId: uploads[0]!.contentItemId! };
}

/** A regenerate run; returns the prompt version id the new profile version was generated with. */
async function regeneratePromptVersionId(page: Page, profileId: string): Promise<string> {
  const { generationId } = await api.post<{ generationId: string }>(page, `/api/profiles/${profileId}/regenerate`);
  const g = await waitForGeneration(page, generationId);
  const v = await api.get<{ promptVersion: { id: string } | null }>(page, `/api/profiles/${profileId}/versions/${g.resultVersionId}`);
  return v.promptVersion!.id;
}

async function adminDefinitions(admin: Page): Promise<AdminDefinition[]> {
  return api.get<AdminDefinition[]>(admin, '/api/admin/definitions');
}

test.describe('US6 administration', () => {
  test('a non-admin gets the 403 page at /admin @ui', async ({ page }) => {
    await signInConfirmed(page);
    await page.goto('/admin');
    // Next's route announcer is a second `role=alert`; the 403 panel is the one carrying the status.
    const alert = page.getByRole('alert').filter({ hasText: '403' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('admin_required');
    await expect(page.getByRole('link', { name: 'Back to dashboard' })).toBeVisible();
  });

  test('admin APIs refuse a non-admin with 403 admin_required', async ({ page }) => {
    await signInConfirmed(page);
    for (const path of ['/api/admin/users', '/api/admin/definitions', '/api/admin/prompts', '/api/admin/metrics/ratings']) {
      await expect(api.get(page, path), path).rejects.toMatchObject({ status: 403, code: 'admin_required' });
    }
    await expect(api.put(page, '/api/admin/settings', { key: 'profile.min_authored_words', value: 10 })).rejects.toMatchObject({
      status: 403,
      code: 'admin_required',
    });
  });

  test('a prompt draft has no effect, publishing applies to the next generation (SC-008) and rollback is in the history', async ({
    page,
    browser,
  }) => {
    const admin = await adminPage(browser);
    const prompts = await api.get<AdminPrompt[]>(admin, '/api/admin/prompts');
    const prompt = prompts.find((p) => p.key === 'tone_profile.generate')!;
    const originalId = prompt.activeVersion!.id;
    if (prompt.draftVersionId) await api.delete(admin, `/api/admin/prompts/${prompt.id}/versions/${prompt.draftVersionId}`);
    let draftId: string | undefined;
    try {
      await signInConfirmed(page);
      const { profile } = await seedProfile(page);

      const { versions } = await api.get<{ versions: PromptVersion[] }>(admin, `/api/admin/prompts/${prompt.id}`);
      const active = versions.find((v) => v.id === originalId)!;
      const draft = (await api.post<{ version: PromptVersion }>(admin, `/api/admin/prompts/${prompt.id}/versions`)).version;
      draftId = draft.id;
      expect(draft.status).toBe('draft');
      await api.patch(admin, `/api/admin/prompts/${prompt.id}/versions/${draft.id}`, {
        systemTemplate: `${active.systemTemplate}\nE2E draft marker: keep the summary to two sentences.`,
        changeNote: 'e2e draft',
      });
      // Draft only: the next generation still pins the active version.
      expect(await regeneratePromptVersionId(page, profile.id)).toBe(originalId);

      await measure('prompt publish -> next generation uses it', 'SC-008', 60_000, async () => {
        const { prompt: published } = await api.post<{ prompt: AdminPrompt }>(
          admin,
          `/api/admin/prompts/${prompt.id}/versions/${draft.id}/publish`,
        );
        expect(published.activeVersion?.id).toBe(draft.id);
        expect(await regeneratePromptVersionId(page, profile.id)).toBe(draft.id);
      });
      draftId = undefined;

      const { prompt: rolledBack } = await api.post<{ prompt: AdminPrompt }>(admin, `/api/admin/prompts/${prompt.id}/rollback`, {
        versionId: originalId,
      });
      expect(rolledBack.activeVersion?.id).toBe(originalId);
      const history = await api.get<HistoryEntry[]>(admin, `/api/admin/prompts/${prompt.id}/history`);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'publish', toVersion: expect.objectContaining({ id: draft.id }) }),
          expect.objectContaining({
            action: 'rollback',
            fromVersion: expect.objectContaining({ id: draft.id }),
            toVersion: expect.objectContaining({ id: originalId }),
            actor: expect.objectContaining({ id: admin.adminId }),
          }),
        ]),
      );
      expect(await regeneratePromptVersionId(page, profile.id)).toBe(originalId);
    } finally {
      if (draftId) await api.delete(admin, `/api/admin/prompts/${prompt.id}/versions/${draftId}`).catch(() => undefined);
      const current = (await api.get<AdminPrompt[]>(admin, '/api/admin/prompts')).find((p) => p.id === prompt.id);
      if (current?.activeVersion?.id !== originalId) {
        await api.post(admin, `/api/admin/prompts/${prompt.id}/rollback`, { versionId: originalId }).catch(() => undefined);
      }
      await admin.context().close();
    }
  });

  test('retiring the last available definition is blocked and a second published definition becomes visible to users', async ({
    page,
    browser,
  }) => {
    const admin = await adminPage(browser);
    let secondId: string | undefined;
    try {
      // Only e2e-created definitions may still be available from an earlier spec; retire them first.
      for (const d of await adminDefinitions(admin)) {
        if (d.availability === 'available' && d.key !== GENERAL_KEY && d.key.startsWith('e2e_')) {
          await api.put(admin, `/api/admin/definitions/${d.id}/availability`, { availability: 'retired' });
        }
      }
      const general = (await adminDefinitions(admin)).find((d) => d.key === GENERAL_KEY)!;
      expect(general.availability).toBe('available');
      await expect(
        api.put(admin, `/api/admin/definitions/${general.id}/availability`, { availability: 'retired' }),
      ).rejects.toMatchObject({ code: 'last_available_definition' });
      expect((await adminDefinitions(admin)).find((d) => d.id === general.id)?.availability).toBe('available');

      await signInConfirmed(page);
      const created = await api.post<{ definition: AdminDefinition; draft: { id: string } }>(admin, '/api/admin/definitions', {
        key: `e2e_admin_${Date.now().toString(36)}`,
        name: 'E2E admin voice',
        description: 'A second definition created by the US6 e2e spec.',
        analysisPrompt:
          'Describe how directly the writer gets to the point: lead with the claim or circle toward it, and how blunt the phrasing is.',
      });
      secondId = created.definition.id;
      expect(created.definition.availability).toBe('retired');
      // Not available without an active version, and invisible to users until made available.
      await expect(
        api.put(admin, `/api/admin/definitions/${secondId}/availability`, { availability: 'available' }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await api.post(admin, `/api/admin/definitions/${secondId}/versions/${created.draft.id}/publish`);
      const userList = () => api.get<{ id: string; name: string; chosen: boolean }[]>(page, '/api/definitions');
      expect((await userList()).map((d) => d.id)).not.toContain(secondId);

      await api.put(admin, `/api/admin/definitions/${secondId}/availability`, { availability: 'available' });
      expect(await userList()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: secondId, name: 'E2E admin voice', chosen: false })]),
      );
      // With two available definitions the general one can now be retired, and made available again.
      await api.put(admin, `/api/admin/definitions/${general.id}/availability`, { availability: 'retired' });
      expect((await userList()).map((d) => d.id)).toEqual([secondId]);
      await api.put(admin, `/api/admin/definitions/${general.id}/availability`, { availability: 'available' });
    } finally {
      if (secondId) {
        await api.put(admin, `/api/admin/definitions/${secondId}/availability`, { availability: 'retired' }).catch(() => undefined);
      }
      await admin.context().close();
    }
  });

  test('an admin edits a draft analysis prompt, previews, publishes and rolls back via the history @ui', async ({ browser }) => {
    const admin = await adminPage(browser);
    let defId: string | undefined;
    try {
      const marker = `E2E analysis marker ${Date.now().toString(36)}`;
      const created = await api.post<{ definition: AdminDefinition; draft: { id: string } }>(admin, '/api/admin/definitions', {
        key: `e2e_prompt_${Date.now().toString(36)}`,
        name: 'E2E prompt voice',
        description: 'A definition whose analysis prompt is edited through the UI.',
        analysisPrompt: 'Describe the tone of the writer: warmth, formality and pacing, with concrete evidence from the samples.',
      });
      defId = created.definition.id;
      const v1Id = created.draft.id;
      await api.post(admin, `/api/admin/definitions/${defId}/versions/${v1Id}/publish`);
      await api.post(admin, `/api/admin/definitions/${defId}/versions`, {});

      await admin.goto(`/admin/definitions/${defId}`);
      const textarea = admin.getByLabel('Analysis prompt');
      await textarea.fill(`${marker}: describe the tone of the writer in plain language, citing short evidence from the samples.`);
      await admin.getByRole('button', { name: 'Save draft' }).click();
      await expect(admin.getByText('Draft saved.')).toBeVisible();
      const detail = await api.get<{ versions: { id: string; status: string; analysisPrompt: string | null }[] }>(
        admin,
        `/api/admin/definitions/${defId}`,
      );
      const draft = detail.versions.find((v) => v.status === 'draft')!;
      expect(draft.analysisPrompt).toContain(marker);

      await admin.getByRole('button', { name: 'Render prompt' }).click();
      await expect(admin.getByText(marker).first()).toBeVisible();

      await admin.getByRole('button', { name: 'Run on sample texts' }).click();
      const runSection = admin.locator('section').filter({ has: admin.getByRole('heading', { name: /Test run/ }) });
      await expect(runSection.getByText('done', { exact: true })).toBeVisible({ timeout: 90_000 });
      await expect(runSection.locator('.rounded-md.border').last()).not.toBeEmpty();

      await admin.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(admin.getByText('published.')).toBeVisible();
      await expect(admin.getByText('Active version 2', { exact: true })).toBeVisible();

      await admin.getByRole('button', { name: 'Roll back to this' }).click();
      await expect(admin.getByText('Rolled back to version 1.')).toBeVisible();
      await expect(admin.getByText('Active version 1', { exact: true })).toBeVisible();
      await expect(admin.getByText(/Rolled back to version 1/).last()).toBeVisible();
      const history = await api.get<HistoryEntry[]>(admin, `/api/admin/definitions/${defId}/history`);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'rollback', toVersion: expect.objectContaining({ id: v1Id }) }),
        ]),
      );

      await admin.goto('/admin/definitions');
      const card = admin.locator('li').filter({ hasText: created.definition.key });
      await expect(card.getByText('Own prompt in use')).toBeVisible();
      await expect(card.getByText('0 users').last()).toBeVisible();
    } finally {
      if (defId) await api.put(admin, `/api/admin/definitions/${defId}/availability`, { availability: 'retired' }).catch(() => undefined);
      await admin.context().close();
    }
  });

  test('the last active admin can neither demote themselves nor delete their account', async ({ page }) => {
    const { userId: adminId } = await signInAs(page, { email: uniqueEmail('-last-admin'), role: 'admin' });
    const demoted = await demoteOtherAdmins(adminId);
    try {
      await expect(api.put(page, `/api/admin/users/${adminId}/role`, { role: 'user' })).rejects.toMatchObject({ code: 'last_admin' });
      await expect(api.post(page, '/api/account/delete', { confirm: 'DELETE' })).rejects.toMatchObject({ code: 'last_admin' });
      // Nothing changed: still an active admin with a live session.
      expect(await api.get<{ id: string; role: string; status: string }>(page, '/api/me')).toMatchObject({
        id: adminId,
        role: 'admin',
        status: 'active',
      });
      expect(await api.get<AdminUserDetail>(page, `/api/admin/users/${adminId}`)).toMatchObject({ role: 'admin' });
    } finally {
      await restoreAdmins(demoted);
    }
  });

  test('admin user detail is metadata only and another user\'s resources are 404 for an admin', async ({ page, browser }) => {
    const admin = await adminPage(browser);
    try {
      const { userId, email } = await signInConfirmed(page);
      const { profile, contentItemId } = await seedProfile(page);
      const { draftId } = await api.post<{ draftId: string }>(page, '/api/drafts', {
        contentType: 'social_post',
        profileId: profile.id,
        brief: `A post about the orchard. ${SECRET_PHRASE}`,
      });
      const [source] = await api.get<{ id: string; type: string }[]>(page, '/api/sources');
      expect(source).toMatchObject({ type: 'uploads' });

      const detail = await api.get<AdminUserDetail>(admin, `/api/admin/users/${userId}`);
      expect(detail).toMatchObject({ id: userId, email, role: 'user' });
      expect(detail.identities.map((i) => i.provider)).toEqual(['google']);
      expect(detail.sources).toEqual([expect.objectContaining({ id: source!.id, type: 'uploads', itemCount: NOTES.length })]);
      expect(detail.profiles).toEqual([expect.objectContaining({ definitionName: 'General voice', versionCount: 1 })]);
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain(SECRET_PHRASE);
      for (const key of ['excerpt', 'summary', 'body', 'draft', 'brief', 'snippet']) expect(serialized).not.toContain(`"${key}`);
      expect(serialized).not.toContain(profile.id);
      expect(serialized).not.toContain(draftId);

      // User-scoped routes never resolve another user's ids, admin or not (SC-010).
      await expect(api.get(admin, `/api/sources/${source!.id}`)).rejects.toMatchObject({ status: 404, code: 'not_found' });
      await expect(api.delete(admin, `/api/content-items/${contentItemId}`)).rejects.toMatchObject({ status: 404, code: 'not_found' });
      await expect(api.get(admin, `/api/profiles/${profile.id}`)).rejects.toMatchObject({ status: 404, code: 'not_found' });
      await expect(api.get(admin, `/api/profiles/${profile.id}/versions/${profile.latestVersion!.id}`)).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
      await expect(api.get(admin, `/api/drafts/${draftId}`)).rejects.toMatchObject({ status: 404, code: 'not_found' });
      // The owner still can.
      expect(await api.get<{ id: string }>(page, `/api/drafts/${draftId}`)).toMatchObject({ id: draftId });
    } finally {
      await admin.context().close();
    }
  });

  test('the admin user detail page shows no user content @ui', async ({ page, browser }) => {
    const admin = await adminPage(browser);
    try {
      const { userId, email } = await signInConfirmed(page);
      await seedProfile(page);

      await admin.goto(`/admin/users/${userId}`);
      await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(admin.getByText(email, { exact: true })).toBeVisible();
      await expect(admin.getByRole('cell', { name: 'uploads', exact: true })).toBeVisible();
      await expect(admin.getByRole('cell', { name: 'General voice' })).toBeVisible();
      const text = await admin.locator('body').innerText();
      expect(text).not.toContain(SECRET_PHRASE);
      expect(text).not.toContain('orchard');
      expect(text).toContain('Admins never see user content.');
    } finally {
      await admin.context().close();
    }
  });
});
