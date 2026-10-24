import { createFakeLlm, LlmRefusedError, type LlmClient } from '@voicespark/integrations/anthropic';
import type { Dimension, DraftContentType, HubFactBasis, HubLinkKind, HubProjectStatus } from '@voicespark/db';
import { hubExtractionSchema, hubTriageSchema, type HubExtraction, type HubTriage } from '../hub/extraction-schema';
import { foldName } from '../hub/normalize';
import { stripNeutralizer } from './analysis';
import { isDocumentOutputSchema, type DocumentOutput } from './document-schema';
import { CONTENT_TYPE_LABEL, draftSchemaContentType, type DraftOutput } from './draft-schema';
import { profileSchemaDimensions, type ProfileOutput } from './profile-schema';

const SAMPLE_BLOCK = /<sample ref="(A[0-9]+)"[^>]*>([\s\S]*?)<\/sample>/g;
const EXCERPT_MAX_CHARS = 120;
const EXCERPT_COUNT = 3;
const BRIEF_LINE = /Brief: ([^\n]*)/;
/** Test hook: a brief line containing this marker makes the fake refuse. */
const REFUSE_MARKER = 'FAKE_LLM_REFUSE';

/** Test switches for document calls: a marker anywhere in the user prompt selects the matching failure. */
export const FAKE_DOC_MARKERS = {
  refuse: 'FAKE_DOC_REFUSE',
  noSummary: 'FAKE_DOC_NO_SUMMARY',
  emptyLists: 'FAKE_DOC_EMPTY_LISTS',
  fewExcerpts: 'FAKE_DOC_FEW_EXCERPTS',
  receivedQuote: 'FAKE_DOC_RECEIVED_QUOTE',
  missingAspect: 'FAKE_DOC_MISSING_ASPECT',
} as const;

const ANALYSIS_PROMPT_BLOCK = /<analysis_prompt[^>]*>([\s\S]*?)<\/analysis_prompt>/;
const ASPECT_LINE = /^\s*-\s+([^:\n]{1,80}):/gm;
const ITEM_BLOCK = /<item [^>]*>([\s\S]*?)<\/item>/;
const MAX_ASPECTS = 20;
const QUOTE_WORDS = 12;

/** Word-aligned prefix of the sample (<= EXCERPT_MAX_CHARS); a verbatim whitespace-normalized substring. */
function excerptOf(text: string): string {
  const words = text.trim().split(/\s+/);
  let out = words[0]!.slice(0, EXCERPT_MAX_CHARS);
  for (const word of words.slice(1)) {
    if (out.length + 1 + word.length > EXCERPT_MAX_CHARS) break;
    out += ` ${word}`;
  }
  return out;
}

function fakeValue(d: Dimension): number | string | string[] {
  switch (d.valueType) {
    case 'scale':
      return d.scale?.min ?? 1;
    case 'enum':
      return d.allowedValues?.[0] ?? 'Fake value';
    case 'text':
      return 'Fake value';
    case 'list':
      return ['fake'];
  }
}

function fakeProfile(dimensions: Dimension[], user: string): ProfileOutput {
  const samples = [...user.matchAll(SAMPLE_BLOCK)]
    .map((m) => ({ ref: m[1]!, text: m[2]! }))
    .filter((s) => s.text.trim() !== '');
  const [first] = samples;
  if (first === undefined) throw new Error('fake_llm_no_samples');
  const firstKey = dimensions[0]?.key;
  return {
    summary: 'Fake profile summary.',
    languages: [{ code: 'en', share: 1 }],
    dimensions: dimensions.map((d) => ({
      key: d.key,
      value: fakeValue(d),
      explanation: 'Fake explanation.',
      evidenceRefs: [first.ref],
    })),
    excerpts: Array.from({ length: EXCERPT_COUNT }, (_, i) => {
      const sample = samples[i % samples.length]!;
      return { text: excerptOf(sample.text), sampleRef: sample.ref, dimensionKeys: firstKey ? [firstKey] : [] };
    }),
    doList: ['Fake do.'],
    dontList: ['Fake dont.'],
  };
}

function slugify(name: string): string {
  let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(key)) key = `a_${key}`;
  return key.slice(0, 41);
}

/** One aspect per `- Name:` line of the analysis prompt block; a single `voice` aspect when there is none. */
function fakeAspects(user: string): { key: string; name: string }[] {
  const block = ANALYSIS_PROMPT_BLOCK.exec(stripNeutralizer(user))?.[1] ?? '';
  const aspects: { key: string; name: string }[] = [];
  const used = new Set<string>();
  for (const m of block.matchAll(ASPECT_LINE)) {
    if (aspects.length >= MAX_ASPECTS) break;
    const name = m[1]!.trim();
    const base = slugify(name);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 41 - `_${n}`.length)}_${n}`;
    used.add(key);
    aspects.push({ key, name });
  }
  return aspects.length > 0 ? aspects : [{ key: 'voice', name: 'Voice' }];
}

function fakeDocument(user: string): DocumentOutput {
  const has = (marker: string) => user.includes(marker);
  if (has(FAKE_DOC_MARKERS.refuse)) throw new LlmRefusedError();
  const aspects = fakeAspects(user);
  const samples = [...user.matchAll(SAMPLE_BLOCK)]
    .map((m) => ({ ref: m[1]!, text: m[2]! }))
    .filter((s) => s.text.trim() !== '');
  if (samples.length === 0) throw new Error('fake_llm_no_samples');
  const firstKey = aspects[0]!.key;
  let sections = aspects.map((a) => ({
    aspectKey: a.key,
    heading: a.name,
    markdown: `Fake description of ${a.name}.`,
  }));
  if (has(FAKE_DOC_MARKERS.missingAspect)) sections = sections.slice(0, -1);
  let summary = 'Fake document summary.';
  if (has(FAKE_DOC_MARKERS.noSummary)) summary = '';
  if (has(FAKE_DOC_MARKERS.receivedQuote)) {
    const item = ITEM_BLOCK.exec(stripNeutralizer(user))?.[1] ?? '';
    summary = item.trim().split(/\s+/).slice(0, QUOTE_WORDS).join(' ');
  }
  const emptyLists = has(FAKE_DOC_MARKERS.emptyLists);
  const fewExcerpts = has(FAKE_DOC_MARKERS.fewExcerpts);
  return {
    aspects,
    summary,
    sections,
    doList: emptyLists ? [''] : ['Fake do.'],
    dontList: emptyLists ? [''] : ['Fake dont.'],
    excerpts: Array.from({ length: EXCERPT_COUNT }, (_, i) => {
      const sample = samples[i % samples.length]!;
      return {
        text: fewExcerpts ? `not in any sample ${i + 1}` : excerptOf(stripNeutralizer(sample.text)),
        sampleRef: sample.ref,
        aspectKeys: [firstKey],
      };
    }),
    languages: [{ code: 'en', share: 1 }],
  };
}

/** Echoes the `Brief: ` line of the user prompt; cites `[M1]` when a memory block was supplied. */
function fakeDraft(contentType: DraftContentType, user: string): DraftOutput {
  const brief = BRIEF_LINE.exec(user)?.[1] ?? '';
  if (brief.includes(REFUSE_MARKER)) throw new LlmRefusedError();
  const memory = user.includes('<memory ref="M1">') ? ' [M1]' : '';
  return {
    title: contentType === 'short_article' ? 'Fake title' : null,
    body: `Fake ${CONTENT_TYPE_LABEL[contentType]} draft. ${brief}${memory}`,
    notes: null,
  };
}

// ---------------------------------------------------------------------------
// Hub extraction and triage (contracts/hub-extraction.md sections 5 and 6)
// ---------------------------------------------------------------------------

/** A `hubfx:<name>` token in the mail text selects a recorded output or a switch. */
const HUB_MARKER = /hubfx:([a-z0-9-]+)/g;

/** Recorded extraction outputs, selected by a `hubfx:<id>` token inside the `<messages>` block. */
export const FAKE_HUB_FIXTURES = {
  /** Jan Kowalski <jan@acme.example> of Acme (acme.example), role and phone from the signature, works-at link. */
  acmeOffer: 'acme-offer',
  /** As `acme-offer`, plus the explicitly named project Orion with person and company links. */
  acmeProject: 'acme-project',
  /** Ola Nowak <ola.nowak@gmail.example>: a person from a free-mail address, no company. */
  freeMailPerson: 'freemail-person',
  /** `relevant = false`, nothing extracted. */
  irrelevant: 'irrelevant',
} as const;

/** Test switches, as `hubfx:<name>` tokens anywhere in the user prompt. */
export const FAKE_HUB_SWITCHES = {
  refuse: 'refuse',
  /** Schema failure on the first call for this prompt, the fixture on the retry. */
  badOnce: 'bad-once',
  /** Schema failure on every call. */
  badTwice: 'bad-twice',
  /** A password in the first person's (else the first company's) `evidence`. */
  plantedPassword: 'planted-password',
  /** A summary that is only an access token, so the output inspection excludes it wholly. */
  excludedSummary: 'excluded-summary',
  /** Triage answers `automated` with confidence 0.95 (default: `human`, 0.9). */
  triageAutomated: 'triage-automated',
  /** Triage throws a transport error. */
  triageError: 'triage-error',
} as const;

/** The token to put into a fixture message body. */
export function fakeHubMarker(name: string): string {
  return `hubfx:${name}`;
}

const PLANTED_PASSWORD = 'Login: jan, hasło: Tr0ub4dor&3xQ';
const EXCLUDED_SUMMARY = 'ghp_0123456789abcdefghijABCDEFGHIJ012345';

interface FixturePerson {
  /** Matched against the `<participants>` addresses; a person not among them is left out. */
  address: string;
  name: string;
  roleTitle?: string;
  roleTitleBasis?: HubFactBasis;
  phone?: string;
  phoneBasis?: HubFactBasis;
  companyRef?: string;
  confidence: number;
  evidence: string;
}

interface FixtureCompany {
  ref: string;
  name: string;
  domain: string | null;
  website?: string;
  industry?: string;
  industryConfidence?: number;
  basis: HubFactBasis;
  confidence: number;
  evidence: string;
}

interface FixtureProject {
  ref: string;
  name: string;
  description?: string;
  status?: HubProjectStatus;
  explicitlyNamed: boolean;
  confidence: number;
  evidence: string;
}

interface FixtureLink {
  kind: HubLinkKind;
  /** A person address or a company or project ref. */
  from: string;
  to: string;
  role?: string;
  roleConfidence?: number;
  basis: HubFactBasis;
  confidence: number;
  evidence: string;
}

interface HubFixture {
  relevant: boolean;
  language: HubExtraction['language'];
  summary: string;
  people: FixturePerson[];
  companies: FixtureCompany[];
  projects: FixtureProject[];
  links: FixtureLink[];
}

const JAN: FixturePerson = {
  address: 'jan@acme.example',
  name: 'Jan Kowalski',
  roleTitle: 'Kierownik zakupów',
  roleTitleBasis: 'signature',
  phone: '+48 601 234 567',
  phoneBasis: 'signature',
  companyRef: 'C1',
  confidence: 0.95,
  evidence: 'Jan Kowalski, Kierownik zakupów, Acme Sp. z o.o.',
};

const ACME: FixtureCompany = {
  ref: 'C1',
  name: 'Acme Sp. z o.o.',
  domain: 'acme.example',
  website: 'https://acme.example/',
  industry: 'Budownictwo',
  industryConfidence: 0.6,
  basis: 'domain',
  confidence: 0.92,
  evidence: 'Acme Sp. z o.o.',
};

const JAN_WORKS_AT_ACME: FixtureLink = {
  kind: 'person_company',
  from: JAN.address,
  to: 'C1',
  role: 'Kierownik zakupów',
  roleConfidence: 0.9,
  basis: 'signature',
  confidence: 0.92,
  evidence: 'Kierownik zakupów, Acme Sp. z o.o.',
};

const HUB_FIXTURES: Record<string, HubFixture> = {
  [FAKE_HUB_FIXTURES.acmeOffer]: {
    relevant: true,
    language: 'pl',
    summary: 'Jan Kowalski z Acme poprosił o ofertę na dostawę stali. Ustalono, że oferta zostanie wysłana w tym tygodniu.',
    people: [JAN],
    companies: [ACME],
    projects: [],
    links: [JAN_WORKS_AT_ACME],
  },
  [FAKE_HUB_FIXTURES.acmeProject]: {
    relevant: true,
    language: 'pl',
    summary: 'Jan Kowalski z Acme omówił harmonogram projektu Orion. Kolejne spotkanie zaplanowano na przyszły tydzień.',
    people: [JAN],
    companies: [ACME],
    projects: [
      {
        ref: 'J1',
        name: 'Orion',
        description: 'Dostawa stali dla budowy hali.',
        status: 'active',
        explicitlyNamed: true,
        confidence: 0.9,
        evidence: 'harmonogram projektu Orion',
      },
    ],
    links: [
      JAN_WORKS_AT_ACME,
      { kind: 'person_project', from: JAN.address, to: 'J1', basis: 'text', confidence: 0.88, evidence: 'prowadzę projekt Orion' },
      { kind: 'company_project', from: 'C1', to: 'J1', basis: 'text', confidence: 0.9, evidence: 'Acme realizuje projekt Orion' },
    ],
  },
  [FAKE_HUB_FIXTURES.freeMailPerson]: {
    relevant: true,
    language: 'en',
    summary: 'Ola Nowak asked about the workshop dates and confirmed she will attend.',
    people: [{ address: 'ola.nowak@gmail.example', name: 'Ola Nowak', confidence: 0.9, evidence: 'Best, Ola Nowak' }],
    companies: [],
    projects: [],
    links: [],
  },
  [FAKE_HUB_FIXTURES.irrelevant]: {
    relevant: false,
    language: 'other',
    summary: '',
    people: [],
    companies: [],
    projects: [],
    links: [],
  },
};

const blockOf = (user: string, tag: string): string =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(user)?.[1] ?? '';

const markersIn = (text: string): Set<string> => new Set([...text.matchAll(HUB_MARKER)].map((m) => m[1]!));

/** `<participants>` lines: `Pn | name | address | flags | sent:yes/no`, keyed by address. */
function participantKeys(user: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of blockOf(user, 'participants').split('\n')) {
    const [key, , address] = line.split(' | ').map((c) => c.trim());
    if (key && address && /^P[0-9]+$/.test(key)) keys.set(address.toLowerCase(), key);
  }
  return keys;
}

/** `<known_records>` lines `id | name | hash` per section, as folded name -> id. */
function knownIds(user: string): Record<'people' | 'companies' | 'projects', Map<string, string>> {
  const out = { people: new Map<string, string>(), companies: new Map<string, string>(), projects: new Map<string, string>() };
  let section: keyof typeof out | undefined;
  for (const line of blockOf(user, 'known_records').split('\n')) {
    const header = /^(people|companies|projects):$/.exec(line.trim());
    if (header) {
      section = header[1] as keyof typeof out;
      continue;
    }
    const [id, name] = line.split(' | ').map((c) => c.trim());
    if (section && id && name) out[section].set(foldName(name), id);
  }
  return out;
}

function fakeHubExtraction(fixture: HubFixture, user: string, switches: Set<string>): HubExtraction {
  const keys = participantKeys(user);
  const known = knownIds(user);
  const keyOf = (ref: string) => (ref.includes('@') ? keys.get(ref) : ref);
  const people = fixture.people
    .filter((p) => keys.has(p.address))
    .map((p) => ({
      participantKey: keys.get(p.address)!,
      existingPersonId: known.people.get(foldName(p.name)) ?? null,
      name: p.name,
      isHuman: true,
      roleTitle: p.roleTitle ?? null,
      roleTitleBasis: p.roleTitleBasis ?? null,
      phone: p.phone ?? null,
      phoneBasis: p.phoneBasis ?? null,
      companyRef: p.companyRef ?? null,
      confidence: p.confidence,
      evidence: p.evidence,
    }));
  const companies = fixture.companies.map((c) => ({
    ref: c.ref,
    existingCompanyId: known.companies.get(foldName(c.name)) ?? null,
    name: c.name,
    domain: c.domain,
    website: c.website ?? null,
    industry: c.industry ?? null,
    industryConfidence: c.industryConfidence ?? null,
    basis: c.basis,
    confidence: c.confidence,
    evidence: c.evidence,
  }));
  const projects = fixture.projects.map((j) => ({
    ref: j.ref,
    existingProjectId: known.projects.get(foldName(j.name)) ?? null,
    name: j.name,
    description: j.description ?? null,
    status: j.status ?? null,
    explicitlyNamed: j.explicitlyNamed,
    confidence: j.confidence,
    evidence: j.evidence,
  }));
  const links = fixture.links.flatMap((l) => {
    const from = keyOf(l.from);
    const to = keyOf(l.to);
    if (from === undefined || to === undefined) return [];
    return [
      {
        kind: l.kind,
        from,
        to,
        role: l.role ?? null,
        roleConfidence: l.roleConfidence ?? null,
        basis: l.basis,
        confidence: l.confidence,
        evidence: l.evidence,
      },
    ];
  });
  const output: HubExtraction = { relevant: fixture.relevant, language: fixture.language, summary: fixture.summary, people, companies, projects, links };
  if (switches.has(FAKE_HUB_SWITCHES.plantedPassword)) {
    const target = output.people[0] ?? output.companies[0];
    if (target) target.evidence = PLANTED_PASSWORD;
  }
  if (switches.has(FAKE_HUB_SWITCHES.excludedSummary)) output.summary = EXCLUDED_SUMMARY;
  return output;
}

/** Fails `hubExtractionSchema`, so `createFakeLlm` throws a ZodError like an unparseable answer. */
const BAD_HUB_OUTPUT = { relevant: 'yes' };

function createHubResponder(): (user: string) => HubExtraction | typeof BAD_HUB_OUTPUT {
  const calls = new Map<string, number>();
  return (user) => {
    const switches = markersIn(user);
    if (switches.has(FAKE_HUB_SWITCHES.refuse)) throw new LlmRefusedError();
    const n = (calls.get(user) ?? 0) + 1;
    calls.set(user, n);
    if (switches.has(FAKE_HUB_SWITCHES.badTwice)) return BAD_HUB_OUTPUT;
    if (switches.has(FAKE_HUB_SWITCHES.badOnce) && n === 1) return BAD_HUB_OUTPUT;
    const id = [...markersIn(blockOf(user, 'messages'))].find((m) => Object.hasOwn(HUB_FIXTURES, m));
    return fakeHubExtraction(HUB_FIXTURES[id ?? FAKE_HUB_FIXTURES.irrelevant]!, user, switches);
  };
}

function fakeHubTriage(user: string): HubTriage {
  const switches = markersIn(user);
  if (switches.has(FAKE_HUB_SWITCHES.refuse)) throw new LlmRefusedError();
  if (switches.has(FAKE_HUB_SWITCHES.triageError)) throw Object.assign(new Error('fake_llm_unavailable'), { status: 503 });
  return switches.has(FAKE_HUB_SWITCHES.triageAutomated)
    ? { kind: 'automated', confidence: 0.95, reason: 'Templated notification from a system sender.' }
    : { kind: 'human', confidence: 0.9, reason: 'A personal message written to the recipient.' };
}

/**
 * Deterministic generation LLM for tests: answers profile and document schemas from the `<sample>` blocks in the user prompt,
 * draft schemas from its `Brief: ` line, and the hub extraction and triage schemas from `hubfx:` tokens
 * (`FAKE_HUB_FIXTURES`, `FAKE_HUB_SWITCHES`); the output is validated against the caller's schema by `createFakeLlm`.
 */
export function createFakeGenerationLlm(): LlmClient {
  const hub = createHubResponder();
  return createFakeLlm((args) => {
    if (args.schema === hubExtractionSchema) return hub(args.user);
    if (args.schema === hubTriageSchema) return fakeHubTriage(args.user);
    const dimensions = profileSchemaDimensions(args.schema);
    if (dimensions !== undefined) return fakeProfile(dimensions, args.user);
    if (isDocumentOutputSchema(args.schema)) return fakeDocument(args.user);
    const contentType = draftSchemaContentType(args.schema);
    if (contentType !== undefined) return fakeDraft(contentType, args.user);
    throw new Error('fake_llm_unsupported');
  });
}
