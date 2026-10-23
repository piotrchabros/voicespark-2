import type { Browser, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, confirmFilters, poll, setAdminSetting } from './support/api';
import { createProfileReady, requestDraft, restoreProfileThreshold, waitForDraft } from './support/drafts';
import { runCore, sql } from './support/scripts';
import { measure } from './support/timing';

// US5 (quickstart section 6): profile generation through the worker with the fake generation LLM. The admin lowers
// `profile.min_authored_words` to 50 first so a couple of notes cross the threshold.

const MIN_WORDS = 50;
const RECEIVED_MARKER = 'quokka-lantern-received-only';

/** Authored notes (plain prose; nothing a filter would touch). Distinct texts, so they are not deduplicated. */
const SHORT_NOTE =
  'A short note about the orchard: the apples came early this year and the wasps found them first.';
const LONG_NOTES = [
  'The valley keeps its own calendar. By the time the town has moved on to autumn coats, the orchard still holds a few warm afternoons in reserve, and I like to spend them walking the rows with a notebook, writing down which trees carried fruit and which ones rested. The notes are plain, but they add up to a kind of diary of the place.',
  'When I write for the newsletter I try to keep the sentences short and the pictures concrete: the ladder against the pear tree, the crates stacked by the gate, the dog asleep in the one patch of shade. Readers tell me they can see it, and that is the whole point of the exercise, so I keep doing it that way.',
];
const RECEIVED_NOTE = `Forwarded message from a neighbour about the fence line. ${RECEIVED_MARKER} Please call when you can.`;

interface UploadView {
  id: string;
  status: 'received' | 'processing' | 'stored' | 'rejected' | 'failed';
  rejectReason: string | null;
  contentItemId: string | null;
}

interface ProfileListItem {
  id: string;
  definition: { id: string; name: string; retired: boolean };
  status: string;
  latestVersion: { id: string; versionNumber: number; createdAt: string } | null;
  activeGeneration: { id: string; kind: string; status: string } | null;
}

interface DocumentBody {
  aspects: { key: string; name: string }[];
  summary: string;
  sections: { aspectKey: string; heading: string; markdown: string }[];
  doList: string[];
  dontList: string[];
  excerpts: { text: string; contentItemId?: string }[];
  languages: { code: string; share: number }[];
}

interface ProfileVersionView {
  id: string;
  versionNumber: number;
  origin: string;
  format: 'structured' | 'document';
  definitionVersion: { id: string; versionNumber: number };
  promptVersion: { id: string; versionNumber: number } | null;
  promptSource: 'default' | 'own' | null;
  analysisPrompt:
    | { kind: 'default'; definitionVersion: { id: string; versionNumber: number } }
    | { kind: 'own'; ownVersion: { id: string; versionNumber: number } }
    | null;
  body: DocumentBody;
  excerptSources: Record<string, { kind: string; itemDate: string; sourceLabels: string[] } | null>;
  languages: string[];
  rating: string | null;
}

interface GenerationView {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';
  blockReason: string | null;
  errorCode: string | null;
  resultVersionId: string | null;
}

interface RatingCounts {
  rated: number;
  soundsLikeMe: number;
  share: number | null;
}

interface RatingsMetrics {
  profiles: RatingCounts;
  drafts: RatingCounts & { byContentType: Record<string, RatingCounts> };
}

interface AdminDefinition {
  id: string;
  key: string;
  availability: 'available' | 'retired';
  activeVersion: { id: string; versionNumber: number; name: string } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizeWs = (s: string) => s.replace(/\s+/g, ' ').trim();

function uniqueEmail(tag = ''): string {
  return `e2e-${test.info().testId}${tag}-${Date.now()}@example.test`;
}

async function signInConfirmed(page: Page, tag = ''): Promise<string> {
  const { userId } = await signInAs(page, { email: uniqueEmail(tag) });
  await confirmFilters(page);
  return userId;
}

/** A second browser context signed in as a fresh admin, with the eligibility threshold lowered. */
async function adminPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInAs(page, { email: uniqueEmail('-admin'), role: 'admin' });
  await setAdminSetting(page, 'profile.min_authored_words', MIN_WORDS);
  return page;
}

async function uploadNote(page: Page, text: string, authorship: 'authored' | 'received' = 'authored'): Promise<UploadView> {
  const { uploadId } = await api.post<{ uploadId: string }>(page, '/api/notes', { text, authorship });
  const upload = await poll(
    () => api.get<UploadView>(page, `/api/uploads/${uploadId}`),
    (u) => u.status !== 'received' && u.status !== 'processing',
    { timeoutMs: 90_000 },
  );
  expect(upload, text.slice(0, 40)).toMatchObject({ status: 'stored' });
  return upload;
}

async function waitForGeneration(page: Page, generationId: string): Promise<GenerationView> {
  return poll(
    () => api.get<GenerationView>(page, `/api/profile-generations/${generationId}`),
    (g) => g.status !== 'queued' && g.status !== 'running',
    { timeoutMs: 150_000, intervalMs: 1_000 },
  );
}

async function expectSucceeded(page: Page, generationId: string): Promise<string> {
  const g = await waitForGeneration(page, generationId);
  expect(g, JSON.stringify(g)).toMatchObject({ status: 'succeeded' });
  return g.resultVersionId!;
}

async function getVersion(page: Page, profileId: string, versionId: string): Promise<ProfileVersionView> {
  return api.get<ProfileVersionView>(page, `/api/profiles/${profileId}/versions/${versionId}`);
}

async function listVersions(page: Page, profileId: string): Promise<{ id: string; origin: string }[]> {
  return (await api.get<{ items: { id: string; origin: string }[] }>(page, `/api/profiles/${profileId}/versions`)).items;
}

const SECOND_ASPECTS = ['Directness', 'Pacing', 'Motifs'];

function aspectPrompt(aspects: string[], extra = ''): string {
  return [
    'Analyse how the author writes. Write one section for each aspect below.',
    '',
    'Aspects:',
    ...aspects.map((a) => `- ${a}: how the author handles ${a.toLowerCase()}.`),
    extra,
  ]
    .join('\n')
    .trim();
}

/** Creates, publishes and makes available a definition whose default analysis prompt lists `aspects`. */
async function createAvailableDefinition(
  admin: Page,
  aspects: string[] = SECOND_ASPECTS,
): Promise<{ id: string; versionId: string; aspects: string[]; prompt: string }> {
  const prompt = aspectPrompt(aspects);
  const created = await api.post<{ definition: AdminDefinition; draft: { id: string } }>(
    admin,
    '/api/admin/definitions',
    {
      key: `e2e_voice_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: 'E2E second voice',
      description: 'A second definition created by the US5 e2e spec.',
      analysisPrompt: prompt,
    },
  );
  const id = created.definition.id;
  await api.post(admin, `/api/admin/definitions/${id}/versions/${created.draft.id}/publish`);
  await api.put(admin, `/api/admin/definitions/${id}/availability`, { availability: 'available' });
  return { id, versionId: created.draft.id, aspects, prompt };
}

async function retire(admin: Page, definitionId: string): Promise<void> {
  await api.put(admin, `/api/admin/definitions/${definitionId}/availability`, { availability: 'retired' }).catch(() => undefined);
}

/** Uploads the long notes, chooses only `definitionId`, generates and waits for the first document version. */
async function profileOn(page: Page, definitionId: string): Promise<{ profileId: string; versionId: string }> {
  for (const note of LONG_NOTES) await uploadNote(page, note);
  await api.put(page, '/api/definition-choices', { definitionIds: [definitionId] });
  const { generations } = await api.post<{ generations: { id: string; profileId: string }[] }>(page, '/api/profiles/generate');
  expect(generations).toHaveLength(1);
  const versionId = await expectSucceeded(page, generations[0]!.id);
  return { profileId: generations[0]!.profileId, versionId };
}

async function revise(page: Page, profileId: string, kind: 'regenerate' | 'feedback'): Promise<ProfileVersionView> {
  const { generationId } = await api.post<{ generationId: string }>(
    page,
    `/api/profiles/${profileId}/${kind}`,
    kind === 'feedback' ? { feedback: 'Please make it warmer and shorter.' } : undefined,
  );
  return getVersion(page, profileId, await expectSucceeded(page, generationId));
}

function expectCompleteDocument(v: ProfileVersionView, headings: string[] | null, authored: string): void {
  expect(v.format).toBe('document');
  expect(v.body.sections.length).toBe(v.body.aspects.length);
  expect(v.body.sections.map((s) => s.aspectKey).sort()).toEqual(v.body.aspects.map((a) => a.key).sort());
  if (headings) expect(v.body.sections.map((s) => s.heading)).toEqual(headings);
  expect(v.body.summary.trim()).not.toBe('');
  expect(v.body.doList.length).toBeGreaterThan(0);
  expect(v.body.dontList.length).toBeGreaterThan(0);
  expect(v.body.excerpts.length).toBeGreaterThanOrEqual(3);
  for (const excerpt of v.body.excerpts) {
    expect(authored).toContain(normalizeWs(excerpt.text));
    expect(excerpt.contentItemId).toMatch(UUID_RE);
    const source = v.excerptSources[excerpt.contentItemId!];
    expect(source, 'excerpt source line').toMatchObject({ kind: 'note' });
    expect(source!.itemDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  expect(JSON.stringify(v)).not.toContain(RECEIVED_MARKER);
}

test.afterAll(async () => {
  await restoreProfileThreshold();
});

test.describe('US5 tone profiles', () => {
  test('below the threshold generation is refused; crossing it by upload auto-generates the first profile (SC-006)', async ({
    page,
    browser,
  }) => {
    const admin = await adminPage(browser);
    try {
      await signInConfirmed(page);
      // The first stored upload auto-chooses the single available definition (profile row, no version yet).
      await uploadNote(page, SHORT_NOTE);
      const eligibility = await api.get<{ authoredWordCount: number; thresholdWords: number; eligible: boolean }>(
        page,
        '/api/profiles/eligibility',
      );
      expect(eligibility).toMatchObject({ thresholdWords: MIN_WORDS, eligible: false });
      expect(eligibility.authoredWordCount).toBeLessThan(MIN_WORDS);
      await expect(api.post(page, '/api/profiles/generate')).rejects.toMatchObject({ code: 'insufficient_content' });
      const before = await api.get<ProfileListItem[]>(page, '/api/profiles');
      expect(before.map((p) => p.latestVersion)).toEqual([null]);

      // Nothing calls generate: the upload hook creates the first generation once the words cross the threshold.
      const profiles = await measure('upload crossing threshold -> first profile version', 'SC-006', 600_000, async () => {
        await uploadNote(page, LONG_NOTES[0]!);
        return poll(() => api.get<ProfileListItem[]>(page, '/api/profiles'), (list) => list.some((p) => p.latestVersion !== null), {
          timeoutMs: 150_000,
          intervalMs: 1_000,
        });
      });
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.latestVersion!.versionNumber).toBe(1);
      expect((await api.get<{ eligible: boolean }>(page, '/api/profiles/eligibility')).eligible).toBe(true);
    } finally {
      await admin.context().close();
    }
  });

  test('two available definitions give two complete documents; regenerate, feedback and direct edit add versions; ratings reach admin aggregates only', async ({
    page,
    browser,
  }) => {
    test.setTimeout(420_000);
    const admin = await adminPage(browser);
    const second = await createAvailableDefinition(admin);
    try {
      const userId = await signInConfirmed(page);
      for (const note of LONG_NOTES) await uploadNote(page, note);
      await uploadNote(page, RECEIVED_NOTE, 'received');

      const available = await api.get<{ id: string; name: string; chosen: boolean }[]>(page, '/api/definitions');
      expect(available.map((d) => d.id)).toContain(second.id);
      expect(available.length).toBeGreaterThanOrEqual(2);
      const general = available.find((d) => d.id !== second.id)!;
      await api.put(page, '/api/definition-choices', { definitionIds: [general.id, second.id] });

      const { generations } = await api.post<{ generations: { id: string; profileId: string }[] }>(
        page,
        '/api/profiles/generate',
      );
      expect(generations).toHaveLength(2);
      for (const g of generations) await expectSucceeded(page, g.id);

      const profiles = await api.get<ProfileListItem[]>(page, '/api/profiles');
      expect(profiles).toHaveLength(2);
      const authored = normalizeWs(LONG_NOTES.join(' '));
      for (const profile of profiles) {
        expect(profile.latestVersion).not.toBeNull();
        const v = await getVersion(page, profile.id, profile.latestVersion!.id);
        // One section per aspect of the definition's analysis prompt; the second definition lists exactly three.
        expectCompleteDocument(v, profile.definition.id === second.id ? second.aspects : null, authored);
        expect(v.languages).toEqual(['en']);
        expect(v.body.languages.map((l) => l.code)).toEqual(['en']);
        expect(v.definitionVersion.id).toMatch(UUID_RE);
        expect(v.promptVersion?.id).toMatch(UUID_RE);
        expect(v).toMatchObject({ promptSource: 'default', analysisPrompt: { kind: 'default' } });
      }

      // Each revision path adds a version; received mail stays background context and is never quoted.
      const profile = profiles.find((p) => p.definition.id === second.id)!;
      expectCompleteDocument(await revise(page, profile.id, 'regenerate'), second.aspects, authored);
      const afterFeedback = await revise(page, profile.id, 'feedback');
      expectCompleteDocument(afterFeedback, second.aspects, authored);

      // Direct edit (FR-020): a new manual_edit version; adjust is refused for documents.
      const edited = await api.post<{ version: { id: string; versionNumber: number; origin: string } }>(
        page,
        `/api/profiles/${profile.id}/document`,
        {
          baseVersionId: afterFeedback.id,
          summary: 'Edited by hand in the e2e suite.',
          sections: afterFeedback.body.sections.map((s) => ({ heading: s.heading, markdown: s.markdown })),
          doList: afterFeedback.body.doList,
          dontList: afterFeedback.body.dontList,
          keepExcerpts: [0, 1, 2],
        },
      );
      expect(edited.version).toMatchObject({ origin: 'manual_edit', versionNumber: 4 });
      await expect(
        api.post(page, `/api/profiles/${profile.id}/document`, {
          baseVersionId: afterFeedback.id,
          summary: 'stale',
          sections: [{ heading: 'H', markdown: 'm' }],
          doList: ['a'],
          dontList: ['b'],
          keepExcerpts: [0],
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        api.post(page, `/api/profiles/${profile.id}/adjust`, { dimensions: { formality: 4 }, note: 'x' }),
      ).rejects.toMatchObject({ code: 'conflict' });
      const versions = await listVersions(page, profile.id);
      expect(versions.map((x) => x.origin)).toEqual(['manual_edit', 'feedback', 'regenerated', 'generated']);
      expect((await getVersion(page, profile.id, edited.version.id)).body.summary).toBe('Edited by hand in the e2e suite.');
      for (const { id } of versions) {
        expect(JSON.stringify(await getVersion(page, profile.id, id))).not.toContain(RECEIVED_MARKER);
      }

      // Rating (SC-007 mechanism): saved on the version, visible to admins as counts only.
      const before = await api.get<RatingsMetrics>(admin, '/api/admin/metrics/ratings');
      const ratedId = versions[0]!.id;
      const rated = await api.put<{ profileVersion: { id: string; rating: string } }>(
        page,
        `/api/profiles/${profile.id}/versions/${ratedId}/rating`,
        { rating: 'sounds_like_me' },
      );
      expect(rated.profileVersion).toMatchObject({ id: ratedId, rating: 'sounds_like_me' });
      expect((await getVersion(page, profile.id, ratedId)).rating).toBe('sounds_like_me');
      const after = await api.get<RatingsMetrics>(admin, '/api/admin/metrics/ratings');
      expect(after.profiles.rated).toBe(before.profiles.rated + 1);
      expect(after.profiles.soundsLikeMe).toBe(before.profiles.soundsLikeMe + 1);
      expect(after.profiles.share).toBeGreaterThan(0);
      expect(Object.keys(after).sort()).toEqual(['drafts', 'profiles']);
      const serialized = JSON.stringify(after);
      for (const id of [userId, profile.id, ratedId]) expect(serialized).not.toContain(id);
      expect(serialized).not.toContain(RECEIVED_MARKER);
    } finally {
      // Leave one available definition behind for the later specs (onboarding auto-choice).
      await retire(admin, second.id);
      await admin.context().close();
    }
  });

  test('the profile page shows the document; feedback and the edit page add versions and earlier ones stay viewable @ui', async ({
    page,
    browser,
  }) => {
    test.setTimeout(420_000);
    const admin = await adminPage(browser);
    const def = await createAvailableDefinition(admin);
    try {
      await signInConfirmed(page);
      const { profileId, versionId } = await profileOn(page, def.id);

      await page.goto(`/profiles/${profileId}`);
      for (const aspect of def.aspects) await expect(page.getByRole('heading', { name: aspect, exact: true })).toBeVisible();
      await expect(page.getByText('Fake document summary.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Do', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: "Don't", exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Excerpts' })).toBeVisible();
      expect(await page.getByRole('figure').count()).toBeGreaterThanOrEqual(3);
      // Every excerpt carries its source line: kind link, date, labels.
      expect(await page.getByRole('link', { name: 'Note', exact: true }).count()).toBeGreaterThanOrEqual(3);
      await expect(page.getByText(/Prompt used: default v\d+/)).toBeVisible();

      // Feedback -> version 2.
      await page.getByLabel('Tell us what to change').fill('Please make it warmer and shorter.');
      await page.getByRole('button', { name: 'Regenerate with feedback' }).click();
      const withFeedback = await poll(() => listVersions(page, profileId), (v) => v.length === 2, { timeoutMs: 150_000, intervalMs: 1_000 });
      expect(withFeedback[0]!.origin).toBe('feedback');

      // Direct edit -> version 3 (manual_edit).
      await page.goto(`/profiles/${profileId}/edit`);
      await page.getByLabel('Summary').fill('Hand-written summary from the edit page.');
      await page.getByRole('button', { name: 'Save as new version' }).click();
      await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));
      await expect(page.getByText('Hand-written summary from the edit page.')).toBeVisible();
      const versions = await listVersions(page, profileId);
      expect(versions.map((v) => v.origin)).toEqual(['manual_edit', 'feedback', 'generated']);

      // Earlier versions stay viewable with their own text.
      await page.goto(`/profiles/${profileId}?version=${versionId}`);
      await expect(page.getByText('Fake document summary.')).toBeVisible();
      await expect(page.getByText('Hand-written summary from the edit page.')).toHaveCount(0);
    } finally {
      await retire(admin, def.id);
      await admin.context().close();
    }
  });

  test('own analysis prompt: customise, save, compare, reset; a new default notifies the own-prompt user, who sees the diff and switches back @ui', async ({
    page,
    browser,
  }) => {
    test.setTimeout(600_000);
    const admin = await adminPage(browser);
    const def = await createAvailableDefinition(admin);
    const otherCtx = await browser.newContext();
    try {
      await signInConfirmed(page);
      const { profileId } = await profileOn(page, def.id);
      const authored = normalizeWs(LONG_NOTES.join(' '));
      const promptUrl = `/profiles/${profileId}/analysis-prompt`;

      // A second user who chose the voice but never customised it.
      const other = await otherCtx.newPage();
      await signInConfirmed(other, '-other');
      await api.put(other, '/api/definition-choices', { definitionIds: [def.id] });
      await expect(api.get(other, `/api/analysis-prompts/${def.id}/compare`)).rejects.toMatchObject({ code: 'not_found' });
      expect((await api.get<{ own: unknown }>(other, `/api/analysis-prompts/${def.id}`)).own).toBeNull();

      // Customise: the own prompt starts as a copy of the default.
      await page.goto(promptUrl);
      await expect(page.getByText('Default', { exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Customise' }).click();
      const editor = page.getByLabel('Your analysis prompt');
      await expect(editor).toHaveValue(def.prompt, { timeout: 30_000 });

      // Whitespace-only cannot be saved; over the limit is refused with the limit (422).
      await editor.fill('   ');
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      const own = await api.get<{ own: { currentVersion: { id: string } } }>(page, `/api/analysis-prompts/${def.id}`);
      await expect(
        api.put(page, `/api/analysis-prompts/${def.id}`, { promptText: 'x'.repeat(20_001), baseVersionId: own.own.currentVersion.id }),
      ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
      await expect(
        api.put(page, `/api/analysis-prompts/${def.id}`, { promptText: '   ', baseVersionId: own.own.currentVersion.id }),
      ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });

      // Save an edit with a fourth aspect -> own version 2.
      const edited = `${def.prompt}\n- Humour: how playful the writing is.`;
      await editor.fill(edited);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Version 2, based on default v1', { exact: false })).toBeVisible({ timeout: 30_000 });
      const versions = await api.get<{ versionNumber: number; inUseNow: boolean }[]>(page, `/api/analysis-prompts/${def.id}/versions`);
      expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);

      // Compare with the default.
      await page.getByRole('button', { name: 'Compare with default' }).click();
      const diff = page.getByRole('group', { name: 'Differences between your prompt and the default' });
      await expect(diff).toBeVisible();
      await expect(diff.locator('ins')).not.toHaveCount(0);
      await expect(diff).toContainText('Humour');

      // The next generation uses the own prompt: four sections, recorded on the version.
      const own1 = await revise(page, profileId, 'regenerate');
      expectCompleteDocument(own1, [...def.aspects, 'Humour'], authored);
      expect(own1).toMatchObject({ promptSource: 'own', analysisPrompt: { kind: 'own', ownVersion: { versionNumber: 2 } } });

      // Reset: back to the default, the own prompt and its versions are kept.
      await page.getByRole('button', { name: 'Reset to default' }).click();
      await expect(page.getByRole('button', { name: 'Customise' })).toBeVisible({ timeout: 30_000 });
      const reset = await api.get<{ own: { inUse: boolean } | null }>(page, `/api/analysis-prompts/${def.id}`);
      expect(reset.own?.inUse).toBe(false);
      expect(await api.get<unknown[]>(page, `/api/analysis-prompts/${def.id}/versions`)).toHaveLength(2);
      expect(await revise(page, profileId, 'regenerate')).toMatchObject({ promptSource: 'default' });

      // Customise again (a fresh copy of the default, own version 3); the other user stays on the default.
      await page.getByRole('button', { name: 'Customise' }).click();
      await expect(page.getByLabel('Your analysis prompt')).toHaveValue(def.prompt, { timeout: 30_000 });
      const listed = await api.get<{ mode: string }[]>(page, '/api/analysis-prompts');
      expect(listed.map((p) => p.mode)).toEqual(['own']);

      // Admin publishes a new default with a changed prompt.
      const draft = await api.post<{ version: { id: string } }>(admin, `/api/admin/definitions/${def.id}/versions`, {
        fromVersionId: def.versionId,
      });
      await api.patch(admin, `/api/admin/definitions/${def.id}/versions/${draft.version.id}`, {
        analysisPrompt: `${def.prompt}\n- Rhythm: how the sentences are paced.`,
      });
      await api.post(admin, `/api/admin/definitions/${def.id}/versions/${draft.version.id}/publish`);

      type Notification = { id: string; type: string; readAt: string | null; payload: Record<string, string> };
      const own2 = await poll(
        () => api.get<{ items: Notification[] }>(page, '/api/notifications'),
        (r) => r.items.some((n) => n.type === 'analysis_prompt_default_changed'),
        { timeoutMs: 60_000 },
      );
      const note = own2.items.find((n) => n.type === 'analysis_prompt_default_changed')!;
      expect(note.payload).toMatchObject({ definitionId: def.id, toDefinitionVersionId: draft.version.id, fromDefinitionVersionId: def.versionId });
      expect(JSON.stringify(note.payload)).not.toContain('Rhythm');
      // The user without an own prompt is not notified.
      const otherNotes = await api.get<{ items: Notification[] }>(other, '/api/notifications');
      expect(otherNotes.items.filter((n) => n.type === 'analysis_prompt_default_changed')).toEqual([]);

      // Open the notification: the diff between the base default and the new default, one click to switch.
      await page.goto('/notifications');
      await expect(page.getByText('The default analysis prompt for E2E second voice changed.')).toBeVisible();
      await page.getByRole('link', { name: 'Go to source' }).first().click();
      await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/analysis-prompt\\?from=${def.versionId}&to=${draft.version.id}`));
      await expect(page.getByText('What changed in the default (v1 to v2)')).toBeVisible();
      const changes = page.getByRole('group', { name: 'Changes between default versions' });
      await expect(changes.locator('ins')).not.toHaveCount(0);
      await expect(changes).toContainText('Rhythm');
      await page.getByRole('button', { name: 'Use the default' }).click();
      await poll(
        () => api.get<{ own: { inUse: boolean } | null }>(page, `/api/analysis-prompts/${def.id}`),
        (d) => d.own?.inUse === false,
      );

      // The next generation records the new default version.
      const switched = await revise(page, profileId, 'regenerate');
      expect(switched).toMatchObject({ promptSource: 'default', analysisPrompt: { kind: 'default', definitionVersion: { id: draft.version.id, versionNumber: 2 } } });
      expectCompleteDocument(switched, [...def.aspects, 'Rhythm'], authored);
    } finally {
      await retire(admin, def.id);
      await otherCtx.close();
      await admin.context().close();
    }
  });

  test('a legacy structured profile stays viewable, a draft can be written from it, and regenerate gives a document', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await signInAs(page, { email: uniqueEmail('-legacy') });
    const { profileId, versionId } = await createProfileReady(page);
    const first = await getVersion(page, profileId, versionId);
    expect(first.format).toBe('document');

    // Seed an old-format (structured) version on top, as a profile generated before this feature would look.
    const legacyBody = {
      summary: 'Legacy structured summary.',
      languages: [{ code: 'en', share: 1 }],
      dimensions: [{ key: 'formality', value: 2, explanation: 'Mostly casual.', evidenceRefs: ['A1'] }],
      excerpts: first.body.excerpts.map((e) => ({ text: e.text, contentItemId: e.contentItemId, dimensionKeys: ['formality'] })),
      doList: ['Keep it short.'],
      dontList: ['Avoid jargon.'],
    };
    const bodyEnc = await runCore<string>(
      `const { encrypt } = await import('@voicespark/core/crypto');
       return encrypt('user-content', JSON.stringify(args[0]));`,
      [legacyBody],
    );
    const [legacy] = await sql<{ id: string }>(
      `INSERT INTO profile_version
         (profile_id, version_number, origin, definition_version_id, prompt_version_id, body_enc, languages,
          contributing_source_ids, contributing_item_count, format, prompt_source, own_prompt_version_id)
       SELECT $1, coalesce(max(version_number), 0) + 1, 'generated', $2, $3, $4, '{en}', '{}'::uuid[], 1,
              'structured'::profile_version_format, NULL, NULL
       FROM profile_version WHERE profile_id = $1
       RETURNING id`,
      [profileId, first.definitionVersion.id, first.promptVersion!.id, bodyEnc],
    );
    await sql('UPDATE tone_profile SET latest_version_id = $2 WHERE id = $1', [profileId, legacy!.id]);

    const view = await getVersion(page, profileId, legacy!.id);
    expect(view).toMatchObject({ format: 'structured', promptSource: null, analysisPrompt: null });

    // Viewable.
    await page.goto(`/profiles/${profileId}`);
    await expect(page.getByText('Legacy structured summary.')).toBeVisible();

    // A draft can be written from it.
    const draftId = await requestDraft(page, { contentType: 'social_post', profileId, brief: 'Announce the harvest supper' });
    const draft = await waitForDraft(page, draftId, 90_000);
    expect(draft).toMatchObject({ status: 'ready', profileVersionId: legacy!.id });

    // Regenerate gives a document; the legacy version stays viewable.
    const regenerated = await revise(page, profileId, 'regenerate');
    expect(regenerated.format).toBe('document');
    expect(regenerated.versionNumber).toBe(3);
    expect((await getVersion(page, profileId, legacy!.id)).format).toBe('structured');
    await page.goto(`/profiles/${profileId}?version=${legacy!.id}`);
    await expect(page.getByText('Legacy structured summary.')).toBeVisible();
  });
});
