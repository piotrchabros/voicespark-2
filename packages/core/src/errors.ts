export const ERROR_STATUS = {
  unauthenticated: 401,
  account_suspended: 403,
  admin_required: 403,
  not_found: 404,
  conflict: 409,
  filter_confirmation_required: 409,
  last_admin: 409,
  last_available_definition: 409,
  last_identity: 409,
  link_exists: 409,
  invalid_link: 409,
  suggestion_not_pending: 409,
  merge_invalid: 409,
  hub_not_enabled: 409,
  definition_retired: 409,
  no_profile: 409,
  validation_failed: 422,
  category_locked: 422,
  insufficient_content: 422,
  unknown_template_variable: 422,
  model_not_allowed: 422,
  sensitive_content: 422,
  note_excluded: 422,
  hub_data_choice_required: 422,
  unsupported_type: 415,
  version_not_draft: 422,
  too_large: 413,
  imap_auth_failed: 400,
  imap_connection_failed: 400,
  oauth_cancelled: 400,
  oauth_failed: 400,
  rate_limited: 429,
  internal_error: 500,
  inspection_unavailable: 503,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

const ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  internal_error: 'Internal server error',
  validation_failed: 'Request validation failed',
  rate_limited: 'Too many requests',
  not_found: 'Not found',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
    status?: number,
  ) {
    super(message ?? ERROR_MESSAGES[code] ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code];
    if (details !== undefined) this.details = details;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export interface ServiceContext {
  userId: string;
  role: 'user' | 'admin';
}
