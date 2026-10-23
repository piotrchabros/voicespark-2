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
};

/** Maps a failed hub API response to a user message. */
export async function hubApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: { fields?: string[] } };
    };
    const code = body.error?.code ?? '';
    const base = ERROR_TEXT[code] ?? body.error?.message ?? 'Something went wrong.';
    const fields = body.error?.details?.fields;
    return code === 'sensitive_content' && fields?.length ? `${base} (${fields.join(', ')})` : base;
  } catch {
    return 'Something went wrong.';
  }
}
