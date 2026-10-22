import type { APIResponse, Page } from '@playwright/test';

// Thin wrappers over `page.request` (shares the page's session cookies). Non-2xx responses throw ApiError with the
// status and the contract error code, so specs can assert `{ status, code }` with `expect(...).rejects`.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly body: unknown,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} -> ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function parse(res: APIResponse): Promise<unknown> {
  if (res.status() === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function call<T>(page: Page, method: Method, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(path, {
    method,
    ...(data === undefined ? {} : { data }),
    maxRedirects: 0,
  });
  const body = await parse(res);
  if (!res.ok()) {
    // Error envelope: { error: { code, message, details? } } (apps/web/lib/http.ts).
    const code = typeof body === 'object' && body !== null ? (body as { error?: { code?: string } }).error?.code : undefined;
    throw new ApiError(res.status(), code, body, method, path);
  }
  return body as T;
}

export const api = {
  get: <T = unknown>(page: Page, path: string) => call<T>(page, 'GET', path),
  post: <T = unknown>(page: Page, path: string, data?: unknown) => call<T>(page, 'POST', path, data),
  put: <T = unknown>(page: Page, path: string, data?: unknown) => call<T>(page, 'PUT', path, data),
  patch: <T = unknown>(page: Page, path: string, data?: unknown) => call<T>(page, 'PATCH', path, data),
  delete: <T = unknown>(page: Page, path: string, data?: unknown) => call<T>(page, 'DELETE', path, data),
};

/** Calls `fn` until `until(value)` holds; throws with the last value on timeout. */
export async function poll<T>(
  fn: () => Promise<T>,
  until: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (until(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`poll timed out after ${timeoutMs} ms; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface Me {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  status: string;
  createdAt: string;
  filtersConfirmed: boolean;
}

export async function me(page: Page): Promise<Me> {
  return api.get<Me>(page, '/api/me');
}

export async function userIdOf(page: Page): Promise<string> {
  return (await me(page)).id;
}

/** Confirms the current filter selection unchanged (the first-connect checklist step). */
export async function confirmFilters(page: Page): Promise<void> {
  const prefs = await api.get<{ selectedCategories: string[] }>(page, '/api/filter-preferences');
  await api.put(page, '/api/filter-preferences', { selectedCategories: prefs.selectedCategories });
}

/** PUT /api/admin/settings with an admin page (key from APP_SETTING_DEFAULTS, numeric value). */
export async function setAdminSetting(adminPage: Page, key: string, value: number): Promise<void> {
  await api.put(adminPage, '/api/admin/settings', { key, value });
}
