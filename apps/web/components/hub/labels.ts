// Shared hub labels/types. Not a 'use client' module so server components can import values.

export type HubKind = 'people' | 'companies' | 'projects';
export type ProjectStatus = 'planned' | 'active' | 'on_hold' | 'completed';

export const KIND_LABELS: Record<HubKind, { singular: string; plural: string }> = {
  people: { singular: 'person', plural: 'People' },
  companies: { singular: 'company', plural: 'Companies' },
  projects: { singular: 'project', plural: 'Projects' },
};

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
};

// Record shapes from contracts/http-api.md "Conventions added".
export interface HubRecord {
  id: string;
  name: string;
  roleTitle?: string | null;
  phone?: string | null;
  emails?: { id: string; address: string; isPrimary: boolean; origin: 'user' | 'email' }[];
  website?: string | null;
  industry?: string | null;
  domains?: { id: string; domain: string; origin: 'user' | 'email' }[];
  status?: ProjectStatus;
  startDate?: string | null;
  endDate?: string | null;
  description?: string | null;
  ownerFields: string[];
  createdFrom: 'user' | 'email';
  createdAt: string;
  updatedAt: string;
}

const ERROR_TEXT: Record<string, string> = {
  validation_failed: 'Some values are not valid. Check the fields and try again.',
  conflict: 'Another record already uses this email or domain.',
  sensitive_content: 'A value looks like sensitive data and was not saved.',
  inspection_unavailable: 'Checking the content is unavailable right now. Try again shortly.',
  not_found: 'This record no longer exists.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  link_exists: 'These records are already linked. You can change the role of the existing link.',
  invalid_link: 'These two records cannot be linked.',
  note_excluded: 'This note was not saved: it only contained excluded information.',
  too_large: 'This file is larger than 25 MB, so it was not attached.',
  unsupported_type: 'This file type is not allowed, so it was not attached.',
  hub_not_enabled: 'The hub is not on for this mailbox.',
};

export interface HubApiFailure {
  status: number;
  code: string;
  message: string;
  details: { fields?: string[]; linkId?: string; category?: string; allowed?: string[] };
}

/** Reads the error envelope of a failed hub API response together with its user message. */
export async function readHubError(res: Response): Promise<HubApiFailure> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: HubApiFailure['details'] };
    };
    const code = body.error?.code ?? '';
    const details = body.error?.details ?? {};
    const base = ERROR_TEXT[code] ?? body.error?.message ?? 'Something went wrong.';
    const fields = details.fields;
    const message = code === 'sensitive_content' && fields?.length ? `${base} (${fields.join(', ')})` : base;
    return { status: res.status, code, message, details };
  } catch {
    return { status: res.status, code: '', message: 'Something went wrong.', details: {} };
  }
}

/** Maps a failed hub API response to a user message. */
export async function hubApiError(res: Response): Promise<string> {
  return (await readHubError(res)).message;
}

// Links, notes and files of a record (US2; contracts/http-api.md "Links", "Notes", "Files").

export type ServiceKind = 'person' | 'company' | 'project';
export type LinkKind = 'person_company' | 'person_project' | 'company_project';

export const SERVICE_KIND: Record<HubKind, ServiceKind> = { people: 'person', companies: 'company', projects: 'project' };
export const KIND_PATH: Record<ServiceKind, HubKind> = { person: 'people', company: 'companies', project: 'projects' };

/** The kind of the link between two record kinds, or null for a same-kind pair (never offered). */
export function linkKindFor(a: HubKind, b: HubKind): LinkKind | null {
  const pair = new Set([SERVICE_KIND[a], SERVICE_KIND[b]]);
  if (pair.size !== 2) return null;
  if (pair.has('person') && pair.has('company')) return 'person_company';
  if (pair.has('person')) return 'person_project';
  return 'company_project';
}

export const LINK_ROLE_MAX = 100;

export interface HubLinkItem {
  link: { id: string; kind: LinkKind; role: string | null; origin: 'user' | 'email' };
  other: { kind: ServiceKind; id: string; name: string };
}

export interface HubNoteItem {
  id: string;
  title: string;
  body: { type: 'doc'; content: unknown[] };
  redactedValues: number;
  createdAt: string;
  updatedAt: string;
  sync?: HubSyncField;
}

export type ExtractionStatus = 'pending' | 'extracted' | 'empty' | 'unsupported' | 'failed' | 'excluded';

export interface HubFileItem {
  id: string;
  name: string;
  description: string | null;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  extractionStatus: ExtractionStatus;
  extractionReason: string | null;
  redactedValues: number;
  createdAt: string;
  updatedAt: string;
  sync?: HubSyncField;
}

export const EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  pending: 'Reading text',
  extracted: 'Searchable',
  empty: 'Not searchable',
  unsupported: 'Not searchable',
  failed: 'Not searchable',
  excluded: 'Not searchable',
};

/** Plain-words reasons; for `excluded` the reason is a filter category key and the caller adds its label. */
export const EXTRACTION_REASON_TEXT: Record<string, string> = {
  image_not_searchable: 'Images are kept, but their text is not read.',
  no_text_extraction_for_type: 'Text is not read from this file type. The file is kept.',
  empty: 'No text was found in this file.',
  timeout: 'Reading the text took too long. The file is kept.',
  corrupt: 'The file could not be read. The file is kept.',
  inspection_failed: 'The text could not be checked, so it was not kept. The file is kept.',
};

// Memory store sync (US7; contracts/http-api.md "Sync"; FR-026). `pending` is shown as "waiting".

export type HubSyncStatus = 'pending' | 'stored' | 'failed';
export type HubSyncEntity = ServiceKind | 'note' | 'file' | 'summary';

/** The `sync` field of record, note and file responses. */
export interface HubSyncField {
  status: HubSyncStatus;
  lastSyncedAt: string | null;
}

export interface HubSyncItem {
  id: string;
  entityType: HubSyncEntity;
  entityId: string;
  label: string | null;
  status: HubSyncStatus;
  attempts: number;
  lastErrorCode: string | null;
  lastSyncedAt: string | null;
}

export const SYNC_STATUS_LABELS: Record<HubSyncStatus, string> = {
  stored: 'stored',
  pending: 'waiting',
  failed: 'failed',
};

export const SYNC_ENTITY_LABELS: Record<HubSyncEntity, string> = {
  person: 'Person',
  company: 'Company',
  project: 'Project',
  note: 'Note',
  file: 'File',
  summary: 'Conversation summary',
};

/** Same text on the server and in the browser (no locale), so a client badge hydrates without a mismatch. */
export function formatSyncedAt(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Search (US5; contracts/http-api.md "Search", contracts/hub-search.md). The server sends highlight offsets, never HTML.

export type HubSearchType = ServiceKind | 'note' | 'file';

export const SEARCH_TYPES: readonly HubSearchType[] = ['person', 'company', 'project', 'note', 'file'];

export const SEARCH_TYPE_LABELS: Record<HubSearchType, string> = {
  person: 'Person',
  company: 'Company',
  project: 'Project',
  note: 'Note',
  file: 'File',
};

/** Filter chips: one type at a time, in this order. */
export const SEARCH_TYPE_FILTERS: { type: HubSearchType; label: string }[] = [
  { type: 'person', label: 'People' },
  { type: 'company', label: 'Companies' },
  { type: 'project', label: 'Projects' },
  { type: 'note', label: 'Notes' },
  { type: 'file', label: 'Files' },
];

export const SEARCH_QUERY_MAX = 200;

export interface HubSearchSnippet {
  text: string;
  /** UTF-16 offsets into `text`: `[start, end]`. */
  highlights: [number, number][];
}

export interface HubSearchItem {
  type: HubSearchType;
  id: string;
  title: string;
  /** The record a note or file belongs to; null for records. */
  owner: { kind: ServiceKind; id: string; name: string } | null;
  snippets: HubSearchSnippet[];
  updatedAt: string;
}

/** The `types` query value (comma list) as known types, deduplicated; unknown words are ignored. */
export function parseSearchTypes(raw: string | undefined): HubSearchType[] {
  if (!raw) return [];
  const out: HubSearchType[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim() as HubSearchType;
    if (SEARCH_TYPES.includes(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Where a search result opens: records on their own page, notes and files on their record's page. */
export function searchResultHref(item: Pick<HubSearchItem, 'type' | 'id' | 'owner'>): string {
  if (item.type === 'note' || item.type === 'file') {
    return item.owner ? `/hub/${KIND_PATH[item.owner.kind]}/${item.owner.id}` : '/hub';
  }
  return `/hub/${KIND_PATH[item.type]}/${item.id}`;
}

// Mailboxes, ignore rules and conversation sources (US3; contracts/http-api.md "Mailboxes and ignore rules",
// "GET /api/hub/{kind}/{id}/sources"; FR-012, FR-018, FR-019, FR-021, FR-022).

export type BackfillState = 'none' | 'pending' | 'running' | 'done';

export interface HubFailedThread {
  id: string;
  subjectAvailable: false;
  errorCode: string | null;
  attempts: number;
  lastAttemptAt: string | null;
}

export interface HubMailbox {
  sourceId: string;
  accountLabel: string;
  status: string;
  enabled: boolean;
  enabledAt: string | null;
  backfillState: BackfillState;
  pausedUntil: string | null;
  threadsProcessed: number;
  threadsSkipped: number;
  threadsFailed: number;
  lastRunAt: string | null;
  dataChoice: 'keep' | 'delete' | null;
  failedThreads: HubFailedThread[];
}

export type HubDataChoice = 'keep' | 'delete';

/** Keep or delete the data derived from a mailbox when its hub is turned off or it is disconnected (FR-031). */
export const HUB_DATA_OPTIONS: { value: HubDataChoice; label: string; help: string }[] = [
  {
    value: 'keep',
    label: 'Keep what was found',
    help: 'Records, values, links and summaries from this mailbox stay in your hub. Nothing new is read.',
  },
  {
    value: 'delete',
    label: 'Delete what was found',
    help: 'Summaries, values and links that came only from this mailbox are removed. Anything you entered yourself stays.',
  },
];

/** The notice the user acknowledges before the hub is turned on for a mailbox (FR-012). */
export const HUB_AI_NOTICE =
  'Conversation content from this mailbox is sent to the AI service, which recognises the people, companies and projects in it. Only filtered summaries and findings are kept; message text is not stored.';

export const BACKFILL_STATE_TEXT: Record<BackfillState, string | null> = {
  none: null,
  pending: 'Earlier mail is queued for reading.',
  running: 'Reading earlier mail.',
  done: null,
};

/** Plain-words reasons for a failed conversation; codes come from the `hub.thread` worker. */
export const THREAD_ERROR_TEXT: Record<string, string> = {
  llm_refused: 'The AI service declined this conversation.',
  llm_bad_output: 'The AI service gave an unusable answer.',
  llm_rate_limited: 'The AI service was busy.',
  llm_unavailable: 'The AI service was unavailable.',
  inspection_failed: 'The content could not be checked.',
  fetch_unavailable: 'The messages could not be read from the mailbox.',
  source_auth: 'The mailbox needs reconnection.',
  daily_cap_reached: 'The daily limit was reached.',
  apply_failed: 'The findings could not be saved.',
};

export type IgnoreRuleKind = 'address' | 'domain';

export interface HubIgnoreRule {
  id: string;
  kind: IgnoreRuleKind;
  value: string;
  createdAt: string;
}

export const IGNORE_RULE_KIND_LABELS: Record<IgnoreRuleKind, string> = { address: 'Sender', domain: 'Domain' };

export type HubSourceSupport = { field: string } | { link: string } | { email: string } | { domain: string };

export interface HubSourceParticipant {
  name: string | null;
  address: string;
  owner: boolean;
}

export interface HubSourceThread {
  threadId: string;
  subject: string | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  participants: HubSourceParticipant[];
  summary: string | null;
  openUrl: string | null;
  supports: HubSourceSupport[];
}

/** Field keys of the three record kinds as shown on the detail page. */
export const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  roleTitle: 'Role',
  phone: 'Phone',
  website: 'Website',
  industry: 'Industry',
  status: 'Status',
  startDate: 'Start date',
  endDate: 'End date',
  description: 'Description',
};

/** Date part only, the same on the server and in the browser. */
export function formatDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'Unknown date';
}

/** The domain of an address, lower-cased; empty when there is none. */
export function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).toLowerCase();
}

/** Anchor of a conversation in the summaries panel, so the sources panel can point at it. */
export const threadAnchor = (threadId: string) => `hub-thread-${threadId}`;
