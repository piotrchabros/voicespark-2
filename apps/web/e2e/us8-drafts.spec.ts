import { randomUUID } from 'node:crypto';
import { signInAs, test, expect } from './fixtures/auth';
import { api } from './support/api';
import {
  createProfileReady,
  DRAFT_CONTENT_TYPES,
  getDraft,
  requestDraft,
  restoreProfileThreshold,
  waitForDraft,
} from './support/drafts';
import { E2E_BASE_URL } from './support/env';
import { measure } from './support/timing';

// US8 / T162: drafts in the user's voice (FR-049..056, SC-012, SC-013). The worker runs the fake generation LLM,
// which echoes the inspected brief, so redaction is visible in the stored body.

const BRIEF = 'Announce our spring garden club meetup and invite new members to bring a friend';
/** Synthetic GitHub-style token: a locked credential category, redacted wherever it appears. */
const API_KEY = 'ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
/** Credential delivery only: the whole brief is excluded (`brief_excluded`) before any model call. */
const PASSWORD_RESET_BRIEF =
  'Reset your password here: https://app.service.test/reset/password?token=aB3dE9fG7hJ2kL5mN8pQ and enter verification code 482913.';

interface RatingCounts {
  rated: number;
  soundsLikeMe: number;
  share: number | null;
}
interface RatingsMetrics {
  profiles: RatingCounts;
  drafts: RatingCounts & { byContentType: Record<string, RatingCounts> };
}

const mailOf = (prefix: string) => `${prefix}-${randomUUID()}@e2e.test`;

test.afterAll(async () => {
  await restoreProfileThreshold();
});

test('one draft of each type is ready under 60 s (SC-012); edit, regenerate, rate, export', async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const { userId } = await signInAs(page, { email: mailOf('us8-drafts') });
  const { profileId, versionId } = await createProfileReady(page);

  const ready: Record<string, string> = {};
  for (const contentType of DRAFT_CONTENT_TYPES) {
    const draft = await measure(`draft ready (${contentType})`, 'SC-012', 60_000, async () => {
      const id = await requestDraft(page, { contentType, profileId, brief: BRIEF });
      return waitForDraft(page, id, 60_000);
    });
    expect(draft, `${contentType} draft`).toMatchObject({
      status: 'ready',
      contentType,
      profileVersionId: versionId,
    });
    // The fake echoes the `Brief: ` prompt line; the short-article template labels it `Topic/brief: ` instead.
    if (contentType === 'short_article') expect(draft.generatedText).toBeTruthy();
    else expect(draft.generatedText).toContain(BRIEF);
    ready[contentType] = draft.id;
  }

  // Edit keeps the generated text (history retained).
  const postId = ready.social_post!;
  const original = await getDraft(page, postId);
  const editedText = `${original.generatedText} (edited by hand)`;
  const { draft: edited } = await api.patch<{
    draft: { editedText: string; generatedText: string; text: string };
  }>(page, `/api/drafts/${postId}`, { editedText });
  expect(edited).toMatchObject({
    editedText,
    generatedText: original.generatedText,
    text: editedText,
  });

  // Regenerate with feedback: a new row pointing at its parent; the parent is unchanged.
  const { draftId: childId } = await api.post<{ draftId: string }>(
    page,
    `/api/drafts/${postId}/regenerate`,
    {
      feedback: 'Make it a little warmer',
    },
  );
  expect(childId).not.toBe(postId);
  const child = await waitForDraft(page, childId);
  expect(child).toMatchObject({
    status: 'ready',
    parentDraftId: postId,
    feedback: 'Make it a little warmer',
  });
  const parentAfter = await getDraft(page, postId);
  expect(parentAfter).toMatchObject({
    status: 'ready',
    generatedText: original.generatedText,
    editedText,
    parentDraftId: null,
  });

  // Rating feeds the admin aggregates (SC-013): counts only, no ids.
  const adminContext = await browser.newContext({ baseURL: E2E_BASE_URL });
  try {
    const admin = await adminContext.newPage();
    await signInAs(admin, { email: mailOf('us8-admin'), role: 'admin' });
    const metrics = () => api.get<RatingsMetrics>(admin, '/api/admin/metrics/ratings');
    const before = await metrics();

    const { draft: rated } = await api.put<{ draft: { rating: string } }>(
      page,
      `/api/drafts/${postId}/rating`,
      {
        rating: 'sounds_like_me',
      },
    );
    expect(rated.rating).toBe('sounds_like_me');

    const after = await metrics();
    expect(after.drafts.rated).toBe(before.drafts.rated + 1);
    expect(after.drafts.soundsLikeMe).toBe(before.drafts.soundsLikeMe + 1);
    expect(after.drafts.byContentType.social_post!.rated).toBe(
      before.drafts.byContentType.social_post!.rated + 1,
    );
    expect(after.drafts.byContentType.social_post!.soundsLikeMe).toBe(
      before.drafts.byContentType.social_post!.soundsLikeMe + 1,
    );
    expect(Object.keys(after).sort()).toEqual(['drafts', 'profiles']);
    const raw = JSON.stringify(after);
    for (const id of [userId, postId, childId, profileId, versionId]) expect(raw).not.toContain(id);
    expect(raw).not.toContain(BRIEF);
  } finally {
    await adminContext.close();
  }

  // Export: md and txt downloads of the current text (edited ?? generated).
  const md = await page.request.get(`/api/drafts/${postId}/export?format=md`);
  expect(md.status()).toBe(200);
  expect(md.headers()['content-type']).toContain('text/markdown');
  expect(md.headers()['content-disposition']).toMatch(
    /^attachment; filename="draft-.*-social_post\.md"$/,
  );
  expect(await md.text()).toContain(editedText);

  const articleId = ready.short_article!;
  const article = await getDraft(page, articleId);
  const txt = await page.request.get(`/api/drafts/${articleId}/export?format=txt`);
  expect(txt.status()).toBe(200);
  expect(txt.headers()['content-type']).toContain('text/plain');
  expect(txt.headers()['content-disposition']).toMatch(
    /^attachment; filename="draft-.*-short_article\.txt"$/,
  );
  const txtBody = await txt.text();
  expect(txtBody).toContain(article.generatedText!);
  if (article.title) {
    expect(txtBody.startsWith(`${article.title}\n\n`)).toBe(true);
    const articleMd = await page.request.get(`/api/drafts/${articleId}/export?format=md`);
    expect((await articleMd.text()).startsWith(`# ${article.title}\n\n`)).toBe(true);
  }
});

test('a brief with an API key comes back redacted; a password-reset brief fails brief_excluded', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInAs(page, { email: mailOf('us8-redact') });
  const { profileId } = await createProfileReady(page);

  const redactedId = await requestDraft(page, {
    contentType: 'social_post',
    profileId,
    brief: `${BRIEF}, our token is api_key = ${API_KEY}`,
  });
  const redacted = await waitForDraft(page, redactedId);
  expect(redacted.status).toBe('ready');
  expect(redacted.text).toContain('[excluded:');
  expect(redacted.text).not.toContain(API_KEY);
  expect(redacted.generatedText).not.toContain(API_KEY);
  expect(redacted.redactionsApplied).toBeGreaterThanOrEqual(1);

  const excludedId = await requestDraft(page, {
    contentType: 'bio',
    profileId,
    brief: PASSWORD_RESET_BRIEF,
  });
  const excluded = await waitForDraft(page, excludedId);
  expect(excluded).toMatchObject({
    status: 'failed',
    errorCode: 'brief_excluded',
    generatedText: null,
  });
});

test('the draft page offers copy and export but no publish, post or share control @ui', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInAs(page, { email: mailOf('us8-ui') });
  const { profileId } = await createProfileReady(page);
  const draftId = await requestDraft(page, { contentType: 'social_post', profileId, brief: BRIEF });
  await waitForDraft(page, draftId);

  await page.goto(`/drafts/${draftId}`);
  await expect(page.getByTestId('draft-body')).toContainText(BRIEF);
  await expect(page.getByTestId('export-md')).toBeVisible();
  await expect(page.getByTestId('export-txt')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(page.getByRole('button', { name: /publish|post to|share to/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /publish|post to|share to/i })).toHaveCount(0);
});

test('a user without a profile sees the "Generate a profile first" empty state @ui', async ({
  page,
}) => {
  await signInAs(page, { email: mailOf('us8-empty') });
  await page.goto('/drafts');
  await expect(page.getByText('Generate a profile first')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to profiles' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New draft' })).toHaveCount(0);
});
