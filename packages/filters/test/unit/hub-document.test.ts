import { describe, expect, it } from 'vitest';
import { FILTER_CATEGORY_KEYS, type ContactValue, type FilteredText, type Policy } from '../../src/categories';
import { buildHubDocument } from '../../src/hub';

// Tests mint brands by cast; production code can only mint them inside the filters package.
const ft = (s: string) => s as FilteredText;
const cv = (s: string) => s as ContactValue;

const WITH_CONTACTS: Policy = { selectedCategories: FILTER_CATEGORY_KEYS.filter((c) => c !== 'third_party_contacts'), rules: [] };
const NO_CONTACTS: Policy = { selectedCategories: FILTER_CATEGORY_KEYS, rules: [] };

const person = (policy: Policy) =>
  buildHubDocument('person', {
    policy,
    name: ft('Jan Kowalski'),
    roleTitle: ft('Sales manager'),
    emails: [cv('jan@acme.example'), cv('j.kowalski@acme.example')],
    phones: [cv('+48 601 234 567')],
    companies: [{ name: ft('Acme'), role: ft('employee') }],
    projects: [{ name: ft('Apollo'), role: ft('lead') }],
    description: ft('Met at the fair.'),
  });

describe('buildHubDocument: person', () => {
  it('renders the template with contacts when the policy allows', () => {
    expect(person(WITH_CONTACTS).content).toBe(
      [
        '# Person: Jan Kowalski',
        'Type: person',
        'Role: Sales manager',
        'Email: jan@acme.example, j.kowalski@acme.example',
        'Phone: +48 601 234 567',
        'Companies: Acme (employee)',
        'Projects: Apollo (lead)',
        '',
        '## Description',
        'Met at the fair.',
      ].join('\n'),
    );
  });

  it('omits email and phone lines when third_party_contacts is selected', () => {
    const doc = person(NO_CONTACTS).content;
    expect(doc).not.toContain('Email:');
    expect(doc).not.toContain('Phone:');
    expect(doc).not.toContain('jan@acme.example');
    expect(doc).not.toContain('601 234 567');
    expect(doc).toContain('# Person: Jan Kowalski');
    expect(doc).toContain('Companies: Acme (employee)');
  });

  it('omits empty fields', () => {
    const doc = buildHubDocument('person', { policy: WITH_CONTACTS, name: ft('Anna'), emails: [], phones: [], companies: [], projects: [] }).content;
    expect(doc).toBe('# Person: Anna\nType: person');
  });

  it('caps lists at 20 entries', () => {
    const companies = Array.from({ length: 25 }, (_, i) => ({ name: ft(`Co${i}`) }));
    const doc = buildHubDocument('person', { policy: WITH_CONTACTS, name: ft('Anna'), emails: [], phones: [], companies, projects: [] }).content;
    expect(doc).toContain('Co19');
    expect(doc).not.toContain('Co20');
  });
});

describe('buildHubDocument: company and project', () => {
  const company = (policy: Policy) =>
    buildHubDocument('company', {
      policy,
      name: ft('Acme'),
      website: ft('https://acme.example'),
      industry: ft('Logistics'),
      domains: [cv('acme.example'), cv('acme-mail.example')],
      people: [{ name: ft('Jan Kowalski'), role: ft('CEO') }],
      projects: [{ name: ft('Apollo') }],
    }).content;

  it('always includes domains', () => {
    for (const policy of [WITH_CONTACTS, NO_CONTACTS]) {
      const doc = company(policy);
      expect(doc).toContain('# Company: Acme');
      expect(doc).toContain('Website: https://acme.example');
      expect(doc).toContain('Industry: Logistics');
      expect(doc).toContain('Domains: acme.example, acme-mail.example');
      expect(doc).toContain('People: Jan Kowalski (CEO)');
      expect(doc).toContain('Projects: Apollo');
    }
  });

  it('renders a project', () => {
    const doc = buildHubDocument('project', {
      policy: WITH_CONTACTS,
      name: ft('Apollo'),
      status: ft('active'),
      start: ft('2024-01-01'),
      people: [{ name: ft('Jan Kowalski'), role: ft('lead') }],
      companies: [{ name: ft('Acme') }],
    }).content;
    expect(doc).toBe(
      ['# Project: Apollo', 'Status: active', 'Start: 2024-01-01', 'People: Jan Kowalski (lead)', 'Companies: Acme'].join('\n'),
    );
  });
});

describe('buildHubDocument: note, file, summary', () => {
  it('renders a note', () => {
    const doc = buildHubDocument('note', {
      policy: WITH_CONTACTS,
      title: ft('Call notes'),
      ownerKind: 'company',
      ownerName: ft('Acme'),
      linked: [ft('Jan Kowalski')],
      created: '2024-02-01T10:00:00Z',
      updated: '2024-02-02T10:00:00Z',
      markdown: ft('- [ ] send offer\n- [x] call back'),
    }).content;
    expect(doc).toBe(
      [
        '# Note: Call notes',
        'Belongs to: company Acme',
        'Linked: Jan Kowalski',
        'Created: 2024-02-01T10:00:00Z  Updated: 2024-02-02T10:00:00Z',
        '---',
        '- [ ] send offer',
        '- [x] call back',
      ].join('\n'),
    );
  });

  const file = (status: 'extracted' | 'empty' | 'not_searchable' | 'excluded', text?: string) =>
    buildHubDocument('file', {
      policy: WITH_CONTACTS,
      name: ft('offer.pdf'),
      extension: 'pdf',
      size: '120 KB',
      ownerKind: 'person',
      ownerName: ft('Jan Kowalski'),
      description: ft('Signed offer'),
      extractionStatus: status,
      ...(status === 'not_searchable' ? { reason: 'scanned image' } : {}),
      ...(text !== undefined ? { text: ft(text) } : {}),
    }).content;

  it('includes the file body only when extracted', () => {
    const extracted = file('extracted', 'Offer body text');
    expect(extracted).toContain('# File: offer.pdf');
    expect(extracted).toContain('Type: pdf, 120 KB');
    expect(extracted).toContain('Belongs to: person Jan Kowalski');
    expect(extracted).toContain('Description: Signed offer');
    expect(extracted).toContain('Text: extracted');
    expect(extracted.endsWith('---\nOffer body text')).toBe(true);
    for (const status of ['empty', 'not_searchable', 'excluded'] as const) {
      const doc = file(status, 'Should never appear');
      expect(doc).not.toContain('Should never appear');
    }
    expect(file('empty')).toContain('Text: empty');
    expect(file('not_searchable')).toContain('Text: not searchable (scanned image)');
    expect(file('excluded')).toContain('Text: excluded');
  });

  it('renders a summary without message text and gates participant addresses', () => {
    const build = (policy: Policy) =>
      buildHubDocument('summary', {
        policy,
        subject: ft('Offer details'),
        firstDate: '2024-02-01',
        lastDate: '2024-02-05',
        messageCount: 4,
        participants: [
          { name: ft('me') },
          { name: ft('Jan Kowalski'), address: cv('jan@acme.example') },
        ],
        related: [ft('Acme')],
        attachments: [ft('offer.pdf')],
        summary: ft('They agreed on the price.'),
      }).content;
    const allowed = build(WITH_CONTACTS);
    expect(allowed).toContain('# Conversation: Offer details');
    expect(allowed).toContain('Dates: 2024-02-01 to 2024-02-05  Messages: 4');
    expect(allowed).toContain('jan@acme.example');
    expect(allowed).toContain('Related: Acme');
    expect(allowed).toContain('Attachments: offer.pdf');
    expect(allowed.endsWith('---\nThey agreed on the price.')).toBe(true);
    const gated = build(NO_CONTACTS);
    expect(gated).not.toContain('jan@acme.example');
    expect(gated).toContain('Jan Kowalski');
  });
});
