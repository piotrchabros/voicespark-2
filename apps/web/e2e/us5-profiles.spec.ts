import type { Browser, Page } from '@playwright/test';
import { expect, signInAs, test } from './fixtures/auth';
import { api, confirmFilters, poll, setAdminSetting } from './support/api';
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

interface ProfileVersionView {
  id: string;
  versionNumber: number;
  origin: string;
  definitionVersion: { id: string; versionNumber: number };
  promptVersion: { id: string; versionNumber: number } | null;
  body: {
    summary: string;
    languages: { code: string; share: number }[];
    dimensions: { key: string; value: unknown; explanation: string }[];
    excerpts: { text: string; contentItemId?: string }[];
  };
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

/** Creates, publishes and makes available a second definition; returns its id and dimension keys. */
async function createAvailableDefinition(admin: Page): Promise<{ id: string; dimensionKeys: string[] }> {
  const dimensions = [
    {
      key: 'directness',
      name: 'Directness',
      description: 'How directly the writer gets to the point.',
      valueType: 'scale',
      scale: { min: 1, max: 5, minLabel: 'roundabout', maxLabel: 'blunt' },
    },
    {
      key: 'pacing',
      name: 'Pacing',
      description: 'The rhythm of the writing.',
      valueType: 'enum',
      allowedValues: ['slow', 'steady', 'brisk'],
    },
    { key: 'motifs', name: 'Motifs', description: 'Recurring images.', valueType: 'list' },
  ];
  const created = await api.post<{ definition: AdminDefinition; draft: { id: string } }>(
    admin,
    '/api/admin/definitions',
    {
      key: `e2e_voice_${Date.now().toString(36)}`,
      name: 'E2E second voice',
      description: 'A second definition created by the US5 e2e spec.',
      dimensions,
    },
  );
  const id = created.definition.id;
  await api.post(admin, `/api/admin/definitions/${id}/versions/${created.draft.id}/publish`);
  await api.put(admin, `/api/admin/definitions/${id}/availability`, { availability: 'available' });
  return { id, dimensionKeys: dimensions.map((d) => d.key) };
}

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

  test('two available definitions give two complete profiles; regenerate, feedback and adjust add versions; ratings reach admin aggregates only', async ({
    page,
    browser,
  }) => {
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
        const expectedKeys =
          profile.definition.id === second.id
            ? second.dimensionKeys
            : ['formality', 'warmth', 'sentence_length', 'vocabulary', 'humour', 'signature_phrases'];
        expect(v.body.dimensions.map((d) => d.key).sort()).toEqual([...expectedKeys].sort());
        expect(v.body.excerpts.length).toBeGreaterThanOrEqual(3);
        for (const excerpt of v.body.excerpts) expect(authored).toContain(normalizeWs(excerpt.text));
        expect(v.languages).toEqual(['en']);
        expect(v.body.languages.map((l) => l.code)).toEqual(['en']);
        expect(v.definitionVersion.id).toMatch(UUID_RE);
        expect(v.promptVersion?.id).toMatch(UUID_RE);
        expect(JSON.stringify(v)).not.toContain(RECEIVED_MARKER);
      }

      // Each revision path adds a version; received mail stays background context and is never quoted.
      const profile = profiles.find((p) => p.definition.id === general.id)!;
      const { generationId: regen } = await api.post<{ generationId: string }>(page, `/api/profiles/${profile.id}/regenerate`);
      await expectSucceeded(page, regen);
      const { generationId: fb } = await api.post<{ generationId: string }>(page, `/api/profiles/${profile.id}/feedback`, {
        feedback: 'Please make it warmer and shorter.',
      });
      await expectSucceeded(page, fb);
      const adjusted = await api.post<{ version: ProfileVersionView }>(page, `/api/profiles/${profile.id}/adjust`, {
        dimensions: { formality: 4, humour: 'light' },
        note: 'Manual tweak from the e2e suite.',
      });
      expect(adjusted.version).toMatchObject({ origin: 'manual_edit', versionNumber: 4 });
      expect(adjusted.version.body.dimensions.find((d) => d.key === 'formality')?.value).toBe(4);
      const versions = await listVersions(page, profile.id);
      expect(versions).toHaveLength(4);
      expect(versions.map((x) => x.origin)).toEqual(['manual_edit', 'feedback', 'regenerated', 'generated']);
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
      await api.put(admin, `/api/admin/definitions/${second.id}/availability`, { availability: 'retired' }).catch(() => undefined);
      await admin.context().close();
    }
  });
});
