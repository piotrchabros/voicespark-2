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
