import type { HubFactBasis, HubFactType, HubLinkKind } from '@voicespark/db';
import type {
  HubExtractedCompany,
  HubExtractedLink,
  HubExtractedPerson,
  HubExtractedProject,
  HubExtraction,
} from './extraction-schema';
import { factFingerprint, markerKey } from './fingerprint';
import {
  companyMatchName,
  foldName,
  isFreeMailDomain,
  isRoleAddress,
  normalizeAddress,
  normalizeDomain,
  projectMatchName,
  stripPlusTag,
} from './normalize';

// Confidence policy (contracts/hub-extraction.md section 9), a port of the reference POLICY_V1.
// Pure: no I/O. `apply.ts` loads the state inside the per-user lock and writes the decisions.

export interface HubPolicyV1 {
  version: 'hub-policy-v1';
  /** Minimum confidence for a person field, company name or link to auto-apply. */
  autoConfidence: 0.8;
  /** Minimum confidence for industry, a new explicitly named project and a project-link role. */
  strongAutoConfidence: 0.85;
  /** Below this a suggestion is dropped (unless tombstoned). */
  suggestFloor: 0.7;
  /** Applied by the caller when it fills `PolicyParticipant.directToOnOwnerSent`. */
  maxOwnerToRecipients: 5;
  /** Generic project names, as `foldName` renders them. */
  genericProjectStoplist: readonly string[];
}

export const HUB_POLICY_V1: HubPolicyV1 = {
  version: 'hub-policy-v1',
  autoConfidence: 0.8,
  strongAutoConfidence: 0.85,
  suggestFloor: 0.7,
  maxOwnerToRecipients: 5,
  genericProjectStoplist: [
    'project', 'projekt', 'deal', 'umowa', 'oferta', 'zlecenie', 'sprawa', 'temat', 'the project', 'nasz projekt',
    'wspolpraca', 'wdrozenie', 'implementation', 'proposal',
  ],
};

export type PolicyExtraction = HubExtraction;
export type HubRecordKind = 'person' | 'company' | 'project';

/** A participant of the thread, as sent to the model plus what only the processor knows. */
export interface PolicyParticipant {
  /** P1...Pn */
  key: string;
  address: string;
  name: string | null;
  /** Number of messages this participant sent in the thread. */
  sent: number;
  /** Direct To recipient of an owner-sent message with at most `maxOwnerToRecipients` To recipients. */
  directToOnOwnerSent: boolean;
  /** Classified automated by the header rules or triage. */
  automated?: boolean;
}

/** Decrypted current state of a candidate record, loaded inside the lock. */
export interface PolicyPerson {
  id: string;
  name: string;
  emails: string[];
  /** Ids of the companies the person is linked to. */
  companyIds: string[];
  roleTitle: string | null;
  phone: string | null;
  ownerFields: string[];
  /** When the current email-derived value of a field was applied (decides "newer"). */
  emailFieldAt?: Partial<Record<'roleTitle' | 'phone', Date | null>>;
}

export interface PolicyCompany {
  id: string;
  name: string;
  domains: string[];
  industry: string | null;
  ownerFields: string[];
}

export interface PolicyProject {
  id: string;
  name: string;
  companyIds: string[];
  personIds: string[];
}

export interface PolicyLink {
  id: string;
  kind: HubLinkKind;
  personId: string | null;
  companyId: string | null;
  projectId: string | null;
  role: string | null;
  roleOwnerSet: boolean;
}

export interface HubPolicyState {
  userId: string;
  threadId: string;
  /** Date of the newest message in the thread. */
  threadDate: Date;
  participants: PolicyParticipant[];
  /** Normalised owner identities (connected and disconnected source addresses). */
  ownerAddresses: ReadonlySet<string>;
  /** Non-free domains of the owner identities. */
  ownerDomains: ReadonlySet<string>;
  /** Decrypted `hub_ignore_rule` values; addresses compared with the `+tag` stripped, domains with subdomains. */
  ignoredAddresses: ReadonlySet<string>;
  ignoredDomains: ReadonlySet<string>;
  people: PolicyPerson[];
  companies: PolicyCompany[];
  projects: PolicyProject[];
  links: PolicyLink[];
  /** `hub_block_marker.key_hash` values found for `blockMarkerKeys(...)`. */
  blockMarkers: ReadonlySet<string>;
  /** Fingerprints of facts rejected with this thread among their evidence. */
  rejectedFingerprints: ReadonlySet<string>;
  /** `hub_merge_redirect` from_id -> to_id, for the model's `existing*Id` values. */
  redirects?: ReadonlyMap<string, string>;
}

export interface LinkEnd {
  kind: HubRecordKind;
  id: string | null;
  ref: string | null;
}

/** Link endpoints in canonical order (person < company < project, as `markerKey.link`). */
export interface LinkDraft {
  kind: HubLinkKind;
  a: LinkEnd;
  b: LinkEnd;
  /** The existing `hub_link` row when one matched. */
  linkId: string | null;
}

export interface HubFactDraft {
  type: HubFactType;
  /** For `link` and `link_role`: the first endpoint (`link.a`). */
  target: LinkEnd;
  /** `roleTitle`, `phone` or `industry` for type `field`. */
  field: string | null;
  value: Record<string, unknown>;
  previousValue: unknown;
  conflict: boolean;
  confidence: number;
  basis: HubFactBasis;
  evidence: string | null;
  link: LinkDraft | null;
}

export type HubDecisionAction = 'create' | 'match' | 'attach' | 'update' | 'supersede' | 'corroborate';
/** `rejected` only ever accompanies `drop`; the others are the `hub_fact.reason` values. */
export type HubDecisionReason =
  | 'low_confidence'
  | 'conflict'
  | 'tombstoned'
  | 'name_only_match'
  | 'inferred_project'
  | 'rejected';

export interface HubDecision {
  fact: HubFactDraft;
  outcome: 'auto' | 'suggest' | 'drop';
  /** Why the outcome is `suggest` or `drop`; null for `auto`. */
  reason: HubDecisionReason | null;
  action: HubDecisionAction;
  /** Participant key, company ref or project ref of the extraction entry. */
  ref: string | null;
  /** Ref of the decision this one depends on (`depends_on_fact_id` once stored). */
  dependsOnRef: string | null;
  fingerprint: string;
}

type Draft = Omit<HubDecision, 'fingerprint'>;

const KIND_ORDER: HubRecordKind[] = ['person', 'company', 'project'];
const LINK_KIND_ENDS: Record<HubLinkKind, [HubRecordKind, HubRecordKind]> = {
  person_company: ['person', 'company'],
  person_project: ['person', 'project'],
  company_project: ['company', 'project'],
};
const COMPOUND_SUFFIX_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

const digits = (s: string): string => s.replace(/\D/g, '');
const sameValue = (field: string, a: string, b: string): boolean =>
  field === 'phone' ? digits(a) !== '' && digits(a) === digits(b) : foldName(a) === foldName(b);
const domainOfAddress = (address: string): string => normalizeAddress(address).split('@')[1] ?? '';
const resolveId = (state: HubPolicyState, id: string | null): string | null =>
  id === null ? null : (state.redirects?.get(id) ?? id);

/** True when the domain or one of its parent domains is in `domains`. */
function domainCovered(domains: ReadonlySet<string>, domain: string): boolean {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) if (domains.has(labels.slice(i).join('.'))) return true;
  return false;
}

/** The capitalised second-level label (`acme-consulting.com.pl` -> `Acme-consulting`). */
export function companyNameFromDomain(domain: string): string {
  const labels = domain.split('.').filter(Boolean);
  let i = labels.length - 2;
  if (i >= 1 && COMPOUND_SUFFIX_LABELS.has(labels[i] ?? '') && (labels[labels.length - 1] ?? '').length === 2) i -= 1;
  const label = labels[Math.max(i, 0)] ?? '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function isGenericProjectName(policy: HubPolicyV1, name: string): boolean {
  const folded = foldName(name);
  return folded === '' || policy.genericProjectStoplist.includes(folded) || policy.genericProjectStoplist.includes(projectMatchName(name));
}

function companyDomainOf(c: HubExtractedCompany | undefined): string | null {
  if (!c) return null;
  if (c.domain) return normalizeDomain(c.domain);
  if (!c.website) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(c.website) ? c.website : `https://${c.website}`);
    return normalizeDomain(url.hostname);
  } catch {
    return null;
  }
}

/** Stable identity of a fact target: the record id, else its natural key in this thread. */
function targetIdentity(fact: HubFactDraft): string {
  if (fact.link) {
    const end = (e: LinkEnd) => (e.id ? `${e.kind}:${e.id}` : `${e.kind}:ref:${e.ref ?? ''}`);
    return `${fact.link.kind}:${end(fact.link.a)}:${end(fact.link.b)}`;
  }
  return fact.target.id ? `${fact.target.kind}:${fact.target.id}` : `${fact.target.kind}:ref:${fact.target.ref ?? ''}`;
}

function fingerprintOf(userId: string, fact: HubFactDraft): string {
  const value = JSON.stringify({ field: fact.field, ...fact.value });
  return factFingerprint(userId, fact.type, targetIdentity(fact), value);
}

/**
 * Appends a decision after the downgrades every decision gets (section 9 "Common downgrades"): a
 * rejected fingerprint drops it, a block marker on one of `keys` turns auto into a tombstoned
 * suggestion, and a suggestion under the floor is dropped unless tombstoned.
 */
function pusher(policy: HubPolicyV1, state: HubPolicyState, out: HubDecision[]) {
  return (draft: Draft, keys: string[]): HubDecision => {
    const fingerprint = fingerprintOf(state.userId, draft.fact);
    let { outcome, reason } = draft;
    const marked = keys.some((k) => state.blockMarkers.has(k));
    if (outcome !== 'drop' && state.rejectedFingerprints.has(fingerprint)) {
      outcome = 'drop';
      reason = 'rejected';
    } else if (outcome !== 'drop' && marked) {
      outcome = 'suggest';
      reason = 'tombstoned';
    }
    if (outcome === 'suggest' && draft.fact.confidence < policy.suggestFloor && reason !== 'tombstoned') {
      outcome = 'drop';
      reason = 'low_confidence';
    }
    const decision = { ...draft, outcome, reason, fingerprint };
    out.push(decision);
    return decision;
  };
}

function draft(
  type: HubFactType,
  target: LinkEnd,
  field: string | null,
  value: Record<string, unknown>,
  confidence: number,
  basis: HubFactBasis,
  evidence: string | null,
  previousValue: unknown = null,
  conflict = false,
  link: LinkDraft | null = null,
): HubFactDraft {
  return { type, target, field, value, previousValue, conflict, confidence, basis, evidence: evidence || null, link };
}

/**
 * Block-marker key hashes that could downgrade a decision; the caller loads the matching
 * `hub_block_marker` rows into `state.blockMarkers`. Link and field keys need the loaded records.
 */
export function blockMarkerKeys(
  extraction: PolicyExtraction,
  state: Pick<HubPolicyState, 'participants'> & Partial<Pick<HubPolicyState, 'people' | 'companies' | 'projects'>>,
): string[] {
  const keys = new Set<string>();
  for (const p of state.participants) keys.add(markerKey.personEmail(p.address));
  for (const c of extraction.companies) {
    keys.add(markerKey.companyName(c.name));
    const d = companyDomainOf(c);
    if (d) keys.add(markerKey.companyDomain(d));
  }
  for (const j of extraction.projects) keys.add(markerKey.projectName(j.name));
  const people = state.people ?? [];
  const companies = state.companies ?? [];
  const projects = state.projects ?? [];
  for (const p of extraction.people) {
    for (const person of people) {
      if (p.roleTitle) keys.add(markerKey.field('person', person.id, 'roleTitle', p.roleTitle));
      if (p.phone) keys.add(markerKey.field('person', person.id, 'phone', p.phone));
    }
  }
  for (const c of extraction.companies) {
    if (c.industry) for (const company of companies) keys.add(markerKey.field('company', company.id, 'industry', c.industry));
  }
  for (const p of people) {
    for (const c of companies) keys.add(markerKey.link('person_company', p.id, c.id));
    for (const j of projects) keys.add(markerKey.link('person_project', p.id, j.id));
  }
  for (const c of companies) for (const j of projects) keys.add(markerKey.link('company_project', c.id, j.id));
  return [...keys];
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

/** Company decisions: match by domain, else by match name; auto-create on business domains. */
export function decideCompanies(extraction: PolicyExtraction, state: HubPolicyState, policy: HubPolicyV1): HubDecision[] {
  const out: HubDecision[] = [];
  const push = pusher(policy, state, out);
  for (const c of extraction.companies) decideCompany(c);
  return out;

  function decideCompany(c: HubExtractedCompany): void {
    const domain = companyDomainOf(c);
    if (domain !== null && (state.ownerDomains.has(domain) || domainCovered(state.ignoredDomains, domain))) return;
    const business = domain !== null && !isFreeMailDomain(domain);
    const norm = companyMatchName(c.name);
    const byName = norm === '' ? [] : state.companies.filter((x) => companyMatchName(x.name) === norm);

    let existing: PolicyCompany | undefined;
    let newDomain = false;
    if (business) {
      existing = state.companies.find((x) => x.domains.some((d) => normalizeDomain(d) === domain));
      // A confidently named company that exists under another domain gains this one.
      if (!existing && byName.length === 1 && c.confidence >= policy.autoConfidence) {
        existing = byName[0];
        newDomain = true;
      }
    } else if (byName.length === 1) {
      existing = byName[0];
    }

    if (existing) {
      const target = { kind: 'company' as const, id: existing.id, ref: c.ref };
      push(
        {
          fact: draft('company', target, null, { name: existing.name }, c.confidence, c.basis, c.evidence),
          outcome: 'auto',
          reason: null,
          action: 'match',
          ref: c.ref,
          dependsOnRef: null,
        },
        [],
      );
      if (newDomain && domain) {
        push(
          {
            fact: draft('company_domain', target, null, { domain }, c.confidence, 'domain', c.evidence),
            outcome: 'auto',
            reason: null,
            action: 'attach',
            ref: c.ref,
            dependsOnRef: null,
          },
          [markerKey.companyDomain(domain)],
        );
      }
      decideIndustry(c, existing);
      return;
    }

    const name = business && c.confidence < policy.autoConfidence ? companyNameFromDomain(domain) : c.name;
    const value = {
      name,
      domain: business ? domain : null,
      website: business ? `https://${domain}` : (c.website ?? null),
    };
    const target = { kind: 'company' as const, id: null, ref: c.ref };
    push(
      {
        fact: draft('company', target, null, value, c.confidence, c.basis, c.evidence),
        outcome: business ? 'auto' : 'suggest',
        reason: business ? null : 'low_confidence',
        action: 'create',
        ref: c.ref,
        dependsOnRef: null,
      },
      [markerKey.companyName(c.name), ...(domain ? [markerKey.companyDomain(domain)] : [])],
    );
    if (business) {
      push(
        {
          fact: draft('company_domain', target, null, { domain }, c.confidence, 'domain', c.evidence),
          outcome: 'auto',
          reason: null,
          action: 'attach',
          ref: c.ref,
          dependsOnRef: c.ref,
        },
        [markerKey.companyDomain(domain)],
      );
    }
  }

  /** `industry` is auto only when empty and at `strongAutoConfidence`; owner-set values conflict. */
  function decideIndustry(c: HubExtractedCompany, existing: PolicyCompany): void {
    if (c.industry === null) return;
    const confidence = c.industryConfidence ?? 0;
    const current = existing.industry;
    const ownerSet = existing.ownerFields.includes('industry');
    const fact = (conflict: boolean) =>
      draft(
        'field',
        { kind: 'company', id: existing.id, ref: c.ref },
        'industry',
        { field: 'industry', value: c.industry },
        confidence,
        c.basis,
        c.evidence,
        current,
        conflict,
      );
    const base = { ref: c.ref, dependsOnRef: null };
    const keys = [markerKey.field('company', existing.id, 'industry', c.industry)];
    if (current !== null && foldName(current) === foldName(c.industry)) {
      if (ownerSet) push({ fact: fact(false), outcome: 'auto', reason: null, action: 'corroborate', ...base }, []);
      return;
    }
    if (ownerSet) {
      push({ fact: fact(true), outcome: 'suggest', reason: 'conflict', action: 'update', ...base }, keys);
    } else if (current === null && confidence >= policy.strongAutoConfidence) {
      push({ fact: fact(false), outcome: 'auto', reason: null, action: 'update', ...base }, keys);
    } else {
      push({ fact: fact(false), outcome: 'suggest', reason: 'low_confidence', action: 'update', ...base }, keys);
    }
  }
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Person decisions; `companyDecisions` supplies the domains attached to existing companies in this thread. */
export function decidePeople(
  extraction: PolicyExtraction,
  state: HubPolicyState,
  policy: HubPolicyV1,
  companyDecisions: HubDecision[],
): HubDecision[] {
  const out: HubDecision[] = [];
  const push = pusher(policy, state, out);
  const participants = new Map(state.participants.map((p) => [p.key, p]));
  const attachedDomains = new Map<string, string>();
  for (const d of companyDecisions) {
    const domain = d.fact.value.domain;
    if (d.fact.type === 'company_domain' && d.outcome !== 'drop' && d.fact.target.id && typeof domain === 'string')
      attachedDomains.set(domain, d.fact.target.id);
  }
  const ignoredAddresses = new Set([...state.ignoredAddresses].map(stripPlusTag));

  const companyOwning = (domain: string): string | undefined =>
    state.companies.find((c) => c.domains.some((d) => normalizeDomain(d) === domain))?.id ?? attachedDomains.get(domain);

  const isExcluded = (address: string): boolean => {
    const a = normalizeAddress(address);
    return (
      state.ownerAddresses.has(a) ||
      ignoredAddresses.has(stripPlusTag(a)) ||
      domainCovered(state.ignoredDomains, domainOfAddress(a)) ||
      isRoleAddress(a)
    );
  };

  for (const p of extraction.people) decidePerson(p);
  return out;

  function decidePerson(p: HubExtractedPerson): void {
    const part = participants.get(p.participantKey);
    if (!part || !p.isHuman || part.automated || isExcluded(part.address)) return;
    const address = normalizeAddress(part.address);
    const key = stripPlusTag(address);
    const domain = domainOfAddress(address);

    const byAddress = state.people.find((x) => x.emails.some((e) => stripPlusTag(e) === key));
    if (byAddress) {
      push(
        {
          fact: draft('person', { kind: 'person', id: byAddress.id, ref: p.participantKey }, null, { name: byAddress.name }, p.confidence, 'header', p.evidence),
          outcome: 'auto',
          reason: null,
          action: 'match',
          ref: p.participantKey,
          dependsOnRef: null,
        },
        [],
      );
      personFields(p, byAddress);
      return;
    }

    const wanted = foldName(p.name);
    const existingId = resolveId(state, p.existingPersonId);
    const candidates = state.people.filter((x) => x.id === existingId || (wanted !== '' && foldName(x.name) === wanted));
    if (candidates.length > 0) {
      const owning = isFreeMailDomain(domain) ? undefined : companyOwning(domain);
      const corroborated = owning ? candidates.filter((x) => x.companyIds.includes(owning)) : [];
      const only = corroborated.length === 1 ? corroborated[0] : undefined;
      const target = only ?? candidates[0]!;
      const decision = push(
        {
          fact: draft('person_email', { kind: 'person', id: target.id, ref: p.participantKey }, null, { address }, p.confidence, 'header', p.evidence),
          outcome: only ? 'auto' : 'suggest',
          reason: only ? null : 'name_only_match',
          action: 'attach',
          ref: p.participantKey,
          dependsOnRef: null,
        },
        [markerKey.personEmail(address)],
      );
      if (only && decision.outcome === 'auto') personFields(p, only);
      return;
    }

    const correspondent = part.sent > 0 || part.directToOnOwnerSent;
    const name = p.name || part.name || (address.split('@')[0] ?? address);
    const created = push(
      {
        fact: draft('person', { kind: 'person', id: null, ref: p.participantKey }, null, { name, email: address }, p.confidence, 'header', p.evidence),
        outcome: correspondent ? 'auto' : 'suggest',
        reason: correspondent ? null : 'low_confidence',
        action: 'create',
        ref: p.participantKey,
        dependsOnRef: null,
      },
      [markerKey.personEmail(address)],
    );
    if (created.outcome === 'auto') personFields(p, null);
  }

  function personFields(p: HubExtractedPerson, existing: PolicyPerson | null): void {
    personField(p, existing, 'roleTitle', p.roleTitle, p.roleTitleBasis);
    personField(p, existing, 'phone', p.phone, p.phoneBasis);
  }

  /** Role and phone: auto from a signature or header at `autoConfidence` when empty or email-set. */
  function personField(
    p: HubExtractedPerson,
    existing: PolicyPerson | null,
    field: 'roleTitle' | 'phone',
    value: string | null,
    basis: HubFactBasis | null,
  ): void {
    if (value === null || value.trim() === '' || basis === null) return;
    const current = existing ? existing[field] : null;
    const ownerSet = existing?.ownerFields.includes(field) ?? false;
    const fact = (conflict: boolean) =>
      draft(
        'field',
        { kind: 'person', id: existing?.id ?? null, ref: p.participantKey },
        field,
        { field, value },
        p.confidence,
        basis,
        p.evidence,
        current,
        conflict,
      );
    const base = { ref: p.participantKey, dependsOnRef: existing ? null : p.participantKey };
    const keys = existing ? [markerKey.field('person', existing.id, field, value)] : [];
    const equal = current !== null && sameValue(field, current, value);

    if (equal) {
      push({ fact: fact(false), outcome: 'auto', reason: null, action: 'corroborate', ...base }, []);
      return;
    }
    if (ownerSet) {
      push({ fact: fact(true), outcome: 'suggest', reason: 'conflict', action: 'update', ...base }, keys);
      return;
    }
    if ((basis !== 'signature' && basis !== 'header') || p.confidence < policy.autoConfidence) {
      push({ fact: fact(false), outcome: 'suggest', reason: 'low_confidence', action: 'update', ...base }, keys);
      return;
    }
    if (current === null || current.trim() === '') {
      push({ fact: fact(false), outcome: 'auto', reason: null, action: 'update', ...base }, keys);
      return;
    }
    const at = existing?.emailFieldAt?.[field] ?? null;
    if (at === null || state.threadDate.getTime() > at.getTime()) {
      push({ fact: fact(false), outcome: 'auto', reason: null, action: 'supersede', ...base }, keys);
    }
    // An older email value never replaces a newer one: no decision.
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Project decisions; `priorDecisions` (companies and people) tell which records this thread involves. */
export function decideProjects(
  extraction: PolicyExtraction,
  state: HubPolicyState,
  policy: HubPolicyV1,
  priorDecisions: HubDecision[],
): HubDecision[] {
  const out: HubDecision[] = [];
  const push = pusher(policy, state, out);
  const involved = new Set(
    priorDecisions
      .filter(
        (d) =>
          d.fact.target.id !== null &&
          ((d.action === 'match' && (d.fact.type === 'person' || d.fact.type === 'company')) ||
            (d.fact.type === 'person_email' && d.outcome === 'auto')),
      )
      .map((d) => d.fact.target.id!),
  );

  for (const j of extraction.projects) decideProject(j);
  return out;

  function decideProject(j: HubExtractedProject): void {
    const norm = projectMatchName(j.name);
    if (norm === '') return;
    const sameName = state.projects.filter((x) => projectMatchName(x.name) === norm);
    const match = sameName.find(
      (x) => x.companyIds.length === 0 || x.companyIds.some((c) => involved.has(c)) || x.personIds.some((p) => involved.has(p)),
    );
    if (match) {
      push(
        {
          fact: draft('project', { kind: 'project', id: match.id, ref: j.ref }, null, { name: match.name }, j.confidence, 'text', j.evidence),
          outcome: 'auto',
          reason: null,
          action: 'match',
          ref: j.ref,
          dependsOnRef: null,
        },
        [],
      );
      return;
    }
    const auto =
      j.explicitlyNamed && j.confidence >= policy.strongAutoConfidence && !isGenericProjectName(policy, j.name) && sameName.length === 0;
    push(
      {
        fact: draft(
          'project',
          { kind: 'project', id: null, ref: j.ref },
          null,
          { name: j.name, description: j.description, status: j.status },
          j.confidence,
          'text',
          j.evidence,
        ),
        outcome: auto ? 'auto' : 'suggest',
        reason: auto ? null : 'inferred_project',
        action: 'create',
        ref: j.ref,
        dependsOnRef: null,
      },
      [markerKey.projectName(j.name)],
    );
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

interface ResolvedEnd extends LinkEnd {
  /** The record is only a suggestion in this thread. */
  pending: boolean;
  /** A company on an owner domain: never linked automatically. */
  ownerDomain: boolean;
}

/**
 * Link decisions: one `link` per pair whose ends resolved through `recordDecisions`, plus a
 * `link_role` for the role of an auto-applied link. Same-kind pairs are never created.
 */
export function decideLinks(
  extraction: PolicyExtraction,
  state: HubPolicyState,
  policy: HubPolicyV1,
  recordDecisions: HubDecision[],
): HubDecision[] {
  const out: HubDecision[] = [];
  const push = pusher(policy, state, out);
  const seen = new Set<string>();

  const kindOfRef = (ref: string): HubRecordKind | null =>
    extraction.people.some((p) => p.participantKey === ref)
      ? 'person'
      : extraction.companies.some((c) => c.ref === ref)
        ? 'company'
        : extraction.projects.some((j) => j.ref === ref)
          ? 'project'
          : null;

  const isOwnerDomainCompany = (id: string | null, ref: string): boolean => {
    const domains = id
      ? (state.companies.find((c) => c.id === id)?.domains ?? [])
      : [companyDomainOf(extraction.companies.find((c) => c.ref === ref))];
    return domains.some((d) => d !== null && state.ownerDomains.has(normalizeDomain(d) ?? d));
  };

  function endOf(ref: string): ResolvedEnd | null {
    const kind = kindOfRef(ref);
    if (!kind) return null;
    const d = recordDecisions.find(
      (x) => x.ref === ref && x.outcome !== 'drop' && (x.fact.type === kind || (kind === 'person' && x.fact.type === 'person_email')),
    );
    if (d) {
      const pending = d.outcome === 'suggest';
      const id = pending ? null : d.fact.target.id;
      return { kind, id, ref, pending, ownerDomain: kind === 'company' && isOwnerDomainCompany(id, ref) };
    }
    // Owner-domain companies get no record decision; an existing one can still be suggested.
    if (kind === 'company') {
      const domain = companyDomainOf(extraction.companies.find((x) => x.ref === ref));
      if (domain && state.ownerDomains.has(domain)) {
        const existing = state.companies.find((x) => x.domains.some((d) => normalizeDomain(d) === domain));
        if (existing) return { kind, id: existing.id, ref, pending: false, ownerDomain: true };
      }
    }
    return null;
  }

  for (const l of extraction.links) decideLink(l);
  return out;

  function decideLink(l: HubExtractedLink): void {
    const from = endOf(l.from);
    const to = endOf(l.to);
    if (!from || !to || from.kind === to.kind) return;
    const [a, b] = KIND_ORDER.indexOf(from.kind) < KIND_ORDER.indexOf(to.kind) ? [from, to] : [to, from];
    const [ka, kb] = LINK_KIND_ENDS[l.kind];
    if (a.kind !== ka || b.kind !== kb) return;
    const pairKey = `${l.kind}:${a.id ?? a.ref}:${b.id ?? b.ref}`;
    if (seen.has(pairKey)) return;
    seen.add(pairKey);

    const idField = { person: 'personId', company: 'companyId', project: 'projectId' } as const;
    const existing =
      a.id && b.id ? state.links.find((x) => x.kind === l.kind && x[idField[a.kind]] === a.id && x[idField[b.kind]] === b.id) : undefined;
    const end = (e: ResolvedEnd): LinkEnd => ({ kind: e.kind, id: e.id, ref: e.ref });
    const link: LinkDraft = { kind: l.kind, a: end(a), b: end(b), linkId: existing?.id ?? null };
    const keys = a.id && b.id ? [markerKey.link(l.kind, a.id, b.id)] : [];
    const pendingEnd = [a, b].find((e) => e.pending);
    const project = l.kind !== 'person_company';

    const auto =
      l.confidence >= policy.autoConfidence && !a.ownerDomain && !b.ownerDomain && !pendingEnd && (project || l.basis !== 'text');
    const decided = push(
      {
        fact: draft('link', end(a), null, { kind: l.kind, role: l.role }, l.confidence, l.basis, l.evidence, null, false, link),
        outcome: auto ? 'auto' : 'suggest',
        reason: auto ? null : 'low_confidence',
        action: existing ? 'match' : 'create',
        ref: null,
        dependsOnRef: pendingEnd?.ref ?? null,
      },
      keys,
    );
    // A suggested link carries its role in `value`; the role fact exists for applied links only.
    if (decided.outcome !== 'auto' || l.role === null || l.role.trim() === '') return;

    const role = l.role;
    const roleConfidence = l.roleConfidence ?? l.confidence;
    const current = existing?.role ?? null;
    const fact = (conflict: boolean) =>
      draft('link_role', end(a), null, { role }, roleConfidence, l.basis, l.evidence, current, conflict, link);
    const base = { ref: null, dependsOnRef: null };
    if (roleConfidence < policy.suggestFloor) {
      push({ fact: fact(false), outcome: 'drop', reason: 'low_confidence', action: 'update', ...base }, []);
      return;
    }
    if (current !== null && foldName(current) === foldName(role)) {
      push({ fact: fact(false), outcome: 'auto', reason: null, action: 'corroborate', ...base }, []);
      return;
    }
    if (existing?.roleOwnerSet) {
      push({ fact: fact(true), outcome: 'suggest', reason: 'conflict', action: 'update', ...base }, []);
      return;
    }
    // A works-at role restates the person's title: an owner-set title that differs is a conflict.
    if (!project && a.id) {
      const owner = state.people.find((p) => p.id === a.id);
      if (owner?.ownerFields.includes('roleTitle') && owner.roleTitle !== null && foldName(owner.roleTitle) !== foldName(role)) {
        push({ fact: fact(true), outcome: 'suggest', reason: 'conflict', action: 'update', ...base }, []);
        return;
      }
    }
    // Signature roles name the position directly; project roles need a strong link reading.
    const roleAuto = project ? l.confidence >= policy.strongAutoConfidence : l.basis === 'signature';
    push(
      {
        fact: fact(false),
        outcome: roleAuto ? 'auto' : 'suggest',
        reason: roleAuto ? null : 'low_confidence',
        action: roleAuto && current !== null ? 'supersede' : 'update',
        ...base,
      },
      [],
    );
  }
}

/** All decisions in the order of application: companies, people, projects, links. */
export function decide(extraction: PolicyExtraction, state: HubPolicyState, policy: HubPolicyV1 = HUB_POLICY_V1): HubDecision[] {
  const companies = decideCompanies(extraction, state, policy);
  const people = decidePeople(extraction, state, policy, companies);
  const projects = decideProjects(extraction, state, policy, [...companies, ...people]);
  const records = [...companies, ...people, ...projects];
  return [...records, ...decideLinks(extraction, state, policy, records)];
}
