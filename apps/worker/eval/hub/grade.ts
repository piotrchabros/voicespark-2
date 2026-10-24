import {
  companyMatchName,
  foldName,
  isFreeMailDomain,
  isRoleAddress,
  normalizeAddress,
  normalizeDomain,
  projectMatchName,
} from '@voicespark/core/hub/normalize';
import type { EvalConversation } from './format';

// Grader of the hub extraction eval (research R14; SC-004 to SC-006), a port of the reference app's scoring over a
// snapshot of one conversation's hub rows (decrypted). Pure: the runner reads the snapshot, this module scores it.
//
// - Pending suggestions count for SC-004: a `suggested` fact that names the right record (the person and address,
//   both ends of a link, the project name) is a hit; the report counts them as "pending hits". SC-006 (share of
//   queued findings, auto-applied precision) is scored over the stored facts and keeps the automation honest.
// - Project names match when the normalised names are equal or one contains the other as whole words ("Atlas" and
//   "Atlas migration", "Orkiestra" and "Wdrożenie Orkiestra").
// - Owner-conflict files carry the owner-typed link role as documentation only: the policy queues the signature role
//   as a conflict, so only the link itself is graded.

export type LinkKind = 'person_company' | 'person_project' | 'company_project';
type EndKind = 'person' | 'company' | 'project';

export interface HubSnapshot {
  people: {
    id: string;
    name: string;
    roleTitle: string | null;
    ownerFields: string[];
    createdFrom: string;
  }[];
  emails: { personId: string; address: string }[];
  companies: { id: string; name: string }[];
  domains: { companyId: string; domain: string }[];
  projects: { id: string; name: string }[];
  links: {
    id: string;
    kind: LinkKind;
    personId: string | null;
    companyId: string | null;
    projectId: string | null;
  }[];
  threads: {
    id: string;
    status: string;
    skipReason: string | null;
    lastErrorCode: string | null;
    summary: string | null;
  }[];
  facts: {
    id: string;
    type: string;
    state: string;
    reason: string | null;
    field: string | null;
    conflict: boolean;
    personId: string | null;
    companyId: string | null;
    projectId: string | null;
    linkId: string | null;
    dependsOnFactId: string | null;
    value: Record<string, unknown>;
  }[];
}

export interface Ratio {
  hit: number;
  total: number;
}

/** Gated metrics, grouped by success criterion; `max` means "at most". */
export const THRESHOLDS = {
  peopleCorrect: { sc: 'SC-004', label: 'people', min: 0.95 },
  personCompanyLinks: { sc: 'SC-004', label: 'person-company links', min: 0.9 },
  projects: { sc: 'SC-004', label: 'project names and links', min: 0.8 },
  duplicatePeople: { sc: 'SC-005', label: 'duplicate people', max: 0.02 },
  automatedPeople: { sc: 'SC-005', label: 'automated senders as people', count: 0 },
  suggestionShare: { sc: 'SC-006', label: 'findings queued', max: 0.2 },
  autoPrecision: { sc: 'SC-006', label: 'auto-applied correct', min: 0.9 },
} as const;
export type MetricName = keyof typeof THRESHOLDS;
export const METRIC_NAMES = Object.keys(THRESHOLDS) as MetricName[];

/** Reported, not gated. */
export const INFO = {
  summaryMentions: 'summaries with every mention',
  ownerFieldsKept: 'owner-set roles kept (SC-007)',
  expectedSuggestions: 'expected suggestions queued',
  roleTitle: 'role titles exact',
} as const;
export type InfoName = keyof typeof INFO;

export interface FileResult {
  id: string;
  set: EvalConversation['set'];
  categories: string[];
  /** The conversation could not be run or a thread was left unprocessed. */
  error: string | null;
  threads: { status: string; skipReason: string | null; lastErrorCode: string | null }[];
  metrics: Record<MetricName, Ratio>;
  info: Record<InfoName, Ratio>;
  /** SC-004 hits that are pending suggestions. */
  pendingHits: number;
  /** Applied facts the labels cannot judge (phones, industries, unlabelled roles). */
  ungradedFacts: number;
  roleAddressPeople: number;
  freeMailCompanies: number;
  misses: string[];
}

const ratio = (): Ratio => ({ hit: 0, total: 0 });
const add = (r: Ratio, ok: boolean) => {
  r.total += 1;
  if (ok) r.hit += 1;
};

export function emptyResult(conversation: EvalConversation): FileResult {
  return {
    id: conversation.id,
    set: conversation.set,
    categories: conversation.categories,
    error: null,
    threads: [],
    metrics: Object.fromEntries(METRIC_NAMES.map((k) => [k, ratio()])) as Record<MetricName, Ratio>,
    info: Object.fromEntries(Object.keys(INFO).map((k) => [k, ratio()])) as Record<InfoName, Ratio>,
    pendingHits: 0,
    ungradedFacts: 0,
    roleAddressPeople: 0,
    freeMailCompanies: 0,
    misses: [],
  };
}

const sameName = (a: string, b: string) => foldName(a) === foldName(b);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Equal normalised project names, or one contains the other as whole words. */
export function sameProject(a: string, b: string): boolean {
  const x = projectMatchName(a);
  const y = projectMatchName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return new RegExp(`(^|\\s)${escapeRegExp(short)}(\\s|$)`).test(long);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const domainKey = (d: string): string => normalizeDomain(d) ?? d.trim().toLowerCase();
const PENDING = 'pending:';
const isPending = (id: string | null): boolean => id !== null && id.startsWith(PENDING);

/**
 * Scores one conversation's snapshot into `r`. `expectedThreads` is the number of distinct conversations the file
 * holds (the cross-mailbox files hold one conversation in two mailboxes).
 */
export function score(
  conversation: EvalConversation,
  snap: HubSnapshot,
  expectedThreads: number,
  r: FileResult = emptyResult(conversation),
): FileResult {
  const exp = conversation.expected;
  const seed = conversation.seed;

  const emailsOf = new Map<string, Set<string>>();
  for (const e of snap.emails) {
    const set = emailsOf.get(e.personId) ?? new Set<string>();
    set.add(normalizeAddress(e.address));
    emailsOf.set(e.personId, set);
  }
  const domainsOf = new Map<string, Set<string>>();
  for (const d of snap.domains) {
    const set = domainsOf.get(d.companyId) ?? new Set<string>();
    set.add(domainKey(d.domain));
    domainsOf.set(d.companyId, set);
  }
  const personByEmail = new Map(snap.emails.map((e) => [normalizeAddress(e.address), e.personId]));
  const companyByDomain = new Map(snap.domains.map((d) => [domainKey(d.domain), d.companyId]));

  type Fact = HubSnapshot['facts'][number];
  const suggested = snap.facts.filter((f) => f.state === 'suggested');
  const factById = new Map(snap.facts.map((f) => [f.id, f]));
  const pendingId = (f: Fact) => `${PENDING}${f.id}`;
  const pendingFact = (id: string | null): Fact | undefined =>
    isPending(id) ? factById.get(id!.slice(PENDING.length)) : undefined;
  const kindOfFact = (f: Fact): EndKind | null =>
    f.type === 'person' || f.type === 'person_email'
      ? 'person'
      : f.type === 'company' || f.type === 'company_domain'
        ? 'company'
        : f.type === 'project'
          ? 'project'
          : null;

  // Expected references -> every id that stands for them: the live record (people by email, companies by domain
  // or name, projects by name) and the pending suggestions that would create or attach them.
  const personIds = (email: string): Set<string> => {
    const a = normalizeAddress(email);
    const ids = new Set<string>();
    const live = personByEmail.get(a);
    if (live) ids.add(live);
    for (const x of suggested) {
      if (
        (x.type === 'person_email' && normalizeAddress(str(x.value.address)) === a) ||
        (x.type === 'person' && normalizeAddress(str(x.value.email)) === a)
      )
        ids.add(pendingId(x));
    }
    return ids;
  };
  const companyIds = (ref: string): Set<string> => {
    const ids = new Set<string>();
    const live =
      companyByDomain.get(domainKey(ref)) ??
      snap.companies.find((c) => companyMatchName(c.name) === companyMatchName(ref))?.id;
    if (live) ids.add(live);
    for (const x of suggested) {
      if (
        x.type === 'company' &&
        ((str(x.value.domain) && domainKey(str(x.value.domain)) === domainKey(ref)) ||
          companyMatchName(str(x.value.name)) === companyMatchName(ref))
      )
        ids.add(pendingId(x));
    }
    return ids;
  };
  const projectIds = (name: string): Set<string> => {
    const ids = new Set<string>();
    for (const p of snap.projects) if (sameProject(p.name, name)) ids.add(p.id);
    for (const x of suggested)
      if (x.type === 'project' && sameProject(str(x.value.name), name)) ids.add(pendingId(x));
    return ids;
  };
  const endIds = (kind: EndKind, ref: string) =>
    kind === 'person' ? personIds(ref) : kind === 'company' ? companyIds(ref) : projectIds(ref);
  /** The live id when there is one, else the first pending suggestion. */
  const preferred = (ids: Set<string>): string | null =>
    [...ids].find((id) => !isPending(id)) ?? [...ids][0] ?? null;
  const personNameOf = (id: string | null) =>
    id ? (snap.people.find((x) => x.id === id)?.name ?? null) : null;
  const personName = (id: string | null): string | null => {
    const f = pendingFact(id);
    if (f) return f.type === 'person' ? str(f.value.name) : personNameOf(f.personId);
    return personNameOf(id);
  };
  const ends = (kind: LinkKind) => kind.split('_') as [EndKind, EndKind];

  /** The link kind and end ids (live, or pending through `depends_on_fact_id`) of a link fact. */
  const linkOf = (f: Fact) => {
    const row = f.linkId ? snap.links.find((l) => l.id === f.linkId) : undefined;
    const kind = (row?.kind ?? f.value.kind) as LinkKind | undefined;
    const dep = f.dependsOnFactId ? factById.get(f.dependsOnFactId) : undefined;
    const pend = (k: EndKind) => (dep && kindOfFact(dep) === k ? pendingId(dep) : null);
    const ids: Record<EndKind, string | null> = {
      person: row?.personId ?? f.personId ?? pend('person'),
      company: row?.companyId ?? f.companyId ?? pend('company'),
      project: row?.projectId ?? f.projectId ?? pend('project'),
    };
    return { kind, ids };
  };
  const col = { person: 'personId', company: 'companyId', project: 'projectId' } as const;
  const findLink = (
    kind: LinkKind,
    a: Set<string>,
    b: Set<string>,
  ): { pending: boolean } | undefined => {
    if (a.size === 0 || b.size === 0) return undefined;
    const [ka, kb] = ends(kind);
    const live = snap.links.some(
      (l) => l.kind === kind && a.has(l[col[ka]] ?? '') && b.has(l[col[kb]] ?? ''),
    );
    if (live) return { pending: false };
    const fact = suggested.find((f) => {
      if (f.type !== 'link') return false;
      const { kind: k, ids } = linkOf(f);
      return k === kind && a.has(ids[ka] ?? '') && b.has(ids[kb] ?? '');
    });
    return fact ? { pending: true } : undefined;
  };

  // SC-004 people: the expected address belongs to (or is suggested for) a person with the expected name.
  for (const p of exp.people) {
    const id = preferred(personIds(p.email));
    const name = personName(id);
    const ok = Boolean(name && sameName(name, p.name));
    add(r.metrics.peopleCorrect, ok);
    if (ok && isPending(id)) r.pendingHits += 1;
    if (!ok) r.misses.push(`person ${p.email} (${p.name})`);
    const row = isPending(id) ? undefined : snap.people.find((x) => x.id === id);
    if (p.roleTitle && row)
      add(r.info.roleTitle, Boolean(row.roleTitle && sameName(row.roleTitle, p.roleTitle)));
  }

  // SC-004 links: person-company on their own; projects together with their links.
  for (const l of exp.links) {
    const [ka, kb] = ends(l.kind);
    const found = findLink(l.kind, endIds(ka, l.a), endIds(kb, l.b));
    add(l.kind === 'person_company' ? r.metrics.personCompanyLinks : r.metrics.projects, !!found);
    if (found?.pending) r.pendingHits += 1;
    if (!found) r.misses.push(`link ${l.kind} ${l.a} - ${l.b}`);
  }
  for (const pr of exp.projects) {
    const id = preferred(projectIds(pr.name));
    add(r.metrics.projects, id !== null);
    if (isPending(id)) r.pendingHits += 1;
    if (id === null) r.misses.push(`project ${pr.name}`);
  }

  // SC-005 duplicates: live people sharing a folded name.
  const byName = new Map<string, number>();
  for (const p of snap.people)
    byName.set(foldName(p.name), (byName.get(foldName(p.name)) ?? 0) + 1);
  for (const n of byName.values())
    for (let i = 0; i < n; i++) add(r.metrics.duplicatePeople, i > 0);
  if ([...byName.values()].some((n) => n > 1)) r.misses.push('duplicate people');

  // SC-005 automated senders that became people (counted per person; target 0).
  if (exp.automated) {
    for (const p of snap.people.filter((x) => x.createdFrom === 'email')) {
      add(r.metrics.automatedPeople, true);
      r.misses.push(`automated sender became person ${p.name}`);
    }
  }
  r.roleAddressPeople = snap.emails.filter(
    (e) =>
      isRoleAddress(e.address) &&
      snap.people.find((p) => p.id === e.personId)?.createdFrom === 'email',
  ).length;
  r.freeMailCompanies = snap.domains.filter((d) => isFreeMailDomain(domainKey(d.domain))).length;

  // Owner-set roles survive (SC-007, info).
  for (const s of seed?.people ?? []) {
    if (s.roleSource !== 'owner' || !s.roleTitle) continue;
    const id = personByEmail.get(normalizeAddress(s.email));
    const row = snap.people.find((p) => p.id === id);
    const ok = Boolean(
      row && row.roleTitle === s.roleTitle && row.ownerFields.includes('roleTitle'),
    );
    add(r.info.ownerFieldsKept, ok);
    if (!ok) r.misses.push(`owner role overwritten for ${s.email}`);
  }

  // Expected suggestions (info): each must be queued, naming the right record.
  for (const s of exp.suggestions) {
    const target = s.person ? personByEmail.get(normalizeAddress(s.person)) : undefined;
    const ok = suggested.some((f) => {
      if (f.type !== s.type) return false;
      switch (s.type) {
        case 'person_email':
          return (
            normalizeAddress(str(f.value.address)) === normalizeAddress(s.address ?? '') &&
            (target === undefined || f.personId === target)
          );
        case 'person':
          return normalizeAddress(str(f.value.email)) === normalizeAddress(s.address ?? '');
        case 'field':
          return f.field === s.field && (target === undefined || f.personId === target);
        case 'project':
          return sameProject(str(f.value.name), s.project ?? '');
        default:
          return f.reason === s.reason;
      }
    });
    add(r.info.expectedSuggestions, ok);
    if (!ok)
      r.misses.push(
        `suggestion ${s.type}/${s.reason} ${s.person ?? s.address ?? s.project ?? ''} not queued`,
      );
  }

  // Threads and summaries.
  r.threads = snap.threads.map((t) => ({
    status: t.status,
    skipReason: t.skipReason,
    lastErrorCode: t.lastErrorCode,
  }));
  if (snap.threads.length > expectedThreads)
    r.misses.push(`${snap.threads.length - expectedThreads} duplicate conversation(s)`);
  const unfinished = snap.threads.filter((t) => t.status !== 'done' && t.status !== 'skipped');
  if (unfinished.length > 0) {
    r.error = `${unfinished.length} thread(s) not processed: ${unfinished
      .map((t) => `${t.status} ${t.lastErrorCode ?? ''}`.trim())
      .join('; ')}`;
  }
  if (exp.summaryMentions.length > 0) {
    const summaries = snap.threads.map((t) => foldName(t.summary ?? ''));
    const ok = exp.summaryMentions.every((m) => summaries.some((s) => s.includes(foldName(m))));
    add(r.info.summaryMentions, ok);
    if (!ok) r.misses.push(`summary lacks ${exp.summaryMentions.join(', ')}`);
  }

  // SC-006: share of queued findings and precision of the auto-applied ones, over the stored facts. Seeded
  // records are ground truth as well: re-matching them is not a wrong fact.
  const knownAddresses = new Set(exp.people.map((p) => normalizeAddress(p.email)));
  for (const s of seed?.people ?? []) knownAddresses.add(normalizeAddress(s.email));
  const seededCompanies = seed?.companies ?? [];
  const expectedDomains = new Set(
    [...exp.companies, ...seededCompanies].flatMap((c) => (c.domain ? [domainKey(c.domain)] : [])),
  );
  const expectedCompanyNames = [
    ...exp.companies.flatMap((c) => (c.name ? [c.name] : [])),
    ...seededCompanies.map((c) => c.name),
  ];
  const expectedProjects = [...exp.projects, ...(seed?.projects ?? [])];
  const expectedPersonFor = (id: string | null) => {
    if (!id) return undefined;
    const emails = emailsOf.get(id) ?? new Set<string>();
    return exp.people.find((p) => emails.has(normalizeAddress(p.email)));
  };
  const expectedLinkFor = (f: Fact) => {
    const { kind, ids } = linkOf(f);
    if (!kind) return undefined;
    const [ka, kb] = ends(kind);
    return exp.links.find(
      (l) =>
        l.kind === kind && endIds(ka, l.a).has(ids[ka] ?? '') && endIds(kb, l.b).has(ids[kb] ?? ''),
    );
  };
  const grade = (f: Fact): boolean | null => {
    const v = f.value;
    switch (f.type) {
      case 'person':
        return (
          (typeof v.email === 'string' && knownAddresses.has(normalizeAddress(v.email))) ||
          exp.people.some((p) => sameName(p.name, str(v.name))) ||
          (seed?.people ?? []).some((p) => sameName(p.name, str(v.name)))
        );
      case 'person_email':
        return knownAddresses.has(normalizeAddress(str(v.address)));
      case 'company':
        return (
          (typeof v.domain === 'string' && expectedDomains.has(domainKey(v.domain))) ||
          expectedCompanyNames.some((n) => companyMatchName(n) === companyMatchName(str(v.name)))
        );
      case 'company_domain':
        return expectedDomains.has(domainKey(str(v.domain)));
      case 'project':
        return expectedProjects.some((p) => sameProject(p.name, str(v.name)));
      case 'field': {
        if (f.field !== 'roleTitle') return null;
        const expected = expectedPersonFor(f.personId);
        if (!expected?.roleTitle) return null;
        return sameName(str(v.value), expected.roleTitle);
      }
      case 'link': {
        if (expectedLinkFor(f)) return true;
        // An unlisted person-company link is still right when the person writes from that domain.
        const { kind, ids } = linkOf(f);
        if (kind !== 'person_company' || !ids.person || !ids.company) return false;
        const domains = domainsOf.get(ids.company) ?? new Set<string>();
        return [...(emailsOf.get(ids.person) ?? [])].some((a) =>
          domains.has(a.split('@')[1] ?? ''),
        );
      }
      case 'link_role': {
        const expected = expectedLinkFor(f);
        if (!expected?.role) return null;
        return sameName(str(v.role), expected.role);
      }
      default:
        return null;
    }
  };
  for (const f of snap.facts) {
    if (f.state === 'suggested') add(r.metrics.suggestionShare, true);
    if (f.state !== 'applied' && f.state !== 'superseded') continue;
    add(r.metrics.suggestionShare, false);
    const ok = grade(f);
    if (ok === null) r.ungradedFacts += 1;
    else {
      add(r.metrics.autoPrecision, ok);
      if (!ok)
        r.misses.push(
          `wrong auto ${f.type}${f.field ? `:${f.field}` : ''} ${JSON.stringify(f.value)}`,
        );
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation and the report

export const pct = (r: Ratio): number | null => (r.total === 0 ? null : r.hit / r.total);
const fmt = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export function sum(results: FileResult[], pick: (r: FileResult) => Ratio): Ratio {
  return results.reduce(
    (acc, r) => ({ hit: acc.hit + pick(r).hit, total: acc.total + pick(r).total }),
    ratio(),
  );
}

export function passes(name: MetricName, r: Ratio): boolean {
  const t = THRESHOLDS[name] as { min?: number; max?: number; count?: number };
  if (t.count !== undefined) return r.hit <= t.count;
  const v = pct(r);
  if (v === null) return true;
  return t.min !== undefined ? v >= t.min : v <= t.max!;
}

function target(name: MetricName): string {
  const t = THRESHOLDS[name] as { min?: number; max?: number; count?: number };
  if (t.count !== undefined) return `= ${t.count}`;
  return t.min !== undefined ? `>= ${t.min * 100}%` : `<= ${t.max! * 100}%`;
}

export interface SetSummary {
  label: string;
  files: number;
  errors: number;
  metrics: Record<MetricName, Ratio & { pass: boolean }>;
  passed: boolean;
}

export function summarize(label: string, results: FileResult[]): SetSummary {
  const metrics = Object.fromEntries(
    METRIC_NAMES.map((name) => {
      const r = sum(results, (x) => x.metrics[name]);
      return [name, { ...r, pass: passes(name, r) }];
    }),
  ) as SetSummary['metrics'];
  const errors = results.filter((r) => r.error).length;
  return {
    label,
    files: results.length,
    errors,
    metrics,
    passed: errors === 0 && Object.values(metrics).every((m) => m.pass),
  };
}

/** One line per success criterion: `SC-004 in-sample (53 files): people 97.0% (n=67, >= 95%) ok | ... PASS`. */
export function scLines(s: SetSummary): string[] {
  const out: string[] = [];
  for (const sc of ['SC-004', 'SC-005', 'SC-006'] as const) {
    const names = METRIC_NAMES.filter((n) => THRESHOLDS[n].sc === sc);
    const parts = names.map((n) => {
      const m = s.metrics[n];
      const t = THRESHOLDS[n] as { count?: number };
      const value = t.count !== undefined ? String(m.hit) : fmt(pct(m));
      return `${THRESHOLDS[n].label} ${value} (n=${m.total}, ${target(n)}) ${m.pass ? 'ok' : 'FAIL'}`;
    });
    const pass = names.every((n) => s.metrics[n].pass);
    out.push(
      `${sc} ${s.label} (${s.files} files): ${parts.join(' | ')} -> ${pass ? 'PASS' : 'FAIL'}`,
    );
  }
  return out;
}

export function infoLines(label: string, results: FileResult[]): string[] {
  const parts = (Object.keys(INFO) as InfoName[]).map((k) => {
    const r = sum(results, (x) => x.info[k]);
    return `${INFO[k]} ${fmt(pct(r))} (n=${r.total})`;
  });
  const n = (pick: (r: FileResult) => number) => results.reduce((a, r) => a + pick(r), 0);
  parts.push(
    `pending hits ${n((r) => r.pendingHits)}`,
    `ungraded applied facts ${n((r) => r.ungradedFacts)}`,
    `role addresses as people ${n((r) => r.roleAddressPeople)}`,
    `free-mail company domains ${n((r) => r.freeMailCompanies)}`,
  );
  return [`info ${label}: ${parts.join(' | ')}`];
}
