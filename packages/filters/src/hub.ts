import { isValidPhoneNumber } from 'libphonenumber-js/max';
import type {
  CategoryCount,
  ContactValue,
  CountCategory,
  FilteredText,
  HubLlmText,
  InspectionInput,
  Policy,
  Span,
} from './categories';
import * as apiKeys from './detectors/api-keys';
import * as bankAccounts from './detectors/bank-accounts';
import * as governmentIds from './detectors/government-ids';
import * as otpCodes from './detectors/otp-codes';
import * as passwords from './detectors/passwords';
import * as paymentCards from './detectors/payment-cards';
import * as resetLinks from './detectors/reset-links';
import { asContactValue, asFiltered, asHubLlmText } from './internal/brand';
import { inspect, inspectTexts, type InspectDeps } from './pipeline';

export type HubInspectionResult =
  | { excluded: false; text: HubLlmText; counts: CategoryCount[]; redactedValues: number }
  | { excluded: true; category: CountCategory };

export type SegmentsResult =
  | { excluded: false; segments: FilteredText[]; redactedValues: number }
  | { excluded: true; category: CountCategory };

/** Joins segments for the rules, the credential-delivery score and the one classifier call. */
export const SEGMENT_SEPARATOR = '\n \n';

const sumRedacted = (counts: readonly CategoryCount[]): number =>
  counts.reduce((n, c) => n + c.redactedValues, 0);

/**
 * Hub-mode inspection for the extraction call (FR-028): the normal pipeline with the contacts detector
 * skipped and the From address kept. The text is the header lines (Subject, From, Title, File) and the body,
 * as `HubLlmText`, which no `FilteredText` sink accepts. Fails closed like `inspect`.
 */
export async function inspectForHubExtraction(
  input: InspectionInput,
  policy: Policy,
  deps: InspectDeps,
): Promise<HubInspectionResult> {
  const r = await inspect(input, policy, deps, { contactMode: 'hub_extraction' });
  if (r.outcome !== 'accepted' || r.text === undefined) {
    return { excluded: true, category: r.counts[0]?.category ?? 'inspection_failed' };
  }
  const f = r.fields ?? {};
  const lines: string[] = [];
  if (f.subject !== undefined) lines.push(`Subject: ${f.subject}`);
  const from = f.fromName !== undefined && f.fromAddress !== undefined ? `${f.fromName} <${f.fromAddress}>` : (f.fromName ?? f.fromAddress);
  if (from !== undefined) lines.push(`From: ${from}`);
  if (f.title !== undefined) lines.push(`Title: ${f.title}`);
  if (f.filename !== undefined) lines.push(`File: ${f.filename}`);
  const head = lines.join('\n');
  return {
    excluded: false,
    text: asHubLlmText(head ? `${head}\n\n${r.text}` : r.text),
    counts: r.counts,
    redactedValues: sumRedacted(r.counts),
  };
}

/**
 * The full user policy over a list of strings in one pass. Detectors run per segment; the classifier gets one
 * call over the segments joined by `SEGMENT_SEPARATOR` and its spans are located per segment (a span that
 * crosses a boundary excludes the call). Whole-item exclusion applies to the call.
 */
export async function inspectSegments(
  segments: readonly string[],
  policy: Policy,
  deps: InspectDeps,
): Promise<SegmentsResult> {
  if (segments.length === 0) return { excluded: false, segments: [], redactedValues: 0 };
  const r = await inspectTexts(segments, policy, deps, SEGMENT_SEPARATOR);
  if (r.outcome === 'excluded') return { excluded: true, category: r.category };
  return { excluded: false, segments: r.texts.map(asFiltered), redactedValues: sumRedacted(r.counts) };
}

/** Locked detectors plus payment, bank and government-id, run synchronously on a raw contact value. */
const CONTACT_DETECTORS: ReadonlyArray<(text: string) => Span[]> = [
  passwords.detectSync,
  otpCodes.detectSync,
  resetLinks.detectSync,
  apiKeys.detectSync,
  paymentCards.detectSync,
  bankAccounts.detectSync,
  governmentIds.detectSync,
];

const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PHONE_CHARS = /^[0-9+()\-.\s/x]*$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

function validFormat(kind: 'email' | 'phone' | 'domain', raw: string): string | null {
  switch (kind) {
    case 'email': {
      const value = raw.trim().toLowerCase();
      if (value.length > 320 || (value.split('@')[0] ?? '').length > 64 || !EMAIL.test(value)) return null;
      return value;
    }
    case 'phone': {
      const value = raw.trim();
      if (value.length > 50 || !PHONE_CHARS.test(value) || !isValidPhoneNumber(value, 'PL')) return null;
      return value;
    }
    case 'domain': {
      const value = raw.trim().toLowerCase();
      if (value.startsWith('www.') || !DOMAIN.test(value)) return null;
      return value;
    }
  }
}

/**
 * Validates an email, phone or domain for the hub contact columns. Email is lower-cased (at most 320 chars),
 * a phone is kept as written (valid per libphonenumber, default region PL, at most 50 chars), a domain is
 * lower-cased without `www.`. Any hit of the locked, payment, bank or government-id detectors on the raw
 * value returns null.
 */
export function validateContactValue(kind: 'email' | 'phone' | 'domain', raw: string): ContactValue | null {
  if (CONTACT_DETECTORS.some((detect) => detect(raw).length > 0)) return null;
  const value = validFormat(kind, raw);
  return value === null ? null : asContactValue(value);
}

const MAX_LIST = 20;

export type HubRecordKind = 'person' | 'company' | 'project';

export interface HubLinkedName {
  name: FilteredText;
  role?: FilteredText;
}

interface HubDocumentPartsBase {
  /** The user's current policy; contact values are written only when it does not select third_party_contacts. */
  policy: Policy;
}

export interface HubPersonParts extends HubDocumentPartsBase {
  name: FilteredText;
  roleTitle?: FilteredText;
  emails: readonly ContactValue[];
  phones: readonly ContactValue[];
  companies: readonly HubLinkedName[];
  projects: readonly HubLinkedName[];
  description?: FilteredText;
}

export interface HubCompanyParts extends HubDocumentPartsBase {
  name: FilteredText;
  website?: FilteredText;
  industry?: FilteredText;
  domains: readonly ContactValue[];
  people: readonly HubLinkedName[];
  projects: readonly HubLinkedName[];
  description?: FilteredText;
}

export interface HubProjectParts extends HubDocumentPartsBase {
  name: FilteredText;
  status?: FilteredText;
  start?: FilteredText;
  end?: FilteredText;
  people: readonly HubLinkedName[];
  companies: readonly HubLinkedName[];
  description?: FilteredText;
}

export interface HubNoteParts extends HubDocumentPartsBase {
  title: FilteredText;
  ownerKind: HubRecordKind;
  ownerName: FilteredText;
  linked: readonly FilteredText[];
  created: string;
  updated: string;
  markdown: FilteredText;
}

export interface HubFileParts extends HubDocumentPartsBase {
  name: FilteredText;
  extension: string;
  size: string;
  ownerKind: HubRecordKind;
  ownerName: FilteredText;
  description?: FilteredText;
  extractionStatus: 'extracted' | 'empty' | 'not_searchable' | 'excluded';
  reason?: string;
  text?: FilteredText;
}

export interface HubSummaryParts extends HubDocumentPartsBase {
  subject: FilteredText;
  firstDate: string;
  lastDate: string;
  messageCount: number;
  participants: readonly { name: FilteredText; address?: ContactValue }[];
  related: readonly FilteredText[];
  attachments: readonly FilteredText[];
  summary: FilteredText;
}

export interface HubDocumentParts {
  person: HubPersonParts;
  company: HubCompanyParts;
  project: HubProjectParts;
  note: HubNoteParts;
  file: HubFileParts;
  summary: HubSummaryParts;
}

export type HubDocumentKind = keyof HubDocumentParts;

export interface HubDocument {
  kind: HubDocumentKind;
  content: FilteredText;
}

const contactsAllowed = (policy: Policy): boolean => !policy.selectedCategories.includes('third_party_contacts');

const capped = <T>(list: readonly T[]): T[] => list.slice(0, MAX_LIST);

const linkedList = (list: readonly HubLinkedName[]): string =>
  capped(list)
    .map((l) => (l.role !== undefined && l.role !== '' ? `${l.name} (${l.role})` : `${l.name}`))
    .join(', ');

/** Pushes `label: value` when the value is present and not empty. */
function line(lines: string[], label: string, value: string | undefined): void {
  if (value !== undefined && value !== '') lines.push(`${label}: ${value}`);
}

function withDescription(lines: string[], description: FilteredText | undefined): string {
  if (description !== undefined && description !== '') lines.push('', '## Description', description);
  return lines.join('\n');
}

function render<K extends HubDocumentKind>(kind: K, parts: HubDocumentParts[K]): string {
  switch (kind) {
    case 'person': {
      const p = parts as HubPersonParts;
      const lines = [`# Person: ${p.name}`, 'Type: person'];
      line(lines, 'Role', p.roleTitle);
      if (contactsAllowed(p.policy)) {
        line(lines, 'Email', capped(p.emails).join(', '));
        line(lines, 'Phone', capped(p.phones).join(', '));
      }
      line(lines, 'Companies', linkedList(p.companies));
      line(lines, 'Projects', linkedList(p.projects));
      return withDescription(lines, p.description);
    }
    case 'company': {
      const p = parts as HubCompanyParts;
      const lines = [`# Company: ${p.name}`];
      line(lines, 'Website', p.website);
      line(lines, 'Industry', p.industry);
      // Domains are not personal contact values; they are written under every policy.
      line(lines, 'Domains', capped(p.domains).join(', '));
      line(lines, 'People', linkedList(p.people));
      line(lines, 'Projects', linkedList(p.projects));
      return withDescription(lines, p.description);
    }
    case 'project': {
      const p = parts as HubProjectParts;
      const lines = [`# Project: ${p.name}`];
      line(lines, 'Status', p.status);
      line(lines, 'Start', p.start);
      line(lines, 'End', p.end);
      line(lines, 'People', linkedList(p.people));
      line(lines, 'Companies', linkedList(p.companies));
      return withDescription(lines, p.description);
    }
    case 'note': {
      const p = parts as HubNoteParts;
      const lines = [`# Note: ${p.title}`, `Belongs to: ${p.ownerKind} ${p.ownerName}`];
      line(lines, 'Linked', capped(p.linked).join(', '));
      lines.push(`Created: ${p.created}  Updated: ${p.updated}`, '---', p.markdown);
      return lines.join('\n');
    }
    case 'file': {
      const p = parts as HubFileParts;
      const lines = [`# File: ${p.name}`, `Type: ${p.extension}, ${p.size}`, `Belongs to: ${p.ownerKind} ${p.ownerName}`];
      line(lines, 'Description', p.description);
      const status =
        p.extractionStatus === 'not_searchable'
          ? `not searchable${p.reason !== undefined && p.reason !== '' ? ` (${p.reason})` : ''}`
          : p.extractionStatus;
      lines.push(`Text: ${status}`);
      // The body is written only for extracted text.
      if (p.extractionStatus === 'extracted' && p.text !== undefined && p.text !== '') lines.push('---', p.text);
      return lines.join('\n');
    }
    case 'summary': {
      const p = parts as HubSummaryParts;
      const allowed = contactsAllowed(p.policy);
      const participants = capped(p.participants).map((x) =>
        allowed && x.address !== undefined ? `${x.name} <${x.address}>` : `${x.name}`,
      );
      const lines = [`# Conversation: ${p.subject}`, `Dates: ${p.firstDate} to ${p.lastDate}  Messages: ${p.messageCount}`];
      line(lines, 'Participants', participants.join(', '));
      line(lines, 'Related', capped(p.related).join(', '));
      line(lines, 'Attachments', capped(p.attachments).join(', '));
      lines.push('---', p.summary);
      return lines.join('\n');
    }
    default:
      throw new Error('unknown hub document kind');
  }
}

/**
 * The only producer of hub memory documents (contracts/memory-store-hub.md). Parts carry `FilteredText`
 * fields and `ContactValue[]` only. Contact values (emails, phones) are written only when the policy does
 * not select third_party_contacts; company domains always. Lists are capped at 20, empty fields omitted.
 */
export function buildHubDocument<K extends HubDocumentKind>(kind: K, parts: HubDocumentParts[K]): HubDocument {
  return { kind, content: asFiltered(render(kind, parts)) };
}
