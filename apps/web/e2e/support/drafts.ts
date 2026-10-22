import type { Page } from '@playwright/test';
import { api, confirmFilters, poll } from './api';
import { sql } from './scripts';

// Profile and draft helpers shared by us7-deletion and us8-drafts. The worker runs the deterministic fake generation
// LLM (AUTH_TEST_MODE): profiles come from the `<sample>` blocks, drafts echo the inspected brief.

const MIN_WORDS_KEY = 'profile.min_authored_words';
/** Low enough for one note; `restoreProfileThreshold` puts the previous value back. */
export const E2E_MIN_AUTHORED_WORDS = 50;

export const DRAFT_CONTENT_TYPES = ['social_post', 'bio', 'short_article'] as const;
export type DraftContentType = (typeof DRAFT_CONTENT_TYPES)[number];

export interface ProfileListItem {
  id: string;
  definition: { id: string; name: string; retired: boolean };
  status: string;
  latestVersion: { id: string; versionNumber: number; createdAt: string } | null;
  outdatedReason: string | null;
  canRegenerate: boolean;
  activeGeneration: unknown;
}

export interface DraftView {
  id: string;
  contentType: DraftContentType;
  status: 'queued' | 'generating' | 'ready' | 'failed';
  rating: string | null;
  title: string | null;
  text: string | null;
  generatedText: string | null;
  editedText: string | null;
  feedback: string | null;
  redactionsApplied: number;
  errorCode: string | null;
  profileVersionId: string;
  promptVersionId: string;
  parentDraftId: string | null;
}

/** Plain first-person prose: accepted by every filter category, so it is stored as authored content. */
export const AUTHORED_NOTE = [
  'I like to start every project with a short walk and a notebook, writing down what I want the work to feel like.',
  'Most weeks I spend the mornings sketching ideas for our garden club newsletter and the afternoons testing recipes.',
  'When I write, I keep sentences short and friendly, and I try to end with a small question for the reader.',
  'Last spring we planted tomatoes, basil and a row of sunflowers that grew taller than the fence by July.',
  'I would rather explain one idea clearly than list ten of them, so I usually cut my first draft in half.',
].join(' ');

let savedMinWords: unknown;
let thresholdLowered = false;

/** Lowers `profile.min_authored_words` (global app setting, uncached) so one note makes a user eligible. */
export async function lowerProfileThreshold(words = E2E_MIN_AUTHORED_WORDS): Promise<void> {
  if (!thresholdLowered) {
    const [row] = await sql<{ value: unknown }>('SELECT value FROM app_setting WHERE key = $1', [
      MIN_WORDS_KEY,
    ]);
    savedMinWords = row?.value;
    thresholdLowered = true;
  }
  await sql(
    `INSERT INTO app_setting (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [MIN_WORDS_KEY, JSON.stringify(words)],
  );
}

/** Puts back the value `lowerProfileThreshold` replaced (deletes the row when there was none: default applies). */
export async function restoreProfileThreshold(): Promise<void> {
  if (!thresholdLowered) return;
  if (savedMinWords === undefined) {
    await sql('DELETE FROM app_setting WHERE key = $1', [MIN_WORDS_KEY]);
  } else {
    await sql('UPDATE app_setting SET value = $2::jsonb, updated_at = now() WHERE key = $1', [
      MIN_WORDS_KEY,
      JSON.stringify(savedMinWords),
    ]);
  }
  thresholdLowered = false;
  savedMinWords = undefined;
}

/** POST /api/notes and wait until the upload is `stored`. */
export async function addAuthoredNote(page: Page, text = AUTHORED_NOTE): Promise<string> {
  const { uploadId } = await api.post<{ uploadId: string }>(page, '/api/notes', {
    text,
    authorship: 'authored',
  });
  const upload = await poll(
    () =>
      api.get<{ status: string; rejectReason: string | null }>(page, `/api/uploads/${uploadId}`),
    (u) => u.status !== 'received' && u.status !== 'processing',
  );
  if (upload.status !== 'stored') {
    throw new Error(`note upload ended ${upload.status} (${upload.rejectReason ?? 'no reason'})`);
  }
  return uploadId;
}

export async function listProfiles(page: Page): Promise<ProfileListItem[]> {
  return api.get<ProfileListItem[]>(page, '/api/profiles');
}

/**
 * Makes the signed-in user's first profile ready: confirms filters, lowers the word threshold, stores one authored
 * note, then waits for the first-eligible auto generation (or requests one) until the profile has a version.
 */
export async function createProfileReady(
  page: Page,
  opts: { note?: string; timeoutMs?: number } = {},
): Promise<{ profileId: string; versionId: string }> {
  await confirmFilters(page);
  await lowerProfileThreshold();
  await addAuthoredNote(page, opts.note);

  let list = await listProfiles(page);
  if (list.length === 0) {
    // No auto-chosen definition (several available): choose the first one explicitly.
    const defs = await api.get<{ id: string; chosen: boolean }[]>(page, '/api/definitions');
    if (defs.length === 0) throw new Error('no available definition');
    await api.put(page, '/api/definition-choices', { definitionIds: [defs[0]!.id] });
    list = await listProfiles(page);
  }
  if (!list.some((p) => p.latestVersion !== null || p.activeGeneration)) {
    await api.post(page, '/api/profiles/generate', {});
  }

  const ready = await poll(
    () => listProfiles(page),
    (profiles) => profiles.some((p) => p.latestVersion !== null),
    { timeoutMs: opts.timeoutMs ?? 90_000 },
  );
  const profile = ready.find((p) => p.latestVersion !== null)!;
  return { profileId: profile.id, versionId: profile.latestVersion!.id };
}

export async function getDraft(page: Page, draftId: string): Promise<DraftView> {
  return api.get<DraftView>(page, `/api/drafts/${draftId}`);
}

/** Polls the draft until it leaves queued/generating; returns the final view (ready or failed). */
export async function waitForDraft(
  page: Page,
  draftId: string,
  timeoutMs = 60_000,
): Promise<DraftView> {
  return poll(
    () => getDraft(page, draftId),
    (d) => d.status === 'ready' || d.status === 'failed',
    { timeoutMs },
  );
}

export async function requestDraft(
  page: Page,
  input: { contentType: DraftContentType; profileId: string; brief: string },
): Promise<string> {
  const { draftId } = await api.post<{ draftId: string }>(page, '/api/drafts', input);
  return draftId;
}
