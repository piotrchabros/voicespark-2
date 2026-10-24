import { and, eq, sql } from 'drizzle-orm';
import {
  hubCompany,
  hubFact,
  hubProject,
  withTransaction,
  type HubCompany,
  type HubFact,
  type HubLink,
  type HubPerson,
  type HubProject,
  type Tx,
} from '@voicespark/db';
import * as mail from '@voicespark/db/repos/user/hub-mail';
import * as repo from '@voicespark/db/repos/user/hub-records';
import { completeThread } from '@voicespark/db/repos/system/hub';
import { inspectSegments, validateContactValue, type Policy } from '@voicespark/filters';
import { AppError, type ServiceContext } from '../../errors';
import { HUB_EXTRACTION_LIMITS, type HubExtraction } from '../../hub/extraction-schema';
import { markerKey } from '../../hub/fingerprint';
import {
  addressHash,
  isFreeMailDomain,
  matchHash,
  matchKey,
  nameKey,
  normalizeAddress,
  normalizeWebsite,
} from '../../hub/normalize';
import {
  blockMarkerKeys,
  decide,
  HUB_POLICY_V1,
  type HubDecision,
  type HubPolicyState,
  type HubPolicyV1,
  type LinkDraft,
  type LinkEnd,
  type PolicyCompany,
  type PolicyLink,
  type PolicyPerson,
  type PolicyProject,
} from '../../hub/policy';
import { getClassifier, loadPolicy } from '../inspection';
import { decryptContent, encryptContent, type HubKind } from './common';
import { domainHash, reindex } from './records';
import { markDirty, markRecordTree } from './sync';

// Apply step of the hub pipeline (contracts/hub-extraction.md sections 9-11; data-model.md "hub_fact",
// "hub_fact_evidence", "hub_thread_record", "Provenance and owner_fields"; FR-015..FR-019, FR-028, SC-007).
// Free-text outputs are inspected first, outside any lock. Then one transaction under the per-user apply lock
// reads owner fields, link roles, block markers and redirects, runs the policy and writes its decisions in the
// order companies -> people -> projects -> links, then the summary, the sync marks, the mailbox counters and the
// thread completion. A user edit made during the model call therefore wins. Dropped decisions are not stored.

/** JSON inside `hub_thread.participants_enc` (data-model.md "Thread participants shape"). */
export interface HubParticipant {
  address: string;
  name: string | null;
  roles: ('from' | 'to' | 'cc')[];
  sent: boolean;
  owner: boolean;
  automated: boolean;
  roleAddress: boolean;
  freeMail: boolean;
}

/** A participant as the processor knows it: the `P1..Pn` key sent to the model and the policy counts. */
export interface ApplyParticipant extends HubParticipant {
  key: string;
  /** Number of messages this participant sent in the thread. */
  messagesSent: number;
  /** Direct To recipient of an owner-sent message with at most `maxOwnerToRecipients` To recipients. */
  directToOnOwnerSent: boolean;
}

export interface ApplyContext {
  participants: ApplyParticipant[];
  /** The user's identities (connected and disconnected source addresses). */
  ownerAddresses: readonly string[];
  /** Decrypted `hub_ignore_rule` values. */
  ignoredAddresses?: readonly string[];
  ignoredDomains?: readonly string[];
  /** `prompt_version` stored on the facts (`hub-extract-v1`). */
  promptVersion: string;
  /** Newest message date; defaults to the thread's `last_message_at`. Decides which email value is newer. */
  threadDate?: Date;
  policy?: HubPolicyV1;
}

export type ApplySkipReason = 'irrelevant' | 'no_candidates';

export interface ApplyResult {
  /** `lease_lost`: the worker's lease expired before the apply committed; nothing was written. */
  outcome: 'done' | 'skipped' | 'lease_lost';
  skipReason: ApplySkipReason | null;
  applied: number;
  suggested: number;
  corroborated: number;
  summaryStored: boolean;
  /** Values the inspection redacted in the stored free text. */
  redactedValues: number;
}

const FACT_EVIDENCE_MAX = 300;
const PERSON_FIELDS = ['roleTitle', 'phone'] as const;
const KINDS: HubKind[] = ['person', 'company', 'project'];
const FIELD_COLUMN: Record<string, string> = {
  roleTitle: 'roleTitleEnc',
  phone: 'phoneEnc',
  industry: 'industryEnc',
};
const RECORD_FACT_TYPES = new Set<HubFact['type']>(['person', 'person_email', 'company', 'project']);
const LINK_ENDS: Record<HubLink['kind'], [HubKind, HubKind]> = {
  person_company: ['person', 'company'],
  person_project: ['person', 'project'],
  company_project: ['company', 'project'],
};

class LeaseLost extends Error {}

const unavailable = () => new AppError('inspection_unavailable');
const domainOf = (address: string): string => normalizeAddress(address).split('@')[1] ?? '';

// ---------------------------------------------------------------------------------------------------------------
// Output inspection (FR-028): one `inspectSegments` call for the summary, one for every other free-text field.

interface Inspected {
  extraction: HubExtraction;
  participants: ApplyParticipant[];
  summary: string | null;
  redactedValues: number;
}

interface Slot {
  text: string;
  /** `null` when the segment was excluded; `changed` when the inspection redacted something in it. */
  set: (value: string | null, changed: boolean) => void;
}

async function inspectAll(texts: string[], policy: Policy) {
  try {
    const r = await inspectSegments(texts, policy, { classifier: getClassifier() });
    if (r.excluded && r.category === 'inspection_failed') throw unavailable();
    return r;
  } catch (err) {
    // Error details are dropped deliberately: they may echo content.
    if (err instanceof AppError) throw err;
    throw unavailable();
  }
}

async function inspectSlots(slots: Slot[], policy: Policy): Promise<number> {
  if (slots.length === 0) return 0;
  const r = await inspectAll(
    slots.map((s) => s.text),
    policy,
  );
  if (!r.excluded) {
    slots.forEach((s, i) => s.set(r.segments[i] as string, r.segments[i] !== s.text));
    return r.redactedValues;
  }
  // Whole-item exclusion applies to the call: find the excluded segments one by one and drop only those.
  let redacted = 0;
  for (const s of slots) {
    const one = await inspectAll([s.text], policy);
    if (one.excluded) s.set(null, true);
    else {
      s.set(one.segments[0] as string, one.segments[0] !== s.text);
      redacted += one.redactedValues;
    }
  }
  return redacted;
}

/**
 * Every stored free-text output passes the user's full policy; contact outputs pass `validateContactValue`.
 * A redacted or excluded name drops its entry (a company or project) or falls back to the participant name
 * (a person); an excluded summary is not stored. Fails closed with 503 `inspection_unavailable`.
 */
async function inspectOutputs(userId: string, input: HubExtraction, participants: ApplyParticipant[]): Promise<Inspected> {
  let policy: Policy;
  try {
    policy = (await loadPolicy(userId)).policy;
  } catch {
    throw unavailable();
  }
  const x = structuredClone(input);
  let redactedValues = 0;

  let summary: string | null = null;
  if (x.relevant && x.summary.trim() !== '') {
    const r = await inspectAll([x.summary], policy);
    if (!r.excluded) {
      summary = (r.segments[0] as string).slice(0, HUB_EXTRACTION_LIMITS.summary);
      redactedValues += r.redactedValues;
    }
  }

  const parts = participants.flatMap((p) => {
    const address = validateContactValue('email', p.address);
    return address === null ? [] : [{ ...p, address: address as string }];
  });
  const dropped = new Set<object>();
  const slots: Slot[] = [];
  const add = (text: string | null, set: Slot['set']) => {
    if (text !== null && text.trim() !== '') slots.push({ text, set });
  };
  const keepOrNull = (v: string | null) => (v === null || v.trim() === '' ? null : v);

  for (const p of parts) add(p.name, (v, changed) => (p.name = changed ? null : v));
  for (const p of x.people) {
    add(p.name, (v, changed) => (p.name = changed || v === null ? '' : v));
    add(p.evidence, (v) => (p.evidence = v ?? ''));
    add(p.roleTitle, (v) => (p.roleTitle = keepOrNull(v)));
    p.phone = p.phone === null ? null : validateContactValue('phone', p.phone);
  }
  for (const c of x.companies) {
    add(c.name, (v, changed) => {
      if (changed || v === null) dropped.add(c);
    });
    add(c.evidence, (v) => (c.evidence = v ?? ''));
    add(c.industry, (v) => (c.industry = keepOrNull(v)));
    c.domain = c.domain === null ? null : validateContactValue('domain', c.domain);
    if (c.domain !== null && isFreeMailDomain(c.domain)) c.domain = null;
    c.website = c.website === null ? null : normalizeWebsite(c.website);
  }
  for (const j of x.projects) {
    add(j.name, (v, changed) => {
      if (changed || v === null) dropped.add(j);
    });
    add(j.evidence, (v) => (j.evidence = v ?? ''));
    add(j.description, (v) => (j.description = keepOrNull(v)));
  }
  for (const l of x.links) {
    add(l.evidence, (v) => (l.evidence = v ?? ''));
    add(l.role, (v) => (l.role = keepOrNull(v)));
  }
  redactedValues += await inspectSlots(slots, policy);

  for (const p of x.people) {
    if (p.roleTitle === null) p.roleTitleBasis = null;
    if (p.phone === null) p.phoneBasis = null;
  }
  for (const l of x.links) if (l.role === null) l.roleConfidence = null;
  x.companies = x.companies.filter((c) => !dropped.has(c));
  x.projects = x.projects.filter((j) => !dropped.has(j));
  const refs = new Set([
    ...x.people.map((p) => p.participantKey),
    ...x.companies.map((c) => c.ref),
    ...x.projects.map((j) => j.ref),
  ]);
  x.links = x.links.filter((l) => refs.has(l.from) && refs.has(l.to));
  for (const p of x.people) if (p.companyRef !== null && !refs.has(p.companyRef)) p.companyRef = null;
  return { extraction: x, participants: parts, summary, redactedValues };
}

// ---------------------------------------------------------------------------------------------------------------
// Policy state, loaded inside the lock

const decOpt = (blob: string | null): string | null => (blob === null ? null : decryptContent(blob));

async function loadState(
  ctx: ServiceContext,
  threadId: string,
  threadDate: Date,
  x: HubExtraction,
  context: ApplyContext,
  participants: ApplyParticipant[],
  tx: Tx,
): Promise<HubPolicyState> {
  const ids: Record<HubKind, Set<string>> = { person: new Set(), company: new Set(), project: new Set() };
  const redirects = new Map<string, string>();
  const resolve = async (kind: HubKind, id: string | null) => {
    if (id === null) return;
    const to = await mail.resolveRedirect(ctx, kind, id, tx);
    if (to !== id) redirects.set(id, to);
    ids[kind].add(to);
  };
  for (const p of x.people) await resolve('person', p.existingPersonId);
  for (const c of x.companies) await resolve('company', c.existingCompanyId);
  for (const j of x.projects) await resolve('project', j.existingProjectId);

  const domains = new Set<string>();
  for (const part of participants) {
    if (part.owner) continue;
    const exact = await repo.findEmailByHash(ctx, addressHash(part.address), tx);
    if (exact) ids.person.add(exact.personId);
    for (const e of await repo.findEmailsByMatchHash(ctx, matchHash(part.address), tx)) ids.person.add(e.personId);
    domains.add(domainOf(part.address));
  }
  for (const c of x.companies) if (c.domain) domains.add(c.domain);
  for (const d of domains) {
    const row = d ? await repo.findDomainByHash(ctx, domainHash(d), tx) : null;
    if (row) ids.company.add(row.companyId);
  }
  const byName = async (kind: HubKind, name: string) => {
    for (const r of await repo.findByMatchKey(ctx, kind, matchKey(ctx.userId, kind, name), tx)) ids[kind].add(r.id);
  };
  for (const p of x.people) if (p.name) await byName('person', p.name);
  for (const c of x.companies) await byName('company', c.name);
  for (const j of x.projects) await byName('project', j.name);

  const linkRows = new Map<string, HubLink>();
  for (const kind of KINDS) {
    for (const l of await repo.listLinksForRecords(ctx, kind, [...ids[kind]], tx)) linkRows.set(l.id, l);
  }
  const links: PolicyLink[] = [...linkRows.values()].map((l) => ({
    id: l.id,
    kind: l.kind,
    personId: l.personId,
    companyId: l.companyId,
    projectId: l.projectId,
    role: decOpt(l.roleEnc),
    roleOwnerSet: l.roleOwnerSet,
  }));

  const personRows = (await repo.getRecordsByIds(ctx, 'person', [...ids.person], tx)) as HubPerson[];
  const fieldDates = await mail.latestAppliedFieldDates(ctx, 'person', [...ids.person], [...PERSON_FIELDS], tx);
  const people: PolicyPerson[] = [];
  for (const r of personRows) {
    const emailFieldAt: PolicyPerson['emailFieldAt'] = {};
    for (const f of fieldDates) if (f.recordId === r.id) emailFieldAt[f.field as 'roleTitle' | 'phone'] = f.at;
    people.push({
      id: r.id,
      name: decryptContent(r.nameEnc),
      emails: (await repo.listEmails(ctx, r.id, tx)).map((e) => decryptContent(e.addressEnc)),
      companyIds: links.filter((l) => l.kind === 'person_company' && l.personId === r.id).map((l) => l.companyId!),
      roleTitle: decOpt(r.roleTitleEnc),
      phone: decOpt(r.phoneEnc),
      ownerFields: [...r.ownerFields],
      emailFieldAt,
    });
  }
  const companies: PolicyCompany[] = [];
  for (const r of (await repo.getRecordsByIds(ctx, 'company', [...ids.company], tx)) as HubCompany[]) {
    companies.push({
      id: r.id,
      name: decryptContent(r.nameEnc),
      domains: (await repo.listDomains(ctx, r.id, tx)).map((d) => decryptContent(d.domainEnc)),
      industry: decOpt(r.industryEnc),
      ownerFields: [...r.ownerFields],
    });
  }
  const projects: PolicyProject[] = ((await repo.getRecordsByIds(ctx, 'project', [...ids.project], tx)) as HubProject[]).map(
    (r) => ({
      id: r.id,
      name: decryptContent(r.nameEnc),
      companyIds: links.filter((l) => l.kind === 'company_project' && l.projectId === r.id).map((l) => l.companyId!),
      personIds: links.filter((l) => l.kind === 'person_project' && l.projectId === r.id).map((l) => l.personId!),
    }),
  );

  const ownerAddresses = new Set([
    ...context.ownerAddresses.map(normalizeAddress),
    ...participants.filter((p) => p.owner).map((p) => normalizeAddress(p.address)),
  ]);
  const ownerDomains = new Set([...ownerAddresses].map(domainOf).filter((d) => d !== '' && !isFreeMailDomain(d)));
  const policyParticipants = participants.map((p) => ({
    key: p.key,
    address: p.address,
    name: p.name,
    sent: p.messagesSent,
    directToOnOwnerSent: p.directToOnOwnerSent,
    automated: p.automated,
  }));
  const base = { participants: policyParticipants, people, companies, projects };
  return {
    userId: ctx.userId,
    threadId,
    threadDate,
    ...base,
    ownerAddresses,
    ownerDomains,
    ignoredAddresses: new Set((context.ignoredAddresses ?? []).map(normalizeAddress)),
    ignoredDomains: new Set((context.ignoredDomains ?? []).map((d) => d.trim().toLowerCase())),
    links,
    blockMarkers: await mail.listBlockedKeyHashes(ctx, blockMarkerKeys(x, base), tx),
    rejectedFingerprints: await mail.listRejectedFingerprintsForThread(ctx, threadId, tx),
    redirects,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Writing decisions

interface Run {
  ctx: ServiceContext;
  /** Null when a suggestion is accepted after its thread was deleted. */
  threadId: string | null;
  tx: Tx;
  /** The suggested fact being accepted (`applyStoredFact`): its row is updated instead of a new one stored. */
  accepting: HubFact | null;
  /** The accepted row once its change was written. */
  accepted: HubFact | null;
  policyVersion: string;
  promptVersion: string;
  /** Record id per extraction ref (participant key, company or project ref), for records created or matched here. */
  idByRef: Map<string, string>;
  /** The stored record fact per ref, so dependents carry `depends_on_fact_id`. */
  factByRef: Map<string, HubFact>;
  /** Link id per link draft, for the role decision that follows. */
  linkByPair: Map<string, string>;
  /** Records involved in this thread; `changed` ones are re-indexed and marked dirty. */
  touched: Map<string, { kind: HubKind; id: string; changed: boolean }>;
  changedLinks: Map<string, HubLink>;
  counts: { applied: number; suggested: number; corroborated: number };
}

const pairKey = (d: HubDecision): string => {
  const l = d.fact.link!;
  return `${l.kind}:${l.a.id ?? l.a.ref}:${l.b.id ?? l.b.ref}`;
};

function touch(run: Run, kind: HubKind, id: string, changed: boolean): void {
  const key = `${kind}:${id}`;
  const prev = run.touched.get(key);
  run.touched.set(key, { kind, id, changed: changed || (prev?.changed ?? false) });
}

function endId(run: Run, end: LinkEnd): string | null {
  return end.id ?? (end.ref ? (run.idByRef.get(end.ref) ?? null) : null);
}

const enc = (v: unknown): string | null => (v === null || v === undefined ? null : encryptContent(JSON.stringify(v)));

/** Inserts the fact row for a decision. Null when this thread already stored the same finding (a re-run). */
async function storeFact(
  run: Run,
  d: HubDecision,
  state: 'applied' | 'suggested',
  targets: { personId?: string | null; companyId?: string | null; projectId?: string | null; linkId?: string | null },
  extra: { reason?: HubFact['reason']; dependsOnFactId?: string | null } = {},
): Promise<HubFact | null> {
  if (run.accepting) return markAccepted(run, targets);
  const evidence = d.fact.evidence ? d.fact.evidence.slice(0, FACT_EVIDENCE_MAX) : null;
  const fact = await mail.insertFact(
    run.ctx,
    {
      threadId: run.threadId,
      type: d.fact.type,
      state,
      basis: d.fact.basis,
      personId: targets.personId ?? null,
      companyId: targets.companyId ?? null,
      projectId: targets.projectId ?? null,
      linkId: targets.linkId ?? null,
      dependsOnFactId: extra.dependsOnFactId ?? null,
      field: d.fact.type === 'link_role' ? 'role' : d.fact.field,
      valueEnc: enc(d.fact.value),
      previousValueEnc: enc(d.fact.previousValue),
      conflict: d.fact.conflict,
      confidence: Math.min(1, Math.max(0, d.fact.confidence)),
      evidenceEnc: evidence ? encryptContent(evidence) : null,
      fingerprint: d.fingerprint,
      reason: state === 'suggested' ? (extra.reason ?? 'low_confidence') : null,
      policyVersion: run.policyVersion,
      promptVersion: run.promptVersion,
    },
    run.tx,
  );
  if (fact) run.counts[state === 'applied' ? 'applied' : 'suggested'] += 1;
  return fact;
}

type FactTargets = { personId?: string | null; companyId?: string | null; projectId?: string | null; linkId?: string | null };

/** Accept of a suggestion: the stored row becomes `applied` and gains the targets the change created or found. */
async function markAccepted(run: Run, targets: FactTargets): Promise<HubFact | null> {
  const set: Partial<typeof hubFact.$inferInsert> = { state: 'applied', decidedAt: new Date() };
  for (const [k, v] of Object.entries(targets) as [keyof FactTargets, string | null | undefined][]) if (v) set[k] = v;
  const [row] = await run.tx
    .update(hubFact)
    .set(set)
    .where(and(eq(hubFact.id, run.accepting!.id), eq(hubFact.userId, run.ctx.userId), eq(hubFact.state, 'suggested')))
    .returning();
  if (!row) return null;
  run.counts.applied += 1;
  run.accepted = row;
  return row;
}

function targetsOf(run: Run, d: HubDecision, id: string | null) {
  if (d.fact.link) {
    const ends: Record<string, string | null> = {};
    for (const e of [d.fact.link.a, d.fact.link.b]) ends[`${e.kind}Id`] = endId(run, e);
    return ends as { personId?: string | null; companyId?: string | null; projectId?: string | null };
  }
  return { [`${d.fact.target.kind}Id`]: id } as { personId?: string | null; companyId?: string | null; projectId?: string | null };
}

/** Stores `d` as a suggestion; a decision whose record is itself only suggested depends on that fact. */
async function suggest(run: Run, d: HubDecision, id: string | null, linkId: string | null = null): Promise<void> {
  const depRef = d.dependsOnRef ?? (id === null ? d.ref : null);
  const dep = depRef ? run.factByRef.get(depRef) : undefined;
  const fact = await storeFact(run, d, 'suggested', { ...targetsOf(run, d, id), linkId }, {
    reason: d.reason && d.reason !== 'rejected' ? d.reason : (dep?.reason ?? 'low_confidence'),
    dependsOnFactId: dep && dep.state === 'suggested' ? dep.id : null,
  });
  if (fact && d.ref && RECORD_FACT_TYPES.has(d.fact.type) && !run.factByRef.has(d.ref)) run.factByRef.set(d.ref, fact);
}

/**
 * An auto decision whose record is not available (its creation became a suggestion) is stored as a suggestion
 * depending on it; with nothing to depend on it is left out. Returns true when handled.
 */
async function deferIfMissing(run: Run, d: HubDecision, id: string | null): Promise<boolean> {
  if (id !== null) return false;
  const depRef = d.dependsOnRef ?? d.ref;
  if (depRef && run.factByRef.get(depRef)?.state === 'suggested') await suggest(run, d, null);
  return true;
}

/** Corroboration: extra evidence on the fact behind the current value, no new fact state (data-model). */
async function corroborate(
  run: Run,
  target: { kind: HubKind; recordId: string; field: string } | { linkId: string },
): Promise<void> {
  if (run.threadId === null) return;
  const source = await mail.findCurrentValueFact(run.ctx, target, run.tx);
  if (!source || source.threadId === run.threadId) return;
  if (await mail.insertFactEvidence(run.ctx, source.id, run.threadId, run.tx)) run.counts.corroborated += 1;
}

async function applyCompany(run: Run, d: HubDecision): Promise<void> {
  const { ctx, tx } = run;
  if (d.action === 'match') {
    const id = d.fact.target.id!;
    if (d.ref) run.idByRef.set(d.ref, id);
    touch(run, 'company', id, false);
    return;
  }
  if (d.outcome === 'suggest') return suggest(run, d, null);
  const v = d.fact.value as { name: string; website: string | null };
  const name = String(v.name);
  const website = v.website ? normalizeWebsite(String(v.website)) : null;
  const values: Omit<typeof hubCompany.$inferInsert, 'userId'> = {
    nameEnc: encryptContent(name),
    nameKey: nameKey(ctx.userId, 'company', name),
    matchKey: matchKey(ctx.userId, 'company', name),
    websiteEnc: website ? encryptContent(website) : null,
    ownerFields: [],
    createdFrom: 'email',
  };
  const row = await repo.insertRecord(ctx, 'company', values, tx);
  const fact = await storeFact(run, d, 'applied', { companyId: row.id });
  if (d.ref) {
    run.idByRef.set(d.ref, row.id);
    if (fact) run.factByRef.set(d.ref, fact);
  }
  touch(run, 'company', row.id, true);
}

async function applyCompanyDomain(run: Run, d: HubDecision): Promise<void> {
  const id = d.fact.target.id ?? (d.ref ? (run.idByRef.get(d.ref) ?? null) : null);
  const domain = validateContactValue('domain', String(d.fact.value.domain ?? ''));
  if (domain === null) return;
  if (d.outcome === 'suggest') return suggest(run, d, id);
  if (await deferIfMissing(run, d, id)) return;
  const existing = await repo.findDomainByHash(run.ctx, domainHash(domain), run.tx);
  if (existing) {
    if (existing.companyId === id) touch(run, 'company', id!, false);
    return;
  }
  await repo.insertDomain(
    run.ctx,
    { companyId: id!, domainEnc: encryptContent(domain), domainHash: domainHash(domain), origin: 'email' },
    run.tx,
  );
  await storeFact(run, d, 'applied', { companyId: id });
  touch(run, 'company', id!, true);
}

async function insertEmailRow(run: Run, personId: string, address: string): Promise<boolean> {
  if (await repo.findEmailByHash(run.ctx, addressHash(address), run.tx)) return false;
  const hasPrimary = (await repo.listEmails(run.ctx, personId, run.tx)).some((e) => e.isPrimary);
  await repo.insertEmail(
    run.ctx,
    {
      personId,
      addressEnc: encryptContent(address),
      addressHash: addressHash(address),
      matchHash: matchHash(address),
      isPrimary: !hasPrimary,
      origin: 'email',
    },
    run.tx,
  );
  return true;
}

async function applyPerson(run: Run, d: HubDecision): Promise<void> {
  const { ctx, tx } = run;
  if (d.action === 'match') {
    const id = d.fact.target.id!;
    if (d.ref) run.idByRef.set(d.ref, id);
    touch(run, 'person', id, false);
    return;
  }
  if (d.outcome === 'suggest') return suggest(run, d, null);
  const address = validateContactValue('email', String(d.fact.value.email ?? ''));
  if (address === null || (await repo.findEmailByHash(ctx, addressHash(address), tx))) return;
  const name = String(d.fact.value.name);
  const row = await repo.insertRecord(
    ctx,
    'person',
    {
      nameEnc: encryptContent(name),
      nameKey: nameKey(ctx.userId, 'person', name),
      matchKey: matchKey(ctx.userId, 'person', name),
      ownerFields: [],
      createdFrom: 'email',
    },
    tx,
  );
  await insertEmailRow(run, row.id, address);
  const fact = await storeFact(run, d, 'applied', { personId: row.id });
  if (d.ref) {
    run.idByRef.set(d.ref, row.id);
    if (fact) run.factByRef.set(d.ref, fact);
  }
  touch(run, 'person', row.id, true);
}

async function applyPersonEmail(run: Run, d: HubDecision): Promise<void> {
  const id = d.fact.target.id!;
  if (d.outcome === 'suggest') return suggest(run, d, id);
  const address = validateContactValue('email', String(d.fact.value.address ?? ''));
  if (address === null || !(await insertEmailRow(run, id, address))) return;
  const fact = await storeFact(run, d, 'applied', { personId: id });
  if (d.ref) {
    run.idByRef.set(d.ref, id);
    if (fact) run.factByRef.set(d.ref, fact);
  }
  touch(run, 'person', id, true);
}

async function applyField(run: Run, d: HubDecision): Promise<void> {
  const kind = d.fact.target.kind;
  const id = d.fact.target.id ?? (d.ref ? (run.idByRef.get(d.ref) ?? null) : null);
  const field = d.fact.field!;
  if (d.action === 'corroborate') {
    if (id === null) return;
    await corroborate(run, { kind, recordId: id, field });
    touch(run, kind, id, false);
    return;
  }
  if (d.outcome === 'suggest') return suggest(run, d, id);
  if (await deferIfMissing(run, d, id)) return;
  const raw = String(d.fact.value.value ?? '');
  const value = field === 'phone' ? validateContactValue('phone', raw) : raw.trim() || null;
  const column = FIELD_COLUMN[field];
  if (value === null || !column) return;
  const row = await repo.lockRecord(run.ctx, kind, id!, run.tx);
  if (!row) return;
  // SC-007: a user-entered or cleared value is never overwritten, even if it changed after the state was read.
  // Only the user's own accept of the suggestion writes it; an accepted conflict joins `owner_fields`.
  if (row.ownerFields.includes(field) && !run.accepting) return;
  const ownerFields = run.accepting?.conflict && !row.ownerFields.includes(field) ? { ownerFields: [...row.ownerFields, field] } : {};
  await repo.updateRecord(run.ctx, kind, id!, { [column]: encryptContent(value), ...ownerFields } as never, run.tx);
  const fact = await storeFact(run, d, 'applied', { [`${kind}Id`]: id });
  if (fact) await mail.supersedeFieldFacts(run.ctx, kind, id!, field, fact.id, run.tx);
  touch(run, kind, id!, true);
}

async function applyProject(run: Run, d: HubDecision): Promise<void> {
  const { ctx, tx } = run;
  if (d.action === 'match') {
    const id = d.fact.target.id!;
    if (d.ref) run.idByRef.set(d.ref, id);
    touch(run, 'project', id, false);
    return;
  }
  if (d.outcome === 'suggest') return suggest(run, d, null);
  const v = d.fact.value as { name: string; description: string | null; status: HubProject['status'] | null };
  const name = String(v.name);
  const values: Omit<typeof hubProject.$inferInsert, 'userId'> = {
    nameEnc: encryptContent(name),
    nameKey: nameKey(ctx.userId, 'project', name),
    matchKey: matchKey(ctx.userId, 'project', name),
    descriptionEnc: v.description ? encryptContent(v.description) : null,
    status: v.status ?? 'planned',
    ownerFields: [],
    createdFrom: 'email',
  };
  const row = await repo.insertRecord(ctx, 'project', values, tx);
  const fact = await storeFact(run, d, 'applied', { projectId: row.id });
  if (d.ref) {
    run.idByRef.set(d.ref, row.id);
    if (fact) run.factByRef.set(d.ref, fact);
  }
  touch(run, 'project', row.id, true);
}

async function applyLink(run: Run, d: HubDecision): Promise<void> {
  const draft = d.fact.link!;
  const a = endId(run, draft.a);
  const b = endId(run, draft.b);
  if (draft.linkId) {
    // The pair is already linked: nothing new to store, the role decision follows.
    run.linkByPair.set(pairKey(d), draft.linkId);
    return;
  }
  if (d.outcome === 'suggest' || a === null || b === null) {
    if (d.outcome === 'suggest') return suggest(run, d, null);
    return void (await deferIfMissing(run, d, null));
  }
  const ends = { kind: draft.a.kind, id: a };
  const other = { kind: draft.b.kind, id: b };
  const existing = await repo.findLinkBetween(run.ctx, ends, other, run.tx);
  if (existing) {
    run.linkByPair.set(pairKey(d), existing.id);
    if (run.accepting) await storeFact(run, d, 'applied', { ...targetsOf(run, d, null), linkId: existing.id });
    return;
  }
  // A suggested link carries its role in `value`: an accepted one is created with it.
  const role = run.accepting ? String(d.fact.value.role ?? '').trim().slice(0, HUB_EXTRACTION_LIMITS.linkRole) : '';
  const row = await repo.insertLink(
    run.ctx,
    {
      kind: draft.kind,
      [`${draft.a.kind}Id`]: a,
      [`${draft.b.kind}Id`]: b,
      roleEnc: role === '' ? null : encryptContent(role),
      roleOwnerSet: false,
      origin: 'email',
    },
    run.tx,
  );
  run.linkByPair.set(pairKey(d), row.id);
  await storeFact(run, d, 'applied', { ...targetsOf(run, d, null), linkId: row.id });
  run.changedLinks.set(row.id, row);
}

async function applyLinkRole(run: Run, d: HubDecision): Promise<void> {
  const linkId = d.fact.link?.linkId ?? run.linkByPair.get(pairKey(d)) ?? null;
  if (linkId === null) return;
  if (d.action === 'corroborate') return corroborate(run, { linkId });
  if (d.outcome === 'suggest') return suggest(run, d, null, linkId);
  const role = String(d.fact.value.role ?? '').trim().slice(0, HUB_EXTRACTION_LIMITS.linkRole);
  if (role === '') return;
  const link = await repo.lockLink(run.ctx, linkId, run.tx);
  // FR-016: a role the user set or cleared is never overwritten, except by the user's accept of the suggestion;
  // an accepted conflict becomes owner-set.
  if (!link || (link.roleOwnerSet && !run.accepting)) return;
  const ownerSet = run.accepting?.conflict ? { roleOwnerSet: true } : {};
  const updated = await repo.updateLink(run.ctx, linkId, { roleEnc: encryptContent(role), ...ownerSet }, run.tx);
  const fact = await storeFact(run, d, 'applied', { ...targetsOf(run, d, null), linkId });
  if (fact) await mail.supersedeLinkRoleFacts(run.ctx, linkId, fact.id, run.tx);
  if (updated) run.changedLinks.set(linkId, updated);
}

async function applyDecision(run: Run, d: HubDecision): Promise<void> {
  // A re-run of the same thread: the finding is stored, its change was written by the first run.
  const stored = run.threadId === null ? null : await mail.getFactByThreadFingerprint(run.ctx, run.threadId, d.fingerprint, run.tx);
  if (stored) {
    const id = stored.personId ?? stored.companyId ?? stored.projectId;
    if (d.ref && RECORD_FACT_TYPES.has(stored.type)) {
      if (!run.factByRef.has(d.ref)) run.factByRef.set(d.ref, stored);
      if (stored.state === 'applied' && id) run.idByRef.set(d.ref, id);
    }
    if (stored.type === 'link' && stored.linkId) run.linkByPair.set(pairKey(d), stored.linkId);
    if (stored.state === 'applied' && id && !d.fact.link) touch(run, d.fact.target.kind, id, false);
    return;
  }
  return applyByType(run, d);
}

function applyByType(run: Run, d: HubDecision): Promise<void> {
  switch (d.fact.type) {
    case 'company':
      return applyCompany(run, d);
    case 'company_domain':
      return applyCompanyDomain(run, d);
    case 'person':
      return applyPerson(run, d);
    case 'person_email':
      return applyPersonEmail(run, d);
    case 'field':
      return applyField(run, d);
    case 'project':
      return applyProject(run, d);
    case 'link':
      return applyLink(run, d);
    case 'link_role':
      return applyLinkRole(run, d);
  }
}

/** A `fact:{fingerprint}` marker (a suggestion rejected in another thread) turns an auto write into a suggestion. */
async function downgradeRejectedFacts(ctx: ServiceContext, decisions: HubDecision[], tx: Tx): Promise<HubDecision[]> {
  const writes = decisions.filter((d) => d.outcome === 'auto' && d.action !== 'match' && d.action !== 'corroborate');
  const blocked = await mail.listBlockedKeyHashes(ctx, writes.map((d) => markerKey.fact(d.fingerprint)), tx);
  if (blocked.size === 0) return decisions;
  return decisions.map((d) =>
    writes.includes(d) && blocked.has(markerKey.fact(d.fingerprint)) ? { ...d, outcome: 'suggest', reason: 'tombstoned' } : d,
  );
}

function newRun(ctx: ServiceContext, threadId: string | null, tx: Tx, policyVersion: string, promptVersion: string, accepting: HubFact | null = null): Run {
  return {
    ctx,
    threadId,
    tx,
    accepting,
    accepted: null,
    policyVersion,
    promptVersion,
    idByRef: new Map(),
    factByRef: new Map(),
    linkByPair: new Map(),
    touched: new Map(),
    changedLinks: new Map(),
    counts: { applied: 0, suggested: 0, corroborated: 0 },
  };
}

/** Thread records, search rows and sync marks for every record the run involves. */
async function finishRecords(run: Run): Promise<void> {
  const { ctx, tx } = run;
  for (const t of run.touched.values()) {
    const attached = run.threadId === null ? false : await mail.insertThreadRecord(ctx, run.threadId, t.kind, t.id, tx);
    if (t.changed) {
      const row = await repo.getRecord(ctx, t.kind, t.id, tx);
      if (row) await reindex(ctx, t.kind, row, tx);
    }
    if (t.changed || attached) await markDirty(tx, ctx.userId, t.kind, t.id);
  }
  for (const l of run.changedLinks.values()) {
    for (const kind of KINDS) {
      const id = kind === 'person' ? l.personId : kind === 'company' ? l.companyId : l.projectId;
      if (id) await markRecordTree(tx, ctx.userId, kind, id);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Accepting a stored suggestion (US4, `services/hub/suggestions.ts`)

/** Targets of a stored fact, with the ends a dependency created filled in by the caller. */
export interface StoredFactTargets {
  personId: string | null;
  companyId: string | null;
  projectId: string | null;
  linkId: string | null;
}

/** The record kind a fact of `type` targets; `link` for links and roles. */
export function factTargetKind(fact: Pick<HubFact, 'type' | 'field'>): HubKind | 'link' {
  switch (fact.type) {
    case 'person':
    case 'person_email':
      return 'person';
    case 'company':
    case 'company_domain':
      return 'company';
    case 'project':
      return 'project';
    case 'field':
      return fact.field === 'industry' ? 'company' : 'person';
    case 'link':
    case 'link_role':
      return 'link';
  }
}

/** The link kind and ends of a `link` or `link_role` fact (canonical order, as `markerKey.link`). */
export function factLinkEnds(
  kind: HubLink['kind'],
  t: StoredFactTargets,
): { kind: HubLink['kind']; a: { kind: HubKind; id: string | null }; b: { kind: HubKind; id: string | null } } {
  const [ka, kb] = LINK_ENDS[kind];
  const idOf = (k: HubKind) => (k === 'person' ? t.personId : k === 'company' ? t.companyId : t.projectId);
  return { kind, a: { kind: ka, id: idOf(ka) }, b: { kind: kb, id: idOf(kb) } };
}

/** Rebuilds the policy decision of a stored suggestion as an `auto` write of its draft value. */
function acceptedDecision(fact: HubFact, value: Record<string, unknown>, t: StoredFactTargets, linkKind: HubLink['kind'] | null): HubDecision {
  const kind = factTargetKind(fact);
  let target: LinkEnd;
  let link: LinkDraft | null = null;
  if (kind === 'link') {
    const ends = factLinkEnds(linkKind ?? 'person_company', t);
    const end = (e: { kind: HubKind; id: string | null }): LinkEnd => ({ kind: e.kind, id: e.id, ref: null });
    link = { kind: ends.kind, a: end(ends.a), b: end(ends.b), linkId: fact.type === 'link_role' ? t.linkId : null };
    target = link.a;
  } else {
    target = { kind, id: kind === 'person' ? t.personId : kind === 'company' ? t.companyId : t.projectId, ref: null };
  }
  const action: HubDecision['action'] =
    fact.type === 'person' || fact.type === 'company' || fact.type === 'project' || fact.type === 'link'
      ? 'create'
      : fact.type === 'person_email' || fact.type === 'company_domain'
        ? 'attach'
        : 'update';
  return {
    fact: {
      type: fact.type,
      target,
      field: fact.type === 'field' ? fact.field : null,
      value,
      previousValue: null,
      conflict: fact.conflict,
      confidence: fact.confidence,
      basis: fact.basis ?? 'text',
      evidence: null,
      link,
    },
    outcome: 'auto',
    reason: null,
    action,
    ref: null,
    dependsOnRef: null,
    fingerprint: fact.fingerprint,
  };
}

async function alreadyOnRecord(run: Run, d: HubDecision): Promise<boolean> {
  if (d.fact.type === 'person_email') {
    const address = validateContactValue('email', String(d.fact.value.address ?? ''));
    const row = address === null ? null : await repo.findEmailByHash(run.ctx, addressHash(address), run.tx);
    return row?.personId === d.fact.target.id;
  }
  if (d.fact.type === 'company_domain') {
    const domain = validateContactValue('domain', String(d.fact.value.domain ?? ''));
    const row = domain === null ? null : await repo.findDomainByHash(run.ctx, domainHash(domain), run.tx);
    return row?.companyId === d.fact.target.id;
  }
  return false;
}

/**
 * Accepts one `suggested` fact inside the caller's transaction, which must hold the per-user apply lock: writes its
 * draft value (`value_enc`) through the same appliers as `applyExtraction` (an owner-set value is overwritten only
 * here; an accepted conflict joins `owner_fields` or makes the link role owner-set), attaches its thread, re-indexes
 * and marks dirty what changed, and turns the row `applied` with `decided_at` and the targets it created. A value
 * that is already present (an existing link, address or domain) is accepted without a write. Returns the updated
 * row, or null when the change could not be written (the value is invalid or the record it needs is missing).
 */
export async function applyStoredFact(ctx: ServiceContext, fact: HubFact, targets: StoredFactTargets, tx: Tx): Promise<HubFact | null> {
  const value = fact.valueEnc === null ? {} : (JSON.parse(decryptContent(fact.valueEnc)) as unknown);
  const draft = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  let linkKind: HubLink['kind'] | null = null;
  if (fact.type === 'link') linkKind = (draft.kind as HubLink['kind'] | undefined) ?? null;
  if (fact.type === 'link_role' && targets.linkId) linkKind = (await repo.getLink(ctx, targets.linkId, tx))?.kind ?? null;
  if (linkKind !== null && !Object.hasOwn(LINK_ENDS, linkKind)) return null;
  if ((fact.type === 'link' || fact.type === 'link_role') && linkKind === null) return null;

  const run = newRun(ctx, fact.threadId, tx, fact.policyVersion, fact.promptVersion, fact);
  const d = acceptedDecision(fact, draft, targets, linkKind);
  await applyByType(run, d);
  // The address or domain is already on the target record: nothing to write, the row is accepted as it is.
  if (!run.accepted && d.fact.target.id && (await alreadyOnRecord(run, d))) {
    await markAccepted(run, { [`${d.fact.target.kind}Id`]: d.fact.target.id });
  }
  if (run.accepted) {
    for (const k of KINDS) {
      const id = k === 'person' ? run.accepted.personId : k === 'company' ? run.accepted.companyId : run.accepted.projectId;
      if (id) touch(run, k, id, false);
    }
  }
  await finishRecords(run);
  return run.accepted;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point

/**
 * Applies one extraction of a claimed thread version. Inspects the outputs first (no lock held), then in one
 * transaction under `pg_advisory_xact_lock(hashtext('hub-apply:' || userId))`: decides with the current records,
 * owner fields, link roles, block markers and redirects, writes the decisions with their `hub_fact` rows, attaches
 * the thread to its records, stores the summary when `relevant` and at least one record is attached (otherwise the
 * thread is skipped as `irrelevant` or `no_candidates`), marks summary, records and links dirty, bumps the mailbox
 * counters and completes the thread. A lease lost before commit rolls everything back (`lease_lost`).
 * Throws 503 `inspection_unavailable` when the outputs cannot be inspected; database errors propagate.
 */
export async function applyExtraction(
  userId: string,
  threadId: string,
  claimedVersion: number,
  extraction: HubExtraction,
  context: ApplyContext,
): Promise<ApplyResult> {
  const ctx: ServiceContext = { userId, role: 'user' };
  const policy = context.policy ?? HUB_POLICY_V1;
  const inspected = await inspectOutputs(userId, extraction, context.participants);
  const x = inspected.extraction;
  const result = (outcome: ApplyResult['outcome'], skipReason: ApplySkipReason | null, run?: Run, summaryStored = false): ApplyResult => ({
    outcome,
    skipReason,
    applied: run?.counts.applied ?? 0,
    suggested: run?.counts.suggested ?? 0,
    corroborated: run?.counts.corroborated ?? 0,
    summaryStored,
    redactedValues: inspected.redactedValues,
  });

  try {
    return await withTransaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hub-apply:' || ${userId}))`);
      const locked = await mail.lockThreadForApply(ctx, threadId, tx);
      if (!locked?.leaseHeld) throw new LeaseLost();
      const thread = locked.thread;

      const run = newRun(ctx, threadId, tx, policy.version, context.promptVersion);

      if (x.relevant) {
        const threadDate = context.threadDate ?? thread.lastMessageAt ?? thread.createdAt;
        const state = await loadState(ctx, threadId, threadDate, x, context, inspected.participants, tx);
        const decisions = await downgradeRejectedFacts(ctx, decide(x, state, policy), tx);
        for (const d of decisions) if (d.outcome !== 'drop') await applyDecision(run, d);
      }

      await finishRecords(run);

      const skipReason: ApplySkipReason | null = !x.relevant
        ? 'irrelevant'
        : (await mail.countThreadRecords(ctx, threadId, tx)) === 0
          ? 'no_candidates'
          : null;
      let summaryStored = false;
      if (skipReason === null) {
        const participants: HubParticipant[] = inspected.participants.map((p) => ({
          address: p.address,
          name: p.name,
          roles: p.roles,
          sent: p.sent,
          owner: p.owner,
          automated: p.automated,
          roleAddress: p.roleAddress,
          freeMail: p.freeMail,
        }));
        const summary = inspected.summary;
        await mail.storeThreadResult(
          ctx,
          threadId,
          {
            language: x.language,
            participantsEnc: encryptContent(JSON.stringify(participants)),
            ...(summary ? { summaryEnc: encryptContent(summary) } : {}),
          },
          tx,
        );
        if (summary) {
          await markDirty(tx, userId, 'summary', threadId);
          summaryStored = true;
        }
      }

      const outcome = skipReason === null ? 'done' : 'skipped';
      if (!(await completeThread(threadId, claimedVersion, outcome, skipReason, tx))) throw new LeaseLost();
      await mail.bumpMailboxCounters(ctx, threadId, outcome, tx);
      return result(outcome, skipReason, run, summaryStored);
    });
  } catch (err) {
    if (err instanceof LeaseLost) return result('lease_lost', null);
    throw err;
  }
}
