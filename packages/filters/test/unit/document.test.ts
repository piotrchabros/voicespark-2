import { describe, expect, it } from 'vitest';
import { FILTER_CATEGORY_KEYS, type DocumentHeader, type InspectionInput, type Policy } from '../../src/categories';
import { buildDocument } from '../../src/document';
import { inspect } from '../../src/pipeline';
import { createRecordedClassifier } from '../../src/classifier/recorded';

const PASSWORD = 'Hunter2xyz!';
const ALL: Policy = { selectedCategories: FILTER_CATEGORY_KEYS, rules: [] };
const NONE: Policy = { selectedCategories: [], rules: [] };
const deps = { classifier: createRecordedClassifier() };

function input(over: Partial<InspectionInput> = {}): InspectionInput {
  return {
    kind: 'email',
    subject: 'Project update',
    bodyText: 'The project is on track.',
    headers: { from: 'Anna Kowalska <anna@friends.test>' },
    folders: [],
    ownAddresses: ['me@voicespark.test'],
    ...over,
  };
}

function headerFrom(r: Awaited<ReturnType<typeof inspect>>, over: Partial<DocumentHeader> = {}): DocumentHeader {
  return {
    kind: 'email',
    date: '2025-03-14T09:30:00Z',
    direction: 'received',
    subject: r.fields?.subject,
    fromName: r.fields?.fromName,
    fromAddress: r.fields?.fromAddress,
    ...over,
  };
}

describe('buildDocument', () => {
  it('throws on an excluded result', async () => {
    const r = await inspect(input(), { selectedCategories: [], rules: [{ type: 'keyword', value: 'project' }] }, deps);
    expect(r.outcome).toBe('excluded');
    expect(() => buildDocument(r, { kind: 'email', date: '2025-03-14' })).toThrow(
      'buildDocument requires an accepted InspectionResult',
    );
  });

  it('renders an email document', async () => {
    const r = await inspect(input(), NONE, deps);
    expect(buildDocument(r, headerFrom(r))).toBe(
      'Subject: Project update\nDate: 2025-03-14T09:30:00Z\nDirection: received\nFrom: Anna Kowalska <anna@friends.test>\n\nThe project is on track.',
    );
  });

  it('renders an attachment like an email', async () => {
    const r = await inspect(input({ kind: 'attachment' }), NONE, deps);
    const doc = buildDocument(r, headerFrom(r, { kind: 'attachment', direction: 'sent' }));
    expect(doc.startsWith('Subject: Project update\nDate: ')).toBe(true);
    expect(doc).toContain('\nDirection: sent\n');
  });

  it('renders From with the display name alone when fromAddress is absent', async () => {
    const r = await inspect(input(), { selectedCategories: ['third_party_contacts'], rules: [] }, deps);
    const doc = buildDocument(r, headerFrom(r));
    expect(doc).toContain('\nFrom: Anna Kowalska\n');
    expect(doc).not.toContain('anna@friends.test');
    expect(doc).not.toContain('<');
  });

  it('renders From with the address alone when there is no name', async () => {
    const r = await inspect(input({ headers: { from: 'anna@friends.test' } }), NONE, deps);
    expect(buildDocument(r, headerFrom(r))).toContain('\nFrom: anna@friends.test\n');
  });

  it('omits lines whose value is undefined', async () => {
    const r = await inspect(input(), NONE, deps);
    const doc = buildDocument(r, { kind: 'email', date: '2025-03-14', subject: r.fields?.subject });
    expect(doc).not.toContain('Direction:');
    expect(doc).not.toContain('From:');
    expect(doc).toBe('Subject: Project update\nDate: 2025-03-14\n\nThe project is on track.');
  });

  it('renders a file document with the filename as Title', async () => {
    const r = await inspect(
      input({ kind: 'file', subject: undefined, filename: 'notes.txt', headers: {}, bodyText: 'File body.' }),
      NONE,
      deps,
    );
    expect(buildDocument(r, { kind: 'file', date: '2025-03-14', filename: r.fields?.filename })).toBe(
      'Title: notes.txt\n\nFile body.',
    );
  });

  it('renders a note document with the title as Title', async () => {
    const r = await inspect(
      input({ kind: 'note', subject: undefined, title: 'Ideas', headers: {}, bodyText: 'Note body.' }),
      NONE,
      deps,
    );
    expect(buildDocument(r, { kind: 'note', date: '2025-03-14', title: r.fields?.title })).toBe(
      'Title: Ideas\n\nNote body.',
    );
  });

  it('never contains a locked-category value from any header field', async () => {
    const r = await inspect(
      input({
        subject: `password: ${PASSWORD}`,
        headers: { from: `"password: ${PASSWORD}" <anna@friends.test>` },
      }),
      ALL,
      deps,
    );
    expect(r.outcome).toBe('accepted');
    const doc = buildDocument(r, headerFrom(r));
    expect(doc).not.toContain(PASSWORD);
    expect(doc).toContain('[excluded:');
  });

  it('never contains a locked value from file name or note title', async () => {
    const file = await inspect(
      input({ kind: 'file', subject: undefined, filename: `password: ${PASSWORD}.txt`, headers: {} }),
      ALL,
      deps,
    );
    const note = await inspect(
      input({ kind: 'note', subject: undefined, title: `password: ${PASSWORD}`, headers: {} }),
      ALL,
      deps,
    );
    expect(buildDocument(file, { kind: 'file', date: '2025-03-14', filename: file.fields?.filename })).not.toContain(PASSWORD);
    expect(buildDocument(note, { kind: 'note', date: '2025-03-14', title: note.fields?.title })).not.toContain(PASSWORD);
  });
});
