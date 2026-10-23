import {
  getDb,
  type DbOrTx,
  type HubCompany,
  type HubFile,
  type HubLink,
  type HubPerson,
  type HubProject,
} from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import { getThread, listThreadRecords } from '@voicespark/db/repos/user/hub-mail';
import * as repo from '@voicespark/db/repos/user/hub-records';
import {
  buildHubDocument,
  inspectSegments,
  validateContactValue,
  type Classifier,
  type ContactValue,
  type FilteredText,
  type HubDocument,
  type HubLinkedName,
  type Policy,
} from '@voicespark/filters';
import { META, type MemoryDoc, type MemoryMetadata } from '@voicespark/integrations/supermemory';
import { noteToMarkdown, type HubNoteDoc } from '../../hub/content-schema';
import { AppError } from '../../errors';
import { getClassifier, loadPolicy } from '../inspection';
import { decryptContent, type HubKind } from './common';
import { docIdFor, type SyncEntityType } from './sync';

// Memory-store documents of the Context Hub (contracts/memory-store-hub.md "Metadata", "Content shape" and
// "Contact-value rule"; FR-025, FR-028). Every build starts from the current rows: decrypt, run every text field
// through the user's current full policy in one `inspectSegments` call (the only way to obtain `FilteredText`),
// validate contact values, then `buildHubDocument`. A copy from an earlier build is never reused.

export interface BuildOptions {
  /** Outbox `version` that produces the document (`vs_hub_version`). */
  version?: number;
  classifier?: Classifier;
  db?: DbOrTx;
}

type Ref = { kind: HubKind; id: string };

const KINDS: HubKind[] = ['person', 'company', 'project'];
const refKey = (r: Ref) => `${r.kind}:${r.id}`;
const decOpt = (blob: string | null): string | null => (blob === null ? null : decryptContent(blob));

/**
 * Collects raw strings for one inspection pass. `add` returns a handle; after `filter` the handle resolves to the
 * filtered text. Throws 503 `inspection_unavailable` on any inspection failure and 422 `sensitive_content` when the
 * whole set is excluded under the current policy (fail-closed: nothing is built).
 */
class Texts {
  private readonly raw: string[] = [];
  private out: FilteredText[] | undefined;

  add(text: string): number {
    this.raw.push(text);
    return this.raw.length - 1;
  }

  opt(text: string | null | undefined): number | undefined {
    return text === null || text === undefined || text === '' ? undefined : this.add(text);
  }

  async filter(policy: Policy, classifier: Classifier): Promise<void> {
    let result: Awaited<ReturnType<typeof inspectSegments>>;
    try {
      result = await inspectSegments(this.raw, policy, { classifier });
    } catch {
      // Error details are dropped deliberately: they may echo content.
      throw new AppError('inspection_unavailable');
    }
    if (result.excluded) {
      if (result.category === 'inspection_failed') throw new AppError('inspection_unavailable');
      throw new AppError('sensitive_content');
    }
    this.out = result.segments;
  }

  get(handle: number): FilteredText {
    return this.out![handle]!;
  }

  getOpt(handle: number | undefined): FilteredText | undefined {
    return handle === undefined ? undefined : this.get(handle);
  }
}

/** The other end of a link seen from `kind`. */
function otherEnd(kind: HubKind, l: HubLink): Ref | null {
  for (const k of KINDS) {
    if (k === kind) continue;
    const id = k === 'person' ? l.personId : k === 'company' ? l.companyId : l.projectId;
    if (id) return { kind: k, id };
  }
  return null;
}

function ownerOf(row: { personId: string | null; companyId: string | null; projectId: string | null }): Ref {
  if (row.personId) return { kind: 'person', id: row.personId };
  if (row.companyId) return { kind: 'company', id: row.companyId };
  return { kind: 'project', id: row.projectId! };
}

/** Decrypted names of the given records; missing (deleted or foreign) records are left out. */
async function namesOf(userId: string, refs: Ref[], db: DbOrTx): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const kind of KINDS) {
    const ids = [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
    for (const row of await repo.getRecordsByIds({ userId }, kind, ids, db)) {
      names.set(refKey({ kind, id: row.id }), decryptContent(row.nameEnc));
    }
  }
  return names;
}

interface LinkedEntry {
  ref: Ref;
  name: string;
  role: string | null;
}

/** Records linked to `ref` with their names and link roles, in link order. */
async function linkedOf(userId: string, ref: Ref, db: DbOrTx): Promise<LinkedEntry[]> {
  const rows = await repo.listLinksForRecord({ userId }, ref.kind, ref.id, db);
  const ends = rows.map((l) => ({ ref: otherEnd(ref.kind, l), role: decOpt(l.roleEnc) }));
  const names = await namesOf(userId, ends.flatMap((e) => (e.ref ? [e.ref] : [])), db);
  return ends.flatMap((e) => {
    const name = e.ref ? names.get(refKey(e.ref)) : undefined;
    return e.ref && name !== undefined ? [{ ref: e.ref, name, role: e.role }] : [];
  });
}

function contactValues(kind: 'email' | 'phone' | 'domain', raws: readonly string[]): ContactValue[] {
  return raws.map((r) => validateContactValue(kind, r)).filter((v): v is ContactValue => v !== null);
}

/** Linked names of one kind as filtered `{name, role}` handles. */
function linkedHandles(t: Texts, linked: LinkedEntry[], kind: HubKind): { name: number; role?: number }[] {
  return linked
    .filter((l) => l.ref.kind === kind)
    .map((l) => ({ name: t.add(l.name), role: t.opt(l.role) }));
}

function resolveLinked(t: Texts, handles: { name: number; role?: number }[]): HubLinkedName[] {
  return handles.map((h) => {
    const role = t.getOpt(h.role);
    return role === undefined ? { name: t.get(h.name) } : { name: t.get(h.name), role };
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isoDate = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '');

interface Built {
  document: HubDocument;
  itemTs: Date;
  linked: Ref[];
  extra: MemoryMetadata;
}

interface BuildEnv {
  userId: string;
  policy: Policy;
  classifier: Classifier;
  db: DbOrTx;
}

async function buildRecord(env: BuildEnv, kind: HubKind, id: string): Promise<Built | null> {
  const { userId, db } = env;
  const row = await repo.getRecord({ userId }, kind, id, db);
  if (!row) return null;
  const linked = await linkedOf(userId, { kind, id }, db);
  const t = new Texts();
  const name = t.add(decryptContent(row.nameEnc));
  const description = t.opt(decOpt(row.descriptionEnc));
  const base = { linked: linked.map((l) => l.ref), itemTs: row.updatedAt };

  if (kind === 'person') {
    const p = row as HubPerson;
    const emails = await repo.listEmails({ userId }, id, db);
    const roleTitle = t.opt(decOpt(p.roleTitleEnc));
    const companies = linkedHandles(t, linked, 'company');
    const projects = linkedHandles(t, linked, 'project');
    await t.filter(env.policy, env.classifier);
    const phone = decOpt(p.phoneEnc);
    return {
      ...base,
      document: buildHubDocument('person', {
        policy: env.policy,
        name: t.get(name),
        roleTitle: t.getOpt(roleTitle),
        emails: contactValues('email', emails.map((e) => decryptContent(e.addressEnc))),
        phones: contactValues('phone', phone === null ? [] : [phone]),
        companies: resolveLinked(t, companies),
        projects: resolveLinked(t, projects),
        description: t.getOpt(description),
      }),
      extra: { [META.hubEmailHashes]: emails.map((e) => e.addressHash) },
    };
  }

  if (kind === 'company') {
    const c = row as HubCompany;
    const domains = await repo.listDomains({ userId }, id, db);
    const website = t.opt(decOpt(c.websiteEnc));
    const industry = t.opt(decOpt(c.industryEnc));
    const people = linkedHandles(t, linked, 'person');
    const projects = linkedHandles(t, linked, 'project');
    await t.filter(env.policy, env.classifier);
    return {
      ...base,
      document: buildHubDocument('company', {
        policy: env.policy,
        name: t.get(name),
        website: t.getOpt(website),
        industry: t.getOpt(industry),
        domains: contactValues('domain', domains.map((d) => decryptContent(d.domainEnc))),
        people: resolveLinked(t, people),
        projects: resolveLinked(t, projects),
        description: t.getOpt(description),
      }),
      extra: { [META.hubDomainHashes]: domains.map((d) => d.domainHash) },
    };
  }

  const p = row as HubProject;
  const status = t.add(p.status);
  const start = t.opt(p.startDate);
  const end = t.opt(p.endDate);
  const people = linkedHandles(t, linked, 'person');
  const companies = linkedHandles(t, linked, 'company');
  await t.filter(env.policy, env.classifier);
  return {
    ...base,
    document: buildHubDocument('project', {
      policy: env.policy,
      name: t.get(name),
      status: t.get(status),
      start: t.getOpt(start),
      end: t.getOpt(end),
      people: resolveLinked(t, people),
      companies: resolveLinked(t, companies),
      description: t.getOpt(description),
    }),
    extra: {},
  };
}

/** Owner name plus the owner's linked records: the "Belongs to" and "Linked" lines of notes and files. */
async function ownerContext(env: BuildEnv, owner: Ref): Promise<{ name: string; linked: LinkedEntry[] } | null> {
  const names = await namesOf(env.userId, [owner], env.db);
  const name = names.get(refKey(owner));
  if (name === undefined) return null;
  return { name, linked: await linkedOf(env.userId, owner, env.db) };
}

function ownerMetadata(owner: Ref): MemoryMetadata {
  return { [META.hubOwnerKind]: owner.kind, [META.hubOwnerId]: owner.id };
}

async function buildNote(env: BuildEnv, id: string): Promise<Built | null> {
  const row = await content.getNote({ userId: env.userId }, id, env.db);
  if (!row) return null;
  const owner = ownerOf(row);
  const ctx = await ownerContext(env, owner);
  if (!ctx) return null;
  const t = new Texts();
  const title = t.add(decryptContent(row.titleEnc));
  const ownerName = t.add(ctx.name);
  const linked = ctx.linked.map((l) => t.add(l.name));
  const markdown = t.add(noteToMarkdown(JSON.parse(decryptContent(row.bodyJsonEnc)) as HubNoteDoc));
  await t.filter(env.policy, env.classifier);
  return {
    document: buildHubDocument('note', {
      policy: env.policy,
      title: t.get(title),
      ownerKind: owner.kind,
      ownerName: t.get(ownerName),
      linked: linked.map((h) => t.get(h)),
      created: row.createdAt.toISOString(),
      updated: row.updatedAt.toISOString(),
      markdown: t.get(markdown),
    }),
    itemTs: row.updatedAt,
    linked: [owner, ...ctx.linked.map((l) => l.ref)],
    extra: ownerMetadata(owner),
  };
}

function fileStatus(row: HubFile): { status: 'extracted' | 'empty' | 'not_searchable' | 'excluded'; reason?: string } {
  switch (row.extractionStatus) {
    case 'extracted':
    case 'empty':
    case 'excluded':
      return { status: row.extractionStatus };
    default:
      // pending, unsupported and failed carry a reason code (never content).
      return { status: 'not_searchable', reason: row.extractionReason ?? row.extractionStatus };
  }
}

async function buildFile(env: BuildEnv, id: string): Promise<Built | null> {
  const row = await content.getFile({ userId: env.userId }, id, env.db);
  if (!row) return null;
  const owner = ownerOf(row);
  const ctx = await ownerContext(env, owner);
  if (!ctx) return null;
  const { status, reason } = fileStatus(row);
  const t = new Texts();
  const name = t.add(decryptContent(row.nameEnc));
  const ownerName = t.add(ctx.name);
  const description = t.opt(decOpt(row.descriptionEnc));
  const text = status === 'extracted' ? t.opt(decOpt(row.extractedTextEnc)) : undefined;
  await t.filter(env.policy, env.classifier);
  return {
    document: buildHubDocument('file', {
      policy: env.policy,
      name: t.get(name),
      extension: row.extension,
      size: formatSize(row.sizeBytes),
      ownerKind: owner.kind,
      ownerName: t.get(ownerName),
      description: t.getOpt(description),
      extractionStatus: status,
      ...(reason !== undefined ? { reason } : {}),
      text: t.getOpt(text),
    }),
    itemTs: row.updatedAt,
    linked: [owner, ...ctx.linked.map((l) => l.ref)],
    extra: ownerMetadata(owner),
  };
}

interface Participant {
  address: string;
  name: string | null;
  owner: boolean;
}

function parseParticipants(blob: string | null): Participant[] {
  if (blob === null) return [];
  const parsed = JSON.parse(decryptContent(blob)) as unknown;
  return Array.isArray(parsed) ? (parsed as Participant[]) : [];
}

async function buildSummary(env: BuildEnv, threadId: string): Promise<Built | null> {
  const { userId, db } = env;
  const thread = await getThread({ userId }, threadId, db);
  if (!thread || thread.summaryEnc === null) return null;
  const records = (await listThreadRecords({ userId }, threadId, db)).map((r) => ownerOf(r));
  const names = await namesOf(userId, records, db);
  const related = records.filter((r) => names.has(refKey(r)));

  const t = new Texts();
  const subject = t.add(decOpt(thread.subjectEnc) ?? '');
  const summary = t.add(decryptContent(thread.summaryEnc));
  const relatedNames = related.map((r) => t.add(names.get(refKey(r))!));
  // The owner is shown as "me"; an address is offered only next to a name, and only the contact rule writes it.
  const participants = parseParticipants(thread.participantsEnc).map((p) => ({
    name: t.add(p.owner ? 'me' : (p.name ?? p.address)),
    address: !p.owner && p.name ? (validateContactValue('email', p.address) ?? undefined) : undefined,
  }));
  await t.filter(env.policy, env.classifier);
  const lang = thread.language ?? 'other';
  return {
    document: buildHubDocument('summary', {
      policy: env.policy,
      subject: t.get(subject),
      firstDate: isoDate(thread.firstMessageAt),
      lastDate: isoDate(thread.lastMessageAt),
      messageCount: thread.messageCount,
      participants: participants.map((p) =>
        p.address === undefined ? { name: t.get(p.name) } : { name: t.get(p.name), address: p.address },
      ),
      related: relatedNames.map((h) => t.get(h)),
      attachments: [],
      summary: t.get(summary),
    }),
    itemTs: thread.lastMessageAt ?? thread.summaryUpdatedAt ?? thread.createdAt,
    linked: related,
    extra: { [META.lang]: lang },
  };
}

/**
 * The memory document of one hub entity, rebuilt from the current rows under the user's current policy, with the
 * full metadata set of contracts/memory-store-hub.md (no names, addresses or domains in metadata). Returns `null`
 * when the entity is gone (deleted, foreign, or a thread without a summary): the caller removes the document.
 * Throws `AppError` `inspection_unavailable` or `sensitive_content` when the text cannot be filtered.
 */
export async function buildDocumentFor(
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
  opts: BuildOptions = {},
): Promise<MemoryDoc | null> {
  const db = opts.db ?? getDb();
  const { policy, version: policyVersion } = await loadPolicy(userId, db);
  const env: BuildEnv = { userId, policy, classifier: opts.classifier ?? getClassifier(), db };
  const built =
    entityType === 'note'
      ? await buildNote(env, entityId)
      : entityType === 'file'
        ? await buildFile(env, entityId)
        : entityType === 'summary'
          ? await buildSummary(env, entityId)
          : await buildRecord(env, entityType, entityId);
  if (!built) return null;
  const linkedKeys = [...new Set(built.linked.map(refKey))];
  return {
    id: docIdFor(entityType, entityId),
    content: built.document.content,
    documentDate: built.itemTs.toISOString(),
    metadata: {
      [META.kind]: `hub_${entityType}`,
      [META.hubItemId]: entityId,
      [META.hubLinkedKeys]: linkedKeys,
      [META.itemTs]: built.itemTs.getTime(),
      [META.hubVersion]: opts.version ?? 0,
      [META.filterPolicyVersion]: policyVersion,
      ...built.extra,
    },
  };
}
