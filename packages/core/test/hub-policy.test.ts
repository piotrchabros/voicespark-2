import { describe, expect, it } from 'vitest';
import { markerKey } from '../src/hub/fingerprint';
import {
  decide,
  HUB_POLICY_V1,
  type HubDecision,
  type HubPolicyState,
  type PolicyCompany,
  type PolicyExtraction,
  type PolicyPerson,
  type PolicyProject,
} from '../src/hub/policy';

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';

// Decision table for contracts/hub-extraction.md section 9 (HUB_POLICY_V1).

type Person = PolicyExtraction['people'][number];
type Company = PolicyExtraction['companies'][number];
type Project = PolicyExtraction['projects'][number];
type Link = PolicyExtraction['links'][number];

const THREAD_DATE = new Date('2026-03-10T10:00:00Z');

function state(over: Partial<HubPolicyState> = {}): HubPolicyState {
  return {
    userId: '11111111-1111-1111-1111-111111111111',
    threadId: 't1',
    threadDate: THREAD_DATE,
    participants: [{ key: 'P1', address: 'jane@acme.pl', name: 'Jane Doe', sent: 1, directToOnOwnerSent: false }],
    ownerAddresses: new Set(['me@mine.com']),
    ownerDomains: new Set(['mine.com']),
    ignoredAddresses: new Set(),
    ignoredDomains: new Set(),
    people: [],
    companies: [],
    projects: [],
    links: [],
    blockMarkers: new Set(),
    rejectedFingerprints: new Set(),
    ...over,
  };
}

const person = (over: Partial<Person> = {}): Person => ({
  participantKey: 'P1',
  existingPersonId: null,
  name: 'Jane Doe',
  isHuman: true,
  roleTitle: null,
  roleTitleBasis: null,
  phone: null,
  phoneBasis: null,
  companyRef: null,
  confidence: 0.95,
  evidence: '',
  ...over,
});

const company = (over: Partial<Company> = {}): Company => ({
  ref: 'C1',
  existingCompanyId: null,
  name: 'Acme Sp. z o.o.',
  domain: 'acme.pl',
  website: null,
  industry: null,
  industryConfidence: null,
  basis: 'domain',
  confidence: 0.9,
  evidence: '',
  ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
  ref: 'J1',
  existingProjectId: null,
  name: 'Apollo',
  description: null,
  status: null,
  explicitlyNamed: true,
  confidence: 0.9,
  evidence: '',
  ...over,
});

const link = (over: Partial<Link> = {}): Link => ({
  kind: 'person_company',
  from: 'P1',
  to: 'C1',
  role: null,
  roleConfidence: null,
  basis: 'domain',
  confidence: 0.9,
  evidence: '',
  ...over,
});

const extraction = (over: Partial<PolicyExtraction> = {}): PolicyExtraction => ({
  relevant: true,
  language: 'en',
  summary: 'x',
  people: [],
  companies: [],
  projects: [],
  links: [],
  ...over,
});

const run = (s: HubPolicyState, e: PolicyExtraction): HubDecision[] => decide(e, s, HUB_POLICY_V1);
const ofType = (ds: HubDecision[], type: string, field?: string) =>
  ds.filter((d) => d.fact.type === type && (field === undefined || d.fact.field === field));
const one = (ds: HubDecision[], type: string, field?: string): HubDecision => {
  const found = ofType(ds, type, field);
  expect(found).toHaveLength(1);
  return found[0]!;
};

const acme: PolicyCompany = { id: 'c-acme', name: 'Acme', domains: ['acme.pl'], industry: null, ownerFields: [] };
const janeExisting: PolicyPerson = {
  id: 'p-jane',
  name: 'Jane Doe',
  emails: ['jane.doe@acme.pl'],
  companyIds: ['c-acme'],
  roleTitle: null,
  phone: null,
  ownerFields: [],
};

describe('constants', () => {
  it('HUB_POLICY_V1 has the section 9 thresholds and stoplist', () => {
    expect(HUB_POLICY_V1).toMatchObject({
      version: 'hub-policy-v1',
      autoConfidence: 0.8,
      strongAutoConfidence: 0.85,
      suggestFloor: 0.7,
      maxOwnerToRecipients: 5,
    });
    expect([...HUB_POLICY_V1.genericProjectStoplist].sort()).toEqual(
      [
        'project', 'projekt', 'deal', 'umowa', 'oferta', 'zlecenie', 'sprawa', 'temat', 'the project', 'nasz projekt',
        'wspolpraca', 'wdrozenie', 'implementation', 'proposal',
      ].sort(),
    );
  });
});

describe('common downgrades', () => {
  it('drops a decision whose fingerprint was rejected with this thread as evidence', () => {
    const e = extraction({ people: [person()] });
    const first = one(run(state(), e), 'person');
    expect(first.outcome).toBe('auto');
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const again = one(run(state({ rejectedFingerprints: new Set([first.fingerprint]) }), e), 'person');
    expect(again).toMatchObject({ outcome: 'drop', reason: 'rejected' });
  });

  it('fingerprints are stable across runs and differ per user', () => {
    const e = extraction({ people: [person()] });
    expect(one(run(state(), e), 'person').fingerprint).toBe(one(run(state(), e), 'person').fingerprint);
    expect(one(run(state({ userId: '22222222-2222-2222-2222-222222222222' }), e), 'person').fingerprint).not.toBe(
      one(run(state(), e), 'person').fingerprint,
    );
  });

  it('turns auto into suggest with reason tombstoned when a block marker matches', () => {
    const s = state({ blockMarkers: new Set([markerKey.personEmail('jane@acme.pl')]) });
    expect(one(run(s, extraction({ people: [person()] })), 'person')).toMatchObject({
      outcome: 'suggest',
      reason: 'tombstoned',
    });
  });

  it('keeps a tombstoned suggestion below the floor', () => {
    const s = state({
      participants: [{ key: 'P1', address: 'jane@acme.pl', name: null, sent: 0, directToOnOwnerSent: false }],
      blockMarkers: new Set([markerKey.personEmail('jane@acme.pl')]),
    });
    expect(one(run(s, extraction({ people: [person({ confidence: 0.5 })] })), 'person')).toMatchObject({
      outcome: 'suggest',
      reason: 'tombstoned',
    });
  });

  it('drops a suggestion below the floor', () => {
    const s = state({
      participants: [{ key: 'P1', address: 'jane@acme.pl', name: null, sent: 0, directToOnOwnerSent: false }],
    });
    expect(one(run(s, extraction({ people: [person({ confidence: 0.69 })] })), 'person')).toMatchObject({
      outcome: 'drop',
      reason: 'low_confidence',
    });
  });
});

describe('companies', () => {
  it('matches an existing company by domain', () => {
    const ds = run(state({ companies: [acme] }), extraction({ companies: [company()] }));
    expect(one(ds, 'company')).toMatchObject({ outcome: 'auto', action: 'match' });
    expect(one(ds, 'company').fact.target.id).toBe('c-acme');
    expect(ofType(ds, 'company_domain')).toHaveLength(0);
  });

  it('attaches the new domain to exactly one name match at >= 0.80', () => {
    const ds = run(state({ companies: [acme] }), extraction({ companies: [company({ domain: 'acme.com', confidence: 0.8 })] }));
    expect(one(ds, 'company')).toMatchObject({ outcome: 'auto', action: 'match' });
    const d = one(ds, 'company_domain');
    expect(d).toMatchObject({ outcome: 'auto', action: 'attach' });
    expect(d.fact.target.id).toBe('c-acme');
    expect(d.fact.value).toEqual({ domain: 'acme.com' });
  });

  it('creates instead of attaching when the name match is below 0.80', () => {
    const ds = run(state({ companies: [acme] }), extraction({ companies: [company({ domain: 'acme.com', confidence: 0.79 })] }));
    const d = one(ds, 'company');
    expect(d).toMatchObject({ outcome: 'auto', action: 'create' });
    expect(d.fact.value).toMatchObject({ name: 'Acme', domain: 'acme.com' });
  });

  it('does not attach by name when several companies share it', () => {
    const other: PolicyCompany = { ...acme, id: 'c-acme2', domains: ['acme.de'] };
    const ds = run(state({ companies: [acme, other] }), extraction({ companies: [company({ domain: 'acme.com' })] }));
    expect(one(ds, 'company')).toMatchObject({ action: 'create' });
  });

  it.each([
    { confidence: 0.9, domain: 'acme.pl', name: 'Acme Sp. z o.o.' },
    { confidence: 0.8, domain: 'acme.pl', name: 'Acme Sp. z o.o.' },
    { confidence: 0.79, domain: 'acme.pl', name: 'Acme' },
    { confidence: 0.5, domain: 'acme-consulting.com.pl', name: 'Acme-consulting' },
    { confidence: 0.5, domain: 'www.acme.co.uk', name: 'Acme' },
  ])('auto-creates a business-domain company (confidence $confidence, $domain -> $name)', ({ confidence, domain, name }) => {
    const ds = run(state(), extraction({ companies: [company({ confidence, domain })] }));
    const c = one(ds, 'company');
    expect(c).toMatchObject({ outcome: 'auto', action: 'create', reason: null });
    expect(c.fact.value).toMatchObject({ name });
    const d = one(ds, 'company_domain');
    expect(d).toMatchObject({ outcome: 'auto', action: 'attach', dependsOnRef: 'C1' });
  });

  it('takes the domain from the website when no domain is given', () => {
    const ds = run(state(), extraction({ companies: [company({ domain: null, website: 'https://www.acme.pl/kontakt' })] }));
    expect(one(ds, 'company_domain').fact.value).toEqual({ domain: 'acme.pl' });
  });

  it.each([
    { label: 'owner domain', s: {}, domain: 'mine.com' },
    { label: 'ignored domain', s: { ignoredDomains: new Set(['acme.pl']) }, domain: 'acme.pl' },
    { label: 'ignored parent domain', s: { ignoredDomains: new Set(['acme.pl']) }, domain: 'mail.acme.pl' },
  ])('creates nothing for an $label', ({ s, domain }) => {
    expect(run(state(s), extraction({ companies: [company({ domain })] }))).toHaveLength(0);
  });

  it('never auto-creates a company on a free-mail domain', () => {
    const ds = run(state(), extraction({ companies: [company({ domain: 'gmail.com' })] }));
    expect(one(ds, 'company')).toMatchObject({ outcome: 'suggest', reason: 'low_confidence', action: 'create' });
    expect(ofType(ds, 'company_domain')).toHaveLength(0);
  });

  it.each([
    { label: 'one name match', companies: [acme], outcome: 'auto', action: 'match' },
    { label: 'no name match', companies: [], outcome: 'suggest', action: 'create' },
    {
      label: 'two name matches',
      companies: [acme, { ...acme, id: 'c-acme2', domains: ['acme.de'] }],
      outcome: 'suggest',
      action: 'create',
    },
  ])('a company with no domain: $label -> $outcome', ({ companies, outcome, action }) => {
    const ds = run(state({ companies }), extraction({ companies: [company({ domain: null, basis: 'signature' })] }));
    expect(one(ds, 'company')).toMatchObject({ outcome, action });
  });

  it('downgrades a company create when its name or domain is block-marked', () => {
    for (const marker of [markerKey.companyName('Acme Sp. z o.o.'), markerKey.companyDomain('acme.pl')]) {
      const ds = run(state({ blockMarkers: new Set([marker]) }), extraction({ companies: [company()] }));
      expect(one(ds, 'company')).toMatchObject({ outcome: 'suggest', reason: 'tombstoned' });
    }
  });

  it.each([
    { label: 'empty, >= 0.85', current: null, owner: false, conf: 0.85, outcome: 'auto', action: 'update', reason: null, conflict: false },
    { label: 'empty, < 0.85', current: null, owner: false, conf: 0.84, outcome: 'suggest', action: 'update', reason: 'low_confidence', conflict: false },
    { label: 'set, different', current: 'Retail', owner: false, conf: 0.95, outcome: 'suggest', action: 'update', reason: 'low_confidence', conflict: false },
    { label: 'owner-set, different', current: 'Retail', owner: true, conf: 0.95, outcome: 'suggest', action: 'update', reason: 'conflict', conflict: true },
    { label: 'owner-set, equal', current: 'software', owner: true, conf: 0.95, outcome: 'auto', action: 'corroborate', reason: null, conflict: false },
  ])('industry: $label -> $outcome', ({ current, owner, conf, outcome, action, reason, conflict }) => {
    const existing: PolicyCompany = { ...acme, industry: current, ownerFields: owner ? ['industry'] : [] };
    const ds = run(
      state({ companies: [existing] }),
      extraction({ companies: [company({ industry: 'Software', industryConfidence: conf })] }),
    );
    const d = one(ds, 'field', 'industry');
    expect(d).toMatchObject({ outcome, action, reason });
    expect(d.fact.conflict).toBe(conflict);
    if (conflict) expect(d.fact.previousValue).toBe('Retail');
  });
});

describe('people', () => {
  it.each([
    { label: 'not human', s: {}, p: { isHuman: false } },
    {
      label: 'automated',
      s: { participants: [{ key: 'P1', address: 'jane@acme.pl', name: null, sent: 1, directToOnOwnerSent: false, automated: true }] },
      p: {},
    },
    {
      label: 'owner',
      s: { participants: [{ key: 'P1', address: 'Me@Mine.com', name: null, sent: 1, directToOnOwnerSent: false }] },
      p: {},
    },
    {
      label: 'role address',
      s: { participants: [{ key: 'P1', address: 'biuro@acme.pl', name: null, sent: 1, directToOnOwnerSent: false }] },
      p: {},
    },
    { label: 'ignored address (+tag)', s: { ignoredAddresses: new Set(['jane@acme.pl']) }, p: {} },
    { label: 'ignored domain', s: { ignoredDomains: new Set(['acme.pl']) }, p: {} },
    { label: 'unknown participant key', s: {}, p: { participantKey: 'P9' } },
  ])('skips a $label participant', ({ s, p }) => {
    const base = state(s as Partial<HubPolicyState>);
    const st =
      (s as { ignoredAddresses?: unknown }).ignoredAddresses !== undefined
        ? { ...base, participants: [{ ...base.participants[0]!, address: 'jane+news@acme.pl' }] }
        : base;
    expect(run(st, extraction({ people: [person(p)] }))).toHaveLength(0);
  });

  it.each(['jane.doe@acme.pl', 'Jane.Doe+crm@acme.pl'])('matches an existing person by address (%s)', (address) => {
    const s = state({
      people: [janeExisting],
      participants: [{ key: 'P1', address, name: null, sent: 1, directToOnOwnerSent: false }],
    });
    const ds = run(s, extraction({ people: [person()] }));
    const d = one(ds, 'person');
    expect(d).toMatchObject({ outcome: 'auto', action: 'match' });
    expect(d.fact.target.id).toBe('p-jane');
    expect(ofType(ds, 'person_email')).toHaveLength(0);
  });

  it('auto-attaches the address to a same-name person linked to the domain company', () => {
    const ds = run(state({ people: [janeExisting], companies: [acme] }), extraction({ people: [person()] }));
    const d = one(ds, 'person_email');
    expect(d).toMatchObject({ outcome: 'auto', action: 'attach', reason: null });
    expect(d.fact.target.id).toBe('p-jane');
    expect(d.fact.value).toEqual({ address: 'jane@acme.pl' });
    expect(ofType(ds, 'person').filter((x) => x.action === 'create')).toHaveLength(0);
  });

  it('auto-attaches when the domain was attached to the company in this thread', () => {
    const s = state({
      people: [janeExisting],
      companies: [{ ...acme, domains: ['acme.de'] }],
      participants: [{ key: 'P1', address: 'jane@acme.com', name: null, sent: 1, directToOnOwnerSent: false }],
    });
    const ds = run(s, extraction({ companies: [company({ domain: 'acme.com' })], people: [person()] }));
    expect(one(ds, 'person_email')).toMatchObject({ outcome: 'auto' });
  });

  it.each([
    { label: 'not linked to the domain company', p: { ...janeExisting, companyIds: [] }, extra: {} },
    { label: 'an existingPersonId candidate is not linked to the domain company', p: { ...janeExisting, name: 'J. Doe', companyIds: [] }, extra: { existingPersonId: 'p-jane' } },
  ])('suggests person_email with name_only_match when $label', ({ p, extra }) => {
    const ds = run(state({ people: [p], companies: [acme] }), extraction({ people: [person(extra)] }));
    expect(one(ds, 'person_email')).toMatchObject({ outcome: 'suggest', reason: 'name_only_match' });
    expect(ofType(ds, 'person')).toHaveLength(0);
  });

  it('resolves existingPersonId through a merge redirect', () => {
    const s = state({ people: [{ ...janeExisting, name: 'J. Doe' }], companies: [acme], redirects: new Map([['p-old', 'p-jane']]) });
    const ds = run(s, extraction({ people: [person({ existingPersonId: 'p-old' })] }));
    expect(one(ds, 'person_email').fact.target.id).toBe('p-jane');
  });

  it.each([
    { label: 'sender', sent: 1, directTo: false, outcome: 'auto', reason: null },
    { label: 'direct To of an owner-sent message', sent: 0, directTo: true, outcome: 'auto', reason: null },
    { label: 'other recipient', sent: 0, directTo: false, outcome: 'suggest', reason: 'low_confidence' },
  ])('no match, $label -> $outcome', ({ sent, directTo, outcome, reason }) => {
    const s = state({
      participants: [{ key: 'P1', address: 'jane@acme.pl', name: 'Jane Doe', sent, directToOnOwnerSent: directTo }],
    });
    const d = one(run(s, extraction({ people: [person()] })), 'person');
    expect(d).toMatchObject({ outcome, reason, action: 'create' });
    expect(d.fact.value).toEqual({ name: 'Jane Doe', email: 'jane@acme.pl' });
  });

  const field = (
    f: 'roleTitle' | 'phone',
    over: Partial<PolicyPerson>,
    value: string,
    basis: 'header' | 'signature' | 'text',
    confidence = 0.9,
  ): HubDecision[] => {
    const s = state({
      people: [{ ...janeExisting, emails: ['jane@acme.pl'], ...over }],
    });
    const p = f === 'roleTitle' ? { roleTitle: value, roleTitleBasis: basis } : { phone: value, phoneBasis: basis };
    return ofType(run(s, extraction({ people: [person({ ...p, confidence })] })), 'field', f);
  };

  it.each([
    { label: 'empty, signature, 0.80', over: {}, basis: 'signature', conf: 0.8, outcome: 'auto', action: 'update', reason: null },
    { label: 'empty, header, 0.90', over: {}, basis: 'header', conf: 0.9, outcome: 'auto', action: 'update', reason: null },
    { label: 'empty, text', over: {}, basis: 'text', conf: 0.95, outcome: 'suggest', action: 'update', reason: 'low_confidence' },
    { label: 'empty, signature, 0.79', over: {}, basis: 'signature', conf: 0.79, outcome: 'suggest', action: 'update', reason: 'low_confidence' },
    {
      label: 'older email value',
      over: { roleTitle: 'Analyst', emailFieldAt: { roleTitle: new Date('2026-01-01T00:00:00Z') } },
      basis: 'signature',
      conf: 0.9,
      outcome: 'auto',
      action: 'supersede',
      reason: null,
    },
    {
      label: 'owner-set, different',
      over: { roleTitle: 'Analyst', ownerFields: ['roleTitle'] },
      basis: 'signature',
      conf: 0.9,
      outcome: 'suggest',
      action: 'update',
      reason: 'conflict',
    },
    {
      label: 'owner-set, equal',
      over: { roleTitle: 'CTO', ownerFields: ['roleTitle'] },
      basis: 'signature',
      conf: 0.9,
      outcome: 'auto',
      action: 'corroborate',
      reason: null,
    },
  ] as const)('roleTitle: $label -> $outcome $action', ({ over, basis, conf, outcome, action, reason }) => {
    const [d, ...rest] = field('roleTitle', over as Partial<PolicyPerson>, 'CTO', basis, conf);
    expect(rest).toHaveLength(0);
    expect(d).toMatchObject({ outcome, action, reason });
    if (reason === 'conflict') {
      expect(d!.fact.conflict).toBe(true);
      expect(d!.fact.previousValue).toBe('Analyst');
    }
  });

  it('never replaces a newer email value with an older thread', () => {
    const ds = field('roleTitle', { roleTitle: 'Analyst', emailFieldAt: { roleTitle: new Date('2026-05-01T00:00:00Z') } }, 'CTO', 'signature');
    expect(ds).toHaveLength(0);
  });

  it('compares phones by digits', () => {
    const [d] = field('phone', { phone: '+48 600 100 200', ownerFields: ['phone'] }, '+48600100200', 'signature');
    expect(d).toMatchObject({ outcome: 'auto', action: 'corroborate' });
  });

  it('a new person gets field decisions that depend on its creation', () => {
    const ds = run(state(), extraction({ people: [person({ roleTitle: 'CTO', roleTitleBasis: 'signature' })] }));
    expect(one(ds, 'field', 'roleTitle')).toMatchObject({ outcome: 'auto', action: 'update', dependsOnRef: 'P1' });
  });

  it('a block marker on a rejected field value downgrades it', () => {
    const s = state({
      people: [{ ...janeExisting, emails: ['jane@acme.pl'] }],
      blockMarkers: new Set([markerKey.field('person', 'p-jane', 'roleTitle', 'CTO')]),
    });
    const ds = run(s, extraction({ people: [person({ roleTitle: 'CTO', roleTitleBasis: 'signature' })] }));
    expect(one(ds, 'field', 'roleTitle')).toMatchObject({ outcome: 'suggest', reason: 'tombstoned' });
  });
});

describe('projects', () => {
  it.each([
    { label: 'explicit, 0.85', p: { confidence: 0.85 }, outcome: 'auto', reason: null },
    { label: 'explicit, 0.84', p: { confidence: 0.84 }, outcome: 'suggest', reason: 'inferred_project' },
    { label: 'inferred', p: { explicitlyNamed: false }, outcome: 'suggest', reason: 'inferred_project' },
    { label: 'inferred, below floor', p: { explicitlyNamed: false, confidence: 0.6 }, outcome: 'drop', reason: 'low_confidence' },
    { label: 'generic "Projekt"', p: { name: 'Projekt' }, outcome: 'suggest', reason: 'inferred_project' },
    { label: 'generic "Wdrożenie"', p: { name: 'Wdrożenie' }, outcome: 'suggest', reason: 'inferred_project' },
    { label: 'generic "The Project"', p: { name: 'The Project' }, outcome: 'suggest', reason: 'inferred_project' },
    { label: 'generic "Nasz projekt"', p: { name: 'Nasz projekt' }, outcome: 'suggest', reason: 'inferred_project' },
    { label: 'generic "Współpraca"', p: { name: 'Współpraca' }, outcome: 'suggest', reason: 'inferred_project' },
  ])('$label -> $outcome', ({ p, outcome, reason }) => {
    const d = one(run(state(), extraction({ projects: [project(p)] })), 'project');
    expect(d).toMatchObject({ outcome, reason, action: 'create' });
  });

  it('matches a same-name project with no companies', () => {
    const apollo: PolicyProject = { id: 'j-apollo', name: 'Projekt Apollo', companyIds: [], personIds: [] };
    const d = one(run(state({ projects: [apollo] }), extraction({ projects: [project()] })), 'project');
    expect(d).toMatchObject({ outcome: 'auto', action: 'match' });
    expect(d.fact.target.id).toBe('j-apollo');
  });

  it('matches a same-name project of a company matched in this thread', () => {
    const apollo: PolicyProject = { id: 'j-apollo', name: 'Apollo', companyIds: ['c-acme'], personIds: [] };
    const ds = run(state({ projects: [apollo], companies: [acme] }), extraction({ companies: [company()], projects: [project()] }));
    expect(one(ds, 'project')).toMatchObject({ outcome: 'auto', action: 'match' });
  });

  it('suggests a same-name project linked only to other companies', () => {
    const apollo: PolicyProject = { id: 'j-apollo', name: 'Apollo', companyIds: ['c-other'], personIds: [] };
    const d = one(run(state({ projects: [apollo] }), extraction({ projects: [project()] })), 'project');
    expect(d).toMatchObject({ outcome: 'suggest', action: 'create', reason: 'inferred_project' });
  });

  it('downgrades a block-marked project name', () => {
    const s = state({ blockMarkers: new Set([markerKey.projectName('Apollo')]) });
    expect(one(run(s, extraction({ projects: [project()] })), 'project')).toMatchObject({
      outcome: 'suggest',
      reason: 'tombstoned',
    });
  });
});

describe('links', () => {
  const base = { people: [person()], companies: [company()] };

  it('auto-links a new person to a new company on a domain basis, ends in person -> company order', () => {
    const ds = run(state(), extraction({ ...base, links: [link({ from: 'C1', to: 'P1' })] }));
    const d = one(ds, 'link');
    expect(d).toMatchObject({ outcome: 'auto', action: 'create', reason: null });
    expect(d.fact.link?.a).toMatchObject({ kind: 'person', ref: 'P1' });
    expect(d.fact.link?.b).toMatchObject({ kind: 'company', ref: 'C1' });
  });

  it.each([
    { label: 'confidence 0.80', l: { confidence: 0.8 }, outcome: 'auto', reason: null },
    { label: 'confidence 0.79', l: { confidence: 0.79 }, outcome: 'suggest', reason: 'low_confidence' },
    { label: 'below floor', l: { confidence: 0.6 }, outcome: 'drop', reason: 'low_confidence' },
    { label: 'person_company on text basis', l: { basis: 'text' as const }, outcome: 'suggest', reason: 'low_confidence' },
  ])('person_company: $label -> $outcome', ({ l, outcome, reason }) => {
    expect(one(run(state(), extraction({ ...base, links: [link(l)] })), 'link')).toMatchObject({ outcome, reason });
  });

  it('never auto-links a company on an owner domain', () => {
    const mine: PolicyCompany = { id: 'c-mine', name: 'Mine', domains: ['mine.com'], industry: null, ownerFields: [] };
    const ds = run(
      state({ companies: [mine] }),
      extraction({
        companies: [company({ ref: 'C2', name: 'Mine', domain: 'mine.com' })],
        projects: [project()],
        links: [link({ kind: 'company_project', from: 'C2', to: 'J1' })],
      }),
    );
    expect(ofType(ds, 'company')).toHaveLength(0);
    const d = one(ds, 'link');
    expect(d.outcome).toBe('suggest');
    expect(d.fact.link?.a.id).toBe('c-mine');
  });

  it('suggests a link whose end is pending, depending on it', () => {
    const ds = run(
      state(),
      extraction({
        ...base,
        projects: [project({ explicitlyNamed: false })],
        links: [link({ kind: 'person_project', from: 'P1', to: 'J1' })],
      }),
    );
    expect(one(ds, 'link')).toMatchObject({ outcome: 'suggest', dependsOnRef: 'J1' });
  });

  it('skips links whose end has no record decision', () => {
    const s = state({ participants: [{ key: 'P1', address: 'info@acme.pl', name: null, sent: 1, directToOnOwnerSent: false }] });
    expect(ofType(run(s, extraction({ ...base, links: [link()] })), 'link')).toHaveLength(0);
  });

  it('creates one link per pair and never a same-kind pair', () => {
    const s = state({
      participants: [
        { key: 'P1', address: 'jane@acme.pl', name: 'Jane Doe', sent: 1, directToOnOwnerSent: false },
        { key: 'P2', address: 'john@acme.pl', name: 'John Roe', sent: 1, directToOnOwnerSent: false },
      ],
    });
    const ds = run(
      s,
      extraction({
        people: [person(), person({ participantKey: 'P2', name: 'John Roe' })],
        companies: [company()],
        links: [link(), link({ from: 'C1', to: 'P1', confidence: 0.85 }), link({ kind: 'person_company', from: 'P1', to: 'P2' })],
      }),
    );
    expect(ofType(ds, 'link')).toHaveLength(1);
  });

  it('matches an existing link between known ends and downgrades a block-marked one', () => {
    const s = state({
      people: [{ ...janeExisting, emails: ['jane@acme.pl'] }],
      companies: [acme],
      links: [{ id: 'l1', kind: 'person_company', personId: 'p-jane', companyId: 'c-acme', projectId: null, role: null, roleOwnerSet: false }],
    });
    const e = extraction({ ...base, links: [link()] });
    const d = one(run(s, e), 'link');
    expect(d).toMatchObject({ outcome: 'auto', action: 'match' });
    expect(d.fact.link?.linkId).toBe('l1');
    const marked = { ...s, blockMarkers: new Set([markerKey.link('person_company', 'p-jane', 'c-acme')]) };
    expect(one(run(marked, e), 'link')).toMatchObject({ outcome: 'suggest', reason: 'tombstoned' });
  });

  describe('roles', () => {
    const known = (over: { role?: string | null; roleOwnerSet?: boolean; person?: Partial<PolicyPerson> } = {}) =>
      state({
        people: [{ ...janeExisting, emails: ['jane@acme.pl'], ...over.person }],
        companies: [acme],
        links: [
          {
            id: 'l1',
            kind: 'person_company',
            personId: 'p-jane',
            companyId: 'c-acme',
            projectId: null,
            role: over.role ?? null,
            roleOwnerSet: over.roleOwnerSet ?? false,
          },
        ],
      });

    it.each([
      { label: 'below 0.70', s: known(), l: { basis: 'signature' as const, roleConfidence: 0.69 }, outcome: 'drop', reason: 'low_confidence', conflict: false },
      { label: 'equal current role', s: known({ role: 'cto' }), l: { roleConfidence: 0.9 }, outcome: 'auto', reason: null, conflict: false },
      { label: 'role_owner_set, different', s: known({ role: 'CEO', roleOwnerSet: true }), l: { basis: 'signature' as const, roleConfidence: 0.9 }, outcome: 'suggest', reason: 'conflict', conflict: true },
      {
        label: 'owner-set person title differs',
        s: known({ person: { roleTitle: 'CEO', ownerFields: ['roleTitle'] } }),
        l: { basis: 'signature' as const, roleConfidence: 0.9 },
        outcome: 'suggest',
        reason: 'conflict',
        conflict: true,
      },
      { label: 'works-at, signature', s: known(), l: { basis: 'signature' as const, roleConfidence: 0.9 }, outcome: 'auto', reason: null, conflict: false },
      { label: 'works-at, domain basis', s: known(), l: { roleConfidence: 0.9 }, outcome: 'suggest', reason: 'low_confidence', conflict: false },
    ])('works-at role: $label -> $outcome', ({ s, l, outcome, reason, conflict }) => {
      const ds = run(s, extraction({ ...base, links: [link({ role: 'CTO', ...l })] }));
      expect(one(ds, 'link').outcome).toBe('auto');
      const r = one(ds, 'link_role');
      expect(r).toMatchObject({ outcome, reason });
      expect(r.fact.conflict).toBe(conflict);
    });

    it.each([
      { confidence: 0.85, outcome: 'auto', reason: null },
      { confidence: 0.84, outcome: 'suggest', reason: 'low_confidence' },
    ])('project link role at link confidence $confidence -> $outcome', ({ confidence, outcome, reason }) => {
      const ds = run(
        state(),
        extraction({
          ...base,
          projects: [project()],
          links: [link({ kind: 'person_project', from: 'P1', to: 'J1', role: 'Lead', roleConfidence: 0.9, basis: 'text', confidence })],
        }),
      );
      expect(one(ds, 'link').outcome).toBe('auto');
      expect(one(ds, 'link_role')).toMatchObject({ outcome, reason });
    });

    it('a suggested link carries its role and gets no role decision', () => {
      const ds = run(state(), extraction({ ...base, links: [link({ basis: 'text', role: 'CTO', roleConfidence: 0.9 })] }));
      expect(one(ds, 'link').fact.value).toMatchObject({ role: 'CTO' });
      expect(ofType(ds, 'link_role')).toHaveLength(0);
    });
  });
});
