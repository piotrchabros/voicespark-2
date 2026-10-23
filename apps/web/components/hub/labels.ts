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

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
