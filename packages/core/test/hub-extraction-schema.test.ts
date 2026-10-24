import { describe, expect, it } from 'vitest';
import { createAnthropicClient } from '@voicespark/integrations/anthropic';
import {
  HUB_EXTRACTION_LIMITS,
  MAX_LLM_CALLS,
  hubExtractionSchema,
  hubTriageSchema,
  postValidateExtraction,
  type HubExtraction,
  type HubExtractionContext,
} from '../src/hub/extraction-schema';

const PERSON_ID = '6f1c2a40-0000-4000-8000-000000000001';
const COMPANY_ID = '6f1c2a40-0000-4000-8000-0000000000c1';
const PROJECT_ID = '6f1c2a40-0000-4000-8000-0000000000a1';
const UNKNOWN_ID = '6f1c2a40-0000-4000-8000-0000000000ff';

const CONTEXT: HubExtractionContext = {
  participantKeys: ['P1', 'P2'],
  knownPersonIds: [PERSON_ID],
  knownCompanyIds: [COMPANY_ID],
  knownProjectIds: [PROJECT_ID],
};

function person(overrides: Partial<HubExtraction['people'][number]> = {}): HubExtraction['people'][number] {
  return {
    participantKey: 'P1',
    existingPersonId: null,
    name: 'Jan Kowalski',
    isHuman: true,
    roleTitle: 'Kierownik zakupów',
    roleTitleBasis: 'signature',
    phone: '+48 600 100 200',
    phoneBasis: 'signature',
    companyRef: 'C1',
    confidence: 0.9,
    evidence: 'Jan Kowalski, Kierownik zakupów',
    ...overrides,
  };
}

function company(overrides: Partial<HubExtraction['companies'][number]> = {}): HubExtraction['companies'][number] {
  return {
    ref: 'C1',
    existingCompanyId: null,
    name: 'Stalbud Sp. z o.o.',
    domain: 'stalbud.example',
    website: null,
    industry: 'construction',
    industryConfidence: 0.6,
    basis: 'signature',
    confidence: 0.9,
    evidence: 'Stalbud Sp. z o.o.',
    ...overrides,
  };
}

function project(overrides: Partial<HubExtraction['projects'][number]> = {}): HubExtraction['projects'][number] {
  return {
    ref: 'J1',
    existingProjectId: null,
    name: 'Orion',
    description: null,
    status: 'planned',
    explicitlyNamed: true,
    confidence: 0.9,
    evidence: 'kickoff projektu Orion',
    ...overrides,
  };
}

function link(overrides: Partial<HubExtraction['links'][number]> = {}): HubExtraction['links'][number] {
  return {
    kind: 'person_company',
    from: 'P1',
    to: 'C1',
    role: 'Kierownik zakupów',
    roleConfidence: 0.9,
    basis: 'signature',
    confidence: 0.9,
    evidence: 'Kierownik zakupów',
    ...overrides,
  };
}

function output(overrides: Partial<HubExtraction> = {}): HubExtraction {
  return {
    relevant: true,
    language: 'pl',
    summary: 'Jan Kowalski przesłał ofertę.',
    people: [person()],
    companies: [company()],
    projects: [project()],
    links: [link()],
    ...overrides,
  };
}

/** The JSON schema exactly as the client sends it (`betaZodOutputFormat` inside `parseStructured`). */
async function sentJsonSchema(): Promise<Record<string, unknown>> {
  let params: Record<string, unknown> | undefined;
  const client = createAnthropicClient({
    apiKey: 'test',
    sdk: {
      beta: {
        messages: {
          parse: async (p) => {
            params = p;
            return { stop_reason: 'end_turn', parsed_output: output() };
          },
          stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', parsed_output: output() }) }),
        },
      },
    },
  });
  await client.parseStructured({
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    maxTokens: 16000,
    system: 's',
    user: 'u',
    schema: hubExtractionSchema,
  });
  const format = (params?.output_config as { format: { schema: Record<string, unknown> } }).format;
  return format.schema;
}

/** Nullable or `anyOf` parameters, following each `$ref` every time it is used. */
function countUnionParameters(root: Record<string, unknown>): number {
  const defs = (root.$defs ?? {}) as Record<string, unknown>;
  const walk = (node: unknown): number => {
    if (Array.isArray(node)) return node.reduce((n: number, v) => n + walk(v), 0);
    if (node === null || typeof node !== 'object') return 0;
    const o = node as Record<string, unknown>;
    let n = 0;
    if (typeof o.$ref === 'string') n += walk(defs[o.$ref.replace('#/$defs/', '')]);
    if (Array.isArray(o.anyOf)) n += 1;
    if (Array.isArray(o.type) && o.type.includes('null')) n += 1;
    for (const [k, v] of Object.entries(o)) if (k !== '$defs') n += walk(v);
    return n;
  };
  return walk(root);
}

describe('hubExtractionSchema', () => {
  it('accepts a contract-shaped output', () => {
    expect(hubExtractionSchema.safeParse(output()).success).toBe(true);
    expect(
      hubExtractionSchema.safeParse(
        output({ people: [person({ roleTitle: null, roleTitleBasis: null, phone: null, phoneBasis: null })] }),
      ).success,
    ).toBe(true);
  });

  it('caps the arrays at 40, 20, 20 and 60', () => {
    expect(HUB_EXTRACTION_LIMITS).toMatchObject({ people: 40, companies: 20, projects: 20, links: 60 });
    const many = <T>(n: number, item: T): T[] => Array.from({ length: n }, () => item);
    expect(hubExtractionSchema.safeParse(output({ people: many(40, person()) })).success).toBe(true);
    expect(hubExtractionSchema.safeParse(output({ people: many(41, person()) })).success).toBe(false);
    expect(hubExtractionSchema.safeParse(output({ companies: many(21, company()) })).success).toBe(false);
    expect(hubExtractionSchema.safeParse(output({ projects: many(21, project()) })).success).toBe(false);
    expect(hubExtractionSchema.safeParse(output({ links: many(60, link()) })).success).toBe(true);
    expect(hubExtractionSchema.safeParse(output({ links: many(61, link()) })).success).toBe(false);
  });

  it('enforces string limits after trimming', () => {
    const ok = (o: HubExtraction) => hubExtractionSchema.safeParse(o).success;
    expect(ok(output({ summary: 'a'.repeat(800) }))).toBe(true);
    expect(ok(output({ summary: 'a'.repeat(801) }))).toBe(false);
    expect(ok(output({ summary: `  ${'a'.repeat(800)}  ` }))).toBe(true);
    expect(ok(output({ people: [person({ name: '' })] }))).toBe(false);
    expect(ok(output({ people: [person({ name: 'a'.repeat(201) })] }))).toBe(false);
    expect(ok(output({ people: [person({ evidence: 'a'.repeat(201) })] }))).toBe(false);
    expect(ok(output({ people: [person({ phone: '1'.repeat(51) })] }))).toBe(false);
    expect(ok(output({ companies: [company({ domain: 'a'.repeat(254) })] }))).toBe(false);
    expect(ok(output({ companies: [company({ website: 'a'.repeat(301) })] }))).toBe(false);
    expect(ok(output({ projects: [project({ description: 'a'.repeat(501) })] }))).toBe(false);
    expect(ok(output({ links: [link({ role: 'a'.repeat(101) })] }))).toBe(false);
    const parsed = hubExtractionSchema.parse(output({ summary: '  trimmed  ' }));
    expect(parsed.summary).toBe('trimmed');
  });

  it('checks enums, uuids and unknown keys', () => {
    const bad = (o: unknown) => hubExtractionSchema.safeParse(o).success;
    expect(bad({ ...output(), language: 'de' })).toBe(false);
    expect(bad(output({ people: [person({ roleTitleBasis: 'domain' as never })] }))).toBe(false);
    expect(bad(output({ companies: [company({ basis: 'domain' })] }))).toBe(true);
    expect(bad(output({ projects: [project({ status: 'cancelled' as never })] }))).toBe(false);
    expect(bad(output({ projects: [project({ status: null })] }))).toBe(true);
    expect(bad(output({ links: [link({ kind: 'person_person' as never })] }))).toBe(false);
    expect(bad(output({ people: [person({ existingPersonId: 'not-a-uuid' })] }))).toBe(false);
    expect(bad({ ...output(), extra: 1 })).toBe(false);
  });

  it('stays within 16 nullable or anyOf parameters in the JSON schema the client sends', async () => {
    const schema = await sentJsonSchema();
    expect(countUnionParameters(schema)).toBeLessThanOrEqual(16);
    // Nullable enums are written as anyOf, never as `null` inside `enum`.
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"enum":\[[^\]]*null/);
    const people = schema.$defs ? Object.values(schema.$defs as Record<string, { properties: Record<string, unknown> }>)
      .find((d) => 'participantKey' in d.properties) : undefined;
    const props = people?.properties ?? (schema.properties as { people: { items: { properties: Record<string, unknown> } } }).people.items.properties;
    expect(props.roleTitleBasis).toHaveProperty('anyOf');
    expect(props.phoneBasis).toHaveProperty('anyOf');
  });

  it('defines the triage output', () => {
    expect(hubTriageSchema.safeParse({ kind: 'automated', confidence: 0.8, reason: 'Bulk headers.' }).success).toBe(true);
    expect(hubTriageSchema.safeParse({ kind: 'robot', confidence: 0.8, reason: '' }).success).toBe(false);
  });

  it('allows one retry only', () => {
    expect(MAX_LLM_CALLS).toBe(2);
  });
});

describe('postValidateExtraction', () => {
  it('clamps confidences to 0..1', () => {
    const out = postValidateExtraction(
      output({
        people: [person({ confidence: 1.4 })],
        companies: [company({ confidence: -0.2, industryConfidence: 3 })],
        projects: [project({ confidence: Number.NaN })],
        links: [link({ confidence: 2, roleConfidence: -1 })],
      }),
      CONTEXT,
    );
    expect(out.people[0]?.confidence).toBe(1);
    expect(out.companies[0]?.confidence).toBe(0);
    expect(out.companies[0]?.industryConfidence).toBe(1);
    expect(out.projects[0]?.confidence).toBe(0);
    expect(out.links[0]).toMatchObject({ confidence: 1, roleConfidence: 0 });
  });

  it('trims and caps fields and caps arrays', () => {
    const out = postValidateExtraction(
      output({
        summary: ` ${'s'.repeat(900)} `,
        people: [person({ name: '  Jan Kowalski  ', evidence: 'e'.repeat(250), roleTitle: '   ' })],
        projects: [project({ description: '  ' })],
        links: Array.from({ length: 70 }, () => link()),
      }),
      CONTEXT,
    );
    expect(out.summary).toHaveLength(800);
    expect(out.people[0]).toMatchObject({ name: 'Jan Kowalski', roleTitle: null, roleTitleBasis: null });
    expect(out.people[0]?.evidence).toHaveLength(200);
    expect(out.projects[0]?.description).toBeNull();
    expect(out.links).toHaveLength(60);
  });

  it('checks phones with the regex and validateContactValue', () => {
    const phone = (p: string) =>
      postValidateExtraction(output({ people: [person({ phone: p })] }), CONTEXT).people[0];
    expect(phone('+48 600 100 200')).toMatchObject({ phone: '+48 600 100 200', phoneBasis: 'signature' });
    expect(phone('call me at 600')).toMatchObject({ phone: null, phoneBasis: null });
    expect(phone('123')).toMatchObject({ phone: null, phoneBasis: null });
  });

  it('drops free-mail and invalid company domains, keeps the company', () => {
    const domain = (d: string) =>
      postValidateExtraction(output({ companies: [company({ domain: d })] }), CONTEXT).companies[0];
    expect(domain('Stalbud.example')?.domain).toBe('stalbud.example');
    expect(domain('gmail.com')?.domain).toBeNull();
    expect(domain('wp.pl')?.domain).toBeNull();
    expect(domain('hotmail.de')?.domain).toBeNull();
    expect(domain('not a domain')?.domain).toBeNull();
    expect(domain('gmail.com')?.name).toBe('Stalbud Sp. z o.o.');
  });

  it('drops unknown participant keys, refs and existing ids', () => {
    const out = postValidateExtraction(
      output({
        people: [
          person({ participantKey: 'P9' }),
          person({ participantKey: 'P2', existingPersonId: UNKNOWN_ID }),
          person({ participantKey: 'P1', existingPersonId: PERSON_ID, companyRef: 'C7' }),
        ],
        companies: [company({ existingCompanyId: UNKNOWN_ID }), company({ ref: 'C2', existingCompanyId: COMPANY_ID }), company({ ref: 'X1' })],
        projects: [project({ existingProjectId: UNKNOWN_ID }), project({ ref: 'J2', existingProjectId: PROJECT_ID })],
        links: [
          link({ from: 'P1', to: 'C2' }),
          link({ from: 'P1', to: 'C1' }),
          link({ from: 'P9', to: 'C2' }),
          link({ kind: 'person_project', from: 'P1', to: 'J2' }),
          link({ kind: 'company_project', from: 'C2', to: 'J1' }),
          link({ kind: 'person_project', from: 'C2', to: 'J2' }),
        ],
      }),
      CONTEXT,
    );
    expect(out.people.map((p) => p.participantKey)).toEqual(['P1']);
    expect(out.people[0]?.companyRef).toBeNull();
    expect(out.companies.map((c) => c.ref)).toEqual(['C2']);
    expect(out.projects.map((p) => p.ref)).toEqual(['J2']);
    expect(out.links.map((l) => `${l.kind}:${l.from}>${l.to}`)).toEqual([
      'person_company:P1>C2',
      'person_project:P1>J2',
    ]);
  });

  it('nulls role confidence and industry confidence without their value', () => {
    const out = postValidateExtraction(
      output({ companies: [company({ industry: null, industryConfidence: 0.5 })], links: [link({ role: null, roleConfidence: 0.7 })] }),
      CONTEXT,
    );
    expect(out.companies[0]?.industryConfidence).toBeNull();
    expect(out.links[0]?.roleConfidence).toBeNull();
  });
});
