import { basename, extname } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { namespaceFor } from '@voicespark/integrations/supermemory';
import {
  makeDocx,
  makeEncryptedPdf,
  makePdf,
  makeScannedPdf,
} from '../../../packages/integrations/test/helpers/fixtures';
import { expect, test } from './fixtures/auth';
import { api, confirmFilters, poll } from './support/api';
import { expectNamespaceEmpty, memory, scanNamespace } from './support/memory';

// US4 (quickstart section 6): uploads and notes through the real worker and the shared memory bridge (D-E1).

interface UploadView {
  id: string;
  kind: 'file' | 'note';
  filename: string | null;
  status: 'received' | 'processing' | 'stored' | 'rejected' | 'failed';
  rejectReason: string | null;
  importJobId: string | null;
  contentItemId: string | null;
}

interface ExclusionSummary {
  importJobId: string;
  categories: { key: string; label: string; excludedItems: number; redactedValues: number }[];
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

const PROSE = {
  pdf: 'Notes from a slow morning walk along the river, where the light kept changing and the herons stood still.',
  docx: 'A few thoughts on how we plan the garden beds this year, rotating the beans and giving the soil a rest.',
  txt: 'Draft of the talk opening: start with the story about the lighthouse keeper and his logbook of storms.',
  md: '# Weekly reflection\n\nThe best conversations this week happened while walking, not in meeting rooms.',
  note: 'Remember to write about the valley orchard and the way the mist lifts late in October mornings.',
};

/** Same shape as the worker upload suite: a deterministic-detector hit, redacted as a span (D-U4). */
const API_KEY = 'sk_live_dWh1HADnEIwLi2jv8DTmESwq';

function uniqueEmail(): string {
  return `e2e-${test.info().testId}-${Date.now()}@example.test`;
}

/** Fixture builders write real files to the test's output dir; the upload sends the bytes read back from disk. */
function writeFixture(name: string, data: Buffer | string): string {
  const path = test.info().outputPath(name);
  writeFileSync(path, data);
  return path;
}

async function uploadFile(page: Page, path: string): Promise<string> {
  const name = basename(path);
  const res = await page.request.post('/api/uploads', {
    multipart: { file: { name, mimeType: MIME[extname(name)] ?? 'application/octet-stream', buffer: readFileSync(path) } },
  });
  expect(res.status(), `POST /api/uploads ${name}`).toBe(202);
  return ((await res.json()) as { uploadId: string }).uploadId;
}

async function uploadNote(page: Page, text: string): Promise<string> {
  return (await api.post<{ uploadId: string }>(page, '/api/notes', { text })).uploadId;
}

/** The worker's terminal outcome for the upload. */
async function waitForUpload(page: Page, uploadId: string): Promise<UploadView> {
  return poll(
    () => api.get<UploadView>(page, `/api/uploads/${uploadId}`),
    (u) => u.status !== 'received' && u.status !== 'processing',
    { timeoutMs: 90_000 },
  );
}

async function signInConfirmed(page: Page, signInAs: (o: { email: string }) => Promise<{ userId: string }>) {
  const { userId } = await signInAs({ email: uniqueEmail() });
  await confirmFilters(page);
  return userId;
}

test.describe('US4 uploads and notes', () => {
  test('pdf, docx, txt and md files plus a note reach stored with a document in the namespace', async ({
    page,
    signInAs,
  }) => {
    const userId = await signInConfirmed(page, signInAs);
    const files = [
      writeFixture('river.pdf', makePdf(PROSE.pdf)),
      writeFixture('garden.docx', makeDocx([PROSE.docx])),
      writeFixture('talk.txt', PROSE.txt),
      writeFixture('reflection.md', PROSE.md),
    ];
    const ids = [];
    for (const path of files) ids.push(await uploadFile(page, path));
    ids.push(await uploadNote(page, PROSE.note));

    const ns = namespaceFor(userId);
    for (const id of ids) {
      const upload = await waitForUpload(page, id);
      expect(upload, upload.filename ?? 'note').toMatchObject({ status: 'stored', rejectReason: null });
      expect(upload.contentItemId).toEqual(expect.any(String));
      const doc = await memory().getDocument(ns, upload.contentItemId!);
      expect(doc, `document for ${upload.filename ?? 'note'}`).not.toBeNull();
    }
    const list = await api.get<{ items: UploadView[] }>(page, '/api/uploads');
    expect(list.items.map((u) => u.id).sort()).toEqual([...ids].sort());
    expect(list.items.map((u) => u.kind).sort()).toEqual(['file', 'file', 'file', 'file', 'note']);
  });

  test('a scanned pdf is rejected with no_text and an encrypted pdf with encrypted', async ({ page, signInAs }) => {
    const userId = await signInConfirmed(page, signInAs);
    const scanned = await uploadFile(page, writeFixture('scan.pdf', makeScannedPdf()));
    const locked = await uploadFile(page, writeFixture('locked.pdf', makeEncryptedPdf()));

    expect(await waitForUpload(page, scanned)).toMatchObject({
      status: 'rejected',
      rejectReason: 'no_text',
      contentItemId: null,
    });
    expect(await waitForUpload(page, locked)).toMatchObject({
      status: 'rejected',
      rejectReason: 'encrypted',
      contentItemId: null,
    });
    await expectNamespaceEmpty(userId);
    const items = await api.get<{ items: unknown[] }>(page, '/api/content-items');
    expect(items.items).toEqual([]);
  });

  test('a txt file holding an API key is stored with the key redacted and counted under api_keys_tokens', async ({
    page,
    signInAs,
  }) => {
    // D-U4: a credential inside otherwise acceptable prose is redacted as a span, not rejected as a whole; the
    // exclusion summary of the upload's import job names the category with the redaction count only.
    const userId = await signInConfirmed(page, signInAs);
    const text = `Deploy notes for the team.\napi_key=${API_KEY}\n${PROSE.txt}`;
    const uploadId = await uploadFile(page, writeFixture('deploy.txt', text));

    const upload = await waitForUpload(page, uploadId);
    expect(upload).toMatchObject({ status: 'stored', rejectReason: null });

    const doc = await memory().getDocument(namespaceFor(userId), upload.contentItemId!);
    expect(doc).not.toBeNull();
    expect(doc!.content).not.toContain(API_KEY);
    expect(JSON.stringify(doc!.metadata)).not.toContain(API_KEY);
    expect(doc!.content).toContain('lighthouse keeper');

    const summary = await api.get<ExclusionSummary>(page, `/api/imports/${upload.importJobId}/exclusion-summary`);
    const category = summary.categories.find((c) => c.key === 'api_keys_tokens');
    expect(category, JSON.stringify(summary)).toBeDefined();
    expect(category!.redactedValues).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(summary)).not.toContain(API_KEY);

    const items = await api.get<{ items: { id: string; snippet?: string; title?: string }[] }>(
      page,
      '/api/content-items',
    );
    expect(items.items.map((i) => i.id)).toEqual([upload.contentItemId]);
    expect(JSON.stringify(items)).not.toContain(API_KEY);
  });

  test('deleting an upload removes its document from the namespace', async ({ page, signInAs }) => {
    const userId = await signInConfirmed(page, signInAs);
    const uploadId = await uploadNote(page, PROSE.note);
    const upload = await waitForUpload(page, uploadId);
    expect(upload.status).toBe('stored');
    const ns = namespaceFor(userId);
    expect(await memory().getDocument(ns, upload.contentItemId!)).not.toBeNull();

    const { deletionRequestId } = await api.delete<{ deletionRequestId: string }>(page, `/api/uploads/${uploadId}`);
    expect(deletionRequestId).toEqual(expect.any(String));
    const request = await poll(
      () => api.get<{ status: string; scope: string }>(page, `/api/deletions/${deletionRequestId}`),
      (r) => r.status === 'completed' || r.status === 'failed',
      { timeoutMs: 120_000 },
    );
    expect(request).toMatchObject({ scope: 'content_item', status: 'completed' });

    expect(await memory().getDocument(ns, upload.contentItemId!)).toBeNull();
    expect(await scanNamespace(userId)).toEqual([]);
    await expect(api.get(page, `/api/uploads/${uploadId}`)).rejects.toMatchObject({ status: 404 });
    const items = await api.get<{ items: unknown[] }>(page, '/api/content-items');
    expect(items.items).toEqual([]);
  });
});
