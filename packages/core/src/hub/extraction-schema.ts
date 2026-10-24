import { z } from 'zod';
import type { HubFactBasis, HubLinkKind, HubProjectStatus } from '@voicespark/db';
import { validateContactValue } from '@voicespark/filters';
import { isFreeMailDomain, normalizeWebsite } from './normalize';

// Structured output of the extraction call (contracts/hub-extraction.md section 8) and its
// post-validation (section 7). The JSON schema sent to the API must stay within 16 nullable or
// `anyOf` parameters; every field below that is `.nullable()` counts, so do not add more.

/** One call plus one retry on a schema or parse failure; the output is never repaired by a second call. */
export const MAX_LLM_CALLS = 2;

export const HUB_EXTRACTION_LIMITS = {
  people: 40,
  companies: 20,
  projects: 20,
  links: 60,
  summary: 800,
  name: 200,
  evidence: 200,
  roleTitle: 200,
  phone: 50,
  domain: 253,
  website: 300,
  industry: 200,
  description: 500,
  linkRole: 100,
  key: 20,
} as const;

export const HUB_PHONE_RE = /^[0-9+()\-.\s/x]*$/;

export interface HubExtraction {
  relevant: boolean;
  language: 'pl' | 'en' | 'other';
  summary: string; // <= 800 chars
  people: {
    participantKey: string;
    existingPersonId: string | null;
    name: string;
    isHuman: boolean;
    roleTitle: string | null;
    roleTitleBasis: HubFactBasis | null;
    phone: string | null;
    phoneBasis: HubFactBasis | null;
    companyRef: string | null;
    confidence: number;
    evidence: string;
  }[];
  companies: {
    ref: string;
    existingCompanyId: string | null;
    name: string;
    domain: string | null;
    website: string | null;
    industry: string | null;
    industryConfidence: number | null;
    basis: HubFactBasis;
    confidence: number;
    evidence: string;
  }[];
  projects: {
    ref: string;
    existingProjectId: string | null;
    name: string;
    description: string | null;
    status: HubProjectStatus | null;
    explicitlyNamed: boolean;
    confidence: number;
    evidence: string;
  }[];
  links: {
    kind: HubLinkKind;
    from: string;
    to: string;
    role: string | null;
    roleConfidence: number | null;
    basis: HubFactBasis;
    confidence: number;
    evidence: string;
  }[];
}

export type HubExtractedPerson = HubExtraction['people'][number];
export type HubExtractedCompany = HubExtraction['companies'][number];
export type HubExtractedProject = HubExtraction['projects'][number];
export type HubExtractedLink = HubExtraction['links'][number];

// Factories, not shared constants: `betaZodOutputFormat` converts with `reused: 'ref'`, and a reused
// instance would become a `$ref`, which hides it from the nullable count.
const L = HUB_EXTRACTION_LIMITS;
const text = (max: number, min = 0) => z.string().trim().min(min).max(max);
const nullableText = (max: number) => z.string().trim().max(max).nullable();
const uuidOrNull = () => z.uuid().nullable();
const fieldBasis = () => z.enum(['header', 'signature', 'text']);
const factBasis = () => z.enum(['header', 'domain', 'signature', 'text']);

const personSchema = z.strictObject({
  participantKey: text(L.key),
  existingPersonId: uuidOrNull(),
  name: text(L.name, 1),
  isHuman: z.boolean(),
  roleTitle: nullableText(L.roleTitle),
  roleTitleBasis: fieldBasis().nullable(),
  phone: nullableText(L.phone),
  phoneBasis: fieldBasis().nullable(),
  companyRef: nullableText(L.key),
  confidence: z.number(),
  evidence: text(L.evidence),
});

const companySchema = z.strictObject({
  ref: text(L.key),
  existingCompanyId: uuidOrNull(),
  name: text(L.name, 1),
  domain: nullableText(L.domain),
  website: nullableText(L.website),
  industry: nullableText(L.industry),
  industryConfidence: z.number().nullable(),
  basis: factBasis(),
  confidence: z.number(),
  evidence: text(L.evidence),
});

const projectSchema = z.strictObject({
  ref: text(L.key),
  existingProjectId: uuidOrNull(),
  name: text(L.name, 1),
  description: nullableText(L.description),
  status: z.enum(['planned', 'active', 'on_hold', 'completed']).nullable(),
  explicitlyNamed: z.boolean(),
  confidence: z.number(),
  evidence: text(L.evidence),
});

const linkSchema = z.strictObject({
  kind: z.enum(['person_company', 'person_project', 'company_project']),
  from: text(L.key),
  to: text(L.key),
  role: nullableText(L.linkRole),
  roleConfidence: z.number().nullable(),
  basis: factBasis(),
  confidence: z.number(),
  evidence: text(L.evidence),
});

export const hubExtractionSchema: z.ZodType<HubExtraction> = z.strictObject({
  relevant: z.boolean(),
  language: z.enum(['pl', 'en', 'other']),
  summary: text(L.summary),
  people: z.array(personSchema).max(L.people),
  companies: z.array(companySchema).max(L.companies),
  projects: z.array(projectSchema).max(L.projects),
  links: z.array(linkSchema).max(L.links),
});

/** Output of the optional triage call (section 5). */
export const hubTriageSchema = z.strictObject({
  kind: z.enum(['human', 'automated']),
  confidence: z.number(),
  reason: z.string().trim().max(300),
});
export type HubTriage = z.infer<typeof hubTriageSchema>;

/** What the model was allowed to reference: the `P1..Pn` keys and the ids listed in `<known_records>`. */
export interface HubExtractionContext {
  participantKeys: Iterable<string>;
  knownPersonIds: Iterable<string>;
  knownCompanyIds: Iterable<string>;
  knownProjectIds: Iterable<string>;
}

const clamp = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const cap = (s: string, max: number): string => s.trim().slice(0, max).trim();

/** Trimmed and capped; empty becomes null. */
const capOrNull = (s: string | null, max: number): string | null => {
  if (s === null) return null;
  const v = cap(s, max);
  return v === '' ? null : v;
};

function checkPhone(raw: string | null): string | null {
  const v = capOrNull(raw, L.phone);
  if (v === null || !HUB_PHONE_RE.test(v)) return null;
  return validateContactValue('phone', v);
}

function checkDomain(raw: string | null): string | null {
  const v = capOrNull(raw, L.domain);
  if (v === null) return null;
  const domain = validateContactValue('domain', v);
  return domain === null || isFreeMailDomain(domain) ? null : domain;
}

function checkWebsite(raw: string | null): string | null {
  const v = capOrNull(raw, L.website);
  const url = v === null ? null : normalizeWebsite(v);
  if (url === null || url.length > L.website) return null;
  const u = new URL(url);
  return u.username || u.password ? null : url;
}

/** Keeps the first entry per key; later duplicates are dropped. */
function firstByKey<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const knownOrNull = (id: string | null, ids: Set<string>): boolean => id === null || ids.has(id);

/**
 * Section 7 post-validation over a parsed output: clamps confidences, trims and caps fields, checks phones
 * (regex and `validateContactValue`), domains (`validateContactValue('domain')`, never free-mail) and
 * websites, drops items with an unknown `participantKey`, `ref` or `existing*Id`, nulls a `companyRef` that
 * does not resolve and drops links whose ends do not resolve. A basis or role confidence without its value
 * becomes null.
 */
export function postValidateExtraction(output: HubExtraction, context: HubExtractionContext): HubExtraction {
  const participantKeys = new Set(context.participantKeys);
  const personIds = new Set(context.knownPersonIds);
  const companyIds = new Set(context.knownCompanyIds);
  const projectIds = new Set(context.knownProjectIds);

  const companies = firstByKey(
    output.companies
      .slice(0, L.companies)
      .map((c) => ({ ...c, ref: cap(c.ref, L.key), name: cap(c.name, L.name) }))
      .filter((c) => /^C[0-9]+$/.test(c.ref) && c.name !== '' && knownOrNull(c.existingCompanyId, companyIds)),
    (c) => c.ref,
  ).map((c) => {
    const industry = capOrNull(c.industry, L.industry);
    return {
      ...c,
      domain: checkDomain(c.domain),
      website: checkWebsite(c.website),
      industry,
      industryConfidence: industry === null ? null : clamp(c.industryConfidence ?? 0),
      confidence: clamp(c.confidence),
      evidence: cap(c.evidence, L.evidence),
    };
  });
  const companyRefs = new Set(companies.map((c) => c.ref));

  const projects = firstByKey(
    output.projects
      .slice(0, L.projects)
      .map((p) => ({ ...p, ref: cap(p.ref, L.key), name: cap(p.name, L.name) }))
      .filter((p) => /^J[0-9]+$/.test(p.ref) && p.name !== '' && knownOrNull(p.existingProjectId, projectIds)),
    (p) => p.ref,
  ).map((p) => ({
    ...p,
    description: capOrNull(p.description, L.description),
    confidence: clamp(p.confidence),
    evidence: cap(p.evidence, L.evidence),
  }));
  const projectRefs = new Set(projects.map((p) => p.ref));

  const people = firstByKey(
    output.people
      .slice(0, L.people)
      .map((p) => ({ ...p, participantKey: cap(p.participantKey, L.key), name: cap(p.name, L.name) }))
      .filter(
        (p) =>
          participantKeys.has(p.participantKey) && p.name !== '' && knownOrNull(p.existingPersonId, personIds),
      ),
    (p) => p.participantKey,
  ).map((p) => {
    const roleTitle = capOrNull(p.roleTitle, L.roleTitle);
    const phone = checkPhone(p.phone);
    const companyRef = p.companyRef === null ? null : cap(p.companyRef, L.key);
    return {
      ...p,
      roleTitle,
      roleTitleBasis: roleTitle === null ? null : p.roleTitleBasis,
      phone,
      phoneBasis: phone === null ? null : p.phoneBasis,
      companyRef: companyRef !== null && companyRefs.has(companyRef) ? companyRef : null,
      confidence: clamp(p.confidence),
      evidence: cap(p.evidence, L.evidence),
    };
  });
  const personKeys = new Set(people.map((p) => p.participantKey));

  const resolves = (kind: HubLinkKind, from: string, to: string): boolean => {
    switch (kind) {
      case 'person_company':
        return personKeys.has(from) && companyRefs.has(to);
      case 'person_project':
        return personKeys.has(from) && projectRefs.has(to);
      case 'company_project':
        return companyRefs.has(from) && projectRefs.has(to);
    }
  };
  const links = output.links
    .slice(0, L.links)
    .map((l) => ({ ...l, from: cap(l.from, L.key), to: cap(l.to, L.key) }))
    .filter((l) => resolves(l.kind, l.from, l.to))
    .map((l) => {
      const role = capOrNull(l.role, L.linkRole);
      return {
        ...l,
        role,
        roleConfidence: role === null ? null : clamp(l.roleConfidence ?? 0),
        confidence: clamp(l.confidence),
        evidence: cap(l.evidence, L.evidence),
      };
    });

  return {
    relevant: output.relevant,
    language: output.language,
    summary: cap(output.summary, L.summary),
    people,
    companies,
    projects,
    links,
  };
}
